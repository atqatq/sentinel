'use strict';
/* ============================================================================
 * The §14.6g sweep writer (stub client) — the register MIRROR in the
 * plan-adapter, without a database. The LIVE proof (sweep-live.js) walks the
 * real mirror in CI; this suite pins the statement shapes, the idempotent
 * semantics and the statement-first refusals the live proof then re-proves:
 *   - resolve-then-insert, one direction: an OPEN row no longer desired
 *     RESOLVES (never deletes); a desired field with no OPEN row inserts;
 *     a desired field already open is NOT re-dated (NOT-ALL keeps it);
 *   - the empty desired set resolves EVERYTHING open in the family (the
 *     gap was fixed upstream);
 *   - statement-first refusals: a non-array, a foreign field, a bare field
 *     without detail, a non-WARN severity, a non-canonical asOf — ZERO
 *     statements for every refusal (the sweep does not gentrify other
 *     guards' tasks);
 *   - the receipt {inserted, resolved, open} is the REGISTER's count, read
 *     back from the table, never recomputed by the reader.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));
const OPS = require(path.join(REPO, 'packages', 'core', 'modules', 'ops'));

const T1 = '11111111-1111-4111-8111-111111111111';
const { unpromisedWaitingTasks } = OPS.datahealth;

/* The stub client: records statements; the register is an in-memory table
 * shaped like data_health_task (payload JSON with the field key). */
