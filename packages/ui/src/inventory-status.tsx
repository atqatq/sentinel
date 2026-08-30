import * as React from "react"

import { StatusPill } from "./status-pill"
import { inventoryTone, type InventoryStatusLabel } from "./status"

/*
 * InventoryStatus — the ONLY way a screen renders the inventory axis.
 *
 * Takes the engine's displayStatus output (delivery spec §8: the vocabulary
 * binds ONLY to displayStatus; raw ladder status is never rendered) and
 * resolves the tone through the fail-closed vocabulary. An unknown status
 * THROWS — it must never render as a neutral pill (ui/status-vocabulary-
 * binding; a status that cannot be bound is a contract violation, and the
 * parity test in test/status.test.ts holds this file against the real
 * engine exports).
 */
function InventoryStatus({
  status,
  className,
}: {
  status: InventoryStatusLabel | (string & {})
  className?: string
}) {
  return (
    <StatusPill tone={inventoryTone(status)} className={className}>
      {status}
    </StatusPill>
  )
}

export { InventoryStatus }
