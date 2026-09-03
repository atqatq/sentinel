#!/usr/bin/env node
/* ============================================================================
 * prepare-db.mjs — the §14.24 database contract, runner-side.
 *
 * Brings the smoke database to the state the smoke asserts against:
 *   1. applies ALL of packages/db/migrations in sorted order — the SAME
 *      files the live proofs apply (one schema truth; no compose-side
 *      parallel migration path exists to drift from it);
 *   2. creates the SERVICE roles with the DEPLOYMENT shape — sentinel_web
 *      and sentinel_worker: each
 *      LOGIN, NOBYPASSRLS, non-superuser, member of the migrations'
 *      NOLOGIN sentinel_app (which carries the table grants) — one role per
 *      long-running service, the way a deployment names them — because an
 *      admin-connection smoke would skip the very thing the RLS discipline
 *      exists to prove;
 *   3. seeds the smoke tenant into the registry, synthetically (D-003),
 *      idempotently (ON CONFLICT DO NOTHING — prepare is re-runnable
 *      without apology). The code is the screens' default, so the smoke's
 *      assertions ride the URL a real user's first click produces.
 *   4. verifies its own work: the role shape and the membership are
 *      asserted against pg_roles/pg_auth_members, not assumed.
 *
 * Requires a reachable postgres via DATABASE_URL_ADMIN (CI: the §14.24
 * compose db service on 127.0.0.1:5433) and the pg module resolvable from
 * packages/db (CI installs pg@8 --no-save there, the db-rls job's pattern).
 * ==========================================================================*/
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { REPO_ROOT } from './repo-root.mjs';

/* The repo root is the ONE shared definition (scripts/e2e/repo-root.mjs) —
 * executed and tree-verified by the named proof, never a per-script
 * dirname() ladder that can be one short. */
const require_ = createRequire(join(REPO_ROOT, 'packages', 'db', 'package.json'));
const { Client } = require_('pg');

const ADMIN_URL = process.env.DATABASE_URL_ADMIN || 'postgres://postgres:postgres@127.0.0.1:5433/sentinel';

/* The smoke tenant — synthetic, fixed, the screens' default code (the
 * /suppliers page's `tenantParam ?? "BahrainMP"`). */
const SMOKE_TENANT = {
  id: '22222222-2222-4222-8222-222222222222',
  code: 'BahrainMP',
  name: 'Bahrain Smoke (synthetic)',
};

function fail(msg) { console.error('  ✗ prepare: ' + msg); process.exit(1); }
function ok(msg) { console.log('  ✓ ' + msg); }

const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'db', 'migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((d) => /^\d{4}_/.test(d)).sort()
  .map((d) => readFileSync(join(MIGRATIONS_DIR, d, 'migration.sql'), 'utf8'))
  .join('\n');

async function main() {
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    /* ---- 1. the migrations, the same files the live proofs apply ---- */
    await db.query(MIGRATIONS);
    ok(`all migrations applied (sorted, ${MIGRATIONS.length} chars of SQL — packages/db's own files)`);

    /* ---- 2. the service roles: the deployment shape, not the admin shortcut ---- */
    for (const role of ['sentinel_web', 'sentinel_worker']) {
      await db.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
             CREATE ROLE "${role}" LOGIN PASSWORD 'smoke-only' NOBYPASSRLS NOSUPERUSER;
           END IF;
         END $$;`);
      await db.query(`GRANT "sentinel_app" TO "${role}";`);
    }

    /* ---- 3. the tenant registry seed, synthetic and idempotent ---- */
    await db.query(
      `INSERT INTO tenant (id, code, name, currency_code, timezone)
       VALUES ($1, $2, $3, 'BHD', 'Asia/Bahrain')
       ON CONFLICT (code) DO NOTHING`,
      [SMOKE_TENANT.id, SMOKE_TENANT.code, SMOKE_TENANT.name],
    );

    /* ---- 3b. the smoke tenant's UNIT CATALOG — the pipeline's mandatory
     * reference dataset (validateUnitCatalog refuses an empty catalog: a
     * tenant without one is an unconfigurable tenant, and the refusal is
     * the strict posture working — run 80's lesson). The codes/aliases are
     * EXACTLY the shape the golden fixtures consume (the worker tests' stub
     * catalog shape, now real rows); idempotent like every seed here. ---- */
    await db.query(
      `INSERT INTO unit_catalog_entry (tenant_id, code, name, factor, is_base)
       VALUES
         ($1, 'KG',   'kilogram (synthetic smoke)', 1, true),
         ($1, 'CTN',  'carton (synthetic smoke)',   NULL, false),
         ($1, 'EACH', 'each (synthetic smoke)',     NULL, false),
         ($1, 'CASE', 'case (synthetic smoke)',     NULL, false)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [SMOKE_TENANT.id],
    );
    await db.query(
      `INSERT INTO unit_alias (tenant_id, alias, catalog_entry_id)
       SELECT $1, a.alias, e.id
         FROM (VALUES ('kilogram', 'KG'), ('cases', 'CASE')) AS a(alias, code)
         JOIN unit_catalog_entry e ON e.tenant_id = $1 AND e.code = a.code
       ON CONFLICT (tenant_id, alias) DO NOTHING`,
      [SMOKE_TENANT.id],
    );

    /* ---- 4. verify its own work — the shape is asserted, not assumed ---- */
    for (const roleName of ['sentinel_web', 'sentinel_worker']) {
      const role = await db.query(
        `SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1`, [roleName]);
      const r = role.rows[0];
      if (!r) fail(`${roleName} does not exist after prepare`);
      if (!r.rolcanlogin || r.rolbypassrls || r.rolsuper) {
        fail(`${roleName} has the wrong shape: login=${r.rolcanlogin} bypassrls=${r.rolbypassrls} super=${r.rolsuper}`);
      }
      ok(`${roleName}: LOGIN, NOBYPASSRLS, non-superuser`);

      const member = await db.query(
        `SELECT 1 FROM pg_auth_members m
         JOIN pg_roles app ON app.oid = m.roleid
         JOIN pg_roles svc ON svc.oid = m.member
         WHERE app.rolname = 'sentinel_app' AND svc.rolname = $1`, [roleName]);
      if (member.rowCount !== 1) fail(`${roleName} is not a member of sentinel_app — the table grants would not reach it`);
      ok(`${roleName} is a member of sentinel_app (the migrations' grantee)`);
    }

    const t = await db.query(`SELECT id, code, name FROM tenant WHERE code = $1`, [SMOKE_TENANT.code]);
    if (t.rowCount !== 1) fail(`tenant '${SMOKE_TENANT.code}' missing from the registry after seed`);
    ok(`tenant '${SMOKE_TENANT.code}' in the registry (synthetic, D-003)`);
  } finally {
    await db.end();
  }
}

main().catch((e) => fail((e && e.message) || String(e)));
