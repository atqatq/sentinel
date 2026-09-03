"use strict"
/* ============================================================================
 * time-machine facts composition — the pure layer between the sealed days
 * (plan-adapter.listSealedDays) and the /audit screen's time machine
 * (screen 12: a slider whose position re-derives the snapshot stats, plus a
 * diff panel against today).
 *
 * Home rules (the approvals/data-health facts pattern):
 *   - packages/db owns the SQL; THIS file owns the composition semantics;
 *     the page owns render. No DB, no clock, no framework imports.
 *
 * Honesty rules encoded here (§11 — "the board you see is the board that
 * was", and §14.16 — a resealed day is marked, never silently smoothed):
 *   - The stats re-derive from the SEALED payload's portfolio — never from
 *     live tables. A snapshot that cannot be read is EXCLUDED and counted,
 *     not silently dropped and not fabricated.
 *   - A day whose money KPIs were WITHHELD (kpiWithheld — the C2 mixed-
 *     currency refusal) renders null money stats with the reason, never 0.
 *   - The timeline only contains SEALED days — an unsealed day does not
 *     exist for the machine; the slider snaps to what was actually sealed.
 *   - Diffs are chosen-minus-latest on every stat INDEPENDENTLY: a stat one
 *     day cannot know (withheld money) diffs as null, never as 0.
 * ==========================================================================*/

export interface SealedDay {
  readonly sealDate: string
  readonly payloadHash: string
  readonly engineVersion: string
  readonly payload: unknown
}

export interface DaySnapshot {
  readonly day: string
  readonly payloadHash: string
  readonly invValue: number | null
  readonly dio: number | null
  readonly shortages: number | null
  readonly refsPlanned: number | null
  readonly moneyWithheld: boolean
  readonly withheldReason: string | null
}

export interface StatDiff {
  readonly label: string
  readonly chosen: number | null
  readonly latest: number | null
  readonly delta: number | null
  readonly unit: "" | "%" | " d"
}

export interface Timeline {
  readonly snapshots: readonly DaySnapshot[] // ascending by day
  readonly unreadable: number // snapshots that could not be re-derived — counted, never hidden
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/** One sealed day → its snapshot, re-derived from the payload's portfolio. */
export function snapshotFromPayload(day: SealedDay): DaySnapshot | null {
  if (!day || typeof day !== "object" || typeof day.sealDate !== "string") return null
  const payload = day.payload as
    | { portfolio?: { actualInvValue?: unknown; actualDIO?: unknown; shortages?: unknown; kpiWithheld?: unknown; withheldReason?: unknown }; counts?: { refs?: unknown } }
    | null
    | undefined
  if (!payload || typeof payload !== "object" || !payload.portfolio) return null
  const p = payload.portfolio
  const withheld = p.kpiWithheld === true
  const counts = payload.counts as { refs?: unknown } | undefined
  return {
    day: day.sealDate,
    payloadHash: typeof day.payloadHash === "string" ? day.payloadHash : "",
    invValue: withheld ? null : num(p.actualInvValue),
    dio: withheld ? null : num(p.actualDIO),
    shortages: typeof p.shortages === "number" && Number.isFinite(p.shortages) ? p.shortages : null,
    refsPlanned: counts && typeof counts.refs === "number" && Number.isFinite(counts.refs) ? counts.refs : null,
    moneyWithheld: withheld,
    withheldReason: withheld && typeof p.withheldReason === "string" ? p.withheldReason : null,
  }
}

/** The 90-day timeline: every readable snapshot, ascending. */
export function buildTimeline(days: readonly SealedDay[]): Timeline {
  const snapshots: DaySnapshot[] = []
  let unreadable = 0
  for (const d of days) {
    const s = snapshotFromPayload(d)
    if (s === null) { unreadable++; continue }
    snapshots.push(s)
  }
  snapshots.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  return { snapshots, unreadable }
}

function diffStat(label: string, chosen: number | null, latest: number | null, unit: StatDiff["unit"]): StatDiff {
  const delta = chosen !== null && latest !== null ? chosen - latest : null
  return { label, chosen, latest, delta, unit }
}

/**
 * The diff panel: chosen day vs the LATEST sealed day, every stat
 * independently. A null on either side diffs as null — the machine never
 * computes "0 change" from two unknowns.
 */
export function diffAgainstLatest(timeline: Timeline, chosenDay: string): readonly StatDiff[] {
  const snaps = timeline.snapshots
  const chosen = snaps.find((s) => s.day === chosenDay) ?? null
  const latest = snaps.length > 0 ? snaps[snaps.length - 1] : null
  const c = chosen ?? { invValue: null, dio: null, shortages: null, refsPlanned: null }
  const l = latest ?? { invValue: null, dio: null, shortages: null, refsPlanned: null }
  return [
    diffStat("Inventory value", c.invValue, l.invValue, ""),
    diffStat("DIO", c.dio, l.dio, " d"),
    diffStat("Shortages", c.shortages, l.shortages, ""),
    diffStat("Refs planned", c.refsPlanned, l.refsPlanned, ""),
  ]
}

/** The slider's label for a day with no seal at that position — honest, named. */
export function dayLabel(day: string, timeline: Timeline): string {
  const s = timeline.snapshots.find((x) => x.day === day)
  return s ? s.day : `${day} · not sealed`
}
