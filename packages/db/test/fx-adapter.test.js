'use strict';
/* ============================================================================
 * FX adapter (stub client) — the SQL mechanics of the M10 pin door (0009 +
 * fx-adapter.js; §14.17, ADR-0003) without a database. The LIVE proof
 * (ingest-replay-live.js) walks the real door in CI; this suite pins the
 * statement shapes, the boundary validations and the fail-closed discipline
 * that the live proof then re-proves against real PostgreSQL:
 *   - statement-first: a malformed argument sends ZERO statements;
 *   - idempotent, logged, retry-safe (the §8 jobs posture): the SAME rate
 *     re-pinned for a pinned day is a NO-OP success (no INSERT, no block);
 *     a DIFFERENT rate refuses RATE_DAY_CONFLICT — a correction goes
 *     through correctRate, never an overwrite;
 *   - the correction act: reason + operator REQUIRED (named refusals), the
 *     UPDATE carries the before/after, correcting to the SAME rate is a
 *     no-op (alreadyEqual), correcting an unpinned day refuses
 *     RATE_NOT_PINNED (pin it, never correct what does not exist);
 *   - the Class-S blocks ride the SAME client (one transaction): FX_PIN
 *     carries after{day,rate} + the trigger/job id in reason; FX_CORRECT
 *     carries the before{rate}/after{rate} diff and the operator rides
 *     onBehalfOf (§16.1 Class S — actor 'system', the human attribution
 *     never lost); a manual pin without an operator refuses;
 *   - the readers shape the fail-safe's raw material: exact day, latest ≤
 *     day, DECIMAL round-tripped through Number (the int8 lesson);
 *   - the unarmed adapter exposes NO pinRate/correctRate — the deployment
 *     refuses loudly (TypeError), never silently unlogged (an unlogged
 *     machine write is §16.1's blind spot).
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));

const KEY = 'stub-hmac-key-0123456789abcdef-0123456789abcdef';
const T1 = '11111111-1111-4111-8111-111111111111';
const DAY = '2026-08-30';
const BY = '22222222-2222-4222-8222-222222222222'; // the operator's Sentinel user id — on_behalf_of is UUID-typed (0004)

/* The stub client: records every statement; answers the pin SELECT, the
 * INSERT/UPDATE and the ledger append from configurable fixtures. */
