import { ENGINE_VERSION } from "@sentinel/module-planning-engine"
import { SCHEMA_VERSION } from "@sentinel/db"
import pkg from "../../../package.json"

export const dynamic = "force-dynamic"

/*
 * /health — the image's probe target AND §6.2's L-07 version stamp (the
 * transport half the §14.23 contract closes). One route, two jobs:
 *
 *   - the orchestrator's HTTP probe hits this (distroless has no shell, so
 *     the container healthcheck is this GET, never a shell exec);
 *   - a production question resolves to the EXACT code state: the app
 *     version, ENGINE_VERSION and SCHEMA_VERSION — each read through the
 *     real public surface (ADR-0001) the running process imported, not a
 *     build-time declaration echoed back.
 *
 * The route is deliberately DB-free: a liveness/readiness probe must not
 * fail because the database is momentarily down — the DB surfaces have
 * their own named states (data-health, DAT-01) and the §8 composition
 * renders them honestly. The probe answers "is the server up and which
 * code is it", nothing more.
 */

export async function GET() {
  return Response.json(
    {
      ok: true,
      service: "sentinel-web",
      dataState: "OK",
      asOf: new Date().toISOString(),
      versions: {
        app: pkg.version,
        engine: ENGINE_VERSION,
        schema: SCHEMA_VERSION,
      },
    },
    { headers: { "cache-control": "no-store" } },
  )
}
