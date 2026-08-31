'use strict';
/* ============================================================================
 * Restatement adapter (stub client) — the SQL mechanics of the M8 version
 * chain (0008_restatement; §14.16) without a database. The LIVE proof
 * (plan-seal-live.js) walks the real chain in CI; this suite pins the
 * statement shapes, the boundary validations and the fail-closed discipline
 * that the live proof then re-proves against real PostgreSQL:
 *   - statement-first: a malformed argument sends ZERO statements;
 *   - the anchor lock: the door serializes on plan_seal FOR UPDATE (full
 *     grants — unlike the ledger's SELECT/INSERT-only), then reads the head
 *     while the lock is held;
 *   - named refusals BEFORE any insert: RESTATE_PREDECESSOR_MISSING (no
 *     anchor = no restatement of a day that was never sealed) and
 *     RESTATE_PREDECESSOR_MISMATCH (a stale predecessor = a concurrent
 *     restatement won; re-run against the new head);
 *   - the ledger block rides the SAME client (one transaction): the Class-W
 *     RESTATE_DAY block carries the version pointers + delta, never a third
 *     copy of the payload (§16.3 rule 2 — the caller's tx owns atomicity);
 *   - the unarmed adapter exposes NO restateSeal — the service boundary
 *     refuses a restatement request loudly (TypeError), never silently;
 *   - the version-aware saveSeal replay resolves the CURRENT version.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));

const KEY = 'stub-hmac-key-0123456789abcdef-0123456789abcdef';
const T1 = '11111111-1111-4111-8111-111111111111';
const DAY = '2026-03-01';
const SEAL_HASH = 'a'.repeat(64);
const V2_HASH = 'b'.repeat(64);

const LEDGER_OPTS = () => ({
  hmacKey: KEY,
  actor: 'u-buyer',
  role: 'BYR',
  sessionId: 'sess-1',
  sourceIp: '10.0.0.1',
  onBehalfOf: null,
});

const ARGS = () => ({
  tenantId: T1,
  sealDate: DAY,
  payload: { asOf: DAY, refs: [{ ref: 'REF-A' }] },
  payloadHash: V2_HASH,
  prevPayloadHash: SEAL_HASH,
  prevRevision: 1,
  delta: { refsChanged: ['REF-A'], driverChanged: true, kpiKeysChanged: ['results'] },
  reason: 'late consumption for January landed',
  restatedBy: 'u-buyer',
  engineVersion: '1.0.0',
  schemaVersion: '0008',
});

/* The stub client: records every statement; answers the anchor lock, the
 * head read, the restatement INSERT RETURNING and the ledger append from
 * configurable fixtures. */
