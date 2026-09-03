// ---------------------------------------------------------------------------
// The e2e-smoke — the named proof `e2e/smoke` (§14.24; §7.1 step 6's
// as-built shape).
//
// The dev/runtime environment of this proof carries NO docker daemon — and
// that is the point, exactly as §14.23's proof argued: compose proves the
// reality in CI (the e2e-smoke job builds the image, stands the stack,
// walks the fence over HTTP); THIS proof pins the shape, so a refactor
// that un-pins the base, publishes to the host network, reconnects as the
// admin shortcut, mutes an assertion, drops the teardown or demotes the
// job fails on the same push that changed it — before CI ever spends a
// docker minute.
//
// Pinned, per §14.24: the compose service set EXACTLY (db + web, and no
// build key in web — one image, one definition); postgres pinned by
// digest; loopback-only publishing; the db healthcheck and the
// service_healthy gate; DATABASE_URL connecting as sentinel_web (the
// deployment shape, never the admin shortcut); the prepare script's
// migrations read from the REAL directory in sorted order, the role
// created LOGIN/NOBYPASSRLS/non-superuser, the sentinel_app membership,
// the idempotent synthetic tenant seed, the script's own role-shape
// verification; the smoke script's assertion surface — every named
// assertion present, the §16 version stamps asserted by EXACT match
// against the real public surfaces, the nonzero exit on any red; and the
// ci.yml job text — job name, needs, proof step FIRST, the build, the
// up/prepare/up sequence, the teardown under if: always(), and the eight
// prior jobs still standing (the ninth joined, none left).
// ==========================================================================*/
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

/* scripts/e2e/test/smoke.test.mjs → four dirnames up = the repo root. */
const REPO_ROOT = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const COMPOSE = readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8');
const PREPARE = readFileSync(join(REPO_ROOT, 'scripts', 'e2e', 'prepare-db.mjs'), 'utf8');
const SMOKE = readFileSync(join(REPO_ROOT, 'scripts', 'e2e', 'smoke.mjs'), 'utf8');
const CI = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

/* The compose file's `services:` block runs to end-of-file in this stack. */
function composeServiceBlock(name) {
  const start = COMPOSE.indexOf(`  ${name}:\n`);
  assert.ok(start !== -1, `service ${name} must be declared`);
  return COMPOSE.slice(start);
}

/* The ci.yml job block: from `  e2e-smoke:` to the next top-level job or EOF. */
function ciJob(name) {
  const start = CI.indexOf(`\n  ${name}:\n`);
  assert.ok(start !== -1, `ci.yml must carry a ${name} job`);
  const rest = CI.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/* --------------------------------------------------------------- compose -- */

test('the stack is named sentinel-smoke and lives at the repo root', () => {
  assert.match(COMPOSE, /^name: sentinel-smoke$/m);
});

test('the service set is EXACTLY db + web — §7.4’s unconsumed topology is set dressing, not shipped', () => {
  const names = [...COMPOSE.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)].map((m) => m[1]);
  assert.deepStrictEqual(names, ['db', 'web'], 'a service with no runtime consumer must not exist yet — each joins when its consumer lands');
});

test('the db base is pinned BY DIGEST — postgres:16 floats for no one (§14.23 clause 2 extended)', () => {
  const db = composeServiceBlock('db');
  assert.match(db, /image: postgres:16@sha256:[0-9a-f]{64}\n/);
});

test('publishing is loopback-only — the smoke’s surface is the runner’s loopback, never 0.0.0.0', () => {
  const ports = [...COMPOSE.matchAll(/^      - "([^"]+)"\n/gm)].map((m) => m[1]);
  assert.ok(ports.length >= 2, `both services publish a port (found: ${ports.join(', ')})`);
  for (const p of ports) assert.match(p, /^127\.0\.0\.1:\d+:\d+$/, `every published port binds 127.0.0.1 — got "${p}"`);
});

test('the db healthcheck is the pg_isready probe and web waits for service_healthy', () => {
  const db = composeServiceBlock('db');
  assert.match(db, /healthcheck:\n/);
  assert.match(db, /pg_isready -U postgres -d sentinel/);
  const web = composeServiceBlock('web');
  assert.match(web, /depends_on:\n      db:\n        condition: service_healthy\n/);
});

