'use strict';
/* ============================================================================
 * Plan-seal LIVE proof — engine-live run + sealed snapshot against a real
 * PostgreSQL (M2 unit 3). Companion to rls-deny-matrix.js (same conventions).
 *
 * Requires a reachable PostgreSQL via DATABASE_URL_ADMIN (CI: postgres:16
 * service; locally: the portable pgprobe server on 5433). The script:
 *   1. creates a scratch database and applies ALL migrations (0001 + 0002)
 *   2. verifies plan_seal is RLS-armed and plan_seal's unique is live
 *   3. seeds two synthetic tenants with a full planning dataset (as owner,
 *      app.tenant_id set per transaction — FORCE binds the owner too)
 *   4. runs the REAL plan-service runPlan through a pg-backed loader/saver
 *      adapter (the same shape the app layer will inject)
 *   5. proves: seal persisted + hash survives the JSONB round-trip, same-day
 *      replay is a no-op, a divergent replay is disclosed not applied,
 *      cross-tenant reads/writes are denied, GUC-less sessions see nothing.
 *
 * Connection note: identical to the deny-matrix lesson — the probe gets its
 * own fully-explicit connection config; the GUC is set per session with
 * set_config('app.tenant_id', …, false) — never via connectionString tricks.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const REPO = path.join(__dirname, '..', '..', '..');
const { runPlan } = require(path.join(REPO, 'packages/plan-service'));
const { canonicalJson } = require(path.join(REPO, 'packages/plan-service/src/canonicalJson'));
const E = require(path.join(REPO, 'packages/core/modules/planning-engine'));
const { SCHEMA_VERSION, makePlanAdapter } = require(path.join(REPO, 'packages/db'));

const ADMIN_URL = process.env.DATABASE_URL_ADMIN || 'postgres://postgres@127.0.0.1:5433/postgres';
const LIVE_DB = 'sentinel_plan_live';
const MIGRATIONS = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
  .filter((d) => /^\d{4}_/.test(d)).sort()
  .map((d) => fs.readFileSync(path.join(__dirname, '..', 'migrations', d, 'migration.sql'), 'utf8'))
  .join('\n');

let passed = 0, failed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function bad(name, detail) { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
async function expectError(name, fn, code) {
  try { await fn(); bad(name, `expected error ${code} but statement succeeded`); }
  catch (e) {
    if (e.code === code) ok(name + ` (code ${e.code})`);
    else bad(name, `expected ${code}, got ${e.code || 'none'}: ${e.message}`);
  }
}

function probeUrl(db) {
  const u = new URL(ADMIN_URL.replace(/^postgres:\/\//, 'http://'));
  return `postgres://plan_probe:probe@${u.hostname}:${u.port || 5432}/${db || LIVE_DB}`;
}

/* The pg-backed ports adapter now lives in ONE place: packages/db/plan-adapter.js
 * (the app route injects the same module). The inline copy it replaces was the
 * unit-3 interim; deduping keeps the served SQL byte-for-byte the proven SQL. */
const makeAdapter = makePlanAdapter;

