'use strict';
/* ============================================================================
 * ledger suite — the H5 ledger decision layer (gate 11, M3).
 *
 * Zero dependencies, no clock, no I/O; the HMAC key is injected. The A6
 * named proofs are pinned by name:
 *   ledger/jcs-vectors       — RFC 8785 canonicalization against the
 *                              checksum-pinned fixture (expected forms stated
 *                              from the spec, never computed by the code);
 *   ledger/tamper-resistant  — any alteration of a payload, a hash, a link
 *                              or the sequence breaks the walk at the exact
 *                              block (the DB makes it impossible too — the
 *                              live proof walks the real chain);
 *   ledger/origin-cannot-mutate — proven at the database (0004_ledger grants
 *                              + RLS + triggers; ledger-live.js in CI); the
 *                              pure side here pins the Class-D attempt
 *                              record the refused mutation travels as.
 * The D-022 survival vectors prove the plan-service seal hashes survive the
 * JCS transition byte-for-byte — never assumed.
 * ==========================================================================*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..', '..', '..', '..', '..');
const L = require(path.join(__dirname, '..'));
const approval = require(path.join(__dirname, '..', '..', 'approval'));

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }

function expectCode(fn, code) {
  try { fn(); } catch (e) {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code || '(none)'}: ${e.message}`);
    return;
  }
  throw new Error(`expected ${code} but nothing threw`);
}

const KEY = 'live-and-unit-hmac-key-0123456789abcdef-0123456789abcdef';
const T1 = '11111111-1111-4111-8111-111111111111';
const jcs = (v) => L.jcs.canonicalizeJson(v);

/* The writer helper every chain test shares — the same three steps the
 * adapter performs: build (§16.2 gate) → canonicalize → keyed hash. */
function writeChain(rows, block) {
  const seq = rows.length + 1;
  const prevHash = rows.length ? rows[rows.length - 1].hash : L.hash.GENESIS;
  const payload = L.blocks.buildBlock(block);
  const canonical = L.hash.canonicalPayloadOf(payload);
  const hash = L.hash.blockHash(KEY, seq, prevHash, canonical);
  rows.push(Object.assign({ seq, prevHash, hash }, payload));
  return rows[rows.length - 1];
}
function baseBlock(over) {
  return Object.assign({
    class: 'W', tenantId: T1, actor: 'u-origin', role: 'O', onBehalfOf: null,
    sourceIp: null, sessionId: null, entity: 'item', entityId: 'i-1',
    action: 'item.update', outcome: 'success', before: null,
    after: { sku: 'TS-0001', stock: 10 }, reason: null,
    engineVersion: '1.0.0', schemaVersion: '0004', at: '2026-08-31T08:15:00.123Z',
  }, over || {});
}

console.log('\nFixture integrity (H12 discipline for the vectors themselves)');

const FIXTURE_DIR = path.join(REPO, 'fixtures', 'ledger');
const VECTORS = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'jcs-vectors.json'), 'utf8'));

test('the JCS vectors are checksum-pinned — a tampered vector fails here', () => {
  const sums = fs.readFileSync(path.join(FIXTURE_DIR, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.strictEqual(sums.length, 1, 'one pinned file');
  const [hex, name] = sums[0].trim().split(/\s+/);
  assert.strictEqual(name, 'jcs-vectors.json');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(FIXTURE_DIR, name))).digest('hex');
  assert.strictEqual(actual, hex, `checksum drift on ${name}`);
});

console.log('\nledger/jcs-vectors — RFC 8785 (JCS), the canonicalization standard');

for (const v of VECTORS.vectors) {
  test(`jcs-vectors: ${v.name} (${v.section})`, () => {
    assert.strictEqual(jcs(v.input), v.expected);
  });
}

