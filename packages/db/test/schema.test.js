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
  'tenant_role', 'approval_config', 'approval_limit', 'proposal',
  'proposal_line', 'approval', 'purchase_order', 'po_line',
  'supplier_change_hold', 'ledger_block',
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

console.log('\nC3 — financial controls (0003_controls)');

test('SoD invariant lives at RLS: a RESTRICTIVE policy on approval binds the actor, refuses the raiser, requires an eligible role', () => {
  const re = /CREATE POLICY "sod_binding" ON "approval" AS RESTRICTIVE FOR INSERT[\s\S]*?approval\.approver_id = current_setting\('app\.actor_id', true\)::uuid[\s\S]*?approval\.approver_id <> \(SELECT p\.raised_by FROM proposal p WHERE p\.id = approval\.proposal_id\)[\s\S]*?tr\.role IN \('O', 'SCM', 'SBR'\)/;
  assert.ok(re.test(migration), 'sod_binding restrictive policy missing or reshaped');
});
test('approval decisions are append-only at RLS: UPDATE and DELETE denied', () => {
  assert.ok(/CREATE POLICY "approval_append_only" ON "approval" AS RESTRICTIVE FOR UPDATE TO PUBLIC USING \(false\);/.test(migration), 'append-only UPDATE deny missing');
  assert.ok(/CREATE POLICY "approval_no_delete" ON "approval" AS RESTRICTIVE FOR DELETE TO PUBLIC USING \(false\);/.test(migration), 'DELETE deny missing');
});
test('approval reason is NOT NULL — a denial without a reason cannot exist (§16.2)', () => {
  const block = migration.match(/CREATE TABLE "approval" \([\s\S]*?\n\);/);
  assert.ok(block && /"reason" TEXT NOT NULL/.test(block[0]), 'reason NOT NULL missing');
});
test('dual-control distinctness is structural: one decision per (proposal, approver)', () => {
  assert.ok(migration.includes('CREATE TABLE "approval"') && /CONSTRAINT "approval_proposal_approver_key" UNIQUE \("proposal_id","approver_id"\)/.test(migration),
    'UNIQUE (proposal_id, approver_id) missing');
});
test('proposal lifecycle is an enum of exactly the design-spec screen-5 states', () => {
  assert.ok(/CREATE TYPE "proposal_state" AS ENUM \('OPEN', 'APPROVED', 'CONVERTED', 'DISMISSED'\);/.test(migration), 'proposal_state enum missing');
});
test('the state guard trigger exists: dual-control votes, limits and totals checked at the DB', () => {
  assert.ok(/CREATE TRIGGER "proposal_state_guard_trigger"[\s\S]*?EXECUTE FUNCTION "proposal_state_guard"\(\);/.test(migration), 'state guard trigger missing');
  for (const code of ['DUAL_CONTROL_NOT_SATISFIED', 'SOD_SELF_APPROVAL', 'APPROVER_NOT_ELIGIBLE', 'APPROVAL_LIMIT_EXCEEDED', 'PROPOSAL_TOTAL_MISMATCH', 'APPROVAL_CONFIG_MISSING', 'CURRENCY_NOT_TENANT_CURRENCY', 'INVALID_PROPOSAL_TRANSITION']) {
    assert.ok(migration.includes(`RAISE EXCEPTION '${code}'`), `state guard lacks ${code}`);
  }
});
test('a REJECTED decision dismisses the proposal in the same statement (trigger)', () => {
  assert.ok(/CREATE TRIGGER "approval_reject_dismisses_trigger"[\s\S]*?EXECUTE FUNCTION "approval_reject_dismisses"\(\);/.test(migration), 'reject-dismisses trigger missing');
});
test('supplier-identity freeze: the trigger refuses direct changes and only the verified hold passes', () => {
  assert.ok(/CREATE TRIGGER "supplier_identity_freeze_trigger"[\s\S]*?EXECUTE FUNCTION "supplier_identity_freeze"\(\);/.test(migration), 'freeze trigger missing');
  assert.ok(migration.includes("RAISE EXCEPTION 'SUPPLIER_IDENTITY_FROZEN'"), 'direct-change refusal missing');
  assert.ok(migration.includes("RAISE EXCEPTION 'SUPPLIER_HOLD_MISMATCH'"), 'delta-mismatch refusal missing');
  assert.ok(/current_setting\('app\.hold_apply_id', true\)/.test(migration), 'hold_apply_id GUC not fail-closed');
});
test('role/tier/limit authority is Origin-only at RLS, and roles are the six §10 codes', () => {
  assert.ok(/CREATE TYPE "user_role" AS ENUM \('O', 'SCM', 'SBR', 'BYR', 'DTA', 'VWR'\);/.test(migration), 'user_role enum missing');
  assert.ok(/CREATE POLICY "controls_origin_only" ON "tenant_role" AS RESTRICTIVE FOR INSERT/.test(migration), 'tenant_role Origin-only policy missing');
  assert.ok(/CREATE POLICY "controls_origin_only" ON "approval_config" AS RESTRICTIVE/.test(migration), 'approval_config Origin-only policy missing');
  assert.ok(/CREATE POLICY "controls_origin_only" ON "approval_limit" AS RESTRICTIVE/.test(migration), 'approval_limit Origin-only policy missing');
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

console.log('\nH5 — the ledger (0004_ledger)');

test('the ledger is append-only at the privilege layer: sentinel_app holds SELECT, INSERT — never UPDATE/DELETE', () => {
  assert.ok(migration.includes('GRANT SELECT, INSERT ON "ledger_block" TO "sentinel_app";'),
    'the SELECT+INSERT grant missing');
  assert.ok(!/GRANT[^;]*UPDATE[^;]*ON "ledger_block"/.test(migration), 'an UPDATE grant leaked onto the ledger');
  assert.ok(!/GRANT[^;]*DELETE[^;]*ON "ledger_block"/.test(migration), 'a DELETE grant leaked onto the ledger');
});
test('the ledger is append-only at RLS: restrictive UPDATE/DELETE denies (defense in depth)', () => {
  assert.ok(/CREATE POLICY "ledger_append_only" ON "ledger_block" AS RESTRICTIVE FOR UPDATE TO PUBLIC USING \(false\);/.test(migration),
    'restrictive UPDATE deny missing');
  assert.ok(/CREATE POLICY "ledger_no_delete" ON "ledger_block" AS RESTRICTIVE FOR DELETE TO PUBLIC USING \(false\);/.test(migration),
    'restrictive DELETE deny missing');
});
test('the immutable triggers refuse any UPDATE/DELETE that ever reaches the table — including a superuser', () => {
  assert.ok(/CREATE TRIGGER "ledger_immutable_update_trigger"[\s\S]*?BEFORE UPDATE ON "ledger_block"[\s\S]*?EXECUTE FUNCTION "ledger_immutable"\(\);/.test(migration),
    'UPDATE immutability trigger missing');
  assert.ok(/CREATE TRIGGER "ledger_immutable_delete_trigger"[\s\S]*?BEFORE DELETE ON "ledger_block"[\s\S]*?EXECUTE FUNCTION "ledger_immutable"\(\);/.test(migration),
    'DELETE immutability trigger missing');
  const fn = migration.match(/CREATE OR REPLACE FUNCTION "ledger_immutable"\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/);
  assert.ok(fn && /RAISE EXCEPTION 'LEDGER_IMMUTABLE';/.test(fn[0]), 'the trigger must refuse by the named code');
});
test('the chain guard refuses a block that does not hang off its predecessor', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION "ledger_chain_guard"\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/);
  assert.ok(fn, 'ledger_chain_guard function missing');
  for (const code of ['LEDGER_SEQ_MUST_START_AT_ONE', 'LEDGER_GENESIS_PREV_HASH', 'LEDGER_SEQ_GAP', 'LEDGER_PREV_HASH_MISMATCH']) {
    assert.ok(fn[0].includes(`'${code}'`), `chain guard must raise ${code}`);
  }
  assert.ok(fn[0].includes("repeat('0', 64)"), 'genesis prev must be 64 zeros');
  assert.ok(/CREATE TRIGGER "ledger_chain_guard_trigger"[\s\S]*?BEFORE INSERT ON "ledger_block"[\s\S]*?EXECUTE FUNCTION "ledger_chain_guard"\(\);/.test(migration),
    'chain guard trigger missing');
});
test('the chain is structural: composite PK (tenant_id, seq) — no forks, no duplicate seq', () => {
  const block = migration.match(/CREATE TABLE "ledger_block" \([\s\S]*?\n\);/);
  assert.ok(block && block[0].includes('CONSTRAINT "ledger_block_pkey" PRIMARY KEY ("tenant_id", "seq")'),
    'composite PK missing');
});
test('a denial without a reason cannot exist even via raw SQL (§16.2 CHECK)', () => {
  assert.ok(migration.includes('CONSTRAINT "ledger_reason_required_for_denials" CHECK ("outcome" <> \'denied\' OR "reason" IS NOT NULL)'),
    'reason-required CHECK missing');
});
test('hashes are hex-locked at the column: prev_hash and hash are 64 lowercase hex', () => {
  assert.ok(/"prev_hash" TEXT NOT NULL CHECK \("prev_hash" ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(migration), 'prev_hash CHECK missing');
  assert.ok(/"hash" TEXT NOT NULL CHECK \("hash" ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(migration), 'hash CHECK missing');
});
test('the verification job reads under a distinct read-only role (sentinel_verifier)', () => {
  assert.ok(/CREATE ROLE "sentinel_verifier" NOLOGIN NOBYPASSRLS;/.test(migration), 'verifier role missing or mis-privileged');
  assert.ok(migration.includes('GRANT SELECT ON "ledger_block" TO "sentinel_verifier";'), 'verifier SELECT grant missing');
  assert.ok(!/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*TO "sentinel_verifier"/.test(migration), 'the verifier must stay read-only');
  assert.ok(/CREATE POLICY "ledger_verifier_read" ON "ledger_block" AS PERMISSIVE FOR SELECT TO "sentinel_verifier" USING \(true\);/.test(migration),
    'the cross-tenant verifier read policy missing');
});
test('the §16.2 fields are all present on ledger_block', () => {
  const block = migration.match(/CREATE TABLE "ledger_block" \([\s\S]*?\n\);/);
  assert.ok(block, 'ledger_block missing');
  for (const col of ['"seq"', '"class"', '"tenant_id"', '"actor"', '"on_behalf_of"', '"role"', '"source_ip"',
    '"session_id"', '"entity"', '"entity_id"', '"action"', '"outcome"', '"before"', '"after"', '"reason"',
    '"engine_version"', '"schema_version"', '"at"', '"prev_hash"', '"hash"']) {
    assert.ok(block[0].includes(col), `column ${col} missing`);
  }
});

console.log('\nM11 — authentication (0005_auth)');

test('the sign-in audit trail is append-only at the privilege layer (the ledger pattern)', () => {
  assert.ok(migration.includes('GRANT SELECT, INSERT ON "login_attempt" TO "sentinel_app";'),
    'the SELECT+INSERT grant missing');
  assert.ok(!/GRANT[^;]*UPDATE[^;]*ON "login_attempt"/.test(migration), 'an UPDATE grant leaked onto login_attempt');
  assert.ok(!/GRANT[^;]*DELETE[^;]*ON "login_attempt"/.test(migration), 'a DELETE grant leaked onto login_attempt');
  assert.ok(/"outcome" TEXT NOT NULL/.test(migration) && /login_attempt_outcome_check" CHECK \("outcome" IN \('SUCCESS', 'FAILURE', 'LOCKED_OUT'\)\)/.test(migration),
    'the outcome CHECK is the audit vocabulary');
});

test('the session bearer token is stored ONLY as a hash: a UNIQUE index on token_hash, no token column', () => {
  const session = migration.match(/CREATE TABLE "user_session" \([\s\S]*?\n\);/);
  assert.ok(session, 'user_session missing');
  assert.ok(session[0].includes('"token_hash" TEXT NOT NULL'), 'token_hash column missing');
  assert.ok(!session[0].includes('"token"'), 'a raw token column leaked onto user_session');
  assert.ok(migration.includes('CREATE UNIQUE INDEX "user_session_token_hash_key" ON "user_session"("token_hash");'),
    'the token_hash UNIQUE index missing');
});

test('the idle window is DERIVED (last_seen_at), the absolute horizon is pinned at issuance, termination is a tombstone', () => {
  const session = migration.match(/CREATE TABLE "user_session" \([\s\S]*?\n\);/);
  assert.ok(session[0].includes('"last_seen_at"'), 'last_seen_at missing (the idle anchor)');
  assert.ok(!session[0].includes('idle'), 'an idle column would drift from the §14.9 floor — idle is derived');
  assert.ok(session[0].includes('"absolute_expires_at"'), 'absolute_expires_at missing');
  assert.ok(session[0].includes('"terminated_at"'), 'terminated_at missing');
  assert.ok(!/GRANT[^;]*DELETE[^;]*ON "user_session"/.test(migration), 'a DELETE grant would break the tombstone posture');
});

test('the MFA gate: an approval INSERT without a proven second factor is refused at the database', () => {
  assert.ok(/CREATE POLICY "mfa_gate" ON "approval" AS RESTRICTIVE FOR INSERT TO PUBLIC\s*\n\s*WITH CHECK \(current_setting\('app\.mfa_ok', true\) = 'true'\);/.test(migration),
    'the restrictive mfa_gate policy missing');
});

test('the auth layer discloses its pre-tenant posture: no RLS on the four auth tables, by design', () => {
  for (const table of ['user_credential', 'mfa_enrolment', 'user_session', 'login_attempt']) {
    const tableBlock = migration.split(`CREATE TABLE "${table}"`)[1] || '';
    assert.ok(tableBlock.length > 0, `${table} missing`);
  }
  /* the D-031 boundary: the session RESOLUTION precedes the tenant GUC —
   * a tenant_isolation fence on these tables is structurally impossible.
   * The absence is the DESIGN; the comment in 0005_auth is its record. */
  assert.ok(/-- RLS POSTURE \(the honest boundary, D-031\)/.test(migration),
    'the D-031 RLS-posture disclosure comment missing');
});

test('the TOTP replay guard is a column with a row-level backstop shape (last_used_step)', () => {
  const enrol = migration.match(/CREATE TABLE "mfa_enrolment" \([\s\S]*?\n\);/);
  assert.ok(enrol && enrol[0].includes('"last_used_step" BIGINT'), 'the replay-guard column missing');
  assert.ok(enrol[0].includes('"verified_at"'), 'the verified_at enrolment-confirmation column missing');
});

console.log('\nSchema ↔ migration consistency');

function parsePrismaModels(sql) {
  /* pre-pass: every model NAME — a field whose TYPE is a model name is a
   * relation (back-references carry no @relation attribute on one-to-one
   * inverses), never a column. */
  const modelNames = new Set();
  const nameRe = /^model\s+(\w+)\s*\{/gm;
  let nm;
  while ((nm = nameRe.exec(sql)) !== null) modelNames.add(nm[1]);

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
      /* a field whose type is another model is a relation, scalar or array,
       * attributed or not — the SQL column never exists */
      const baseType = rest.split(/\s+/)[0].replace(/\?$/, '').replace(/\[\]$/, '');
      if (modelNames.has(baseType)) continue;
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
  /* The contract is the CONCATENATION: columns added by later ALTERs
   * (e.g. 0006_open_po_status) belong to the table's column set too. */
  const alterRe = /ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)"/g;
  let a;
  while ((a = alterRe.exec(sql)) !== null) {
    if (!tables[a[1]]) tables[a[1]] = new Set();
    tables[a[1]].add(a[2]);
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
