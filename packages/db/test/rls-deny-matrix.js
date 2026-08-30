'use strict';
/* ============================================================================
 * RLS deny-matrix — LIVE proof of the tenant-isolation contract (ADR-0001).
 *
 * Requires a reachable PostgreSQL. Runs in CI against postgres:16; locally
 * against any server via DATABASE_URL_ADMIN. The script:
 *   1. creates a scratch database and applies migrations/0001_init/migration.sql
 *   2. verifies the catalog: relrowsecurity + relforcerowsecurity on every
 *      tenant-scoped table; sentinel_app present and NOBYPASSRLS
 *   3. seeds two synthetic tenants (as owner, with app.tenant_id set)
 *   4. connects as a probe role (member of sentinel_app, non-superuser) and
 *      walks the full deny matrix below
 *   5. proves FORCE RLS binds even a NON-superuser table owner
 * Any unexpected outcome exits non-zero.
 *
 * Connection note (learned by failure): node-pg lets connectionString fields
 * override per-connection user/password config — the probe MUST get its own
 * fully-explicit config, or it silently connects as the superuser, which
 * bypasses RLS entirely and every deny would false-pass.
 *
 * GUC lifecycle note (PG documented): on a session that never set the
 * parameter, current_setting('app.tenant_id', true) → NULL → silent
 * zero-row deny; after SET then RESET the placeholder is '' → the ::uuid
 * cast errors (22P02) → loud deny. Both paths are asserted.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL_ADMIN || 'postgres://postgres@127.0.0.1:5433/postgres';
const MATRIX_DB = 'sentinel_rls_matrix';
const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations/0001_init/migration.sql'), 'utf8');

const TENANT_SCOPED = [
  'ownership_grant', 'unit_catalog_entry', 'unit_alias', 'supplier', 'item',
  'warehouse', 'stock_line', 'open_po_line', 'consumption_balance',
  'delivery_day', 'planning_param', 'category_owner', 'ingest_file',
  'quarantine_record', 'data_health_task', 'idempotency_key', 'fx_rate_pin',
];

let passed = 0, failed = 0;
function ok(name){ passed++; console.log('  ✓ ' + name); }
function bad(name, detail){ failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }

/* Explicit per-role connection: parse the admin URL, rebuild with the probe
 * identity. Never reuse the admin connection string with overrides. */
