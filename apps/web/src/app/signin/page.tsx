import { TopBar, TopBarSpacer } from "@sentinel/ui/top-bar"
import { Wordmark } from "@sentinel/ui/wordmark"
import { Menubar } from "@sentinel/ui/menubar"
import { SearchTrigger } from "@sentinel/ui/search-trigger"
import { TenantSwitcher } from "@sentinel/ui/tenant-switcher"
import { ThemeToggle } from "@sentinel/ui/theme-toggle"
import { Avatar } from "@sentinel/ui/avatar"
import { PageHeader } from "@sentinel/ui/page-header"

import { DensityControl } from "../shell-controls"
import { SignInForm } from "./signin-controls"

export const dynamic = "force-dynamic"

/*
 * /signin — the sign-in door (the screen half of §16.1 Class N). The
 * transport is POST /api/auth/login; this page owns only the shell and the
 * honest contract statement: the session rides an httpOnly cookie (the
 * bearer token never lands in a database statement — the adapter stores
 * only its SHA-256), the MFA challenge is the same route's second step,
 * and every refusal renders verbatim — the lockout (AUTH_LOCKED, 423)
 * included. Before this door existed the app told an unauthenticated
 * operator to "Sign in first." with nowhere to walk through; a named
 * refusal without its door is half the §8 contract.
 */

export default function SignInPage() {
  return (
    <>
      <TopBar>
        <Wordmark />
        <Menubar currentRoute="/signin" />
        <TopBarSpacer />
        <SearchTrigger />
        <TenantSwitcher tenantCode="BahrainMP" />
        <DensityControl />
        <ThemeToggle />
        <Avatar initials="OR" />
      </TopBar>

      <main className="space-y-5 p-6">
        <PageHeader
          eyebrow="Admin · Access"
          title="Sign in"
          subhead={
            <>
              The session rides an httpOnly cookie — the bearer token never touches a database
              statement, only its SHA-256 does. The MFA challenge rides the same route as its
              second step; every refusal renders verbatim, the lockout (AUTH_LOCKED) included.
            </>
          }
        />
        <SignInForm />
      </main>
    </>
  )
}
