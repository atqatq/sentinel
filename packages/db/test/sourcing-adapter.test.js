'use strict';
/* ============================================================================
 * Sourcing adapter (stub client) — the SRC-05 evidence read without a
 * database. Pins: the explicit tenant predicate on every statement, the
 * evidence join's approved-supplier shape (active AND not banned), the
 * attribution counts (unattributable PO lines are COUNTED, never dropped),
 * the int8 casts (counts leave as JS numbers), and the honest null for a
 * category the evidence never mentions.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');
const { makeSourcingAdapter } = require(path.join(__dirname, '..', 'sourcing-adapter'));

const T1 = '11111111-1111-4111-8111-111111111111';

function stubClient({ categoryRows = [], evidenceRows = [], attributionRow = null, sealStampRow = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      const norm = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: norm, values });
      if (/FROM plan_seal/.test(norm)) return { rows: sealStampRow, rowCount: sealStampRow.length };
      if (/FROM item WHERE/.test(norm)) return { rows: categoryRows, rowCount: categoryRows.length };
      if (/FROM open_po_line o/.test(norm) && /GROUP BY/.test(norm)) return { rows: evidenceRows, rowCount: evidenceRows.length };
      if (/FILTER \(WHERE item_id IS NULL/.test(norm)) {
        return { rows: [attributionRow || { openLines: 0, unattributed: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

let passed = 0, failed = 0;
const pending = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

(async () => {
  await test('the evidence read: every statement carries the explicit tenant predicate', async () => {
    const c = stubClient();
    await makeSourcingAdapter(c, T1).loadCategorySupplierEvidence();
    assert.strictEqual(c.calls.length, 3, `three reads: categories, evidence, attribution (${c.calls.length})`);
    for (const call of c.calls) {
      assert.ok(call.text.includes('tenant_id = $1'), `the tenant predicate is explicit: ${call.text.slice(0, 60)}`);
    }
  });

  await test('a category the evidence never mentions reads UNSOURCED (null), never 0-and-hidden', async () => {
    const c = stubClient({
      categoryRows: [
        { category: 'Dairy', itemCount: 12 },
        { category: 'Chemicals', itemCount: 4 },
      ],
      evidenceRows: [{ category: 'Dairy', supplierCount: 2 }],
    });
    const ev = await makeSourcingAdapter(c, T1).loadCategorySupplierEvidence();
    assert.deepStrictEqual(ev.categories, [
      { category: 'Dairy', itemCount: 12, supplierCount: 2 },
      { category: 'Chemicals', itemCount: 4, supplierCount: null },
    ]);
  });

  await test('the attribution counts ride the read — unattributable PO lines are disclosed, not dropped', async () => {
    const c = stubClient({
      categoryRows: [],
      evidenceRows: [],
      attributionRow: { openLines: 500, unattributed: 37 },
    });
    const ev = await makeSourcingAdapter(c, T1).loadCategorySupplierEvidence();
    assert.strictEqual(ev.openLines, 500);
    assert.strictEqual(ev.unattributedLines, 37, '37 lines with no item/supplier link would otherwise fake a healthier mix');
  });

  await test('the join shape pins the approved-supplier definition: active AND not banned', async () => {
    const c = stubClient();
    await makeSourcingAdapter(c, T1).loadCategorySupplierEvidence();
    const evidenceSql = c.calls[1].text;
    assert.ok(/s\.is_active/.test(evidenceSql), 'is_active is in the WHERE');
    assert.ok(/NOT s\.is_banned/.test(evidenceSql), 'a banned supplier is not an approved one');
    assert.ok(/COUNT\(DISTINCT o\.supplier_id\)/.test(evidenceSql), 'DISTINCT suppliers — line counts would lie');
  });

  await test('loadLastSealStamp: the epoch crosses as a JS number; never-sealed reads null', async () => {
    const c = stubClient({ sealStampRow: [{ sealedAtMs: '1756500000000' }] });
    const t = await makeSourcingAdapter(c, T1).loadLastSealStamp();
    assert.strictEqual(t, 1756500000000, 'the int8 lesson: a number, never a string');
    const c2 = stubClient();
    assert.strictEqual(await makeSourcingAdapter(c2, T1).loadLastSealStamp(), null, 'never sealed is an honest null');
  });

  const label = `sourcing-adapter (stub): ${passed} passed, ${failed} failed`;
  console.log(`\n  ${label}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
