'use strict';
/* ============================================================================
 * Intelligence egress allow-list — the M13 named proof
 * `intelligence/egress-allowlist` (build spec §14.20; audit M13).
 *
 * The audit's acceptance scenario is pinned FIRST: a prompt containing a
 * disallowed field is REJECTED BEFORE THE API CALL. The rest of the proof
 * pins the normative verdict family (malformed envelope → host → role →
 * cross-tenant → fields, in order), the exact-host discipline, the §16.4
 * envelope's hash-only property, hash determinism under the RFC 8785 canon,
 * and the allow-list's data classification.
 * ==========================================================================*/
const assert = require('assert');
const I = require('../index.js');

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }

const HOST = 'api.anthropic.com';
const base = (over) => ({
  host: HOST,
  role: 'origin',
  tenantScope: 'TENANT-A',
  consolidation: false,
  prompt: {
    instructions: 'Summarise the cover position for the period.',
    dataFields: [
      { name: 'refName', value: 'Chicken Fresh' },
      { name: 'coverDays', value: 4.2 },
      { name: 'stockoutCount', value: 3 },
    ],
    ...over.prompt,
  },
  ...over,
});

/* ---- the audit's acceptance scenario --------------------------------------- */
console.log('\nThe audit scenario — a disallowed field is rejected before the API call');

test('a prompt carrying a disallowed field (per-supplier price) refuses EGRESS_FIELD_NOT_ALLOW_LISTED', () => {
  const r = I.classifyEgress(base({ prompt: { instructions: 'x', dataFields: [
    { name: 'refName', value: 'Chicken Fresh' },
    { name: 'unitPrice', value: 12.5 },          // prices-per-supplier: absent by design
  ] } }));
  assert.strictEqual(r.verdict, 'REFUSED');
  assert.strictEqual(r.reason, 'EGRESS_FIELD_NOT_ALLOW_LISTED');
  assert.ok(r.detail.includes('unitPrice'));
});

test('personnel data refuses the same way — the classification is fail-closed, not redacted-after-the-fact', () => {
  for (const field of ['buyerName', 'approverId', 'salaryTotal', 'supplierName']) {
    const r = I.classifyEgress(base({ prompt: { instructions: 'x', dataFields: [{ name: field, value: 'x' }] } }));
    assert.strictEqual(r.reason, 'EGRESS_FIELD_NOT_ALLOW_LISTED', field);
  }
});

/* ---- the allow-list is policy data ------------------------------------------ */
console.log('\nThe allow-list — policy data, not code');

