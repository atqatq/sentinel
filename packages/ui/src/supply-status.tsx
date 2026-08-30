import * as React from "react"

import { SupplyPill } from "./supply-pill"
import { supplyTone, type SupplyStatusLabel } from "./status"

/*
 * SupplyStatus — the ONLY way a screen renders the supply axis (build spec
 * §3.1: independent and additive; the shape language — square, outlined —
 * keeps the axes from blurring). Tone resolution is fail-closed through the
 * vocabulary; an unknown status THROWS (ui/status-vocabulary-binding).
 */
function SupplyStatus({
  status,
  className,
}: {
  status: SupplyStatusLabel | (string & {})
  className?: string
}) {
  return (
    <SupplyPill tone={supplyTone(status)} className={className}>
      {status}
    </SupplyPill>
  )
}

export { SupplyStatus }
