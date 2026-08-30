"use client"

import * as React from "react"

import { cn } from "./lib/utils"

/*
 * Segmented control — README §Layout shell: "2px padding, radius 6, --raised
 * background, 1px --line; the active segment gets --hover fill, radius 4,
 * --text label; inactive labels --text-3." Used for the top bar's currency
 * and density controls.
 */
function Segmented({
  options,
  value,
  onValueChange,
  ariaLabel,
  disabled,
  className,
}: {
  options: readonly { value: string; label: string }[]
  value: string
  onValueChange?: (value: string) => void
  ariaLabel: string
  disabled?: boolean
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn(
        "inline-flex h-[30px] shrink-0 items-center rounded-sm border border-line bg-raised p-[2px]",
        disabled && "opacity-60",
        className
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => !active && onValueChange?.(opt.value)}
            className={cn(
              "inline-flex h-full items-center rounded-[4px] px-2.5 font-sans text-[12px] leading-none transition-colors duration-100 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info",
              active ? "bg-hover text-text" : "text-text-3 hover:text-text-2"
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export { Segmented }
