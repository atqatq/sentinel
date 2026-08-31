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
/* Async-safe runner: an async test's assertions must COMPLETE before the
 * summary prints — a bare process.exit swallows every pending continuation
 * (a failing async test would exit 0). All async test promises are awaited
 * before the verdict; the live-replay suite (ingest-replay-live.js) has
 * always been async-safe — this brings the stub suite to the same honesty. */
const pending = [];
function test(name, fn) {
  const pass = () => { passed++; console.log('  ✓ ' + name); };
  const fail = (e) => { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); };
  let out;
  try { out = fn(); } catch (e) { fail(e); return; }
  if (out && typeof out.then === 'function') pending.push(out.then(pass, fail));
  else pass();
}

/* Stub client: records every statement; findFile/loadSeenKeys SELECTs get
 * scripted responses so apply() can run end-to-end without a server. The
 * scripted appliedAt is a STRING — node-pg delivers int8/bigint as strings,
 * and the adapter must convert at the boundary (the live proof inherits the
 * real behavior; this stub inherits the real shape). */
function stubClient({ prior = null, seen = [], priorCfs = {} } = {}) {
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
      if (/INSERT INTO idempotency_key/i.test(text)) return { rows: [], rowCount: values[3].length };
      if (/FROM item WHERE tenant_id/i.test(text)) {
        return { rows: Object.entries(priorCfs).map(([sku, cf]) => ({ sku, conversion_factor: cf })), rowCount: Object.keys(priorCfs).length };
      }
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

test('apply() issues exactly: 1 prior-CF read (items) + 1 file upsert + N row upserts + 1 register insert, in order', async () => {
  const c = stubClient();
  const out = await makeIngestAdapter(c, T).apply(plan({ rows: [{ sku: 'A' }, { sku: 'B' }].map((r) => ({ ...r, itemName: 'x', unit: 'PCS' })) }));
  assert.strictEqual(c.calls.length, 5);
  assert.ok(c.calls[0].text.startsWith('SELECT sku, conversion_factor FROM item'), 'the M7 prior-CF read comes first');
  assert.ok(c.calls[1].text.startsWith('INSERT INTO ingest_file'));
  assert.ok(c.calls[2].text.startsWith('INSERT INTO item'));
  assert.ok(c.calls[3].text.startsWith('INSERT INTO item'));
  assert.ok(c.calls[4].text.startsWith('INSERT INTO idempotency_key'));
  assert.strictEqual(out.rowsApplied, 2);
  assert.strictEqual(out.keysRegistered, 2);
  assert.deepStrictEqual(out.cf, { staged: 0, stagedExisting: 0, blanksKept: 0, invalidKept: 0, tasks: [] }, 'the CF summary rides the items apply');
});
test('the item conflict target is the H6 unique (tenant_id, sku) with DO UPDATE', () => {
  const c = stubClient();
  return makeIngestAdapter(c, T).apply(plan()).then(() => {
    const s = c.calls[2].text;
    assert.ok(s.includes('ON CONFLICT (tenant_id, sku) DO UPDATE'), s);
  });
});
test('H7 two-branch supplier identity: external_id rides the partial unique; name-only rides (tenant, name)', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({
    kind: 'suppliers',
    rows: [{ supplierExternalId: 'S1', supplierName: 'Acme LLC' }],
  }));
  const extStmt = c.calls[1].text;
  assert.ok(extStmt.includes('ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL'), extStmt);

  const c2 = stubClient();
  await makeIngestAdapter(c2, T).apply(plan({
    kind: 'suppliers',
    rows: [{ supplierName: 'Beta LLC' }],
  }));
  assert.ok(c2.calls[1].text.includes('ON CONFLICT (tenant_id, name) DO UPDATE'));
  assert.strictEqual(c2.calls[1].values[1], null); // external_id NULL on the name branch
});
test('open PO conflict target is (tenant, po_number, sku); consumption is (tenant, sku, period)', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({
    kind: 'open_pos',
    rows: [{ poNumber: 'P1', sku: 'S', ordered: 1, received: 0, waiting: 1, unit: 'CTN', unitPrice: 2, currency: 'USD', tenantUnitPrice: 3 }],
  }));
  assert.ok(c.calls[1].text.includes('ON CONFLICT (tenant_id, po_number, sku)'));
  const c2 = stubClient();
  await makeIngestAdapter(c2, T).apply(plan({
    kind: 'consumption_balances',
    rows: [{ sku: 'S', periodStart: '2026-08-01', periodEnd: '2026-08-31', startBalance: 1, goodsIn: 2, goodsOut: 1, stockChanges: 0, endBalance: 2 }],
  }));
  assert.ok(c2.calls[1].text.includes('ON CONFLICT (tenant_id, sku, period_start, period_end)'));
});
test('planning params upsert writes params as jsonb with source manual', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ kind: 'planning_params', rows: [{ recipeRef: 'R-1', params: { leadTimeDays: 7 } }] }));
  assert.ok(c.calls[1].text.includes('$3::jsonb'));
  assert.ok(c.calls[1].text.includes("source='manual'"));
  assert.strictEqual(c.calls[1].values[2], JSON.stringify({ leadTimeDays: 7 }));
});
test('the register insert stamps file_checksum and is ON CONFLICT DO NOTHING (a retry re-registers nothing)', () => {
  const c = stubClient();
  return makeIngestAdapter(c, T).apply(plan({ rows: [{ sku: 'A', itemName: 'x', unit: 'PCS' }] })).then(() => {
    const s = c.calls[3].text;
    assert.ok(s.includes('file_checksum'));
    assert.ok(s.includes('ON CONFLICT (tenant_id, kind, idem_key) DO NOTHING'));
    assert.strictEqual(c.calls[3].values[2], SHA);
  });
});