test('jcs: undefined values drop (the JS-binding rule the seal canonicalJson ships)', () => {
  assert.strictEqual(jcs({ a: 1, ghost: undefined }), '{"a":1}');
  assert.strictEqual(jcs({ a: 1, ghost: undefined }), JSON.stringify(JSON.parse('{"a":1}')));
});
test('jcs: NaN/Infinity refuse — they would silently render "null"', () => {
  assert.throws(() => jcs({ a: NaN }), TypeError);
  assert.throws(() => jcs({ a: Infinity }), TypeError);
});
test('jcs: bigint, function, symbol refuse — non-JSON values never hash', () => {
  assert.throws(() => jcs({ a: 1n }), TypeError);
  assert.throws(() => jcs(() => 1), TypeError);
  assert.throws(() => jcs({ a: Symbol('x') }), TypeError);
});
test('jcs: code-unit order puts uppercase before lowercase (no locale collation)', () => {
  assert.strictEqual(jcs({ a: 2, A: 1 }), '{"A":1,"a":2}');
});
test('jcs: canonicalization is idempotent on its own output (as text round-trip)', () => {
  const once = jcs(VECTORS.survival[0].value);
  assert.strictEqual(jcs(JSON.parse(once)), once);
});

console.log('\nledger/jcs-vectors — the D-022 survival proofs (seal hashes survive JCS)');

const planService = require(path.join(REPO, 'packages', 'plan-service'));
for (const s of VECTORS.survival) {
  test(`jcs-survival: ${s.name} — jcs ≡ plan-service canonicalJson, SHA256 identical`, () => {
    const a = jcs(s.value);
    const b = planService.canonicalJson(s.value);
    assert.strictEqual(a, b, 'the two canonicalizations diverged — the seal hash would NOT survive');
    assert.strictEqual(L.hash.sha256Hex(a), L.hash.sha256Hex(b));
  });
}

console.log('\nhash — keyed HMAC-SHA256 over seq ‖ prevHash ‖ canonicalJson(payload)');

test('blockHash is deterministic and 64 lowercase hex', () => {
  const a = L.hash.blockHash(KEY, 1, L.hash.GENESIS, '{"a":1}');
  const b = L.hash.blockHash(KEY, 1, L.hash.GENESIS, '{"a":1}');
  assert.strictEqual(a, b);
  assert.ok(L.hash.HEX64.test(a));
});
test('the hash is KEYED — a different key yields a different hash (forge-proof without the key)', () => {
  const a = L.hash.blockHash(KEY, 1, L.hash.GENESIS, '{"a":1}');
  const b = L.hash.blockHash(KEY + 'x', 1, L.hash.GENESIS, '{"a":1}');
  assert.notStrictEqual(a, b);
});
test('the hash binds seq and prevHash — same payload, different position, different hash', () => {
  const a = L.hash.blockHash(KEY, 1, L.hash.GENESIS, '{"a":1}');
  const b = L.hash.blockHash(KEY, 2, L.hash.GENESIS, '{"a":1}');
  const c = L.hash.blockHash(KEY, 2, 'a'.repeat(64), '{"a":1}');
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(b, c);
});
test('the key is injected — weak, missing or non-string keys refuse (LEDGER_KEY_WEAK)', () => {
  expectCode(() => L.hash.blockHash('short', 1, L.hash.GENESIS, '{}'), 'LEDGER_KEY_WEAK');
  expectCode(() => L.hash.blockHash(undefined, 1, L.hash.GENESIS, '{}'), 'LEDGER_KEY_WEAK');
  expectCode(() => L.hash.blockHash(42, 1, L.hash.GENESIS, '{}'), 'LEDGER_KEY_WEAK');
});
test('seq must be a positive integer; prevHash must be 64 lowercase hex', () => {
  expectCode(() => L.hash.blockHash(KEY, 0, L.hash.GENESIS, '{}'), 'LEDGER_SEQ_INVALID');
  expectCode(() => L.hash.blockHash(KEY, 1.5, L.hash.GENESIS, '{}'), 'LEDGER_SEQ_INVALID');
  expectCode(() => L.hash.blockHash(KEY, 1, 'A'.repeat(64), '{}'), 'LEDGER_PREV_HASH_INVALID');
  expectCode(() => L.hash.blockHash(KEY, 1, 'z'.repeat(64), '{}'), 'LEDGER_PREV_HASH_INVALID');
  expectCode(() => L.hash.blockHash(KEY, 1, L.hash.GENESIS, {}), 'LEDGER_PAYLOAD_CANONICAL_REQUIRED');
});
test('GENESIS is 64 zeros', () => {
  assert.strictEqual(L.hash.GENESIS, '0'.repeat(64));
});

console.log('\ncanonicalInstant — canonical UTC, millisecond precision (H4)');

