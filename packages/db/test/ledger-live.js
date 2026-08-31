'use strict';
/* ============================================================================
 * LEDGER live proof — the H5 tamper-evident ledger against REAL PostgreSQL.
 *
 * Requires a reachable PostgreSQL. Runs in CI (db-rls job, postgres:16).
 * The A6 named proofs are exercised THROUGH THE REAL WIRING — the pure
 * ledger module decides, the ledger adapter writes, the database re-proves
 * (grants + RLS + the chain-guard and immutable triggers):
 *
 *   ledger/origin-cannot-mutate: no actor including Origin can UPDATE or
 *     DELETE a block — the privilege layer refuses loudly (42501), the RLS
 *     restrictive policies silently filter (0 rows) even for a role that
 *     HOLDS the grants, the immutable triggers catch anything that ever
 *     reaches the table (including a superuser) — and the refused attempt
 *     is itself recorded as a Class-D block.
 *   ledger/tamper-resistant: the chain guard refuses wrong seq/prev links;
 *     a tampered hash is DETECTED by the verifier walk (and the honest
 *     boundary is named: tampering requires direct superuser access to the
 *     database — in-app mutation is structurally impossible); the chain
 *     verifies again after restoration.
 *   ledger/jcs-vectors: the RFC 8785 fixture set (checksum-pinned) runs
 *     against the implementation — the same module the hashes were computed
 *     with, so the CI record carries the vectors alongside the live walk.
 *
 * Plus the §16.4 acceptance that wires today: class-coverage (one
 * representative block per class W/A/N/S/D with every §16.2 field),
 * denial-logged (the C3 refusal record durably in the chain, verbatim),
 * system-actor (actor='system' with the version stamps), no-secrets
 * (refused before any statement), and write-failure-rolls-back (a forced
 * ledger failure aborts the business transaction — §16.3 rule 2).
 *
 * Any unexpected outcome exits non-zero.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));
const ledgerMod = require(path.join(REPO, 'packages', 'core', 'modules', 'ledger'));
const approval = require(path.join(REPO, 'packages', 'core', 'modules', 'approval'));
const planningEngine = require(path.join(REPO, 'packages', 'core', 'modules', 'planning-engine'));

const ADMIN_URL = process.env.DATABASE_URL_ADMIN || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const LIVE_DB = 'sentinel_ledger_live';
const MIGRATION = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
  .filter((d) => /^\d{4}_/.test(d)).sort()
  .map((d) => fs.readFileSync(path.join(__dirname, '..', 'migrations', d, 'migration.sql'), 'utf8'))
  .join('\n');

const KEY = 'ledger-live-hmac-key-0123456789abcdef-0123456789abcdef';
const SCHEMA = DB.SCHEMA_VERSION;
const ENGINE = planningEngine.ENGINE_VERSION || 'unknown';

let passed = 0, failed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function bad(name, detail) { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }

function probeUrl(role) {
  const u = new URL(ADMIN_URL.replace(/^postgres:\/\//, 'http://'));
  return `postgres://${role}:${role}@${u.hostname}:${u.port || 5432}/${LIVE_DB}`;
}

async function withCtx(probe, tenantId, fn) {
  await probe.query('BEGIN');
  await probe.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  try {
    return await fn();
  } finally {
    await probe.query('COMMIT').catch(() => probe.query('ROLLBACK'));
  }
}

async function expectPgError(name, probe, tenantId, fn, { code, message }) {
  await probe.query('BEGIN');
  await probe.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  try {
    await fn();
    bad(name, `expected ${code || message} but the statement succeeded`);
  } catch (e) {
    if (code && e.code === code) ok(name + ` (code ${e.code})`);
    else if (message && String(e.message).includes(message)) ok(name + ` (${message})`);
    else bad(name, `expected ${code || message}, got ${e.code || 'none'}: ${e.message}`);
  } finally {
    await probe.query('ROLLBACK');
  }
}

function ledgerConfig(actor, role) {
  return {
    hmacKey: KEY, engineVersion: ENGINE, schemaVersion: SCHEMA,
    actor, role, sessionId: 'sess-live-1', sourceIp: '10.7.0.1', onBehalfOf: null,
  };
}

async function main() {
  /* ---- 1. scratch database + migrations ---- */
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${LIVE_DB};`);
  await admin.query(`CREATE DATABASE ${LIVE_DB};`);
  await admin.end();

  const db = new Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, '/' + LIVE_DB) });
  await db.connect();
  await db.query(MIGRATION);

  /* ---- 2. catalog ---- */
  console.log('\nCatalog: RLS armed on the ledger');
  const t = await db.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ledger_block' AND relnamespace = 'public'::regnamespace`);
  const row = t.rows[0];
  if (row && row.relrowsecurity && row.relforcerowsecurity) ok('ledger_block: ENABLE + FORCE');
  else bad('ledger_block: ENABLE + FORCE', `relrowsecurity=${row && row.relrowsecurity} relforcerowsecurity=${row && row.relforcerowsecurity}`);

  /* ---- 3. seed two tenants + a principal each (superuser bootstrap) ---- */
  const T1 = (await db.query(`INSERT INTO tenant (code, name, currency_code, timezone) VALUES ('ledger-alpha','Ledger Alpha (synthetic)','BHD','Asia/Bahrain') RETURNING id`)).rows[0].id;
  const T2 = (await db.query(`INSERT INTO tenant (code, name, currency_code, timezone) VALUES ('ledger-beta','Ledger Beta (synthetic)','AED','Asia/Dubai') RETURNING id`)).rows[0].id;
  const U1 = (await db.query(`INSERT INTO app_user (email, display_name) VALUES ('origin.alpha@live.synthetic','alpha-origin') RETURNING id`)).rows[0].id;
  const U2 = (await db.query(`INSERT INTO app_user (email, display_name) VALUES ('viewer.alpha@live.synthetic','alpha-viewer') RETURNING id`)).rows[0].id;

  /* ---- 4. the probes ---- */
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledger_probe') THEN
      CREATE ROLE ledger_probe LOGIN PASSWORD 'ledger_probe';
    END IF;
  END $$;`);
  await db.query(`GRANT sentinel_app TO ledger_probe;`);
  const probe = new Client({ connectionString: probeUrl('ledger_probe') });
  await probe.connect();
  const who = await probe.query('SELECT current_user');
  if (who.rows[0].current_user !== 'ledger_probe') {
    bad('probe identity', `connected as ${who.rows[0].current_user} — connection config regression`);
    process.exit(1);
  }
  const A1 = DB.makeLedgerAdapter(probe, T1, ledgerConfig(U1, 'O'));
  const A2 = DB.makeLedgerAdapter(probe, T2, ledgerConfig(U1, 'O'));

  /* ---- 5. the chain: genesis, linkage, JSONB round-trip ---- */
  console.log('\nAppend: genesis, linkage, and the storage round-trip');
  let first;
  await withCtx(probe, T1, async () => {
    first = await A1.appendBlock({
      class: 'W', entity: 'item', entityId: 'i-1', action: 'item.update', outcome: 'success',
      before: { stock: 9 }, after: { sku: 'TS-0001', stock: 10 }, reason: null,
    });
    if (first.seq === 1 && first.prevHash === '0'.repeat(64) && /^[0-9a-f]{64}$/.test(first.hash)) {
      ok('genesis block: seq 1, prevHash = 64 zeros, hash 64 hex');
    } else bad('genesis block', JSON.stringify(first));
  });
  await withCtx(probe, T1, async () => {
    const second = await A1.appendBlock({
      class: 'W', entity: 'item', entityId: 'i-1', action: 'item.update', outcome: 'success',
      before: { stock: 10 }, after: { sku: 'TS-0001', stock: 11 }, reason: null,
    });
    if (second.seq === 2 && second.prevHash === first.hash) ok('the second block hangs off the first (prevHash linkage)');
    else bad('the second block hangs off the first', JSON.stringify(second));
  });
  await withCtx(probe, T1, async () => {
    const chain = await A1.loadChain();
    const r = chain[0];
    const okRound = r.class === 'W' && r.actor === U1 && r.role === 'O' && r.sessionId === 'sess-live-1'
      && r.sourceIp === '10.7.0.1' && r.before && r.before.stock === 9 && r.after && r.after.stock === 10
      && r.engineVersion === ENGINE && r.schemaVersion === SCHEMA
      && r.at === first.at;
    if (okRound) ok('the §16.2 fields round-trip: actor, role, session, sourceIp, before/after JSONB, stamps, and at (TIMESTAMPTZ → canonical string)');
    else bad('the §16.2 fields round-trip', JSON.stringify(r));
    if (r.at === first.at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.at)) {
      ok('at survives the database as the canonical .sssZ string the hash covered');
    } else bad('at round-trip', `${r.at} vs ${first.at}`);
  });

  /* ---- 6. the chain guard refuses wrong appends ---- */
  console.log('\nChain guard: a wrong append is structurally impossible');
  await expectPgError('a seq gap refuses (LEDGER_SEQ_GAP)', probe, T1,
    () => probe.query(`INSERT INTO ledger_block (seq, class, tenant_id, actor, entity, action, outcome, engine_version, schema_version, at, prev_hash, hash)
      VALUES (5, 'W', $1, $2, 'item', 'item.update', 'success', $3, $4, now(), $5, $6)`, [T1, U1, ENGINE, SCHEMA, '0'.repeat(64), 'a'.repeat(64)]),
    { message: 'LEDGER_SEQ_GAP' });
  await expectPgError('a wrong prev_hash refuses (LEDGER_PREV_HASH_MISMATCH)', probe, T1,
    () => probe.query(`INSERT INTO ledger_block (seq, class, tenant_id, actor, entity, action, outcome, engine_version, schema_version, at, prev_hash, hash)
      VALUES (3, 'W', $1, $2, 'item', 'item.update', 'success', $3, $4, now(), $5, $6)`, [T1, U1, ENGINE, SCHEMA, 'b'.repeat(64), 'c'.repeat(64)]),
    { message: 'LEDGER_PREV_HASH_MISMATCH' });
  await expectPgError('an empty tenant refuses seq ≠ 1 (LEDGER_SEQ_MUST_START_AT_ONE)', probe, T2,
    () => probe.query(`INSERT INTO ledger_block (seq, class, tenant_id, actor, entity, action, outcome, engine_version, schema_version, at, prev_hash, hash)
      VALUES (2, 'W', $1, $2, 'item', 'item.update', 'success', $3, $4, now(), $5, $6)`, [T2, U1, ENGINE, SCHEMA, '0'.repeat(64), 'd'.repeat(64)]),
    { message: 'LEDGER_SEQ_MUST_START_AT_ONE' });
  await expectPgError('genesis with a non-zero prev refuses (LEDGER_GENESIS_PREV_HASH)', probe, T2,
    () => probe.query(`INSERT INTO ledger_block (seq, class, tenant_id, actor, entity, action, outcome, engine_version, schema_version, at, prev_hash, hash)
      VALUES (1, 'W', $1, $2, 'item', 'item.update', 'success', $3, $4, now(), $5, $6)`, [T2, U1, ENGINE, SCHEMA, 'e'.repeat(64), 'f'.repeat(64)]),
    { message: 'LEDGER_GENESIS_PREV_HASH' });

  /* ---- 7. NAMED PROOF: ledger/origin-cannot-mutate ---- */
  console.log('\nNAMED PROOF ledger/origin-cannot-mutate — three layers + the attempt recorded');
  await expectPgError('layer 1 — the app role holds no UPDATE grant: refused loudly (42501)', probe, T1,
    () => probe.query(`UPDATE ledger_block SET hash = $1 WHERE seq = 1`, ['a'.repeat(64)]), { code: '42501' });
  await expectPgError('layer 1 — the app role holds no DELETE grant: refused loudly (42501)', probe, T1,
    () => probe.query(`DELETE FROM ledger_block WHERE seq = 1`), { code: '42501' });

  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledger_rls_probe') THEN
      CREATE ROLE ledger_rls_probe LOGIN PASSWORD 'ledger_rls_probe' NOBYPASSRLS;
    END IF;
  END $$;`);
  await db.query(`GRANT USAGE ON SCHEMA public TO ledger_rls_probe;`);
  await db.query(`GRANT SELECT, UPDATE, DELETE ON ledger_block TO ledger_rls_probe;`);
  const rlsProbe = new Client({ connectionString: probeUrl('ledger_rls_probe') });
  await rlsProbe.connect();
  await withCtx(rlsProbe, T1, async () => {
    const u = await rlsProbe.query(`UPDATE ledger_block SET hash = $1 WHERE seq = 1`, ['a'.repeat(64)]);
    const d = await rlsProbe.query(`DELETE FROM ledger_block WHERE seq = 1`);
    if (u.rowCount === 0 && d.rowCount === 0) {
      ok('layer 2 — even a role that HOLDS UPDATE+DELETE grants finds zero mutable rows (restrictive RLS, the honest silent filter)');
    } else bad('layer 2 — restrictive RLS filters', `update=${u.rowCount} delete=${d.rowCount}`);
  });
  await rlsProbe.end();

  await expectPgError('layer 3 — a superuser bypassing RLS still hits the immutable trigger (LEDGER_IMMUTABLE, UPDATE)', db, T1,
    () => db.query(`UPDATE ledger_block SET hash = $2 WHERE tenant_id = $1 AND seq = 1`, [T1, 'a'.repeat(64)]),
    { message: 'LEDGER_IMMUTABLE' });
  await expectPgError('layer 3 — a superuser bypassing RLS still hits the immutable trigger (LEDGER_IMMUTABLE, DELETE)', db, T1,
    () => db.query(`DELETE FROM ledger_block WHERE tenant_id = $1 AND seq = 1`, [T1]),
    { message: 'LEDGER_IMMUTABLE' });

  await withCtx(probe, T1, async () => {
    /* the refused DELETE attempt is itself recorded — §16.4 */
    await A1.recordRefusedMutation({ action: 'ledger.delete', entity: 'ledger_block', entityId: '1', reason: 'LEDGER_IMMUTABLE' });
    const chain = await A1.loadChain();
    const attempt = chain[chain.length - 1];
    if (attempt.class === 'D' && attempt.outcome === 'denied' && attempt.reason === 'LEDGER_IMMUTABLE'
      && attempt.action === 'ledger.delete' && attempt.actor === U1) {
      ok('the refused mutation is itself recorded: a Class-D block carries actor, action and the refusal code');
    } else bad('the refused mutation is itself recorded', JSON.stringify(attempt));
    const v = await A1.verifyChain();
    if (v.ok) ok('the chain still verifies after recording the attempt');
    else bad('the chain still verifies', JSON.stringify(v));
  });

  /* ---- 8. cross-tenant fence + per-tenant genesis ---- */
  console.log('\nFence: each tenant owns its own chain');
  await withCtx(probe, T2, async () => {
    const n = await probe.query('SELECT count(*)::int AS n FROM ledger_block');
    if (n.rows[0].n === 0) ok('tenant beta sees NONE of tenant alpha\'s blocks');
    else bad('tenant beta sees NONE of tenant alpha\'s blocks', `${n.rows[0].n} leaked`);
    const g = await A2.appendBlock({
      class: 'W', entity: 'item', entityId: 'j-1', action: 'item.update', outcome: 'success',
      before: null, after: { sku: 'AE-0001' }, reason: null,
    });
    if (g.seq === 1) ok('tenant beta starts its OWN chain at seq 1 (per-tenant sequences)');
    else bad('tenant beta starts its OWN chain', JSON.stringify(g));
  });

  /* ---- 9. class coverage: one representative block per class ---- */
  console.log('\n§16.4 class-coverage: W/A/N/S/D all ride the SAME chain');
  await withCtx(probe, T1, async () => {
    await A1.appendBlock({
      class: 'A', entity: 'export', entityId: null, action: 'export.xlsx', outcome: 'success',
      before: null, after: { rows: 1000, query: 'portfolio as-of 2026-08-30' }, reason: null,
    });
    await A1.appendBlock({
      class: 'N', entity: 'session', entityId: null, action: 'session.login.success', outcome: 'success',
      before: null, after: { mfa: 'totp' }, reason: null,
    });
    await A1.appendBlock({
      class: 'S', entity: 'plan_seal', entityId: '2026-08-30', action: 'plan.seal', outcome: 'success',
      actor: 'system', role: null,
      before: null, after: { sealDate: '2026-08-30', engineVersion: ENGINE }, reason: null,
    });
    const chain = await A1.loadChain();
    const classes = new Set(chain.map((b) => b.class));
    if (['W', 'A', 'N', 'S', 'D'].every((c) => classes.has(c))) {
      ok('all five classes present in ONE sequence — class is a field, not a store');
    } else bad('all five classes present', [...classes].join(','));
    const exportBlock = chain.find((b) => b.class === 'A');
    if (exportBlock.after && exportBlock.after.rows === 1000 && exportBlock.sessionId === 'sess-live-1') {
      ok('the Class-A export block carries the row count and the query (§16.4 ledger/export-logged shape)');
    } else bad('the Class-A export block', JSON.stringify(exportBlock));
    const sys = chain.find((b) => b.class === 'S');
    if (sys.actor === 'system' && sys.role === null && sys.engineVersion === ENGINE && sys.schemaVersion === SCHEMA) {
      ok(`ledger/system-actor: actor='system', role null, ENGINE_VERSION ${ENGINE} + SCHEMA_VERSION ${SCHEMA} stamped`);
    } else bad('ledger/system-actor', JSON.stringify(sys));
    const v = await A1.verifyChain();
    if (v.ok && v.verified === chain.length) ok(`the mixed-class chain verifies end to end (${v.verified} blocks)`);
    else bad('the mixed-class chain verifies', JSON.stringify(v));
  });

  /* ---- 10. denial-logged: the C3 refusal record lands verbatim ---- */
  console.log('\nledger/denial-logged: the C3 Class-D record, durably, verbatim');
  await withCtx(probe, T1, async () => {
    const verdict = approval.decide.reviewApproval({
      proposal: { id: 'prop-synthetic', state: 'OPEN', raisedBy: U1, currencyCode: 'BHD', totalAmount: 500 },
      actor: { userId: U1, role: 'O' },
      config: { dualThresholdAmount: 1000 }, limits: [], prior: [],
      decision: 'APPROVED', reason: 'self', tenantCurrency: 'BHD',
    });
    if (!(verdict.ok === false && verdict.denial.reason === 'SOD_SELF_APPROVAL')) {
      bad('the C3 module refuses the self-approval', JSON.stringify(verdict));
      return;
    }
    await A1.appendDenialRecord(verdict.denial);
    const chain = await A1.loadChain();
    const d = chain[chain.length - 1];
    if (d.class === 'D' && d.outcome === 'denied' && d.reason === 'SOD_SELF_APPROVAL'
      && d.actor === U1 && d.entityId === 'prop-synthetic' && d.action === 'proposal.approve') {
      ok('the SoD denial is durable in the chain, byte-verbatim (D-029 → D-030)');
    } else bad('the SoD denial is durable', JSON.stringify(d));
  });

  /* ---- 11. no-secrets + write-failure-rolls-back ---- */
  console.log('\nHygiene and deny-by-default');
  await withCtx(probe, T1, async () => {
    try {
      await A1.appendBlock({
        class: 'W', entity: 'supplier', entityId: 's-1', action: 'supplier.update', outcome: 'success',
        before: null, after: { name: 'x', bankAccount: 'BH67BMAG00001299123456' }, reason: null,
      });
      bad('no-secrets: a banking field refuses', 'the append succeeded');
    } catch (e) {
      if (e.code === 'LEDGER_PAYLOAD_FORBIDDEN_FIELD') ok('no-secrets: a banking field refuses BEFORE any statement (§16.3 rule 3)');
      else bad('no-secrets: a banking field refuses', e.message);
    }
  });

  await expectPgError('a forced ledger-write failure aborts the transaction (23514 via the hash CHECK)', probe, T1,
    () => probe.query(`INSERT INTO ledger_block (seq, class, tenant_id, actor, entity, action, outcome, engine_version, schema_version, at, prev_hash, hash)
      VALUES ((SELECT COALESCE(max(seq),0)+1 FROM ledger_block WHERE tenant_id = $1), 'W', $1, $2, 'item', 'item.update', 'success', $3, $4, now(), (SELECT hash FROM ledger_block WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1), 'zz-not-hex')`, [T1, U1, ENGINE, SCHEMA]),
    { code: '23514' });
  /* the business change rides the SAME transaction and rolls back with it
   * (§16.3 rule 2). The business write is an ingest_file register row — the
   * app role's honest day-to-day write (tenant_isolation only). tenant_role
   * would be WRONG twice: C3's controls_origin_only policy refuses this
   * actor by design (the refusal would fake the proof), and the rollback
   * count runs AFTER the GUC transaction ends — a transaction-local
   * set_config leaves the GUC EMPTY on the session for its remaining life
   * (pinned empirically on PG16), so any probe-side RLS read then casts
   * ''::uuid and 22P02s loud. The count is therefore taken as the
   * SUPERUSER (RLS bypassed — the physical truth, not a policy-filtered
   * view). Fail-closed holds: EMPTY is loud, never leaky. */
  await withCtx(probe, T1, async () => {
    try {
      await probe.query(
        `INSERT INTO ingest_file (tenant_id, kind, mode, file_name, checksum_sha256, byte_size, status, row_count)
         VALUES ($1, 'items', 'A', 'deny-by-default.csv', $2, 128, 'RECEIVED', 3)`,
        [T1, 'c'.repeat(64)]);
      await probe.query(`INSERT INTO ledger_block (seq, class, tenant_id, actor, entity, action, outcome, engine_version, schema_version, at, prev_hash, hash)
        VALUES ((SELECT COALESCE(max(seq),0)+1 FROM ledger_block WHERE tenant_id = $1), 'W', $1, $2, 'item', 'item.update', 'success', $3, $4, now(), (SELECT hash FROM ledger_block WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1), 'zz-not-hex')`, [T1, U1, ENGINE, SCHEMA]);
      await probe.query('COMMIT');
      bad('write-failure-rolls-back: the business change did not survive the ledger failure', 'the tx committed');
    } catch (e) {
      await probe.query('ROLLBACK').catch(() => {});
      const n = await db.query(`SELECT count(*)::int AS n FROM ingest_file WHERE tenant_id = $1 AND file_name = 'deny-by-default.csv'`, [T1]);
      if (n.rows[0].n === 0) ok('write-failure-rolls-back: the register row rolled back WITH the failed ledger write (§16.3 rule 2)');
      else bad('write-failure-rolls-back', `${n.rows[0].n} rows survived`);
    }
  });

  /* ---- 12. NAMED PROOF: ledger/tamper-resistant ---- */
  console.log('\nNAMED PROOF ledger/tamper-resistant — detection, restoration, and the honest boundary');
  await withCtx(probe, T1, async () => {
    const chain = await A1.loadChain();
    const victim = chain.find((b) => b.seq === 2);
    /* Tampering requires direct superuser access — the §10 honest boundary:
     * in-app mutation is structurally impossible (layers 1–3 above). */
    await db.query(`ALTER TABLE ledger_block DISABLE TRIGGER ledger_immutable_update_trigger`);
    await db.query(`UPDATE ledger_block SET hash = $2 WHERE tenant_id = $1 AND seq = 2`, [T1, 'f'.repeat(64)]);
    await db.query(`ALTER TABLE ledger_block ENABLE TRIGGER ledger_immutable_update_trigger`);
    const broken = await A1.verifyChain();
    if (!broken.ok && broken.brokenAt === 2 && broken.reason.startsWith('LEDGER_HASH_MISMATCH')) {
      ok('a tampered hash is detected at the exact block (brokenAt 2, LEDGER_HASH_MISMATCH)');
    } else bad('a tampered hash is detected', JSON.stringify(broken));
    await db.query(`ALTER TABLE ledger_block DISABLE TRIGGER ledger_immutable_update_trigger`);
    await db.query(`UPDATE ledger_block SET hash = $2 WHERE tenant_id = $1 AND seq = 2`, [T1, victim.hash]);
    await db.query(`ALTER TABLE ledger_block ENABLE TRIGGER ledger_immutable_update_trigger`);
    const restored = await A1.verifyChain();
    if (restored.ok) ok('after restoring the original hash, the chain verifies end to end');
    else bad('after restoring', JSON.stringify(restored));
  });

  await withCtx(probe, T1, async () => {
    const other = DB.makeLedgerAdapter(probe, T1, Object.assign(ledgerConfig(U1, 'O'), { hmacKey: KEY + 'x' }));
    const r = await other.verifyChain();
    if (!r.ok && r.brokenAt === 1) ok('a verifier with the WRONG key detects immediately — the hash is keyed (H5)');
    else bad('a verifier with the WRONG key detects', JSON.stringify(r));
  });

  /* ---- 13. the read-only verifier role ---- */
  console.log('\nThe verifier: a distinct read-only role that sees every chain');
  const total = (await db.query('SELECT count(*)::int AS n FROM ledger_block')).rows[0].n; // superuser: all tenants
  await db.query('BEGIN');
  try {
    /* The tenant GUC is SET here because THIS session has run transaction-local
     * set_config before (the layer-3 proofs) — the GUC is EMPTY on it now, and
     * a policy cast of an EMPTY GUC is 22P02-loud. A production verifier
     * connection is fresh (never-set → NULL → the tenant cast is honestly
     * false, and ledger_verifier_read still shows every chain). With T1 set,
     * the OR of tenant_isolation and ledger_verifier_read shows all rows. */
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
    await db.query('SET ROLE sentinel_verifier');
    const n = (await db.query('SELECT count(*)::int AS n FROM ledger_block')).rows[0].n;
    if (total > 0 && n === total) {
      ok(`the verifier reads the WHOLE ledger cross-tenant (${n} blocks, across every tenant fence) — that is the job`);
    } else bad('the verifier reads cross-tenant', `verifier sees ${n}, total is ${total}`);
  } catch (e) {
    bad('the verifier reads cross-tenant', e.message);
  } finally {
    await db.query('RESET ROLE');
    await db.query('ROLLBACK');
  }
  await expectPgError('the verifier cannot write (no INSERT grant, 42501)', db, T1,
    async () => {
      /* SET LOCAL ROLE — transaction-scoped: the ROLLBACK in expectPgError's
       * finally restores the role even from the aborted state a 42501 leaves
       * (a session-level SET ROLE would 25P02 on its RESET-ROLE cleanup). */
      await db.query('SET LOCAL ROLE sentinel_verifier');
      await db.query(`INSERT INTO ledger_block (seq, class, tenant_id, actor, entity, action, outcome, engine_version, schema_version, at, prev_hash, hash)
        VALUES (99, 'W', $1, 'x', 'x', 'x', 'success', 'x', 'x', now(), $2, $3)`, [T1, '0'.repeat(64), 'a'.repeat(64)]);
    }, { code: '42501' });
  await expectPgError('the verifier cannot mutate (no UPDATE grant, 42501)', db, T1,
    async () => {
      await db.query('SET LOCAL ROLE sentinel_verifier');
      await db.query(`UPDATE ledger_block SET hash = $2 WHERE tenant_id = $1 AND seq = 1`, [T1, 'a'.repeat(64)]);
    }, { code: '42501' });

  /* ---- 14. jcs-vectors in the CI record ---- */
  console.log('\nledger/jcs-vectors: the RFC 8785 fixture set against the implementation');
  const fixtureDir = path.join(REPO, 'fixtures', 'ledger');
  const vectors = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'jcs-vectors.json'), 'utf8'));
  const sums = fs.readFileSync(path.join(fixtureDir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const [hex, fname] = sums[0].trim().split(/\s+/);
  const actualHex = crypto.createHash('sha256').update(fs.readFileSync(path.join(fixtureDir, fname))).digest('hex');
  const allMatch = vectors.vectors.every((v) => ledgerMod.jcs.canonicalizeJson(v.input) === v.expected);
  if (actualHex === hex && allMatch) {
    ok(`checksum-pinned vectors verified (${vectors.vectors.length} RFC 8785 cases + ${vectors.survival.length} survival shapes)`);
  } else bad('checksum-pinned vectors', `checksum ${actualHex === hex} vectors ${allMatch}`);

  /* ---- cleanup ---- */
  await probe.end();
  await db.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('ledger-live failed to run:', e.code || '', e.message, e.detail || ''); process.exit(1); });
