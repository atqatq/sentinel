import * as React from "react"

import { cn } from "./lib/utils"

/*
 * Page header — README §Layout shell: "24px page padding, then eyebrow
 * (section label style, reading <Group> · <Tenant>), screen title (22/28,
 * 600), and a one-or-two-sentence subhead at 13px --text-2, max-width: 88ch,
 * text-wrap: pretty. Screen-specific actions sit right-aligned and
 * baseline-aligned with the block." Eyebrow uses the section-label role
 * (11/14, 600, +0.06em uppercase, --text-3).
 */
function PageHeader({
  eyebrow,
  title,
  subhead,
  actions,
  className,
}: {
  eyebrow: string
  title: string
  subhead?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="page-header"
      className={cn("flex items-baseline justify-between gap-6", className)}
    >
      <div className="min-w-0">
        <p className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-text-3">
          {eyebrow}
        </p>
        <h1 className="mt-2 font-sans text-[22px] font-semibold leading-[28px] tracking-[-0.011em] text-text">
          {title}
        </h1>
        {subhead ? (
          <div className="mt-2 max-w-[88ch] font-sans text-[13px] leading-[20px] text-text-2 [text-wrap:pretty]">
            {subhead}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export { PageHeader }
