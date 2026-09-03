'use strict';
/* ============================================================================
 * SCORECARD live proof — the §14.6f rollup door against REAL PostgreSQL.
 *
 * Requires a reachable PostgreSQL. Runs in CI (db-rls job, postgres:16).
 * The end-to-end walk: the PURE layer rebuilds a scorecard over a matching
 * result whose supplier never delivered against a promised date (the H2
 * second arm arms the evidence), the door records the ONE Class-S
 * SCORECARD_REBUILT block, and the database re-proves what the stub tier
 * cannot:
 *   - the block round-trips with every §16.2 field (class S, actor system,
 *     the after payload as JSONB, the L-07 stamps, the trigger in reason);
 *   - the chain verifies green across the append (verifyChain);
 *   - RLS: the block is invisible from another tenant's context — the
 *     scorecard of one tenant is not another tenant's evidence;
 *   - the unarmed door refuses loudly (the deployment posture).
 *
 * Any unexpected outcome exits non-zero.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));
const FEEDBACK = require(path.join(REPO, 'packages', 'core', 'modules', 'execution-feedback', 'src', 'feedback.js'));
const { matchPoLines } = require(path.join(REPO, 'packages', 'core', 'modules', 'execution-feedback', 'src', 'matching.js'));
const planningEngine = require(path.join(REPO, 'packages', 'core', 'modules', 'planning-engine'));

const ADMIN_URL = process.env.DATABASE_URL_ADMIN || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const LIVE_DB = 'sentinel_scorecard_live';
const MIGRATION = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
  .filter((d) => /^\d{4}_/.test(d)).sort()
  .map((d) => fs.readFileSync(path.join(__dirname, '..', 'migrations', d, 'migration.sql'), 'utf8'))
  .join('\n');

const KEY = 'scorecard-live-hmac-key-0123456789abcdef-0123456789abcdef';
const SCHEMA = DB.SCHEMA_VERSION;
const ENGINE = planningEngine.ENGINE_VERSION || 'unknown';
const ASOF = '2026-09-01';

let passed = 0, failed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function bad(name, detail) { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }

async function withCtx(probe, tenantId, fn) {
  await probe.query('BEGIN');
  await probe.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  try {
    return await fn();
  } finally {
    await probe.query('COMMIT').catch(() => probe.query('ROLLBACK'));
  }
}

/* The matching result the pure layer judges: one never-delivered supplier
 * (promised 2026-08-10, zero receipts) beside one that delivered in full. */
