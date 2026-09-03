'use strict';
/* ============================================================================
 * The §14.13c API read ports (stub client) — loadCfVersionById and
 * loadLatestSealPayload, the decision boundary's inputs, without a database:
 *   - the version loads BY ID, PENDING only, NUMERIC crossing the asNum
 *     boundary (the int8 lesson, read direction), a null FROM staying null;
 *   - a malformed versionId refuses BEFORE any statement (statement-first);
 *   - the seal payload reads as JSONB (the re-derivation walk needs the
 *     sizing basis, never just the hash); no seal → null.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));

const T1 = '11111111-1111-4111-8111-111111111111';
const VID = '33333333-3333-4333-8333-333333333333';

function stubClient({ cfRows = [], sealRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      const norm = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: norm, values });
      if (/FROM item_cf_version/.test(norm)) return { rows: cfRows, rowCount: cfRows.length };
      if (/FROM plan_seal/.test(norm)) return { rows: sealRows, rowCount: sealRows.length };
      return { rows: [], rowCount: 0 };
    },
  };
}

let passed = 0, failed = 0;
const test = (name, fn) => {
  const p = (async () => {
    try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (e) { failed += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
  })();
  TESTS.push(p);
};
const TESTS = [];

(async () => {
  console.log('\nThe §14.13c read ports — statement-first, the int8 boundary (stub tier)');

  test('loadCfVersionById: PENDING only, NUMERIC crossed by asNum, a null FROM stays null', async () => {
    const c = stubClient({ cfRows: [{ id: VID, tenantId: T1, sku: 'SKU-1', version: 2, from_value: null, to_value: '15.5', state: 'PENDING', requestedBy: null }] });
    const v = await DB.makeProcureAdapter(c, T1).loadCfVersionById(VID);
    assert.strictEqual(v.fromValue, null, 'Number(null) is 0 — which would lie');
    assert.strictEqual(v.toValue, 15.5, 'a finite JS number, never a DECIMAL string');
    assert.strictEqual(v.from, null);
    assert.strictEqual(v.to, '15.5');
    assert.ok(c.calls[0].text.includes('state = \'PENDING\''), 'the state is re-proved in SQL');
  });

  test('loadCfVersionById: a malformed versionId refuses BEFORE any statement', async () => {
    const c = stubClient();
    await assert.rejects(
      () => DB.makeProcureAdapter(c, T1).loadCfVersionById('not-a-uuid'),
      /CF_VERSION_ID_INVALID/);
    assert.strictEqual(c.calls.length, 0, 'ZERO statements — statement-first');
  });

  test('loadLatestSealPayload: the payload as JSONB; no seal reads null', async () => {
    const c = stubClient({ sealRows: [{ payload: { refs: [] } }] });
    const p = await DB.makeProcureAdapter(c, T1).loadLatestSealPayload();
    assert.deepStrictEqual(p, { refs: [] });
    const c2 = stubClient();
    const none = await DB.makeProcureAdapter(c2, T1).loadLatestSealPayload();
    assert.strictEqual(none, null, 'no seal is an honest null — never a fabricated payload');
  });

  test('listPendingCfVersions (the §14.13c tray read): PENDING only, oldest request first, NUMERIC crossed, null FROM stays null', async () => {
    const c = stubClient({ cfRows: [
      { id: VID, sku: 'SKU-A', version: 2, from_value: '12', to_value: '15', requested_reason: 'repack', created_at: '2026-08-30T08:00:00Z' },
      { id: '44444444-4444-4444-8444-444444444444', sku: 'SKU-B', version: 1, from_value: null, to_value: '4', requested_reason: null, created_at: '2026-08-29T08:00:00Z' },
    ] });
    const rows = await DB.makeProcureAdapter(c, T1).listPendingCfVersions();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].toValue, 15, 'a finite JS number — the tray never renders a DECIMAL string');
    assert.strictEqual(rows[1].fromValue, null, 'a FIRST-EVER factor has no FROM — never Number(null) = 0');
    const sql = c.calls[0].text;
    assert.ok(sql.includes("state = 'PENDING'"), 'the queue is PENDING only');
    assert.ok(/ORDER BY created_at/.test(sql), 'oldest request first — the order the tray works down');
    assert.ok(/WHERE tenant_id = \$1/.test(sql), 'the tenant predicate is explicit in the statement (RLS is the fence, this is the shape)');
    assert.ok(!/LIMIT/.test(sql), 'no cap on the queue — a hidden cap would hide a pending decision');
  });

  test('listPendingCfVersions: an empty queue reads as an empty array, not null', async () => {
    const c = stubClient();
    const rows = await DB.makeProcureAdapter(c, T1).listPendingCfVersions();
    assert.deepStrictEqual(rows, [], 'an empty tray is an honest zero the screen can render');
  });

  await Promise.all(TESTS);
  console.log(`\ncf read ports (stub): ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
