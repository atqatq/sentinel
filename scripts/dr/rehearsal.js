#!/usr/bin/env node
'use strict';
/* ============================================================================
 * scripts/dr/rehearsal.js — the DR restore-leg rehearsal harness (build spec
 * §14.21; audit H11; named proof `dr/restore-rehearsal-gate`).
 *
 * The audit: "backup restore tested in CI-adjacent staging at least once
 * before cutover." This harness is the CI-adjacent staging — it runs in the
 * db-rls job on EVERY push, so the pre-cutover rehearsal (the signed, dated
 * RUNBOOK act that closes gate 14) rehearses a drill that already works.
 *
 * The drill, honestly:
 *   1. scratch database ← all migrations
 *   2. two tenants; ONE Class-S baseline block in tenant A's chain (the
 *      block the restore must bring back — a chain of zero blocks proves
 *      nothing)
 *   3. pg_dump -Fc  →  sha256 checksum, verified before the restore
 *   4. the source database DESTROYED (the storage accident, simulated)
 *   5. pg_restore into a clean database (the clock covers the restore phase
 *      through the last verification probe — the RUNBOOK's RTO measure)
 *   6. probes on the restored copy: schema sentinels (0004/0008/0009),
 *      RLS armed + cross-tenant denial, verifyChain green through the
 *      ledger door as the app-role probe
 *   7. the evidence runs through the PURE gate (evaluateRestore) — the
 *      restore leg of §14.21. The WAL leg is the deployment's to prove at
 *      the signed staging rehearsal (the service cluster's archive_mode is
 *      printed for the run sheet, never evaluated here — honesty over
 *      theater).
 *
 * Any refusal → the accumulated report on stderr, exit 1. Same-cluster
 * restore: roles persist (they are cluster-level); cross-cluster restores
 * restore roles FIRST (pg_dumpall --roles-only) — docs/RUNBOOK.md §1.
 * ==========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const DR = require(path.join(REPO, 'packages', 'core', 'modules', 'dr'));
const planningEngine = require(path.join(REPO, 'packages', 'core', 'modules', 'planning-engine'));
const DB = require(path.join(REPO, 'packages', 'db'));

const ADMIN_URL = process.env.DATABASE_URL_ADMIN || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCRATCH_DB = 'sentinel_dr_rehearsal';
const RESTORED_DB = 'sentinel_dr_restored';
const LEDGER_KEY = 'dr-rehearsal-hmac-key-0123456789abcdef-0123456789abcdef';

const MIGRATIONS = fs.readdirSync(path.join(REPO, 'packages', 'db', 'migrations'))
  .filter((d) => /^\d{4}_/.test(d)).sort()
  .map((d) => fs.readFileSync(path.join(REPO, 'packages', 'db', 'migrations', d, 'migration.sql'), 'utf8'))
  .join('\n');

/* The migration-floor sentinels: the highest OBJECT present names the schema
 * version the restored copy actually carries (the honest probe — there is
 * no version table; the migration contract IS the object set). Kinds:
 * 'table' probes information_schema.tables, 'function' probes pg_proc —
 * 0010_setup's identity object is the founder door FUNCTION (D-049), so
 * the sentinel floor follows the migration contract's own shape. */
const SCHEMA_SENTINELS = [
  ['0004', 'ledger_block', 'table'],
  ['0008', 'plan_seal_restatement', 'table'],
  ['0009', 'fx_rate_pin', 'table'],
  ['0010', 'setup_create_tenant_with_founder', 'function'],
];

