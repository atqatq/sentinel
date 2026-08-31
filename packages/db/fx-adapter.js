'use strict';
/* ============================================================================
 * fx-adapter — the M10 pin door: the SQL executor of ADR-0003 / §14.17.
 *
 * The fx_rate_pin table (0001) is the SOURCE OF RECORD for every USD→local
 * conversion. Until this adapter existed NOTHING wrote it — the reading
 * side (ingest-worker-adapter.loadFxPin, normalizeMoney) refused
 * RATE_NOT_PINNED against a table no tenant could populate without SQL.
 * This module is the writing side:
 *
 *   pinRate(day, rate, meta)     — idempotent, logged, retry-safe (the §8
 *                                  jobs posture): the SAME rate re-pinned
 *                                  for a pinned day is a no-op success; a
 *                                  DIFFERENT rate refuses RATE_DAY_CONFLICT
 *                                  (the daily pin is not silently
 *                                  overwritable). One Class-S FX_PIN ledger
 *                                  block in the SAME caller transaction
 *                                  (§16.3 rule 2 — the restatement posture:
 *                                  a failed append rolls the pin back).
 *   correctRate(day, rate, meta) — the EXPLICIT correction act: reason
 *                                  REQUIRED, the UPDATE carries before/after,
 *                                  one Class-S FX_CORRECT block with the
 *                                  diff. Correct again, never un-pin —
 *                                  DELETE is refused structurally (0009:
 *                                  the append-only trigger + the revoked
 *                                  privilege), the correction trail is the
 *                                  history.
 *   loadPinForDay / loadLatestPinAtOrBefore — the readers; the worker's
 *                                  rate window (the latest pin ≤ the run
 *                                  day) is the fail-safe's raw material;
 *                                  the RESOLUTION is the money layer's pure
 *                                  decision (fx.js), never this adapter's.
 *
 * Class-S envelope (§16.1 names FX pin verbatim): actor 'system', role null;
 * a manual trigger rides onBehalfOf (the operator) with the trigger and job
 * id named in reason; engineVersion/schemaVersion are stamped HERE from the
 * repo constants — a caller never labels the chain. The ledger door is
 * armed only by opts.ledger ({ hmacKey }) — UNARMED, a pin fails loudly
 * (TypeError): either armed or refused, never silently unlogged (the §14.16
 * wiring posture; an unlogged machine write is §16.1's blind spot).
 *
 * Statement-first discipline (the restateSeal posture): every argument is
 * validated BEFORE the first statement touches the database; refusals are
 * named (code-carrying Errors), never coerced. RLS scopes every statement
 * to the bound tenant (the GUC is the caller's transaction's).
 * ==========================================================================*/

const E = require('../core/modules/planning-engine');
const { SCHEMA_VERSION } = require('./schema-version');
const ledgerMod = require('./ledger-adapter');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUM_DECIMALS = 8;

function fxError(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}

function assertDay(day, code) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) {
    throw fxError(code || 'RATE_DAY_INVALID', `day must be a YYYY-MM-DD string, got ${JSON.stringify(day)}`);
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/* The operator identity: the ledger's on_behalf_of is a USER UUID (the 0004
 * DDL) — the door validates the shape before anything is sent, the same
 * identity discipline the restatement door carries (the block's actor is
 * the authenticated principal's, never a free-text label). */
function assertActor(by, requiredCode, shapeCode) {
  if (typeof by !== 'string' || by.trim() === '') {
    throw fxError(requiredCode, 'a manual act names its operator (by) — the trail is the point');
  }
  if (!UUID_RE.test(by.trim())) {
    throw fxError(shapeCode, `by must be the operator's Sentinel user id (uuid), got ${JSON.stringify(by)}`);
  }
}

/* The DECIMAL(18,8) round-trip: node-pg ships NUMERIC as a string (the int8
 * lesson, three firings and counting) — the READERS Number() at their own
 * boundary, the door's idempotency comparison compares NUMBERS, not
 * representations, and a caller can never hand a string where a rate
 * belongs. */
function asRate(v) {
  /* STRICT: a string where a rate belongs is the wiring disease (the nz()
   * lesson) — the CALLER hands a number; the READERS Number() the DECIMAL
   * round-trip at their own boundary. */
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw fxError('RATE_INVALID', `rate must be a positive finite number, got ${JSON.stringify(v)}`);
  }
  return Number(v.toFixed(NUM_DECIMALS));
}

