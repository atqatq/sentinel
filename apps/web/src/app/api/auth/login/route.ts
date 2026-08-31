import { makeAuthAdapter } from "@sentinel/db"
import type { PoolClient } from "pg"

import { getSentinelPool } from "../../../../lib/pg"
import { sessionCookieHeader } from "../../../../lib/auth-server"

/*
 * POST /api/auth/login — the sign-in transport (M11; audit M11 fix; build
 * spec §16.1 Class N). This file owns ONLY transport: the decisions are
 * the pure auth module's (via the adapter composition), the statements are
 * the auth adapter's, the database re-proves what it can (login_attempt is
 * append-only; the mfa_gate policy holds every approval vote until the
 * session carries a proven second factor).
 *
 * Two-step by design (the stateless challenge — D-031):
 *   POST {email, password}        → CHALLENGE_MFA | ISSUE | REFUSED
 *   POST {email, password, code}  → the MFA step (this same route; the
 *     credentials are re-verified — the server keeps no challenge state)
 *
 * The adapter's attemptLogin owns the ONE multi-statement atomic unit of
 * the auth layer (attempts + Class-N emissions + issuance live or die
 * together, §16.3 rule 2) on a dedicated pool client.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  let body: { email?: unknown; password?: unknown; code?: unknown } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    body = {}
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  const password = typeof body.password === "string" ? body.password : ""
  const code = typeof body.code === "string" ? body.code : null
  if (!email || !password) {
    return Response.json(
      { verdict: "REFUSED", reason: "INVALID_REQUEST", detail: "email and password are required" },
      { status: 400 }
    )
  }

  const wrapKey = process.env.SESSION_WRAP_KEY || ""
  if (wrapKey.length < 32) {
    return Response.json(
      { verdict: "ERROR", message: "SESSION_WRAP_KEY is not configured (32+ chars required) — the auth boundary refuses to run without its injected keys." },
      { status: 500 }
    )
  }

  const pool = getSentinelPool()
  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (e) {
    return Response.json({ verdict: "ERROR", message: `could not acquire a database client: ${(e as Error).message}` }, { status: 500 })
  }

  try {
    const auth = makeAuthAdapter(client, { wrapKey })
    const result = await auth.attemptLogin({ email, password, code })

    if (result.outcome === "REFUSED") {
      return Response.json(
        { verdict: "REFUSED", reason: result.reason },
        { status: result.reason === "AUTH_LOCKED" ? 423 : 401 }
      )
    }
    if (result.outcome === "CHALLENGE_MFA") {
      return Response.json({ verdict: "MFA_REQUIRED", tenantCode: result.tenantCode })
    }
    /* ISSUE */
    return Response.json(
      { verdict: "OK", principal: result.principal },
      { headers: { "set-cookie": sessionCookieHeader(result.token || "") } }
    )
  } catch (e) {
    return Response.json({ verdict: "ERROR", message: (e as Error).message }, { status: 500 })
  } finally {
    client.release()
  }
}
