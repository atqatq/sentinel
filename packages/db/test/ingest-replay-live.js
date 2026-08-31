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
 *        - supplier H7 identity: same external ID, different spelling — the
 *          identity delta stages a COOLING_OFF hold (the C3 freeze refuses
 *          the direct change) and the merge lands only out-of-band verified;
 *        - RLS: cross-tenant register reads/writes denied.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const REPO = path.join(__dirname, '..', '..', '..');
const { planIngestFile } = require(path.join(REPO, 'packages/core/modules/ingestion/src/idempotency'));
const { makeIngestAdapter } = require(path.join(REPO, 'packages/db/ingest-adapter'));
const { makeIngestWorkerAdapter } = require(path.join(REPO, 'packages/db/ingest-worker-adapter'));
const { makeProcureAdapter } = require(path.join(REPO, 'packages/db/procure-adapter'));
const { makeFxAdapter } = require(path.join(REPO, 'packages/db/fx-adapter'));
const { makeLedgerAdapter } = require(path.join(REPO, 'packages/db/ledger-adapter'));
const { normalizeMoney } = require(path.join(REPO, 'packages/core/modules/ingestion/src/normalize'));
const { classifySupplierChange } = require(path.join(REPO, 'packages/core/modules/approval/src/freeze'));

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

  /* ---- 6b. M7 (§14.13b): a changed conversion factor STAGES, never applies ---- */
  console.log('\nM7: a changed conversion factor stages — the stored factor keeps serving');
  const procureCF = makeProcureAdapter(clientA, T.A);
  const cfFactor = async () => { const v = (await clientA.query(`SELECT conversion_factor FROM item WHERE sku = 'SKU-1'`)).rows[0].conversion_factor; return v === null ? null : Number(v); };
  const cfPending = async () => (await clientA.query(
    `SELECT id, version, from_value, to_value, state::text AS state FROM item_cf_version WHERE tenant_id = $1 AND sku = 'SKU-1' AND state = 'PENDING' ORDER BY version`, [T.A])).rows;

  /* step 1: the factor is currently NULL — a first usable value is a change too: stages */
  const cfRows1 = [{ sku: 'SKU-1', itemName: 'Tomato paste', unit: 'CTN', price: 6.5, conversionFactor: 12 }];
  const planCF1 = planIngestFile({ ...FIXTURE, checksum: sha('v2-cf1'), fileName: 'items-cf-1.xlsx', rows: cfRows1, seen: await adapterA.loadSeenKeys('items'), prior: await adapterA.findFile('items', sha('v2-cf1')) });
  const rCF1 = await tx(clientA, () => adapterA.apply(planCF1));
  const v1s = await cfPending();
  if (rCF1.cf.staged === 1 && v1s.length === 1 && v1s[0].from_value === null && Number(v1s[0].to_value) === 12 && (await cfFactor()) === null) {
    ok('from-none-to-some stages: PENDING v1 (NULL → 12), the stored factor keeps serving (NULL)');
  } else bad('cf stage 1', JSON.stringify({ cf: rCF1.cf, versions: v1s, factor: await cfFactor() }));

  /* step 2: the door applies v1 — the factor moves to 12 */
  const procureV1 = v1s[0];
  const door1 = await tx(clientA, () => procureCF.resolveCfVersion({ versionId: procureV1.id, decidedBy: null, decision: 'APPLY', latestSeal: null }));
  if (door1.state === 'EFFECTIVE' && (await cfFactor()) === 12 && door1.tasksInserted === 0) {
    ok('the APPLY door moves the factor to 12 (no seal → no re-derivation tasks)');
  } else bad('cf door 1', JSON.stringify({ door: door1.state, factor: await cfFactor() }));

  /* step 3: a genuinely changed drop (12 → 24) stages v2; the stored 12 keeps serving */
  const cfRows2 = [{ sku: 'SKU-1', itemName: 'Tomato paste', unit: 'CTN', price: 6.5, conversionFactor: 24 }];
  const planCF2 = planIngestFile({ ...FIXTURE, checksum: sha('v2-cf2'), fileName: 'items-cf-2.xlsx', rows: cfRows2, seen: await adapterA.loadSeenKeys('items'), prior: await adapterA.findFile('items', sha('v2-cf2')) });
  const rCF2 = await tx(clientA, () => adapterA.apply(planCF2));
  const v2s = await cfPending();
  if (rCF2.cf.staged === 1 && v2s.length === 1 && Number(v2s[0].from_value) === 12 && Number(v2s[0].to_value) === 24 && (await cfFactor()) === 12) {
    ok('a changed drop stages v2 (12 → 24) — the stored 12 keeps serving until the gate decides');
  } else bad('cf stage 2', JSON.stringify({ cf: rCF2.cf, versions: v2s, factor: await cfFactor() }));

  /* step 4: the same target proposed again (new checksum) does NOT fork the ledger */
  const planCF2b = planIngestFile({ ...FIXTURE, checksum: sha('v2-cf2b'), fileName: 'items-cf-2b.xlsx', rows: cfRows2, seen: await adapterA.loadSeenKeys('items'), prior: await adapterA.findFile('items', sha('v2-cf2b')) });
  const rCF2b = await tx(clientA, () => adapterA.apply(planCF2b));
  const v2count = (await clientA.query(`SELECT count(*)::int AS n FROM item_cf_version WHERE tenant_id = $1 AND sku = 'SKU-1'`, [T.A])).rows[0].n;
  if (rCF2b.cf.staged === 0 && rCF2b.cf.stagedExisting === 1 && v2count === 2) {
    ok('the same target re-proposed never forks the ledger: stagedExisting 1, versions stay 2');
  } else bad('cf dedupe', JSON.stringify({ cf: rCF2b.cf, versions: v2count }));

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

  /* ---- 8. H7 supplier identity, live — through the C3 freeze door ---- */
  console.log('\nH7 supplier identity: a re-spelled import stages a hold; the merge lands only verified');
  await tx(clientA, () => adapterA.apply(planIngestFile({
    tenantId: T.A, kind: 'suppliers', checksum: sha('sup1'), fileName: 'suppliers.xlsx', byteSize: 64, mode: 'A',
    rows: [{ supplierExternalId: 'SUP-9', supplierName: 'Gulf Foods LLC' }],
  })));
  const supFirst = (await clientA.query(`SELECT id, name FROM supplier WHERE external_id = 'SUP-9'`)).rows[0];
  if (supFirst && supFirst.name === 'Gulf Foods LLC') ok('the first import CREATES the identity — creation is not frozen');
  else bad('first supplier import', JSON.stringify(supFirst));

  /* The re-spelled import is an IDENTITY change: the C3 freeze refuses it
   * outright (the H6 executor flows ride the same supplier table), and the
   * stored identity keeps serving. */
  let frozen = false;
  try {
    await tx(clientA, () => adapterA.apply(planIngestFile({
      tenantId: T.A, kind: 'suppliers', checksum: sha('sup2'), fileName: 'suppliers-r4.xlsx', byteSize: 64, mode: 'A',
      rows: [{ supplierExternalId: 'SUP-9', supplierName: 'Gulf Foods L.L.C. (spelled differently)' }],
    })));
  } catch (e) { frozen = String(e.message).includes('SUPPLIER_IDENTITY_FROZEN'); }
  const supHeld = (await clientA.query(`SELECT name FROM supplier WHERE external_id = 'SUP-9'`)).rows[0];
  if (frozen && supHeld.name === 'Gulf Foods LLC') ok('the re-spelled import is REFUSED (SUPPLIER_IDENTITY_FROZEN); the stored identity keeps serving');
  else bad('the freeze must refuse the re-spelled import', JSON.stringify({ frozen, name: supHeld && supHeld.name }));

  /* The pipeline stages the hold; out-of-band verification opens the door and
   * the H7 merge completes — one row per external ID, the verified spelling. */
  const procure = makeProcureAdapter(clientA, T.A);
  const storedRow = (await clientA.query(`SELECT external_id, name, payment_term_days, payment_terms_text, currency_code FROM supplier WHERE id = $1`, [supFirst.id])).rows[0];
  const cls = classifySupplierChange(
    { external_id: storedRow.external_id, name: storedRow.name, payment_term_days: storedRow.payment_term_days, payment_terms_text: storedRow.payment_terms_text, currency_code: storedRow.currency_code },
    { external_id: storedRow.external_id, name: 'Gulf Foods L.L.C. (spelled differently)', payment_term_days: storedRow.payment_term_days, payment_terms_text: storedRow.payment_terms_text, currency_code: storedRow.currency_code });
  if (!cls.frozen) bad('the classifier must freeze a name delta', JSON.stringify(cls));
  else {
    const hold = await tx(clientA, () => procure.stageSupplierHold({ supplierId: supFirst.id, changedFields: cls.delta, requestedBy: null }));
    if (hold && hold.state === 'COOLING_OFF') ok('the identity delta stages a COOLING_OFF hold (pipeline-originated)');
    else bad('hold staging', JSON.stringify(hold));
    await tx(clientA, () => procure.resolveHold({
      holdId: hold.id, supplierId: supFirst.id, changedFields: cls.delta,
      verifiedBy: null, reference: 'OBV-2026-001 (out-of-band confirmed)', decision: 'APPLY',
    }));
    const sup = (await clientA.query(`SELECT count(*)::int AS n FROM supplier WHERE external_id = 'SUP-9'`)).rows[0].n;
    const supName = (await clientA.query(`SELECT name FROM supplier WHERE external_id = 'SUP-9'`)).rows[0].name;
    const holdState = (await clientA.query(`SELECT state::text AS s FROM supplier_change_hold WHERE id = $1`, [hold.id])).rows[0].s;
    if (sup === 1 && supName.includes('spelled differently') && holdState === 'APPLIED') ok('one supplier row per external ID; the re-spelled merge landed THROUGH the verified hold');
    else bad('supplier merge wrong', JSON.stringify({ sup, supName, holdState }));
  }

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

  /* ---- 11. M10 FX fail-safe: the pin door + the stale-visible fallback ---- */
  console.log('\nM10 FX fail-safe: the pin door (ADR-0003) and the stale-visible fallback, live');
  {
    const FX_LEDGER_KEY = 'ingest-replay-live-hmac-key-0123456789abcdef-0123456789abcdef';
    const FX_DAY = '2026-08-25';
    const fx = makeFxAdapter(clientA, T.A, { ledger: { hmacKey: FX_LEDGER_KEY } });

    const pinned = await tx(clientA, () => fx.pinRate(FX_DAY, 0.376, { trigger: 'schedule', jobId: 'replay-live' }));
    if (pinned.pinned === true && pinned.ledger && pinned.ledger.seq >= 1) {
      ok(`pinRate lands the pin + ONE Class-S FX_PIN block (seq ${pinned.ledger.seq}) — the chain's first Class-S production writer`);
    } else bad('pinRate did not land the pin/block', JSON.stringify(pinned));

    const again = await tx(clientA, () => fx.pinRate(FX_DAY, 0.376, { trigger: 'schedule' }));
    const pinBlocks = (await clientA.query(`SELECT count(*)::int AS n FROM ledger_block WHERE class = 'S' AND action = 'FX_PIN'`)).rows[0].n;
    if (again.alreadyPinned === true && pinBlocks === 1) ok('the SAME rate re-pinned is a no-op success — no second block (retry-safe, logged once)');
    else bad('re-pin not idempotent', JSON.stringify({ again, pinBlocks }));

    await expectError('a DIFFERENT rate for a pinned day refuses RATE_DAY_CONFLICT — corrections go through the door',
      () => tx(clientA, () => fx.pinRate(FX_DAY, 0.377, { trigger: 'schedule' })), 'RATE_DAY_CONFLICT');

    const workerA = makeIngestWorkerAdapter(clientA, T.A);
    const fresh = normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: FX_DAY }, 'BHD', await workerA.loadFxPin(FX_DAY));
    if (fresh.ok && fresh.rateSource === 'PINNED_USD' && fresh.stale === undefined && Math.abs(fresh.tenantValue - 3.76) < 1e-9) {
      ok('a USD row converts at the exact pin — fresh, no staleness fields (the additive shape holds live)');
    } else bad('fresh conversion wrong', JSON.stringify(fresh));

    const stale = normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-08-28' }, 'BHD', await workerA.loadFxPin('2026-08-28'));
    if (stale.ok && stale.stale === true && stale.rateStale.pinnedFor === FX_DAY && stale.rateStale.staleDays === 3) {
      ok('a USD row on an unpinned day CONTINUES on the last pinned rate — stale-visible with pinnedFor + staleDays (the M10 fix, live)');
    } else bad('fallback wrong', JSON.stringify(stale));

    const workerB = makeIngestWorkerAdapter(clientB, T.B);
    const never = normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-08-28' }, 'BHD', await workerB.loadFxPin('2026-08-28'));
    if (!never.ok && never.reason === 'RATE_NOT_PINNED') {
      ok('a never-pinned tenant still refuses RATE_NOT_PINNED — the D-015 narrowed refusal, live');
    } else bad('never-pinned tenant did not refuse', JSON.stringify(never));

    const corr = await tx(clientA, () => fx.correctRate(FX_DAY, 0.377, { by: '22222222-2222-4222-8222-222222222222', reason: 'treasury revised the morning fix' }));
    const rateNow = (await clientA.query(`SELECT usd_to_local FROM fx_rate_pin WHERE day = $1`, [FX_DAY])).rows[0];
    if (corr.corrected === true && corr.before === 0.376 && corr.after === 0.377 && Number(rateNow.usd_to_local) === 0.377) {
      ok(`the correction lands with the diff + ONE Class-S FX_CORRECT block (seq ${corr.ledger.seq})`);
    } else bad('correction wrong', JSON.stringify({ corr, rateNow }));

    await expectError('DELETE is denied to the app role (0009 revoked the privilege)',
      () => clientA.query(`DELETE FROM fx_rate_pin WHERE day = $1`, [FX_DAY]), '42501');
    let ownerRefused = false;
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [T.A]);
      await db.query(`DELETE FROM fx_rate_pin WHERE day = $1`, [FX_DAY]);
      await db.query('COMMIT');
    } catch (e) {
      ownerRefused = e.message.includes('FX_RATE_PIN_IMMUTABLE');
      try { await db.query('ROLLBACK'); } catch (_) {}
    }
    if (ownerRefused) ok('the trigger refuses DELETE even for the OWNER — correct again, never un-pin');
    else bad('owner DELETE was not refused by the trigger');

    const chainOk = await makeLedgerAdapter(clientA, T.A, { hmacKey: FX_LEDGER_KEY, actor: 'replay-live', role: null }).verifyChain();
    if (chainOk && chainOk.ok) ok(`verifyChain green across the pins + correction (${chainOk.verified} blocks, Class-S included)`);
    else bad('chain verification failed', JSON.stringify(chainOk));

    const fxB = makeFxAdapter(clientB, T.B);
    const cross = await fxB.loadPinForDay(FX_DAY);
    if (cross === null) ok("tenant B's session sees none of tenant A's pins (RLS on the source of record)");
    else bad('cross-tenant pin read leaked', JSON.stringify(cross));
  }

  /* ---- 12. RLS on the register ---- */
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
