"use client"

import * as React from "react"

/*
 * Stale-data banner — README §Layout shell, verbatim: "below the top bar
 * when the newest ingest is older than one day: color-mix(--warn 12%) fill,
 * color-mix(--warn 26%) top border, 7px 16px padding, a 6px --warn dot, and
 * copy naming the exact timestamp: 'Precoro export is 2 days old —
 * `2026-08-27 06:14`. Figures may be stale.' Dismissible."
 *
 * Staleness is never silent: the banner names the exact age and timestamp.
 * The primitive takes the precomputed facts (daysOld, sinceDisplay) from its
 * caller — computing "now" is the freshness layer's job (M9), not a render
 * concern, and keeping the clock out of the primitive keeps it testable.
 */
function StaleBanner({
  daysOld,
  sinceDisplay,
  onDismiss,
  className,
}: {
  daysOld: number
  /** Exact timestamp rendered into the copy (the caller formats it). */
  sinceDisplay: string
  onDismiss?: () => void
  className?: string
}) {
  return (
    <div
      role="status"
      data-slot="stale-banner"
      className={
        "flex items-center gap-2.5 px-4 py-[7px] " + (className ?? "")
      }
      style={{
        backgroundColor: "color-mix(in srgb, var(--warn) 12%, transparent)",
        borderTop: "1px solid color-mix(in srgb, var(--warn) 26%, transparent)",
      }}
    >
      <span
        aria-hidden="true"
        className="size-[6px] shrink-0 rounded-full"
        style={{ backgroundColor: "var(--warn)" }}
      />
      <p className="font-sans text-[13px] leading-[18px] text-text">
        Precoro export is {daysOld} {daysOld === 1 ? "day" : "days"} old —{" "}
        <span className="font-mono text-[12px]">{sinceDisplay}</span>. Figures may be stale.
      </p>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss stale-data banner"
          className="ml-auto inline-flex size-[22px] shrink-0 items-center justify-center rounded-sm text-[13px] leading-none text-text-3 hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
        >
          ✕
        </button>
      ) : null}
    </div>
  )
}

export { StaleBanner }
