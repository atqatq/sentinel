import { NextResponse } from "next/server"

import { getSentinelPool } from "../../../lib/pg"
import { readDataHealthFacts } from "../../../lib/data-health-server"
import { resolveRequestSession, unauthorized } from "../../../lib/auth-server"

/*
 * GET /api/data-health — the HTTP transport for the data-health facts
 * envelope (M2 data-health screens; D-024's "the data-health screens render
 * from these facts"; D-025). This file owns ONLY transport:
 *
 *   - the pool factory (shared, one per process);
 *   - the clock injection — asOf = now at the boundary, exactly like the
 *     plan route's asOf; the composition and the ops module stay clock-free;
 *   - the status mapping:
 *       200 the facts envelope, verbatim
 *       401 session (missing / expired / terminated — reason named)
 *       404 unknown tenant (the registry lookup names it)
 *       500 wiring/DB error — phase named (POOL | DB), never a data refusal.
 *
 * AUTHENTICATED IDENTITY (M11 — the D-023/D-029 interim retirement,
 * delivered): the tenant comes from the SESSION — the ?tenant= query
 * parameter is RETIRED and refuses by name when present. The session
 * resolution is the same one the plan route rides (lib/auth-server — one
 * source, no drift); the reader keeps its code-based signature and gets
 * the code from the session's own tenant row.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const carried = new URL(request.url).searchParams.get("tenant")
  if (carried) {
    return NextResponse.json(
      {
        verdict: "REFUSED",
        reason: "SESSION_IDENTITY_REQUIRED",
        detail: "the tenant query parameter is retired (M11) — identity comes from the session; sign in and let the boundary bind it",
      },
      { status: 400 }
    )
  }

  let pool
  try {
    pool = getSentinelPool()
  } catch (e) {
    return NextResponse.json(
      { verdict: "ERROR", message: (e as Error).message },
      { status: 500 }
    )
  }

  const resolved = await resolveRequestSession(pool, request)
  if (!resolved.ok) return unauthorized(resolved.reason)
  const tenantCode = resolved.session.tenantCode
  if (!tenantCode) {
    return NextResponse.json(
      { verdict: "ERROR", phase: "TENANT", message: "the session's tenant row could not be resolved to its code" },
      { status: 500 }
    )
  }

  const result = await readDataHealthFacts(pool, tenantCode, Date.now())
  if (result.ok) {
    return NextResponse.json(result.facts)
  }
  if (result.phase === "TENANT") {
    return NextResponse.json(
      { verdict: "UNKNOWN_TENANT", message: result.message },
      { status: 404 }
    )
  }
  return NextResponse.json(
    { verdict: "ERROR", phase: result.phase, message: result.message },
    { status: 500 }
  )
}