test('web declares NO build key — one image, one definition: compose consumes what the job built', () => {
  const web = composeServiceBlock('web');
  assert.ok(!/^    build:/m.test(web), 'a second build story is a second artifact that can drift — the job builds THE Dockerfile, compose consumes it');
  assert.match(web, /image: sentinel-web:ci\n/);
});

test('DATABASE_URL connects as sentinel_web — the deployment shape, never the admin shortcut', () => {
  const web = composeServiceBlock('web');
  assert.match(web, /DATABASE_URL: postgres:\/\/sentinel_web:smoke-only@db:5432\/sentinel\n/);
  assert.ok(!/postgres:postgres@db/.test(web), 'connecting as the admin role would skip the very thing the RLS discipline exists to prove');
});

/* ------------------------------------------------------------ prepare-db -- */

test('prepare applies the REAL migrations — packages/db/migrations, sorted, the live proofs’ set', () => {
  assert.match(PREPARE, /readdirSync\(MIGRATIONS_DIR\)/);
  assert.match(PREPARE, /\/\^\\d\{4\}_\/\.test\(d\)\)\.sort\(\)/);
  assert.match(PREPARE, /packages', 'db', 'migrations/);
  assert.match(PREPARE, /await db\.query\(MIGRATIONS\)/);
});

test('the web role is created LOGIN, NOBYPASSRLS, NOSUPERUSER — the deployment shape', () => {
  assert.match(PREPARE, /CREATE ROLE "sentinel_web" LOGIN PASSWORD 'smoke-only' NOBYPASSRLS NOSUPERUSER/);
});

test('sentinel_web joins sentinel_app — the migrations’ grantee is how the table grants reach the web role', () => {
  assert.match(PREPARE, /GRANT "sentinel_app" TO "sentinel_web";/);
});

test('the tenant seed is idempotent and uses the screens’ default code (D-003 synthetic)', () => {
  assert.match(PREPARE, /ON CONFLICT \(code\) DO NOTHING/);
  assert.match(PREPARE, /code: 'BahrainMP'/);
});

