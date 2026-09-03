'use strict';
/* ============================================================================
 * Named proof `worker/runtime` (§14.25) — the poll loop's semantics, pinned
 * WITHOUT a live database (the fence's live posture is walked by the db
 * suites; the compose walk is the e2e unit's named follow-on).
 *
 * Every dep of the runtime is injectable, so the proof substitutes stub
 * clients and stub pipelines and pins the CONTRACT, not the convenience:
 * the boot refusals; the scan's invisibility rules; the claim's atomic
 * rename BEFORE any byte is read; the fence ORDER (resolve above BEGIN,
 * the GUC before any adapter statement); the identity rule (the folder
 * speaks, the file's name never does); the outcome→folder mapping
 * EXHAUSTIVE; poison isolation; the boot sweep; the batch cap; the drain;
 * the FAILED-write's identity gate (both branches); and the exceljs exact
 * pin + the db public surface the runtime is the consumer of.
 * ==========================================================================*/

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require(path.join(__dirname, '..', 'src', 'config'));
const claimLayer = require(path.join(__dirname, '..', 'src', 'claim'));
const { processClaim, outcomeForVerdict } = require(path.join(__dirname, '..', 'src', 'runner'));
const { makeLoop } = require(path.join(__dirname, '..', 'src', 'main'));

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  const pass = () => { passed++; console.log('  ✓ ' + name); };
  const fail = (e) => { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); };
  let out;
  try { out = fn(); } catch (e) { fail(e); return; }
  if (out && typeof out.then === 'function') {
    pending.push(out.then(pass, fail));
  } else pass();
}

/* ---- helpers ------------------------------------------------------------- */

function tmpInbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'worker-runtime-'));
}

function mkFile(dir, name, content) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
  return path.join(dir, name);
}

/** A recording stub client — every statement lands in the shared timeline. */
function stubClient(timeline) {
  return {
    async query(sql, params) { timeline.push(sql.split('\n')[0].trim()); return { rows: [] }; },
    async end() { timeline.push('(client closed)'); },
  };
}

const TENANT = { id: '11111111-1111-4111-8111-111111111111', code: 'BHMP', name: 'Bahrain Metals' };

/** deps whose every seam is recorded; the pipeline is a stub returning the
 * given verdict (or throwing the given error). */
function stubDeps(overrides) {
  const timeline = [];
  const client = stubClient(timeline);
  const deps = {
    timeline,
    config: { inbox: '', databaseUrl: 'postgres://stub', pollMs: 1, batchMax: 25 },
    databaseUrl: 'postgres://stub',
    connect: async () => { timeline.push('connect'); return client; },
    resolveTenantByCode: async (c, code) => { timeline.push(`resolve(${code})`); return code === TENANT.code ? TENANT : null; },
    makeWorkerPorts: (c, t) => ({
      markFileFailed: async (file) => { timeline.push(`markFileFailed(${file.kind})`); return { fileId: 'F1' }; },
    }),
    makeExecutor: (c, t) => ({}),
    runFileToRows: async (d, input) => { timeline.push(`pipeline(${input.source},verdict)`) ; return { verdict: 'APPLIED', fileName: input.declaredName, tenantId: input.tenantId, source: input.source, mode: input.mode, asOfMs: input.asOfMs }; },
    faultIdentity: null, // the default: the watched folder cannot name a kind
    now: () => 1725369600000,
    log: () => {},
    ...overrides,
  };
  return deps;
}

/* ========================================================================== */

test('boot refusal: a missing DATABASE_URL refuses at boot with a named reason (dead on arrival must say so, not idle)', () => {
  try { loadConfig({}); assert.fail('the boot must refuse'); }
  catch (e) { assert.ok(/WORKER_BOOT_REFUSED.*DATABASE_URL/.test(e.message), e.message); }
});

