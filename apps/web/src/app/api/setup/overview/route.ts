import { getSentinelPool } from "../../../../lib/pg"
import { resolveRequestSession, unauthorized } from "../../../../lib/auth-server"
import { makeSetupBoundary, setupGuards, invalidRequest } from "../../../../lib/setup-server"

/*
 * GET /api/setup/overview — the wizard's state machine input (§14.28
 * clause 4; D-049). Origin-only (the boundary gate; the database's own
 * policies re-prove every per-tenant read through the RLS the adapter
 * sets the GUCs for). The overview carries the honest first-run facts —
 * hasOrigin, tenantCount, the distinct userCount, per-tenant users,
 * limits and register state — and the /setup screen derives the
 * remainingSteps from it (the pure setup module's derivation; §14.10's
 * first-run states are DATA, never decoration).
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
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

  try {
    const setup = makeSetupBoundary(pool)
    const overview = await setup.setupOverview({ actorId: resolved.session.userId })
    return Response.json({ verdict: "OK", overview })
  } catch (e) {
    return Response.json({ verdict: "ERROR", phase: "SETUP", message: (e as Error).message }, { status: 500 })
  }
}

// POST /api/setup/overview is not a thing — the wrong-method refusal keeps
// the shape honest.
export async function POST() {
  return invalidRequest("the overview is a read — GET it; commands ride their own doors")
}