test('a Date renders YYYY-MM-DDTHH:MM:SS.sssZ', () => {
  assert.strictEqual(L.blocks.canonicalInstant(new Date(Date.UTC(2026, 7, 31, 8, 15, 0, 123))), '2026-08-31T08:15:00.123Z');
  assert.strictEqual(L.blocks.canonicalInstant(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 0))), '2026-01-02T03:04:05.000Z');
});
test('RFC 3339 UTC strings normalize to the .sssZ form — Z and +00:00 both', () => {
  assert.strictEqual(L.blocks.canonicalInstant('2026-08-31T08:15:00Z'), '2026-08-31T08:15:00.000Z');
  assert.strictEqual(L.blocks.canonicalInstant('2026-08-31T08:15:00+00:00'), '2026-08-31T08:15:00.000Z');
  assert.strictEqual(L.blocks.canonicalInstant('2026-08-31T08:15:00.5Z'), '2026-08-31T08:15:00.500Z');
});
test('sub-millisecond precision refuses — the hash must round-trip from TIMESTAMPTZ(6)', () => {
  expectCode(() => L.blocks.canonicalInstant('2026-08-31T08:15:00.1234Z'), 'LEDGER_AT_SUB_MILLISECOND');
  expectCode(() => L.blocks.canonicalInstant('2026-08-31T08:15:00.123456Z'), 'LEDGER_AT_SUB_MILLISECOND');
});
test('naive and non-UTC datetimes refuse (H4: canonical UTC only)', () => {
  expectCode(() => L.blocks.canonicalInstant('2026-08-31T08:15:00'), 'LEDGER_AT_INVALID');
  expectCode(() => L.blocks.canonicalInstant('2026-08-31T08:15:00+03:00'), 'LEDGER_AT_INVALID');
  expectCode(() => L.blocks.canonicalInstant('2026-13-31T08:15:00Z'), 'LEDGER_AT_INVALID');
  expectCode(() => L.blocks.canonicalInstant('08/31/2026'), 'LEDGER_AT_INVALID');
  expectCode(() => L.blocks.canonicalInstant(new Date('not a date')), 'LEDGER_AT_INVALID');
});
test('the canonical form is a fixed point: instant → Date → instant is byte-identical', () => {
  const s = L.blocks.canonicalInstant('2026-08-31T08:15:00.123Z');
  assert.strictEqual(L.blocks.canonicalInstant(new Date(s)), s);
});

console.log('\nbuildBlock — the §16.2 required-fields gate (every block, every class)');

