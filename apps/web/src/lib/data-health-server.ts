import type { Pool, PoolClient } from "pg"

import { makeDataHealthAdapter, resolveTenantByCode } from "@sentinel/db"
import { freshness as freshnessApi } from "@sentinel/module-ops"

import {
  composeDataHealthFacts,
  utcMonthStart,
  type DataHealthFacts,
} from "./data-health"

/*
 * readDataHealthFacts — the ONE server-side reader for the data-health
 * facts. The GET transport and the /data-health screen both call THIS
 * function, so the facts the HTTP API serves and the facts the screen
 * renders are byte-identical by construction (the plan-adapter lesson:
 * one source, no drift).
 *
 * This is the composition root: the real @sentinel/module-ops surface is
 * injected into the pure composition here (ADR-0001 — app consumption of
 * core modules rides the package public surface), and the clock is the
 * caller's asOfMs (transport-injected; nothing in the read path calls
 * Date()).
 *
 * Transaction fence (ADR-0002): the tenant CODE resolves to its uuid via
 * the registry lookup (above the fence by design), then ONE transaction
 * carries a transaction-local set_config('app.tenant_id', …, true) so
 * RLS fences every read; the GUC dies with the transaction, so a pooled
 * connection never leaks a scope.
 */

export type DataHealthRead =
  | { ok: true; facts: DataHealthFacts }
  | { ok: false; phase: "POOL" | "TENANT" | "DB"; message: string }

export async function readDataHealthFacts(
  pool: Pool,
  tenantCode: string,
  asOfMs: number,
  deliveriesCadenceHours?: number
): Promise<DataHealthRead> {
  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (e) {
    return {
      ok: false,
      phase: "POOL",
      message: `could not acquire a database client: ${(e as Error).message}`,
    }
  }

  try {
    const tenant = await resolveTenantByCode(client, tenantCode)
    if (!tenant) {
      return {
        ok: false,
        phase: "TENANT",
        message: `no tenant with code '${tenantCode}' exists — the tenant switcher's code is the display identity`,
      }
    }

    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id])

    const adapter = makeDataHealthAdapter(client, tenant.id)
    const stamps = await adapter.lastAppliedStampByKind()
    const tasks = await adapter.listOpenTasks()
    const closedThisMonth = await adapter.countResolvedSince(utcMonthStart(asOfMs))
    const ingestCounts = await adapter.countIngestFiles()

    /* Compose INSIDE the transaction: a composition throw (unknown severity,
     * unknown kind) rolls back a read-only run — nothing half-read ships. */
    const facts = composeDataHealthFacts({
      tenant: { code: tenant.code, name: tenant.name },
      asOfMs,
      stamps,
      tasks,
      closedThisMonth,
      ingestCounts,
      deps: freshnessApi,
      ...(deliveriesCadenceHours === undefined ? {} : { deliveriesCadenceHours }),
    })

    await client.query("COMMIT")
    return { ok: true, facts }
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
