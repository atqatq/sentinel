import { NextResponse } from "next/server"

import { getSentinelPool } from "../../../lib/pg"
import { readDataHealthFacts } from "../../../lib/data-health-server"

/*
 * GET /api/data-health?tenant=<code> — the HTTP transport for the
 * data-health facts envelope (M2 data-health screens; D-024's "the
 * data-health screens render from these facts"; D-025). This file owns
 * ONLY transport:
 *
 *   - the pool factory (shared, one per process);
 *   - the clock injection — asOf = now at the boundary, exactly like the
 *     plan route's asOf; the composition and the ops module stay clock-free;
 *   - the status mapping:
 *       200 the facts envelope, verbatim
 *       400 request-shape (missing tenant parameter)
 *       404 unknown tenant code (the registry lookup names it)
 *       500 wiring/DB error — phase named (POOL | DB), never a data refusal.
 *
 * The tenant CODE is the display identity (the tenant switcher's), resolved
 * to the fence uuid inside the reader. Authenticated identity (session →
 * tenant) replaces it at the boundary when C3 SoD lands (M3) — the same
 * declared interim as POST /api/plan.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const tenantCode = new URL(request.url).searchParams.get("tenant")
  if (!tenantCode) {
    return NextResponse.json(
      {
        verdict: "REFUSED",
        reason: "INVALID_REQUEST",
        detail: "tenant (code) query parameter is required",
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
