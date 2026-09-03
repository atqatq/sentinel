import type { Pool, PoolClient } from "pg"

import { makeSourcingAdapter, resolveTenantByCode } from "@sentinel/db"

/*
 * readSuppliersSurface — the ONE server-side reader for the /suppliers
 * screen's SRC-05 tile (A15.2; the single-source exposure KPI). The SQL
 * lives in packages/db (makeSourcingAdapter — one source); the KPI formula
 * lives in the pure kpi-catalog module (evaluateSrc05); THIS file is the
 * composition root wiring the two through the ADR-0002 transaction fence.
 *
 * The clock is injected by the transport (asOfMs) — nothing in the read
 * path calls Date(); the freshness stamp is the LATEST SEAL's sealed_at
 * (a surface that judges staleness against the wall clock instead of the
 * seal would lie about its own freshness).
 */

export interface Src05Envelope {
  id: string | null
  value: number | null
  dataState: string
  reason: string | null
  basis: string | null
  freshness: { ageHours: number; staleAfterHours: number | null; stale: boolean }
  counts: {
    activeCategories: number
    singleSourceCategories: number
    multiSourceCategories: number
    unsourcedCategories: number
    inactiveCategories: number
  } | null
  rows: Array<{ category: string; active: boolean; supplierCount: number | null }>
}

export type SuppliersRead =
  | {
      ok: true
      src05: Src05Envelope
      openLines: number
      unattributedLines: number
    }
  | { ok: false; phase: "POOL" | "TENANT" | "DB" | "FRESHNESS"; message: string }

export async function readSuppliersSurface(pool: Pool, tenantCode: string, asOfMs: number): Promise<SuppliersRead> {
  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (e) {
    return { ok: false, phase: "POOL", message: `could not acquire a database client: ${(e as Error).message}` }
  }

  try {
    await client.query("BEGIN")

    const tenant = await resolveTenantByCode(client, tenantCode)
    if (!tenant) {
      await client.query("ROLLBACK")
      return { ok: false, phase: "TENANT", message: `tenant '${tenantCode}' is not in the registry` }
    }

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id])

    const sourcing = makeSourcingAdapter(client, tenant.id)
    const evidence = await sourcing.loadCategorySupplierEvidence()
    const lastSealedAt = await sourcing.loadLastSealStamp()
    if (lastSealedAt === null) {
      await client.query("ROLLBACK")
      return {
        ok: false,
        phase: "FRESHNESS",
        message: "no plan run has ever sealed for this tenant — SRC-05's freshness stamp does not exist yet",
      }
    }

    /* evaluateSrc05 rides the package public surface (ADR-0001 — the app
     * consumes the module through @sentinel/module-kpi-catalog, never src/
     * internals). */
    const KPI = await import("@sentinel/module-kpi-catalog")
    const src05 = KPI.evaluateSrc05(
      { categories: evidence.categories.map((c) => ({ category: c.category, active: true, supplierCount: c.supplierCount })) },
      { asOf: asOfMs, lastSealedAt },
    ) as unknown as Src05Envelope

    await client.query("COMMIT")
    return { ok: true, src05, openLines: evidence.openLines, unattributedLines: evidence.unattributedLines }
  } catch (e) {
    try {
      await client.query("ROLLBACK")
    } catch {
      /* the connection is already broken — release below returns it anyway */
    }
    return { ok: false, phase: "DB", message: (e as Error).message }
  } finally {
    client.release()
  }
}
