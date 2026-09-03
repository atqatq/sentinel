import { TopBar, TopBarSpacer } from "@sentinel/ui/top-bar"
import { Wordmark } from "@sentinel/ui/wordmark"
import { Menubar } from "@sentinel/ui/menubar"
import { SearchTrigger } from "@sentinel/ui/search-trigger"
import { TenantSwitcher } from "@sentinel/ui/tenant-switcher"
import { ThemeToggle } from "@sentinel/ui/theme-toggle"
import { Avatar } from "@sentinel/ui/avatar"
import { PageHeader } from "@sentinel/ui/page-header"

import { DensityControl } from "../shell-controls"
import { getSentinelPool } from "../../lib/pg"
import { readSuppliersSurface } from "../../lib/suppliers-server"

export const dynamic = "force-dynamic"

/*
 * Screen 10 — Suppliers / Supplier Scorecards (the SRC-05 slice). The full
 * scorecard panel (stated-vs-observed lead time, box plots, suggestions)
 * rides the receipt-matching evidence and is its own unit; THIS screen
 * ships the tile the §16.5 catalog names as SRC-05's source (A15.2):
 * the single-source exposure — the share of active categories whose
 * sourcing evidence carries exactly one approved supplier.
 *
 * Honesty rules rendered here:
 *   - the formula lives in the pure kpi-catalog module; the tile renders
 *     the envelope verbatim, INCLUDING its dataState — a WITHHELD,
 *     INSUFFICIENT_DATA or STALE state is the information, never hidden
 *     behind a number;
 *   - unsourced categories (no supplier evidence) surface in the counts —
 *     they are neither single-source nor silently healthy;
 *   - unattributable PO lines are disclosed — an under-count would fake a
 *     healthier mix;
 *   - the basis ("approved = active and not banned, per open-PO evidence")
 *     is on the record, because a KPI whose provenance is hidden is a
 *     number nobody can challenge.
 */

