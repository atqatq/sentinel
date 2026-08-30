import * as React from "react"

import { cn } from "./lib/utils"

/*
 * Search trigger — README §Layout shell item 4: 30px tall, --raised,
 * 1px --line-strong, radius 6, "Search" at 12.5px --text-3 plus "⌘K" in
 * mono 11px. Opens the command palette — the palette itself is the
 * Command Center unit's deliverable; until it lands this renders the
 * trigger per spec and does not pretend to work.
 */
function SearchTrigger({
  onClick,
  className,
}: {
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Search (Command palette, Control K)"
      className={cn(
        "inline-flex h-[30px] shrink-0 items-center gap-2 rounded-sm border border-line-strong bg-raised px-2.5 outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info",
        className
      )}
    >
      <span className="font-sans text-[12.5px] leading-none text-text-3">Search</span>
      <span className="font-mono text-[11px] leading-none text-text-3">⌘K</span>
    </button>
  )
}

export { SearchTrigger }
