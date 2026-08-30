'use strict';
/* ============================================================================
 * H6 — idempotent upsert wrapper tests (A7, gate 12 residual).
 *
 * Golden thread: re-importing the same file changes nothing
 * (INGESTION_FILE_SPEC §4), per tenant, at the APPLICATION level — the DB
 * already refuses structurally (tenant-leading uniques, 23505) but an
 * application decision must turn the re-import into a disclosed no-op
 * instead of an error. Named proof: `ingest/idempotent-per-tenant-replay`.
 *
 * The per-tenant INDEPENDENCE half of the proof is live by nature (two
 * tenants, one register column) — packages/db/test/ingest-replay-live.js
 * proves it against real PostgreSQL in CI. Here the pure decision layer is
 * proven: key derivation per kind, fail-closed refusals, replay semantics,
 * deterministic collapse, and DAT-04 accounting.
 * ==========================================================================*/
const assert = require('assert');
const I = require('../src/idempotency');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }
function throwsCode(name, fn, code) {
  test(name, () => {
    let threw = null;
    try { fn(); } catch (e) { threw = e; }
    assert.ok(threw, 'expected a throw');
    assert.ok(threw.message.startsWith(code + ':'), `expected ${code}, got: ${threw.message}`);
  });
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(64);
const base = (over) => ({
  tenantId: TENANT, kind: 'items', checksum: SHA, fileName: 'items.xlsx',
  byteSize: 128, mode: 'A',
  rows: [{ sku: 'SKU-001', itemName: 'Tomato paste' }],
  ...over,
});

/* ---- per-kind key derivation ------------------------------------------------ */
console.log('\nPer-kind idempotency keys (INGESTION_FILE_SPEC §4 six keys; H6 tenant scoping is structural)');

test('items key is the SKU', () => {
  assert.strictEqual(I.idempotencyKey('items', { sku: 'SKU-001' }), JSON.stringify(['SKU-001']));
});
test('inventory key is SKU+Warehouse', () => {
  assert.strictEqual(I.idempotencyKey('inventory_all_dimensions', { sku: 'SKU-001', warehouse: 'WH-1' }),
    JSON.stringify(['SKU-001', 'WH-1']));
});
test('open PO key is PO Number+SKU', () => {
  assert.strictEqual(I.idempotencyKey('open_pos', { poNumber: 'PO-7', sku: 'SKU-001' }),
    JSON.stringify(['PO-7', 'SKU-001']));
});
test('deliveries key is the period + granularity (the register carries the tenant of "Tenant+Date")', () => {
  assert.strictEqual(I.idempotencyKey('deliveries', { periodStart: '2026-08-30', periodEnd: '2026-08-30', granularity: 'daily' }),
    JSON.stringify(['2026-08-30', '2026-08-30', 'daily']));
});
test('params key is the Recipe Ref', () => {
  assert.strictEqual(I.idempotencyKey('planning_params', { recipeRef: 'R-100' }), JSON.stringify(['R-100']));
});
test('consumption key follows the schema structural unique (sku + period)', () => {
  assert.strictEqual(I.idempotencyKey('consumption_balances', { sku: 'SKU-001', periodStart: '2026-08-01', periodEnd: '2026-08-31' }),
    JSON.stringify(['SKU-001', '2026-08-01', '2026-08-31']));
});
test('category owner key follows the schema structural unique (category)', () => {
  assert.strictEqual(I.idempotencyKey('category_owners', { category: 'Produce' }), JSON.stringify(['Produce']));
});
test('H7: supplier key rides Supplier ID when present, Name interim — and the identity BASE is in the key', () => {
  assert.strictEqual(I.idempotencyKey('suppliers', { supplierExternalId: 'SUP-7', supplierName: 'Acme LLC' }),
    JSON.stringify(['ext', 'SUP-7']));
  assert.strictEqual(I.idempotencyKey('suppliers', { supplierName: 'Acme LLC' }),
    JSON.stringify(['name', 'Acme LLC']));
});
test('keys are whitespace-normalized but case-preserved (§3.1 discipline)', () => {
  assert.strictEqual(I.idempotencyKey('items', { sku: '  SKU-001 \n' }), JSON.stringify(['SKU-001']));
  assert.notStrictEqual(I.idempotencyKey('items', { sku: 'sku-001' }), JSON.stringify(['SKU-001']));
});
test('the derived key is tenant-independent — per-tenant scoping lives in the register column (H6 structural)', () => {
  const a = I.planIngestFile(base()).rows[0].key;
  const b = I.planIngestFile(base({ tenantId: '22222222-2222-4222-8222-222222222222' })).rows[0].key;
  assert.strictEqual(a, b);
});
test('keys are all eight kinds deep and pinned (a kind added without an ops-coverage review fails here)', () => {
  assert.deepStrictEqual([...I.DATASET_KINDS].sort(), [
    'category_owners', 'consumption_balances', 'deliveries', 'inventory_all_dimensions',
    'items', 'open_pos', 'planning_params', 'suppliers',
  ]);
  for (const k of I.DATASET_KINDS) assert.strictEqual(typeof I.KEY_FIELDS[k] === 'object' || k === 'suppliers', true);
});

/* ---- fail-closed refusals ---------------------------------------------------- */
console.log('\nFail-closed: an unkeyable row is refused, never coerced');

throwsCode('a row missing its key field names the field', () => I.idempotencyKey('items', { itemName: 'no sku' }), 'MISSING_IDEMPOTENCY_KEY');
throwsCode('a non-string key value is INVALID, never String()-coerced', () => I.idempotencyKey('items', { sku: 12345 }), 'INVALID_IDEMPOTENCY_KEY');
throwsCode('an unknown kind is UNKNOWN_DATASET_KIND', () => I.idempotencyKey('nope', { sku: 'S' }), 'UNKNOWN_DATASET_KIND');
throwsCode('supplier with neither ID nor name is refused', () => I.idempotencyKey('suppliers', {}), 'MISSING_IDEMPOTENCY_KEY');
throwsCode('a malformed checksum is refused', () => I.planIngestFile(base({ checksum: 'XYZ' })), 'INVALID_CHECKSUM');
throwsCode('an unknown mode is refused', () => I.planIngestFile(base({ mode: 'C' })), 'INVALID_MODE');
throwsCode('an empty file is refused — an apply of zero rows is never a real file', () => I.planIngestFile(base({ rows: [] })), 'EMPTY_ROWS');
throwsCode('a row that does not parse to a key fails the WHOLE plan', () => I.planIngestFile(base({ rows: [{ sku: 'A' }, { sku: '' }] })), 'MISSING_IDEMPOTENCY_KEY');
throwsCode('a prior row outside the ingest_file_status enum is refused', () => I.planIngestFile(base({ prior: { status: 'WEIRD' } })), 'INVALID_PRIOR');
throwsCode('seen entries must be strings', () => I.planIngestFile(base({ seen: [42] })), 'INVALID_SEEN');

/* ---- replay semantics -------------------------------------------------------- */
console.log('\nReplay: the same file applied twice changes nothing (named proof)');

test('ingest/idempotent-per-tenant-replay (pure half): prior APPLIED → REPLAY_NOOP carrying the prior identity', () => {
  const plan = I.planIngestFile(base({
    seen: [JSON.stringify(['SKU-001'])],
    prior: { id: 'file-1', status: 'APPLIED', appliedAt: 1756500000000 },
  }));
  assert.strictEqual(plan.action, 'REPLAY_NOOP');
  assert.strictEqual(plan.fileId, 'file-1');
  assert.strictEqual(plan.appliedAt, 1756500000000);
  assert.strictEqual(plan.rowsApplied, 0);
  assert.deepStrictEqual(plan.rows, []);
  assert.strictEqual(plan.keysIngested, 1);
  assert.strictEqual(plan.duplicateHits, 1);
  assert.ok(plan.disclosures[0].includes('replay-no-op'));
});
test('replay accounting is computed from seen, never assumed — a pre-wrapper file replays with honest zeros', () => {
  const plan = I.planIngestFile(base({ seen: [], prior: { id: 'file-1', status: 'APPLIED', appliedAt: 1 } }));
  assert.strictEqual(plan.action, 'REPLAY_NOOP');
  assert.strictEqual(plan.duplicateHits, 0);
  assert.strictEqual(plan.newKeys, plan.keysIngested);
});
test('a FAILED prior reprocesses — APPLY updating the SAME file row, never forking history', () => {
  const plan = I.planIngestFile(base({ prior: { id: 'file-9', status: 'FAILED' } }));
  assert.strictEqual(plan.action, 'APPLY');
  assert.strictEqual(plan.reprocessOf, 'file-9');
  assert.ok(plan.disclosures.some((d) => d.includes('reprocess')));
});
test('a RECEIVED prior (crashed worker) reprocesses the same row', () => {
  assert.strictEqual(I.planIngestFile(base({ prior: { id: 'f', status: 'RECEIVED' } })).action, 'APPLY');
  assert.strictEqual(I.planIngestFile(base({ prior: { id: 'f', status: 'QUARANTINED' } })).action, 'APPLY');
});

/* ---- deterministic collapse + DAT-04 ---------------------------------------- */
console.log('\nDuplicate collapse and DAT-04 accounting');

test('intra-file duplicate keys collapse: last occurrence wins, order kept at first occurrence', () => {
  const plan = I.planIngestFile(base({ rows: [
    { sku: 'A', itemName: 'first' }, { sku: 'B', itemName: 'mid' }, { sku: 'A', itemName: 'last' },
  ] }));
  assert.deepStrictEqual(plan.rows.map((r) => [r.key, r.row.itemName]), [
    [JSON.stringify(['A']), 'last'], [JSON.stringify(['B']), 'mid'],
  ]);
  assert.deepStrictEqual(plan.collapsedKeys, [{ key: JSON.stringify(['A']), occurrences: 2 }]);
  assert.ok(plan.disclosures.some((d) => d.includes('collapsed deterministically')));
});
test('DAT-04 inputs: duplicateHits counts collapsed keys already in the register', () => {
  const K_A = JSON.stringify(['A']), K_B = JSON.stringify(['B']);
  const plan = I.planIngestFile(base({ rows: [{ sku: 'A' }, { sku: 'B' }], seen: [K_A] }));
  assert.strictEqual(plan.keysIngested, 2);
  assert.strictEqual(plan.duplicateHits, 1);
  assert.strictEqual(plan.newKeys, 1);
  assert.ok(plan.disclosures.some((d) => d.includes('DAT-04')));
});
test('array and Set seen produce identical plans', () => {
  const K = JSON.stringify(['SKU-001']);
  const a = I.planIngestFile(base({ seen: [K] }));
  const b = I.planIngestFile(base({ seen: new Set([K]) }));
  assert.deepStrictEqual(a, b);
});
test('determinism: identical inputs produce deep-equal, JSON-round-trip-stable plans', () => {
  const mk = () => I.planIngestFile(base({ rows: [{ sku: 'A' }, { sku: 'B', itemName: 'x' }], seen: [JSON.stringify(['A'])] }));
  assert.deepStrictEqual(mk(), mk());
  assert.deepStrictEqual(JSON.parse(JSON.stringify(mk())), mk());
});

console.log(`\n  idempotency: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
