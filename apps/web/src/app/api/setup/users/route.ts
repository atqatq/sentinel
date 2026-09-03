import { getSentinelPool } from "../../../../lib/pg"
import { resolveRequestSession, unauthorized } from "../../../../lib/auth-server"
import { makeSetupBoundary, setupGuards, invalidRequest } from "../../../../lib/setup-server"

/*
 * POST /api/setup/users — account + credential + role grant in ONE
 * transaction (§14.28 clause 4; D-049). Origin-only at the boundary; the
 * database's own controls_origin_only re-proves the acting Origin's O on
 * the grant (the transaction sets the target tenant's GUCs — 42501
 * surfaces as SETUP_TARGET_NOT_OWNED). Every setup-created account lands
 * must_change — the user changes their own password at first sign-in; the
 * password strength is the pure policy floor's decision (the adapter runs
 * it before any statement).
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

  const required = ["email", "displayName", "password", "role", "tenantCode"] as const
  for (const k of required) {
    if (typeof body[k] !== "string" || (body[k] as string).trim() === "") {
      return invalidRequest(`${k} is required`)
    }
  }

  try {
    const setup = makeSetupBoundary(pool)
    const r = await setup.createUserWithRole({
      email: body.email as string,
      displayName: body.displayName as string,
      password: body.password as string,
      role: body.role as string,
      tenantCode: body.tenantCode as string,
      actorId: resolved.session.userId,
    })
    return Response.json({ verdict: "OK", user: r })
  } catch (e) {
    const err = e as Error & { code?: string }
    if (err.code && (String(err.code).startsWith("SETUP_") || String(err.code).startsWith("AUTH_PASSWORD_"))) {
      return Response.json({ verdict: "REFUSED", reason: err.code, detail: err.message }, { status: 422 })
    }
    return Response.json({ verdict: "ERROR", phase: "SETUP", message: err.message }, { status: 500 })
  }
}
