'use strict';
/* ============================================================================
 * Ingest adapter — structural proof WITHOUT a database (stub client).
 *
 * The live half (real PostgreSQL: conflict targets fire, RLS fences, applied
 * stamps land) is packages/db/test/ingest-replay-live.js in the db-rls job.
 * THIS suite pins everything provable without a server: the statement
 * sequence apply() issues (file register → fact rows → key register), the
 * ON CONFLICT targets being exactly the H6 tenant-leading uniques, the
 * supplier's H7 two-branch identity, the fail-closed refusals, and the
 * guard that a REPLAY_NOOP can never reach the database.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');
const { makeIngestAdapter, WIRED_KINDS } = require(path.join(__dirname, '..', 'ingest-adapter'));
const { planIngestFile } = require(path.join(__dirname, '..', '..', 'core', 'modules', 'ingestion', 'src', 'idempotency'));

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

/* Stub client: records every statement; findFile/loadSeenKeys SELECTs get
 * scripted responses so apply() can run end-to-end without a server. The
 * scripted appliedAt is a STRING — node-pg delivers int8/bigint as strings,
 * and the adapter must convert at the boundary (the live proof inherits the
 * real behavior; this stub inherits the real shape). */
function stubClient({ prior = null, seen = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      if (/FROM ingest_file/i.test(text)) {
        return prior
          ? { rows: [{ id: prior.id, status: prior.status, appliedAt: prior.appliedAt === null || prior.appliedAt === undefined ? null : String(prior.appliedAt) }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/FROM idempotency_key/i.test(text)) return { rows: seen.map((idem_key) => ({ idem_key })), rowCount: seen.length };
      if (/RETURNING id/i.test(text)) return { rows: [{ id: 'file-uuid', appliedAt: 1756500000000 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
}

const T = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(64);
const plan = (over = {}) => planIngestFile({
  tenantId: T, kind: 'items', checksum: SHA, fileName: 'items.xlsx', byteSize: 10, mode: 'A',
  rows: [{ sku: 'SKU-001', itemName: 'Tomato', unit: 'CTN' }],
  ...over,
});

/* ---- ports ------------------------------------------------------------------ */
console.log('\nThe three ports (findFile / loadSeenKeys / apply) are tenant-fenced');

test('findFile selects the H6 file unique columns with an explicit tenant predicate', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).findFile('items', SHA);
  assert.ok(c.calls[0].text.includes('FROM ingest_file'));
  assert.ok(c.calls[0].text.includes('tenant_id = $1'));
  assert.deepStrictEqual(c.calls[0].values.slice(0, 3), [T, 'items', SHA]);
});
test('loadSeenKeys reads the register tenant-scoped, ordered', async () => {
  const c = stubClient();
  const seen = await makeIngestAdapter(c, T).loadSeenKeys('deliveries');
  assert.deepStrictEqual(seen, []);
  assert.ok(c.calls[0].text.includes('FROM idempotency_key'));
  assert.ok(c.calls[0].text.includes('ORDER BY idem_key'));
});
test('findFile converts the int8 appliedAt to a finite epoch-ms NUMBER (pg ships bigint as a string)', async () => {
  const c = stubClient({ prior: { id: 'f1', status: 'APPLIED', appliedAt: 1756500000000 } });
  const prior = await makeIngestAdapter(c, T).findFile('items', SHA);
  assert.strictEqual(typeof prior.appliedAt, 'number');
  assert.strictEqual(prior.appliedAt, 1756500000000);
  const c2 = stubClient({ prior: { id: 'f2', status: 'FAILED', appliedAt: null } });
  const failed = await makeIngestAdapter(c2, T).findFile('items', SHA);
  assert.strictEqual(failed.appliedAt, null); // Number(null) is 0 — the adapter must never lie
});

/* ---- apply(): statement sequence + conflict targets -------------------------- */
console.log('\napply(): file register upsert → fact rows → key register, all tenant-fenced');

test('apply() issues exactly: 1 file upsert + N row upserts + 1 register insert, in order', async () => {
  const c = stubClient();
  const out = await makeIngestAdapter(c, T).apply(plan({ rows: [{ sku: 'A' }, { sku: 'B' }].map((r) => ({ ...r, itemName: 'x', unit: 'PCS' })) }));
  assert.strictEqual(c.calls.length, 3);
  assert.ok(c.calls[0].text.startsWith('INSERT INTO ingest_file'));
  assert.ok(c.calls[1].text.startsWith('INSERT INTO item'));
  assert.ok(c.calls[2].text.startsWith('INSERT INTO idempotency_key'));
  assert.deepStrictEqual(out, { fileId: 'file-uuid', appliedAt: 1756500000000, rowsApplied: 2, keysRegistered: 2 });
});
test('the item conflict target is the H6 unique (tenant_id, sku) with DO UPDATE', () => {
  const c = stubClient();
  return makeIngestAdapter(c, T).apply(plan()).then(() => {
    const s = c.calls[1].text;
    assert.ok(s.includes('ON CONFLICT (tenant_id, sku) DO UPDATE'), s);
  });
});
test('H7 two-branch supplier identity: external_id rides the partial unique; name-only rides (tenant, name)', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({
    kind: 'suppliers',
    rows: [{ key: '["ext","S1"]', row: { supplierExternalId: 'S1', supplierName: 'Acme LLC' } }],
  }));
  const extStmt = c.calls[1].text;
  assert.ok(extStmt.includes('ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL'), extStmt);

  const c2 = stubClient();
  await makeIngestAdapter(c2, T).apply(plan({
    kind: 'suppliers',
    rows: [{ key: '["name","Beta"]', row: { supplierName: 'Beta LLC' } }],
  }));
  assert.ok(c2.calls[1].text.includes('ON CONFLICT (tenant_id, name) DO UPDATE'));
  assert.strictEqual(c2.calls[1].values[1], null); // external_id NULL on the name branch
});
test('open PO conflict target is (tenant, po_number, sku); consumption is (tenant, sku, period)', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({
    kind: 'open_pos',
    rows: [{ key: 'k', row: { poNumber: 'P1', sku: 'S', ordered: 1, received: 0, waiting: 1, unit: 'CTN', unitPrice: 2, currency: 'USD', tenantUnitPrice: 3 } }],
  }));
  assert.ok(c.calls[1].text.includes('ON CONFLICT (tenant_id, po_number, sku)'));
  const c2 = stubClient();
  await makeIngestAdapter(c2, T).apply(plan({
    kind: 'consumption_balances',
    rows: [{ key: 'k', row: { sku: 'S', periodStart: '2026-08-01', periodEnd: '2026-08-31', startBalance: 1, goodsIn: 2, goodsOut: 1, stockChanges: 0, endBalance: 2 } }],
  }));
  assert.ok(c2.calls[1].text.includes('ON CONFLICT (tenant_id, sku, period_start, period_end)'));
});
test('planning params upsert writes params as jsonb with source manual', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ kind: 'planning_params', rows: [{ key: 'k', row: { recipeRef: 'R-1', params: { leadTimeDays: 7 } } }] }));
  assert.ok(c.calls[1].text.includes('$3::jsonb'));
  assert.ok(c.calls[1].text.includes("source='manual'"));
  assert.strictEqual(c.calls[1].values[2], JSON.stringify({ leadTimeDays: 7 }));
});
test('the register insert stamps file_checksum and is ON CONFLICT DO NOTHING (a retry re-registers nothing)', () => {
  const c = stubClient();
  return makeIngestAdapter(c, T).apply(plan({ rows: [{ sku: 'A', itemName: 'x', unit: 'PCS' }] })).then(() => {
    const s = c.calls[2].text;
    assert.ok(s.includes('file_checksum'));
    assert.ok(s.includes('ON CONFLICT (tenant_id, kind, idem_key) DO NOTHING'));
    assert.strictEqual(c.calls[2].values[2], SHA);
  });
});

