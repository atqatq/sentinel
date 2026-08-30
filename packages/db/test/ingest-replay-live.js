'use strict';
/* ============================================================================
 * Ingest-replay LIVE proof — the H6 idempotent upsert wrapper against a real
 * PostgreSQL (M2 pipeline wiring; A7 named proof `ingest/idempotent-per-
 * tenant-replay`). Companion to plan-seal-live.js and rls-deny-matrix.js
 * (same conventions: scratch database, ALL migrations, probe role under
 * sentinel_app, GUC per transaction/session).
 *
 * Requires a reachable PostgreSQL via DATABASE_URL_ADMIN (CI: postgres:16
 * service). The script:
 *   1. creates a scratch database and applies ALL migrations
 *   2. seeds two synthetic tenants (owner + transaction GUC)
 *   3. drives the REAL decision layer (planIngestFile) over the REAL
 *      executor (makeIngestAdapter) through probe sessions, and proves:
 *        - fresh apply: file register APPLIED, rows upserted, key register
 *          populated with file_checksum stamped;
 *        - same-file replay: REPLAY_NOOP — row/register/file counts and
 *          applied_at all unchanged, and the REPLAY_NOOP plan is refused by
 *          the executor (it must never reach the database);
 *        - the SAME fixture into the OTHER tenant: APPLY, not replay —
 *          independent rows (the H6 defect is dead: tenant scoping lives in
 *          the register column);
 *        - a NEW file with overlapping keys: upsert in place, register
 *          unchanged, DAT-04 duplicateHits honest;
 *        - a FAILED file reprocesses in place (no forked history);
 *        - supplier H7 identity: same external ID, different spelling MERGES;
 *        - RLS: cross-tenant register reads/writes denied.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const REPO = path.join(__dirname, '..', '..', '..');
const { planIngestFile } = require(path.join(REPO, 'packages/core/modules/ingestion/src/idempotency'));
const { makeIngestAdapter } = require(path.join(REPO, 'packages/db/ingest-adapter'));

const ADMIN_URL = process.env.DATABASE_URL_ADMIN || 'postgres://postgres@127.0.0.1:5433/postgres';
const LIVE_DB = 'sentinel_ingest_live';
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
  return `postgres://ingest_probe:probe@${u.hostname}:${u.port || 5432}/${db || LIVE_DB}`;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

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

  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ingest_probe') THEN
      CREATE ROLE ingest_probe LOGIN PASSWORD 'probe';
    END IF;
  END $$;`);
  await db.query(`GRANT sentinel_app TO ingest_probe;`);

  /* ---- 2. two synthetic tenants ---- */
  async function asTenant(tenantId, fn) {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    try { return await fn(); } finally { await db.query('COMMIT'); }
  }
  const T = {};
  for (const [key, code] of [['A', 'ingest-alpha'], ['B', 'ingest-beta']]) {
    T[key] = (await db.query(
      `INSERT INTO tenant (code, name, currency_code, timezone) VALUES ($1,$2,'BHD','Asia/Bahrain') RETURNING id`,
      [code, `Tenant ${key} (synthetic)`])).rows[0].id;
  }

  /* tenant probe sessions (explicit connections, GUC per session) */
  const clientA = new Client({ connectionString: probeUrl() });
  await clientA.connect();
  await clientA.query(`SELECT set_config('app.tenant_id', $1, false)`, [T.A]);
  const clientB = new Client({ connectionString: probeUrl() });
  await clientB.connect();
  await clientB.query(`SELECT set_config('app.tenant_id', $1, false)`, [T.B]);

  const adapterA = makeIngestAdapter(clientA, T.A);
  const adapterB = makeIngestAdapter(clientB, T.B);
  async function tx(client, fn) {
    await client.query('BEGIN');
    try {
      const out = await fn();
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }

  const ITEM_ROWS = [
    { sku: 'SKU-1', itemName: 'Tomato paste', unit: 'CTN', price: 6.5 },
    { sku: 'SKU-2', itemName: 'Olives', unit: 'BTL' },
    { sku: 'SKU-3', itemName: 'Flour', unit: 'KG' },
  ];
  const FIXTURE = { tenantId: T.A, kind: 'items', fileName: 'items-week-35.xlsx', byteSize: 2048, mode: 'A', rows: ITEM_ROWS };

  /* ---- 3. fresh apply ---- */
  console.log('\nFresh apply: file register APPLIED, rows upserted, register populated');
  const seenA1 = await adapterA.loadSeenKeys('items');
  const priorA1 = await adapterA.findFile('items', sha('v1'));
  const plan1 = planIngestFile({ ...FIXTURE, checksum: sha('v1'), seen: seenA1, prior: priorA1 });
  if (plan1.action === 'APPLY' && plan1.keysIngested === 3 && plan1.duplicateHits === 0) {
    ok('the decision layer plans APPLY with honest zeros on an empty register');
  } else bad('fresh plan wrong', JSON.stringify({ action: plan1.action, hits: plan1.duplicateHits }));

  const r1 = await tx(clientA, () => adapterA.apply(plan1));
  if (r1.rowsApplied === 3 && r1.keysRegistered === 3) ok(`apply executed: ${r1.rowsApplied} rows, ${r1.keysRegistered} keys registered`);
  else bad('apply counts wrong', JSON.stringify(r1));

  const fileRow = (await clientA.query(`SELECT status::text AS s, row_count FROM ingest_file WHERE checksum_sha256 = $1`, [sha('v1')])).rows[0];
  if (fileRow && fileRow.s === 'APPLIED' && fileRow.row_count === 3) ok('ingest_file row is APPLIED with the row count');
  else bad('ingest_file row wrong', JSON.stringify(fileRow));
  const itemsA = (await clientA.query(`SELECT count(*)::int AS n FROM item`)).rows[0].n;
  if (itemsA === 3) ok('3 item rows upserted for tenant A');
  else bad(`expected 3 items, got ${itemsA}`);
  const reg1 = (await clientA.query(`SELECT count(*)::int AS n, count(file_checksum)::int AS stamped FROM idempotency_key`)).rows[0];
  if (reg1.n === 3 && reg1.stamped === 3) ok('key register holds 3 keys, file_checksum stamped on all');
  else bad('register wrong', JSON.stringify(reg1));

  /* ---- 4. same-file replay: changes nothing ---- */
  console.log('\nReplay: the same file applied twice changes nothing (named proof, live half)');
  const priorA2 = await adapterA.findFile('items', sha('v1'));
  const seenA2 = await adapterA.loadSeenKeys('items');
  const plan2 = planIngestFile({ ...FIXTURE, checksum: sha('v1'), seen: seenA2, prior: priorA2 });
  if (plan2.action === 'REPLAY_NOOP' && plan2.rowsApplied === 0 && plan2.duplicateHits === 3 &&
      plan2.fileId === priorA2.id && plan2.appliedAt === priorA2.appliedAt) {
    ok('prior APPLIED → REPLAY_NOOP carrying the prior identity, duplicateHits = all keys');
  } else bad('replay decision wrong', JSON.stringify({ action: plan2.action, hits: plan2.duplicateHits }));

  /* the adapter refusal is a TypeError (no pg code) — prove it directly: */
  {
    let refused = false;
    try { await tx(clientA, () => adapterA.apply(plan2)); } catch (e) { refused = e.message.startsWith('apply: expected an APPLY plan'); }
    if (refused) ok('confirmed: apply(REPLAY_NOOP) throws before any statement');
    else bad('REPLAY_NOOP reached the executor unrefused');
  }

  const after = {
    items: (await clientA.query(`SELECT count(*)::int AS n FROM item`)).rows[0].n,
    reg: (await clientA.query(`SELECT count(*)::int AS n FROM idempotency_key`)).rows[0].n,
    files: (await clientA.query(`SELECT count(*)::int AS n FROM ingest_file`)).rows[0].n,
  };
  const priorA3 = await adapterA.findFile('items', sha('v1'));
  if (after.items === 3 && after.reg === 3 && after.files === 1 && priorA3.appliedAt === priorA2.appliedAt) {
    ok('rows, register, file count and applied_at ALL unchanged after the replay');
  } else bad('replay changed something', JSON.stringify({ ...after, at1: priorA2.appliedAt, at2: priorA3.appliedAt }));

  /* ---- 5. the same fixture, the OTHER tenant: independent rows ---- */
  console.log('\nPer-tenant independence: the same fixture, two tenants');
  const seenB1 = await adapterB.loadSeenKeys('items');
  const priorB1 = await adapterB.findFile('items', sha('v1'));
  const planB1 = planIngestFile({ ...FIXTURE, tenantId: T.B, checksum: sha('v1'), seen: seenB1, prior: priorB1 });
  if (planB1.action === 'APPLY' && seenB1.length === 0) {
    ok("tenant B's register is EMPTY for the same keys — the H6 defect (cross-tenant collision) is structurally dead");
  } else bad('tenant B should plan APPLY on an empty register', JSON.stringify({ action: planB1.action, seen: seenB1.length }));
  await tx(clientB, () => adapterB.apply(planB1));
  const itemsB = (await clientB.query(`SELECT count(*)::int AS n FROM item`)).rows[0].n;
  if (itemsB === 3) ok('tenant B holds its own 3 rows from the identical fixture');
  else bad(`tenant B items = ${itemsB}`);
  const crossReg = (await clientA.query(`SELECT count(*)::int AS n FROM idempotency_key`)).rows[0].n;
  if (crossReg === 3) ok("tenant A still sees only its own 3 register keys (RLS + tenant-leading unique)");
  else bad(`tenant A register now shows ${crossReg}`);
  const planB2 = planIngestFile({ ...FIXTURE, tenantId: T.B, checksum: sha('v1'), seen: await adapterB.loadSeenKeys('items'), prior: await adapterB.findFile('items', sha('v1')) });
  if (planB2.action === 'REPLAY_NOOP') ok('replay in tenant B is also a no-op — each tenant replays independently');
  else bad('tenant B replay wrong', planB2.action);

  /* ---- 6. a NEW file with overlapping keys: upsert, DAT-04 honest ---- */
  console.log('\nNew file, overlapping keys: upsert in place, register never duplicated');
  const CHANGED = ITEM_ROWS.map((r) => ({ ...r, itemName: r.itemName + ' (renamed)' }));
  const plan3 = planIngestFile({ ...FIXTURE, checksum: sha('v2'), rows: CHANGED, seen: await adapterA.loadSeenKeys('items'), prior: await adapterA.findFile('items', sha('v2')) });
  if (plan3.action === 'APPLY' && plan3.duplicateHits === 3 && plan3.newKeys === 0) {
    ok('DAT-04 accounting: all 3 keys seen before — duplicateHits 3, newKeys 0');
  } else bad('DAT-04 stats wrong', JSON.stringify({ action: plan3.action, hits: plan3.duplicateHits }));
  const r3 = await tx(clientA, () => adapterA.apply(plan3));
  const afterV2 = {
    items: (await clientA.query(`SELECT count(*)::int AS n FROM item`)).rows[0].n,
    reg: (await clientA.query(`SELECT count(*)::int AS n FROM idempotency_key`)).rows[0].n,
    files: (await clientA.query(`SELECT count(*)::int AS n FROM ingest_file`)).rows[0].n,
    renamed: (await clientA.query(`SELECT count(*)::int AS n FROM item WHERE name LIKE '%renamed%'`)).rows[0].n,
  };
  if (afterV2.items === 3 && afterV2.reg === 3 && afterV2.files === 2 && afterV2.renamed === 3 && r3.keysRegistered === 0) {
    ok('values updated in place: items stay 3, register stays 3 (DO NOTHING), second file registered, names renamed');
  } else bad('upsert semantics wrong', JSON.stringify({ ...afterV2, keysRegistered: r3.keysRegistered }));

  /* ---- 7. a FAILED file reprocesses in place ---- */
  console.log('\nReprocess: a FAILED file retries into the SAME history slot');
  await asTenant(T.A, async () => {
    await db.query(
      `INSERT INTO ingest_file (tenant_id, kind, mode, file_name, checksum_sha256, byte_size, status, row_count)
       VALUES ($1,'items','A','crashed.xlsx',$2,512,'FAILED',NULL)`,
      [T.A, sha('v3')]);
  });
  const priorV3 = await adapterA.findFile('items', sha('v3'));
  const plan4 = planIngestFile({ ...FIXTURE, checksum: sha('v3'), fileName: 'crashed.xlsx', byteSize: 512, rows: ITEM_ROWS, seen: await adapterA.loadSeenKeys('items'), prior: priorV3 });
  if (plan4.action === 'APPLY' && plan4.reprocessOf === priorV3.id) ok('prior FAILED → APPLY reprocessing the same register row');
  else bad('reprocess decision wrong', JSON.stringify({ action: plan4.action, reprocessOf: plan4.reprocessOf }));
  await tx(clientA, () => adapterA.apply(plan4));
  const v3rows = (await clientA.query(`SELECT count(*)::int AS n FROM ingest_file WHERE checksum_sha256 = $1`, [sha('v3')])).rows[0].n;
  const v3status = (await clientA.query(`SELECT status::text AS s FROM ingest_file WHERE checksum_sha256 = $1`, [sha('v3')])).rows[0].s;
  if (v3rows === 1 && v3status === 'APPLIED') ok('the FAILED row is UPDATED in place — no forked file history');
  else bad('reprocess forked or lost the file row', JSON.stringify({ v3rows, v3status }));

  /* ---- 8. H7 supplier identity, live ---- */
  console.log('\nH7 supplier identity: same ID, different spelling MERGES');
  await tx(clientA, () => adapterA.apply(planIngestFile({
    tenantId: T.A, kind: 'suppliers', checksum: sha('sup1'), fileName: 'suppliers.xlsx', byteSize: 64, mode: 'A',
    rows: [{ supplierExternalId: 'SUP-9', supplierName: 'Gulf Foods LLC' }],
  })));
  await tx(clientA, () => adapterA.apply(planIngestFile({
    tenantId: T.A, kind: 'suppliers', checksum: sha('sup2'), fileName: 'suppliers-r4.xlsx', byteSize: 64, mode: 'A',
    rows: [{ supplierExternalId: 'SUP-9', supplierName: 'Gulf Foods L.L.C. (spelled differently)' }],
  })));
  const sup = (await clientA.query(`SELECT count(*)::int AS n FROM supplier WHERE external_id = 'SUP-9'`)).rows[0].n;
  const supName = (await clientA.query(`SELECT name FROM supplier WHERE external_id = 'SUP-9'`)).rows[0].name;
  if (sup === 1 && supName.includes('spelled differently')) ok('one supplier row per external ID; the re-spelled import merged into it');
  else bad('supplier merge wrong', JSON.stringify({ sup, supName }));

  /* ---- 9. deliveries daily wiring + non-daily refusal ---- */
  console.log('\nDeliveries: daily rows upsert per day; other granularities refuse, named');
  await tx(clientA, () => adapterA.apply(planIngestFile({
    tenantId: T.A, kind: 'deliveries', checksum: sha('del1'), fileName: 'deliveries.xlsx', byteSize: 64, mode: 'A',
    rows: [
      { periodStart: '2026-08-28', periodEnd: '2026-08-28', granularity: 'daily', qty: 12 },
      { periodStart: '2026-08-29', periodEnd: '2026-08-29', granularity: 'daily', qty: 9 },
    ],
  })));
  const dels = (await clientA.query(`SELECT count(*)::int AS n FROM delivery_day`)).rows[0].n;
  if (dels === 2) ok('2 daily delivery rows stored');
  else bad(`delivery rows = ${dels}`);
  {
    let refused = false;
    try {
      await tx(clientA, () => adapterA.apply(planIngestFile({
        tenantId: T.A, kind: 'deliveries', checksum: sha('del2'), fileName: 'weekly.xlsx', byteSize: 64, mode: 'A',
        rows: [{ periodStart: '2026-08-24', periodEnd: '2026-08-30', granularity: 'weekly', qty: 63 }],
      })));
    } catch (e) { refused = e.message.startsWith('DELIVERIES_NON_DAILY_NOT_WIRED'); }
    if (refused) ok('a weekly row refuses with DELIVERIES_NON_DAILY_NOT_WIRED — never silently stored');
    else bad('weekly row was not refused');
  }

  /* ---- 10. fail-closed at the boundary, nothing written ---- */
  console.log('\nFail-closed: an unkeyable row refuses the whole plan, nothing written');
  {
    const before = (await clientA.query(`SELECT count(*)::int AS n FROM item`)).rows[0].n;
    let refused = false;
    try {
      planIngestFile({ ...FIXTURE, checksum: sha('bad'), rows: [{ sku: 'SKU-9', itemName: 'x', unit: 'CTN' }, { itemName: 'no sku' }] });
    } catch (e) { refused = e.message.startsWith('MISSING_IDEMPOTENCY_KEY'); }
    const afterBad = (await clientA.query(`SELECT count(*)::int AS n FROM item`)).rows[0].n;
    if (refused && afterBad === before) ok('MISSING_IDEMPOTENCY_KEY refuses the WHOLE file — the keyed row is not half-applied');
    else bad('unkeyed file half-applied', JSON.stringify({ refused, afterBad, before }));
  }

  /* ---- 11. RLS on the register ---- */
  console.log('\nRLS: the register is tenant-fenced like every other table');
  const crossKeys = (await clientA.query(`SELECT count(*)::int AS n FROM idempotency_key WHERE tenant_id = $1`, [T.B])).rows[0].n;
  if (crossKeys === 0) ok("tenant A's session sees none of tenant B's register keys");
  else bad(`cross-tenant register read leaked ${crossKeys}`);
  await expectError('cross-tenant register WRITE is denied', () =>
    clientA.query(`INSERT INTO idempotency_key (tenant_id, kind, idem_key) VALUES ($1,'items','["X"]')`, [T.B]), '42501');

  await finish(db, clientA, clientB);
}

async function finish(db, clientA, clientB) {
  try { await clientA.end(); } catch (_) {}
  try { await clientB.end(); } catch (_) {}
  try { await db.end(); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error('LIVE-INGEST FATAL:', e.message); process.exit(1); });
