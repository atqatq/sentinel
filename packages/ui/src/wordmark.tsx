import * as React from "react"

import { cn } from "./lib/utils"

/*
 * Wordmark — README §Layout shell item 1, verbatim: an 18×18 --brand square
 * at radius 5, gap 9, "SENTINEL" in IBM Plex Sans 13px/600 caps at +0.18em.
 * The wide tracking is what makes it read as a mark rather than a heading;
 * do not tighten it (README §Typography). Brand green is a brand moment —
 * never a button colour, never in a data context.
 */
function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-[9px]", className)}>
      <span aria-hidden="true" className="size-[18px] shrink-0 rounded-[5px] bg-brand" />
      <span className="text-[13px] font-semibold uppercase leading-none tracking-[0.18em] text-text">
        Sentinel
      </span>
    </span>
  )
}

export { Wordmark }
