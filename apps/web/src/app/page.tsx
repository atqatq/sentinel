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
import { InventoryStatus } from "@sentinel/ui/inventory-status"
import { SupplyStatus } from "@sentinel/ui/supply-status"
import { INVENTORY_STATUSES, SUPPLY_STATUSES } from "@sentinel/ui/status"

import { DensityControl } from "./shell-controls"

/*
 * The scaffold reference page — the SDS shell and the two-axis status
 * language rendered in their real states. This page is NOT a §4 screen:
 * it names itself as scaffolding, fabricates no dataset (the product rule
 * is "no fabricated rows · no spinner · dataset named above"), and every
 * status pill comes from the vocabulary data — no label is hardcoded here
 * (ui/status-vocabulary-binding).
 *
 * The first §4 screen (Data Health, /data-health) has landed; the
 * menubar's remaining EMPTY tags are the honest map of what exists.
 */

const SECTION_LABEL =
  "font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-text-3"

function Card({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-md border border-line bg-surface p-4">
      <h2 className="font-sans text-[16px] font-semibold leading-[22px] text-text">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export default function Home() {
  return (
    <>
      <TopBar>
        <Wordmark />
        <Menubar />
        <TopBarSpacer />
        <SearchTrigger />
        <TenantSwitcher tenantCode="BahrainMP" />
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

      {/* Example state, named as such: the README's own banner copy. The REAL
          banner renders on /data-health from the M9 freshness facts (the
          D-023 clock carve-out is closed there) — never from a clock here. */}
      <StaleBanner daysOld={2} sinceDisplay="2026-08-27 06:14" />

      <main className="space-y-5 p-6">
        <PageHeader
          eyebrow="Data · BahrainMP"
          title="Shell & status language"
          subhead={
            <>
              Scaffold reference for the SDS shell and the two-axis status vocabulary — not a
              §4 screen. The vocabulary renders in its real states below; no dataset is
              fabricated. The banner above is the design handoff&rsquo;s own example, named as
              an example.
            </>
          }
        />

        <Card title="Status language — two independent axes, never merged">
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <p className={SECTION_LABEL}>Inventory status · axis 1</p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {INVENTORY_STATUSES.map((b) => (
                  <li key={b.label} className="flex items-center gap-2">
                    <InventoryStatus status={b.label} />
                    <span className="font-mono text-[10.5px] leading-none text-text-3">
                      {b.tone}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 max-w-[88ch] font-sans text-[12.5px] leading-[18px] text-text-2">
                Binds only to the engine&rsquo;s <span className="font-mono">displayStatus</span>{" "}
                (M1): <span className="font-mono">Not Planned</span> and{" "}
                <span className="font-mono">No Lead Time</span> are the M1 display states the §3.1
                table predates — warn, not muted, so a data gap that blocks planning never renders
                as silence.
              </p>
            </div>
            <div>
              <p className={SECTION_LABEL}>Supply status · axis 2 (additive)</p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {SUPPLY_STATUSES.map((b) => (
                  <li key={b.label} className="flex items-center gap-2">
                    <SupplyStatus status={b.label} />
                    <span className="font-mono text-[10.5px] leading-none text-text-3">
                      {b.tone}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 max-w-[88ch] font-sans text-[12.5px] leading-[18px] text-text-2">
                Square-cornered and outlined so the axes never blur: an item can be healthy{" "}
                <em>and</em> have a late PO. Shape carries the axis; the label carries the state;
                colour is never the sole carrier of meaning.
              </p>
            </div>
          </div>
        </Card>

        <Card title="Governance — what holds this page up">
          <ul className="space-y-2 font-sans text-[13px] leading-[20px] text-text-2">
            <li>
              <span className="font-mono text-[12px] text-text">ui/status-vocabulary-binding</span>{" "}
              — the label→tone tables live once, in{" "}
              <span className="font-mono text-[12px] text-text">packages/ui/status</span>, resolve
              fail-closed (unknown statuses throw), and are tested against the real engine
              exports.
            </li>
            <li>
              <span className="font-mono text-[12px] text-text">ui/no-primitives-outside-packages-ui</span>{" "}
              — every primitive on this page (pills, segmented control, menubar, dropdown) is
              vendored in <span className="font-mono text-[12px] text-text">packages/ui</span>;
              this page only composes them.
            </li>
            <li>
              <span className="font-mono text-[12px] text-text">ui/sds-theme-token-parity</span> —
              theme and density cascade from the two root attributes on{" "}
              <span className="font-mono text-[12px] text-text">&lt;html&gt;</span>; try the
              theme toggle and the density control.
            </li>
          </ul>
        </Card>

        <Card title="Engine live — POST /api/plan">
          <p className="max-w-[88ch] font-sans text-[13px] leading-[20px] text-text-2">
            The plan route is the HTTP transport for the D-022 engine-live contract: it opens one
            tenant-scoped transaction (transaction-local{" "}
            <span className="font-mono text-[12px]">app.tenant_id</span>), injects the pg-backed
            adapter from <span className="font-mono text-[12px] text-text">packages/db</span>, and
            maps the receipt to 200 sealed/replayed · 400 request-shape · 422 data-health refusal ·
            500 wiring. Authenticated tenant identity (session → tenant) replaces the request-carried
            interim when C3 SoD lands in M3.
          </p>
        </Card>
      </main>
    </>
  )
}
