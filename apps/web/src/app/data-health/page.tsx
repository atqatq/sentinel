import { TopBar, TopBarSpacer } from "@sentinel/ui/top-bar"
import { Wordmark } from "@sentinel/ui/wordmark"
import { Menubar } from "@sentinel/ui/menubar"
import { SearchTrigger } from "@sentinel/ui/search-trigger"
import { TenantSwitcher } from "@sentinel/ui/tenant-switcher"
import { Segmented } from "@sentinel/ui/segmented"
import { ThemeToggle } from "@sentinel/ui/theme-toggle"
import { Avatar } from "@sentinel/ui/avatar"
import { StaleBanner } from "@sentinel/ui/stale-banner"
import { PageHeader } from "@sentinel/ui/page-header"

import { DensityControl } from "../shell-controls"
import { getSentinelPool } from "../../lib/pg"
import { readDataHealthFacts } from "../../lib/data-health-server"
import { formatUtcMinutes, type DataHealthFacts, type RegisterRow } from "../../lib/data-health"

export const dynamic = "force-dynamic"

/*
 * §4 screen 9 — Data Health (M2 row: "data-health screens"; D-024: "the
 * data-health screens render from these facts in their unit"). A server
 * component: the facts are read through readDataHealthFacts (the same
 * reader the GET transport serves), so the screen renders REAL pipeline
 * state — no fabricated rows, no spinner, dataset named above.
 *
 * Anatomy per the design handoff §9 (the README is rendered-detail
 * authority) + the D-024 obligation that this screen also renders the
 * freshness facts (the disclosure is recorded in D-025): the pipeline
 * freshness panel (DAT-01 + per-kind state + alarms verbatim from the ops
 * module), the four register KPIs, and the gap register with the §9
 * unassigned-owner rule.
 *
 * The stale-data banner is D-023's clock carve-out CLOSED: it renders only
 * from the freshness facts (newest seal older than one day), never from a
 * clock in the render layer. Dismissal is client state and lands with the
 * client-shell unit; the banner renders non-dismissible here rather than
 * faking a handler.
 */

const SECTION_LABEL =
  "font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-text-3"

/* The freshness-state tone binding — ops' three pipeline states to SDS
 * tones. This is a THIRD vocabulary (beside the two-axis status language):
 * it renders only here and in future ops-owned surfaces; when a second
 * consumer appears it promotes into packages/ui with a parity test, like
 * the status vocabulary did. Colour is never the sole carrier — every row
 * pairs the dot with the state word. */
const STATE_COLOR: Record<string, string> = {
  FRESH: "var(--ok)",
  DEGRADED: "var(--warn)",
  ALARM: "var(--critical)",
}

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "var(--critical)",
  WARN: "var(--warn)",
  INFO: "var(--info)",
}

function Card({
  title,
  aside,
  children,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-md border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="font-sans text-[14px] font-semibold leading-[20px] text-text">{title}</h2>
        {aside ? <div className="min-w-0">{aside}</div> : null}
      </div>
      <div>{children}</div>
    </section>
  )
}

/* §8 first-run honest empty state — the dataset is named, nothing is faked. */
function FirstRunEmpty({ tenantCode, received }: { tenantCode: string; received: number }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-24 text-center">
      <div aria-hidden="true" className="size-[34px] rounded-sm border border-dashed border-line-strong" />
      <p className="font-sans text-[16px] font-semibold leading-[22px] text-text">
        No data-health register yet
      </p>
      <p className="max-w-[52ch] font-sans text-[13px] leading-[20px] text-text-2">
        {received === 0
          ? `This screen reads the gap register the ingestion pipeline produces — open data gaps, their owners, and what each one blocks. Nothing has been ingested for ${tenantCode} yet, so there is nothing to show — no placeholder rows, no spinner.`
          : `This screen reads the gap register the ingestion pipeline produces. ${received} file${received === 1 ? "" : "s"} arrived for ${tenantCode}, but none has been applied yet, so there is no register to show — no placeholder rows, no spinner.`}
      </p>
      <p className="font-mono text-[10.5px] leading-[16px] text-text-3">
        no fabricated rows · no spinner · dataset named above
      </p>
    </div>
  )
}

/* The not-yet-truthful-empty state: the pipeline ran, but nothing persists
 * register entries until the ingestion worker (H6) lands. */
