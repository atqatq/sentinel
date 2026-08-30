'use strict';
/* ============================================================================
 * Schema structural tests — run everywhere, no database required.
 *
 * Verifies the migration contract WITHOUT a live server:
 *   1. Every tenant-scoped table is RLS-covered: ENABLE + FORCE + a
 *      tenant_isolation policy using the fail-closed
 *      current_setting('app.tenant_id', true) pattern (ADR-0002).
 *   2. The app role is NOBYPASSRLS.
 *   3. No float types anywhere — NUMERIC only for money/quantities (§8).
 *   4. prisma/schema.prisma ↔ migration.sql consistency (table + column sets).
 *   5. H6 idempotency keys: UNIQUE indexes lead with tenant_id.
 *   6. H7 supplier identity: name unique per tenant; external_id unique when
 *      present (partial index).
 * The LIVE proof of the policies is test/rls-deny-matrix.js (CI postgres:16).
 * ==========================================================================*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, '..');
/* All migrations, applied order — the contract is the CONCATENATION: every
 * structural check below must hold across every migration ever shipped,
 * not just 0001. Directory names sort by their 000N prefix. */
const migration = fs.readdirSync(path.join(DB, 'migrations'))
  .filter((d) => /^\d{4}_/.test(d))
  .sort()
  .map((d) => fs.readFileSync(path.join(DB, 'migrations', d, 'migration.sql'), 'utf8'))
  .join('\n');
