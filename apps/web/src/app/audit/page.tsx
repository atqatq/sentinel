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
import { readAuditSurface } from "../../lib/audit-server"
import { TimeMachine } from "./time-machine"

export const dynamic = "force-dynamic"

/*
 * Screen 12 — Audit & Time Machine. "Every change is attributable and every
 * past day is reconstructable."
 *
 * Left: the audit chain table — the H5 ledger's blocks, newest first, each
 * row carrying the actor, the action, the before → after and the hash. The
 * header pill is verifyChain's REAL verdict under the deployment's HMAC key
 * (armed only); an unarmed deployment renders the disclosure instead of a
 * fabricated "chain intact".
 *
 * Right: the time machine — a slider over the sealed days of the window;
 * the four snapshot stats re-derive from the SEALED payloads (never live
 * tables — "the board you see is the board that was"), with the diff panel
 * against the latest sealed day. Money a seal withheld renders as
 * withheld, never as zero.
 */

const CLASS_COLOR: Record<string, string> = {
  W: "var(--text)",
  A: "var(--ok)",
  N: "var(--info)",
  S: "var(--warn)",
  D: "var(--critical)",
}

function OutcomeDot({ outcome }: { outcome: string }) {
  const color =
    outcome === "applied" || outcome === "approved" || outcome === "ok"
      ? "var(--ok)"
      : outcome === "denied" || outcome === "failed"
        ? "var(--critical)"
        : "var(--text-3)"
  return (
    <span
      aria-hidden="true"
      className="inline-block size-[6px] shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  )
}

function BeforeAfter({ before, after }: { before: unknown; after: unknown }) {
  if (before === null && after === null) return <span className="font-mono text-[11px] text-text-3">—</span>
  return (
    <span className="font-mono text-[11px] leading-[16px]">
      {before !== null && before !== undefined ? (
        <>
          <span className="text-text-3 line-through">{JSON.stringify(before).slice(0, 24)}</span>
          {" → "}
        </>
      ) : null}
      {after !== null && after !== undefined ? (
        <span className="text-text">{JSON.stringify(after).slice(0, 24)}</span>
      ) : null}
    </span>
  )
}

function ChainHeaderPill({
  verified,
  entryCount,
}: {
  verified: boolean | null
  entryCount: number | null
}) {
  if (verified === null) {
    return (
      <span className="font-mono text-[10.5px] leading-[16px] text-text-3">
        chain verification unavailable — the ledger door is unarmed on this deployment
      </span>
    )
  }
  if (verified === false) {
    return (
      <span className="font-mono text-[10.5px] font-semibold leading-[16px]" style={{ color: "var(--critical)" }}>
        CHAIN BROKEN — do not trust the history below
      </span>
    )
  }
  return (
    <span className="font-mono text-[10.5px] leading-[16px]" style={{ color: "var(--ok)" }}>
      chain intact · {entryCount === null ? "?" : entryCount.toLocaleString("en-US")} entries
    </span>
  )
}

function FirstRunEmpty({ tenantCode }: { tenantCode: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-24 text-center">
      <div aria-hidden="true" className="size-[34px] rounded-sm border border-dashed border-line-strong" />
      <p className="font-sans text-[16px] font-semibold leading-[22px] text-text">
        No sealed days yet
      </p>
      <p className="max-w-[52ch] font-sans text-[13px] leading-[20px] text-text-2">
        This screen reads the sealed plan snapshots (plan_seal) and the hash-chained audit ledger
        (ledger_block) for {tenantCode}. Nothing has been sealed yet, so there is nothing to
        reconstruct — no placeholder rows, no spinner.
      </p>
      <p className="font-mono text-[10.5px] leading-[16px] text-text-3">
        no fabricated rows · no spinner · dataset named above
      </p>
    </div>
  )
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const tenantParam = typeof params.tenant === "string" ? params.tenant : undefined
  const tenantCode = tenantParam ?? "BahrainMP"

  const result = await readAuditSurface(getSentinelPool(), tenantCode)

  return (
    <>
      <TopBar>
        <Wordmark />
        <Menubar currentRoute="/audit" />
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
          title="Audit & Time Machine"
          subhead={
            <>
              Every change is attributable and every past day is reconstructable. The chain table
              is the H5 ledger&rsquo;s verdict under this deployment&rsquo;s key; the machine
              re-derives each day from the sealed snapshot — the board you see is the board that
              was.
            </>
          }
        />

        {!result.ok ? (
          <section className="rounded-md border border-line bg-surface">
            <div className="flex flex-col gap-2 px-4 py-10">
              <p className="font-sans text-[13px] font-semibold leading-[18px] text-text" style={{ color: "var(--critical)" }}>
                The audit surface could not be read ({result.phase})
              </p>
              <p className="font-mono text-[11px] leading-[16px] text-text-2">{result.message}</p>
              <p className="font-sans text-[12.5px] leading-[18px] text-text-2">
                One retry (reload) is the contract. A persistent failure is a deployment wiring
                error, not a data refusal.
              </p>
            </div>
          </section>
        ) : (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {/* ---- left: the audit chain table ---- */}
            <section className="overflow-hidden rounded-md border border-line bg-surface">
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                <h2 className="font-sans text-[14px] font-semibold leading-[20px] text-text">Audit chain</h2>
                <ChainHeaderPill verified={result.chain.verified} entryCount={result.chain.entryCount} />
              </div>
              {result.chain.blocks === null ? (
                <div className="px-4 py-10">
                  <p className="max-w-[60ch] font-sans text-[13px] leading-[20px] text-text-2">
                    The ledger door is unarmed on this deployment (the HMAC key is not in the
                    environment), so the chain table and its verification refuse to render — the
                    same armament the decide/apply API requires. The blocks exist; the surface
                    discloses instead of guessing.
                  </p>
                </div>
              ) : result.chain.blocks.length === 0 ? (
                <div className="px-4 py-10">
                  <p className="font-sans text-[13px] leading-[20px] text-text-2">
                    The chain is intact and empty — no audited change has landed yet for this
                    tenant. The first write (a seal, a decision, a restatement) starts it.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-line text-left">
                        <th className="px-4 py-2 font-sans text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">When</th>
                        <th className="px-4 py-2 font-sans text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">Actor</th>
                        <th className="px-4 py-2 font-sans text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">Change</th>
                        <th className="px-4 py-2 font-sans text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">Before → after</th>
                        <th className="px-4 py-2 font-sans text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">Hash</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.chain.blocks.map((b) => (
                        <tr key={b.seq} className="border-b border-line last:border-b-0">
                          <td className="whitespace-nowrap px-4 py-2 font-mono text-[11px] leading-[16px] text-text-2">
                            {new Date(b.atMs).toISOString().replace("T", " ").slice(0, 16)}
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] leading-[16px] text-text-2">{b.actor}</td>
                          <td className="px-4 py-2">
                            <span className="flex items-center gap-2">
                              <OutcomeDot outcome={b.outcome} />
                              <span className="font-mono text-[11px] leading-[16px] text-text">
                                {b.entity}/{b.action}
                              </span>
                              <span
                                className="font-mono text-[10px] leading-[14px] text-text-3"
                                title={`ledger class ${b.class}`}
                              >
                                {b.class}
                              </span>
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            <BeforeAfter before={b.before} after={b.after} />
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] leading-[16px] text-text-3" title={b.hash}>
                            {b.hash.slice(0, 8)}…
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* ---- right: the time machine ---- */}
            <section className="overflow-hidden rounded-md border border-line bg-surface">
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                <h2 className="font-sans text-[14px] font-semibold leading-[20px] text-text">Time machine</h2>
                <span className="font-mono text-[10.5px] leading-[16px] text-text-3">90-day window</span>
              </div>
              {result.timeline.snapshots.length === 0 && result.timeline.unreadable === 0 ? (
                <FirstRunEmpty tenantCode={tenantCode} />
              ) : (
                <div className="px-4 py-4">
                  <TimeMachine timeline={result.timeline} />
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </>
  )
}
