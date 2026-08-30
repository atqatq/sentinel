/* ============================================================================
 * data-health facts composition suite — the app-side proof that the screen
 * and the /api/data-health transport render REAL, honestly-composed facts.
 *
 * Zero-install: the ops freshness surface is the REAL module (required
 * through its public-contract index by relative path — the same file the
 * package main points at), injected into the composition exactly as the
 * route's composition root injects it via the workspace import. No database,
 * no clock: every stamp and asOf is injected; identical inputs must give
 * identical envelopes.
 *
 * Every test is named after the requirement it pins (delivery spec §5.1 —
 * the name is the traceability link).
 * ==========================================================================*/
import { createRequire } from "node:module"
import assert from "node:assert/strict"

import {
  composeDataHealthFacts,
  buildSealStamps,
  formatUtcMinutes,
  utcMonthStart,
  type TaskRow,
  type StampRow,
} from "../src/lib/data-health.ts"

const require = createRequire(import.meta.url)
const OPS = require("../../../packages/core/modules/ops")

const F = OPS.freshness
const HOUR = F.HOUR
const T0 = 1_700_000_000_000 // an arbitrary injected instant (2023-11-14 22:13:20 UTC)
const ASOF = T0 + 100 * HOUR

const KINDS: readonly string[] = F.DATASET_KINDS // canonical order (8 kinds)

let passed = 0
let failed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log("  ✓ " + name)
  } catch (e) {
    failed++
    console.log("  ✗ " + name + "\n      " + (e as Error).message)
  }
}

function throwsWith(fn: () => void, prefix: string) {
  try {
    fn()
  } catch (e) {
    assert.ok(
      String((e as Error).message).startsWith(prefix),
      `expected throw '${prefix}…' but got: ${(e as Error).message}`
    )
    return
  }
  throw new Error(`expected throw starting '${prefix}' — nothing was thrown`)
}

/* All eight kinds sealed `hours` before asOf; 'never' pins a kind to null. */
function stamps(hours: number, never: string[] = []): StampRow[] {
  return KINDS.map((kind) => ({
    kind,
    lastAppliedAtMs: never.includes(kind) ? null : ASOF - hours * HOUR,
  }))
}

const deps = {
  evaluateFreshness: F.evaluateFreshness,
  STATES: F.STATES,
  DAT01_SLO_HOURS: F.DAT01_SLO_HOURS,
  DAT01_ALARM_HOURS: F.DAT01_ALARM_HOURS,
  DAT01_OWNER: F.DAT01_OWNER,
  DATASET_KINDS: F.DATASET_KINDS,
}

function task(overrides: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    taskType: "DATA_HEALTH",
    severity: "WARN",
    status: "OPEN",
    payload: {},
    createdAtMs: ASOF - 2 * HOUR,
    resolvedAtMs: null,
    ...overrides,
  }
}

const baseInput = {
  tenant: { code: "BahrainMP", name: "Bahrain Member Practice" },
  asOfMs: ASOF,
  stamps: stamps(5),
  tasks: [] as TaskRow[],
  closedThisMonth: 0,
  ingestCounts: { received: 4, applied: 4 },
  deps,
}

/* ------------------------------------------------------------ the tests -- */

test("empty pipeline: never-sealed kinds are ALARM with a null age — silence is never freshness", () => {
  const facts = composeDataHealthFacts({ ...baseInput, stamps: stamps(0, [...KINDS]) })
  assert.equal(facts.freshness.perDataset.length, 8)
  assert.ok(facts.freshness.perDataset.every((e) => e.state === "ALARM" && e.ageHours === null))
  assert.equal(facts.freshness.dat01.value, null, "ANY unsealed kind holds DAT-01 at null")
  assert.equal(facts.freshness.alarms.length, 8)
})

test("empty pipeline: the missing-deliveries channel is raised with the H8 consequence named", () => {
  const facts = composeDataHealthFacts({ ...baseInput, stamps: stamps(0, [...KINDS]) })
  assert.equal(facts.freshness.missingDeliveries.raised, true)
  assert.match(facts.freshness.missingDeliveries.banner!.text, /H8/)
})

