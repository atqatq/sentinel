import * as React from "react"

import { cn } from "./lib/utils"

/*
 * Top bar — README §Layout shell, verbatim: "sticky, z-index: 60, --surface
 * background, 1px --line-strong bottom border, height 52px, horizontal
 * padding 16, gap 16." Contents left to right: wordmark cluster, menubar,
 * flexible spacer, then the context controls (search trigger, tenant
 * switcher, currency + density segmented controls, theme toggle, avatar).
 * The bar is layout; the controls are composable children/slots.
 */
function TopBar({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <header
      data-slot="top-bar"
      className={cn(
        "sticky top-0 z-60 flex h-[52px] items-center gap-4 border-b border-line-strong bg-surface px-4",
        className
      )}
    >
      {children}
    </header>
  )
}

/* The flexible spacer between the menubar and the context controls. */
function TopBarSpacer({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("min-w-4 flex-1", className)} />
}

export { TopBar, TopBarSpacer }
