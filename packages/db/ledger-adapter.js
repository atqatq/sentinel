'use strict';
/* ============================================================================
 * makeLedgerAdapter(client, tenantId, config) — the SQL executor of the H5
 * ledger (0004_ledger): append blocks into the per-tenant hash chain, load
 * the chain, verify it, and give the C3 refusal records their durable home.
 *
 * Home rule (the H6/C3 pattern): the DECISION layer is the pure ledger
 * module (packages/core/modules/ledger — the §16.2 gate, the JCS
 * canonicalization, the keyed HMAC — consumed through its public surface per
 * ADR-0001); this package owns the SQL mechanics. The database re-proves the
 * chain structure (the ledger_chain_guard trigger + the composite PK) and
 * the immutability (grants + RLS + the ledger_immutable triggers). A buggy
 * caller cannot fork the chain.
 *
 * config (all injected — the adapter owns no secrets and no clock defaults
 * beyond the injectable now()):
 *   hmacKey       REQUIRED — the secret-manager key; never logged, never
 *                 stored, never leaves this process.
 *   engineVersion, schemaVersion — the L-07 stamps (DB.SCHEMA_VERSION is
 *                 the migration contract; the caller passes both).
 *   actor, role, sessionId, sourceIp, onBehalfOf — the authenticated
 *                 envelope of the caller's session (the app.actor_id
 *                 generation of identity — D-029's boundary).
 *   now           optional () => Date (tests pin the clock).
 *
 * Statement-first discipline: the §16.2 gate runs BEFORE any statement is
 * built — a malformed block refuses with zero statements sent, and a forced
 * ledger failure rolls the whole business transaction back with it
 * (§16.3 rule 2: deny-by-default — the ledger write rides the same tx).
 *
 * The int8 lesson (live-caught twice before): node-pg ships BIGINT as a
 * STRING — every seq leaving this adapter is a finite JS number, never a
 * string that would poison the chain arithmetic.
 *
 * pg is never imported here; the client is injected. The structural suites
 * import this package without a database; the LIVE proof is
 * test/ledger-live.js (CI db-rls job).
 * ==========================================================================*/

const ledger = require('../core/modules/ledger');

function asSeq(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`LEDGER_SEQ_BOUNDARY: seq left the database as ${JSON.stringify(v)} — expected a safe integer (the int8 lesson)`);
  }
  return n;
}

