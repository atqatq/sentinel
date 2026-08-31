'use strict';
/* ============================================================================
 * File-to-rows worker — end-to-end structural proof WITHOUT a database.
 *
 * The real stage modules ride (strict parse, file binding, normalization,
 * H10 hardening, the H4 date boundary) over STUB ports and a STUB executor —
 * the same surfaces packages/db ships. The golden CSV fixtures
 * (fixtures/golden, checksum-pinned by H12) drive the happy paths; crafted
 * grids drive every refusal. The live half (real PostgreSQL: RLS, conflict
 * targets, register lifecycle) rides the db-rls job like its siblings.
 *
 * The thread: one file in, one honest outcome out — and what the pure
 * layers could only RETURN, the worker PERSISTS.
 * ==========================================================================*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { runFileToRows } = require('../index.js');

const REPO = path.join(__dirname, '..', '..', '..');
const fixture = (name) => fs.readFileSync(path.join(REPO, 'fixtures', 'golden', name));
const ASOF = Date.UTC(2026, 7, 31, 8, 0, 0); // 2026-08-31T08:00Z → 2026-08-31 in Asia/Riyadh (UTC+3)
const TENANT = '11111111-1111-4111-8111-111111111111';

let passed = 0, failed = 0;
/* Async-safe runner: async assertions must COMPLETE before the verdict —
 * a bare process.exit would swallow every pending continuation. */
const pending = [];
function test(name, fn) {
  const pass = () => { passed++; console.log('  ✓ ' + name); };
  const fail = (e) => { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); };
  let out;
  try { out = fn(); } catch (e) { fail(e); return; }
  if (out && typeof out.then === 'function') pending.push(out.then(pass, fail));
  else pass();
}

/* ---- stubs ------------------------------------------------------------------ */

function stubPorts(over = {}) {
  const calls = { tasks: [], quarantineRecords: null, registerQuarantine: [], countUpdates: [] };
  const ports = {
    calls,
    loadTenantSettings: async () => (over.settings === undefined ? { currencyCode: 'SAR', timezone: 'Asia/Riyadh' } : over.settings),
    loadUnitCatalog: async () => over.catalog || {
      canonical: ['KG', 'CTN', 'EACH', 'CASE'],
      aliases: { kilogram: 'KG', cases: 'CASE' },
    },
    loadFxPin: async (day) => (over.pin === undefined ? { usdToLocalByDay: {} } : { usdToLocalByDay: { [day]: over.pin } }),
    loadConversionFactors: async () => over.factors || {},
    resolveStockRefs: async (skus, codes) => {
      if (over.resolveRefs) return over.resolveRefs(skus, codes);
      const items = {}; const warehouses = {};
      for (const s of skus) if (over.itemIds && over.itemIds[s]) items[s] = over.itemIds[s];
      for (const c of codes) if (over.warehouseIds && over.warehouseIds[c]) warehouses[c] = over.warehouseIds[c];
      return { items, warehouses };
    },
    resolveUserIdsByEmail: async (emails) => {
      const m = {}; for (const e of emails) if (over.users && over.users[e]) m[e] = over.users[e];
      return m;
    },
    loadDailyDeliveriesHistory: async () => over.history || [],
    markFileQuarantined: async (f) => { calls.registerQuarantine.push(f); return { fileId: 'file-q-uuid' }; },
    insertQuarantineRecords: async (records, fileId) => { calls.quarantineRecords = { records, fileId }; return records.length; },
    insertDataHealthTasks: async (tasks, ctx) => { calls.tasks.push({ tasks, ctx }); return tasks.length; },
    updateQuarantinedCount: async (fileId, n) => { calls.countUpdates.push({ fileId, n }); return 1; },
  };
  return ports;
}

function stubExecutor(over = {}) {
  const calls = { plans: [], findCalls: [], seenKinds: [] };
  return {
    calls,
    findFile: async (kind, checksum) => { calls.findCalls.push({ kind, checksum }); return over.prior || null; },
    loadSeenKeys: async (kind) => { calls.seenKinds.push(kind); return over.seen || []; },
    apply: async (plan) => {
      calls.plans.push(plan);
      return { fileId: 'file-uuid', appliedAt: 1756500000000, rowsApplied: plan.rows.length, keysRegistered: plan.rows.length };
    },
  };
}

const run = (portsOver, executorOver, input) => {
  /* Accept either an over-shape ({history: …}) or a pre-built stub (it has
   * .calls) — the test must hold the SAME stub the run used. */
  const ports = portsOver && portsOver.calls ? portsOver : stubPorts(portsOver);
  const executor = executorOver && executorOver.calls ? executorOver : stubExecutor(executorOver);
  return runFileToRows(
    { ports, executor },
    {
      tenantId: TENANT, source: 'dropzone', asOfMs: ASOF,
      // production configures the scanner (H10: no scanner while required ⇒ refuse);
      // every test rides a clean stub exactly like a wired deployment would.
      avScan: async () => ({ clean: true, engine: 'stub-av' }),
      ...input,
    },
  );
};

