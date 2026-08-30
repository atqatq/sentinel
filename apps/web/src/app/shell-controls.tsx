"use client"

import * as React from "react"

import { Segmented } from "@sentinel/ui/segmented"

/*
 * Density control — app wiring for the README §Layout shell item 7. The
 * segmented primitive is vendored (packages/ui); setting the cascade root
 * attribute [data-sds-density] is app state, exactly like ThemeToggle does
 * for [data-sds-theme]. This is composition, not a primitive copy
 * (ui/no-primitives-outside-packages-ui stays clean).
 */
export function DensityControl() {
  const [density, setDensity] = React.useState<"comfortable" | "compact">("comfortable")

  React.useEffect(() => {
    const current = document.documentElement.getAttribute("data-sds-density")
    if (current === "compact" || current === "comfortable") setDensity(current)
  }, [])

  return (
    <Segmented
      ariaLabel="Table density"
      value={density}
      onValueChange={(v) => {
        const next = v === "compact" ? "compact" : "comfortable"
        setDensity(next)
        document.documentElement.setAttribute("data-sds-density", next)
      }}
      options={[
        { value: "comfortable", label: "Comfortable" },
        { value: "compact", label: "Compact" },
      ]}
    />
  )
}
