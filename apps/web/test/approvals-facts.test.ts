/* ============================================================================
 * approvals facts composition suite — the app-side proof that the /approvals
 * tray renders REAL, honestly-composed facts (the §14.13c approvals tray).
 *
 * Zero-install, zero-db, zero-clock: every row is injected; identical inputs
 * must give identical envelopes. Every test is named after the requirement
 * it pins (delivery spec §5.1 — the name is the traceability link).
 * ==========================================================================*/
import assert from "node:assert/strict"

import {
  composeApprovalTray,
  deltaPct,
  deltaLabel,
  sortForTray,
  type PendingCfVersion,
} from "../src/lib/approvals.ts"

let passed = 0
let failed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`)
  }
}

const row = (over: Partial<PendingCfVersion>): PendingCfVersion => ({
  id: "v-1",
  sku: "TS-0001",
  version: 2,
  fromValue: 12,
  toValue: 15,
  requestedReason: "supplier repack changed the case weight",
  createdAt: "2026-08-30T08:00:00.000Z",
  ...over,
})

test("deltaPct: an upward change reads positive, a downward negative — one decimal at render", () => {
  assert.strictEqual(Math.round(deltaPct(row({ fromValue: 12, toValue: 15 }))! * 10) / 10, 25)
  assert.strictEqual(Math.round(deltaPct(row({ fromValue: 8, toValue: 6 }))! * 10) / 10, -25)
})

test("a FIRST-EVER factor has no FROM — the delta is null, never a percentage off a 0 base", () => {
  assert.strictEqual(deltaPct(row({ fromValue: null, toValue: 4 })), null)
  assert.strictEqual(deltaLabel(row({ fromValue: null, toValue: 4 })), "first factor")
})

test("a zero FROM is the same lie as a missing one — null, never Infinity", () => {
  assert.strictEqual(deltaPct(row({ fromValue: 0, toValue: 9 })), null)
  assert.strictEqual(deltaLabel(row({ fromValue: 0, toValue: 9 })), "—")
})

test("deltaLabel signs the number honestly: +25.0% and -25.0%; a zero change reads 0.0% (no sign — it implies nothing)", () => {
  assert.strictEqual(deltaLabel(row({ fromValue: 12, toValue: 15 })), "+25.0%")
  assert.strictEqual(deltaLabel(row({ fromValue: 8, toValue: 6 })), "-25.0%")
  assert.strictEqual(deltaLabel(row({ fromValue: 5, toValue: 5 })), "0.0%")
})

test("sortForTray: oldest request first, stable on ties (arrival order, then sku)", () => {
  const rows = [
    row({ id: "b", sku: "TS-0002", createdAt: "2026-08-31T08:00:00.000Z" }),
    row({ id: "a", sku: "TS-0001", createdAt: "2026-08-30T08:00:00.000Z" }),
    row({ id: "c", sku: "TS-0003", createdAt: "2026-08-31T08:00:00.000Z" }),
  ]
  const sorted = sortForTray(rows)
  assert.deepStrictEqual(sorted.map((r) => r.id), ["a", "b", "c"])
})

test("sortForTray: a row with NO createdAt sorts last — the missing stamp never jumps the queue", () => {
  const rows = [
    row({ id: "no-stamp", createdAt: null }),
    row({ id: "stamped", createdAt: "2026-08-30T08:00:00.000Z" }),
  ]
  const sorted = sortForTray(rows)
  assert.strictEqual(sorted[sorted.length - 1].id, "no-stamp")
})

test("composeApprovalTray: the count is the row count and the rows are the sorted rows", () => {
  const rows = [
    row({ id: "b", createdAt: "2026-08-31T08:00:00.000Z" }),
    row({ id: "a", createdAt: "2026-08-30T08:00:00.000Z" }),
  ]
  const tray = composeApprovalTray(rows)
  assert.strictEqual(tray.pendingCount, 2)
  assert.deepStrictEqual(tray.rows.map((r) => r.id), ["a", "b"])
})

test("composeApprovalTray: an EMPTY tray is an honest zero, not an error", () => {
  const tray = composeApprovalTray([])
  assert.strictEqual(tray.pendingCount, 0)
  assert.deepStrictEqual(tray.rows, [])
})

test("determinism: identical inputs produce deep-equal facts", () => {
  const rows = [row({ id: "x" }), row({ id: "y", fromValue: null, toValue: 3 })]
  assert.deepStrictEqual(composeApprovalTray(rows), composeApprovalTray(rows))
})

console.log(`\n  approvals facts: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
