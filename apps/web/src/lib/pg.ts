import type { Pool } from "pg"

import { pgDriver } from "@sentinel/db"

/*
 * One pooled pg client factory shared by every DB-touching route in the
 * app. The plan transport had this inline; the data-health transport joins
 * it — one pool per process, not one per route (the single-source rule
 * applied to connections, not just SQL).
 *
 * DATABASE_URL must connect as a NOBYPASSRLS role (sentinel_app in
 * production). FORCE (ADR-0002) binds owners too, but the deployment
 * contract is the app role. The pool itself holds no tenant state — every
 * request fences its own transaction with a transaction-local
 * set_config('app.tenant_id', …, true) that dies with the transaction, so
 * pooled connections never leak a tenant scope.
 */
const g = globalThis as typeof globalThis & { __sentinelPgPool?: Pool }

export function getSentinelPool(): Pool {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      "DATABASE_URL is not configured — the Sentinel routes cannot reach PostgreSQL. " +
      "This is a deployment wiring error, not a data refusal."
    )
  }
  if (!g.__sentinelPgPool) {
    g.__sentinelPgPool = new (pgDriver().Pool)({ connectionString: url, max: 4 })
  }
  return g.__sentinelPgPool
}
