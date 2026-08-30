import * as React from "react"

import { cn } from "./lib/utils"

/*
 * SDS status pill — implements the pill recipe in docs/design/README.md
 * §Status verbatim:
 *   fill  color-mix(in srgb, <token> 14%, transparent)
 *   text  <token>
 *   dot   6px, <token>
 *   height 22px · padding 0 9px · radius 999px · JetBrains Mono 11.5px/500
 *
 * The two-axis status vocabulary is semantic only (ok, warn, critical, info,
 * pending, muted). The pill's visible text is the label — colour is never
 * the sole carrier of meaning (dot is aria-hidden). Raw ladder status binds
 * to displayStatus before it reaches this component (M1 contract).
 */

export type StatusTone = "ok" | "warn" | "critical" | "info" | "pending" | "muted"

function StatusPill({
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
      data-slot="status-pill"
      data-tone={tone}
      className={cn(
        "inline-flex h-[22px] w-fit shrink-0 items-center gap-[6px] rounded-full px-[9px] font-mono text-[11.5px] font-medium leading-none whitespace-nowrap",
        className
      )}
      style={{
        backgroundColor: `color-mix(in srgb, ${token} 14%, transparent)`,
        color: token,
        ...props.style,
      }}
      {...props}
    >
      <span
        aria-hidden="true"
        className="size-[6px] shrink-0 rounded-full"
        style={{ backgroundColor: token }}
      />
      {children}
    </span>
  )
}

export { StatusPill }
