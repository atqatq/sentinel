'use strict';
/* ============================================================================
 * auth/policy.js — the M11 session & credential policy floor (audit M11;
 * delivery spec §6.3 M3 + the AuthN/Z row; build spec §10.1, §14.9).
 *
 * THE AUDIT M11 FIX, verbatim in intent: "Session idle/absolute limits, MFA,
 * password policy, and lockout exist only for Origin (§10.1, §14.9).
 * Directors and Sr Buyers approve spend. Fix: MFA mandatory for all
 * approval-capable roles; session policy AT LEAST AS STRICT as Origin's;
 * lockout for all accounts."
 *
 * §14.9's Origin numbers therefore become the FLOOR for every principal:
 *   session timeout 30 min idle / 8 h absolute (build spec §14.9 verbatim).
 * These are named constants, not configuration: a tenant cannot loosen the
 * floor below the spec (the same posture as the C3 tier defaults — D-029:
 * defaults are placeholders; the FLOOR is spec law).
 *
 * The approval-capable role set mirrors the approval module's
 * APPROVAL_ELIGIBLE (the C3 authority on who can cast votes) and is pinned
 * to it by a parity test — two sources, one proof (the D-022 survival
 * pattern).
 * ==========================================================================*/

const SESSION = {
  /* §14.9: session timeout 30 min idle / 8 h absolute — the floor for ALL
   * principals (audit M11: "session policy at least as strict as Origin's"). */
  IDLE_MINUTES: 30,
  ABSOLUTE_HOURS: 8,
};

const LOCKOUT = {
  /* §14.9: "failed-login lockout" (Origin) — extended to all accounts by the
   * audit M11 fix. Five consecutive failures inside the window lock the
   * account; a success clears the failure streak (a remembered password must
   * not deadbolt its owner); the lock itself expires. Named numbers, not
   * guessed ones. */
  FAILURE_THRESHOLD: 5,
  WINDOW_MINUTES: 15,
  LOCK_MINUTES: 15,
};

const PASSWORD = {
  /* §10.1's posture (Argon2id/bcrypt-class hashing, rotation, no plaintext)
   * requires a credential that survives offline attack on a leaked hash
   * database. Twelve characters across at least three of the four classes is
   * the floor this V1 names; the production password lives in the OIDC IdP
   * (delivery spec AuthN/Z row) and THIS floor governs only the lab/bootstrap
   * local-credential path (D-031 names the split). */
  MIN_LENGTH: 12,
  MIN_CLASSES: 3,
};

const TOTP = {
  /* RFC 6238: TOTP-SHA1, 30-second time step, 6 digits — the §10.1 second
   * factor ("TOTP or FIDO2/WebAuthn"; TOTP is the one a server can verify
   * statelessly in this V1; passkeys are the named follow-on). A verification
   * window of ±1 step absorbs clock drift; anything wider would accept a
   * code observed earlier — replay is refused at the enrolment's last-used
   * step, never by widening the window. */
  ALGO: 'sha1',
  STEP_SECONDS: 30,
  DIGITS: 6,
  WINDOW_STEPS: 1,
};

/* The roles that may cast approval votes — the C3 authority
 * (approval.roles.APPROVAL_ELIGIBLE). Pinned by parity in the module tests.
 * MFA is MANDATORY for exactly this set (audit M11). */
const APPROVAL_CAPABLE = ['O', 'SCM', 'SBR'];

function isApprovalCapable(role) {
  return APPROVAL_CAPABLE.includes(role);
}

module.exports = { SESSION, LOCKOUT, PASSWORD, TOTP, APPROVAL_CAPABLE, isApprovalCapable };