const STATE_COLOR: Record<string, string> = {
  OK: "var(--ok)",
  STALE: "var(--warn)",
  WITHHELD: "var(--critical)",
  INSUFFICIENT_DATA: "var(--critical)",
}

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const tenantParam = typeof params.tenant === "string" ? params.tenant : undefined
  const tenantCode = tenantParam ?? "BahrainMP"

  const result = await readSuppliersSurface(getSentinelPool(), tenantCode, Date.now())

  return (
    <>
      <TopBar>
        <Wordmark />
        <Menubar currentRoute="/suppliers" />
        <TopBarSpacer />
        <SearchTrigger />
        <TenantSwitcher tenantCode={tenantCode} />
        <DensityControl />
        <ThemeToggle />
        <Avatar initials="SU" />
      </TopBar>

      <main className="space-y-5 p-6">
        <PageHeader
          eyebrow={`Sourcing · ${tenantCode}`}
          title="Supplier Scorecards — Single-source exposure"
          subhead={
            <>
              Sentinel&rsquo;s sourcing risk tile: the share of active categories whose evidence
              carries exactly one approved supplier. The catalog target is ≤ 15% — a
              single-sourced category is a supplier failure away from a shelf of stockouts.
            </>
          }
        />

        {!result.ok ? (
          <section className="rounded-md border border-line bg-surface">
            <div className="flex flex-col gap-2 px-4 py-10">
              <p className="font-sans text-[13px] font-semibold leading-[18px] text-text" style={{ color: "var(--critical)" }}>
                The tile could not be composed ({result.phase})
              </p>
              <p className="font-mono text-[11px] leading-[16px] text-text-2">{result.message}</p>
              <p className="font-sans text-[12.5px] leading-[18px] text-text-2">
                One retry (reload) is the contract. A persistent failure is a deployment wiring
                error, not a data refusal.
              </p>
            </div>
          </section>
        ) : (
          <section className="overflow-hidden rounded-md border border-line bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <h2 className="font-sans text-[14px] font-semibold leading-[20px] text-text">
                SRC-05 · Single-source exposure
              </h2>
              <span
                className="font-mono text-[10.5px] font-semibold leading-[16px]"
                style={{ color: STATE_COLOR[result.src05.dataState] ?? "var(--text-3)" }}
              >
                {result.src05.dataState}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-3">
              {/* the value — or the named absence */}
              <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4">
                <p className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-text-3">
                  Exposure
                </p>
                <p
                  className="font-mono text-[34px] font-semibold leading-[40px]"
                  style={{ color: result.src05.value !== null && result.src05.value > 15 ? "var(--critical)" : "var(--text)" }}
                >
                  {result.src05.value === null ? "—" : `${result.src05.value}%`}
                </p>
                <p className="font-sans text-[12px] leading-[17px] text-text-2">
                  {result.src05.counts
                    ? `${result.src05.counts.singleSourceCategories} of ${result.src05.counts.activeCategories} active categories · target ≤ 15%`
                    : "the population produced no value — see the state"}
                </p>
              </div>

              {/* the mix — every bucket on the record */}
              <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4">
                <p className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-text-3">
                  The mix
                </p>
                {result.src05.counts ? (
                  <ul className="space-y-1.5 font-sans text-[12.5px] leading-[18px] text-text-2">
                    <li>
                      Single-source:{" "}
                      <span className="font-mono text-text">{result.src05.counts.singleSourceCategories}</span>
                    </li>
                    <li>
                      Multi-source:{" "}
                      <span className="font-mono text-text">{result.src05.counts.multiSourceCategories}</span>
                    </li>
                    <li>
                      Unsourced (no evidence):{" "}
                      <span className="font-mono text-text" style={{ color: result.src05.counts.unsourcedCategories > 0 ? "var(--warn)" : undefined }}>
                        {result.src05.counts.unsourcedCategories}
                      </span>
                    </li>
                    <li>
                      Inactive (out of scope):{" "}
                      <span className="font-mono text-text">{result.src05.counts.inactiveCategories}</span>
                    </li>
                  </ul>
                ) : (
                  <p className="font-sans text-[12.5px] leading-[18px] text-text-2">
                    No population yet — nothing to mix.
                  </p>
                )}
              </div>

              {/* the provenance — basis + freshness, never hidden */}
              <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4">
                <p className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-text-3">
                  Provenance
                </p>
                <p className="font-sans text-[12.5px] leading-[18px] text-text-2">{result.src05.basis}</p>
                <p className="font-sans text-[12.5px] leading-[18px] text-text-2">{result.src05.reason}</p>
                <p className="font-mono text-[11px] leading-[16px] text-text-3">
                  freshness: {result.src05.freshness.ageHours < 1
                    ? "<1h"
                    : `${Math.round(result.src05.freshness.ageHours)}h`}{" "}
                  old · stale threshold {result.src05.freshness.staleAfterHours ?? "event"}h
                </p>
                {result.unattributedLines > 0 ? (
                  <p className="font-sans text-[12px] leading-[17px]" style={{ color: "var(--warn)" }}>
                    {result.unattributedLines} of {result.openLines} open PO lines carry no
                    category+supplier attribution — the mix excludes them, and this note keeps
                    them from hiding.
                  </p>
                ) : null}
              </div>
            </div>

            {/* the per-category register — the tile's evidence, named */}
            {result.src05.rows.length > 0 ? (
              <div className="overflow-x-auto border-t border-line">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-line text-left">
                      <th className="px-4 py-2 font-sans text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">Category</th>
                      <th className="px-4 py-2 font-sans text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">Approved suppliers</th>
                      <th className="px-4 py-2 font-sans text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">Sourcing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.src05.rows.map((r) => (
                      <tr key={r.category} className="border-b border-line last:border-b-0">
                        <td className="px-4 py-2 font-sans text-[12.5px] leading-[18px] text-text">{r.category}</td>
                        <td className="px-4 py-2 font-mono text-[12px] leading-[17px] text-text-2">
                          {r.supplierCount === null ? "none evidenced" : r.supplierCount}
                        </td>
                        <td className="px-4 py-2 font-sans text-[12.5px] leading-[18px]">
                          <span
                            style={{
                              color:
                                r.supplierCount === 1
                                  ? "var(--critical)"
                                  : r.supplierCount === null
                                    ? "var(--warn)"
                                    : "var(--ok)",
                            }}
                          >
                            {r.supplierCount === 1
                              ? "single-source — one supplier failure from stockout"
                              : r.supplierCount === null
                                ? "unsourced — no approved supplier evidenced yet"
                                : "multi-source"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="border-t border-line px-6 py-16 text-center">
                <div aria-hidden="true" className="mx-auto mb-3 size-[34px] rounded-sm border border-dashed border-line-strong" />
                <p className="font-sans text-[13px] font-semibold leading-[18px] text-text">
                  No category evidence yet
                </p>
                <p className="mx-auto max-w-[52ch] pt-1 font-sans text-[13px] leading-[20px] text-text-2">
                  This tile reads the item master&rsquo;s active categories and the sourcing
                  evidence on open PO lines (item → category, line → supplier). For {tenantCode}
                  {" "}neither has landed yet — no placeholder rows, no spinner.
                </p>
                <p className="pt-1 font-mono text-[10.5px] leading-[16px] text-text-3">
                  no fabricated rows · no spinner · dataset named above
                </p>
              </div>
            )}
          </section>
        )}
      </main>
    </>
  )
}
