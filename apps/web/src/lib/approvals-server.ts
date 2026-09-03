import type { Pool, PoolClient } from "pg"

import { makeProcureAdapter, resolveTenantByCode } from "@sentinel/db"

import {
  composeApprovalTray,
  type TrayFacts,
  type PendingCfVersion,
} from "./approvals"

/*
 * readApprovalTray — the ONE server-side reader for the §14.13c approvals
 * tray. The /approvals screen renders from THIS function, so the tray always
 * shows the same queue the decide/apply API consumes (the data-health
 * reader's posture: one source, no drift).
 *
 * Transaction fence (ADR-0002): the tenant CODE resolves to its uuid via
 * the registry lookup (above the fence by design), then ONE transaction
 * carries a transaction-local set_config('app.tenant_id', …, true) so RLS
 * fences the read; the GUC dies with the transaction, so a pooled connection
 * never leaks a scope.
 */

export type ApprovalTrayRead =
  | { ok: true; tray: TrayFacts }
  | { ok: false; phase: "POOL" | "TENANT" | "DB"; message: string }

export async function readApprovalTray(pool: Pool, tenantCode: string): Promise<ApprovalTrayRead> {
  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (e) {
    return { ok: false, phase: "POOL", message: `could not acquire a database client: ${(e as Error).message}` }
  }

  try {
    await client.query("BEGIN")

    const tenant = await resolveTenantByCode(client, tenantCode)
    if (!tenant) {
      await client.query("ROLLBACK")
      return { ok: false, phase: "TENANT", message: `tenant '${tenantCode}' is not in the registry` }
    }

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id])

    const procure = makeProcureAdapter(client, tenant.id)
    const rows: PendingCfVersion[] = await procure.listPendingCfVersions()
    const tray = composeApprovalTray(rows)

    await client.query("COMMIT")
    return { ok: true, tray }
  } catch (e) {
    try {
      await client.query("ROLLBACK")
    } catch {
      /* the connection is already broken — release below returns it anyway */
    }
    return { ok: false, phase: "DB", message: (e as Error).message }
  } finally {
    client.release()
  }
}