test('prepare verifies its own work — role shape and membership asserted, not assumed', () => {
  assert.match(PREPARE, /SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles/);
  assert.match(PREPARE, /pg_auth_members/);
  assert.match(PREPARE, /fail\(`sentinel_web has the wrong shape/);
});

test('prepare fails loud — any red verification exits nonzero', () => {
  assert.match(PREPARE, /function fail\(msg\) \{ console\.error\('  ✗ prepare: ' \+ msg\); process\.exit\(1\); \}/);
});

/* ---------------------------------------------------------------- smoke --- */

test('the smoke asserts /health: 200, ok, service, dataState and no-store (§14.24 clause 10a)', () => {
  assert.match(SMOKE, /get\('\/health'\)/);
  assert.match(SMOKE, /health\.ok === true/);
  assert.match(SMOKE, /health\.service === 'sentinel-web'/);
  assert.match(SMOKE, /health\.dataState === 'OK'/);
  assert.match(SMOKE, /includes\('no-store'\)/);
});

test('the §16 stamps are EXACT matches against the real public surfaces (ADR-0001), not shape checks', () => {
  assert.match(SMOKE, /require_\('@sentinel\/db'\)/);
  assert.match(SMOKE, /require_\('@sentinel\/module-planning-engine'\)/);
  assert.match(SMOKE, /v\.app === WEB_PKG\.version/);
  assert.match(SMOKE, /v\.engine === ENGINE\.ENGINE_VERSION/);
  assert.match(SMOKE, /v\.schema === DB\.SCHEMA_VERSION/);
});

test('the shell stands: / renders 200 with the wordmark (clause 10b)', () => {
  assert.match(SMOKE, /get\('\/'\)/);
  assert.match(SMOKE, /home\.text\.includes\('Sentinel'\)/);
});

test('an unknown tenant renders 200 with the fence’s TENANT state verbatim (clause 10c — a named state, never a 500)', () => {
  assert.match(SMOKE, /UNKNOWN_TENANT/);
  assert.match(SMOKE, /t\.status === 200/);
  assert.match(SMOKE, /t\.text\.includes\('\(TENANT\)'\)/);
});

test('the seeded, never-sealed tenant renders the fence’s FRESHNESS state verbatim (clause 10d — no seal, no stamp, honest refusal)', () => {
  assert.match(SMOKE, /get\('\/suppliers'\)/);
  assert.match(SMOKE, /f\.status === 200/);
  assert.match(SMOKE, /f\.text\.includes\('\(FRESHNESS\)'\)/);
});

test('the smoke fails loud — any red assertion (or a crash) exits nonzero', () => {
  assert.match(SMOKE, /process\.exit\(failed > 0 \? 1 : 0\)/);
  assert.match(SMOKE, /process\.exit\(1\);\n\}\);/);
});

test('the smoke waits for the container to boot — a readiness poll against /health, never a single-shot race', () => {
  assert.match(SMOKE, /waitForServer/);
  assert.match(SMOKE, /AbortSignal\.timeout\(2_000\)/);
  assert.match(SMOKE, /server not ready within/);
});

test('the smoke’s network story is the loopback — SMOKE_BASE_URL defaults to 127.0.0.1, no egress', () => {
  assert.match(SMOKE, /process\.env\.SMOKE_BASE_URL \|\| 'http:\/\/127\.0\.0\.1:3000'/);
});

/* ------------------------------------------------------------------- ci --- */

test('the e2e-smoke job exists, is merge-blocking (no continue-on-error) and needs guard + web-shell', () => {
  const job = ciJob('e2e-smoke');
  assert.match(job, /needs: \[guard, web-shell\]/);
  assert.ok(!job.includes('continue-on-error'), 'a merge-blocking gate never carries a mute switch');
});

test('the proof runs FIRST — no docker minute before the contract is checked (§14.23’s ordering, repeated)', () => {
  const job = ciJob('e2e-smoke');
  const proof = job.indexOf('node scripts/e2e/test/smoke.test.mjs');
  const build = job.indexOf('docker build --tag sentinel-web:ci .');
  assert.ok(proof !== -1, 'the named proof e2e/smoke must run in the job');
  assert.ok(build !== -1, 'the job must build the image itself');
  assert.ok(proof < build, 'proof before build');
});

test('the job builds the EXACT tag compose consumes — sentinel-web:ci, one definition', () => {
  const job = ciJob('e2e-smoke');
  assert.match(job, /docker build --tag sentinel-web:ci \./);
});

test('the up/prepare/up sequence stands the stack in contract order', () => {
  const job = ciJob('e2e-smoke');
  const upDb = job.indexOf('docker compose up -d --wait db');
  const install = job.indexOf('npm install --prefix packages/db pg@8 --no-save');
  const prepare = job.indexOf('node scripts/e2e/prepare-db.mjs');
  const upWeb = job.indexOf('docker compose up -d web');
  const smoke = job.indexOf('node scripts/e2e/smoke.mjs');
  for (const [name, idx] of [['up db', upDb], ['pg install', install], ['prepare', prepare], ['up web', upWeb], ['smoke', smoke]]) {
    assert.ok(idx !== -1, `the job must carry the ${name} step`);
  }
  assert.ok(upDb < install && install < prepare && prepare < upWeb && upWeb < smoke, 'the sequence is up db → pg install → prepare → up web → smoke');
  assert.match(job, /DATABASE_URL_ADMIN: postgres:\/\/postgres:postgres@127\.0\.0\.1:5433\/sentinel/);
  assert.match(job, /SMOKE_BASE_URL: http:\/\/127\.0\.0\.1:3000/);
});

test('the teardown is part of the contract — down -v under if: always()', () => {
  const job = ciJob('e2e-smoke');
  const teardown = job.indexOf('docker compose down -v --remove-orphans');
  assert.ok(teardown !== -1, 'an ephemeral stack must not leak into the next run');
  assert.match(job, /if: always\(\)/);
});

test('the eight prior jobs still stand — the ninth joined, none left', () => {
  for (const j of ['guard', 'security', 'golden-tests', 'ingestion-tests', 'db-rls', 'ui-checks', 'web-shell', 'image-build']) {
    assert.match(CI, new RegExp(`\\n  ${j}:\\n`), `job ${j} must remain`);
  }
});

console.log(`\n  e2e/smoke: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