test('a valid Class-W block passes and carries EXACTLY the §16.2 payload fields', () => {
  const p = L.blocks.buildBlock(baseBlock());
  assert.deepStrictEqual(Object.keys(p).sort(), L.blocks.PAYLOAD_FIELDS.slice().sort());
  assert.strictEqual(p.at, '2026-08-31T08:15:00.123Z');
});
test('every one of the five classes passes the same gate — class is a field, not a store', () => {
  for (const cls of L.blocks.CLASSES) {
    const p = L.blocks.buildBlock(baseBlock({ class: cls, outcome: cls === 'D' ? 'denied' : 'success', reason: cls === 'D' ? 'r' : null }));
    assert.strictEqual(p.class, cls);
  }
});
test('a missing field refuses — undefined is not null (LEDGER_FIELD_UNDEFINED)', () => {
  for (const f of L.blocks.PAYLOAD_FIELDS) {
    const block = baseBlock();
    delete block[f];
    expectCode(() => L.blocks.buildBlock(block), 'LEDGER_FIELD_UNDEFINED');
  }
});
test('a foreign field refuses — a shifted key set shifts every future hash', () => {
  expectCode(() => L.blocks.buildBlock(baseBlock({ extra: 1 })), 'LEDGER_FIELD_UNKNOWN');
});
test('unknown class and unknown outcome refuse (§16.1 / §16.2 vocabularies)', () => {
  expectCode(() => L.blocks.buildBlock(baseBlock({ class: 'X' })), 'LEDGER_CLASS_INVALID');
  expectCode(() => L.blocks.buildBlock(baseBlock({ outcome: 'maybe' })), 'LEDGER_OUTCOME_INVALID');
});
test('tenant must be the fence uuid; actor must be a non-empty string', () => {
  expectCode(() => L.blocks.buildBlock(baseBlock({ tenantId: 'not-a-uuid' })), 'LEDGER_TENANT_INVALID');
  expectCode(() => L.blocks.buildBlock(baseBlock({ actor: '' })), 'LEDGER_FIELD_INVALID');
  expectCode(() => L.blocks.buildBlock(baseBlock({ actor: null })), 'LEDGER_FIELD_INVALID');
});
test('a human principal carries its role — only actor \'system\' may leave it null', () => {
  expectCode(() => L.blocks.buildBlock(baseBlock({ role: null })), 'LEDGER_ROLE_REQUIRED');
  L.blocks.buildBlock(baseBlock({ actor: 'system', role: null })); // Class S shape
});
test('a denial without a reason refuses (§16.2: reason required for denials)', () => {
  expectCode(() => L.blocks.buildBlock(baseBlock({ class: 'D', outcome: 'denied', reason: null })), 'LEDGER_REASON_REQUIRED');
  expectCode(() => L.blocks.buildBlock(baseBlock({ class: 'D', outcome: 'denied', reason: '   ' })), 'LEDGER_REASON_REQUIRED');
});
test('before/after must be null, objects or arrays — a diff, never "updated"', () => {
  expectCode(() => L.blocks.buildBlock(baseBlock({ after: 'updated' })), 'LEDGER_AFTER_INVALID');
  expectCode(() => L.blocks.buildBlock(baseBlock({ before: 42 })), 'LEDGER_BEFORE_INVALID');
  L.blocks.buildBlock(baseBlock({ after: ['a', 1] }));
});
test('no secrets or PII: forbidden field names refuse at any depth, case-insensitive', () => {
  expectCode(() => L.blocks.buildBlock(baseBlock({ after: { bankAccount: 'BH67BMAG...' } })), 'LEDGER_PAYLOAD_FORBIDDEN_FIELD');
  expectCode(() => L.blocks.buildBlock(baseBlock({ after: { nested: { PASSWORD: 'x' } } })), 'LEDGER_PAYLOAD_FORBIDDEN_FIELD');
  expectCode(() => L.blocks.buildBlock(baseBlock({ after: { rows: [{ api_key: 'k' }] } })), 'LEDGER_PAYLOAD_FORBIDDEN_FIELD');
  expectCode(() => L.blocks.buildBlock(baseBlock({ before: { iban: 'x' } })), 'LEDGER_PAYLOAD_FORBIDDEN_FIELD');
});
test('ordinary business payloads pass the hygiene scan', () => {
  L.blocks.buildBlock(baseBlock({ after: { sku: 'TS-0001', stock: 10, bank_reference_note: 'see PO' } }));
});

console.log('\nrecords — the Class-D consumption path (D-029: verbatim, never forked)');

test('the approval module\'s denial record travels through UNCHANGED into a §16.2 block', () => {
  const verdict = approval.decide.reviewApproval({
    proposal: { id: 'p-1', state: 'OPEN', raisedBy: 'u-buyer', currencyCode: 'BHD', totalAmount: 500 },
    actor: { userId: 'u-buyer', role: 'BYR' },
    config: { dualThresholdAmount: 1000 }, limits: [], prior: [],
    decision: 'APPROVED', reason: 'x', tenantCurrency: 'BHD',
  });
  assert.strictEqual(verdict.ok, false);
  const block = L.records.denialToBlock(verdict.denial, {
    tenantId: T1, engineVersion: '1.0.0', schemaVersion: '0004', at: '2026-08-31T08:15:00.000Z',
  });
  assert.strictEqual(block.class, 'D');
  assert.strictEqual(block.outcome, 'denied');
  assert.strictEqual(block.actor, 'u-buyer');
  assert.strictEqual(block.role, 'BYR');
  assert.strictEqual(block.action, 'proposal.approve');
  assert.strictEqual(block.entity, 'proposal');
  assert.strictEqual(block.entityId, 'p-1');
  assert.strictEqual(block.reason, 'SOD_SELF_APPROVAL');
  assert.strictEqual(block.before, null);
  assert.strictEqual(block.after, null);
});
test('a forked denial shape refuses — the format is fixed at the source', () => {
  expectCode(() => L.records.denialToBlock({ class: 'W', outcome: 'success' }, { tenantId: T1 }), 'LEDGER_DENIAL_SHAPE');
  expectCode(() => L.records.denialToBlock({ class: 'D', outcome: 'denied', actor: 'a', action: 'x', entity: 'e' }, { tenantId: T1 }), 'LEDGER_DENIAL_SHAPE');
  expectCode(() => L.records.denialToBlock(null, { tenantId: T1 }), 'LEDGER_DENIAL_SHAPE');
});