/* A minimal XLSX-shaped ZIP: local headers up front (the magic-bytes sniffer
 * requires PK\x03\x04 at byte 0), then the central directory + EOCD — exactly
 * what the H10 gate reads (it never inflates), so the gate ACCEPTs and the
 * worker must refuse with the named extraction gap. */
function fakeXlsxBytes() {
  const local = (name, cSize, uSize) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6);
    h.writeUInt16LE(0, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0, 12);
    h.writeUInt32LE(0, 14); h.writeUInt32LE(cSize, 18); h.writeUInt32LE(uSize, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    return Buffer.concat([h, nameBuf]);
  };
  const cdEntry = (name, cSize, uSize, offset) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0, 12); h.writeUInt16LE(0, 14);
    h.writeUInt32LE(0, 16); h.writeUInt32LE(cSize, 20); h.writeUInt32LE(uSize, 24);
    h.writeUInt16LE(nameBuf.length, 28); h.writeUInt16LE(0, 30); h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36); h.writeUInt32LE(0, 38); h.writeUInt32LE(offset, 42);
    return Buffer.concat([h, nameBuf]);
  };
  const l1 = local('[Content_Types].xml', 20, 200);
  const l2 = local('xl/workbook.xml', 30, 300);
  const cd = Buffer.concat([
    cdEntry('[Content_Types].xml', 20, 200, 0),
    cdEntry('xl/workbook.xml', 30, 300, l1.length),
  ]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(2, 8); eocd.writeUInt16LE(2, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(l1.length + l2.length, 16);
  return Buffer.concat([l1, l2, cd, eocd]);
}

/* ---- contract ---------------------------------------------------------------- */
console.log('\nThe worker refuses mis-wired deps before touching a byte');

test('ports missing required methods refuse with the named list', async () => {
  let threw = null;
  try { await runFileToRows({ executor: stubExecutor(), ports: { loadTenantSettings: async () => null } }, { tenantId: TENANT, bytes: new Uint8Array(1), asOfMs: ASOF }); }
  catch (e) { threw = e; }
  assert.ok(threw && threw.message.includes('ports missing required methods:'), threw && threw.message);
  assert.ok(threw.message.includes('loadFxPin') && threw.message.includes('markFileQuarantined'));
});
test('deps without the H6 executor surface refuse', async () => {
  let threw = null;
  try { await runFileToRows({ executor: {}, ports: stubPorts() }, { tenantId: TENANT, bytes: new Uint8Array(1), asOfMs: ASOF }); }
  catch (e) { threw = e; }
  assert.ok(threw && threw.message.includes('deps.executor must be the H6 adapter surface'), threw && threw.message);
});
test('bytes must be a Uint8Array; asOfMs must be the injected finite clock', async () => {
  let threw = null;
  try { await run(stubPorts(), {}, { bytes: 'nope' }); } catch (e) { threw = e; }
  assert.ok(threw && threw.message.includes('bytes must be a Uint8Array'), threw && threw.message);
  let threw2 = null;
  try { await run(stubPorts(), {}, { bytes: new Uint8Array(1), asOfMs: 'now' }); } catch (e) { threw2 = e; }
  assert.ok(threw2 && threw2.message.includes('asOfMs must be a finite epoch-ms number'), threw2 && threw2.message);
});
test('a tenant without settings refuses the run — no guessed currency, no guessed timezone', async () => {
  const r = await run({ settings: null }, {}, { bytes: Buffer.from('x'), declaredName: 'x.csv' });
  assert.strictEqual(r.verdict, 'QUARANTINED');
  assert.strictEqual(r.reason, 'TENANT_SETTINGS_UNAVAILABLE');
  assert.strictEqual(r.counters.rowsRead, 0);
});

/* ---- pre-binding refusals: no register row, CRITICAL task ---------------------- */
console.log('\nPre-binding refusals: the register\'s kind column never carries a guess');

test('an empty payload is refused at the gate; a CRITICAL task persists, no register row', async () => {
  const ports = stubPorts();
  const r = await runFileToRows({ ports, executor: stubExecutor() }, { tenantId: TENANT, bytes: new Uint8Array(0), declaredName: 'empty.csv', asOfMs: ASOF });
  assert.strictEqual(r.verdict, 'QUARANTINED');
  assert.strictEqual(r.stage, 'gate');
  assert.strictEqual(r.reason, 'EMPTY_PAYLOAD');
  assert.strictEqual(ports.calls.tasks.length, 1);
  assert.strictEqual(ports.calls.tasks[0].tasks[0].severity, 'CRITICAL');
  assert.strictEqual(ports.calls.tasks[0].ctx.checksum, r.checksum);
  assert.strictEqual(ports.calls.registerQuarantine.length, 0); // kind unknown — never registered
  assert.strictEqual(ports.calls.quarantineRecords, null);
});
test('the XML family is refused outright (XXE stance) — same gate, same honesty', async () => {
  const ports = stubPorts();
  const r = await runFileToRows({ ports, executor: stubExecutor() }, { tenantId: TENANT, bytes: Buffer.from('<?xml version="1.0"?><a/>'), declaredName: 'data.xml', asOfMs: ASOF });
  assert.strictEqual(r.reason, 'XML_REJECTED');
  assert.strictEqual(ports.calls.registerQuarantine.length, 0);
});
test('an XLSX workbook passes the H10 gate structurally, then refuses by NAME — extraction is a follow-on unit', async () => {
  const ports = stubPorts();
  const r = await runFileToRows(
    { ports, executor: stubExecutor() },
    { tenantId: TENANT, bytes: fakeXlsxBytes(), declaredName: 'ITEMS.xlsx', asOfMs: ASOF, avScan: async () => ({ clean: true, engine: 'stub-av' }) },
  );
  assert.strictEqual(r.verdict, 'QUARANTINED');
  assert.strictEqual(r.stage, 'grid');
  assert.strictEqual(r.reason, 'XLSX_EXTRACTION_NOT_WIRED');
  assert.ok(r.detail.includes('no hand-rolled XML parser'));
  assert.strictEqual(ports.calls.tasks[0].tasks[0].severity, 'CRITICAL');
  assert.strictEqual(ports.calls.registerQuarantine.length, 0);
});
test('a text file with no kind signature binds nothing — quarantined whole with the closest match named', async () => {
  const ports = stubPorts();
  const r = await runFileToRows(
    { ports, executor: stubExecutor() },
    { tenantId: TENANT, bytes: Buffer.from('a,b,c\n1,2,3'), declaredName: 'mystery.csv', asOfMs: ASOF, avScan: async () => ({ clean: true, engine: 'stub-av' }) },
  );
  assert.strictEqual(r.verdict, 'QUARANTINED');
  assert.strictEqual(r.stage, 'bind');
  assert.strictEqual(r.reason, 'NO_HEADER_ROW_FOUND');
  assert.ok(r.detail.includes('no kind signature matched'));
  assert.strictEqual(ports.calls.registerQuarantine.length, 0);
});

/* ---- the golden items file, end to end ----------------------------------------- */
console.log('\nThe golden items file: gate → bind → type → H6 → executor, honestly counted');

test('items_modeA.csv lands APPLIED with honest counters — including the fixture\'s own shifted row caught per-row', async () => {
  const ex = stubExecutor();
  const r = await run({}, ex, { bytes: fixture('items_modeA.csv'), declaredName: 'items_modeA.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(r.kind, 'items');
  assert.strictEqual(r.counters.instructionRowCount, 2);
  assert.strictEqual(r.counters.rowsRead, 3);
  assert.strictEqual(r.counters.rowsApplied, 2); // TS-0003 shifts a column (extra comma in the pinned fixture) — the strict boundary catches it
  assert.strictEqual(r.counters.rowsQuarantined, 3); // SCIENTIFIC + UNRESOLVED_UNIT + FORMAT on the same shifted line
  assert.strictEqual(r.counters.unresolvedUnits, 1);
  assert.strictEqual(r.tasksRaised, 1); // the unresolved-unit WARN
  assert.ok(r.disclosures.some((d) => d.includes('instruction row(s)')));
  assert.deepStrictEqual(ex.calls.plans[0].rows.map((x) => x.row.sku), ['TS-0001', 'TS-0002']);
  assert.strictEqual(ex.calls.plans[0].rows[0].row.price, 12.5); // a NUMBER — the strict parse ran
  assert.strictEqual(ex.calls.plans[0].rows[0].row.inactive, false); // '0' via the column's own polarity
  assert.strictEqual(ex.calls.plans[0].rows[0].row.unit, 'KG'); // resolved to the CANONICAL spelling
});
test('the plan keys derive from the BUSINESS identity (Item SKU)', async () => {
  const ex = stubExecutor();
  const r = await run({}, ex, { bytes: fixture('items_modeA.csv'), declaredName: 'items_modeA.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.deepStrictEqual(ex.calls.plans[0].rows.map((x) => x.key), ['["TS-0001"]', '["TS-0002"]']);
});
test('§14.13b: the executor\'s CF summary rides the run — staged/blank disclosures, CF_INVALID_KEPT task on the register', async () => {
  const ex = stubExecutor();
  ex.apply = async (plan) => ({
    fileId: 'file-uuid', appliedAt: 1756500000000, rowsApplied: plan.rows.length, keysRegistered: plan.rows.length,
    cf: {
      staged: 1, stagedExisting: 0, blanksKept: 2, invalidKept: 1,
      tasks: [{ type: 'DATA_HEALTH', field: 'conversion_factor', severity: 'WARN', detail: 'sku X: incoming conversion factor unusable (0) — CF_INVALID_KEPT, the stored factor keeps serving (§14.13b)' }],
    },
  });
  const r = await run({}, ex, { bytes: fixture('items_modeA.csv'), declaredName: 'items_modeA.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(r.tasksRaised, 2); // the unresolved-unit WARN + the CF_INVALID_KEPT WARN
  assert.ok(r.disclosures.some((d) => d.includes('1 conversion-factor change(s) staged as PENDING versions')));
  assert.ok(r.disclosures.some((d) => d.includes('2 item row(s) carried no conversion factor')));
  assert.ok(r.disclosures.filter((d) => d.includes('conversion-factor') || d.includes('conversion factor')).every((d) => d.includes('§14.13b')));
});
test('REPLAY_NOOP: the same file twice changes nothing — zero writes, prior identity returned', async () => {
  const ports = stubPorts();
  const ex = stubExecutor({ prior: { id: 'prior-file', status: 'APPLIED', appliedAt: 1756500000000 } });
  const r = await run(ports, ex, { bytes: fixture('items_modeA.csv'), declaredName: 'items_modeA.csv' });
  assert.strictEqual(r.verdict, 'REPLAY_NOOP');
  assert.strictEqual(r.fileId, 'prior-file');
  assert.strictEqual(r.appliedAt, 1756500000000);
  assert.strictEqual(ex.calls.plans.length, 0); // the executor never saw a plan
  assert.strictEqual(ports.calls.tasks.length, 0); // a replay is not a gap
  assert.strictEqual(ports.calls.quarantineRecords, null);
  assert.strictEqual(ports.calls.registerQuarantine.length, 0);
});
test('identical bytes + identical ports produce deep-equal receipts (determinism)', async () => {
  const a = await run({}, {}, { bytes: fixture('items_modeA.csv'), declaredName: 'items_modeA.csv' });
  const b = await run({}, {}, { bytes: fixture('items_modeA.csv'), declaredName: 'items_modeA.csv' });
  assert.deepStrictEqual(a, b);
});
test('the source is recorded but never consulted — email-in rides the identical pipeline', async () => {
  const a = await run({}, {}, { bytes: fixture('items_modeA.csv'), declaredName: 'items_modeA.csv', source: 'dropzone' });
  const b = await run({}, {}, { bytes: fixture('items_modeA.csv'), declaredName: 'items_modeA.csv', source: 'email-in' });
  assert.strictEqual(b.source, 'email-in');
  const { source: _s, ...rest } = b;
  const { source: _s2, ...restA } = a;
  void _s; void _s2;
  assert.deepStrictEqual(rest, restA); // every verdict field identical except the recorded source
});

/* ---- per-row quarantine: corruption quarantines its ROW, never the file ---------- */
console.log('\nPer-row quarantine: a corrupt value never poisons the file, and it is LEDGERED');

test("a thousands-separated price quarantines its ROW; survivors apply with quarantined_count ledgered", async () => {
  const csvText = 'ITEMS — synthetic\nSKU *,Item Name *,Price *,Currency,Inactive * [1=Inactive 0=Active],Unit,Item Type *,Recipe Ref Name (required if the Code field is empty),Conversion Factor*\n'
    + 'TS-0001,Good Item,12.5,SAR,0,kg,Ingredient,Ref A,1\n'
    + 'TS-0002,Bad Item,"1,200",SAR,0,kg,Ingredient,Ref A,1\n'
    + 'TS-0003,Other Item,3.25,SAR,0,each,Ingredient,Ref B,1\n';
  const ex = stubExecutor();
  const r = await run({}, ex, { bytes: Buffer.from(csvText), declaredName: 'mixed.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(r.counters.rowsRead, 3);
  assert.strictEqual(r.counters.rowsApplied, 2);
  assert.strictEqual(r.counters.rowsQuarantined, 1);
  const ex2 = stubExecutor();
  const ports2 = stubPorts();
  const r2 = await runFileToRows({ ports: ports2, executor: ex2 }, { tenantId: TENANT, bytes: Buffer.from(csvText), declaredName: 'mixed.csv', asOfMs: ASOF, avScan: async () => ({ clean: true, engine: 'stub-av' }) });
  assert.strictEqual(r2.counters.rowsApplied, 2);
  assert.strictEqual(ports2.calls.quarantineRecords.records.length, 1);
  assert.strictEqual(ports2.calls.quarantineRecords.records[0].reason, 'THOUSANDS_SEPARATOR');
  assert.strictEqual(ports2.calls.quarantineRecords.records[0].rowIndex, 4); // the ORIGINAL file line of the bad row
  assert.strictEqual(ports2.calls.quarantineRecords.fileId, ports2.calls.countUpdates[0].fileId);
  assert.strictEqual(ports2.calls.countUpdates[0].n, 1);
});
test('an unresolved unit spelling is a data-health item, never a guess — and zero survivors quarantines the file whole', async () => {
  const csvText = 'ITEMS — synthetic\nSKU *,Item Name *,Price *,Currency,Inactive * [1=Inactive 0=Active],Unit,Item Type *,Recipe Ref Name (required if the Code field is empty),Conversion Factor*\n'
    + 'TS-0001,Odd Unit Item,12.5,SAR,0,crat,Ingredient,Ref A,1\n';
  const r = await run({}, stubExecutor(), { bytes: Buffer.from(csvText), declaredName: 'unit.csv' });
  assert.strictEqual(r.verdict, 'QUARANTINED');
  assert.strictEqual(r.reason, 'NO_SURVIVOR_ROWS');
  assert.strictEqual(r.counters.rowsQuarantined, 1);
  assert.strictEqual(r.counters.unresolvedUnits, 1);
  assert.strictEqual(r.tasksRaised, 1); // the WARN naming the unresolved spellings
});
test('a file whose rows ALL quarantine is quarantined whole — registered, never half-applied', async () => {
  const csvText = 'ITEMS — synthetic\nSKU *,Item Name *,Price *,Currency,Inactive * [1=Inactive 0=Active],Unit,Item Type *,Recipe Ref Name (required if the Code field is empty),Conversion Factor*\n'
    + 'TS-0001,Bad Item,"1,200",SAR,0,kg,Ingredient,Ref A,1\n';
  const ports = stubPorts();
  const ex = stubExecutor();
  const r = await runFileToRows({ ports, executor: ex }, { tenantId: TENANT, bytes: Buffer.from(csvText), declaredName: 'allbad.csv', asOfMs: ASOF, avScan: async () => ({ clean: true, engine: 'stub-av' }) });
  assert.strictEqual(r.verdict, 'QUARANTINED');
  assert.strictEqual(r.stage, 'validate');
  assert.strictEqual(r.reason, 'NO_SURVIVOR_ROWS');
  assert.strictEqual(ex.calls.plans.length, 0);
  assert.strictEqual(ports.calls.registerQuarantine.length, 1);
  assert.strictEqual(ports.calls.registerQuarantine[0].kind, 'items'); // the H6 unique, honest status
  assert.strictEqual(ports.calls.registerQuarantine[0].quarantinedCount, 1);
  assert.strictEqual(ports.calls.quarantineRecords.fileId, 'file-q-uuid');
});
test('a junk boolean and a missing required field quarantine their rows with the original line numbers', async () => {
  const csvText = 'ITEMS — synthetic\nSKU *,Item Name *,Price *,Currency,Inactive * [1=Inactive 0=Active],Unit,Item Type *,Recipe Ref Name (required if the Code field is empty),Conversion Factor*\n'
    + 'TS-0001,Junk Flag,12.5,SAR,maybe,kg,Ingredient,Ref A,1\n'
    + 'TS-0002,,3.25,SAR,0,kg,Ingredient,Ref B,1\n';
  const r = await run({}, stubExecutor(), { bytes: Buffer.from(csvText), declaredName: 'junk.csv' });
  assert.strictEqual(r.counters.rowsQuarantined, 2);
  assert.strictEqual(r.counters.rowsApplied, 0);
  assert.strictEqual(r.verdict, 'QUARANTINED'); // no survivors
});

/* ---- the suppliers fixture: allow-list + H7 + payment terms ---------------------- */
console.log('\nSuppliers: banking columns never persist, terms parse to days, H7 identity keys');

test('suppliers_modeA_with_bank_columns.csv: every banned column dropped at the boundary, terms parsed to days', async () => {
  const ex = stubExecutor();
  const r = await run({}, ex, { bytes: fixture('suppliers_modeA_with_bank_columns.csv'), declaredName: 'suppliers.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(r.counters.droppedColumns, 13); // every banned column the export carries (the spec lists 14; the fixture ships 13)
  assert.strictEqual(r.counters.rowsApplied, 2);
  const row = ex.calls.plans[0].rows[0].row;
  assert.strictEqual(row.paymentTermDays, 45); // "SOA +45 Days" → 45, never guessed
  assert.strictEqual(row.supplierActive, true); // '1' IS active for the Active column
  assert.strictEqual(row.bankAccountNumber, undefined); // no banned field survives anywhere
});
test('the supplier key rides the H7 name branch for current-template exports', async () => {
  const ex = stubExecutor();
  await run({}, ex, { bytes: fixture('suppliers_modeA_with_bank_columns.csv'), declaredName: 'suppliers.csv' });
  assert.deepStrictEqual(ex.calls.plans[0].rows[0].key, '["name","Supplier A"]');
});

/* ---- deliveries: day-expansion + the A5 guard ------------------------------------ */
console.log('\nDeliveries: coarse granularities expand to exact-sum daily rows; YTD refuses by name');

test('deliveries_template_tab.csv: the weekly 700 expands to seven daily 100s — exact-sum, disclosed', async () => {
  const ex = stubExecutor();
  const r = await run({}, ex, { bytes: fixture('deliveries_template_tab.csv'), declaredName: 'deliveries.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  const rows = ex.calls.plans[0].rows.map((x) => x.row);
  const week = rows.filter((x) => x.periodStart === '2026-08-31');
  assert.strictEqual(week.length, 1);
  assert.strictEqual(week[0].qty, 100);
  assert.strictEqual(week[0].granularity, 'daily');
  const weekTotal = rows.filter((x) => x.periodStart >= '2026-08-31' && x.periodStart <= '2026-09-06').reduce((a, b) => a + b.qty, 0);
  assert.strictEqual(weekTotal, 700); // the period total survives exactly
  assert.strictEqual(rows.length, 10); // 3 native daily rows + 7 expanded days
  assert.ok(r.disclosures.some((d) => d.includes('expanded to 7 daily rows') && d.includes('line 6')));
});
test('a YTD row refuses by name — cumulative totals are never spread', async () => {
  const csvText = 'DELIVERIES — Mode B template tab 6 shape\nPeriod Start,Granularity [daily|weekly|monthly|quarterly|ytd],Deliveries,Period End,Months Elapsed (YTD only),Business Unit\n'
    + '2026-01-01,ytd,9600,2026-08-31,8,Unit A\n';
  const ex = stubExecutor();
  const r = await run({}, ex, { bytes: Buffer.from(csvText), declaredName: 'ytd.csv' });
  assert.strictEqual(r.verdict, 'QUARANTINED');
  assert.strictEqual(r.reason, 'NO_SURVIVOR_ROWS');
  assert.ok(r.disclosures.length === 0 || r.disclosures.every((d) => !d.includes('ytd')));
  void ex;
});
test('the A5 guard: a daily value outside the ±50% band runs on the trailing 7-day mean, named in a task + banner', async () => {
  const history = [];
  for (let d = 24; d <= 30; d++) history.push({ date: `2026-08-${d}`, qty: 100 });
  const csvText = 'DELIVERIES — Mode B template tab 6 shape\nPeriod Start,Granularity [daily|weekly|monthly|quarterly|ytd],Deliveries,Period End,Months Elapsed (YTD only),Business Unit\n'
    + '2026-08-31,daily,1000,2026-08-31,,Unit A\n';
  const ex = stubExecutor();
  const r = await run({ history }, ex, { bytes: Buffer.from(csvText), declaredName: 'spike.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(ex.calls.plans[0].rows[0].row.qty, 100); // the substitution, honest
  assert.ok(r.disclosures.some((d) => d.includes('±50% band') && d.includes('line 3')));
  assert.strictEqual(r.banners.length, 1);
  assert.strictEqual(r.tasksRaised, 1);
});
test('a value inside the band sails through untouched', async () => {
  const history = [];
  for (let d = 24; d <= 30; d++) history.push({ date: `2026-08-${d}`, qty: 100 });
  const csvText = 'DELIVERIES — Mode B template tab 6 shape\nPeriod Start,Granularity [daily|weekly|monthly|quarterly|ytd],Deliveries,Period End,Months Elapsed (YTD only),Business Unit\n'
    + '2026-08-31,daily,120,2026-08-31,,Unit A\n';
  const ex = stubExecutor();
  const r = await run({ history }, ex, { bytes: Buffer.from(csvText), declaredName: 'ok.csv' });
  assert.strictEqual(ex.calls.plans[0].rows[0].row.qty, 120);
  assert.strictEqual(r.tasksRaised, 0);
});

/* ---- inventory: code→id resolution + C2 ------------------------------------------ */
console.log('\nInventory: codes resolve to ids BEFORE the executor; value normalizes in the tenant currency');

test('resolved refs land as ids; unresolved codes quarantine per-row; value rides rate-1 C2, disclosed', async () => {
  const csvText = 'INVENTORY — synthetic\nWarehouse,SKU,Item Name,Unit,Quantity,"Gross Total, Document Currency"\n'
    + 'RIYADH-01,SKU-1,Cached Item,kg,10,950\n'
    + 'NOWHERE-01,SKU-1,Item,kg,5,400\n'
    + 'RIYADH-01,GHOST-SKU,Item,kg,5,400\n';
  const ex = stubExecutor();
  const r = await run({ itemIds: { 'SKU-1': '33333333-3333-4333-8333-333333333333' }, warehouseIds: { 'RIYADH-01': '44444444-4444-4444-8444-444444444444' } }, ex, { bytes: Buffer.from(csvText), declaredName: 'inv.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(r.counters.rowsApplied, 1);
  assert.strictEqual(r.counters.rowsQuarantined, 2);
  const row = ex.calls.plans[0].rows[0].row;
  assert.strictEqual(row.itemId, '33333333-3333-4333-8333-333333333333');
  assert.strictEqual(row.warehouseId, '44444444-4444-4444-8444-444444444444');
  assert.strictEqual(row.documentCurrency, 'SAR'); // tenant currency — the export carries none, disclosed
  assert.strictEqual(row.tenantValue, 950); // rate 1, LOCAL
  assert.ok(r.disclosures.some((d) => d.includes('the document currency IS the tenant currency')));
});
test('a negative on-hand is FLAGGED, kept, and raised as a WARN — §4 says flagged, not refused', async () => {
  const csvText = 'INVENTORY — synthetic\nWarehouse,SKU,Item Name,Unit,Quantity,"Gross Total, Document Currency"\n'
    + 'RIYADH-01,SKU-1,Negative Item,kg,-3,95\n';
  const ex = stubExecutor();
  const r = await run({ itemIds: { 'SKU-1': '33333333-3333-4333-8333-333333333333' }, warehouseIds: { 'RIYADH-01': '44444444-4444-4444-8444-444444444444' } }, ex, { bytes: Buffer.from(csvText), declaredName: 'neg.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(ex.calls.plans[0].rows[0].row.quantity, -3); // kept
  assert.strictEqual(r.tasksRaised, 1); // the WARN
});

/* ---- open POs: C1 conversion + C2 money ------------------------------------------ */
console.log('\nOpen POs: waiting quantities convert at ingestion (C1); money pins to the tenant rate (C2)');

const openPoCsv = (price) => 'OPEN POS — synthetic\nPurchase Order #,Supplier,SKU,Item Name,Unit,Purchase Order Delivery Date,Unit Price,Receipt Dates,Currency,Ordered (Quantity),Received (Quantity),Waiting (Quantity)\n'
  + `PO-1,Supplier A,SKU-1,Item,CTN,2026-09-01,${price},,USD,100,40,60\n`;
test('with a conversion factor and a pinned rate: waitingQtyConverted = waiting × factor, tenantUnitPrice = price × pin', async () => {
  const ex = stubExecutor();
  const r = await run({ factors: { 'SKU-1': 12 }, pin: 3.75 }, ex, { bytes: Buffer.from(openPoCsv('2')), declaredName: 'pos.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  const row = ex.calls.plans[0].rows[0].row;
  assert.strictEqual(row.waitingQtyConverted, 720);
  assert.strictEqual(row.tenantUnitPrice, 7.5); // 2 × 3.75
  assert.ok(r.disclosures.some((d) => d.includes('pinned USD→SAR rate 3.75')));
});
test('a SKU without a conversion factor quarantines MISSING_CONVERSION_FACTOR (the engine never sees it)', async () => {
  const r = await run({ pin: 3.75 }, stubExecutor(), { bytes: Buffer.from(openPoCsv('2')), declaredName: 'pos.csv' });
  assert.strictEqual(r.verdict, 'QUARANTINED');
  assert.strictEqual(r.reason, 'NO_SURVIVOR_ROWS');
  assert.strictEqual(r.counters.unresolvedUnits, 0);
});
test('an unpinned USD day refuses RATE_NOT_PINNED per row — never a guessed rate', async () => {
  const csvText = 'OPEN POS — synthetic\nPurchase Order #,Supplier,SKU,Item Name,Unit,Purchase Order Delivery Date,Unit Price,Receipt Dates,Currency,Ordered (Quantity),Received (Quantity),Waiting (Quantity)\n'
    + 'PO-1,Supplier A,SKU-1,Item,CTN,2026-09-01,2,,USD,100,40,60\n'
    + 'PO-2,Supplier A,SKU-1,Item,CTN,2026-09-01,2,,SAR,100,40,60\n';
  const ex = stubExecutor();
  const r = await run({ factors: { 'SKU-1': 12 } }, ex, { bytes: Buffer.from(csvText), declaredName: 'pos.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(r.counters.rowsApplied, 1); // the SAR line (rate 1, LOCAL)
  assert.strictEqual(r.counters.rowsQuarantined, 1); // the USD line — no pin for the day
  const kept = ex.calls.plans[0].rows.map((x) => x.row);
  assert.strictEqual(kept[0].currency, 'SAR');
  assert.strictEqual(kept[0].tenantUnitPrice, 2);
});

/* ---- open POs: the §14.6c Purchase Order Status surface --------------------------- */

const openPoStatusCsv = (rows, withHeader = true) => 'OPEN POS — synthetic\n'
  + 'Purchase Order #,Supplier,SKU,Item Name,Unit,Purchase Order Delivery Date,Unit Price,Receipt Dates,Currency,Ordered (Quantity),Received (Quantity),Waiting (Quantity),Purchase Order Status\n'
  + rows.join('\n') + '\n';
test('a carried status normalizes to the closed vocabulary and rides the row (§14.6c)', async () => {
  const ex = stubExecutor();
  const csvText = openPoStatusCsv([
    'PO-1,Supplier A,SKU-1,Item,CTN,2026-09-01,2,,USD,100,40,60,open',
    'PO-2,Supplier A,SKU-1,Item,CTN,2026-09-01,2,,USD,100,0,100,CANCELLED',
  ]);
  const r = await run({ factors: { 'SKU-1': 1 }, pin: 3.75 }, ex, { bytes: Buffer.from(csvText), declaredName: 'pos.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  const rows = ex.calls.plans[0].rows.map((x) => x.row);
  assert.strictEqual(rows[0].poStatus, 'OPEN');
  assert.strictEqual(rows[1].poStatus, 'CANCELLED');
});
test('a present-but-unknown status quarantines the row PO_STATUS_UNKNOWN — never coerced', async () => {
  const ex = stubExecutor();
  const ports = stubPorts({ factors: { 'SKU-1': 1 }, pin: 3.75 });
  const csvText = openPoStatusCsv([
    'PO-1,Supplier A,SKU-1,Item,CTN,2026-09-01,2,,USD,100,40,60,pending',
    'PO-2,Supplier A,SKU-1,Item,CTN,2026-09-01,2,,SAR,100,0,100,OPEN',
  ]);
  const r = await run(ports, ex, { bytes: Buffer.from(csvText), declaredName: 'pos.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(r.counters.rowsApplied, 1);
  assert.strictEqual(r.counters.rowsQuarantined, 1);
  assert.strictEqual(ports.calls.quarantineRecords.records[0].reason, 'PO_STATUS_UNKNOWN');
});
test('a blank status among carried ones degrades that line to live and discloses the count', async () => {
  const ex = stubExecutor();
  const csvText = openPoStatusCsv([
    'PO-1,Supplier A,SKU-1,Item,CTN,2026-09-01,2,,USD,100,40,60,',
    'PO-2,Supplier A,SKU-1,Item,CTN,2026-09-01,2,,USD,100,0,100,OPEN',
  ]);
  const r = await run({ factors: { 'SKU-1': 1 }, pin: 3.75 }, ex, { bytes: Buffer.from(csvText), declaredName: 'pos.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(ex.calls.plans[0].rows[0].row.poStatus, null);
  assert.ok(r.disclosures.some((d) => d.includes('1 open PO line(s) carried no Purchase Order Status value')));
});
test('a feed without the status column discloses the live-line degradation once (§14.6c)', async () => {
  const ex = stubExecutor();
  const r = await run({ factors: { 'SKU-1': 12 }, pin: 3.75 }, ex, { bytes: Buffer.from(openPoCsv('2')), declaredName: 'pos.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(ex.calls.plans[0].rows[0].row.poStatus, null);
  assert.ok(r.disclosures.some((d) => d.includes('no Purchase Order Status column — every line degrades to live')));
});

/* ---- category owners + planning params ------------------------------------------- */
console.log('\nControl plane: owner identity resolves honestly; params fold into the storage shape');

test('category_owners: a registered email resolves to user_id; an unknown one stays null, disclosed', async () => {
  const csvText = 'CATEGORY OWNERS — synthetic\nCategory Name,Tenant,Owner Name,Owner Email,Role\n'
    + 'Produce,T1,Dana,dana@x.test,Buyer\n'
    + 'Bakery,T1,Lou,unknown@x.test,Head\n';
  const ex = stubExecutor();
  const r = await run({ users: { 'dana@x.test': '55555555-5555-4555-8555-555555555555' } }, ex, { bytes: Buffer.from(csvText), declaredName: 'owners.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  const rows = ex.calls.plans[0].rows.map((x) => x.row);
  assert.strictEqual(rows[0].userId, '55555555-5555-4555-8555-555555555555');
  assert.strictEqual(rows[1].userId, null);
  assert.ok(r.disclosures.some((d) => d.includes('no Sentinel user yet')));
});
test('planning_params fold their dimensions into the executor\'s single params object', async () => {
  const csvText = 'PLANNING PARAMS — synthetic\nRecipe Ref Name,Lead Time Days,Safety Days,Order Frequency Days,MOQ,Preferred SKU,Shelf Life Days\n'
    + 'Ref A,7,2,3,50,1,180\n';
  const ex = stubExecutor();
  const r = await run({}, ex, { bytes: Buffer.from(csvText), declaredName: 'params.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  const row = ex.calls.plans[0].rows[0].row;
  assert.deepStrictEqual(row.params, { leadTimeDays: 7, safetyDays: 2, orderFreqDays: 3, moq: 50, preferredSku: true, shelfLifeDays: 180 });
  assert.deepStrictEqual(ex.calls.plans[0].rows[0].key, '["Ref A"]');
});
test('mode B is accepted and rides the plan (§1: both modes, identical pipeline)', async () => {
  const ex = stubExecutor();
  const r = await run({}, ex, { bytes: fixture('deliveries_template_tab.csv'), declaredName: 'deliveries.csv', mode: 'B' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(ex.calls.plans[0].mode, 'B');
});
test('a second drop with overlapping keys upserts in place with honest DAT-04 accounting', async () => {
  const seen = ['["TS-0001"]'];
  const ex = stubExecutor({ seen });
  const r = await run({}, ex, { bytes: fixture('items_modeA.csv'), declaredName: 'items_v2.csv' });
  assert.strictEqual(r.verdict, 'APPLIED');
  assert.strictEqual(r.counters.duplicateHits, 1);
  assert.strictEqual(r.counters.newKeys, 1);
  assert.ok(r.disclosures.some((d) => d.includes('1 of 2 keys are already in this tenant\'s register')));
});

(async () => {
  await Promise.all(pending);
  console.log(`\n  file-to-rows worker: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