function buildMatched() {
  return matchPoLines({
    proposals: [
      { refId: 'R1', sku: 'FLOUR-1', supplier: 'Maziwa Fresh', qty: 50, expectedUnitPrice: 2, raisedAt: '2026-08-01', poNumbers: ['PO-BARE'] },
      { refId: 'R2', sku: 'RICE-7', supplier: 'Nile Perch Ltd', qty: 80, expectedUnitPrice: 1.5, raisedAt: '2026-08-01', poNumbers: ['PO-GOOD'] },
    ],
    poLines: [
      { poNumber: 'PO-BARE', sku: 'FLOUR-1', ordered: 50, waiting: 50, poCreationDate: '2026-08-03', expectedDelivery: '2026-08-10', supplierName: 'Maziwa Fresh' },
      { poNumber: 'PO-GOOD', sku: 'RICE-7', ordered: 80, waiting: 0, received: 80, poCreationDate: '2026-08-03', expectedDelivery: '2026-08-08', supplierName: 'Nile Perch Ltd' },
    ],
    events: [
      { poNumber: 'PO-GOOD', sku: 'RICE-7', type: 'receipt', qty: 80, at: '2026-08-08' },
    ],
    amendments: [],
  });
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

  /* ---- 2. tenants + the app-role probe ---- */
  const T1 = (await db.query(`INSERT INTO tenant (code, name, currency_code, timezone) VALUES ('score-alpha','Score Alpha (synthetic)','BHD','Asia/Bahrain') RETURNING id`)).rows[0].id;
  const T2 = (await db.query(`INSERT INTO tenant (code, name, currency_code, timezone) VALUES ('score-beta','Score Beta (synthetic)','AED','Asia/Dubai') RETURNING id`)).rows[0].id;
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'score_probe') THEN
      CREATE ROLE score_probe LOGIN PASSWORD 'score_probe';
    END IF;
  END $$;`);
  await db.query(`GRANT sentinel_app TO score_probe;`);
  const probe = new Client({
    connectionString: (() => {
      const u = new URL(ADMIN_URL.replace(/^postgres:\/\//, 'http://'));
      return `postgres://score_probe:score_probe@${u.hostname}:${u.port || 5432}/${LIVE_DB}`;
    })(),
  });
  await probe.connect();

  /* ---- 3. the pure rebuild: the never-delivered supplier is armed ---- */
  console.log('\nThe pure rebuild (H2 second arm) feeds the door');
  const matched = buildMatched();
  const rebuild = FEEDBACK.rebuildScorecard(matched, {
    asOf: ASOF, trigger: 'schedule', jobId: 'scorecard-nightly-live',
    engineVersion: ENGINE, schemaVersion: SCHEMA,
  });
  const maziwa = rebuild.scorecard.suppliers.find((s) => s.supplier === 'Maziwa Fresh');
  if (maziwa && maziwa.dueLines === 1 && maziwa.fillRate === 0 && maziwa.avgLateDays === 22
      && rebuild.secondArm.pastPromiseDue === 1) {
    ok(`the arm fired live-shaped: Maziwa Fresh due 1, fill 0, ${maziwa.avgLateDays} days past due`);
  } else bad('the arm fired', JSON.stringify({ maziwa, secondArm: rebuild.secondArm }));
  if (rebuild.event.class === 'S' && rebuild.event.entityId === ASOF
      && rebuild.event.engineVersion === ENGINE && rebuild.event.schemaVersion === SCHEMA) {
    ok('the Class-S event carries the L-07 stamps from the repo constants');
  } else bad('the Class-S event stamps', JSON.stringify(rebuild.event));

  /* ---- 4. the door records the block — through the real ledger ---- */
  console.log('\nThe rollup door — one Class-S block through the append path');
  const door = DB.makeScorecardAdapter(probe, T1, { ledger: { hmacKey: KEY } });
  const ledger1 = DB.makeLedgerAdapter(probe, T1, {
    hmacKey: KEY, engineVersion: ENGINE, schemaVersion: SCHEMA,
    actor: 'system', role: null, sessionId: null, sourceIp: null, onBehalfOf: null,
  });
  let receipt;
  await withCtx(probe, T1, async () => {
    receipt = await door.recordRebuild(rebuild.event);
  });
  if (receipt && receipt.recorded === true && receipt.seq === 1 && /^[0-9a-f]{64}$/.test(receipt.hash)) {
    ok(`recorded: seq ${receipt.seq}, genesis hash ${receipt.hash.slice(0, 12)}…`);
  } else bad('recorded', JSON.stringify(receipt));

  await withCtx(probe, T1, async () => {
    const chain = await ledger1.loadChain();
    const b = chain.find((x) => x.action === 'SCORECARD_REBUILT');
    const roundOk = b
      && b.class === 'S'
      && b.actor === 'system'
      && b.entity === 'supplier_scorecard'
      && b.entityId === ASOF
      && b.before === null
      && b.after && b.after.asOf === ASOF
      && Array.isArray(b.after.suppliers) && b.after.suppliers.length === 2
      && b.after.dueLines === 2 && b.after.pastPromiseDue === 1
      && b.reason === 'trigger=schedule job=scorecard-nightly-live'
      && b.engineVersion === ENGINE && b.schemaVersion === SCHEMA;
    if (roundOk) ok('the §16.2 fields round-trip: class S, actor system, before null, the after receipt as JSONB, trigger in reason, stamps');
    else bad('the §16.2 fields round-trip', JSON.stringify(b));
  });

  await withCtx(probe, T1, async () => {
    const v = await ledger1.verifyChain();
    if (v && v.valid) ok('verifyChain green across the rollup append — the score is answerable by the chain');
    else bad('verifyChain green', JSON.stringify(v));
  });

  /* ---- 5. cross-tenant: T2's context sees nothing of T1's scorecard ---- */
  console.log('\nRLS — the scorecard of one tenant is not another tenant\'s evidence');
  const ledger2 = DB.makeLedgerAdapter(probe, T2, {
    hmacKey: KEY, engineVersion: ENGINE, schemaVersion: SCHEMA,
    actor: 'system', role: null, sessionId: null, sourceIp: null, onBehalfOf: null,
  });
  await withCtx(probe, T2, async () => {
    const rows = await probe.query(`SELECT count(*)::int AS n FROM ledger_block WHERE action = 'SCORECARD_REBUILT'`);
    if (rows.rows[0].n === 0) ok('T2 sees zero SCORECARD_REBUILT blocks from T1 (RLS invisible)');
    else bad('T2 sees zero blocks', `count=${rows.rows[0].n}`);
    const v = await ledger2.verifyChain();
    if (v && v.valid) ok('T2\'s own chain verifies (empty and green) — the tenants do not touch');
    else bad('T2 chain green', JSON.stringify(v));
  });

  /* ---- 6. the unarmed door refuses loudly ---- */
  const bareDoor = DB.makeScorecardAdapter(probe, T1, {});
  if (typeof bareDoor.recordRebuild !== 'function') ok('the unarmed door exposes NO recordRebuild — either armed or loud');
  else bad('the unarmed door', 'recordRebuild is exposed without an hmac key');

  /* ---- summary ---- */
  await probe.end();
  await db.end();
  console.log(`\nscorecard-live: ${passed} passed, ${failed} failed`);
  const drop = new Client({ connectionString: ADMIN_URL });
  await drop.connect();
  await drop.query(`DROP DATABASE IF EXISTS ${LIVE_DB};`);
  await drop.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
