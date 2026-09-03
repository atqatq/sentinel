#!/usr/bin/env node
/* ============================================================================
 * smoke.mjs — the §14.24 smoke: the stack walked over HTTP, no browser.
 *
 * Assertions, each named in §14.24 clause 10:
 *   (a) /health answers 200 with ok/service/dataState/no-store and the
 *       §16 stamps — app, engine, schema — each EXACTLY equal to the
 *       workspace's real public-surface values (the running image must BE
 *       this tree's code, not a neighbor's);
 *   (b) / renders 200 — the shell stands;
 *   (c) /suppliers with an unknown tenant code renders 200 with the
 *       fence's TENANT state verbatim — a named state, never a 500;
 *   (d) /suppliers with the seeded tenant (never sealed) renders 200 with
 *       the fence's FRESHNESS state verbatim — no seal, no stamp, an
 *       honest refusal through the real path (§16's no-silent-numbers,
 *       walked in a container).
 *
 * Any red assertion exits nonzero — the CI job fails. The base URL rides
 * SMOKE_BASE_URL (default the compose web service on the runner's loopback);
 * the §14.24 clause-13 walk also needs the worker role's loopback URL
 * (SMOKE_DATABASE_URL_WORKER) for the FENCED register reads — never the
 * admin shortcut.
 * ==========================================================================*/
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

import { REPO_ROOT } from './repo-root.mjs';

/* The stamps are resolved BY PATH from the zero-dependency sources: the
 * e2e job installs NO workspace (the image is the artifact under test;
 * the runner needs only the tree's version constants to judge it). The
 * files are the same public surfaces the health route's packages expose
 * (ADR-0001) — @sentinel/db's schema-version module and the planning
 * engine's package main — read where they live. */
const requirePath = createRequire(import.meta.url);
const DB = requirePath(join(REPO_ROOT, 'packages', 'db', 'schema-version.js'));
const ENGINE = requirePath(join(REPO_ROOT, 'packages', 'core', 'modules', 'planning-engine', 'index.js'));
const WEB_PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'web', 'package.json'), 'utf8'));

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const UNKNOWN_TENANT = 'NoSuchTenant';

/* ---- clause 13: the walk's fixtures and surfaces ------------------------- */
const WALK_TENANT_CODE = 'BahrainMP'; // prepare's seeded code — the inbox folder IS the tenant code (§14.25 clause 2)
const WALK_FIXTURE = join(REPO_ROOT, 'fixtures', 'golden', 'suppliers_modeA_with_bank_columns.csv');
const WALK_INBOX = join(REPO_ROOT, 'e2e-inbox'); // the compose bind mount — CI-ephemeral, gitignored
const WORKER_DB_URL = process.env.SMOKE_DATABASE_URL_WORKER || 'postgres://sentinel_worker:smoke-only@127.0.0.1:5433/sentinel';
const requireFromDb = createRequire(join(REPO_ROOT, 'packages', 'db', 'package.json')); // pg rides the job's --no-save install (prepare's pattern)

let passed = 0, failed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function bad(name, detail) { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }

async function get(pathname) {
  const res = await fetch(BASE + pathname, { redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

/* React's SSR interleaves <!-- --> separators between adjacent text
 * segments — the page renders "(TENANT)" to the EYE, but the HTML carries
 * "(<!-- -->TENANT<!-- -->)". The verbatim-state matches run against the
 * comment-normalized markup, because the assertion's subject is what the
 * page SAYS, not how React serialized it. */
function html(t) {
  return t.replace(/<!--.*?-->/g, '');
}

/* The readiness poll — the container has NO compose-side healthcheck (the
 * distroless runtime ships no shell, so a container healthcheck cannot be a
 * shell exec; the orchestrator's probe is this loop). The smoke waits for
 * /health to answer before it asserts, so a slow boot is a wait, not a red. */
async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = (e && e.message) || String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return `server not ready within ${timeoutMs}ms: ${lastError}`;
}

/* A generalized settle poll — the file lands when the container's fence
 * commits and the daemon settles it; a slow poll cycle is a wait, not a red. */
async function waitForSettled(path, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return `the file never settled into ${path} within ${timeoutMs}ms`;
}

/* The FENCED register read — AS sentinel_worker, the same role the write
 * rode: BEGIN → set_config(app.tenant_id) → SELECT → COMMIT. The admin
 * shortcut would skip the very thing the RLS discipline exists to prove. */
async function fencedRegisterRead(fileName) {
  const { Client } = requireFromDb('pg');
  const client = new Client({ connectionString: WORKER_DB_URL });
  await client.connect();
  try {
    const tenant = await client.query(`SELECT id FROM tenant WHERE code = $1`, [WALK_TENANT_CODE]);
    if (tenant.rows.length !== 1) throw new Error(`tenant '${WALK_TENANT_CODE}' unresolved — prepare seeded it`);
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.rows[0].id]);
    const rows = await client.query(
      `SELECT file_name, kind, status, checksum_sha256 AS checksum, applied_at
         FROM ingest_file WHERE kind = 'suppliers' ORDER BY applied_at`,
    );
    await client.query('COMMIT');
    return rows.rows;
  } finally {
    await client.end();
  }
}

