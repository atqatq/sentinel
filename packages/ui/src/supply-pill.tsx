import * as React from "react"

import { cn } from "./lib/utils"
import type { StatusTone } from "./status"

/*
 * SDS supply-status pill — the square counterpart in the design handoff's
 * two-axis language (README §MRP Board, prototype `pill(label, tone, square)`):
 *   shape    square-cornered, radius 6 (inventory pills are round, radius 999)
 *   fill     transparent — never a status fill
 *   border   1px color-mix(in srgb, <token> 34%, transparent)
 *   marker   6px SQUARE (radius 0) in <token> — shape, not colour, separates
 *            the axes; an item can be healthy AND have a late PO
 *   type     JetBrains Mono 11.5px/500, height 22px, padding 0 9px (shared)
 *
 * The supply axis binds only through SupplyStatus (the vocabulary component);
 * this raw primitive exists so the recipe stays in packages/ui (A12).
 */
function SupplyPill({
  tone,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  tone: StatusTone
}) {
  const token = `var(--${tone})`

  return (
    <span
      data-slot="supply-pill"
      data-tone={tone}
      className={cn(
        "inline-flex h-[22px] w-fit shrink-0 items-center gap-[6px] rounded-sm border px-[9px] font-mono text-[11.5px] font-medium leading-none whitespace-nowrap",
        className
      )}
      style={{
        backgroundColor: "transparent",
        borderColor: `color-mix(in srgb, ${token} 34%, transparent)`,
        color: token,
        ...props.style,
      }}
      {...props}
    >
      <span
        aria-hidden="true"
        className="size-[6px] shrink-0"
        style={{ backgroundColor: token }}
      />
      {children}
    </span>
  )
}

export { SupplyPill }
