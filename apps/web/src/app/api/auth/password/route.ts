import { makeAuthBoundary, readSessionCookie, resolveRequestSession, unauthorized } from "../../../../lib/auth-server"
import { getSentinelPool } from "../../../../lib/pg"

/*
 * POST /api/auth/password — the §14.28 rotation's transport (clause 2;
 * D-049). EVERY session may rotate (must-change sessions MOST of all —
 * this is the door that clears the interstitial). The adapter owns the
 * atomic unit: the current password is re-verified (a rotation is a
 * re-authentication, never a bearer act), the pure policy floor decides
 * the replacement, must_change clears, and every OTHER live session of
 * the user takes the tombstone.
 *
 * Transport-only, like its siblings: shape checks here, decisions in the
 * pure layer, statements in the adapter.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  let body: { email?: unknown; currentPassword?: unknown; newPassword?: unknown } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    body = {}
  }

  let pool
  try {
    pool = getSentinelPool()
  } catch (e) {
    return Response.json({ verdict: "ERROR", message: (e as Error).message }, { status: 500 })
  }

  const token = readSessionCookie(request)
  if (!token) return unauthorized("SESSION_REQUIRED")
  const resolved = await resolveRequestSession(pool, request)
  if (!resolved.ok) return unauthorized(resolved.reason)

  // The rotation re-authenticates, so the email must match the SESSION's
  // own principal — the route resolves it from the boundary's adapter
  // (the session row carries the user; the email is looked up by the
  // adapter itself from the session's user id — never from the request
  // body, which an attacker could point at another account).
  const auth = makeAuthBoundary(pool)
  const who = await auth.resolveSession(token)
  if (!who.resolved) return unauthorized(who.reason || "AUTH_SESSION_UNKNOWN")

  if (typeof body.currentPassword !== "string" || body.currentPassword === "" ||
      typeof body.newPassword !== "string" || body.newPassword === "") {
    return Response.json(
      { verdict: "REFUSED", reason: "INVALID_REQUEST", detail: "currentPassword and newPassword are required" },
      { status: 400 }
    )
  }

  try {
    // The rotation re-authenticates against the SESSION's own email —
    // resolveSession carries it additively (u.email, the app_user join it
    // already made); the request body's email (if any) is ignored, so a
    // session can never be aimed at another account.
    const email = (who.session as { email?: string }).email
    if (!email) {
      return Response.json({ verdict: "ERROR", phase: "AUTH", message: "the session's email could not be resolved for the re-authentication" }, { status: 500 })
    }
    const r = await auth.rotateCredential({
      email,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      token,
    })
    if (r.outcome === "REFUSED") {
      return Response.json({ verdict: "REFUSED", reason: r.reason }, { status: r.reason === "AUTH_PASSWORD_CURRENT_INVALID" ? 403 : 422 })
    }
    return Response.json({ verdict: "OK", rotated: true, othersTerminated: r.othersTerminated })
  } catch (e) {
    return Response.json({ verdict: "ERROR", phase: "AUTH", message: (e as Error).message }, { status: 500 })
  }
}