async function main() {
  console.log(`\n§14.24 e2e-smoke against ${BASE}\n`);

  const ready = await waitForServer();
  if (ready !== true) {
    console.error('  ✗ readiness: ' + ready);
    process.exit(1);
  }
  ok('/health answers — the container is up and serving');

  /* ---- (a) /health — the §16 stamps, exact against this tree ---- */
  const h = await get('/health');
  if (h.status === 200) ok('/health answers 200');
  else bad('/health answers 200', `got ${h.status}`);

  let health = null;
  try { health = JSON.parse(h.text); } catch { /* handled below */ }
  if (!health) {
    bad('/health body parses as JSON', h.text.slice(0, 120));
  } else {
    if (health.ok === true) ok('health.ok is true');
    else bad('health.ok is true', `got ${JSON.stringify(health.ok)}`);
    if (health.service === 'sentinel-web') ok('health.service is sentinel-web');
    else bad('health.service is sentinel-web', `got ${JSON.stringify(health.service)}`);
    if (health.dataState === 'OK') ok('health.dataState is OK');
    else bad('health.dataState is OK', `got ${JSON.stringify(health.dataState)}`);
    if ((h.headers.get('cache-control') || '').includes('no-store')) ok('the probe carries no-store');
    else bad('the probe carries no-store', `cache-control: ${h.headers.get('cache-control')}`);

    const v = health.versions || {};
    if (v.app === WEB_PKG.version) ok(`versions.app === ${WEB_PKG.version} (the running image IS this tree)`);
    else bad('versions.app matches apps/web/package.json', `got ${JSON.stringify(v.app)}`);
    if (v.engine === ENGINE.ENGINE_VERSION) ok(`versions.engine === ${ENGINE.ENGINE_VERSION} (the real planning-engine surface)`);
    else bad('versions.engine matches @sentinel/module-planning-engine', `got ${JSON.stringify(v.engine)}`);
    if (v.schema === DB.SCHEMA_VERSION) ok(`versions.schema === ${DB.SCHEMA_VERSION} (the real db surface)`);
    else bad('versions.schema matches @sentinel/db', `got ${JSON.stringify(v.schema)}`);
  }

  /* ---- (b) the shell stands ---- */
  const home = await get('/');
  if (home.status === 200 && home.text.includes('Sentinel')) ok('/ renders 200 with the shell (wordmark present)');
  else bad('/ renders 200 with the shell', `status ${home.status}`);

  /* ---- (c) unknown tenant → the fence's TENANT state, verbatim, still 200 ---- */
  const t = await get(`/suppliers?tenant=${UNKNOWN_TENANT}`);
  if (t.status === 200) ok('unknown tenant renders 200 (a named state, not a 500)');
  else bad('unknown tenant renders 200', `got ${t.status}`);
  if (html(t.text).includes('(TENANT)')) ok('the fence\'s TENANT state rendered verbatim');
  else bad('the fence\'s TENANT state rendered verbatim', `page for tenant=${UNKNOWN_TENANT} lacks "(TENANT)"`);

  /* ---- (d) the seeded, never-sealed tenant → FRESHNESS, verbatim ---- */
  const f = await get('/suppliers');
  if (f.status === 200) ok('default tenant renders 200 (the screens\' default code, seeded by prepare)');
  else bad('default tenant renders 200', `got ${f.status}`);
  if (html(f.text).includes('(FRESHNESS)')) ok('the fence\'s FRESHNESS state rendered verbatim (no seal → no stamp → honest refusal)');
  else bad('the fence\'s FRESHNESS state rendered verbatim', 'the never-sealed tenant\'s page lacks "(FRESHNESS)"');

  /* ---- (e) THE WALK — clause 13: the worker's file through the real stack.
   * The fixture's bytes are the H12-pinned golden suppliers file; the inbox
   * folder is the tenant code (the identity model); the assertions are the
   * settle, the fenced register read, and the REPLAY idempotency. -------- */
  const fixtureBytes = readFileSync(WALK_FIXTURE);
  const fixtureSha = createHash('sha256').update(fixtureBytes).digest('hex');
  mkdirSync(join(WALK_INBOX, WALK_TENANT_CODE), { recursive: true });
  // world-writable ON PURPOSE and DISCLOSED (clause 13): CI-ephemeral, destroyed by the
  // teardown, so the nonroot worker (UID 65532) can claim and settle inside it.
  chmodSync(WALK_INBOX, 0o777);
  chmodSync(join(WALK_INBOX, WALK_TENANT_CODE), 0o777);

  const walkName = 'suppliers_walk.csv';
  writeFileSync(join(WALK_INBOX, WALK_TENANT_CODE, walkName), fixtureBytes);
  const settled = await waitForSettled(join(WALK_INBOX, 'done', WALK_TENANT_CODE, walkName));
  if (settled === true) ok(`(e) the file settled done/${WALK_TENANT_CODE}/ — claim, fence and commit happened IN THE CONTAINER on the real database`);
  else bad('(e) the file settles into done/<TENANT_CODE>/', settled);

  let registerRows = null;
  try { registerRows = await fencedRegisterRead(walkName); }
  catch (e) { bad('(e) the fenced register read (AS sentinel_worker, the write\'s own fence)', (e && e.message) || String(e)); }
  if (registerRows) {
    const applied = registerRows.filter((r) => r.status === 'APPLIED');
    const row = applied.find((r) => r.file_name === walkName);
    if (row) {
      ok('(e) the register row: kind suppliers, status APPLIED (read through the write\'s own fence)');
      if (row.checksum === fixtureSha) ok('(e) the register checksum EXACTLY the fixture\'s pinned sha256 — the file that walked is byte-for-byte the pinned bytes');
      else bad('(e) the register checksum matches the fixture\'s pinned sha256', `register ${row.checksum} vs fixture ${fixtureSha}`);
    } else {
      bad('(e) the register row: kind suppliers, status APPLIED', `rows: ${JSON.stringify(registerRows)}`);
    }
  }

  /* the REPLAY — same bytes, a new name: §4's "re-importing the same file
   * changes nothing", walked live. */
  const replayName = 'suppliers_replay.csv';
  writeFileSync(join(WALK_INBOX, WALK_TENANT_CODE, replayName), fixtureBytes);
  const replaySettled = await waitForSettled(join(WALK_INBOX, 'done', WALK_TENANT_CODE, replayName));
  if (replaySettled === true) ok('(e) the replay settled done/ too (REPLAY_NOOP — it changed nothing)');
  else bad('(e) the replay settles into done/<TENANT_CODE>/', replaySettled);

  let replayRows = null;
  try { replayRows = await fencedRegisterRead(replayName); }
  catch (e) { bad('(e) the fenced register re-read after the replay', (e && e.message) || String(e)); }
  if (replayRows && registerRows) {
    if (replayRows.length === 1) ok('(e) after the replay the register STILL carries ONE suppliers row — the H6 unique never forked the history');
    else bad('(e) the register still carries exactly one suppliers row after the replay', `found ${replayRows.length}`);
    if (registerRows[0] && replayRows[0] && Number(replayRows[0].applied_at) === Number(registerRows[0].applied_at)) ok('(e) applied_at UNCHANGED by the replay — the prior outcome\'s identity is what a replay returns');
    else bad('(e) applied_at unchanged by the replay', `before ${registerRows[0] && registerRows[0].applied_at} / after ${replayRows[0] && replayRows[0].applied_at}`);
  }

  console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('  ✗ smoke crashed: ' + ((e && e.message) || String(e)));
  process.exit(1);
});
