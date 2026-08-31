import { makeAuthAdapter } from "@sentinel/db"
import type { PoolClient } from "pg"

import { getSentinelPool } from "../../../../lib/pg"
import { clearedSessionCookieHeader, readSessionCookie } from "../../../../lib/auth-server"

/*
 * POST /api/auth/logout — session termination (§16.1 Class N: session
 * creation AND termination are logged). The tombstone is the adapter's
 * UPDATE (no DELETE for any actor); the cookie is cleared regardless —
 * a logout must always LOOK like it worked.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const token = readSessionCookie(request)
  const pool = getSentinelPool()
  let terminated = false
  if (token) {
    const wrapKey = process.env.SESSION_WRAP_KEY || ""
    if (wrapKey.length < 32) {
      return Response.json({ verdict: "ERROR", message: "SESSION_WRAP_KEY is not configured." }, { status: 500 })
    }
    const auth = makeAuthAdapter(
      { query: (text: string, values?: unknown[]) => pool.query(text, values as never[]) },
      { wrapKey }
    )
    try {
      const r = await auth.terminateSession(token)
      terminated = r.terminated
    } catch {
      terminated = false
    }
  }
  return Response.json(
    { verdict: "OK", terminated },
    { headers: { "set-cookie": clearedSessionCookieHeader() } }
  )
}
