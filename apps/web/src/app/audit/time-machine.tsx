"use client"

import * as React from "react"

import {
  diffAgainstLatest,
  type DaySnapshot,
  type StatDiff,
  type Timeline,
} from "../../lib/timemachine"

/*
 * TimeMachine — the client half of screen 12: a range slider whose position
 * selects a SEALED day and re-derives the four snapshot stats live, plus a
 * diff panel against the latest sealed day.
 *
 * Every snapshot is PRELOADED (the server component read them from
 * plan_seal through the fenced reader) — the slider does no fetching, no
 * aggregation that could drift from the sealed truth: it only points at
 * what was sealed, and the stats re-derive from the sealed payloads via
 * lib/timemachine (the same pure layer the tests pin). An unsealed window
 * renders its absence — no interpolation, no nearest-day guessing, no
 * spinner.
 */
export function TimeMachine({ timeline }: { timeline: Timeline }) {
  const snaps = timeline.snapshots
  const [index, setIndex] = React.useState(snaps.length > 0 ? snaps.length - 1 : 0)

  const chosen = snaps.length > 0 ? (snaps[Math.min(index, snaps.length - 1)] ?? null) : null
  const chosenDay = chosen?.day ?? ""
  const diffs = React.useMemo(() => diffAgainstLatest(timeline, chosenDay), [timeline, chosenDay])
  const label = chosen ? chosen.day : "no sealed day"

  return (
    <div className="flex flex-col gap-4">
      {snaps.length === 0 ? (
        <p className="font-sans text-[13px] leading-[20px] text-text-2">
          No sealed day in the window yet — the machine snaps only to days that were actually
          sealed, and none was. Nothing is interpolated.
        </p>
      ) : (
        <>
          <div className="flex items-baseline justify-between">
            <p className="font-mono text-[14px] font-semibold leading-[20px] text-text">{label}</p>
            <p className="font-mono text-[11px] leading-[16px] text-text-3">
              {snaps.length} sealed day{snaps.length === 1 ? "" : "s"} in the window
              {timeline.unreadable > 0 ? ` · ${timeline.unreadable} unreadable (excluded)` : ""}
            </p>
          </div>
          <input
            type="range"
            aria-label="Sealed day"
            min={0}
            max={Math.max(snaps.length - 1, 0)}
            value={Math.min(index, snaps.length - 1)}
            onChange={(e) => setIndex(Number(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between font-mono text-[10.5px] leading-[16px] text-text-3">
            <span>{snaps[0]?.day}</span>
            <span>{snaps[snaps.length - 1]?.day} (latest)</span>
          </div>
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        {diffs.map((d) => (
          <div key={d.label} className="flex flex-col gap-1 rounded-md border border-line bg-surface p-3">
            <p className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-text-3">
              {d.label}
            </p>
            <p className="font-mono text-[16px] leading-[22px] text-text">
              {d.chosen === null ? "—" : d.chosen.toLocaleString("en-US") + d.unit}
            </p>
            <p className="font-mono text-[11px] leading-[16px]" style={{ color: "var(--text-2)" }}>
              {d.delta === null
                ? "no sealed comparison"
                : `${d.delta === 0 ? "±0" : d.delta > 0 ? "+" : ""}${d.delta.toLocaleString("en-US")}${d.unit} vs latest`}
            </p>
          </div>
        ))}
      </div>

      {chosen?.moneyWithheld ? (
        <p className="font-sans text-[12px] leading-[17px]" style={{ color: "var(--warn)" }}>
          Money stats withheld on this day: {chosen.withheldReason ?? "the sealed run withheld them"} —
          the seal says so, and the machine does not guess.
        </p>
      ) : null}

      <p className="font-mono text-[10.5px] leading-[16px] text-text-3">
        snapshots are immutable · the board you see is the board that was
      </p>
    </div>
  )
}