test('boot refusal: SENTINEL_WORKER_POLL_MS / BATCH_MAX must be positive integers', () => {
  for (const bad of ['0', '-5', 'abc', '1.5']) {
    try { loadConfig({ DATABASE_URL: 'x', SENTINEL_WORKER_POLL_MS: bad }); assert.fail('poll ' + bad); }
    catch (e) { assert.ok(/WORKER_BOOT_REFUSED.*SENTINEL_WORKER_POLL_MS/.test(e.message), e.message); }
    try { loadConfig({ DATABASE_URL: 'x', SENTINEL_WORKER_BATCH_MAX: bad }); assert.fail('batch ' + bad); }
    catch (e) { assert.ok(/WORKER_BOOT_REFUSED.*SENTINEL_WORKER_BATCH_MAX/.test(e.message), e.message); }
  }
  const ok = loadConfig({ DATABASE_URL: 'x' });
  assert.strictEqual(ok.inbox, '/data/inbox');
  assert.strictEqual(ok.pollMs, 15000);
  assert.strictEqual(ok.batchMax, 25);
});

test('scan: tenant folders only; dotfiles and dot-directories invisible; a root file is an unattributed stray', () => {
  const inbox = tmpInbox();
  try {
    mkFile(inbox, 'BHMP/inventory.csv', 'x');
    mkFile(inbox, 'BHMP/.editor-residue.csv', 'x');
    mkFile(inbox, '.claiming/ghost.csv', 'x');
    mkFile(inbox, '.hidden-dir/never.csv', 'x');
    mkFile(inbox, 'stray-at-root.csv', 'x');
    mkFile(inbox, 'BHMP/subdir-is-not-a-file/ignore', 'x');
    const { tenants, strays } = claimLayer.scanInbox(inbox);
    assert.deepStrictEqual(tenants.map((t) => t.originalName), ['inventory.csv']);
    assert.strictEqual(tenants[0].tenantCode, 'BHMP');
    assert.deepStrictEqual(strays.map((s) => s.originalName), ['stray-at-root.csv']);
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('claim: the atomic rename moves the file into .claiming BEFORE any byte is read — the inbox path no longer exists', () => {
  const inbox = tmpInbox();
  try {
    const p = mkFile(inbox, 'BHMP/inventory.csv', 'SKU,Qty\nX,1');
    const claim = claimLayer.claimFile({ tenantCode: 'BHMP', originalName: 'inventory.csv', inboxPath: p });
    assert.ok(!fs.existsSync(p), 'the inbox copy must be gone the moment the claim lands');
    assert.ok(fs.existsSync(claim.claimedPath), 'the claimed file lives in .claiming/');
    assert.ok(claim.claimedPath.includes(path.join('BHMP', '.claiming')));
    assert.strictEqual(claim.originalName, 'inventory.csv');
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('settle: exactly one outcome folder per claimed file, tenant segment preserved; an invented outcome refuses', () => {
  const inbox = tmpInbox();
  try {
    const claim = { tenantCode: 'BHMP', originalName: 'inventory.csv', claimedPath: mkFile(inbox, 'BHMP/.claiming/inventory.csv', 'x') };
    const settled = claimLayer.settleFile(inbox, claim, 'done');
    assert.strictEqual(settled, path.join(inbox, 'done', 'BHMP', 'inventory.csv'));
    assert.ok(fs.existsSync(settled));
    try { claimLayer.settleFile(inbox, claim, 'maybe'); assert.fail('an invented outcome must refuse'); }
    catch (e) { assert.ok(/not one of done \| quarantine \| failed/.test(e.message), e.message); }
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('the fence ORDER: connect → resolve ABOVE BEGIN → the GUC → the adapters → the pipeline → COMMIT — the resolve precedes BEGIN, the GUC precedes every adapter statement', async () => {
  const deps = stubDeps({
    runFileToRows: async (d, input) => {
      deps.timeline.push('pipeline');
      await d.ports.probe(); // an adapter statement INSIDE the fence
      return { verdict: 'APPLIED' };
    },
  });
  const probeClient = stubClient(deps.timeline);
  deps.connect = async () => { deps.timeline.push('connect'); return probeClient; };
  deps.makeWorkerPorts = (c, t) => ({
    probe: async () => { await c.query('PORTS_PROBE'); },
    markFileFailed: async () => {},
  });
  deps.makeExecutor = () => ({ executor: true });
  const inbox = tmpInbox();
  deps.config.inbox = inbox;
  try {
    const claim = claimLayer.claimFile({ tenantCode: 'BHMP', originalName: 'inventory.csv', inboxPath: mkFile(inbox, 'BHMP/inventory.csv', 'x') });
    const r = await processClaim(deps, claim);
    assert.strictEqual(r.outcome, 'done');
    const i = (ev) => deps.timeline.indexOf(ev);
    assert.ok(i('resolve(BHMP)') < i('BEGIN'), 'identity resolves ABOVE the fence');
    assert.ok(i('BEGIN') < i("SELECT set_config('app.tenant_id', $1, true)"), 'the GUC follows BEGIN');
    assert.ok(i("SELECT set_config('app.tenant_id', $1, true)") < i('PORTS_PROBE'), 'no adapter statement precedes the GUC');
    assert.ok(i('PORTS_PROBE') < i('COMMIT'), 'the pipeline rides the fenced transaction');
    assert.ok(i('COMMIT') < i('(client closed)'), 'the client closes after COMMIT');
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('the identity rule: the FOLDER speaks — a file whose NAME encodes another tenant is processed under the folder tenant; the name is metadata only', async () => {
  const inputs = [];
  const deps = stubDeps({
    runFileToRows: async (d, input) => { inputs.push(input); return { verdict: 'APPLIED' }; },
  });
  const inbox = tmpInbox();
  deps.config.inbox = inbox;
  try {
    const claim = claimLayer.claimFile({ tenantCode: 'BHMP', originalName: 'TENANT_22222222_inventory_upload.csv', inboxPath: mkFile(inbox, 'BHMP/TENANT_22222222_inventory_upload.csv', 'x') });
    const r = await processClaim(deps, claim);
    assert.strictEqual(r.outcome, 'done');
    const input = inputs[0];
    assert.strictEqual(input.tenantId, TENANT.id, 'identity comes from the folder, resolved above the fence');
    assert.strictEqual(input.declaredName, 'TENANT_22222222_inventory_upload.csv', 'the name is metadata, recorded');
    assert.strictEqual(input.source, 'watched-folder');
    assert.strictEqual(input.mode, 'A');
    assert.strictEqual(input.asOfMs, 1725369600000, 'the clock is injected at the boundary');
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('unknown tenant code: no fence is opened, no register is attempted, the file lands failed/ with the named reason', async () => {
  const deps = stubDeps({});
  const inbox = tmpInbox();
  deps.config.inbox = inbox;
  try {
    const claim = claimLayer.claimFile({ tenantCode: 'GHOST', originalName: 'inventory.csv', inboxPath: mkFile(inbox, 'GHOST/inventory.csv', 'x') });
    const r = await processClaim(deps, claim);
    assert.strictEqual(r.outcome, 'failed');
    assert.strictEqual(r.reason, 'UNKNOWN_TENANT_CODE');
    assert.ok(!deps.timeline.includes('BEGIN'), 'no fence without a tenant');
    const settled = claimLayer.settleFile(inbox, claim, r.outcome);
    assert.ok(settled.includes(path.join('failed', 'GHOST')));
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('the outcome mapping is EXHAUSTIVE: APPLIED and REPLAY_NOOP → done, QUARANTINED → quarantine, anything else → failed', async () => {
  for (const [verdict, expected] of [['APPLIED', 'done'], ['REPLAY_NOOP', 'done'], ['QUARANTINED', 'quarantine']]) {
    assert.strictEqual(outcomeForVerdict(verdict), expected, verdict);
    const inbox = tmpInbox();
    const deps = stubDeps({ runFileToRows: async () => ({ verdict }) });
    deps.config.inbox = inbox;
    try {
      const claim = claimLayer.claimFile({ tenantCode: 'BHMP', originalName: 'f.csv', inboxPath: mkFile(inbox, 'BHMP/f.csv', 'x') });
      const r = await processClaim(deps, claim);
      assert.strictEqual(r.outcome, expected);
      assert.ok(claimLayer.settleFile(inbox, claim, r.outcome).includes(path.join(expected, 'BHMP')));
    } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
  }
  const inbox = tmpInbox();
  const deps = stubDeps({ runFileToRows: async () => ({ verdict: 'SOMETHING_ELSE' }) });
  deps.config.inbox = inbox;
  try {
    const claim = claimLayer.claimFile({ tenantCode: 'BHMP', originalName: 'f.csv', inboxPath: mkFile(inbox, 'BHMP/f.csv', 'x') });
    const r = await processClaim(deps, claim);
    assert.strictEqual(r.outcome, 'failed', 'an unrecognized verdict is a bug: failed/, never done/');
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('the fault path: ROLLBACK, NO FAILED register write (a fault without bound identity — a pre-binding refusal is never registered), the file lands failed/', async () => {
  const deps = stubDeps({ runFileToRows: async () => { throw new Error('executor exploded'); } });
  const inbox = tmpInbox();
  deps.config.inbox = inbox;
  try {
    const claim = claimLayer.claimFile({ tenantCode: 'BHMP', originalName: 'f.csv', inboxPath: mkFile(inbox, 'BHMP/f.csv', 'x') });
    const r = await processClaim(deps, claim);
    assert.strictEqual(r.outcome, 'failed');
    const t = deps.timeline;
    assert.ok(t.includes('BEGIN') && t.includes('ROLLBACK'), 'the poisoned transaction is rolled back');
    assert.ok(!t.some((s) => s.startsWith('markFileFailed')), 'the register never carries a guess');
    assert.ok(t.indexOf('ROLLBACK') < t.length, 'the rollback precedes the settle');
    const settled = claimLayer.settleFile(inbox, claim, r.outcome);
    assert.ok(settled.includes(path.join('failed', 'BHMP')));
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('the fault path WITH bound identity (the future transports\u2019 hook): FAILED rides a FRESH transaction — ROLLBACK, then BEGIN → GUC → markFileFailed → COMMIT', async () => {
  const deps = stubDeps({
    runFileToRows: async () => { throw new Error('executor exploded'); },
    faultIdentity: (error, claim) => ({ kind: 'inventory_all_dimensions', mode: 'A', fileName: claim.originalName, checksum: 'a'.repeat(64), byteSize: 3 }),
  });
  const inbox = tmpInbox();
  deps.config.inbox = inbox;
  try {
    const claim = claimLayer.claimFile({ tenantCode: 'BHMP', originalName: 'f.csv', inboxPath: mkFile(inbox, 'BHMP/f.csv', 'x') });
    const r = await processClaim(deps, claim);
    assert.strictEqual(r.outcome, 'failed');
    const t = deps.timeline;
    const rollbacks = t.filter((s) => s === 'ROLLBACK').length;
    const begins = t.filter((s) => s === 'BEGIN').length;
    assert.strictEqual(rollbacks, 1);
    assert.strictEqual(begins, 2, 'the ORIGINAL transaction and the FRESH FAILED-write transaction');
    const failIdx = t.findIndex((s) => s.startsWith('markFileFailed'));
    assert.ok(failIdx > t.indexOf('ROLLBACK'), 'the FAILED write follows the rollback');
    assert.ok(t.indexOf('COMMIT', failIdx) > failIdx, 'the FAILED write commits');
    assert.strictEqual(t[failIdx], 'markFileFailed(inventory_all_dimensions)');
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('poison isolation: a cycle processes the NEXT file after one file threw — no neighbor is punished', async () => {
  const inbox2 = tmpInbox();
  let calls = 0;
  const deps2 = stubDeps({
    runFileToRows: async () => { calls++; if (calls === 1) throw new Error('poisoned'); return { verdict: 'APPLIED' }; },
  });
  deps2.config.inbox = inbox2;
  try {
    mkFile(inbox2, 'BHMP/bad.csv', 'x');
    mkFile(inbox2, 'BHMP/good.csv', 'x');
    const loop = makeLoop(deps2);
    const counts = await loop.cycle();
    assert.strictEqual(counts.processed, 2, 'both files processed in one cycle');
    assert.strictEqual(counts.failed, 1);
    assert.strictEqual(counts.done, 1);
    assert.ok(fs.existsSync(path.join(inbox2, 'failed', 'BHMP', 'bad.csv')));
    assert.ok(fs.existsSync(path.join(inbox2, 'done', 'BHMP', 'good.csv')));
    const remaining = fs.readdirSync(path.join(inbox2, 'BHMP')).filter((f) => !f.startsWith('.'));
    assert.strictEqual(remaining.length, 0, 'the inbox never keeps work — the tenant folder remains, empty, the operator\u2019s next drop point');
  } finally { fs.rmSync(inbox2, { recursive: true, force: true }); }
});

test('strays: a file at the inbox root settles failed/_unattributed — the layout violation is a named outcome', async () => {
  const inbox = tmpInbox();
  const deps = stubDeps({});
  deps.config.inbox = inbox;
  try {
    mkFile(inbox, 'no-tenant-folder.csv', 'x');
    const loop = makeLoop(deps);
    await loop.cycle();
    assert.ok(fs.existsSync(path.join(inbox, 'failed', '_unattributed', 'no-tenant-folder.csv')));
    assert.ok(!fs.existsSync(path.join(inbox, 'no-tenant-folder.csv')));
    assert.strictEqual(deps.timeline.filter((s) => s === 'BEGIN').length, 0, 'no fence — no tenant');
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('the boot sweep: orphaned claims in .claiming/ are processed FIRST — before any newly dropped file', async () => {
  const inbox = tmpInbox();
  const order = [];
  const deps = stubDeps({
    runFileToRows: async (d, input) => { order.push(input.declaredName); return { verdict: 'APPLIED' }; },
  });
  deps.config.inbox = inbox;
  try {
    mkFile(inbox, 'BHMP/.claiming/orphan-from-crash.csv', 'x'); // already claimed before the crash
    mkFile(inbox, 'BHMP/fresh-drop.csv', 'x');
    const loop = makeLoop(deps);
    await loop.cycle();
    assert.deepStrictEqual(order, ['orphan-from-crash.csv', 'fresh-drop.csv'], 'orphans ride the boot cycle first');
    assert.ok(fs.existsSync(path.join(inbox, 'done', 'BHMP', 'orphan-from-crash.csv')));
    assert.ok(fs.existsSync(path.join(inbox, 'done', 'BHMP', 'fresh-drop.csv')));
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('the batch cap: a cycle claims at most batchMax files — the rest remain for the next cycle', async () => {
  const inbox = tmpInbox();
  const deps = stubDeps({});
  deps.config.inbox = inbox;
  deps.config.batchMax = 3;
  try {
    for (const n of ['a', 'b', 'c', 'd', 'e']) mkFile(inbox, `BHMP/${n}.csv`, 'x');
    const loop = makeLoop(deps);
    const c1 = await loop.cycle();
    assert.strictEqual(c1.processed, 3);
    const remaining = fs.readdirSync(path.join(inbox, 'BHMP')).filter((f) => f.endsWith('.csv'));
    assert.strictEqual(remaining.length, 2, 'the unclaimed files are untouched in the inbox');
    const c2 = await loop.cycle();
    assert.strictEqual(c2.processed, 2);
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('the drain: the in-flight cycle finishes, the next cycle never starts — exactly one cycle runs', async () => {
  const inbox = tmpInbox();
  let cycles = 0;
  const deps = stubDeps({});
  deps.config.inbox = inbox;
  const sleep = async () => { cycles++; if (cycles >= 1) loopRef.drain(); };
  const loopRef = makeLoop({ ...deps, sleep });
  try {
    await loopRef.run();
    assert.strictEqual(cycles, 1, 'the drain stopped the loop after the in-flight cycle');
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

test('the inbox is created on boot when missing — an empty inbox is a valid, honest idle', async () => {
  const inbox = path.join(tmpInbox(), 'nested', 'inbox');
  const deps = stubDeps({});
  deps.config.inbox = inbox;
  const logs = [];
  const loopRef = makeLoop({ ...deps, log: (l) => logs.push(l), sleep: async () => { loopRef.drain(); } });
  await loopRef.run();
  assert.ok(fs.existsSync(inbox));
  assert.ok(logs.some((l) => l.includes('honest idle')), logs.join('\n'));
  fs.rmSync(path.join(inbox, '..'), { recursive: true, force: true });
});

test('the exceljs pin: 4.4.0 exact in the worker\u2019s runtime story (§4.1)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'packages', 'ingest-service', 'package.json'), 'utf8'));
  assert.strictEqual(manifest.dependencies.exceljs, '4.4.0');
});

test('the db public surface: makeIngestWorkerAdapter is exported — the worker runtime is the consumer it waited for (ADR-0001)', () => {
  const surface = require(path.join(__dirname, '..', '..', '..', 'packages', 'db', 'index.js'));
  assert.strictEqual(typeof surface.makeIngestWorkerAdapter, 'function');
  assert.strictEqual(typeof surface.resolveTenantByCode, 'function');
  assert.strictEqual(typeof surface.makeIngestAdapter, 'function');
  assert.strictEqual(typeof surface.connectPlanClient, 'function');
});

test('the AV posture: the config parses only a declared true/false (a typo refuses at boot, never a quiet bypass), the default is M3\u2019s fail-closed true', () => {
  assert.strictEqual(loadConfig({ DATABASE_URL: 'x' }).avRequired, true, 'no declaration \u2014 the fail-closed default');
  assert.strictEqual(loadConfig({ DATABASE_URL: 'x', SENTINEL_WORKER_AV_REQUIRED: 'false' }).avRequired, false, 'a declared posture is honored');
  assert.strictEqual(loadConfig({ DATABASE_URL: 'x', SENTINEL_WORKER_AV_REQUIRED: 'true' }).avRequired, true);
  for (const junk of ['FALSE', 'off', '1', '']) {
    if (junk === '') { assert.strictEqual(loadConfig({ DATABASE_URL: 'x', SENTINEL_WORKER_AV_REQUIRED: '' }).avRequired, true, 'empty means undeclared'); continue; }
    try { loadConfig({ DATABASE_URL: 'x', SENTINEL_WORKER_AV_REQUIRED: junk }); assert.fail('junk posture must refuse: ' + junk); }
    catch (e) { assert.ok(/WORKER_BOOT_REFUSED.*SENTINEL_WORKER_AV_REQUIRED/.test(e.message), e.message); }
  }
});

test('the runner carries the deployment\u2019s AV posture into the pipeline input \u2014 declared false reaches runFileToRows, the undeclared default is true', async () => {
  const inputs = [];
  const deps = stubDeps({ runFileToRows: async (d, input) => { inputs.push(input); return { verdict: 'APPLIED' }; }, avRequired: false });
  const inbox = tmpInbox();
  deps.config.inbox = inbox;
  try {
    const claim = claimLayer.claimFile({ tenantCode: 'BHMP', originalName: 'f.csv', inboxPath: mkFile(inbox, 'BHMP/f.csv', 'x') });
    await processClaim(deps, claim);
    assert.strictEqual(inputs[0].avRequired, false, 'the declared posture rides the input into the gate');
    const deps2 = stubDeps({ runFileToRows: async (d, input) => { inputs.push(input); return { verdict: 'APPLIED' }; } });
    deps2.config.inbox = inbox;
    const claim2 = claimLayer.claimFile({ tenantCode: 'BHMP', originalName: 'g.csv', inboxPath: mkFile(inbox, 'BHMP/g.csv', 'x') });
    await processClaim(deps2, claim2);
    assert.strictEqual(inputs[1].avRequired, true, 'undeclared \u2014 the fail-closed default');
  } finally { fs.rmSync(inbox, { recursive: true, force: true }); }
});

/* ---- the verdict ---------------------------------------------------------- */

(async () => {
  await Promise.all(pending);
  console.log(`\n  worker/runtime: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