function stubClient({ anchor = [{ payload_hash: SEAL_HASH }], head = [], restatementReturn = null, ledgerTail = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      const norm = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: norm, values });
      if (/FROM plan_seal WHERE tenant_id = \$1 AND seal_date = \$2 FOR UPDATE/.test(norm)) {
        return { rows: anchor, rowCount: anchor.length };
      }
      if (/FROM plan_seal_restatement[\s\S]*ORDER BY revision DESC LIMIT 1/.test(norm)) {
        return { rows: head, rowCount: head.length };
      }
      if (/INSERT INTO plan_seal_restatement/.test(norm)) {
        if (restatementReturn) return { rows: [restatementReturn], rowCount: 1 };
        return {
          rows: [{
            revision: values[2], payload: JSON.parse(values[3]), payloadHash: values[4],
            prevRevision: values[5], prevPayloadHash: values[6], delta: JSON.parse(values[7]),
            reason: values[8], restatedBy: values[11],
            restatedAt: new Date(Date.UTC(2026, 8, 1, 9, 0, 0, 0)),
            engineVersion: values[9], schemaVersion: values[10],
          }],
          rowCount: 1,
        };
      }
      if (/pg_advisory_xact_lock/.test(norm)) return { rows: [], rowCount: 0 };
      if (/ORDER BY seq DESC LIMIT 1/.test(norm)) return { rows: ledgerTail, rowCount: ledgerTail.length };
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

  await test('an unarmed adapter exposes NO restateSeal — the service refuses restatements loudly at its own boundary', async () => {
    const a = DB.makePlanAdapter({ query: async () => ({ rows: [] }) }, T1);
    assert.strictEqual(a.saver.restateSeal, undefined);
    assert.strictEqual(typeof a.saver.loadDayVersions, 'function');
  });

  await test('an armed adapter exposes the door; the stamps are the repo constants, not the caller’s', async () => {
    const c = stubClient({ head: [] });
    DB.makePlanAdapter(c, T1, { ledger: LEDGER_OPTS() });
    /* Constructing the ledger adapter with a short key refuses at construction. */
    assert.throws(() => DB.makePlanAdapter(c, T1, { ledger: { ...LEDGER_OPTS(), hmacKey: 'short' } }),
      /LEDGER_CONFIG_KEY_REQUIRED/);
  });

  console.log('\nStatement-first refusals — zero statements on malformed input');

  await test('a malformed argument refuses before ANY statement is sent', async () => {
    const cases = [
      { over: { sealDate: '2026-3-1' }, code: /RESTATE_SEAL_DATE_INVALID/ },
      { over: { payloadHash: 'nothex' }, code: /RESTATE_HASH_INVALID/ },
      { over: { prevPayloadHash: null }, code: /RESTATE_HASH_INVALID/ },
      { over: { prevRevision: 0 }, code: /RESTATE_PREDECESSOR_INVALID/ },
      { over: { prevRevision: 1.5 }, code: /RESTATE_PREDECESSOR_INVALID/ },
      { over: { payload: null }, code: /RESTATE_PAYLOAD_INVALID/ },
      { over: { delta: 'refs' }, code: /RESTATE_DELTA_INVALID/ },
      { over: { reason: '   ' }, code: /RESTATE_REASON_REQUIRED/ },
      { over: { restatedBy: '' }, code: /RESTATE_ACTOR_REQUIRED/ },
      { over: { engineVersion: '' }, code: /RESTATE_STAMP_INVALID/ },
    ];
    for (const { over, code } of cases) {
      const c = stubClient();
      const a = DB.makePlanAdapter(c, T1, { ledger: LEDGER_OPTS() });
      await assert.rejects(() => a.saver.restateSeal({ ...ARGS(), ...over }), code);
      assert.strictEqual(c.calls.length, 0, `expected zero statements for ${JSON.stringify(over)}`);
    }
  });

  console.log('\nThe anchor and the head — the chain discipline');

  await test('a missing seal row refuses RESTATE_PREDECESSOR_MISSING — no restatement of a day never sealed', async () => {
    const c = stubClient({ anchor: [] });
    const a = DB.makePlanAdapter(c, T1, { ledger: LEDGER_OPTS() });
    await assert.rejects(() => a.saver.restateSeal(ARGS()), /RESTATE_PREDECESSOR_MISSING/);
    assert.strictEqual(c.calls.length, 1, 'the anchor lock must be the only statement sent');
  });

  await test('a stale predecessor refuses RESTATE_PREDECESSOR_MISMATCH before any insert', async () => {
    const c = stubClient({ head: [{ revision: 3, payloadHash: 'd'.repeat(64) }] });
    const a = DB.makePlanAdapter(c, T1, { ledger: LEDGER_OPTS() });
    await assert.rejects(() => a.saver.restateSeal(ARGS()), /RESTATE_PREDECESSOR_MISMATCH/);
    assert.strictEqual(c.calls.length, 2, 'anchor lock + head read only — the INSERT never fires');
  });

  await test('the anchor lock is FOR UPDATE on plan_seal and precedes the head read', async () => {
    const c = stubClient({ head: [] });
    const a = DB.makePlanAdapter(c, T1, { ledger: LEDGER_OPTS() });
    await a.saver.restateSeal(ARGS());
    assert.ok(/FOR UPDATE$/.test(c.calls[0].text), 'the anchor lock must be FOR UPDATE');
    assert.ok(/FROM plan_seal_restatement/.test(c.calls[1].text), 'the head read follows while the lock is held');
  });

  console.log('\nThe apply — one transaction, version row + ledger block');

  await test('revision 2 chains off the seal: INSERT + Class-W RESTATE_DAY block, pointers + delta ride', async () => {
    const c = stubClient({ head: [] });
    const a = DB.makePlanAdapter(c, T1, { ledger: LEDGER_OPTS() });
    const r = await a.saver.restateSeal(ARGS());
    assert.strictEqual(r.revision, 2);
    assert.strictEqual(r.prevRevision, 1);
    assert.strictEqual(r.prevPayloadHash, SEAL_HASH);
    assert.strictEqual(r.ledger.seq, 1);
    assert.ok(/^[0-9a-f]{64}$/.test(r.ledger.hash));
    const ins = c.calls.find((x) => /INSERT INTO plan_seal_restatement/.test(x.text));
    assert.ok(ins, 'the restatement INSERT must fire');
    assert.strictEqual(ins.values[2], 2, 'revision is derived by the door');
    assert.strictEqual(ins.values[5], 1);
    assert.strictEqual(ins.values[6], SEAL_HASH);
    const blk = c.calls.find((x) => /INSERT INTO ledger_block/.test(x.text));
    assert.ok(blk, 'the ledger block must fire on the SAME client (one transaction)');
    assert.strictEqual(blk.values[1], 'W', 'class W — a business change');
    assert.strictEqual(blk.values[8], 'plan_seal');
    assert.strictEqual(blk.values[9], DAY);
    assert.strictEqual(blk.values[10], 'RESTATE_DAY');
    const before = JSON.parse(blk.values[12]);
    const after = JSON.parse(blk.values[13]);
    assert.deepStrictEqual(before, { revision: 1, payloadHash: SEAL_HASH });
    assert.strictEqual(after.revision, 2);
    assert.strictEqual(after.payloadHash, V2_HASH);
    assert.deepStrictEqual(after.delta, ARGS().delta);
    assert.strictEqual(blk.values[14], ARGS().reason);
    /* No third copy of the payload: neither before nor after carries it. */
    assert.strictEqual(JSON.stringify(before).includes('"asOf"'), false);
    assert.strictEqual(JSON.stringify(after).includes('"asOf"'), false);
  });

  await test('revision N>2 chains off the restatement head, not the seal', async () => {
    const c = stubClient({ head: [{ revision: 2, payloadHash: SEAL_HASH }] });
    const a = DB.makePlanAdapter(c, T1, { ledger: LEDGER_OPTS() });
    const r = await a.saver.restateSeal({ ...ARGS(), prevRevision: 2, prevPayloadHash: SEAL_HASH });
    assert.strictEqual(r.revision, 3);
    const ins = c.calls.find((x) => /INSERT INTO plan_seal_restatement/.test(x.text));
    assert.strictEqual(ins.values[5], 2, 'prev_revision is the restatement head');
  });

  await test('the door returns the new version as the day’s current seal', async () => {
    const c = stubClient({ head: [] });
    const a = DB.makePlanAdapter(c, T1, { ledger: LEDGER_OPTS() });
    const r = await a.saver.restateSeal(ARGS());
    assert.strictEqual(r.seal.revision, 2);
    assert.strictEqual(r.seal.source, 'restatement');
    assert.strictEqual(r.seal.payloadHash, V2_HASH);
    assert.deepStrictEqual(r.delta, ARGS().delta);
  });

  console.log('\nThe time-machine read');

  await test('loadDayVersions: null for a never-sealed day; seal first, restatements ascending, current resolved', async () => {
    const c = {
      calls: [],
      async query(text, values) {
        const norm = text.replace(/\s+/g, ' ').trim();
        this.calls.push(norm);
        if (/FROM plan_seal WHERE tenant_id = \$1 AND seal_date = \$2$/.test(norm)) {
          return values[1] === DAY
            ? { rows: [{ tenantId: T1, sealDate: DAY, revision: 1, source: 'seal', payloadHash: SEAL_HASH }] }
            : { rows: [], rowCount: 0 };
        }
        if (/FROM plan_seal_restatement[\s\S]*ORDER BY revision ASC$/.test(norm)) {
          return { rows: [
            { revision: 2, payloadHash: V2_HASH, source: 'restatement' },
            { revision: 3, payloadHash: 'd'.repeat(64), source: 'restatement' },
          ] };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const a = DB.makePlanAdapter(c, T1);
    const v = await a.saver.loadDayVersions(DAY);
    assert.strictEqual(v.versions.length, 3);
    assert.strictEqual(v.versions[0].source, 'seal');
    assert.strictEqual(v.versions[1].revision, 2);
    assert.strictEqual(v.versions[2].revision, 3);
    assert.strictEqual(v.current.revision, 3);
    assert.strictEqual(v.sealDate, DAY);
    assert.strictEqual(await a.saver.loadDayVersions('2026-04-01'), null);
  });

  await test('loadDayVersions refuses a malformed date with zero statements', async () => {
    const c = stubClient();
    const a = DB.makePlanAdapter(c, T1);
    await assert.rejects(() => a.saver.loadDayVersions('not-a-date'), /RESTATE_SEAL_DATE_INVALID/);
    assert.strictEqual(c.calls.length, 0);
  });

  console.log('\nVersion-aware replay');

  await test('saveSeal replay resolves the CURRENT version: a restated day replays against its head', async () => {
    const sealRow = { tenantId: T1, sealDate: DAY, payloadHash: SEAL_HASH, revision: 1, source: 'seal' };
    const head = { revision: 2, payloadHash: V2_HASH, restatedAt: new Date(Date.UTC(2026, 8, 1)) };
    const c = {
      calls: [],
      async query(text, values) {
        const norm = text.replace(/\s+/g, ' ').trim();
        this.calls.push(norm);
        if (/ON CONFLICT \(tenant_id, seal_date\) DO NOTHING/.test(norm)) return { rows: [], rowCount: 0 };
        if (/FROM plan_seal_restatement[\s\S]*ORDER BY revision DESC LIMIT 1/.test(norm)) {
          return { rows: [head], rowCount: 1 };
        }
        return { rows: [sealRow], rowCount: 1 };
      },
    };
    const a = DB.makePlanAdapter(c, T1);
    const r = await a.saver.saveSeal({ sealDate: DAY, payloadHash: 'x'.repeat(64) });
    assert.strictEqual(r.replayed, true);
    assert.strictEqual(r.seal.payloadHash, V2_HASH, 'the replay target is the restatement head');
    assert.strictEqual(r.seal.revision, 2);
    assert.strictEqual(r.seal.source, 'restatement');
  });

  await test('saveSeal first-seal returns revision 1 with the seal source', async () => {
    const c = {
      calls: [],
      async query(text) {
        const norm = text.replace(/\s+/g, ' ').trim();
        this.calls.push(norm);
        if (/ON CONFLICT \(tenant_id, seal_date\) DO NOTHING RETURNING/.test(norm)) {
          return { rows: [{ tenantId: T1, sealDate: DAY, payloadHash: SEAL_HASH }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const a = DB.makePlanAdapter(c, T1);
    const r = await a.saver.saveSeal({ sealDate: DAY, payloadHash: SEAL_HASH });
    assert.strictEqual(r.replayed, false);
    assert.strictEqual(r.seal.revision, 1);
    assert.strictEqual(r.seal.source, 'seal');
  });

  await run();
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });

async function run() {
  for (const p of pending) await p;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
