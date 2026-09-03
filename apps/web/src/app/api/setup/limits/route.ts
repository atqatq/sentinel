import { getSentinelPool } from "../../../../lib/pg"
import { resolveRequestSession, unauthorized } from "../../../../lib/auth-server"
import { makeSetupBoundary, setupGuards, invalidRequest } from "../../../../lib/setup-server"

/*
 * POST /api/setup/limits — the §16 amendment's setup-time command (§14.28
 * clause 4; D-049): the dual-control threshold and the per-role ceilings,
 * upserted through the EXISTING controls_origin_only policies (the adapter
 * sets the session tenant's GUCs inside its transaction — zero new SQL
 * authority). Origin-only at the boundary AND at the row level.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  let body: Record<string, unknown> = {}
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    body = {}
  }

  let pool
  try {
    pool = getSentinelPool()
  } catch (e) {
    return Response.json({ verdict: "ERROR", message: (e as Error).message }, { status: 500 })
  }

  const resolved = await resolveRequestSession(pool, request)
  if (!resolved.ok) return unauthorized(resolved.reason)
  const guard = setupGuards(resolved.session)
  if (guard) return guard

  if (typeof body.dualThresholdAmount !== "number") {
    return invalidRequest("dualThresholdAmount must be a number")
  }
  if (!Array.isArray(body.limits) || body.limits.length === 0) {
    return invalidRequest("limits must be a non-empty array of {role, maxSingleAmount}")
  }

  try {
    const setup = makeSetupBoundary(pool)
    const r = await setup.amendLimits({
      dualThresholdAmount: body.dualThresholdAmount as number,
      limits: body.limits as Array<{ role: string; maxSingleAmount: number | null }>,
      actorId: resolved.session.userId,
      tenantId: resolved.session.tenantId,
    })
    return Response.json({ verdict: "OK", ...r })
  } catch (e) {
    const err = e as Error & { code?: string }
    if (err.code && String(err.code).startsWith("SETUP_")) {
      return Response.json({ verdict: "REFUSED", reason: err.code, detail: err.message }, { status: 422 })
    }
    return Response.json({ verdict: "ERROR", phase: "SETUP", message: err.message }, { status: 500 })
  }
}
