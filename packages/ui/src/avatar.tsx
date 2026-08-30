import * as React from "react"

import { cn } from "./lib/utils"

/*
 * Avatar — README §Layout shell item 9: a 26px circle, #2A6FA6 fill,
 * initials in IBM Plex Sans 10.5/500. (The fill is the handoff's literal
 * demo value; it is a chrome colour, not a status or brand token.)
 */
function Avatar({ initials, className }: { initials: string; className?: string }) {
  return (
    <span
      data-slot="avatar"
      className={cn(
        "inline-flex size-[26px] shrink-0 items-center justify-center rounded-full font-sans text-[10.5px] font-medium leading-none text-[#E8EBED]",
        className
      )}
      style={{ backgroundColor: "#2A6FA6" }}
      aria-label={initials}
    >
      {initials}
    </span>
  )
}

export { Avatar }