test("fresh pipeline: no alarms, DAT-01 honest, no banner, only the cadence-default disclosure", () => {
  const facts = composeDataHealthFacts(baseInput)
  assert.ok(facts.freshness.perDataset.every((e) => e.state === "FRESH"))
  assert.equal(facts.freshness.alarms.length, 0)
  assert.equal(facts.freshness.missingDeliveries.raised, false)
  assert.equal(facts.freshness.dat01.value, 5)
  assert.equal(facts.staleBanner, null, "a 5h-old seal is younger than the one-day shell rule")
  assert.equal(facts.disclosures.length, 1)
})

test("stale banner: the NEWEST seal drives the banner — mixed ages never overstate staleness", () => {
  const allOld = composeDataHealthFacts({ ...baseInput, stamps: stamps(84) })
  assert.ok(allOld.staleBanner, "an 84h-old newest seal is past the one-day rule")
  assert.equal(allOld.staleBanner!.daysOld, 3, "floor(84h / 24h) = 3 whole days")
  assert.equal(allOld.staleBanner!.sinceDisplay, formatUtcMinutes(ASOF - 84 * HOUR))

  const mixed = composeDataHealthFacts({
    ...baseInput,
    stamps: KINDS.map((kind, i) => ({
      kind,
      lastAppliedAtMs: i === 0 ? ASOF - 2 * HOUR : ASOF - 84 * HOUR,
    })),
  })
  assert.equal(mixed.staleBanner, null, "a 2h-old newest seal means no stale banner at all")
})

test("banner timestamp renders in UTC wall format — deterministic on every server", () => {
  assert.equal(formatUtcMinutes(T0), "2023-11-14 22:13")
})

test("deliveries cadence: tenant-amendable — 30h breaches the daily default but passes a weekly tenant", () => {
  const lateDeliveries = (cadence?: number) =>
    composeDataHealthFacts({
      ...baseInput,
      ...(cadence === undefined ? {} : { deliveriesCadenceHours: cadence }),
      stamps: KINDS.map((kind) => ({
        kind,
        lastAppliedAtMs: kind === "deliveries" ? ASOF - 30 * HOUR : ASOF - 5 * HOUR,
      })),
    })
  const daily = lateDeliveries()
  assert.equal(daily.freshness.missingDeliveries.raised, true, "30h > 26h daily default")
  const weekly = lateDeliveries(182)
  assert.equal(weekly.freshness.missingDeliveries.raised, false, "30h < 182h weekly cadence")
  assert.ok(
    !weekly.disclosures.some((d) => d.includes("daily-preferred default")),
    "an explicit cadence replaces the default disclosure"
  )
})

test("seal stamps fold over the canonical kind list; an unknown kind fails closed (D-024)", () => {
  const seals = buildSealStamps([{ kind: "deliveries", lastAppliedAtMs: T0 }], KINDS)
  assert.equal(seals[0].sealedAt, null, "kinds absent from ingest_file stay null")
  const deliveriesEntry = seals.find((s) => s.kind === "deliveries")
  assert.equal(deliveriesEntry?.sealedAt, T0)

  throwsWith(
    () => buildSealStamps([{ kind: "mystery_file", lastAppliedAtMs: T0 }], KINDS),
    "UNKNOWN_INGEST_KIND"
  )
})

test("future stamps are refused by the ops module through the composition (fail-closed chain)", () => {
  throwsWith(
    () =>
      composeDataHealthFacts({
        ...baseInput,
        stamps: KINDS.map((kind) => ({ kind, lastAppliedAtMs: ASOF + HOUR })),
      }),
    "FUTURE_SEAL"
  )
})

