import type { Pool } from "pg"

import { makeAuthAdapter } from "@sentinel/db"

/*
 * auth-server — the ONE server-side session resolver for the API routes
 * (the plan-adapter lesson: one source, no drift). The boundary contract
 * the D-023/D-029 interim retirement promised:
 *
 *   - the session rides an httpOnly cookie (the bearer token NEVER lands
 *     in a database statement — the adapter stores only its SHA-256);
 *   - resolveSession reads by hash, decides the lifecycle state (the pure
 *     auth module — §14.9's 30-min idle / 8-h absolute floor for every
 *     principal), and touches last_seen_at on the live path;
 *   - the route then opens its own transaction and sets the GUC trio:
 *       app.tenant_id  — the ADR-0002 fence (transaction-local, dies at COMMIT)
 *       app.actor_id   — the D-029 identity fence (sod_binding binds approvals)
 *       app.mfa_ok     — the M11 second-factor verdict (mfa_gate binds votes)
 *     all transaction-local, so pooled connections never leak a scope or a
 *     principal.
 *
 * The HMAC wrap key is injected from the environment at this boundary —
 * the auth adapter owns no secrets (the H5 key posture). SESSION_WRAP_KEY
 * must be 32+ chars; a deployment without it fails loudly at the boundary,
 * never silently unencrypted.
 */

export const SESSION_COOKIE = "sentinel_session"

export type SessionEnvelope = {
  sessionId: string
  userId: string
  tenantId: string
  role: string
  mfaOk: boolean
  isOrigin?: boolean
  tenantCode?: string
}

export type ResolvedSession =
  | { ok: true; session: SessionEnvelope }
  | { ok: false; status: 401; reason: string }

function wrapKey(): string {
  const key = process.env.SESSION_WRAP_KEY
  if (!key || key.length < 32) {
    throw new Error(
      "SESSION_WRAP_KEY is not configured (32+ chars required) — the auth boundary refuses to run without its injected keys."
    )
  }
  return key
}

export function makeAuthBoundary(pool: Pool) {
  return makeAuthAdapter(
    // The boundary's client is the shared pool itself: every auth statement
    // the routes make is a single-round-trip read/write, and the ONE
    // multi-statement atomic unit (attemptLogin) manages its own explicit
    // transaction on a dedicated pool client at the login route.
    pool,
    { wrapKey: wrapKey(), now: () => new Date() }
  )
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie") || ""
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="))
  }
  return null
}

export function sessionCookieHeader(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${8 * 60 * 60}`
}

export function clearedSessionCookieHeader(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`
}

/* Resolve the request's session to the envelope the routes fence with.
 * Every non-ACTIVE lifecycle state comes back named (401), never thrown. */
export async function resolveRequestSession(
  pool: Pool,
  request: Request
): Promise<ResolvedSession> {
  const token = readSessionCookie(request)
  if (!token) return { ok: false, status: 401, reason: "SESSION_REQUIRED" }
  try {
    const auth = makeAuthBoundary(pool)
    const r = await auth.resolveSession(token)
    if (r.resolved !== true) {
      return { ok: false, status: 401, reason: r.reason || "AUTH_SESSION_UNKNOWN" }
    }
    return {
      ok: true,
      session: {
        sessionId: r.session.sessionId,
        userId: r.session.userId,
        tenantId: r.session.tenantId,
        role: r.session.role,
        mfaOk: r.session.mfaOk,
        isOrigin: r.session.isOrigin,
        tenantCode: r.session.tenantCode,
      },
    }
  } catch (e) {
    return { ok: false, status: 401, reason: `AUTH_RESOLUTION_FAILED: ${(e as Error).message}` }
  }
}

export function unauthorized(reason: string) {
  return Response.json({ verdict: "REFUSED", reason }, { status: 401 })
}
