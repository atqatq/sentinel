import * as React from "react"

import { cn } from "./lib/utils"

/*
 * Tenant switcher — README §Layout shell item 5: a 6px --brand dot plus the
 * tenant code in mono 12px. The brand dot is a brand moment (tenant
 * identity), not a status colour. Cycling BahrainMP ⇄ QatarMP arrives with
 * the tenant-context unit; the primitive renders the current tenant.
 */
function TenantSwitcher({
  tenantCode,
  className,
}: {
  tenantCode: string
  className?: string
}) {
  return (
    <span
      data-slot="tenant-switcher"
      className={cn("inline-flex shrink-0 items-center gap-2", className)}
    >
      <span aria-hidden="true" className="size-[6px] shrink-0 rounded-full bg-brand" />
      <span className="font-mono text-[12px] leading-none text-text">{tenantCode}</span>
    </span>
  )
}

export { TenantSwitcher }
