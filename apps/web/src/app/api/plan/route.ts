import { NextResponse } from "next/server"
import type { Pool, PoolClient } from "pg"

import { handlePlanRun } from "@sentinel/plan-service"
import { makePlanAdapter, pgDriver } from "@sentinel/db"

/*
 * POST /api/plan — the HTTP transport for the engine-live run (delivery spec
 * §6.3 M2; the D-022 carve-out). Semantics live in plan-service.handlePlanRun:
 *   200 SEALED / REPLAYED · 400 request-shape · 422 data-health refusal ·
 *   500 wiring error. This file owns ONLY transport concerns:
 *
 *   - one pooled pg client per request; the whole run (input reads + seal
 *     write) is ONE transaction, scoped by a transaction-local
 *     set_config('app.tenant_id', …, true) — the ADR-0002 RLS fence. The
 *     GUC dies with the transaction, so a pooled connection never leaks a
 *     tenant scope into the next request.
 *   - DATABASE_URL must connect as a NOBYPASSRLS role (sentinel_app in
 *     production). FORCE (ADR-0002) binds owners too, but the deployment
 *     contract is the app role.
 *   - Tenant identity comes from the request body as the declared interim;
 *     authenticated identity (session → tenant) lands with C3 SoD in M3
 *     and replaces this field at the boundary, not inside the service.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const g = globalThis as typeof globalThis & { __sentinelPlanPool?: Pool }

function getPool(): Pool {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      "DATABASE_URL is not configured — the plan route cannot reach PostgreSQL. " +
      "This is a deployment wiring error, not a data refusal."
    )
  }
  if (!g.__sentinelPlanPool) {
    g.__sentinelPlanPool = new (pgDriver().Pool)({ connectionString: url, max: 4 })
  }
  return g.__sentinelPlanPool
}

export async function POST(request: Request) {
  /* A malformed body reaches handlePlanRun as null and comes back as a 400
   * INVALID_REQUEST receipt — the service owns request semantics. */
  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }

  /* The tenant must be known BEFORE the transaction opens (the GUC and the
   * adapter both bind to it). Absent/empty → 400 without touching the pool. */
  const tenantId = (body as { tenantId?: unknown } | null)?.tenantId
  if (typeof tenantId !== "string" || tenantId === "") {
    return NextResponse.json(
      {
        verdict: "REFUSED",
        reason: "INVALID_REQUEST",
        detail: "tenantId (non-empty string) is required to open the tenant-scoped transaction",
      },
      { status: 400 }
    )
  }

  let pool: Pool
  try {
    pool = getPool()
  } catch (e) {
    return NextResponse.json(
      { verdict: "ERROR", message: (e as Error).message },
      { status: 500 }
    )
  }

  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (e) {
    return NextResponse.json(
      { verdict: "ERROR", message: `could not acquire a database client: ${(e as Error).message}` },
      { status: 500 }
    )
  }

  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
    const receipt = await handlePlanRun(body, makePlanAdapter(client, tenantId))
    await client.query("COMMIT")
    return NextResponse.json(receipt.json, { status: receipt.status })
  } catch (e) {
    try {
      await client.query("ROLLBACK")
    } catch {
      /* the connection is already broken — release below returns it anyway */
    }
    return NextResponse.json(
      { verdict: "ERROR", message: (e as Error).message },
      { status: 500 }
    )
  } finally {
    client.release()
  }
}
