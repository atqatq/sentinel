import { makeSetupAdapter } from "@sentinel/db"

import { makeAuthBoundary, type SessionEnvelope } from "./auth-server"
import type { Pool } from "pg"

/*
 * setup-server — the ONE composition point for the /api/setup routes
 * (the single-source rule applied to the setup layer's wiring, the
 * data-health-server lesson).
 *
 *   - the pure validators ride @sentinel/core's setup module through the
 *     adapter (the adapter re-validates — the boundary decides, the
 *     database re-proves, zero trust between layers);
 *   - the tz allowlist is injected from the runtime (Intl — the browser-
 *     independent zone list Node ships), keeping the core module env-free;
 *   - the credential posture lives in ONE place: the composed auth
 *     boundary (the same makeAuthBoundary every auth route rides);
 *   - the ledger is UNWIRED at this boundary (the auth boundary's own
 *     disclosed posture) — a deployment that wires a Class-N emitter for
 *     the setup events passes config.ledger through this one file.
 *
 * The guards, in one place because every setup route carries the SAME two:
 *   SETUP_NOT_ORIGIN (403) — the boundary's Origin gate; the database's own
 *     policies re-prove everything (the founder door's is_origin check,
 *     controls_origin_only on the grants and amendments — the API+DB pair);
 *   SESSION_MUST_CHANGE (403) — a password the account has never chosen
 *     must not govern a setup (§14.28 clause 2).
 */

export function makeSetupBoundary(pool: Pool) {
  return makeSetupAdapter(pool, {
    auth: makeAuthBoundary(pool),
    tzList: Intl.supportedValuesOf("timeZone"),
  })
}

export function forbidden(originGate: "SETUP_NOT_ORIGIN" | "SESSION_MUST_CHANGE", detail: string) {
  return Response.json({ verdict: "REFUSED", reason: originGate, detail }, { status: 403 })
}

export function setupGuards(session: SessionEnvelope): Response | null {
  if (session.isOrigin !== true) {
    return forbidden("SETUP_NOT_ORIGIN", "the setup layer is the Origin's — the database re-proves every write's authority itself")
  }
  if (session.mustChange === true) {
    return forbidden("SESSION_MUST_CHANGE", "rotate your password first (POST /api/auth/password) — a password you never chose must not govern a setup")
  }
  return null
}

export function invalidRequest(detail: string) {
  return Response.json({ verdict: "REFUSED", reason: "INVALID_REQUEST", detail }, { status: 400 })
}