/* ---- fail-closed guardrails --------------------------------------------------- */
console.log('\nFail-closed: the executor refuses what the decision layer should never have let through');

test('a REPLAY_NOOP plan must never reach the database — rejected before any statement', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply({ action: 'REPLAY_NOOP' }).then(() => { throw new Error('no throw'); },
    (e) => assert.ok(e.message.startsWith('apply: expected an APPLY plan'), e.message));
  assert.strictEqual(c.calls.length, 0);
});
test('a plan for another tenant is TENANT_MISMATCH before any statement', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ tenantId: '22222222-2222-4222-8222-222222222222' }))
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('TENANT_MISMATCH'), e.message));
  assert.strictEqual(c.calls.length, 0);
});
test('inventory and category owners are disclosed as KIND_NOT_WIRED', () => {
  assert.ok(!WIRED_KINDS.includes('inventory_all_dimensions'));
  assert.ok(!WIRED_KINDS.includes('category_owners'));
});
test('an unwired kind refuses before any statement runs — nothing half-applied', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ kind: 'inventory_all_dimensions', rows: [{ key: 'k', row: { sku: 'S', warehouse: 'W' } }] }))
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('KIND_NOT_WIRED'), e.message));
  assert.strictEqual(c.calls.length, 0);
});
test('a non-daily delivery row is refused, never silently stored', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ kind: 'deliveries', rows: [{ key: 'k', row: { periodStart: '2026-08-01', periodEnd: '2026-08-07', granularity: 'weekly', qty: 5 } }] }))
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('DELIVERIES_NON_DAILY_NOT_WIRED'), e.message));
  assert.strictEqual(c.calls.length, 0);
});
test('a daily row with divergent period bounds is INVALID_DAILY_ROW', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ kind: 'deliveries', rows: [{ key: 'k', row: { periodStart: '2026-08-02', periodEnd: '2026-08-03', granularity: 'daily', qty: 6 } }] }))
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('INVALID_DAILY_ROW'), e.message));
});
test('a required numeric column arriving as a string is INVALID_ROW (strict-parse discipline) — and issues ZERO statements', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ kind: 'open_pos', rows: [{ key: 'k', row: { poNumber: 'P1', sku: 'S', ordered: '1', received: 0, waiting: 1, unit: 'CTN', unitPrice: 2, currency: 'USD', tenantUnitPrice: 3 } }] }))
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('INVALID_ROW'), e.message));
  assert.strictEqual(c.calls.length, 0); // pre-validation refuses the whole plan before any write
});
test('a malformed date is INVALID_DATE before it can hit a DATE column', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ kind: 'consumption_balances', rows: [{ key: 'k', row: { sku: 'S', periodStart: '08/01/2026', periodEnd: '2026-08-31', startBalance: 1, goodsIn: 2, goodsOut: 1, stockChanges: 0, endBalance: 2 } }] }))
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('INVALID_DATE'), e.message));
});
test('a keyless plan row is refused at the executor too', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ rows: [{ row: { sku: 'S', itemName: 'x', unit: 'PCS' } }] }))
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('apply: every plan.rows[].key'), e.message));
});

(async () => {
  console.log(`\n  ingest-adapter (stub): ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