/* ---- M7 (§14.13b): the items seam stages a changed factor, never applies it --- */
console.log('\nM7: a changed conversion factor STAGES — the stored factor keeps serving');

test('a changed usable factor stages: the row rides the keep-CF statement and a PENDING version inserts', async () => {
  const c = stubClient({ priorCfs: { 'SKU-001': '12.00000000' } });
  const out = await makeIngestAdapter(c, T).apply(plan({ rows: [{ sku: 'SKU-001', itemName: 'Tomato', unit: 'CTN', conversionFactor: 24 }] }));
  const rowStmt = c.calls[3].text; // [0] prior read, [1] dedupe probe, [2] file register, [3] item row, [4] version, [5] register
  assert.ok(rowStmt.startsWith('INSERT INTO item'), rowStmt);
  assert.ok(!rowStmt.includes('conversion_factor'), 'the stored factor is untouched by the staged row');
  const verStmt = c.calls[4].text;
  assert.ok(verStmt.startsWith('INSERT INTO item_cf_version'), verStmt);
  assert.ok(verStmt.includes("'PENDING', NULL"), 'pipeline-staged: requested_by NULL');
  assert.strictEqual(out.cf.staged, 1);
  assert.strictEqual(out.cf.blanksKept, 0);
  assert.strictEqual(out.cf.tasks.length, 0);
});
test('an equal factor rides the normal upsert (conversion_factor written, no version, no probe)', async () => {
  const c = stubClient({ priorCfs: { 'SKU-001': '12.00000000' } });
  const out = await makeIngestAdapter(c, T).apply(plan({ rows: [{ sku: 'SKU-001', itemName: 'Tomato', unit: 'CTN', conversionFactor: 12 }] }));
  assert.ok(c.calls[2].text.includes('conversion_factor=EXCLUDED.conversion_factor'));
  assert.strictEqual(out.cf.staged, 0);
  assert.ok(c.calls.every((x) => !x.text.startsWith('INSERT INTO item_cf_version')));
});
test('a blank never wipes: keep-CF, disclosed, no version row', async () => {
  const c = stubClient({ priorCfs: { 'SKU-001': '12.00000000' } });
  const out = await makeIngestAdapter(c, T).apply(plan({ rows: [{ sku: 'SKU-001', itemName: 'Tomato', unit: 'CTN', conversionFactor: null }] }));
  assert.ok(!c.calls[2].text.includes('conversion_factor'), 'the stored factor survives the blank column');
  assert.strictEqual(out.cf.blanksKept, 1);
  assert.strictEqual(out.cf.staged, 0);
});
test('an invalid incoming factor is kept and named: keep-CF + a CF_INVALID_KEPT WARN task, no version row', async () => {
  const c = stubClient({ priorCfs: { 'SKU-001': '12.00000000' } });
  const out = await makeIngestAdapter(c, T).apply(plan({ rows: [{ sku: 'SKU-001', itemName: 'Tomato', unit: 'CTN', conversionFactor: 0 }] }));
  assert.ok(!c.calls[2].text.includes('conversion_factor'));
  assert.strictEqual(out.cf.invalidKept, 1);
  assert.strictEqual(out.cf.tasks.length, 1);
  assert.strictEqual(out.cf.tasks[0].field, 'conversion_factor');
  assert.strictEqual(out.cf.tasks[0].severity, 'WARN');
  assert.ok(out.cf.tasks[0].detail.includes('CF_INVALID_KEPT'));
});
test('bootstrap (no stored row) applies the factor freely — first load is not a change', async () => {
  const c = stubClient({ priorCfs: {} });
  const out = await makeIngestAdapter(c, T).apply(plan({ rows: [{ sku: 'SKU-001', itemName: 'Tomato', unit: 'CTN', conversionFactor: 24 }] }));
  assert.ok(c.calls[2].text.includes('conversion_factor'), 'a new item takes its factor on the first load');
  assert.strictEqual(out.cf.staged, 0);
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
test('the two M2-refused kinds are NOW WIRED (M3 worker unit, D-028) — all eight manifest kinds have proven mappings', () => {
  assert.ok(WIRED_KINDS.includes('inventory_all_dimensions'));
  assert.ok(WIRED_KINDS.includes('category_owners'));
  assert.strictEqual(WIRED_KINDS.length, 8);
});
test('an unwired kind still refuses at the executor backstop before any statement runs — nothing half-applied', async () => {
  const c = stubClient();
  /* Hand-built plan (bypassing planIngestFile's own UNKNOWN_DATASET_KIND)
   * — the executor's backstop must hold on its own: a kind that ever left
   * the UPSERTS map refuses here, never half-applies. */
  await makeIngestAdapter(c, T).apply({ action: 'APPLY', tenantId: T, kind: 'no_such_kind', checksum: SHA, fileName: 'x', byteSize: 1, mode: 'A', rows: [{ key: 'k', row: {} }] })
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('KIND_NOT_WIRED'), e.message));
  assert.strictEqual(c.calls.length, 0);
});
test('stock_line upserts on the (tenant, item_id, warehouse_id) unique with C2-normalized money columns', async () => {
  const ITEM = '33333333-3333-4333-8333-333333333333';
  const WH = '44444444-4444-4444-8444-444444444444';
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({
    kind: 'inventory_all_dimensions',
    rows: [{ sku: 'SKU-001', warehouse: 'RIYADH-01', itemId: ITEM, warehouseId: WH, quantity: 12, unitCode: 'CTN', valueDocument: 96.5, documentCurrency: 'SAR', tenantValue: 96.5 }],
  }));
  const s = c.calls[1].text;
  assert.ok(s.startsWith('INSERT INTO stock_line'), s);
  assert.ok(s.includes('ON CONFLICT (tenant_id, item_id, warehouse_id) DO UPDATE'), s);
  assert.deepStrictEqual(c.calls[1].values.slice(0, 4), [T, ITEM, WH, 12]);
});
test('a stock_line row with a raw code instead of a resolved uuid refuses INVALID_ROW — codes never reach the executor', async () => {
  const c = stubClient();
  const p = plan({
    kind: 'inventory_all_dimensions',
    rows: [{ sku: 'SKU-001', warehouse: 'RIYADH-01', quantity: 1, unitCode: 'CTN', valueDocument: 1, documentCurrency: 'SAR', tenantValue: 1 }],
  });
  p.rows[0].row.itemId = 'SKU-001'; // the caller's unresolved code sneaks in — the executor must catch it
  await makeIngestAdapter(c, T).apply(p)
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('INVALID_ROW') && e.message.includes('itemId'), e.message));
  assert.strictEqual(c.calls.length, 0);
});
test('category_owner upserts on the (tenant, category) unique; an unregistered owner keeps user_id NULL', async () => {
  const UID = '55555555-5555-4555-8555-555555555555';
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({
    kind: 'category_owners',
    rows: [{ category: 'Produce', ownerEmail: 'o@x.test', userId: UID }],
  }));
  assert.ok(c.calls[1].text.includes('ON CONFLICT (tenant_id, category) DO UPDATE'));
  assert.strictEqual(c.calls[1].values[2], 'o@x.test');
  assert.strictEqual(c.calls[1].values[3], UID);
  const c2 = stubClient();
  await makeIngestAdapter(c2, T).apply(plan({
    kind: 'category_owners',
    rows: [{ category: 'Bakery', ownerEmail: 'unknown@x.test' }],
  }));
  assert.strictEqual(c2.calls[1].values[3], null); // honest: owner exists in the feed, not yet in Sentinel
});
test('a category_owners row with a junk user_id refuses INVALID_ROW before any statement', async () => {
  const c = stubClient();
  const p = plan({ kind: 'category_owners', rows: [{ category: 'Produce', ownerEmail: 'o@x.test' }] });
  p.rows[0].row.userId = 'not-a-uuid'; // injected after planning — the executor's own guard must hold
  await makeIngestAdapter(c, T).apply(p)
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('INVALID_ROW') && e.message.includes('userId'), e.message));
  assert.strictEqual(c.calls.length, 0);
});
test('a non-daily delivery row is refused, never silently stored', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ kind: 'deliveries', rows: [{ periodStart: '2026-08-01', periodEnd: '2026-08-07', granularity: 'weekly', qty: 5 }] }))
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('DELIVERIES_NON_DAILY_NOT_WIRED'), e.message));
  assert.strictEqual(c.calls.length, 0);
});
test('a daily row with divergent period bounds is INVALID_DAILY_ROW', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ kind: 'deliveries', rows: [{ periodStart: '2026-08-02', periodEnd: '2026-08-03', granularity: 'daily', qty: 6 }] }))
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('INVALID_DAILY_ROW'), e.message));
});
test('a required numeric column arriving as a string is INVALID_ROW (strict-parse discipline) — and issues ZERO statements', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ kind: 'open_pos', rows: [{ poNumber: 'P1', sku: 'S', ordered: '1', received: 0, waiting: 1, unit: 'CTN', unitPrice: 2, currency: 'USD', tenantUnitPrice: 3 }] }))
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('INVALID_ROW'), e.message));
  assert.strictEqual(c.calls.length, 0); // pre-validation refuses the whole plan before any write
});
test('a malformed date is INVALID_DATE before it can hit a DATE column', async () => {
  const c = stubClient();
  await makeIngestAdapter(c, T).apply(plan({ kind: 'consumption_balances', rows: [{ sku: 'S', periodStart: '08/01/2026', periodEnd: '2026-08-31', startBalance: 1, goodsIn: 2, goodsOut: 1, stockChanges: 0, endBalance: 2 }] }))
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('INVALID_DATE'), e.message));
});
test('a keyless plan row is refused at the executor too', async () => {
  const c = stubClient();
  const p = plan(); // legitimately planned, then the key is stripped post-decision
  p.rows[0] = { row: { sku: 'SKU-001', itemName: 'x', unit: 'PCS' } };
  await makeIngestAdapter(c, T).apply(p)
    .then(() => { throw new Error('no throw'); }, (e) => assert.ok(e.message.startsWith('apply: plan.rows[0] must be a { key, row } pair'), e.message));
  assert.strictEqual(c.calls.length, 0);
});

(async () => {
  await Promise.all(pending);
  console.log(`\n  ingest-adapter (stub): ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
