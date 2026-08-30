/* ============================================================================
 * ui/status-vocabulary-binding — the status-language contract test.
 *
 * Proves, against the REAL engine exports (not copies):
 *   1. every status the engine's displayStatus() can output resolves a tone
 *      through the inventory vocabulary (fail-closed binding holds);
 *   2. every status the engine's supplyStatus() can output resolves a tone
 *      through the supply vocabulary;
 *   3. the vocabularies cover exactly their contract sets (build spec §3.1
 *      + the M1 display overrides);
 *   4. unknown statuses THROW — an unbindable status never renders neutral;
 *   5. every binding wears a valid SDS tone token.
 *
 * Runs with Node's type stripping (--experimental-strip-types on node 22):
 * the vocabulary module is pure data + functions (erasable syntax only).
 * ============================================================================*/
'use strict';

import { createRequire } from 'node:module';
import {
  INVENTORY_STATUSES, SUPPLY_STATUSES, SDS_TONES,
  inventoryTone, supplyTone, isInventoryStatus, isSupplyStatus,
} from '../src/status.ts';

const require = createRequire(import.meta.url);
const E = require('../../core/modules/planning-engine');

let passed = 0, failed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function bad(name, detail) { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
function assert(name, cond, detail) { cond ? ok(name) : bad(name, detail); }

/* ---- 1. displayStatus domain ↔ inventory vocabulary ---------------------- */

/* Rows engineered so statusOf() walks every reachable ladder branch
 * (engine.js: Over Stock > OK(no consumption) > Zero Stock > Below Safety >
 * Follow-up with Supplier > Below Reorder > Over Stock > OK). */
const ladderRows = [
  ['Over Stock (cap)',              { available: 200, maxStock: 100, reorderPct: 1.5, safetyStock: 10, openPO: 0 }],
  ['Zero Stock',                    { available: 0,   maxStock: 100, reorderPct: 1.5, safetyStock: 10, openPO: 0 }],
  ['Below Safety',                  { available: 5,   maxStock: 100, reorderPct: 1.5, safetyStock: 10, openPO: 0 }],
  ['Follow-up with Supplier',       { available: 50,  maxStock: 100, reorderPct: 1.5, safetyStock: 10, openPO: 10 }],
  ['Below Reorder',                 { available: 95,  maxStock: 100, reorderPct: 1.0, safetyStock: 10, openPO: 0 }],
  ['Over Stock (upper band)',       { available: 130, maxStock: 100, reorderPct: 1.5, safetyStock: 10, openPO: 0 }],
  ['OK (planned, covered)',         { available: 50,  maxStock: 100, reorderPct: 1.5, safetyStock: 10, openPO: 0 }],
  ['OK (no consumption, M="NC")',   { available: 50,  maxStock: 100, reorderPct: null, safetyStock: 10, openPO: 0 }],
];

const displayOverrides = [
  ['Inactive (NO_USAGE)',           { dataState: 'NO_USAGE' }],
  ['Not Planned (NO_PARAMS)',       { dataState: 'NO_PARAMS' }],
  ['No Lead Time (NO_LEAD_TIME)',   { dataState: 'NO_LEAD_TIME' }],
];

console.log('\nEngine displayStatus overrides → inventory vocabulary');
for (const [name, extra] of displayOverrides) {
  const row = { status: 'OK', ...extra };
  let shown = null, tone = null, err = null;
  try { shown = E.displayStatus(row); } catch (e) { err = e; }
  if (err) { bad(`displayStatus computed for ${name}`, err.message); continue; }
  if (shown === null || shown === undefined) { bad(`displayStatus non-null for ${name}`, 'engine returned ' + shown); continue; }
  try { tone = inventoryTone(shown); } catch (e) { bad(`vocabulary binds "${shown}" (${name})`, e.message); continue; }
  if (SDS_TONES.includes(tone)) ok(`displayStatus "${shown}" → ${tone} (${name})`);
  else bad(`tone token valid for "${shown}"`, String(tone));
}

console.log('\nEngine displayStatus → inventory vocabulary (fail-closed)');
for (const [name, params] of ladderRows) {
  /* The real pipeline: statusOf computes the raw ladder status, displayStatus
   * maps it to the display status the UI may render. */
  let raw = null, shown = null, tone = null, err = null;
  try { raw = E.statusOf(params); shown = E.displayStatus({ status: raw, dataState: 'OK' }); } catch (e) { err = e; }
  if (err) { bad(`statusOf→displayStatus computed for ${name}`, err.message); continue; }
  if (shown === null || shown === undefined) { bad(`displayStatus non-null for ${name}`, 'engine returned ' + shown); continue; }
  try { tone = inventoryTone(shown); } catch (e) { bad(`vocabulary binds "${shown}" (${name})`, e.message); continue; }
  if (SDS_TONES.includes(tone)) ok(`displayStatus "${shown}" → ${tone} (${name})`);
  else bad(`tone token valid for "${shown}"`, String(tone));
}

/* ---- 2. supplyStatus domain ↔ supply vocabulary --------------------------- */

console.log('\nEngine supplyStatus → supply vocabulary (fail-closed)');
const supplyFacts = [
  ['Normal',                  { openPO: 0, overduePO: 0, partialPO: 0 }],
  ['Follow-up with Supplier', { openPO: 10, overduePO: 0, partialPO: 0 }],
  ['Partial Delivery',        { openPO: 10, overduePO: 0, partialPO: 4 }],
  ['Late PO',                 { openPO: 10, overduePO: 6, partialPO: 0 }],
  ['Supplier Issue',          { openPO: 10, overduePO: 6, partialPO: 4, supplierIssue: true }],
];
for (const [expected, po] of supplyFacts) {
  const got = E.supplyStatus(po);
  if (got !== expected) { bad(`supplyStatus outputs "${expected}"`, `got "${got}"`); continue; }
  let tone = null;
  try { tone = supplyTone(got); } catch (e) { bad(`vocabulary binds supply "${got}"`, e.message); continue; }
  ok(`supplyStatus "${got}" → ${tone}`);
}

/* ---- 3. exact contract coverage ------------------------------------------- */

console.log('\nVocabulary coverage is exactly the contract set');
const EXPECTED_INVENTORY = [
  'OK', 'Below Reorder', 'Below Safety', 'Zero Stock', 'Over Stock',
  'Follow-up with Supplier', 'Inactive', 'Not Planned', 'No Lead Time',
];
const EXPECTED_SUPPLY = ['Normal', 'Follow-up with Supplier', 'Partial Delivery', 'Late PO', 'Supplier Issue'];
assert('inventory vocabulary = §3.1 seven + M1 display overrides',
  INVENTORY_STATUSES.length === EXPECTED_INVENTORY.length &&
  EXPECTED_INVENTORY.every((l) => isInventoryStatus(l)),
  'labels: ' + INVENTORY_STATUSES.map((b) => b.label).join(' | '));
assert('supply vocabulary = §3.1 five, independent table',
  SUPPLY_STATUSES.length === EXPECTED_SUPPLY.length &&
  EXPECTED_SUPPLY.every((l) => isSupplyStatus(l)),
  'labels: ' + SUPPLY_STATUSES.map((b) => b.label).join(' | '));
assert('axes never merge: Normal is not an inventory status', !isInventoryStatus('Normal'));
assert('axes never merge: the tables are separate maps',
  inventoryTone('OK') === 'ok' && supplyTone('Normal') === 'ok' &&
  isSupplyStatus('OK') === false);

/* §3.1 named tones for the seven the build spec names verbatim. */
const NAMED = { 'OK': 'ok', 'Below Reorder': 'warn', 'Below Safety': 'critical', 'Zero Stock': 'critical', 'Over Stock': 'info', 'Follow-up with Supplier': 'pending', 'Inactive': 'muted' };
for (const [label, tone] of Object.entries(NAMED)) {
  assert(`§3.1 binds "${label}" → ${tone}`, inventoryTone(label) === tone, String(inventoryTone(label)));
}

/* ---- 4. fail-closed resolution -------------------------------------------- */

console.log('\nUnknown statuses throw (never a neutral render)');
const unknown = ['Discontinued', 'Planned', '', 'ok', null, undefined, 42, 'Normal '];
for (const u of unknown) {
  let threw = false;
  try { inventoryTone(u); } catch { threw = true; }
  assert(`inventoryTone rejects ${JSON.stringify(u)}`, threw);
}
for (const u of ['OK', '', null, 'Below Safety']) {
  let threw = false;
  try { supplyTone(u); } catch { threw = true; }
  assert(`supplyTone rejects ${JSON.stringify(u)}`, threw);
}

/* ---- 5. every binding wears a valid SDS tone ------------------------------ */

for (const b of [...INVENTORY_STATUSES, ...SUPPLY_STATUSES]) {
  assert(`"${b.label}" wears tone ${b.tone}`, SDS_TONES.includes(b.tone));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