console.log('\nledger/tamper-resistant — the pure chain walk');

test('an empty chain verifies trivially', () => {
  assert.deepStrictEqual(L.verify.verifyChain([], KEY), { ok: true, verified: 0 });
});
test('an honest multi-block chain verifies end to end', () => {
  const rows = [];
  writeChain(rows, baseBlock({ action: 'item.create', after: { sku: 'TS-0001' } }));
  writeChain(rows, baseBlock({ class: 'D', outcome: 'denied', action: 'proposal.approve', entityId: 'p-1', reason: 'SOD_SELF_APPROVAL', before: null, after: null }));
  writeChain(rows, baseBlock({ class: 'S', actor: 'system', role: null, action: 'plan.seal', entity: 'plan_seal', after: { seal: '2026-08-31' } }));
  const r = L.verify.verifyChain(rows, KEY);
  assert.deepStrictEqual(r, { ok: true, verified: 3 });
});
test('a tampered payload field breaks the walk at the exact block', () => {
  const rows = [];
  writeChain(rows, baseBlock({}));
  const second = writeChain(rows, baseBlock({ action: 'item.update' }));
  writeChain(rows, baseBlock({ action: 'item.update', entityId: 'i-2' }));
  second.after.stock = 999; // the alteration
  const r = L.verify.verifyChain(rows, KEY);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.brokenAt, 2);
  assert.ok(r.reason.startsWith('LEDGER_HASH_MISMATCH'));
});
test('a tampered hash, a broken link and a seq gap are each detected with the named reason', () => {
  const rows = [];
  writeChain(rows, baseBlock({}));
  writeChain(rows, baseBlock({ action: 'item.update' }));
  const rows2 = JSON.parse(JSON.stringify(rows));
  rows2[1].hash = 'f'.repeat(64);
  assert.strictEqual(L.verify.verifyChain(rows2, KEY).reason.indexOf('LEDGER_HASH_MISMATCH'), 0);
  const rows3 = JSON.parse(JSON.stringify(rows));
  rows3[1].prevHash = 'e'.repeat(64);
  assert.strictEqual(L.verify.verifyChain(rows3, KEY).reason.indexOf('LEDGER_PREV_HASH_MISMATCH'), 0);
  const rows4 = [rows[0], rows[1]];
  rows4[1].seq = 3;
  assert.strictEqual(L.verify.verifyChain(rows4, KEY).reason.indexOf('LEDGER_SEQ_GAP'), 0);
});
test('a payload that lost a §16.2 field is corruption, detected (LEDGER_PAYLOAD_CORRUPT)', () => {
  const rows = [];
  writeChain(rows, baseBlock({}));
  const stored = JSON.parse(JSON.stringify(rows[0]));
  delete stored.engineVersion;
  const r = L.verify.verifyChain([stored], KEY);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.startsWith('LEDGER_PAYLOAD_CORRUPT'));
});
test('a verifier with the WRONG KEY detects on the first block — the key is part of the proof', () => {
  const rows = [];
  writeChain(rows, baseBlock({}));
  const r = L.verify.verifyChain(rows, KEY + 'x');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.brokenAt, 1);
  assert.ok(r.reason.startsWith('LEDGER_HASH_MISMATCH'));
});
test('the verifier never throws for a broken chain — it reports', () => {
  const rows = [];
  writeChain(rows, baseBlock({}));
  rows[0].hash = 'broken';
  assert.strictEqual(L.verify.verifyChain(rows, KEY).ok, false);
});
test('verifyChain refuses a non-array quietly loud', () => {
  assert.throws(() => L.verify.verifyChain('nope', KEY), TypeError);
});

(async () => {
  console.log(`\n  ledger (module): ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
