import { TopBar, TopBarSpacer } from "@sentinel/ui/top-bar"
import { Wordmark } from "@sentinel/ui/wordmark"
import { Menubar } from "@sentinel/ui/menubar"
import { SearchTrigger } from "@sentinel/ui/search-trigger"
import { TenantSwitcher } from "@sentinel/ui/tenant-switcher"
import { ThemeToggle } from "@sentinel/ui/theme-toggle"
import { Avatar } from "@sentinel/ui/avatar"
import { PageHeader } from "@sentinel/ui/page-header"

import { DensityControl } from "../shell-controls"
import { SetupWizard } from "./setup-controls"

export const dynamic = "force-dynamic"

/*
 * §14.28 — the setup doors' screen (D-049): the Origin's wizard over the
 * initial setup — Overview (what exists / what's missing, derived from the
 * overview facts by the pure setup module's remainingSteps), Tenants (the
 * founder door), Users & roles (must_change accounts), Approval limits
 * (the §16 amendment) and First ingestion. The commands ride /api/setup/*;
 * the guards render verbatim: a non-Origin visit sees SETUP_NOT_ORIGIN
 * (403) — the honest empty state IS the refusal — and a must-change
 * session sees the rotation interstitial before anything else (§14.28
 * clause 2: a password the account has never chosen must not govern a
 * setup).
 *
 * The shell mirrors the sibling screens (§Layout); the wizard is a client
 * component because the state machine is interactive — every decision
 * inside it lives in the pure module and the adapter, never here.
 */

export default function SetupPage() {
  return (
    <>
      <TopBar>
        <Wordmark />
        <Menubar currentRoute="/setup" />
        <TopBarSpacer />
        <SearchTrigger />
        <TenantSwitcher tenantCode="BahrainMP" />
        <DensityControl />
        <ThemeToggle />
        <Avatar initials="OR" />
      </TopBar>

      <main className="space-y-5 p-6">
        <PageHeader
          eyebrow="Admin · Setup"
          title="Origin Bootstrap"
          subhead={
            <>
              The §14.10 bootstrap, implemented: tenants, accounts, roles and the approval
              limits are created here — by the Origin, under its own session — and the first
              ingestion rides the worker&rsquo;s own pipeline. Every write is Origin-gated at the
              boundary and re-proved by the database&rsquo;s own policies; every refusal is named.
            </>
          }
        />
        <SetupWizard />
      </main>
    </>
  )
}
