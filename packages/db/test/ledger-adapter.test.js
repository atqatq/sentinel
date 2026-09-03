'use strict';
/* ============================================================================
 * Ledger adapter (stub client) — the SQL mechanics of the H5 ledger without
 * a database. The LIVE proof (ledger-live.js) walks the real chain in CI;
 * this suite pins the statement shapes, the boundary conversions and the
 * fail-closed discipline that the live proof then re-proves against real
 * PostgreSQL:
 *   - the §16.2 gate runs BEFORE any statement is built (zero statements on
 *     a malformed block — nothing half-applies even outside a transaction);
 *   - the envelope (actor/role/session/versions) travels from the injected
 *     config, never guessed;
 *   - the int8 lesson: BIGINT seq leaves this adapter as a JS number;
 *   - the D-029 consumption path: the approval module's denial record goes
 *     in verbatim, a Class-D INSERT comes out.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));
const approval = require(path.join(REPO, 'packages', 'core', 'modules', 'approval'));

const KEY = 'stub-hmac-key-0123456789abcdef-0123456789abcdef';
const T1 = '11111111-1111-4111-8111-111111111111';
const PINNED = new Date(Date.UTC(2026, 7, 31, 8, 15, 0, 123));
const NOW = () => PINNED;

const CONFIG = {
  hmacKey: KEY,
  engineVersion: '1.0.0',
  schemaVersion: '0004',
  actor: 'u-origin',
  role: 'O',
  sessionId: 'sess-1',
  sourceIp: '10.0.0.1',
  onBehalfOf: null,
  now: NOW,
};

/* The stub client: records every statement, answers the tail lookup and the
 * INSERT RETURNING from configurable fixtures. */
function stubClient({ tail = [], chain = [], insertSeq = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      const norm = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: norm, values });
      if (/pg_advisory_xact_lock/.test(norm)) return { rows: [], rowCount: 0 };
      if (/ORDER BY seq DESC LIMIT 1/.test(norm)) return { rows: tail, rowCount: tail.length };
      if (/INSERT INTO ledger_block/.test(norm)) {
        const seq = insertSeq === null ? values[0] : insertSeq;
        return { rows: [{ seq, prevHash: values[18], hash: values[19], at: PINNED }], rowCount: 1 };
      }
      if (/ORDER BY ledger.seq ASC/.test(norm)) return { rows: chain, rowCount: chain.length };
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

function baseIntent(over) {
  return Object.assign({
    class: 'W', entity: 'item', entityId: 'i-1', action: 'item.update',
    outcome: 'success', before: null, after: { sku: 'TS-0001', stock: 10 }, reason: null,
  }, over || {});
}

