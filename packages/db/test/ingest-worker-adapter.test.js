'use strict';
/* ============================================================================
 * Ingest worker adapter — structural proof WITHOUT a database (stub client).
 *
 * The file-to-rows worker's SQL surface (M3, D-028): the pipeline read ports
 * (tenant settings, unit catalog, FX pin, conversion factors, code→id and
 * email→id resolution, daily deliveries history) and the persistence half
 * the H6 layers left to the production caller (register failure lifecycle,
 * quarantine ledger, data_health tasks, quarantined-count fix-up).
 *
 * The live half rides the db-rls job like its siblings. Here every port is
 * pinned tenant-fenced with the exact shape the pipeline consumes — the
 * shapes are contracts: resolveUnit eats {canonical, aliases},
 * normalizeMoney eats {usdToLocalByDay}, the register lifecycle upserts the
 * SAME H6 unique apply() uses (a retry never forks the file history).
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');
const { makeIngestWorkerAdapter, TASK_SEVERITIES } = require(path.join(__dirname, '..', 'ingest-worker-adapter'));

let passed = 0, failed = 0;
/* Async-safe runner: an async test's assertions must COMPLETE before the
 * summary prints — a bare process.exit would swallow every pending
 * continuation (proven: a failing async test exited 0). Every async test
 * promise is collected and awaited before the verdict. */
const pending = [];
function test(name, fn) {
  const pass = () => { passed++; console.log('  ✓ ' + name); };
  const fail = (e) => { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); };
  let out;
  try { out = fn(); } catch (e) { fail(e); return; }
  if (out && typeof out.then === 'function') pending.push(out.then(pass, fail));
  else pass();
}
async function rejects(name, fn, fragment) {
  return test(name, async () => {
    let threw = null;
    try { await fn(); } catch (e) { threw = e; }
    assert.ok(threw, 'expected a rejection');
    assert.ok(threw.message.includes(fragment), `expected '${fragment}', got: ${threw.message}`);
  });
}

