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
import { readApprovalTray } from "../../lib/approvals-server"
import { deltaLabel, type PendingCfVersion } from "../../lib/approvals"
import { DecideControls } from "./decide-controls"

export const dynamic = "force-dynamic"

/*
 * §14.13c — the approvals tray (the UI composition riding the CF
 * decide/apply API): every PENDING conversion-factor version for the
 * tenant, oldest request first, each row carrying the gate's own decide
 * actions. The governance arithmetic lives in the gate (never here); this
 * screen renders the queue the gate's deciders work down and shows the
 * gate's refusals verbatim — a refusal the decider cannot see is a probing
 * hand that learns nothing, and a decision the tray hides is a gate nobody
 * uses (§14.13c's own words).
 *
 * A server component rendering through readApprovalTray — the SAME reader
 * posture as /data-health: RLS-fenced, one source, honest empty states
 * (§8: the dataset is named, nothing faked). The signed delta is composed
 * in lib/approvals (pure, test-proven); a FIRST-EVER factor renders "first
 * factor", never a percentage off a missing or zero base.
 */

const DELTA_OK = "var(--ok)"
const DELTA_WARN = "var(--warn)"

function DeltaCell({ v }: { v: PendingCfVersion }) {
  const label = deltaLabel(v)
  const pct = v.fromValue !== null && v.fromValue !== 0 && Number.isFinite(v.fromValue)
    ? ((v.toValue - v.fromValue) / v.fromValue) * 100
    : null
  /* The status language binds to the FACT, not the vibe: a large swing in
   * either direction warns (a factor that moved >25% re-sizes every plan
   * derived from it), small swings render neutral-positive. Colour is never
   * the sole carrier — the signed label is the information. */
  const color = pct === null ? "var(--text-2)" : Math.abs(pct) > 25 ? DELTA_WARN : DELTA_OK
  return (
    <span className="font-mono text-[12px] leading-[17px]" style={{ color }}>
      {label}
    </span>
  )
}

function FactorValues({ v }: { v: PendingCfVersion }) {
  return (
    <span className="font-mono text-[12.5px] leading-[18px] text-text">
      {v.fromValue === null ? (
        <>
          <span className="text-text-3">∅ → </span>
          {v.toValue}
        </>
      ) : (
        <>
          {v.fromValue} <span className="text-text-3">→ </span>
          {v.toValue}
        </>
      )}
    </span>
  )
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const tenantParam = typeof params.tenant === "string" ? params.tenant : undefined
  /* The declared interim identity (the /data-health page's pattern); the
   * SESSION decides the DECIDER — the tray only scopes what it shows. */
  const tenantCode = tenantParam ?? "BahrainMP"

  const result = await readApprovalTray(getSentinelPool(), tenantCode)

  return (
    <>
      <TopBar>
        <Wordmark />
        <Menubar currentRoute="/approvals" />
        <TopBarSpacer />
        <SearchTrigger />
        <TenantSwitcher tenantCode={tenantCode} />
        <DensityControl />
        <ThemeToggle />
        <Avatar initials="SU" />
      </TopBar>

      <main className="space-y-5 p-6">
        <PageHeader
          eyebrow={`Governance · ${tenantCode}`}
          title="Approvals — Conversion factors"
          subhead={
            <>
              The §14.13c decision gate&rsquo;s tray: every pending conversion-factor change,
              oldest request first. Approving freezes the factor in and lands the re-derivation
              tasks; rejecting puts the reason on the record. The requester can never decide
              their own request — the gate enforces it, this tray just carries it.
            </>
          }
        />

        {!result.ok ? (
          <section className="rounded-md border border-line bg-surface">
            <div className="flex flex-col gap-2 px-4 py-10">
              <p className="font-sans text-[13px] font-semibold leading-[18px] text-text" style={{ color: "var(--critical)" }}>
                The tray could not be read ({result.phase})
              </p>
              <p className="font-mono text-[11px] leading-[16px] text-text-2">{result.message}</p>
              <p className="font-sans text-[12.5px] leading-[18px] text-text-2">
                One retry (reload) is the contract. A persistent failure is a deployment wiring
                error, not a data refusal.
              </p>
            </div>
          </section>
        ) : result.tray.pendingCount === 0 ? (
          <section className="overflow-hidden rounded-md border border-line bg-surface">
            {/* §8 first-run honest empty state — the dataset is named. */}
            <div className="flex flex-col items-center gap-3 px-6 py-24 text-center">
              <div aria-hidden="true" className="size-[34px] rounded-sm border border-dashed border-line-strong" />
              <p className="font-sans text-[16px] font-semibold leading-[22px] text-text">
                No pending conversion-factor decisions
              </p>
              <p className="max-w-[52ch] font-sans text-[13px] leading-[20px] text-text-2">
                This tray reads the PENDING versions of the conversion-factor gate
                (item_cf_version) for {tenantCode}. The queue is empty — either nothing has been
                staged, or every staged factor has been decided. No placeholder rows, no spinner.
              </p>
              <p className="font-mono text-[10.5px] leading-[16px] text-text-3">
                no fabricated rows · no spinner · dataset named above
              </p>
            </div>
          </section>
        ) : (
          <section className="overflow-hidden rounded-md border border-line bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <h2 className="font-sans text-[14px] font-semibold leading-[20px] text-text">
                Pending decisions
              </h2>
              <span className="font-mono text-[11px] leading-[16px] text-text-3">
                {result.tray.pendingCount} pending
              </span>
            </div>
            <ul className="divide-y divide-line">
              {result.tray.rows.map((v) => (
                <li key={v.id} className="flex flex-col gap-3 px-4 py-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-[13px] font-semibold leading-[18px] text-text">
                      {v.sku}
                    </span>
                    <span className="font-mono text-[11px] leading-[16px] text-text-3">
                      v{v.version}
                    </span>
                    <FactorValues v={v} />
                    <DeltaCell v={v} />
                    <span className="ml-auto font-mono text-[11px] leading-[16px] text-text-3">
                      {v.createdAt ? new Date(v.createdAt).toISOString().slice(0, 10) : "no stamp"}
                    </span>
                  </div>
                  {v.requestedReason ? (
                    <p className="font-sans text-[12.5px] leading-[18px] text-text-2">
                      {v.requestedReason}
                    </p>
                  ) : (
                    <p className="font-sans text-[12.5px] italic leading-[18px] text-text-3">
                      requested without a reason — the gate will still require one to reject
                    </p>
                  )}
                  <DecideControls versionId={v.id} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  )
}
