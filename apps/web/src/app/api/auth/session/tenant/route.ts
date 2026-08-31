import { makeAuthAdapter, resolveTenantByCode } from "@sentinel/db"

import { getSentinelPool } from "../../../../../lib/pg"
import { readSessionCookie, unauthorized } from "../../../../../lib/auth-server"

/*
 * PUT /api/auth/session/tenant — the tenant switcher's lawful door (M11).
 * The session's tenant is DATA the boundary controls: a user moves to a
 * tenant where they hold an ACTIVE tenant_role; Origin moves anywhere
 * (§10.1 supremacy — logged like anyone else). The tenant CODE arrives
 * from the switcher, resolves through the registry lookup (above the
 * fence by design), and the move is one tombstone-safe UPDATE.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function PUT(request: Request) {
  let body: { tenantCode?: unknown } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    body = {}
  }
  const tenantCode = typeof body.tenantCode === "string" ? body.tenantCode.trim() : ""
  if (!tenantCode) {
    return Response.json(
      { verdict: "REFUSED", reason: "INVALID_REQUEST", detail: "tenantCode is required" },
      { status: 400 }
    )
  }

  const pool = getSentinelPool()
  const wrapKey = process.env.SESSION_WRAP_KEY || ""
  if (wrapKey.length < 32) {
    return Response.json({ verdict: "ERROR", message: "SESSION_WRAP_KEY is not configured." }, { status: 500 })
  }

  const token = readSessionCookie(request)
  if (!token) return unauthorized("SESSION_REQUIRED")

  const auth = makeAuthAdapter(
    { query: (text: string, values?: unknown[]) => pool.query(text, values as never[]) },
    { wrapKey }
  )

  const resolved = await auth.resolveSession(token)
  if (!resolved.resolved || !resolved.session) {
    return unauthorized(resolved.reason || "AUTH_SESSION_UNKNOWN")
  }
  const session = resolved.session

  const tenant = await resolveTenantByCode(
    { query: (text: string, values?: unknown[]) => pool.query(text, values as never[]) },
    tenantCode
  )
  if (!tenant) {
    return Response.json({ verdict: "REFUSED", reason: "UNKNOWN_TENANT" }, { status: 404 })
  }

  if (!session.isOrigin) {
    const member = await auth.hasTenantRole(session.userId, tenant.id)
    if (!member) {
      return Response.json(
        { verdict: "REFUSED", reason: "AUTH_TENANT_FORBIDDEN", detail: "no active tenant_role in that tenant" },
        { status: 403 }
      )
    }
  }

  const moved = await auth.setSessionTenant(token, tenant.id)
  return Response.json({ verdict: "OK", moved: moved.moved, tenantCode: tenant.code })
}