function makeFxAdapter(client, tenantId, opts) {
  if (!tenantId) throw new Error('FX_TENANT_REQUIRED');
  /* The ledger door: armed only when the caller supplies the secret-manager
   * key. The envelope is the SYSTEM's (§16.1 Class S); the engine/schema
   * stamps are the repo's own constants. */
  const ledgerAdapter = opts && opts.ledger && opts.ledger.hmacKey
    ? ledgerMod.makeLedgerAdapter(client, tenantId, {
        hmacKey: opts.ledger.hmacKey,
        actor: 'system',
        role: null,
        onBehalfOf: null,
        sourceIp: null,
        sessionId: null,
        engineVersion: E.ENGINE_VERSION,
        schemaVersion: SCHEMA_VERSION,
      })
    : null;

  return {
    /** Pin the tenant-day rate. meta: { trigger: 'schedule'|'manual'|'upload',
     *  jobId?, by? } — a manual trigger names the operator (by) and rides the
     *  block's onBehalfOf; the trigger and job id are named in reason (§16.1
     *  Class S). Returns { pinned, alreadyPinned, day, rate, ledger? }. */
    pinRate: ledgerAdapter ? async (day, rate, meta) => {
      assertDay(day);
      const r = asRate(rate);
      const m = meta || {};
      if (m.trigger !== undefined && !['schedule', 'manual', 'upload'].includes(m.trigger)) {
        throw fxError('RATE_TRIGGER_INVALID', `trigger must be schedule|manual|upload, got ${JSON.stringify(m.trigger)}`);
      }
      const trigger = m.trigger || 'schedule';
      if (trigger === 'manual') assertActor(m.by, 'RATE_PINNER_REQUIRED', 'RATE_PINNER_INVALID');
      const by = trigger === 'manual' ? m.by.trim() : null;
      const existing = await client.query(
        `SELECT usd_to_local FROM fx_rate_pin WHERE tenant_id = $1 AND day = $2`,
        [tenantId, day]);
      if (existing.rows[0]) {
        const pinned = Number(existing.rows[0].usd_to_local);
        if (pinned === r) {
          return { pinned: false, alreadyPinned: true, day, rate: r }; // retried job — not an error
        }
        throw fxError('RATE_DAY_CONFLICT',
          `${day} is already pinned at ${pinned} — a different rate for a pinned day is a CORRECTION (correctRate), never an overwrite`);
      }
      await client.query(
        `INSERT INTO fx_rate_pin (tenant_id, day, usd_to_local, pinned_by)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, day, r, by || trigger]);
      /* The SAME transaction (§16.3 rule 2): a failed append throws and the
       * caller's ROLLBACK takes the pin row with it. */
      const block = await ledgerAdapter.appendBlock({
        class: 'S',
        entity: 'fx_rate_pin',
        entityId: day,
        action: 'FX_PIN',
        outcome: 'success',
        before: null,
        after: { day, rate: r },
        onBehalfOf: by,
        reason: `trigger=${trigger}${m.jobId ? ` job=${m.jobId}` : ''}`,
      });
      return { pinned: true, alreadyPinned: false, day, rate: r, ledger: { seq: block.seq, hash: block.hash } };
    } : undefined,

    /** The explicit correction act. meta: { by, reason } — both REQUIRED
     *  (the diff needs an author and a why). Returns { corrected,
     *  alreadyEqual, day, before, after, ledger? }. */
    correctRate: ledgerAdapter ? async (day, rate, meta) => {
      assertDay(day);
      const r = asRate(rate);
      const m = meta || {};
      if (typeof m.reason !== 'string' || m.reason.trim() === '') {
        throw fxError('RATE_CORRECTION_REASON_REQUIRED', 'a correction carries its reason — the database of record is audited, the why is the record');
      }
      assertActor(m.by, 'RATE_CORRECTION_ACTOR_REQUIRED', 'RATE_CORRECTION_ACTOR_INVALID');
      const by = m.by.trim();
      const existing = await client.query(
        `SELECT usd_to_local FROM fx_rate_pin WHERE tenant_id = $1 AND day = $2`,
        [tenantId, day]);
      if (!existing.rows[0]) {
        throw fxError('RATE_NOT_PINNED', `${day} has no pin to correct — pin it (pinRate), never correct what does not exist`);
      }
      const before = Number(existing.rows[0].usd_to_local);
      if (before === r) {
        return { corrected: false, alreadyEqual: true, day, rate: r };
      }
      await client.query(
        `UPDATE fx_rate_pin SET usd_to_local = $3, pinned_at = now(), pinned_by = $4
          WHERE tenant_id = $1 AND day = $2`,
        [tenantId, day, r, by]);
      const block = await ledgerAdapter.appendBlock({
        class: 'S',
        entity: 'fx_rate_pin',
        entityId: day,
        action: 'FX_CORRECT',
        outcome: 'success',
        before: { rate: before },
        after: { rate: r },
        onBehalfOf: by,
        reason: m.reason.trim(),
      });
      return {
        corrected: true, alreadyEqual: false, day,
        before, after: r,
        ledger: { seq: block.seq, hash: block.hash },
      };
    } : undefined,

    /** The exact tenant-day pin: { day, rate } | null. */
    loadPinForDay: async (day) => {
      assertDay(day);
      const r = await client.query(
        `SELECT day::text AS day, usd_to_local FROM fx_rate_pin WHERE tenant_id = $1 AND day = $2`,
        [tenantId, day]);
      return r.rows[0] ? { day, rate: Number(r.rows[0].usd_to_local) } : null;
    },

    /** The latest pin at or before the day — the M10 fail-safe's raw
     *  material (the RESOLUTION is fx.js's pure decision). null = no pin ≤
     *  the day exists (the money layer then refuses RATE_NOT_PINNED). */
    loadLatestPinAtOrBefore: async (day) => {
      assertDay(day);
      const r = await client.query(
        `SELECT day::text AS day, usd_to_local FROM fx_rate_pin
          WHERE tenant_id = $1 AND day <= $2 ORDER BY day DESC LIMIT 1`,
        [tenantId, day]);
      return r.rows[0] ? { day: r.rows[0].day, rate: Number(r.rows[0].usd_to_local) } : null;
    },
  };
}

module.exports = { makeFxAdapter, fxError };
