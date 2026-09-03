/* ============================================================================
 * time-machine facts composition suite — the app-side proof that the /audit
 * time machine re-derives its snapshots from SEALED payloads only, and that
 * every honesty rule (withheld money, unreadable snapshots, null diffs) is
 * pinned. Zero-db, zero-clock; identical inputs give identical timelines.
 * ==========================================================================*/
import assert from "node:assert/strict"

import {
  buildTimeline,
  diffAgainstLatest,
  dayLabel,
  snapshotFromPayload,
  type SealedDay,
} from "../src/lib/timemachine.ts"

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

const day = (over: Partial<SealedDay> & { sealDate: string }): SealedDay => ({
  payloadHash: "a".repeat(64),
  engineVersion: "1.0.0",
  payload: {
    portfolio: { actualInvValue: 1200, actualDIO: 34.5, shortages: 7, kpiWithheld: false, withheldReason: null },
    counts: { refs: 42 },
  },
  ...over,
})

test("a sealed day re-derives the four snapshot stats from its SEALED portfolio", () => {
  const s = snapshotFromPayload(day({ sealDate: "2026-08-30" }))
  assert.ok(s)
  assert.strictEqual(s!.invValue, 1200)
  assert.strictEqual(s!.dio, 34.5)
  assert.strictEqual(s!.shortages, 7)
  assert.strictEqual(s!.refsPlanned, 42)
})

test("WITHHELD money KPIs (the C2 mixed-currency refusal) render null with the reason — never 0", () => {
  const s = snapshotFromPayload(day({
    sealDate: "2026-08-29",
    payload: {
      portfolio: { actualInvValue: 0, actualDIO: 0, shortages: 3, kpiWithheld: true, withheldReason: "rows not normalized to tenant currency" },
      counts: { refs: 40 },
    },
  }))
  assert.ok(s)
  assert.strictEqual(s!.invValue, null, "the money stat is null, never the poisoned sum")
  assert.strictEqual(s!.dio, null)
  assert.strictEqual(s!.shortages, 3, "shortages are counts, not money — they still hold")
  assert.strictEqual(s!.moneyWithheld, true)
  assert.strictEqual(s!.withheldReason, "rows not normalized to tenant currency")
})

test("a day with NO readable payload is excluded and COUNTED — never silently dropped", () => {
  const t = buildTimeline([
    day({ sealDate: "2026-08-30" }),
    day({ sealDate: "2026-08-29", payload: null }),
    day({ sealDate: "2026-08-28", payload: { nope: true } }),
  ])
  assert.strictEqual(t.snapshots.length, 1)
  assert.strictEqual(t.unreadable, 2)
})

test("buildTimeline sorts ascending regardless of arrival order", () => {
  const t = buildTimeline([
    day({ sealDate: "2026-08-31" }),
    day({ sealDate: "2026-08-28" }),
    day({ sealDate: "2026-08-30" }),
  ])
  assert.deepStrictEqual(t.snapshots.map((s) => s.day), ["2026-08-28", "2026-08-30", "2026-08-31"])
})

test("the diff panel compares every stat INDEPENDENTLY against the latest sealed day", () => {
  const t = buildTimeline([
    day({ sealDate: "2026-08-28", payload: { portfolio: { actualInvValue: 1000, actualDIO: 30, shortages: 5, kpiWithheld: false }, counts: { refs: 40 } } }),
    day({ sealDate: "2026-08-30", payload: { portfolio: { actualInvValue: 1200, actualDIO: 34.5, shortages: 7, kpiWithheld: false }, counts: { refs: 42 } } }),
  ])
  const diffs = diffAgainstLatest(t, "2026-08-28")
  assert.deepStrictEqual(
    diffs.map((d) => ({ label: d.label, delta: d.delta })),
    [
      { label: "Inventory value", delta: -200 },
      { label: "DIO", delta: -4.5 },
      { label: "Shortages", delta: -2 },
      { label: "Refs planned", delta: -2 },
    ],
  )
})

test("diffs against an unknown or withheld stat are null — two unknowns never compute a fake zero", () => {
  const t = buildTimeline([
    day({ sealDate: "2026-08-28", payload: { portfolio: { kpiWithheld: true, shortages: 1 }, counts: { refs: 9 } } }),
    day({ sealDate: "2026-08-30" }),
  ])
  const diffs = diffAgainstLatest(t, "2026-08-28")
  const inv = diffs.find((d) => d.label === "Inventory value")!
  assert.strictEqual(inv.chosen, null)
  assert.strictEqual(inv.delta, null, "a withheld chosen stat and a known latest still diff as null")
  const sh = diffs.find((d) => d.label === "Shortages")!
  assert.strictEqual(sh.delta, 1 - 7)
})

test("an EMPTY timeline diffs as four nulls — the machine shows the absence, not zeros", () => {
  const t = buildTimeline([])
  const diffs = diffAgainstLatest(t, "2026-09-01")
  assert.ok(diffs.every((d) => d.chosen === null && d.latest === null && d.delta === null))
})

test("dayLabel names an unsealed day as NOT SEALED — the slider never impersonates a seal", () => {
  const t = buildTimeline([day({ sealDate: "2026-08-30" })])
  assert.strictEqual(dayLabel("2026-08-30", t), "2026-08-30")
  assert.strictEqual(dayLabel("2026-08-29", t), "2026-08-29 · not sealed")
})

test("determinism: identical inputs produce deep-equal timelines", () => {
  const days = [day({ sealDate: "2026-08-30" }), day({ sealDate: "2026-08-29" })]
  assert.deepStrictEqual(buildTimeline(days), buildTimeline(days))
})

console.log(`\n  time-machine facts: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
