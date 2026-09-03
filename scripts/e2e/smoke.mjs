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
 * SMOKE_BASE_URL (default the compose web service on the runner's loopback).
 * ==========================================================================*/
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

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

  console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('  ✗ smoke crashed: ' + ((e && e.message) || String(e)));
  process.exit(1);
});