function stubClient({ existing = [], insertOk = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      const norm = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: norm, values });
      if (/SELECT usd_to_local FROM fx_rate_pin WHERE tenant_id = \$1 AND day = \$2$/.test(norm)) {
        return { rows: existing, rowCount: existing.length };
      }
      if (/SELECT day::text AS day, usd_to_local FROM fx_rate_pin/.test(norm)) {
        return { rows: existing, rowCount: existing.length };
      }
      if (/INSERT INTO fx_rate_pin/.test(norm)) {
        if (!insertOk) throw new Error('stub insert refused');
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE fx_rate_pin SET/.test(norm)) return { rows: [], rowCount: 1 };
      if (/pg_advisory_xact_lock/.test(norm)) return { rows: [], rowCount: 0 };
      if (/ORDER BY seq DESC LIMIT 1/.test(norm)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO ledger_block/.test(norm)) {
        return { rows: [{ seq: values[0], prevHash: values[18], hash: 'c'.repeat(64), at: new Date(Date.UTC(2026, 8, 1, 9, 0, 0, 0)) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const pending = [];
function test(name, fn) {
  const p = (async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  })();
  pending.push(p);
}

let passed = 0, failed = 0;

(async () => {
  console.log('\nThe door is either armed or absent');

  await test('an unarmed adapter exposes NO pinRate/correctRate — a machine write is either logged or refused loudly, never silently unlogged', async () => {
    const a = DB.makeFxAdapter({ query: async () => ({ rows: [] }) }, T1);
    assert.strictEqual(a.pinRate, undefined);
    assert.strictEqual(a.correctRate, undefined);
    assert.strictEqual(typeof a.loadPinForDay, 'function');
    assert.strictEqual(typeof a.loadLatestPinAtOrBefore, 'function');
  });

  await test('an armed adapter exposes the doors; a short HMAC key refuses at construction', async () => {
    const c = stubClient();
    const a = DB.makeFxAdapter(c, T1, { ledger: { hmacKey: KEY } });
    assert.strictEqual(typeof a.pinRate, 'function');
    assert.strictEqual(typeof a.correctRate, 'function');
    assert.throws(() => DB.makeFxAdapter(c, T1, { ledger: { hmacKey: 'short' } }), /LEDGER_CONFIG_KEY_REQUIRED/);
  });

  console.log('\nStatement-first refusals — zero statements on malformed input');

  await test('a malformed argument refuses before ANY statement is sent', async () => {
    const cases = [
      { fn: 'pinRate', args: ['2026-8-30', 0.376, {}], code: /RATE_DAY_INVALID/ },
      { fn: 'pinRate', args: [DAY, 0, {}], code: /RATE_INVALID/ },
      { fn: 'pinRate', args: [DAY, -1, {}], code: /RATE_INVALID/ },
      { fn: 'pinRate', args: [DAY, '0.376', {}], code: /RATE_INVALID/ },   // a string where a rate belongs — the wiring disease
      { fn: 'pinRate', args: [DAY, 0.376, { trigger: 'teleport' }], code: /RATE_TRIGGER_INVALID/ },
      { fn: 'pinRate', args: [DAY, 0.376, { trigger: 'manual' }], code: /RATE_PINNER_REQUIRED/ },
      { fn: 'pinRate', args: [DAY, 0.376, { trigger: 'manual', by: 'not-a-uuid' }], code: /RATE_PINNER_INVALID/ },
      { fn: 'correctRate', args: [DAY, 0.377, { by: '', reason: 'x' }], code: /RATE_CORRECTION_ACTOR_REQUIRED/ },
      { fn: 'correctRate', args: [DAY, 0.377, { by: BY }], code: /RATE_CORRECTION_REASON_REQUIRED/ },
      { fn: 'correctRate', args: [DAY, 0.377, { by: 'u-treasury', reason: 'x' }], code: /RATE_CORRECTION_ACTOR_INVALID/ },
      { fn: 'correctRate', args: ['bad-day', 0.377, { by: 'u-buyer', reason: 'x' }], code: /RATE_DAY_INVALID/ },
    ];
    for (const { fn, args, code } of cases) {
      const c = stubClient({ existing: [] });
      const a = DB.makeFxAdapter(c, T1, { ledger: { hmacKey: KEY } });
      await assert.rejects(() => a[fn](...args), code);
      assert.strictEqual(c.calls.length, 0, `${fn}(${args.join(', ')}) sent ${c.calls.length} statements`);
    }
  });

  console.log('\npinRate — idempotent, logged, retry-safe');

  await test('a fresh pin INSERTs and appends ONE Class-S FX_PIN block in the SAME client (one transaction)', async () => {
    const c = stubClient({ existing: [] });
    const a = DB.makeFxAdapter(c, T1, { ledger: { hmacKey: KEY } });
    const r = await a.pinRate(DAY, 0.376, { trigger: 'schedule', jobId: 'fx-pin-24h' });
    assert.strictEqual(r.pinned, true);
    assert.strictEqual(r.alreadyPinned, false);
    assert.ok(r.ledger.seq >= 1);
    const insert = c.calls.find((x) => /INSERT INTO fx_rate_pin/.test(x.text));
    assert.ok(insert, 'the pin INSERT ran');
    assert.deepStrictEqual(insert.values, [T1, DAY, 0.376, 'schedule']);
    const block = c.calls.find((x) => /INSERT INTO ledger_block/.test(x.text));
    assert.ok(block, 'the ledger block ran on the same client');
    assert.strictEqual(block.values[1], 'S');            // class
    assert.strictEqual(block.values[8], 'fx_rate_pin');  // entity
    assert.strictEqual(block.values[10], 'FX_PIN');      // action
    assert.strictEqual(block.values[9], DAY);            // entityId
    assert.strictEqual(block.values[14], 'trigger=schedule job=fx-pin-24h'); // reason names trigger + job id
    assert.strictEqual(block.values[3], 'system');       // actor
    assert.strictEqual(block.values[5], null);           // role — actor 'system' may leave it null
  });
  await test('a manual pin rides onBehalfOf (the operator USER UUID — the ledger DDL is uuid-typed) and pins pinned_by with the operator id', async () => {
    const c = stubClient({ existing: [] });
    const a = DB.makeFxAdapter(c, T1, { ledger: { hmacKey: KEY } });
    await a.pinRate(DAY, 0.376, { trigger: 'manual', by: BY });
    const insert = c.calls.find((x) => /INSERT INTO fx_rate_pin/.test(x.text));
    assert.strictEqual(insert.values[3], BY);
    const block = c.calls.find((x) => /INSERT INTO ledger_block/.test(x.text));
    assert.strictEqual(block.values[4], BY);            // onBehalfOf
    assert.strictEqual(block.values[14], 'trigger=manual');
  });
  await test('the SAME rate re-pinned for a pinned day is a NO-OP success — a retried job is not an error, nothing is written', async () => {
    const c = stubClient({ existing: [{ usd_to_local: '0.37600000' }] });
    const a = DB.makeFxAdapter(c, T1, { ledger: { hmacKey: KEY } });
    const r = await a.pinRate(DAY, 0.376, { trigger: 'schedule' });
    assert.strictEqual(r.pinned, false);
    assert.strictEqual(r.alreadyPinned, true);
    assert.strictEqual(r.ledger, undefined);
    assert.ok(!c.calls.some((x) => /INSERT INTO fx_rate_pin/.test(x.text)), 'no INSERT ran');
    assert.ok(!c.calls.some((x) => /INSERT INTO ledger_block/.test(x.text)), 'no block ran — the ledger logs changes, not non-events');
  });
  await test('a DIFFERENT rate for a pinned day refuses RATE_DAY_CONFLICT — corrections go through the door, never an overwrite', async () => {
    const c = stubClient({ existing: [{ usd_to_local: '0.37600000' }] });
    const a = DB.makeFxAdapter(c, T1, { ledger: { hmacKey: KEY } });
    await assert.rejects(() => a.pinRate(DAY, 0.377, { trigger: 'schedule' }), /RATE_DAY_CONFLICT/);
    assert.ok(!c.calls.some((x) => /INSERT INTO/.test(x.text)));
  });

  console.log('\ncorrectRate — the explicit act');

  await test('a correction UPDATEs with the diff and appends ONE Class-S FX_CORRECT block carrying before/after + the operator', async () => {
    const c = stubClient({ existing: [{ usd_to_local: '0.37600000' }] });
    const a = DB.makeFxAdapter(c, T1, { ledger: { hmacKey: KEY } });
    const r = await a.correctRate(DAY, 0.377, { by: BY, reason: 'treasury revised the morning fix' });
    assert.strictEqual(r.corrected, true);
    assert.strictEqual(r.before, 0.376);
    assert.strictEqual(r.after, 0.377);
    const upd = c.calls.find((x) => /UPDATE fx_rate_pin SET/.test(x.text));
    assert.deepStrictEqual(upd.values, [T1, DAY, 0.377, BY]);
    const block = c.calls.find((x) => /INSERT INTO ledger_block/.test(x.text));
    assert.strictEqual(block.values[10], 'FX_CORRECT');
    assert.deepStrictEqual(JSON.parse(block.values[12]), { rate: 0.376 }); // before — a diff, never "updated"
    assert.deepStrictEqual(JSON.parse(block.values[13]), { rate: 0.377 }); // after
    assert.strictEqual(block.values[14], 'treasury revised the morning fix');
    assert.strictEqual(block.values[4], BY);
  });
  await test('correcting an unpinned day refuses RATE_NOT_PINNED — pin it, never correct what does not exist', async () => {
    const c = stubClient({ existing: [] });
    const a = DB.makeFxAdapter(c, T1, { ledger: { hmacKey: KEY } });
    await assert.rejects(() => a.correctRate(DAY, 0.377, { by: BY, reason: 'x' }), /RATE_NOT_PINNED/);
  });
  await test('correcting to the SAME rate is a no-op (alreadyEqual) — nothing is written', async () => {
    const c = stubClient({ existing: [{ usd_to_local: '0.37600000' }] });
    const a = DB.makeFxAdapter(c, T1, { ledger: { hmacKey: KEY } });
    const r = await a.correctRate(DAY, 0.376, { by: BY, reason: 'no-op check' });
    assert.strictEqual(r.corrected, false);
    assert.strictEqual(r.alreadyEqual, true);
    assert.ok(!c.calls.some((x) => /UPDATE fx_rate_pin/.test(x.text)));
    assert.ok(!c.calls.some((x) => /INSERT INTO ledger_block/.test(x.text)));
  });

  console.log('\nThe readers — the fail-safe\'s raw material');

  await test('loadPinForDay returns the exact pin with the DECIMAL round-tripped through Number', async () => {
    const c = stubClient({ existing: [{ day: DAY, usd_to_local: '0.37600000' }] });
    const a = DB.makeFxAdapter(c, T1);
    const r = await a.loadPinForDay(DAY);
    assert.deepStrictEqual(r, { day: DAY, rate: 0.376 });
    assert.strictEqual(typeof r.rate, 'number');   // the int8 lesson: node-pg ships NUMERIC as strings
  });
  await test('loadLatestPinAtOrBefore scopes day <= the requested day, newest first', async () => {
    const c = stubClient({ existing: [{ day: '2026-08-29', usd_to_local: '0.375' }] });
    const a = DB.makeFxAdapter(c, T1);
    const r = await a.loadLatestPinAtOrBefore('2026-08-31');
    assert.deepStrictEqual(r, { day: '2026-08-29', rate: 0.375 });
    const q = c.calls.find((x) => /usd_to_local FROM fx_rate_pin/.test(x.text));
    assert.ok(q.text.includes('day <= $2'));
    assert.ok(q.text.includes('ORDER BY day DESC LIMIT 1'));
  });
  await test('an absent pin reads as null — the money layer owns the RATE_NOT_PINNED refusal', async () => {
    const c = stubClient({ existing: [] });
    const a = DB.makeFxAdapter(c, T1);
    assert.strictEqual(await a.loadPinForDay(DAY), null);
    assert.strictEqual(await a.loadLatestPinAtOrBefore(DAY), null);
  });
  await test('the readers refuse a malformed day statement-first', async () => {
    const c = stubClient();
    const a = DB.makeFxAdapter(c, T1);
    await assert.rejects(() => a.loadPinForDay('2026-8-3'), /RATE_DAY_INVALID/);
    await assert.rejects(() => a.loadLatestPinAtOrBefore(20260830), /RATE_DAY_INVALID/);
    assert.strictEqual(c.calls.length, 0);
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
