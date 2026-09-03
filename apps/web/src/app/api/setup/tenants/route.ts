import { getSentinelPool } from "../../../../lib/pg"
import { resolveRequestSession, unauthorized } from "../../../../lib/auth-server"
import { makeSetupBoundary, setupGuards, invalidRequest } from "../../../../lib/setup-server"

/*
 * POST /api/setup/tenants — the founder door's transport (§14.28 clause 3;
 * D-049). Origin-only at the boundary; the SECURITY DEFINER door re-proves
 * is_origin at the row level (the API+DB pair — the boundary gate is never
 * the only gate). The response carries the new tenant's id and code; the
 * door's refusals surface verbatim (SETUP_TENANT_CODE_TAKEN,
 * SETUP_SHAPE_INVALID, SETUP_NOT_ORIGIN).
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

  const required = ["code", "name", "currencyCode", "timezone"] as const
  for (const k of required) {
    if (typeof body[k] !== "string" || (body[k] as string).trim() === "") {
      return invalidRequest(`${k} is required`)
    }
  }

  try {
    const setup = makeSetupBoundary(pool)
    const r = await setup.createTenant({
      code: body.code as string,
      name: body.name as string,
      currencyCode: body.currencyCode as string,
      timezone: body.timezone as string,
      actorId: resolved.session.userId,
    })
    return Response.json({ verdict: "OK", tenant: r })
  } catch (e) {
    const err = e as Error & { code?: string }
    if (err.code && String(err.code).startsWith("SETUP_")) {
      return Response.json({ verdict: "REFUSED", reason: err.code, detail: err.message }, { status: 422 })
    }
    return Response.json({ verdict: "ERROR", phase: "SETUP", message: err.message }, { status: 500 })
  }
}