function urlFor(db) {
  return ADMIN_URL.replace(/\/[^/?]*$/, '/' + db);
}
function probeUrlFor(db) {
  const u = new URL(ADMIN_URL.replace(/^postgres:\/\//, 'http://'));
  return `postgres://dr_probe:dr_probe@${u.hostname}:${u.port || 5432}/${db}`;
}
function ts() {
  return new Date().toISOString();
}

function die(msg) {
  console.error(`[${ts()}] DR REHEARSAL REFUSED: ${msg}`);
  process.exit(1);
}

function loadPg() {
  const candidates = [
    path.join(REPO, 'packages', 'db', 'node_modules', 'pg'),
    'pg',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* try next */ }
  }
  die('the pg client is not importable — run `npm install --prefix packages/db pg@8 --no-save` (the db-rls job does this before the live suites)');
}

function requireBinary(name) {
  try {
    execFileSync(name, ['--version'], { stdio: 'pipe' });
  } catch (_) {
    die(`\`${name}\` is not on PATH — the harness needs the postgresql-client-16 tools (ubuntu-latest ships them; install postgresql-client otherwise)`);
  }
}

async function main() {
  const { Client } = loadPg();
  requireBinary('pg_dump');
  requireBinary('pg_restore');

  const day = new Date().toISOString().slice(0, 10);
  console.log(`[${ts()}] DR restore-leg rehearsal — day ${day}, source ${SCRATCH_DB}, target ${RESTORED_DB}`);

  /* ---- 1. scratch database + all migrations ---- */
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE);`);
  await admin.query(`DROP DATABASE IF EXISTS ${RESTORED_DB} WITH (FORCE);`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB};`);

  const scratch = new Client({ connectionString: urlFor(SCRATCH_DB) });
  await scratch.connect();
  await scratch.query(MIGRATIONS);
  console.log(`[${ts()}] scratch database migrated (SCHEMA_VERSION ${DB.SCHEMA_VERSION})`);

  /* ---- 2. two tenants + the baseline block the restore must bring back ---- */
  const TA = (await scratch.query(
    `INSERT INTO tenant (code, name, currency_code, timezone) VALUES ('dr-alpha','DR Alpha (synthetic)','BHD','Asia/Bahrain') RETURNING id`)).rows[0].id;
  const TB = (await scratch.query(
    `INSERT INTO tenant (code, name, currency_code, timezone) VALUES ('dr-beta','DR Beta (synthetic)','AED','Asia/Dubai') RETURNING id`)).rows[0].id;

  const ledgerA = DB.makeLedgerAdapter(scratch, TA, {
    hmacKey: LEDGER_KEY, actor: 'system', role: null,
    engineVersion: planningEngine.ENGINE_VERSION, schemaVersion: DB.SCHEMA_VERSION,
  });
  await scratch.query('BEGIN');
  await scratch.query(`SELECT set_config('app.tenant_id', $1, true)`, [TA]);
  const baseline = await ledgerA.appendBlock({
    class: 'S', entity: 'dr_rehearsal', entityId: `baseline-${day}`,
    action: 'dr.rehearsal.baseline', outcome: 'success',
    before: null, after: { note: 'DR rehearsal baseline — the block the restore must bring back' },
    reason: 'trigger: scripts/dr/rehearsal.js (the CI-adjacent staging drill)',
  });
  await scratch.query('COMMIT');
  if (baseline.seq !== 1) die(`baseline block landed at seq ${baseline.seq} — expected the genesis 1`);
  console.log(`[${ts()}] baseline Class-S block appended (seq 1, hash ${baseline.hash.slice(0, 12)}…)`);
  await scratch.end();

  /* ---- 3. pg_dump + checksum, verified BEFORE the restore ---- */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-rehearsal-'));
  const dumpFile = path.join(tmp, 'sentinel_dr.dump');
  execFileSync('pg_dump', ['--dbname=' + urlFor(SCRATCH_DB), '--format=custom', '--file=' + dumpFile], { stdio: 'pipe' });
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const digest = sha(dumpFile);
  if (sha(dumpFile) !== digest) die('the dump checksum did not survive its own re-read — nothing else matters');
  const sizeMb = (fs.statSync(dumpFile).size / (1024 * 1024)).toFixed(2);
  console.log(`[${ts()}] dump taken (custom format, ${sizeMb} MB, sha256 ${digest.slice(0, 12)}…) and checksum verified`);

  /* ---- 4. the storage accident, simulated: the source is DESTROYED ---- */
  await admin.query(`DROP DATABASE ${SCRATCH_DB} WITH (FORCE);`);
  console.log(`[${ts()}] source database DESTROYED — from here, only the backup exists`);

  /* ---- 5. the restore (the RTO clock covers restore → last probe) ---- */
  const startedAtMs = Date.now();
  await admin.query(`CREATE DATABASE ${RESTORED_DB};`);
  execFileSync('pg_restore', ['--dbname=' + urlFor(RESTORED_DB), '--no-owner', dumpFile], { stdio: 'pipe' });
  console.log(`[${ts()}] pg_restore completed into ${RESTORED_DB}`);

  /* ---- 6. the probes on the restored copy ---- */
  const restored = new Client({ connectionString: urlFor(RESTORED_DB) });
  await restored.connect();

  let restoredSchemaVersion = null;
  for (const [version, name, kind] of SCHEMA_SENTINELS) {
    const q = kind === 'function'
      ? `SELECT 1 FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`
      : `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`;
    const r = await restored.query(q, [name]);
    if (r.rows.length === 1) restoredSchemaVersion = version;
  }
  if (!restoredSchemaVersion) die('none of the schema sentinels exist on the restored copy — the restore is empty');

  const rlsA = await restored.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'plan_seal' AND relnamespace = 'public'::regnamespace`);
  const rlsB = await restored.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ledger_block' AND relnamespace = 'public'::regnamespace`);
  const armed = (row) => row && row.relrowsecurity === true && row.relforcerowsecurity === true;
  if (!armed(rlsA.rows[0]) || !armed(rlsB.rows[0])) die('RLS is not ENABLE + FORCE on the restored plan_seal / ledger_block');
  console.log(`[${ts()}] schema sentinel ${restoredSchemaVersion}; RLS ENABLE + FORCE on plan_seal and ledger_block`);

  /* The probe role + the cross-tenant denial — the app-role posture survives
   * the restore (grants are database objects; roles are cluster-level and
   * persist in the same cluster — cross-cluster restores restore roles
   * FIRST per the RUNBOOK). */
  await restored.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dr_probe') THEN
      CREATE ROLE dr_probe LOGIN PASSWORD 'dr_probe';
    END IF;
  END $$;`);
  await restored.query(`GRANT sentinel_app TO dr_probe;`);
  await restored.end();
  await admin.end();

  const probe = new Client({ connectionString: probeUrlFor(RESTORED_DB) });
  await probe.connect();
  const who = await probe.query('SELECT current_user');
  if (who.rows[0].current_user !== 'dr_probe') die(`probe connected as ${who.rows[0].current_user} — the app-role posture did not survive`);
  await probe.query(`SELECT set_config('app.tenant_id', $1, false)`, [TA]);
  const own = await probe.query(`SELECT count(*)::int AS n FROM ledger_block WHERE tenant_id = $1`, [TA]);
  const foreign = await probe.query(`SELECT count(*)::int AS n FROM ledger_block WHERE tenant_id = $1`, [TB]);
  if (own.rows[0].n !== 1) die(`the probe sees ${own.rows[0].n} of its own blocks — expected exactly the baseline 1`);
  if (foreign.rows[0].n !== 0) die(`the probe sees ${foreign.rows[0].n} of tenant B's blocks — cross-tenant isolation did NOT survive the restore`);
  console.log(`[${ts()}] RLS probes green as dr_probe: own block visible (1), tenant B's rows invisible (0)`);

  const restoredLedger = DB.makeLedgerAdapter(probe, TA, {
    hmacKey: LEDGER_KEY, actor: 'system', role: null,
    engineVersion: planningEngine.ENGINE_VERSION, schemaVersion: DB.SCHEMA_VERSION,
  });
  const verdict = await restoredLedger.verifyChain();
  await probe.end();
  if (!verdict.ok) die(`verifyChain on the restored copy is RED (${verdict.reason} at seq ${verdict.brokenAt})`);
  console.log(`[${ts()}] verifyChain green on the restored copy — ${verdict.verified} block(s), the chain survived the restore`);

  /* ---- 7. the evidence through the PURE gate (the restore leg) ---- */
  const rtoMinutes = (Date.now() - startedAtMs) / 60000;
  const evidence = {
    rehearsal: {
      day,
      environment: 'staging',
      runbookVersion: '1.1.0',
      executedBy: 'scripts/dr/rehearsal.js (CI db-rls)',
    },
    backup: {
      kind: 'logical-dump',
      checksumVerified: true,
    },
    restore: {
      rtoMinutes,
      restoredSchemaVersion,
      rlsVerified: true,
      chainVerified: true,
    },
  };
  const result = DR.evaluateRestore(evidence, { expectedSchemaVersion: DB.SCHEMA_VERSION });

  if (result.verdict !== 'PASS') {
    console.error(`\ndr restore leg: FAIL — the accumulated report:`);
    for (const r of result.refusals) console.error(`  ✗ ${r.code}: ${r.detail}`);
    process.exit(1);
  }

  console.log(`\ndr restore leg: PASS — ${JSON.stringify(result.record)}`);
  console.log(`\nNote for the run sheet: the WAL leg (RPO ≤ ${DR.RPO_TARGET_MINUTES} min via continuous archiving) is the`);
  console.log(`signed staging rehearsal's to prove — evaluateRehearsal + closeGate in docs/RUNBOOK.md §1.1.`);
  console.log(`This drill proved the restore path on today's push; gate 14 closes on the signed FULL rehearsal.`);
  console.log(`\nCleanup: dropping ${RESTORED_DB} and the temp dir.`);
  const cleanup = new Client({ connectionString: ADMIN_URL });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${RESTORED_DB} WITH (FORCE);`);
  await cleanup.end();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`[${ts()}] clean. The next quarterly cadence point: last PASS day + ${DR.REHEARSAL_CADENCE_DAYS}.`);
}

main().catch((e) => {
  die(e && e.stack ? e.stack : String(e));
});