/* Stub client: records statements, scripts responses keyed by table. */
function stubClient(script = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      if (/FROM tenant\b/i.test(text)) return { rows: script.tenant ? [script.tenant] : [], rowCount: script.tenant ? 1 : 0 };
      if (/FROM unit_catalog_entry/i.test(text) && !/JOIN/i.test(text)) {
        return { rows: (script.canonical || []).map((code) => ({ code })), rowCount: (script.canonical || []).length };
      }
      if (/FROM unit_alias/i.test(text)) {
        return { rows: (script.aliases || []).map(([alias, code]) => ({ alias, code })), rowCount: (script.aliases || []).length };
      }
      if (/FROM fx_rate_pin/i.test(text)) return script.pin ? { rows: [{ day: script.pinDay || '2026-08-30', usd_to_local: script.pin }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (/FROM item WHERE tenant_id = \$1 AND sku = ANY/i.test(text)) {
        return { rows: (script.itemIds || []).map(([sku, id]) => ({ sku, id })), rowCount: (script.itemIds || []).length };
      }
      if (/FROM item\s+WHERE tenant_id = \$1 AND conversion_factor IS NOT NULL/i.test(text.replace(/\s+/g, ' '))) {
        return { rows: script.factors || [], rowCount: (script.factors || []).length };
      }
      if (/FROM warehouse/i.test(text)) {
        return { rows: (script.warehouseIds || []).map(([code, id]) => ({ code, id })), rowCount: (script.warehouseIds || []).length };
      }
      if (/FROM app_user/i.test(text)) {
        return { rows: (script.users || []).map(([email, id]) => ({ email, id })), rowCount: (script.users || []).length };
      }
      if (/FROM delivery_day/i.test(text)) return { rows: script.history || [], rowCount: (script.history || []).length };
      if (/RETURNING id/i.test(text)) return { rows: [{ id: 'file-uuid' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
}

const T = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(64);
const FILE_ID = '66666666-6666-4666-8666-666666666666';

/* ---- construction ---------------------------------------------------------- */
console.log('\nThe worker adapter is tenant-bound and client-injected');

test('a client without .query refuses at construction', () => {
  let threw = null;
  try { makeIngestWorkerAdapter({}, T); } catch (e) { threw = e; }
  assert.ok(threw && threw.message.includes('client must be a pg client with .query'), threw && threw.message);
});
test('an empty tenantId refuses at construction', () => {
  let threw = null;
  try { makeIngestWorkerAdapter(stubClient(), '  '); } catch (e) { threw = e; }
  assert.ok(threw && threw.message.includes('tenantId must be a non-empty string'), threw && threw.message);
});

/* ---- read ports -------------------------------------------------------------- */
console.log('\nRead ports: the pipeline never guesses a setting, a rate, a catalog or an id');

test('loadTenantSettings selects currency + timezone, tenant-fenced; a gone tenant returns null', async () => {
  const c = stubClient({ tenant: { currencyCode: 'SAR', timezone: 'Asia/Riyadh' } });
  const s = await makeIngestWorkerAdapter(c, T).loadTenantSettings();
  assert.deepStrictEqual(s, { currencyCode: 'SAR', timezone: 'Asia/Riyadh' });
  assert.ok(c.calls[0].text.includes('FROM tenant WHERE id = $1'));
  assert.strictEqual(c.calls[0].values[0], T);
  const c2 = stubClient();
  assert.strictEqual(await makeIngestWorkerAdapter(c2, T).loadTenantSettings(), null);
});

test('loadUnitCatalog returns the resolveUnit shape {canonical, aliases}; aliases JOIN their own tenant catalog', async () => {
  const c = stubClient({ canonical: ['KG', 'CTN'], aliases: [['kilogram', 'KG'], ['case', 'CTN']] });
  const cat = await makeIngestWorkerAdapter(c, T).loadUnitCatalog();
  assert.deepStrictEqual(cat, { canonical: ['KG', 'CTN'], aliases: { kilogram: 'KG', case: 'CTN' } });
  const joinCall = c.calls.find((x) => /FROM unit_alias/i.test(x.text));
  assert.ok(joinCall.text.includes('JOIN unit_catalog_entry'), 'alias→code must be a JOIN, never a second guess');
});

test('loadFxPin returns the M10 WINDOW: the latest pin ≤ the run day, keyed by ITS OWN day; no pin ≤ the day is an EMPTY table', async () => {
  const c = stubClient({ pin: '3.75', pinDay: '2026-08-30' });
  const table = await makeIngestWorkerAdapter(c, T).loadFxPin('2026-08-31');
  assert.deepStrictEqual(table, { usdToLocalByDay: { '2026-08-30': 3.75 } }); // keyed by the PINNED day (the fail-safe's raw material)
  assert.strictEqual(table.usdToLocalByDay['2026-08-30'], 3.75); // NUMBER, not the DECIMAL string
  const q = c.calls.find((x) => /FROM fx_rate_pin/i.test(x.text));
  assert.ok(q.text.includes('day <= $2'), 'the window query scopes day ≤ the run day');
  assert.ok(q.text.includes('ORDER BY day DESC LIMIT 1'), 'the window query takes the LATEST pin ≤ the day');
  const c2 = stubClient();
  const empty = await makeIngestWorkerAdapter(c2, T).loadFxPin('2026-08-31');
  assert.deepStrictEqual(empty, { usdToLocalByDay: {} }); // NO pin ≤ the day — the refusal case (RATE_NOT_PINNED at the money layer)
});

rejects('loadFxPin refuses a non-canonical day — a typo must never silently miss its pin',
  () => makeIngestWorkerAdapter(stubClient(), T).loadFxPin('2026-8-31'),
  'day must be a YYYY-MM-DD string');

test('loadConversionFactors returns sku→factor for usable factors', async () => {
  const c = stubClient({ factors: [{ sku: 'S1', conversion_factor: '12' }, { sku: 'S2', conversion_factor: '0.5' }] });
  const m = await makeIngestWorkerAdapter(c, T).loadConversionFactors();
  assert.deepStrictEqual(m, { S1: 12, S2: 0.5 });
});
rejects('a corrupt master factor refuses at the boundary (never silently converts)',
  () => makeIngestWorkerAdapter(stubClient({ factors: [{ sku: 'BAD', conversion_factor: '0' }] }), T).loadConversionFactors(),
  'non-usable conversion_factor');

test('resolveStockRefs batches tenant-scoped lookups; unresolved codes are simply absent — never invented', async () => {
  const ITEM = '33333333-3333-4333-8333-333333333333';
  const WH = '44444444-4444-4444-8444-444444444444';
  const c = stubClient({ itemIds: [['SKU-1', ITEM]], warehouseIds: [['RIYADH-01', WH]] });
  const refs = await makeIngestWorkerAdapter(c, T).resolveStockRefs(['SKU-1', 'SKU-GONE'], ['RIYADH-01']);
  assert.deepStrictEqual(refs, { items: { 'SKU-1': ITEM }, warehouses: { 'RIYADH-01': WH } });
  assert.ok(c.calls[0].text.includes('sku = ANY($2::text[])'));
  assert.ok(c.calls[1].text.includes('code = ANY($2::text[])'));
  const empty = await makeIngestWorkerAdapter(stubClient(), T).resolveStockRefs([], []);
  assert.deepStrictEqual(empty, { items: {}, warehouses: {} });
});

test('resolveUserIdsByEmail is a global-registry lookup (identity above the fence); unknown emails stay absent', async () => {
  const UID = '55555555-5555-4555-8555-555555555555';
  const c = stubClient({ users: [['o@x.test', UID]] });
  const m = await makeIngestWorkerAdapter(c, T).resolveUserIdsByEmail(['o@x.test', 'gone@x.test']);
  assert.deepStrictEqual(m, { 'o@x.test': UID });
});

test('loadDailyDeliveriesHistory reads daily rows only, as {date, qty} numbers for the A5 baseline', async () => {
  const c = stubClient({ history: [{ day: '2026-08-30', deliveries: '110' }, { day: '2026-08-31', deliveries: '95.5' }] });
  const h = await makeIngestWorkerAdapter(c, T).loadDailyDeliveriesHistory();
  assert.deepStrictEqual(h, [{ date: '2026-08-30', qty: 110 }, { date: '2026-08-31', qty: 95.5 }]);
  assert.ok(c.calls[0].text.includes("granularity = 'daily'"));
});

/* ---- persistence half ---------------------------------------------------------- */
console.log('\nPersistence: the register lifecycle, the quarantine ledger, the data-health register');

const FILE = { kind: 'items', mode: 'A', fileName: 'ITEMS.xlsx', checksum: SHA, byteSize: 128, rowCount: 10, quarantinedCount: 2 };

test('markFileQuarantined upserts the SAME H6 unique as apply(), stamps the status, resets applied_at', async () => {
  const c = stubClient();
  const out = await makeIngestWorkerAdapter(c, T).markFileQuarantined(FILE);
  assert.deepStrictEqual(out, { fileId: 'file-uuid' });
  const s = c.calls[0].text;
  assert.ok(s.startsWith('INSERT INTO ingest_file'));
  assert.ok(s.includes("status='QUARANTINED'"));
  assert.ok(s.includes('ON CONFLICT (tenant_id, kind, checksum_sha256)'));
  assert.ok(s.includes('applied_at=NULL'));
  assert.deepStrictEqual(c.calls[0].values[0], T);
  assert.deepStrictEqual(c.calls[0].values[6], 'QUARANTINED');
});
test('markFileFailed is the same lifecycle with status FAILED', async () => {
  const c = stubClient();
  await makeIngestWorkerAdapter(c, T).markFileFailed({ ...FILE, rowCount: null, quarantinedCount: null });
  assert.ok(c.calls[0].text.includes("status='FAILED'"));
  assert.strictEqual(c.calls[0].values[7], null);
  assert.strictEqual(c.calls[0].values[8], null);
});
rejects('a pre-binding refusal has no kind and is NEVER registered — the register carries no guess',
  () => makeIngestWorkerAdapter(stubClient(), T).markFileQuarantined({ ...FILE, kind: '' }),
  'never registered');
rejects('markFile* refuses a junk checksum at the boundary',
  () => makeIngestWorkerAdapter(stubClient(), T).markFileQuarantined({ ...FILE, checksum: 'abc' }),
  'checksum must be a lowercase 64-hex sha256');
rejects('markFile* refuses a negative byteSize at the boundary',
  () => makeIngestWorkerAdapter(stubClient(), T).markFileQuarantined({ ...FILE, byteSize: -1 }),
  'byteSize must be a non-negative integer');
rejects('markFile* refuses a mode outside §1 (A|B) at the boundary',
  () => makeIngestWorkerAdapter(stubClient(), T).markFileQuarantined({ ...FILE, mode: 'C' }),
  'is not an INGESTION_FILE_SPEC');

test('insertQuarantineRecords batches one INSERT; ingest_file_id is linked when the run has one', async () => {
  const c = stubClient();
  const n = await makeIngestWorkerAdapter(c, T).insertQuarantineRecords([
    { fileKind: 'items', rowIndex: 3, field: 'price', raw: '1,200', reason: 'THOUSANDS_SEPARATOR', detail: '1,200' },
    { fileKind: 'items', rowIndex: 4, field: 'unit', raw: 'crat', reason: 'UNRESOLVED_UNIT' },
  ], FILE_ID);
  assert.strictEqual(n, 1); // stub rowCount
  const s = c.calls[0].text;
  assert.ok(s.startsWith('INSERT INTO quarantine_record'));
  assert.ok(s.includes('unnest($2::uuid[]'));
  const v = c.calls[0].values;
  assert.strictEqual(v[1][0], FILE_ID);
  assert.strictEqual(v[1][1], FILE_ID); // every record of the run rides the same register row
  assert.deepStrictEqual(v[2], ['items', 'items']);
  assert.deepStrictEqual(v[3], [3, 4]);
  assert.deepStrictEqual(v[6], ['THOUSANDS_SEPARATOR', 'UNRESOLVED_UNIT']);
  assert.strictEqual(v[5][1], 'crat'); // raw values carried verbatim
  assert.strictEqual(v[7][1], null); // no detail → NULL, never 'undefined'
});
test('insertQuarantineRecords with an empty list issues ZERO statements', async () => {
  const c = stubClient();
  assert.strictEqual(await makeIngestWorkerAdapter(c, T).insertQuarantineRecords([]), 0);
  assert.strictEqual(c.calls.length, 0);
});

test('insertDataHealthTasks persists the guard tasks verbatim: type→task_type, WARN floor, context rides the payload', async () => {
  const c = stubClient();
  await makeIngestWorkerAdapter(c, T).insertDataHealthTasks([
    { type: 'DATA_HEALTH', field: 'qty', fileKind: 'deliveries', detail: 'Deliveries value breached plausibility bounds; substituted pending confirmation.' },
    { type: 'DATA_HEALTH', field: 'ingest', detail: 'Inbound file refused.', severity: 'CRITICAL' },
  ], { fileName: 'DELIV.xlsx', checksum: SHA });
  const s = c.calls[0].text;
  assert.ok(s.includes("SELECT $1, 'DATA_HEALTH'"));
  assert.ok(s.includes("'OPEN'"));
  assert.deepStrictEqual(c.calls[0].values[1], ['WARN', 'CRITICAL']);
  const payloads = c.calls[0].values[2].map((p) => JSON.parse(p));
  assert.strictEqual(payloads[0].field, 'qty');
  assert.strictEqual(payloads[0].severity, undefined); // severity is a COLUMN, not duplicated in the payload
  assert.strictEqual(payloads[0].type, undefined);
  assert.strictEqual(payloads[0].sourceFile, 'DELIV.xlsx');
  assert.strictEqual(payloads[1].severity, undefined);
  assert.strictEqual(payloads[1].checksum, SHA);
});
test('insertDataHealthTasks carries ctx.sheetName into payload.sheet — the §14.26 fan-out names WHICH tab spoke', async () => {
  const c = stubClient();
  await makeIngestWorkerAdapter(c, T).insertDataHealthTasks([
    { type: 'DATA_HEALTH', field: 'qty', detail: 'Deliveries value breached plausibility bounds; substituted pending confirmation.' },
  ], { fileName: 'TEMPLATE.xlsx', checksum: SHA, sheetName: '6_DELIVERIES' });
  const payload = JSON.parse(c.calls[0].values[2][0]);
  assert.strictEqual(payload.sheet, '6_DELIVERIES');
  assert.strictEqual(payload.sourceFile, 'TEMPLATE.xlsx');
  // the single-grid path passes NO sheetName — the payload gains no sheet key
  const c2 = stubClient();
  await makeIngestWorkerAdapter(c2, T).insertDataHealthTasks([
    { type: 'DATA_HEALTH', field: 'ingest', detail: 'refused' },
  ], { fileName: 'ITEMS.csv', checksum: SHA });
  assert.strictEqual(JSON.parse(c2.calls[0].values[2][0]).sheet, undefined);
});
rejects('insertDataHealthTasks refuses a non-DATA_HEALTH object — fail-closed at the SQL boundary',
  () => makeIngestWorkerAdapter(stubClient(), T).insertDataHealthTasks([{ type: 'BANNER', field: 'x', detail: 'y' }]),
  'every task must be a');
rejects('insertDataHealthTasks refuses an unknown severity',
  () => makeIngestWorkerAdapter(stubClient(), T).insertDataHealthTasks([{ type: 'DATA_HEALTH', field: 'x', detail: 'y', severity: 'LOUD' }]),
  "severity 'LOUD' is not a data_health_severity");
test('the severity vocabulary is exactly the migration enum', () => {
  assert.deepStrictEqual(TASK_SEVERITIES, ['INFO', 'WARN', 'CRITICAL']);
});

test('updateQuarantinedCount is tenant-fenced by id and integer-checked', async () => {
  const c = stubClient();
  await makeIngestWorkerAdapter(c, T).updateQuarantinedCount(FILE_ID, 2);
  assert.ok(c.calls[0].text.startsWith('UPDATE ingest_file SET quarantined_count = $3'));
  assert.deepStrictEqual(c.calls[0].values, [T, FILE_ID, 2]);
});
rejects('updateQuarantinedCount refuses a junk fileId',
  () => makeIngestWorkerAdapter(stubClient(), T).updateQuarantinedCount('file-uuid', 2),
  'fileId must be a uuid string');
rejects('updateQuarantinedCount refuses a fractional count',
  () => makeIngestWorkerAdapter(stubClient(), T).updateQuarantinedCount(FILE_ID, 1.5),
  'quarantinedCount must be a non-negative integer');

test('insertDataHealthTasks casts the unnested severity to the ENUM in the SQL text itself — a bare text expression into data_health_severity refuses at real PostgreSQL (the walk\u0027s run-81 lesson; the procure door already cast, the worker adapter now matches)', async () => {
  const c = stubClient();
  await makeIngestWorkerAdapter(c, T).insertDataHealthTasks([
    { type: 'DATA_HEALTH', field: 'probe', detail: 'the pinned cast', severity: 'WARN' },
  ], { fileName: 'probe.csv', checksum: 'a'.repeat(64) });
  const stmt = c.calls.find((q) => q.text.includes('INSERT INTO data_health_task'));
  assert.ok(stmt, 'the task INSERT ran against the stub');
  assert.match(stmt.text, /f\.severity::data_health_severity/, 'the explicit cast rides the SQL — INSERT...SELECT\u0027s text column needs it, and only a live PostgreSQL run could catch its absence');
});

(async () => {
  await Promise.all(pending);
  console.log(`\n  ingest-worker-adapter (stub): ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