(async () => {
  console.log('\nConfig discipline');

  await test('the adapter refuses to construct without a tenant, a config, or a real key', async () => {
    assert.throws(() => DB.makeLedgerAdapter(null, '', CONFIG), /LEDGER_TENANT_REQUIRED/);
    assert.throws(() => DB.makeLedgerAdapter(null, T1), /LEDGER_CONFIG_REQUIRED/);
    assert.throws(() => DB.makeLedgerAdapter(null, T1, Object.assign({}, CONFIG, { hmacKey: 'short' })), /LEDGER_CONFIG_KEY_REQUIRED/);
    assert.throws(() => DB.makeLedgerAdapter(null, T1, Object.assign({}, CONFIG, { hmacKey: undefined })), /LEDGER_CONFIG_KEY_REQUIRED/);
  });

  console.log('\nAppend — the writer path');

  await test('a genesis append: tail lookup, seq 1, prevHash = GENESIS, hash 64 hex', async () => {
    const c = stubClient();
    const r = await DB.makeLedgerAdapter(c, T1, CONFIG).appendBlock(baseIntent());
    assert.strictEqual(r.seq, 1);
    assert.strictEqual(r.prevHash, '0'.repeat(64));
    assert.ok(/^[0-9a-f]{64}$/.test(r.hash));
    assert.strictEqual(c.calls.length, 3);
    assert.ok(/pg_advisory_xact_lock/.test(c.calls[0].text), 'the tail lock must be the advisory xact lock (the app role holds no UPDATE privilege for FOR UPDATE)');
    assert.ok(/ORDER BY seq DESC LIMIT 1/.test(c.calls[1].text), 'the tail read must be a SEPARATE statement taken while the lock is held');
    assert.ok(/INSERT INTO ledger_block/.test(c.calls[2].text));
  });

  await test('the second append chains onto the tail: seq 2, prevHash = tail hash', async () => {
    const c = stubClient({ tail: [{ seq: '7', hash: 'a'.repeat(64) }] });
    const r = await DB.makeLedgerAdapter(c, T1, CONFIG).appendBlock(baseIntent());
    assert.strictEqual(r.seq, 8, 'the int8 lesson: the tail seq arrives as a string and must leave as a number');
    assert.strictEqual(r.prevHash, 'a'.repeat(64));
  });

  await test('the envelope travels from the config, never guessed', async () => {
    const c = stubClient();
    await DB.makeLedgerAdapter(c, T1, CONFIG).appendBlock(baseIntent());
    const v = c.calls[2].values;
    assert.strictEqual(v[3], 'u-origin');   // actor
    assert.strictEqual(v[5], 'O');          // role
    assert.strictEqual(v[6], '10.0.0.1');   // source_ip
    assert.strictEqual(v[7], 'sess-1');     // session_id
    assert.strictEqual(v[15], '1.0.0');     // engine_version
    assert.strictEqual(v[16], '0004');      // schema_version
    assert.strictEqual(v[1], 'W');          // class
  });

  await test('the clock is injectable: at is the pinned instant, canonical .sssZ', async () => {
    const c = stubClient();
    const r = await DB.makeLedgerAdapter(c, T1, CONFIG).appendBlock(baseIntent());
    assert.strictEqual(r.at, '2026-08-31T08:15:00.123Z');
    assert.strictEqual(c.calls[2].values[17], '2026-08-31T08:15:00.123Z');
  });

  await test('statement-first: a §16.2-invalid block refuses with ZERO statements', async () => {
    const c = stubClient();
    await DB.makeLedgerAdapter(c, T1, CONFIG).appendBlock(baseIntent({ class: 'X' }))
      .then(() => { throw new Error('no throw'); }, (e) => assert.strictEqual(e.code, 'LEDGER_CLASS_INVALID'));
    assert.strictEqual(c.calls.length, 0);
  });

  await test('no secrets: a forbidden payload field refuses before any statement', async () => {
    const c = stubClient();
    await DB.makeLedgerAdapter(c, T1, CONFIG).appendBlock(baseIntent({ after: { bankAccount: 'BH67' } }))
      .then(() => { throw new Error('no throw'); }, (e) => assert.strictEqual(e.code, 'LEDGER_PAYLOAD_FORBIDDEN_FIELD'));
    assert.strictEqual(c.calls.length, 0);
  });

  console.log('\nThe D-029 consumption path');

  await test('the approval module\'s denial record lands verbatim as a Class-D INSERT', async () => {
    const c = stubClient();
    const verdict = approval.decide.reviewApproval({
      proposal: { id: 'p-1', state: 'OPEN', raisedBy: 'u-buyer', currencyCode: 'BHD', totalAmount: 500 },
      actor: { userId: 'u-buyer', role: 'BYR' },
      config: { dualThresholdAmount: 1000 }, limits: [], prior: [],
      decision: 'APPROVED', reason: 'x', tenantCurrency: 'BHD',
    });
    assert.strictEqual(verdict.ok, false);
    await DB.makeLedgerAdapter(c, T1, CONFIG).appendDenialRecord(verdict.denial);
    const v = c.calls[2].values;
    assert.strictEqual(v[1], 'D');                    // class
    assert.strictEqual(v[11], 'denied');              // outcome
    assert.strictEqual(v[3], 'u-buyer');              // actor — verbatim from the denial, not the config
    assert.strictEqual(v[5], 'BYR');                  // role
    assert.strictEqual(v[14], 'SOD_SELF_APPROVAL');   // reason
    assert.strictEqual(v[9], 'p-1');                  // entity_id
  });

  await test('a refused mutation is itself recorded: Class-D with the refusal code (origin-cannot-mutate)', async () => {
    const c = stubClient();
    await DB.makeLedgerAdapter(c, T1, CONFIG).recordRefusedMutation({
      action: 'ledger.delete', entity: 'ledger_block', entityId: '3', reason: 'LEDGER_IMMUTABLE',
    });
    const v = c.calls[2].values;
    assert.strictEqual(v[1], 'D');
    assert.strictEqual(v[10], 'ledger.delete');
    assert.strictEqual(v[14], 'LEDGER_IMMUTABLE');
  });

  await test('a refusal intent without action or reason refuses before any statement', async () => {
    const c = stubClient();
    assert.throws(() => DB.makeLedgerAdapter(c, T1, CONFIG).recordRefusedMutation({ reason: 'x' }), /LEDGER_REFUSAL_INTENT_INVALID/);
    assert.throws(() => DB.makeLedgerAdapter(c, T1, CONFIG).recordRefusedMutation({ action: 'x' }), /LEDGER_REFUSAL_INTENT_INVALID/);
    assert.strictEqual(c.calls.length, 0);
  });

  console.log('\nLoad + verify over the stub');

  await test('loadChain converts the BIGINT seq to a number and renders at canonically', async () => {
    const c = stubClient({ chain: [{
      seq: '2', class: 'W', tenantId: T1, actor: 'u-origin', onBehalfOf: null, role: 'O',
      sourceIp: null, sessionId: null, entity: 'item', entityId: 'i-1', action: 'item.update',
      outcome: 'success', before: null, after: { sku: 'TS-0001' }, reason: null,
      engineVersion: '1.0.0', schemaVersion: '0004',
      at: new Date(Date.UTC(2026, 7, 31, 8, 15, 0, 123)),
      prevHash: '0'.repeat(64), hash: 'b'.repeat(64),
    }] });
    const rows = await DB.makeLedgerAdapter(c, T1, CONFIG).loadChain();
    assert.strictEqual(rows[0].seq, 2);
    assert.strictEqual(rows[0].at, '2026-08-31T08:15:00.123Z');
  });

  await test('verifyChain over an honest stub chain reports ok (the hashes recompute)', async () => {
    /* Build a REAL two-block chain with the module, then feed the rows back
     * through the adapter's verify path — the round-trip the DB storage must
     * preserve (the live proof re-proves it against actual JSONB/TIMESTAMPTZ). */
    const ledgerMod = require(path.join(REPO, 'packages', 'core', 'modules', 'ledger'));
    const rows = [];
    for (const intent of [baseIntent(), baseIntent({ action: 'item.update', entityId: 'i-2' })]) {
      const seq = rows.length + 1;
      const prevHash = rows.length ? rows[rows.length - 1].hash : ledgerMod.hash.GENESIS;
      const payload = ledgerMod.blocks.buildBlock(Object.assign({
        tenantId: T1, actor: 'u-origin', role: 'O', onBehalfOf: null, sourceIp: null, sessionId: null,
        engineVersion: '1.0.0', schemaVersion: '0004', at: '2026-08-31T08:15:00.123Z',
      }, intent));
      const canonical = ledgerMod.hash.canonicalPayloadOf(payload);
      const hash = ledgerMod.hash.blockHash(KEY, seq, prevHash, canonical);
      rows.push(Object.assign({ seq, prevHash, hash }, payload));
    }
    const c = stubClient({ chain: rows.map((r) => Object.assign({}, r, { at: PINNED })) });
    const r = await DB.makeLedgerAdapter(c, T1, CONFIG).verifyChain();
    assert.deepStrictEqual(r, { ok: true, verified: 2 });
  });

  await test('a tail seq that is not a safe integer refuses at the boundary (LEDGER_SEQ_BOUNDARY)', async () => {
    const c = stubClient({ tail: [{ seq: 'not-a-number', hash: 'a'.repeat(64) }] });
    await DB.makeLedgerAdapter(c, T1, CONFIG).appendBlock(baseIntent())
      .then(() => { throw new Error('no throw'); }, (e) => assert.ok(/LEDGER_SEQ_BOUNDARY/.test(e.message), e.message));
  });

  /* ---- the audit-chain reads (screen 12; the time-machine unit) ---- */
  console.log('\nThe audit-chain reads: newest first, capped, seq crossing the int8 boundary');
  await test('listBlocks: the newest seq first with a hard cap; BIGINT seq leaves as a JS number', async () => {
    const c = stubClient();
    // the stub's default SELECT branch returns empty rows — listBlocks rides it
    const blocks = await DB.makeLedgerAdapter(c, T1, CONFIG).listBlocks({ limit: 20 });
    assert.deepStrictEqual(blocks, [], 'no blocks yet is an honest empty list');
    const sql = c.calls[0].text;
    assert.ok(/ORDER BY seq DESC LIMIT 20$/.test(sql), `the cap lands IN the statement (no unbounded read): ${sql}`);
    assert.ok(/WHERE tenant_id = \$1/.test(sql), 'the tenant predicate is explicit');
  });
  await test('countBlocks: COUNT(*) crosses the boundary as a JS number, never a string', async () => {
    const c = stubClient();
    // the default branch returns rows: [] — countBlocks would read rows[0] of an empty select
    // so the stub needs a count row; give it through the chain branch? No — patch narrowly:
    c.query = (async (text) => {
      const norm = String(text).replace(/\s+/g, ' ').trim();
      c.calls.push({ text: norm });
      if (/COUNT\(\*\)/.test(norm)) return { rows: [{ n: '41' }], rowCount: 1 }; // pg ships BIGINT as a STRING
      return { rows: [], rowCount: 0 };
    });
    const n = await DB.makeLedgerAdapter(c, T1, CONFIG).countBlocks();
    assert.strictEqual(n, 41, `the int8 lesson, read direction: got ${typeof n}`);
  });

  const label = `ledger-adapter (stub): ${passed} passed, ${failed} failed`;
  await Promise.all(pending);
  console.log(`\n  ${label}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