const prismaSchema = fs.readFileSync(path.join(DB, 'prisma/schema.prisma'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }

/* Every table carrying tenant_id (all except tenant itself and app_user,
 * which are cross-tenant by design — see ADR-0002). */
const TENANT_SCOPED = [
  'ownership_grant', 'unit_catalog_entry', 'unit_alias', 'supplier', 'item',
  'warehouse', 'stock_line', 'open_po_line', 'consumption_balance',
  'delivery_day', 'planning_param', 'category_owner', 'ingest_file',
  'quarantine_record', 'data_health_task', 'idempotency_key', 'fx_rate_pin',
  'plan_seal',
];

console.log('\nRLS coverage (ADR-0002)');

test('every tenant-scoped table has ENABLE + FORCE + tenant_isolation policy', () => {
  for (const t of TENANT_SCOPED) {
    assert.ok(migration.includes(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`), `${t}: ENABLE missing`);
    assert.ok(migration.includes(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`), `${t}: FORCE missing`);
    const re = new RegExp(`CREATE POLICY "tenant_isolation" ON "${t}"[\\s\\S]*?WITH CHECK \\(tenant_id = current_setting\\('app\\.tenant_id', true\\)::uuid\\);`);
    assert.ok(re.test(migration), `${t}: fail-closed policy missing`);
  }
});
test('policies are fail-closed: missing GUC yields NULL, never a wildcard', () => {
  // current_setting without missing_ok would throw instead of denying;
  // current_setting with a fallback default would silently allow. Neither form may appear.
  assert.ok(!/current_setting\('app\.tenant_id'\)/.test(migration), 'non-fail-closed current_setting found');
  assert.ok(!/current_setting\('app\.tenant_id',\s*(?:false|'[^']*')\)/.test(migration), 'fallback-default current_setting found');
});
test('every tenant-scoped table declares tenant_id UUID NOT NULL', () => {
  for (const t of TENANT_SCOPED) {
    const block = migration.match(new RegExp(`CREATE TABLE "${t}" \\([\\s\\S]*?\\);`));
    assert.ok(block, `${t}: CREATE TABLE not found`);
    assert.ok(/"tenant_id" UUID NOT NULL/.test(block[0]), `${t}: tenant_id UUID NOT NULL missing`);
  }
});
test('app role exists and is NOBYPASSRLS', () => {
  assert.ok(/CREATE ROLE "sentinel_app" NOLOGIN NOBYPASSRLS/.test(migration), 'sentinel_app NOBYPASSRLS missing');
});
test('grants: sentinel_app gets DML only — no DDL, no TRUNCATE, no BYPASS', () => {
  const grant = migration.match(/GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "sentinel_app";/);
  assert.ok(grant, 'DML grant missing');
  assert.ok(!/GRANT ALL ON ALL TABLES/.test(migration), 'GRANT ALL found');
  assert.ok(!/TRUNCATE/.test(migration), 'TRUNCATE grant found');
  assert.ok(!/BYPASSRLS;?\s*$.*GRANT/m.test(migration), 'unexpected bypass grant');
});

console.log('\nNumeric discipline (§8: never float)');

test('no float/real/double types anywhere in the migration (comments stripped)', () => {
  const withoutComments = migration.replace(/--[^\n]*/g, '');
  assert.ok(!/\b(FLOAT|REAL|DOUBLE\s+PRECISION)\b/i.test(withoutComments), 'float-family type found');
});
test('money and quantity columns are DECIMAL(18,6); rates DECIMAL(18,8)', () => {
  assert.ok(/"tenant_value" DECIMAL\(18,6\) NOT NULL/.test(migration), 'stock_line tenant_value');
  assert.ok(/"unit_price" DECIMAL\(18,6\) NOT NULL/.test(migration), 'open_po_line unit_price');
  assert.ok(/"quantity" DECIMAL\(18,6\) NOT NULL/.test(migration), 'stock_line quantity');
  assert.ok(/"usd_to_local" DECIMAL\(18,8\) NOT NULL/.test(migration), 'fx_rate_pin usd_to_local');
  assert.ok(/"conversion_factor" DECIMAL\(18,8\)/.test(migration), 'item conversion_factor');
});

console.log('\nH6 — idempotency keys lead with tenant_id');

test('all six spec idempotency keys are tenant-leading UNIQUE indexes', () => {
  const keys = [
    'item_tenant_id_sku_key',
    'stock_line_tenant_id_item_id_warehouse_id_key',
    'open_po_line_tenant_id_po_number_sku_key',
    'supplier_tenant_id_name_key',
    'delivery_day_tenant_id_day_key',
    'planning_param_tenant_id_recipe_ref_key',
  ];
  for (const k of keys) {
    assert.ok(migration.includes(`CREATE UNIQUE INDEX "${k}"`), `${k} missing`);
  }
});
test('control-plane uniques are tenant-leading too (H6 structural)', () => {
  const keys = [
    'consumption_balance_tenant_sku_period_key',
    'ingest_file_tenant_kind_checksum_key',
    'idempotency_key_tenant_kind_key_key',
    'fx_rate_pin_tenant_id_day_key',
    'unit_catalog_entry_tenant_id_code_key',
    'unit_alias_tenant_id_alias_key',
    'category_owner_tenant_id_category_key',
    'plan_seal_tenant_id_seal_date_key',
  ];
  for (const k of keys) {
    assert.ok(migration.includes(`CREATE UNIQUE INDEX "${k}"`), `${k} missing`);
  }
});
test('H7: supplier external_id unique per tenant when present (partial index)', () => {
  assert.ok(/CREATE UNIQUE INDEX "supplier_tenant_id_external_id_key" ON "supplier"\("tenant_id","external_id"\) WHERE "external_id" IS NOT NULL;/.test(migration),
    'partial unique on external_id missing');
});

console.log('\nSchema ↔ migration consistency');

function parsePrismaModels(sql) {
  const models = {};
  const modelRe = /^model\s+(\w+)\s*\{([^}]*)\}/gm;
  let m;
  while ((m = modelRe.exec(sql)) !== null) {
    const modelName = m[1];
    const body = m[2];
    const mapMatch = body.match(/@@map\("([^"]+)"\)/);
    const table = mapMatch ? mapMatch[1] : modelName;
    const cols = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      // relation fields and back-references are not columns
      if (/@relation/.test(line) || /\[\]$/.test(line.split(/\s+/).pop() || '')) continue;
      if (/\[\]/.test(line)) continue;
      const fieldMatch = line.match(/^(\w+)\s+(.+?)(\s|$)/);
      if (!fieldMatch) continue;
      const field = fieldMatch[1];
      const rest = fieldMatch[2] + (fieldMatch[3] || '');
      if (/^enum\b/.test(rest)) continue;
      const colMap = line.match(/@map\("([^"]+)"\)/);
      const col = colMap ? colMap[1] : field;
      // scalar columns only — a column must also have a SQL type annotation or be a plain scalar
      if (/@relation/.test(line)) continue;
      cols.push(col);
    }
    models[table] = new Set(cols);
  }
  return models;
}

function parseSqlTables(sql) {
  const tables = {};
  const tableRe = /CREATE TABLE "([^"]+)" \(([\s\S]*?)\n\);/g;
  let m;
  while ((m = tableRe.exec(sql)) !== null) {
    const cols = new Set();
    const colRe = /^\s*"([^"]+)"\s+"?[A-Za-z]/gm;
    let c;
    while ((c = colRe.exec(m[2])) !== null) cols.add(c[1]);
    tables[m[1]] = cols;
  }
  return tables;
}

test('every Prisma model maps to a CREATE TABLE in the migration', () => {
  const models = parsePrismaModels(prismaSchema);
  const sqlTables = parseSqlTables(migration);
  for (const [table, cols] of Object.entries(models)) {
    assert.ok(table !== 'Tenant' || sqlTables.tenant, 'tenant table missing');
    assert.ok(sqlTables[table], `model maps to "${table}" but no CREATE TABLE found`);
    for (const col of cols) {
      assert.ok(sqlTables[table].has(col), `${table}.${col} in schema.prisma but missing from migration.sql`);
    }
  }
});
test('every CREATE TABLE in the migration is declared in schema.prisma', () => {
  const models = parsePrismaModels(prismaSchema);
  const sqlTables = parseSqlTables(migration);
  for (const table of Object.keys(sqlTables)) {
    assert.ok(models[table], `"${table}" exists in migration.sql but not in schema.prisma`);
  }
});
test('no columns in migration.sql that are absent from the Prisma model', () => {
  const models = parsePrismaModels(prismaSchema);
  const sqlTables = parseSqlTables(migration);
  for (const [table, cols] of Object.entries(sqlTables)) {
    for (const col of cols) {
      assert.ok(models[table] && models[table].has(col), `${table}.${col} in migration.sql but missing from schema.prisma`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