function RegisterNotYetRecorded() {
  return (
    <div className="flex flex-col gap-2 px-4 py-10">
      <p className="font-sans text-[13px] leading-[20px] text-text">
        No register entries recorded yet.
      </p>
      <p className="max-w-[88ch] font-sans text-[13px] leading-[20px] text-text-2">
        The ingestion worker that persists <span className="font-mono text-[12px]">DATA_HEALTH</span>{" "}
        tasks (H6) has not landed, so an empty register is not yet evidence of a healthy
        pipeline — the freshness panel above is the truthful pipeline state.
      </p>
    </div>
  )
}

function KpiTile({
  label,
  value,
  meta,
  color,
}: {
  label: string
  value: string
  meta: string
  color: string
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4">
      <span className={SECTION_LABEL}>{label}</span>
      <span
        className="font-mono text-[25px] font-medium leading-none tracking-[-0.01em] [font-variant-numeric:tabular-nums]"
        style={{ color }}
      >
        {value}
      </span>
      <span className="font-mono text-[10.5px] leading-[16px] text-text-3">{meta}</span>
    </div>
  )
}

function SeverityPill({ row }: { row: RegisterRow }) {
  const color = SEVERITY_COLOR[row.severity] ?? "var(--muted)"
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-[9px] font-mono text-[11px] font-medium leading-[22px]"
      style={{ backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
    >
      <span aria-hidden="true" className="size-[6px] rounded-full" style={{ backgroundColor: color }} />
      {row.severity}
    </span>
  )
}

const TH =
  "h-[34px] bg-raised px-3 text-start font-sans text-[11px] font-semibold uppercase leading-none tracking-[0.06em] text-text-3 border-b border-line-strong align-middle"
const TH_LAST = TH.replace("px-3", "px-4") + " text-end"
const TD = "h-[46px] border-b border-line px-3 font-sans text-[13px] text-text align-middle"

function RegisterTable({ rows }: { rows: RegisterRow[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={TH}>Gap</th>
          <th className={TH + " text-end"}>Count</th>
          <th className={TH}>Coverage</th>
          <th className={TH}>Blocks</th>
          <th className={TH}>Owner</th>
          <th className={TH_LAST}>Severity</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const sevColor = SEVERITY_COLOR[row.severity] ?? "var(--muted)"
          const unassigned = row.owner === null
          return (
            <tr
              key={row.id}
              style={unassigned ? { backgroundColor: "color-mix(in srgb, var(--critical) 5%, transparent)" } : undefined}
            >
              <td className={TD}>{row.name}</td>
              <td
                className={TD + " text-end font-mono text-[12px] [font-variant-numeric:tabular-nums]"}
                style={{ color: sevColor }}
              >
                {row.countText}
              </td>
              <td className={TD + " min-w-[150px]"}>
                {row.scopePct === null ? (
                  <span className="font-mono text-[12px] text-text-3">—</span>
                ) : (
                  <div className="flex flex-col gap-1">
                    <div className="h-[4px] rounded-full bg-hover">
                      <div
                        className="h-[4px] rounded-full"
                        style={{ width: `${row.scopePct}%`, backgroundColor: sevColor }}
                      />
                    </div>
                    <span className="font-mono text-[10.5px] leading-[14px] text-text-3">
                      {row.scopePct}% of scope
                    </span>
                  </div>
                )}
              </td>
              <td className={TD + " text-[12.5px] text-text-2"}>{row.blocks ?? "—"}</td>
              <td
                className={TD + " text-[12.5px]"}
                style={{ color: unassigned ? "var(--critical)" : "var(--text-2)" }}
              >
                {unassigned ? "Unassigned" : row.owner}
              </td>
              <td className={TD.replace("px-3", "px-4") + " text-end"}>
                <SeverityPill row={row} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function FreshnessPanel({ facts }: { facts: DataHealthFacts }) {
  const { freshness, dat01Target } = facts
  const dat01Color = STATE_COLOR[freshness.dat01.state] ?? "var(--muted)"
  return (
    <Card
      title="Pipeline freshness"
      aside={
        <span className="font-mono text-[11px] leading-none text-text-3">
          {freshness.dat01.id} · owner {dat01Target.owner} · target ≤ {dat01Target.sloHours}h · &gt;{" "}
          {dat01Target.alarmHours}h red + alarm
        </span>
      }
    >
      <div className="flex flex-col gap-0">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="size-[7px] shrink-0 rounded-full"
              style={{ backgroundColor: dat01Color }}
            />
            <span className="font-mono text-[12px] text-text-2">{freshness.dat01.id}</span>
            <span className="font-sans text-[13px] font-medium text-text">
              Worst across file types
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span
              className="font-mono text-[20px] font-medium leading-none [font-variant-numeric:tabular-nums]"
              style={{ color: dat01Color }}
            >
              {freshness.dat01.value === null ? "—" : `${freshness.dat01.value.toFixed(1)}h`}
            </span>
            <span className="font-mono text-[11px] uppercase leading-none" style={{ color: dat01Color }}>
              {freshness.dat01.state}
            </span>
          </div>
        </div>

        {freshness.perDataset.map((e) => {
          const color = STATE_COLOR[e.state] ?? "var(--muted)"
          return (
            <div
              key={e.kind}
              className="flex items-center justify-between gap-3 border-b border-line px-4 py-2 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="size-[6px] shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="truncate font-mono text-[12px] text-text">{e.kind}</span>
                {e.reason ? (
                  <span className="font-mono text-[10.5px] leading-none text-text-3">{e.reason}</span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-baseline gap-3">
                <span className="font-mono text-[11px] leading-none text-text-3">
                  {e.lastSealedAt === null
                    ? "never sealed"
                    : `sealed ${formatUtcMinutes(e.lastSealedAt)} UTC`}
                </span>
                <span
                  className="w-[64px] text-end font-mono text-[12px] leading-none [font-variant-numeric:tabular-nums]"
                  style={{ color }}
                >
                  {e.ageHours === null ? "—" : `${e.ageHours.toFixed(1)}h`}
                </span>
              </div>
            </div>
          )
        })}

        {freshness.alarms.map((a) => (
          <div
            key={`${a.code}:${a.dataset}`}
            className="flex items-start gap-2.5 px-4 py-2.5"
            style={{ backgroundColor: "color-mix(in srgb, var(--critical) 7%, transparent)" }}
          >
            <span
              aria-hidden="true"
              className="mt-[6px] size-[6px] shrink-0 rounded-full"
              style={{ backgroundColor: "var(--critical)" }}
            />
            <p className="font-sans text-[13px] leading-[18px] text-text">{a.banner.text}</p>
            <span className="ml-auto shrink-0 font-mono text-[10.5px] leading-[18px] text-text-3">
              {a.code}
            </span>
          </div>
        ))}

        {freshness.missingDeliveries.raised && freshness.missingDeliveries.banner ? (
          <div
            className="flex items-start gap-2.5 px-4 py-2.5"
            style={{ backgroundColor: "color-mix(in srgb, var(--warn) 10%, transparent)" }}
          >
            <span
              aria-hidden="true"
              className="mt-[6px] size-[6px] shrink-0 rounded-full"
              style={{ backgroundColor: "var(--warn)" }}
            />
            <p className="font-sans text-[13px] leading-[18px] text-text">
              {freshness.missingDeliveries.banner.text}
            </p>
            <span className="ml-auto shrink-0 font-mono text-[10.5px] leading-[18px] text-text-3">
              {freshness.missingDeliveries.code}
            </span>
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function ErrorState({ title, detail }: { title: string; detail: string }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border px-4 py-4"
      style={{
        borderColor: "color-mix(in srgb, var(--critical) 34%, transparent)",
        backgroundColor: "color-mix(in srgb, var(--critical) 5%, transparent)",
      }}
    >
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="size-[6px] shrink-0 rounded-full" style={{ backgroundColor: "var(--critical)" }} />
        <p className="font-sans text-[13px] font-semibold leading-[18px] text-text">{title}</p>
      </div>
      <p className="font-mono text-[11px] leading-[16px] text-text-2">{detail}</p>
      <p className="font-sans text-[12.5px] leading-[18px] text-text-2">
        One retry (reload) is the contract. If it fails again, this is a deployment wiring
        error, not a data refusal — the module faulted, and this screen is where that lands.
      </p>
    </div>
  )
}

export default async function DataHealthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const tenantParam = typeof params.tenant === "string" ? params.tenant : undefined
  /* The declared interim identity (matches the switcher below, as on the
   * scaffold page); session-authenticated identity replaces it at the
   * boundary when C3 SoD lands in M3. */
  const tenantCode = tenantParam ?? "BahrainMP"

  const result = await readDataHealthFacts(getSentinelPool(), tenantCode, Date.now())

  return (
    <>
      <TopBar>
        <Wordmark />
        <Menubar currentRoute="/data-health" />
        <TopBarSpacer />
        <SearchTrigger />
        <TenantSwitcher tenantCode={tenantCode} />
        {/* Local↔USD needs the pinned-rate FX service (Decision 7 / M4-M10):
            rendered per spec, inert until the service exists — disclosed. */}
        <Segmented
          ariaLabel="Currency display (inert until the FX service lands)"
          disabled
          value="local"
          options={[
            { value: "local", label: "BHD" },
            { value: "usd", label: "USD" },
          ]}
        />
        <DensityControl />
        <ThemeToggle />
        <Avatar initials="SU" />
      </TopBar>

      {result.ok && result.facts.staleBanner ? (
        <StaleBanner
          daysOld={result.facts.staleBanner.daysOld}
          sinceDisplay={result.facts.staleBanner.sinceDisplay}
        />
      ) : null}

      <main className="space-y-5 p-6">
        <PageHeader
          eyebrow={`Data · ${tenantCode}`}
          title="Data Health"
          subhead={
            <>
              The gap register. Sentinel&rsquo;s accuracy is capped by its worst dataset, so the
              gaps are a first-class screen rather than a warning banner — and the pipeline&rsquo;s
              freshness is rendered from the M9 facts, never from a clock.
            </>
          }
        />

        {!result.ok ? (
          result.phase === "TENANT" ? (
            <ErrorState
              title={`Unknown tenant “${tenantCode}”`}
              detail={result.message}
            />
          ) : (
            <ErrorState title="Data Health could not read its facts." detail={result.message} />
          )
        ) : (
          <>
            <FreshnessPanel facts={result.facts} />

            {result.facts.register.rows.length > 0 ? (
              <>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <KpiTile
                    label="Open gaps"
                    value={String(result.facts.register.kpis.openGaps)}
                    meta="non-resolved register entries"
                    color={result.facts.register.kpis.openGaps > 0 ? "var(--critical)" : "var(--text)"}
                  />
                  <KpiTile
                    label="Refs blocked from planning"
                    value={
                      result.facts.register.kpis.refsBlocked === null
                        ? "—"
                        : String(result.facts.register.kpis.refsBlocked)
                    }
                    meta={
                      result.facts.register.kpis.refsBlocked === null
                        ? "withheld — no payload states it"
                        : "stated by task payloads"
                    }
                    color={
                      result.facts.register.kpis.refsBlocked !== null && result.facts.register.kpis.refsBlocked > 0
                        ? "var(--warn)"
                        : "var(--text)"
                    }
                  />
                  <KpiTile
                    label="Unassigned gaps"
                    value={String(result.facts.register.kpis.unassignedGaps)}
                    meta="no owner named"
                    color={
                      result.facts.register.kpis.unassignedGaps > 0 ? "var(--critical)" : "var(--text)"
                    }
                  />
                  <KpiTile
                    label="Closed this month"
                    value={String(result.facts.register.kpis.closedThisMonth)}
                    meta={`resolved since ${formatUtcMinutes(
                      result.facts.asOfMs
                    ).slice(0, 10)} (UTC)`}
                    color="var(--ok)"
                  />
                </div>

                <Card
                  title="Gap register"
                  aside={
                    <span className="font-sans text-[12.5px] leading-none text-text-3">
                      Every gap has an owner and a screen it blocks. Unassigned gaps are the real
                      problem.
                    </span>
                  }
                >
                  <RegisterTable rows={result.facts.register.rows} />
                </Card>
              </>
            ) : result.facts.ingestCounts.applied > 0 ? (
              <Card title="Gap register">
                <RegisterNotYetRecorded />
              </Card>
            ) : (
              <Card title="Gap register">
                <FirstRunEmpty
                  tenantCode={tenantCode}
                  received={result.facts.ingestCounts.received}
                />
              </Card>
            )}

            {result.facts.disclosures.length > 0 ? (
              <ul className="space-y-1 px-1">
                {result.facts.disclosures.map((d) => (
                  <li key={d} className="font-mono text-[10.5px] leading-[16px] text-text-3">
                    {d}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </main>
    </>
  )
}