function probeUrl() {
  const u = new URL(ADMIN_URL.replace(/^postgres:\/\//, 'http://')); // URL parser convenience
  return `postgres://rls_probe:probe@${u.hostname}:${u.port || 5432}/${MATRIX_DB}`;
}

async function expectError(name, fn, code) {
  try { await fn(); bad(name, 'expected error ' + code + ' but statement succeeded'); }
  catch (e) {
    if (e.code === code) ok(name + ` (code ${e.code})`);
    else bad(name, `expected ${code}, got ${e.code || 'none'}: ${e.message}`);
  }
}
async function expectCount(name, client, sql, params, expected) {
  try {
    const r = await client.query(sql, params);
    const got = r.rows.length ? Number(Object.values(r.rows[0])[0]) : NaN;
    if (got === expected) ok(name); else bad(name, `expected ${expected}, got ${got}`);
  } catch (e) { bad(name, e.message); }
}
async function expectRowCount(name, client, sql, expected) {
  try {
    const r = await client.query(sql);
    if (r.rowCount === expected) ok(name); else bad(name, `expected rowCount ${expected}, got ${r.rowCount}`);
  } catch (e) { bad(name, e.message); }
}

async function main() {
  /* ---- 1. scratch database ---- */
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${MATRIX_DB};`);
  await admin.query(`CREATE DATABASE ${MATRIX_DB};`);
  await admin.end();

  const db = new Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, '/' + MATRIX_DB) });
  await db.connect();
  await db.query(MIGRATION);

  /* ---- 2. catalog verification ---- */
  console.log('\nCatalog: RLS armed on every tenant-scoped table');
  for (const t of TENANT_SCOPED) {
    const r = await db.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`, [t]);
    const row = r.rows[0];
    if (row && row.relrowsecurity && row.relforcerowsecurity) ok(`${t}: ENABLE + FORCE`);
    else bad(`${t}: relrowsecurity=${row && row.relrowsecurity} relforcerowsecurity=${row && row.relforcerowsecurity}`);
  }
  const role = await db.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'sentinel_app'`);
  if (role.rows.length === 1 && role.rows[0].rolbypassrls === false && role.rows[0].rolsuper === false) ok('sentinel_app: NOBYPASSRLS, non-superuser');
  else bad('sentinel_app: wrong role configuration');

  /* ---- 3. seed two tenants (as owner; GUC set per transaction) ---- */
  const T1 = (await db.query(`INSERT INTO tenant (code, name, currency_code, timezone) VALUES ('tenant-alpha','Tenant Alpha (synthetic)','BHD','Asia/Bahrain') RETURNING id`)).rows[0].id;
  const T2 = (await db.query(`INSERT INTO tenant (code, name, currency_code, timezone) VALUES ('tenant-beta','Tenant Beta (synthetic)','AED','Asia/Dubai') RETURNING id`)).rows[0].id;

  async function asTenant(tenantId, fn) {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    try { return await fn(); } finally { await db.query('COMMIT'); }
  }
  await asTenant(T1, () => db.query(
    `INSERT INTO item (tenant_id, sku, name, unit_code, conversion_factor, converted_unit) VALUES ($1,'SKU-T1-1','Synthetic Item T1','CTN',100,'PCS') RETURNING id`, [T1]));
  await asTenant(T2, () => db.query(
    `INSERT INTO item (tenant_id, sku, name, unit_code, conversion_factor, converted_unit) VALUES ($1,'SKU-T2-1','Synthetic Item T2','CTN',50,'PCS') RETURNING id`, [T2]));
  const D2 = (await asTenant(T2, () => db.query(
    `INSERT INTO delivery_day (tenant_id, day, granularity, deliveries) VALUES ($1,'2026-08-29','daily',80) RETURNING id`, [T2]))).rows[0].id;
  const I2 = (await db.query(`SELECT id FROM item WHERE sku = 'SKU-T2-1'`)).rows[0].id;

  /* ---- 4. probe role ---- */
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rls_probe') THEN
      CREATE ROLE rls_probe LOGIN PASSWORD 'probe';
    END IF;
  END $$;`);
  await db.query(`GRANT sentinel_app TO rls_probe;`);

  const probe = new Client({ connectionString: probeUrl() });
  await probe.connect();
  const who = await probe.query('SELECT current_user');
  if (who.rows[0].current_user !== 'rls_probe') {
    bad('probe identity', `connected as ${who.rows[0].current_user} — connection config regression`);
  } else {
    ok('probe connects as rls_probe (non-superuser), not the admin role');
  }

  const setTenant = (t) => probe.query(`SELECT set_config('app.tenant_id', $1, false)`, [t]);

  console.log('\nDeny matrix (as rls_probe / sentinel_app)');

  /* A/A2/B/B2 run on a session that has NEVER set the GUC (fresh client). */
  const fresh = new Client({ connectionString: probeUrl() });
  await fresh.connect();
  await expectCount('A · fail-closed READ, GUC never set (NULL): zero rows', fresh, `SELECT count(*) FROM item`, [], 0);
  await expectError('B · fail-closed WRITE, GUC never set (NULL): INSERT rejected', () =>
    fresh.query(`INSERT INTO item (tenant_id, sku, name, unit_code) VALUES ('${T1}','SKU-X','x','CTN')`), '42501');
  await fresh.query(`SET app.tenant_id = '${T1}'`);
  await fresh.query(`RESET app.tenant_id`); /* leaves the '' placeholder */
  await expectError('A2 · GUC set-then-reset (empty-string placeholder): read errors loudly (cast)', () =>
    fresh.query(`SELECT count(*) FROM item`), '22P02');
  await expectError('B2 · GUC set-then-reset (empty-string placeholder): write errors loudly (cast)', () =>
    fresh.query(`INSERT INTO item (tenant_id, sku, name, unit_code) VALUES ('${T1}','SKU-X2','x','CTN')`), '22P02');
  await fresh.end();

  await setTenant(T1);
  await expectCount('C · tenant scope: sees own rows only (item)', probe, `SELECT count(*) FROM item`, [], 1);
  await expectCount('C · tenant scope: sees own rows only (delivery_day)', probe, `SELECT count(*) FROM delivery_day`, [], 0);
  await expectCount('D · cross-tenant READ by id → zero rows', probe, `SELECT count(*) FROM item WHERE id = $1`, [I2], 0);
  await expectRowCount('E · cross-tenant UPDATE → 0 rows affected',
    probe, `UPDATE item SET name = 'hijacked' WHERE id = '${I2}'`, 0);
  await expectRowCount('F · cross-tenant DELETE → 0 rows affected',
    probe, `DELETE FROM delivery_day WHERE id = '${D2}'`, 0);
  await expectError('G · cross-tenant WRITE → WITH CHECK rejects', () =>
    probe.query(`INSERT INTO item (tenant_id, sku, name, unit_code) VALUES ('${T2}','SKU-BAD','bad','CTN')`), '42501');
  await expectRowCount('I · positive control: own-tenant INSERT succeeds',
    probe, `INSERT INTO item (tenant_id, sku, name, unit_code) VALUES ('${T1}','SKU-T1-2','ok','CTN')`, 1);

  await probe.query(`SET app.tenant_id = 'not-a-uuid'`);
  await expectError('H · garbage tenant context → statement errors (cast)', () =>
    probe.query(`SELECT count(*) FROM item`), '22P02');
  await probe.query(`SET app.tenant_id = '${T1}'`);

  console.log('\nH6 · idempotency keys are tenant-scoped by construction');
  await expectRowCount('J1 · T1 registers key (items, SKU-1)',
    probe, `INSERT INTO idempotency_key (tenant_id, kind, idem_key) VALUES ('${T1}','items','SKU-1')`, 1);
  await expectError('J2 · same-tenant replay violates the tenant-scoped unique', () =>
    probe.query(`INSERT INTO idempotency_key (tenant_id, kind, idem_key) VALUES ('${T1}','items','SKU-1')`), '23505');
  await setTenant(T2);
  await expectRowCount('J3 · SAME key for the other tenant does NOT collide (the H6 defect is dead)',
    probe, `INSERT INTO idempotency_key (tenant_id, kind, idem_key) VALUES ('${T2}','items','SKU-1')`, 1);

  console.log('\nFORCE RLS binds a non-superuser table owner');
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sentinel_migrator') THEN
      CREATE ROLE sentinel_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$;`);
  await db.query(`GRANT sentinel_migrator TO postgres;`);
  for (const t of TENANT_SCOPED) await db.query(`ALTER TABLE "${t}" OWNER TO sentinel_migrator`);

  /* The owner test needs a session that can SET ROLE sentinel_migrator.
   * SET ROLE replaces the session's privileges entirely — a superuser acting
   * as the non-superuser owner is genuinely bound by FORCE RLS. */
  const owner = new Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, '/' + MATRIX_DB) });
  await owner.connect();
  await owner.query(`SET ROLE sentinel_migrator`);
  await expectCount('K1 · non-superuser owner, GUC never set → zero rows (FORCE works)', owner, `SELECT count(*) FROM item`, [], 0);
  await expectError('K2 · non-superuser owner, GUC never set → write rejected', () =>
    owner.query(`INSERT INTO item (tenant_id, sku, name, unit_code) VALUES ('${T1}','SKU-O','o','CTN')`), '42501');
  await owner.query(`SELECT set_config('app.tenant_id', '${T1}', false)`);
  await expectRowCount('K3 · owner with tenant context operates normally',
    owner, `INSERT INTO item (tenant_id, sku, name, unit_code) VALUES ('${T1}','SKU-T1-3','owner-ok','CTN')`, 1);
  await owner.end();

  await probe.end();

  /* ---- cleanup: restore ownership so re-runs stay clean ---- */
  for (const t of TENANT_SCOPED) await db.query(`ALTER TABLE "${t}" OWNER TO postgres`);
  await db.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('matrix failed to run:', e.message); process.exit(1); });
