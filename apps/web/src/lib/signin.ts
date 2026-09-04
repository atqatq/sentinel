/*
 * signin — the post-sign-in landing decision, PURE.
 *
 * The login transport (POST /api/auth/login) answers ISSUE with the
 * session cookie plus the principal; where the browser goes next is a
 * DECISION, and decisions live in pure modules (the setup-controls rule:
 * the client never invents a rule, never coerces a refusal). The map:
 *
 *   - role "O" — the founder role the bootstrap grants, by the door —
 *     lands on /setup: the wizard is the Origin's desk, and a must_change
 *     session meets the rotation interstitial there (§14.28 clause 2: a
 *     password the account has never chosen must not govern a setup);
 *   - every other principal lands on / — the menubar's Overview.
 *
 * No second rotation door is invented here: /setup's interstitial is the
 * ONE must-change screen (§14.10 discipline — one path per door); a
 * non-origin must_change account's own door is a named gap, not a silent
 * coercion into the Origin's wizard.
 */

export type LoginPrincipal = {
  userId: string
  tenantId: string
  tenantCode: string
  role: string
  mfaOk: boolean
  mustChange: boolean
}

export function landingFor(principal: LoginPrincipal): string {
  return principal.role === "O" ? "/setup" : "/"
}