function stubClient({ rows = [] } = {}) {
  const calls = [];
  const state = rows.slice();
  return {
    calls,
    state,
    async query(text, values) {
      const norm = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: norm, values });
      if (/^UPDATE data_health_task SET status = 'RESOLVED'/.test(norm)) {
        const keep = values.length > 1 ? values[1] : [];
        let n = 0;
        for (const r of state) {
          if (r.status === 'OPEN' && r.payload.field.startsWith('unpromised-waiting.') && !keep.includes(r.payload.field)) {
            r.status = 'RESOLVED'; r.resolved_at = new Date(); n += 1;
          }
        }
        return { rowCount: n };
      }
      if (/^INSERT INTO data_health_task/.test(norm)) {
        /* the node-pg array contract, pinned here the way real pg consumes
         * it: the jsonb[] parameter is a JS array of JSON STRINGS (node-pg
         * serializes it into the Postgres array literal) — a pre-stringified
         * JSON document is the malformed-array-literal defect the live tier
         * caught on the sweep's first CI run */
        if (!Array.isArray(values[1])) throw new Error('SWEEP_PG_ARRAY_CONTRACT: the jsonb[] parameter must be a JS array, got a string');
        for (const p of values[1]) JSON.parse(p);
        const payloads = values[1].map((p) => JSON.parse(p));
        let n = 0;
        for (const p of payloads) {
          const exists = state.some((r) => r.status === 'OPEN' && r.payload.field === p.field);
          if (!exists) { state.push({ tenant_id: values[0], task_type: 'DATA_HEALTH', severity: 'WARN', status: 'OPEN', payload: p }); n += 1; }
        }
        return { rowCount: n };
      }
      if (/^SELECT count\(\*\)::int AS n FROM data_health_task/.test(norm)) {
        return { rows: [{ n: state.filter((r) => r.status === 'OPEN' && r.payload.field.startsWith('unpromised-waiting.')).length }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed += 1; }
};
const refuses = (code, fn) => {
  try { fn(); return `expected ${code}, nothing threw`; }
  catch (e) { return e.message.includes(code) ? null : `expected ${code}, got: ${e.message}`; }
};

const taskFor = (ref) => unpromisedWaitingTasks([
  { ref, supply: { status: 'OK', openPO: 3, unpromisedLines: 1, unpromisedWaiting: 9 } },
]).tasks[0];

(async () => {
  console.log('\nThe register mirror — insert / no-op / resolve (stub tier)');

  await (async () => {
    const c = stubClient();
    const saver = DB.makePlanAdapter(c, T1).saver;
    const out = await saver.syncUnpromisedWaitingTasks([taskFor('WB-CAKE-001')], { asOf: '2026-09-01' });
    assert.strictEqual(out.inserted, 1, 'a desired field with no OPEN row inserts');
    assert.strictEqual(out.resolved, 0);
    assert.strictEqual(out.open, 1, 'the open count is the REGISTER\'s, read back');
    const upd = c.calls.find((x) => x.text.startsWith("UPDATE data_health_task SET status = 'RESOLVED'"));
    const ins = c.calls.find((x) => x.text.startsWith('INSERT INTO data_health_task'));
    const cnt = c.calls.find((x) => x.text.startsWith('SELECT count(*)::int AS n FROM data_health_task'));
    assert.ok(upd && ins && cnt, 'resolve, insert, count — the mirror in its own statements');
    assert.ok(JSON.stringify(ins.values[1]).includes('raisedAsOf'), 'the payload carries the raising run\'s asOf');
    assert.ok(JSON.stringify(ins.values[1]).includes('unpromised-waiting.WB-CAKE-001'));
  })();
  passed += 0;
  console.log('  ✓ a fresh gap inserts (WARN, the asOf in the payload) and the receipt reads the register');

  await (async () => {
    const open = { status: 'OPEN', payload: { field: 'unpromised-waiting.WB-CAKE-001', detail: 'older' } };
    const c = stubClient({ rows: [open] });
    const saver = DB.makePlanAdapter(c, T1).saver;
    const out = await saver.syncUnpromisedWaitingTasks([taskFor('WB-CAKE-001')], { asOf: '2026-09-02' });
    assert.strictEqual(out.inserted, 0, 'the same gap is NOT re-raised');
    assert.strictEqual(out.open, 1);
    assert.strictEqual(c.state[0].payload.detail, 'older', 'the live row is not re-dated — the raising run stays on the payload');
    assert.strictEqual(c.state[0].status, 'OPEN');
  })();
  console.log('  ✓ an already-open gap is a NO-OP — not re-raised, not re-dated, not duplicated');

  await (async () => {
    const open = { status: 'OPEN', payload: { field: 'unpromised-waiting.WB-CAKE-001', detail: 'older' } };
    const c = stubClient({ rows: [open] });
    const saver = DB.makePlanAdapter(c, T1).saver;
    const out = await saver.syncUnpromisedWaitingTasks([taskFor('WB-TART-002')], { asOf: '2026-09-02' });
    assert.strictEqual(out.resolved, 1, 'the cleared gap RESOLVES');
    assert.strictEqual(out.inserted, 1);
    assert.strictEqual(c.state[0].status, 'RESOLVED', 'rows are never deleted — the audit trail is the resolution');
    assert.ok(c.state[0].resolved_at, 'resolved_at stamped');
    assert.strictEqual(out.open, 1, 'the register now holds the NEW gap only');
  })();
  console.log('  ✓ a gap no longer disclosed resolves (resolved_at stamped; the row stays)');

  await (async () => {
    const c = stubClient({ rows: [
      { status: 'OPEN', payload: { field: 'unpromised-waiting.WB-CAKE-001', detail: 'a' } },
      { status: 'OPEN', payload: { field: 'unpromised-waiting.WB-TART-002', detail: 'b' } },
    ] });
    const saver = DB.makePlanAdapter(c, T1).saver;
    const out = await saver.syncUnpromisedWaitingTasks([], { asOf: '2026-09-02' });
    assert.strictEqual(out.resolved, 2, 'an empty desired set resolves the whole family — the gaps were fixed upstream');
    assert.strictEqual(out.open, 0);
    assert.strictEqual(out.inserted, 0);
  })();
  console.log('  ✓ an empty desired set resolves everything open in the family');

  await (async () => {
    const c = stubClient();
    const saver = DB.makePlanAdapter(c, T1).saver;
    const cases = [
      ['TASKS_MALFORMED', () => saver.syncUnpromisedWaitingTasks('tasks')],
      ['TASK_MALFORMED', () => saver.syncUnpromisedWaitingTasks([{ nope: 1 }])],
      ['FIELD_FOREIGN', () => saver.syncUnpromisedWaitingTasks([{ type: 'DATA_HEALTH', field: 'freshness.open_pos', detail: 'x', severity: 'WARN' }])],
      ['FIELD_FOREIGN', () => saver.syncUnpromisedWaitingTasks([{ type: 'DATA_HEALTH', field: 'unpromised-other.X', detail: 'x', severity: 'WARN' }])],
      ['TASK_MALFORMED', () => saver.syncUnpromisedWaitingTasks([{ type: 'DATA_HEALTH', field: 'unpromised-waiting.X', detail: '', severity: 'WARN' }])],
      ['SEVERITY_INVALID', () => saver.syncUnpromisedWaitingTasks([{ type: 'DATA_HEALTH', field: 'unpromised-waiting.X', detail: 'x', severity: 'CRITICAL' }])],
      ['ASOF_INVALID', () => saver.syncUnpromisedWaitingTasks([], { asOf: '09/02/2026' })],
    ];
    for (const [code, fn] of cases) {
      try { await fn(); failed += 1; console.log(`  ✗ ${code}: nothing threw`); }
      catch (e) {
        if (String(e.message).includes(code)) passed += 1;
        else { failed += 1; console.log(`  ✗ ${code}: got ${e.message}`); }
      }
    }
    assert.strictEqual(c.calls.length, 0, 'ZERO statements for every refusal — statement-first');
  })();
  console.log('  ✓ statement-first refusals: shape, the field family, severity, the asOf canon — zero statements');

  console.log(`\nsweep-adapter (stub): ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