test("register: severity-first order, unassigned rule data, KPIs from real rows", () => {
  const rows: TaskRow[] = [
    task({ id: "t-info", severity: "INFO", payload: { name: "Perishables without shelf life", count: "27", scopePct: 12, blocks: "Over-stock detection", owner: "Owner F" } }),
    task({ id: "t-crit", severity: "CRITICAL", payload: { name: "Suppliers missing lead time", count: "193 / 230", scopePct: 84, blocks: "Lead-time suggestions, MRP accuracy", owner: "Owner C", refsBlocked: 0 } }),
    task({ id: "t-warn-1", severity: "WARN", payload: { name: "Unmapped SKUs", count: "318", scopePct: 52, blocks: "Preferred SKU, proposals", owner: "Owner G", refsBlocked: 31 } }),
    task({ id: "t-warn-2", severity: "WARN", payload: { count: "46" }, createdAtMs: ASOF - 5 * HOUR }),
  ]
  const facts = composeDataHealthFacts({ ...baseInput, tasks: rows, closedThisMonth: 12 })

  assert.deepEqual(
    facts.register.rows.map((r) => r.id),
    ["t-crit", "t-warn-1", "t-warn-2", "t-info"],
    "CRITICAL first, then WARN newest-first, then INFO"
  )

  const unassigned = facts.register.rows.find((r) => r.id === "t-warn-2")
  assert.equal(unassigned?.owner, null, "no owner in the payload = the §9 Unassigned rule")
  assert.equal(unassigned?.name, "DATA_HEALTH", "name falls back to the task type, never invented")

  assert.equal(facts.register.kpis.openGaps, 4)
  assert.equal(facts.register.kpis.unassignedGaps, 1)
  assert.equal(facts.register.kpis.closedThisMonth, 12)
  assert.equal(facts.register.kpis.refsBlocked, 31, "sums what payloads state")
  assert.ok(
    facts.disclosures.some((d) => d.includes("under-count")),
    "partial refsBlocked coverage is disclosed, not silent"
  )
})

test("register: refsBlocked is WITHHELD (null) when no payload states it — never a lying zero", () => {
  const facts = composeDataHealthFacts({
    ...baseInput,
    tasks: [task({ id: "t-1", payload: { name: "Unresolved units", count: "46" } })],
  })
  assert.equal(facts.register.kpis.refsBlocked, null)
  assert.ok(facts.disclosures.some((d) => d.includes("withheld")))
})

test("register: an unknown severity throws — an unbindable value never renders neutral", () => {
  throwsWith(
    () =>
      composeDataHealthFacts({
        ...baseInput,
        tasks: [task({ id: "t-x", severity: "HIGH" })],
      }),
    "UNKNOWN_SEVERITY"
  )
})

test("coverage cell: scopePct outside 0–100 is null, never a negative bar", () => {
  const facts = composeDataHealthFacts({
    ...baseInput,
    tasks: [task({ id: "t-1", payload: { scopePct: 140 } })],
  })
  assert.equal(facts.register.rows[0].scopePct, null)
})

test("determinism: identical inputs produce deep-equal, JSON-round-trip-stable envelopes", () => {
  const tasks: TaskRow[] = [
    task({ id: "t-1", payload: { name: "Unresolved units", count: "46", refsBlocked: 46 } }),
  ]
  const a = composeDataHealthFacts({ ...baseInput, tasks })
  const b = composeDataHealthFacts({ ...baseInput, tasks })
  assert.deepEqual(a, b)
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a)
})

test("dat01 target travels as data from the ops constants — the screen restates no spec number", () => {
  const facts = composeDataHealthFacts(baseInput)
  assert.equal(facts.dat01Target.sloHours, F.DAT01_SLO_HOURS)
  assert.equal(facts.dat01Target.alarmHours, F.DAT01_ALARM_HOURS)
  assert.equal(facts.dat01Target.owner, F.DAT01_OWNER)
})

test("utcMonthStart pins the closed-this-month window to the UTC month of asOf", () => {
  assert.equal(utcMonthStart(ASOF), Date.UTC(2023, 10, 1))
})

/* ---------------------------------------------------------------- report -- */

console.log(`\n  data-health facts: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