function makeLedgerAdapter(client, tenantId, config) {
  if (!tenantId) throw new Error('LEDGER_TENANT_REQUIRED');
  if (!config || typeof config !== 'object') throw new Error('LEDGER_CONFIG_REQUIRED');
  if (typeof config.hmacKey !== 'string' || config.hmacKey.length < 32) {
    throw new Error('LEDGER_CONFIG_KEY_REQUIRED: the secret-manager HMAC key is injected by the caller (32+ chars)');
  }
  const q = (text, values) => client.query(text, values);
  const now = config.now || (() => new Date());
  /* The envelope defaults — every block carries them explicitly (the pure
   * gate refuses undefined; the config supplies the session's identity). */
  const envelope = {
    tenantId,
    onBehalfOf: config.onBehalfOf === undefined ? null : config.onBehalfOf,
    role: config.role === undefined ? null : config.role,
    sourceIp: config.sourceIp === undefined ? null : config.sourceIp,
    sessionId: config.sessionId === undefined ? null : config.sessionId,
    engineVersion: config.engineVersion,
    schemaVersion: config.schemaVersion,
  };

  /* The single append path every writer shares: §16.2 gate → tail lock →
   * seq/prev allocation → canonical payload → keyed hash → INSERT. */
  async function append(input) {
    const at = input.at === undefined ? ledger.blocks.canonicalInstant(now()) : ledger.blocks.canonicalInstant(input.at);
    const payload = ledger.blocks.buildBlock(Object.assign({}, envelope, input, {
      actor: input.actor === undefined ? config.actor : input.actor,
      at,
    }));
    /* The tail lock: serialize per-tenant appenders on the current last
     * block (a FOR UPDATE on the row that must parent the next one). With
     * an empty chain there is nothing to lock — a racing genesis pair
     * collides on the composite PK (23505) and the loser retries; the
     * chain-guard trigger is the structural backstop either way. */
    const tail = await q(
      `SELECT seq, hash FROM ledger_block WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1 FOR UPDATE`,
      [tenantId]);
    const seq = tail.rows.length ? asSeq(tail.rows[0].seq) + 1 : 1;
    const prevHash = tail.rows.length ? tail.rows[0].hash : ledger.hash.GENESIS;
    const canonical = ledger.hash.canonicalPayloadOf(payload);
    const hash = ledger.hash.blockHash(config.hmacKey, seq, prevHash, canonical);
    const ins = await q(
      `INSERT INTO ledger_block
         (seq, class, tenant_id, actor, on_behalf_of, role, source_ip, session_id,
          entity, entity_id, action, outcome, before, after, reason,
          engine_version, schema_version, at, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18::timestamptz,$19,$20)
     RETURNING seq, prev_hash AS "prevHash", hash, at`,
      [seq, payload.class, tenantId, payload.actor, payload.onBehalfOf, payload.role,
       payload.sourceIp, payload.sessionId, payload.entity, payload.entityId,
       payload.action, payload.outcome,
       payload.before === null ? null : JSON.stringify(payload.before),
       payload.after === null ? null : JSON.stringify(payload.after),
       payload.reason, payload.engineVersion, payload.schemaVersion,
       payload.at, prevHash, hash]);
    return {
      seq: asSeq(ins.rows[0].seq),
      prevHash: ins.rows[0].prevHash,
      hash: ins.rows[0].hash,
      at: ledger.blocks.canonicalInstant(ins.rows[0].at),
    };
  }

  /* The chain in seq order, shaped for the pure verifier (at rendered back
   * to the canonical string the hash covered — the round-trip the
   * millisecond discipline guarantees). */
  async function loadChainRows() {
    const r = await q(
      `SELECT ledger.seq, ledger.class, ledger.tenant_id AS "tenantId", ledger.actor,
              ledger.on_behalf_of AS "onBehalfOf", ledger.role, ledger.source_ip AS "sourceIp",
              ledger.session_id AS "sessionId", ledger.entity, ledger.entity_id AS "entityId",
              ledger.action, ledger.outcome, ledger.before, ledger.after, ledger.reason,
              ledger.engine_version AS "engineVersion", ledger.schema_version AS "schemaVersion",
              ledger.at, ledger.prev_hash AS "prevHash", ledger.hash
         FROM ledger_block ledger WHERE ledger.tenant_id = $1 ORDER BY ledger.seq ASC`,
      [tenantId]);
    return r.rows.map((row) => Object.assign({}, row, {
      seq: asSeq(row.seq),
      at: ledger.blocks.canonicalInstant(row.at),
      before: row.before === undefined ? null : row.before,
      after: row.after === undefined ? null : row.after,
    }));
  }

  return {
    /* Append one block. The caller supplies the §16.2 event fields (class,
     * actor, entity, entityId, action, outcome, before, after, reason);
     * actor/role/session envelope fields fall back to the config; at is
     * stamped from the injectable clock unless explicitly given. Returns
     * { seq, prevHash, hash, at }. */
    appendBlock: (input) => append(input || {}),

    /* The D-029 consumption path: the approval module's Class-D denial
     * record travels through UNCHANGED (denialToBlock) into the chain. */
    appendDenialRecord: (denial, over) => {
      const o = over || {};
      const block = ledger.records.denialToBlock(denial, Object.assign({}, envelope, {
        actor: o.actor === undefined ? config.actor : o.actor,
        at: o.at === undefined ? ledger.blocks.canonicalInstant(now()) : ledger.blocks.canonicalInstant(o.at),
      }));
      return append(block);
    },

    /* §16.4 ledger/origin-cannot-mutate: a refused mutation is itself
     * recorded — a Class-D block carrying the refusal code. The refusal
     * happens at the database; this block is the audit of the attempt. */
    recordRefusedMutation: ({ action, entity, entityId, reason }) => {
      if (typeof action !== 'string' || !action) throw new Error('LEDGER_REFUSAL_INTENT_INVALID');
      if (typeof reason !== 'string' || !reason) throw new Error('LEDGER_REFUSAL_INTENT_INVALID');
      return append({
        class: 'D', outcome: 'denied',
        actor: config.actor, role: envelope.role,
        entity: entity || 'ledger_block', entityId: entityId === undefined ? null : entityId,
        action, reason, before: null, after: null,
      });
    },

    /* The chain in seq order, shaped for the pure verifier. */
    loadChain: loadChainRows,

    /* Re-walk the chain under THIS caller's key (§11: the verification job;
     * H5: under the read-only sentinel_verifier role the migration ships). */
    verifyChain: async () => ledger.verify.verifyChain(await loadChainRows(), config.hmacKey),
  };
}

module.exports = { makeLedgerAdapter };