test('exactly one entry: the LLM analysis call, hostname not a URL, credential SLOT name never a value', () => {
  assert.strictEqual(I.ALLOW_LIST.length, 1);
  const e = I.ALLOW_LIST[0];
  assert.strictEqual(e.id, 'llm-analysis');
  assert.ok(!/https?:\/\//.test(e.host));
  assert.strictEqual(e.credentialSource, 'SENTINEL_INTELLIGENCE_LLM_KEY');
  assert.ok(!/sk-|key=|secret/i.test(JSON.stringify(e)));
});

test('the entry is frozen — the outbound set cannot be mutated at runtime', () => {
  assert.ok(Object.isFrozen(I.ALLOW_LIST) && Object.isFrozen(I.ALLOW_LIST[0]));
  assert.throws(() => { 'use strict'; I.ALLOW_LIST[0].host = 'evil.test'; }, TypeError);
});

test('the classification holds: aggregates and item/ref names ride — no personnel, no per-supplier prices, no unknown fields', () => {
  const list = I.ALLOW_LIST[0].fieldAllowList;
  for (const f of ['refName', 'sku', 'category', 'consumptionTotal', 'coverDays', 'stockoutCount', 'leadTimeP80', 'fillRate', 'savingsTotal']) {
    assert.ok(list.includes(f), f);
  }
  for (const f of ['unitPrice', 'pricePerSupplier', 'buyerName', 'salary', 'supplierName', 'comment']) {
    assert.ok(!list.includes(f), f);
  }
});

/* ---- the refusal family, in normative order ---------------------------------- */
console.log('\nThe refusal family — fail-closed, named, ordered');

test('a merged prompt blob refuses EGRESS_PROMPT_MALFORMED — the separation IS the stance', () => {
  assert.strictEqual(I.classifyEgress(base({ prompt: 'summarise everything' })).reason, 'EGRESS_PROMPT_MALFORMED');
  assert.strictEqual(I.classifyEgress(base({ prompt: { instructions: 5, dataFields: [] } })).reason, 'EGRESS_PROMPT_MALFORMED');
  assert.strictEqual(I.classifyEgress(base({ prompt: { instructions: 'x' } })).reason, 'EGRESS_PROMPT_MALFORMED');
  assert.strictEqual(I.classifyEgress(base({ prompt: { instructions: 'x', dataFields: [{ value: 1 }] } })).reason, 'EGRESS_PROMPT_MALFORMED');
});

test('a non-JSON dataField value refuses loudly by name — never a raw crash', () => {
  const r = I.classifyEgress(base({ prompt: { instructions: 'x', dataFields: [{ name: 'coverDays', value: undefined }] } }));
  assert.strictEqual(r.verdict, 'REFUSED');
  assert.strictEqual(r.reason, 'EGRESS_PROMPT_MALFORMED');
});

test('the host matches EXACTLY — unknown, lookalike and case-variant hosts refuse', () => {
  assert.strictEqual(I.classifyEgress(base({ host: 'evil.test' })).reason, 'EGRESS_HOST_NOT_ALLOW_LISTED');
  assert.strictEqual(I.classifyEgress(base({ host: 'api.anthropic.com.evil.test' })).reason, 'EGRESS_HOST_NOT_ALLOW_LISTED');
  assert.strictEqual(I.classifyEgress(base({ host: 'API.ANTHROPIC.COM' })).reason, 'EGRESS_HOST_NOT_ALLOW_LISTED');
  assert.strictEqual(I.classifyEgress(base({ host: undefined })).reason, 'EGRESS_HOST_NOT_ALLOW_LISTED');
});

test('the Intelligence view is origin-only — any other role refuses before anything else is judged', () => {
  assert.strictEqual(I.classifyEgress(base({ role: 'scm' })).reason, 'EGRESS_ORIGIN_ONLY');
  assert.strictEqual(I.classifyEgress(base({ role: 'sbr' })).reason, 'EGRESS_ORIGIN_ONLY');
  assert.strictEqual(I.classifyEgress(base({ role: undefined })).reason, 'EGRESS_ORIGIN_ONLY');
});

test('cross-tenant prompts refuse without the explicit consolidation flag — and consolidate only with it', () => {
  const multi = { tenantScope: ['TENANT-A', 'TENANT-B'] };
  assert.strictEqual(I.classifyEgress(base(multi)).reason, 'EGRESS_CROSS_TENANT_REFUSED');
  const ok = I.classifyEgress(base({ ...multi, consolidation: true }));
  assert.strictEqual(ok.verdict, 'ALLOWED');
  assert.strictEqual(ok.envelope.consolidation, true);
});

test('refusal ORDER is normative: shape → host → role → cross-tenant → fields', () => {
  // malformed prompt + unknown host → shape wins
  assert.strictEqual(I.classifyEgress({ host: 'evil.test', prompt: 'blob' }).reason, 'EGRESS_PROMPT_MALFORMED');
  // unknown host + non-origin role → host wins
  assert.strictEqual(I.classifyEgress({ host: 'evil.test', role: 'scm', prompt: { instructions: 'x', dataFields: [] } }).reason, 'EGRESS_HOST_NOT_ALLOW_LISTED');
  // non-origin role + multi-tenant without flag → role wins (the caller learns nothing about consolidation)
  assert.strictEqual(I.classifyEgress(base({ role: 'scm', tenantScope: ['A', 'B'] })).reason, 'EGRESS_ORIGIN_ONLY');
  // multi-tenant without flag + disallowed field → cross-tenant wins
  assert.strictEqual(I.classifyEgress(base({ tenantScope: ['A', 'B'], prompt: { instructions: 'x', dataFields: [{ name: 'buyerName', value: 'x' }] } })).reason, 'EGRESS_CROSS_TENANT_REFUSED');
});

/* ---- the allowed path — the §16.4 log envelope -------------------------------- */
console.log('\nThe allowed path — the §16.4 log envelope, hash-only');

test('a fully allowed request yields the envelope — exact shape, sorted fields, consolidation false', () => {
  const r = I.classifyEgress(base({}));
  assert.strictEqual(r.verdict, 'ALLOWED');
  assert.deepStrictEqual(Object.keys(r.envelope).sort(), ['consolidation', 'fields', 'host', 'promptHash', 'purpose', 'tenantScope']);
  assert.strictEqual(r.envelope.host, HOST);
  assert.deepStrictEqual(r.envelope.fields, ['coverDays', 'refName', 'stockoutCount']);
  assert.match(r.envelope.promptHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(r.envelope.consolidation, false);
});

test('the envelope carries NO content — instruction text and data values are absent and unrecoverable', () => {
  const r = I.classifyEgress(base({
    prompt: { instructions: 'SUMMARISE-THE-COVER-POSITION-MARKER', dataFields: [{ name: 'refName', value: 'SECRET-SUPPLIER-MARKER' }] },
  }));
  const s = JSON.stringify(r.envelope);
  assert.ok(!s.includes('SUMMARISE-THE-COVER-POSITION-MARKER'));
  assert.ok(!s.includes('SECRET-SUPPLIER-MARKER'));
});

test('hash determinism under the JCS canon: identical requests hash identically; key order inside a dataField does not matter', () => {
  const a = I.classifyEgress(base({}));
  const b = I.classifyEgress(base({}));
  assert.strictEqual(a.envelope.promptHash, b.envelope.promptHash);
  const reordered = I.classifyEgress(base({ prompt: { instructions: 'Summarise the cover position for the period.',
    dataFields: [{ value: 'Chicken Fresh', name: 'refName' }] } }));
  const straight = I.classifyEgress(base({ prompt: { instructions: 'Summarise the cover position for the period.',
    dataFields: [{ name: 'refName', value: 'Chicken Fresh' }] } }));
  assert.strictEqual(reordered.envelope.promptHash, straight.envelope.promptHash);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a.envelope)), a.envelope);
});

test('duplicate dataFields dedupe in the envelope; array order is the payload (a different order is a different hash — honest)', () => {
  const dup = I.classifyEgress(base({ prompt: { instructions: 'x', dataFields: [
    { name: 'refName', value: 'A' }, { name: 'refName', value: 'A' }, { name: 'sku', value: 'S1' },
  ] } }));
  assert.deepStrictEqual(dup.envelope.fields, ['refName', 'sku']);
  const one = I.classifyEgress(base({ prompt: { instructions: 'x', dataFields: [{ name: 'refName', value: 'A' }] } }));
  const two = I.classifyEgress(base({ prompt: { instructions: 'x', dataFields: [{ name: 'refName', value: 'A' }, { name: 'sku', value: 'S1' }] } }));
  assert.notStrictEqual(one.envelope.promptHash, two.envelope.promptHash);
});

test('an instructions-only prompt (no data) is allowed with an empty field list — no procurement data leaves', () => {
  const r = I.classifyEgress(base({ prompt: { instructions: 'Explain EOQ.', dataFields: [] } }));
  assert.strictEqual(r.verdict, 'ALLOWED');
  assert.deepStrictEqual(r.envelope.fields, []);
});

console.log(`\nintelligence/egress-allowlist: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
