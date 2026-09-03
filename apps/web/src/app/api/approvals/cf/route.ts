import { NextResponse } from "next/server"
import type { Pool, PoolClient } from "pg"

import { handleCfDecision } from "@sentinel/procure-service"
import { makeProcureAdapter, makeLedgerAdapter } from "@sentinel/db"

import { getSentinelPool } from "../../../../lib/pg"
import { resolveRequestSession, unauthorized } from "../../../../lib/auth-server"

/*
 * POST /api/approvals/cf — the transport for the §14.13b conversion-factor
 * decision gate (build spec §14.13c, D-036's scheduled follow-on).
 * Semantics live in procure-service.handleCfDecision (HTTP-agnostic):
 *   200 APPLIED/REJECTED receipt · 400 request-shape · 403 gate denial with
 *   its Class-D record · 404 CF_VERSION_NOT_FOUND · 500 wiring. This file
 *   owns ONLY transport concerns:
 *
 *   - IDENTITY IS THE SESSION'S (M11): a body-carried tenantId or actor is
 *     the plan route's retired interim and refuses by name — the boundary
 *     decides whose hand is on the decision, and it is never the caller's
 *     claim. The session's actor envelope is MERGED into the service request
 *     (the plan route's pattern).
 *   - one pooled pg client per request; the whole decision (the version
 *     read, the gate, the denial record, the freeze door, the re-derivation
 *     tasks) is ONE transaction, scoped by the GUC trio (ADR-0002): a failed
 *     denial-record write rolls the decision back with it (§16.3 rule 2).
 *   - the ledger door is ARMED only when the deployment carries the
 *     secret-manager HMAC key + the session's envelope — a Class-D denial
 *     never leaves no trace (§16.1); UNARMED the service refuses loudly
 *     (500), the route never strips the requirement.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }

  /* The retired interim, refused by name at the transport (the plan route's
   * posture): identity never rides the body. */
  const carried = body as { tenantId?: unknown; actor?: unknown } | null
  if (carried && (carried.tenantId !== undefined || carried.actor !== undefined)) {
    return NextResponse.json(
      {
        verdict: "REFUSED",
        reason: "IDENTITY_NOT_CARRIED",
        detail: "tenantId/actor are retired from the request body (M11) — identity comes from the session; sign in and let the boundary bind it",
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

    const procure = makeProcureAdapter(client, session.tenantId)

    /* the ledger door: armed only by the deployment key + the session's
     * envelope (an anonymous denial record cannot exist) — UNARMED the
     * service refuses loudly and the transaction rolls back with it */
    const ledgerKey = process.env.SENTINEL_LEDGER_HMAC_KEY
    const ledger = ledgerKey
      ? makeLedgerAdapter(client, session.tenantId, {
          hmacKey: ledgerKey,
          actor: session.userId,
          role: session.role,
        })
      : undefined

    const receipt = await handleCfDecision(
      {
        actor: { userId: session.userId, role: session.role },
        versionId: (body as { versionId?: string } | null)?.versionId ?? undefined,
        decision: (body as { decision?: string } | null)?.decision ?? undefined,
        reason: (body as { reason?: string } | null)?.reason,
      },
      {
        loadCfVersion: procure.loadCfVersionById,
        loadLatestSeal: procure.loadLatestSealPayload,
        resolveCfVersion: procure.resolveCfVersion,
        ledger,
      }
    )

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
