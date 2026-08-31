import { NextResponse } from "next/server"
import type { Pool, PoolClient } from "pg"

import { handlePlanRun } from "@sentinel/plan-service"
import { makePlanAdapter } from "@sentinel/db"

import { getSentinelPool } from "../../../lib/pg"
import { resolveRequestSession, unauthorized } from "../../../lib/auth-server"

/*
 * POST /api/plan — the HTTP transport for the engine-live run (delivery spec
 * §6.3 M2; the D-022 carve-out). Semantics live in plan-service.handlePlanRun:
 *   200 SEALED / REPLAYED · 400 request-shape · 401 session · 422 data-health
 *   refusal · 500 wiring error. This file owns ONLY transport concerns:
 *
 *   - one pooled pg client per request; the whole run (input reads + seal
 *     write) is ONE transaction, scoped by a transaction-local
 *     set_config('app.tenant_id', …, true) — the ADR-0002 RLS fence. The
 *     GUC dies with the transaction, so a pooled connection never leaks a
 *     tenant scope into the next request. The pool factory is the app's
 *     shared one (lib/pg) — one pool per process, not one per route.
 *   - DATABASE_URL must connect as a NOBYPASSRLS role (sentinel_app in
 *     production). FORCE (ADR-0002) binds owners too, but the deployment
 *     contract is the app role.
 *   - AUTHENTICATED IDENTITY (M11 — the D-023/D-029 interim retirement,
 *     delivered): the tenant comes from the SESSION (httpOnly cookie →
 *     user_session → tenant_id), resolved server-side before the
 *     transaction opens; the actor and the MFA verdict ride the same
 *     session into the GUC trio app.tenant_id / app.actor_id (the C3
 *     sod_binding fence) / app.mfa_ok (the mfa_gate policy on approvals).
 *     A body-carried tenantId is REFUSED BY NAME — the request no longer
 *     speaks for identity; it never will again.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  /* A malformed body reaches handlePlanRun as null and comes back as a 400
   * INVALID_REQUEST receipt — the service owns request semantics. */
  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }

  /* The interim is RETIRED: a body-carried tenantId refuses by name. */
  const carried = (body as { tenantId?: unknown } | null)?.tenantId
  if (typeof carried === "string" && carried !== "") {
    return NextResponse.json(
      {
        verdict: "REFUSED",
        reason: "SESSION_IDENTITY_REQUIRED",
        detail: "tenantId is retired from the request body (M11) — identity comes from the session; sign in and let the boundary bind it",
      },
      { status: 400 }
    )
  }

  const pool: Pool = getSentinelPool()

  /* the session resolves ABOVE the fence (it produces the fence's value) */
  const resolved = await resolveRequestSession(pool, request)
  if (!resolved.ok) return unauthorized(resolved.reason)
  const session = resolved.session

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
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [session.tenantId])
    await client.query("SELECT set_config('app.actor_id', $1, true)", [session.userId])
    await client.query("SELECT set_config('app.mfa_ok', $1, true)", [session.mfaOk ? "true" : "false"])
    /* the service stays tenant-explicit — the boundary decides where the
     * tenant's name comes from (the session, no longer the request body) */
    const request2 =
      body !== null && typeof body === "object"
        ? { ...(body as Record<string, unknown>), tenantId: session.tenantId }
        : { tenantId: session.tenantId }
    /* The M8 restatement door (§14.16): armed only when the deployment
     * carries the secret-manager HMAC key — the actor/role envelope is the
     * SAME authenticated session the GUCs carry (an anonymous restatement
     * cannot exist). UNARMED, a restatement request fails loudly at the
     * service boundary (a named wiring error), never silently ignored. */
    const ledgerKey = process.env.SENTINEL_LEDGER_HMAC_KEY
    const ports = makePlanAdapter(
      client,
      session.tenantId,
      ledgerKey
        ? {
            ledger: {
              hmacKey: ledgerKey,
              actor: session.userId,
              role: session.role,
            },
          }
        : undefined
    )
    const receipt = await handlePlanRun(request2, ports)
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
