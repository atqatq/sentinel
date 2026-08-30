"use client"

import * as React from "react"

import { cn } from "./lib/utils"
import { MENUBAR_GROUPS, type MenubarGroup } from "./menubar-data"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu"

/*
 * Menubar — README §Layout shell, verbatim behaviour:
 *   - 8 groups, each a 30px-tall ghost button that opens a dropdown on click
 *   - once any menu is open, hovering a sibling switches to it (standard
 *     menubar behaviour); Escape and any outside click close it (Radix)
 *   - the group button reads --text when the current screen belongs to that
 *     group, otherwise --text-2; the open group takes a --hover fill
 *   - dropdown panel: 36px below the trigger, z-index 80, min-width 264px,
 *     6px padding, --raised, 1px --line-strong, radius 10, popover shadow,
 *     entering with a 120ms fade-and-4px-rise
 *   - items: 13px, 7px 9px padding, radius 6, --hover fill when current;
 *     screens without an implementation carry a right-aligned mono 10px
 *     EMPTY tag in --text-3
 *
 * `currentRoute` selects the highlighted group; with no implemented screens
 * there is no current group (every button reads --text-2), which is the
 * honest scaffold state.
 */
function Menubar({
  groups = MENUBAR_GROUPS,
  currentRoute,
  className,
}: {
  groups?: readonly MenubarGroup[]
  /** Route of the screen the user is on; null while nothing is implemented. */
  currentRoute?: string | null
  className?: string
}) {
  const [openLabel, setOpenLabel] = React.useState<string | null>(null)

  const activeGroup = React.useMemo(
    () =>
      currentRoute
        ? groups.find((g) => g.entries.some((entry) => entry.route === currentRoute)) ?? null
        : null,
    [groups, currentRoute]
  )

  return (
    <nav
      aria-label="Main menu"
      className={cn("flex min-w-0 items-center gap-1", className)}
      onKeyDown={(ev) => {
        if (ev.key === "Escape") setOpenLabel(null)
      }}
    >
      {groups.map((group) => {
        const open = openLabel === group.label
        const isActive = activeGroup?.label === group.label
        return (
          <DropdownMenu
            key={group.label}
            open={open}
            onOpenChange={(next) => setOpenLabel(next ? group.label : null)}
          >
            <DropdownMenuTrigger
              onMouseEnter={() => {
                if (openLabel !== null && openLabel !== group.label) setOpenLabel(group.label)
              }}
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "inline-flex h-[30px] shrink-0 items-center rounded-sm px-2.5 font-sans text-[13px] leading-none outline-none transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info",
                open ? "bg-hover" : "hover:bg-hover",
                (isActive || open) ? "text-text" : "text-text-2"
              )}
            >
              {group.label}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={6}>
              {group.entries.map((entry) => {
                const current = entry.route !== null && entry.route === currentRoute
                return (
                  <DropdownMenuItem
                    key={entry.label}
                    disabled={entry.route === null}
                    className={cn(current && "bg-hover")}
                  >
                    <span className="truncate">{entry.label}</span>
                    {entry.route === null ? (
                      <span
                        aria-hidden="true"
                        className="ml-auto shrink-0 pl-3 font-mono text-[10px] leading-none text-text-3"
                      >
                        EMPTY
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      })}
    </nav>
  )
}

export { Menubar }