async function main() {
  /* ---- 1. scratch database + all migrations ---- */
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${LIVE_DB};`);
  await admin.query(`CREATE DATABASE ${LIVE_DB};`);
  await admin.end();

  const db = new Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, '/' + LIVE_DB) });
  await db.connect();
  await db.query(MIGRATIONS);

  console.log('\nCatalog: plan_seal is RLS-armed');
  const rel = await db.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'plan_seal' AND relnamespace = 'public'::regnamespace`);
  if (rel.rows[0] && rel.rows[0].relrowsecurity && rel.rows[0].relforcerowsecurity) ok('plan_seal: ENABLE + FORCE');
  else bad('plan_seal RLS not armed');
  const role = await db.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'sentinel_app'`);
  if (role.rows.length === 1 && role.rows[0].rolbypassrls === false && role.rows[0].rolsuper === false) {
    ok('sentinel_app: NOBYPASSRLS, non-superuser');
  } else bad('sentinel_app: wrong role configuration');

  /* ---- 2. probe role ---- */
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'plan_probe') THEN
      CREATE ROLE plan_probe LOGIN PASSWORD 'probe';
    END IF;
  END $$;`);
  await db.query(`GRANT sentinel_app TO plan_probe;`);

  /* ---- 3. seed two tenants with a full planning dataset (owner + GUC) ---- */
  async function asTenant(tenantId, fn) {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    try { return await fn(); } finally { await db.query('COMMIT'); }
  }
  const T = {};
  for (const [key, code, cur, tz, sku] of [
    ['A', 'plan-alpha', 'BHD', 'Asia/Bahrain', 'SKU-A-1'],
    ['B', 'plan-beta', 'AED', 'Asia/Dubai', 'SKU-B-1'],
  ]) {
    T[key] = (await db.query(
      `INSERT INTO tenant (code, name, currency_code, timezone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [code, `Tenant ${key} (synthetic)`, cur, tz])).rows[0].id;
    const tid = T[key];
    await asTenant(tid, async () => {
      await db.query(
        `INSERT INTO planning_param (tenant_id, recipe_ref, params, source) VALUES ($1,'REF-A',$2,'manual')`,
        [tid, JSON.stringify({ lead: { manual: 5 }, safetyDays: { manual: 3 }, orderFreq: { manual: 7 }, moq: { manual: 50 } })]);
      await db.query(
        `INSERT INTO item (tenant_id, sku, name, unit_code, recipe_ref, conversion_factor, converted_unit, price, preferred_for_recipe_ref)
         VALUES ($1,$2,'Synthetic Item','CTN','REF-A',12,'PCS',6.5,true)`, [tid, sku]);
      const item = (await db.query(`SELECT id FROM item WHERE tenant_id = $1 AND sku = $2`, [tid, sku])).rows[0].id;
      const wh1 = (await db.query(
        `INSERT INTO warehouse (tenant_id, code, name, kind) VALUES ($1,'WH-1','Main','COMPANY') RETURNING id`, [tid])).rows[0].id;
      const wh2 = (await db.query(
        `INSERT INTO warehouse (tenant_id, code, name, kind) VALUES ($1,'WH-2','Overflow','COMPANY') RETURNING id`, [tid])).rows[0].id;
      await db.query(
        `INSERT INTO stock_line (tenant_id, item_id, warehouse_id, quantity, unit_code, value_document, document_currency, tenant_value)
         VALUES ($1,$2,$3,10,'CTN',72,$5,72), ($1,$2,$4,2,'CTN',14.4,$5,14.4)`, [tid, item, wh1, wh2, cur]);
      await db.query(
        `INSERT INTO open_po_line (tenant_id, po_number, sku, item_id, ordered_qty, received_qty, waiting_qty, waiting_qty_converted, unit_code, unit_price, currency_code, tenant_unit_price)
         VALUES ($1,'PO-1',$2,$3,50,30,20,240,'CTN',6,$4,6), ($1,'PO-2',$2,$3,10,0,10,NULL,'CTN',6,$4,6)`,
        [tid, sku, item, cur]);
      // S(Jan) = 100+500-200-50 = 350 ; S(Feb) = 200+300-60-60 = 380 ; T = 730*12 = 8760
      await db.query(
        `INSERT INTO consumption_balance (tenant_id, sku, period_start, period_end, start_balance, goods_in, goods_out, stock_changes, end_balance)
         VALUES ($1,$2,'2026-01-01','2026-01-31',100,500,50,0,200), ($1,$2,'2026-02-01','2026-02-28',200,300,60,0,60)`, [tid, sku]);
      await db.query(
        `INSERT INTO delivery_day (tenant_id, day, granularity, deliveries)
         SELECT $1, d::date, 'daily', 100 FROM generate_series('2026-01-01'::date, '2026-02-28'::date, '1 day'::interval) d`, [tid]);
    });
  }

  /* ---- 4. tenant sessions (explicit probe connections, GUC per session) ---- */
  const clientA = new Client({ connectionString: probeUrl() });
  await clientA.connect();
  await clientA.query(`SELECT set_config('app.tenant_id', $1, false)`, [T.A]);
  const clientB = new Client({ connectionString: probeUrl() });
  await clientB.connect();
  await clientB.query(`SELECT set_config('app.tenant_id', $1, false)`, [T.B]);

  console.log('\nEngine live: the run computes, persists and replays');
  const reqA = { tenantId: T.A, asOf: '2026-03-01', driver: { value: 880, granularity: 'monthly' }, actor: 'plan-seal-live' };
  const r1 = await runPlan(reqA, makeAdapter(clientA, T.A));
  if (r1.verdict === 'SEALED') ok('tenant A run SEALS through the real database');
  else { bad('tenant A run refused', JSON.stringify(r1).slice(0, 300)); return finish(db, clientA, clientB); }

  const countA = await clientA.query(`SELECT count(*)::int AS n FROM plan_seal`);
  if (countA.rows[0].n === 1) ok('exactly one seal row for tenant A');
  else bad(`expected 1 seal row, got ${countA.rows[0].n}`);

  const rowA = (await clientA.query(
    `SELECT engine_version, schema_version, payload, payload_hash FROM plan_seal WHERE seal_date = '2026-03-01'`)).rows[0];
  if (rowA.engine_version === E.ENGINE_VERSION && rowA.schema_version === SCHEMA_VERSION) {
    ok(`seal columns carry the L-07 stamps (${E.ENGINE_VERSION} / ${SCHEMA_VERSION})`);
  } else bad('stamp columns wrong', `${rowA.engine_version} / ${rowA.schema_version}`);

  /* The integrity claim: hash survives the JSONB round-trip. */
  const recomputed = crypto.createHash('sha256').update(canonicalJson(rowA.payload)).digest('hex');
  if (recomputed === rowA.payload_hash) ok('payload_hash survives the JSONB round-trip (sha256(canonicalJson(payload)))');
  else bad('JSONB round-trip broke the hash', `${recomputed} != ${rowA.payload_hash}`);

  const ref = rowA.payload.refs[0];
  if (ref.rateInputs && ref.rateInputs.histTotalDeliveries === 5900 && ref.rateInputs.consumptionConverted === 8760) {
    ok('rate inputs are the H8-guarded window numbers (T=8760 over 5900 deliveries)');
  } else bad('rate inputs wrong', JSON.stringify(ref.rateInputs || null));
  if (Array.isArray(rowA.payload.disclosures.unconvertedOpenPo) &&
      rowA.payload.disclosures.unconvertedOpenPo.some((x) => x.poNumber === 'PO-2')) {
    ok('the unconverted open-PO row (PO-2) is disclosed in the sealed payload');
  } else bad('unconverted open-PO disclosure missing');

  console.log('\nReplay: H6 semantics against the live unique');
  const r2 = await runPlan(reqA, makeAdapter(clientA, T.A));
  if (r2.verdict === 'REPLAYED' && r2.divergent === false && r2.payloadHash === r1.payloadHash) {
    ok('same-day rerun REPLAYS the stored seal unchanged');
  } else bad('replay semantics wrong', JSON.stringify({ verdict: r2.verdict, divergent: r2.divergent }));
  const r3 = await runPlan({ ...reqA, driver: { value: 999, granularity: 'monthly' } }, makeAdapter(clientA, T.A));
  const still1 = (await clientA.query(`SELECT count(*)::int AS n FROM plan_seal`)).rows[0].n;
  if (r3.verdict === 'REPLAYED' && r3.divergent === true && r3.banner && still1 === 1) {
    ok('a divergent same-day request is disclosed, not applied (M8 restatement refused)');
  } else bad('divergent replay mishandled', JSON.stringify({ verdict: r3.verdict, divergent: r3.divergent, rows: still1 }));

  console.log('\nTenant isolation on plan_seal (live)');
  const rB = await runPlan({ ...reqA, tenantId: T.B }, makeAdapter(clientB, T.B));
  if (rB.verdict === 'SEALED' && rB.payloadHash !== r1.payloadHash) {
    ok('tenant B seals independently (hash differs — tenant identity is in the payload)');
  } else bad('tenant B seal wrong', rB.verdict);
  const crossRead = await clientA.query(`SELECT count(*)::int AS n FROM plan_seal WHERE tenant_id = $1`, [T.B]);
  if (crossRead.rows[0].n === 0) ok('cross-tenant read is silently denied (RLS)');
  else bad(`cross-tenant read leaked ${crossRead.rows[0].n} rows`);
  await expectError('cross-tenant write is rejected', () =>
    clientA.query(
      `INSERT INTO plan_seal (tenant_id, seal_date, engine_version, schema_version, payload, payload_hash)
       VALUES ($1,'2026-03-02','x','0000','{}','x')`, [T.B]), '42501');
  const naked = new Client({ connectionString: probeUrl() });
  await naked.connect();
  const noGuc = await naked.query(`SELECT count(*)::int AS n FROM plan_seal`);
  if (noGuc.rows[0].n === 0) ok('a session that never set the GUC sees nothing (silent deny)');
  else bad(`GUC-less session saw ${noGuc.rows[0].n} rows`);
  await naked.end();

  await finish(db, clientA, clientB);
}

async function finish(db, clientA, clientB) {
  try { await clientA.end(); } catch (_) {}
  try { await clientB.end(); } catch (_) {}
  try { await db.end(); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error('LIVE-SEAL FATAL:', e.message); process.exit(1); });
