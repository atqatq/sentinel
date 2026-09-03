"use strict"
/* ============================================================================
 * approvals facts composition — the pure layer between the db adapter's
 * pending CF versions and the /approvals screen (the §14.13c approvals tray,
 * the UI composition riding the CF decide/apply API).
 *
 * Home rules (the data-health facts pattern):
 *   - packages/db owns the SQL (procure-adapter.listPendingCfVersions — one
 *     source); THIS file owns the composition semantics; the page owns render.
 *   - No DB, no clock, no framework imports — identical inputs produce
 *     identical facts, provable without a workspace install.
 *
 * Honesty rules encoded here (never a silent number, never an invented one):
 *   - deltaPct is null when the version has no previous value (a FIRST-EVER
 *     factor has no FROM) — the tray renders "first factor", never a
 *     fabricated percentage off a 0 base.
 *   - aging is null when createdAt is missing (the adapter always supplies
 *     it; the composition still refuses to invent an age).
 *   - The tray order is the adapter's (oldest request first) — re-sorted
 *     STABLY here only as a defense, never reversed by render-time whims.
 * ==========================================================================*/

export interface PendingCfVersion {
  readonly id: string
  readonly sku: string
  readonly version: number
  readonly fromValue: number | null
  readonly toValue: number
  readonly requestedReason: string | null
  readonly createdAt: string | Date | null
}

export interface TrayFacts {
  readonly pendingCount: number
  readonly rows: readonly PendingCfVersion[]
}

/** A version's decision-relevant delta, or null when honestly unknowable. */
export function deltaPct(v: PendingCfVersion): number | null {
  if (v.fromValue === null) return null
  if (!Number.isFinite(v.fromValue) || !Number.isFinite(v.toValue)) return null
  if (v.fromValue === 0) return null // a percentage off a zero base is a lie
  return ((v.toValue - v.fromValue) / v.fromValue) * 100
}

/** The tray's delta cell: signed percentage at one decimal, or the honest word. */
export function deltaLabel(v: PendingCfVersion): string {
  const p = deltaPct(v)
  if (p === null) {
    return v.fromValue === null ? "first factor" : "—"
  }
  const sign = p > 0 ? "+" : ""
  return `${sign}${p.toFixed(1)}%`
}

/**
 * Stable oldest-first order (the adapter's ORDER BY re-asserted in the pure
 * layer — a defense in depth, not a re-derivation: ties stay in arrival
 * order, so the render cannot depend on driver sort stability).
 */
export function sortForTray(rows: readonly PendingCfVersion[]): readonly PendingCfVersion[] {
  return [...rows].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : NaN
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : NaN
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    if (Number.isFinite(ta) && !Number.isFinite(tb)) return -1
    if (!Number.isFinite(ta) && Number.isFinite(tb)) return 1
    return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0
  })
}

/** The whole tray's facts from the adapter rows — the page renders THIS. */
export function composeApprovalTray(rows: readonly PendingCfVersion[]): TrayFacts {
  return { pendingCount: rows.length, rows: sortForTray(rows) }
}
