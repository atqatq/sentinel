'use strict';
/* ============================================================================
 * SWEEP live proof — the §14.6g register mirror against REAL PostgreSQL.
 *
 * Requires a reachable PostgreSQL. Runs in CI (db-rls job, postgres:16).
 * The mirror walk through the REAL writer:
 *   raise   — run one plan run's shape: a gapped ref syncs into an OPEN
 *             WARN row (the asOf in the payload);
 *   no-op   — the same gap re-synced inserts nothing, re-dates nothing;
 *   resolve — the gap cleared syncs to a RESOLVED row with resolved_at
 *             stamped, the row NEVER deleted;
 *   fence   — a second tenant's register is untouched (RLS + tenant_id).
 * Any unexpected outcome exits non-zero.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));
const OPS = require(path.join(REPO, 'packages', 'core', 'modules', 'ops'));

const ADMIN_URL = process.env.DATABASE_URL_ADMIN || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const LIVE_DB = 'sentinel_sweep_live';
const MIGRATION = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
  .filter((d) => /^\d{4}_/.test(d)).sort()
  .map((d) => fs.readFileSync(path.join(__dirname, '..', 'migrations', d, 'migration.sql'), 'utf8'))
  .join('\n');

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

let passed = 0, failed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function bad(name, detail) { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }

const taskFor = (ref, waiting) => OPS.datahealth.unpromisedWaitingTasks([
  { ref, supply: { status: 'OK', openPO: 3, unpromisedLines: 1, unpromisedWaiting: waiting } },
]).tasks[0];

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${LIVE_DB};`);
  await admin.query(`CREATE DATABASE ${LIVE_DB};`);
  await admin.end();

  const db = new Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, '/' + LIVE_DB) });
  await db.connect();
  await db.query(MIGRATION);

  /* the fence: the sweep rides the tenant_id column + RLS (0001 posture) */
  const rows = await db.query(`SELECT id FROM tenant ORDER BY code LIMIT 2`);
  if (rows.rows.length < 2) {
    // migrations seed no tenants in a fresh database — create the two fences
    await db.query(`INSERT INTO tenant (id, code, name, currency_code, timezone)
                    VALUES ($1,'sweep-alpha','Sweep Alpha (synthetic)','BHD','Asia/Bahrain'),
                           ($2,'sweep-beta','Sweep Beta (synthetic)','AED','Asia/Dubai')`, [T1, T2]);
  } else {
    await db.query(`UPDATE tenant SET id = $1 WHERE code = (SELECT min(code) FROM tenant)`, [T1]);
    await db.query(`UPDATE tenant SET id = $2 WHERE id <> $1`, [T2, T1]);
  }

  const saver = DB.makePlanAdapter(db, T1).saver;

  console.log('\nRaise — a disclosed gap lands OPEN/WARN through the real writer');
  const first = await saver.syncUnpromisedWaitingTasks([taskFor('WB-CAKE-001', 12)], { asOf: '2026-09-01' });
  if (first.inserted === 1 && first.open === 1) ok('the gap inserted; the receipt reads the register');
  else bad('raise', JSON.stringify(first));
  const row1 = (await db.query(
    `SELECT severity, status, payload, resolved_at FROM data_health_task WHERE tenant_id = $1`, [T1])).rows[0];
  if (row1 && row1.severity === 'WARN' && row1.status === 'OPEN'
      && row1.payload.field === 'unpromised-waiting.WB-CAKE-001'
      && row1.payload.raisedAsOf === '2026-09-01' && row1.resolved_at === null) {
    ok('the row shape: WARN/OPEN, the field + the raising run\'s asOf in the payload, resolved_at null');
  } else bad('row shape', JSON.stringify(row1));

  console.log('\nNo-op — the same gap re-synced changes nothing');
  const second = await saver.syncUnpromisedWaitingTasks([taskFor('WB-CAKE-001', 12)], { asOf: '2026-09-02' });
  if (second.inserted === 0 && second.resolved === 0 && second.open === 1) ok('idempotent: no fork, no re-date');
  else bad('no-op', JSON.stringify(second));
  const row2 = (await db.query(
    `SELECT payload, created_at FROM data_health_task WHERE tenant_id = $1`, [T1])).rows[0];
  if (row2.payload.raisedAsOf === '2026-09-01') ok('the live row keeps its raising run (not re-dated)');
  else bad('not re-dated', JSON.stringify(row2.payload));

  console.log('\nResolve — the gap cleared upstream resolves; the row stays');
  const third = await saver.syncUnpromisedWaitingTasks([], { asOf: '2026-09-03' });
  if (third.resolved === 1 && third.open === 0 && third.inserted === 0) ok('the empty desired set resolves the family');
  else bad('resolve', JSON.stringify(third));
  const row3 = (await db.query(
    `SELECT status, resolved_at FROM data_health_task WHERE tenant_id = $1`, [T1])).rows[0];
  if (row3 && row3.status === 'RESOLVED' && row3.resolved_at !== null) ok('RESOLVED with resolved_at stamped — the audit trail is the resolution');
  else bad('resolved row', JSON.stringify(row3));

  console.log('\nFence — another tenant\'s register is untouched');
  const saver2 = DB.makePlanAdapter(db, T2).saver;
  await saver2.syncUnpromisedWaitingTasks([taskFor('WB-JUICE-003', 5)], { asOf: '2026-09-01' });
  const t1rows = (await db.query(`SELECT count(*)::int AS n FROM data_health_task WHERE tenant_id = $1`, [T1])).rows[0].n;
  const t2rows = (await db.query(`SELECT count(*)::int AS n FROM data_health_task WHERE tenant_id = $1`, [T2])).rows[0].n;
  if (t1rows === 1 && t2rows === 1) ok('T1 and T2 each hold exactly their own gap — the fence holds');
  else bad('fence', `T1=${t1rows} T2=${t2rows}`);

  await db.end();
  console.log(`\nsweep-live: ${passed} passed, ${failed} failed`);
  const drop = new Client({ connectionString: ADMIN_URL });
  await drop.connect();
  await drop.query(`DROP DATABASE IF EXISTS ${LIVE_DB};`);
  await drop.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
