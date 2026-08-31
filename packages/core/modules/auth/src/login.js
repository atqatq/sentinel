'use strict';
/* ============================================================================
 * auth/login.js — the sign-in state machine and the lockout decision
 * (audit M11: lockout for ALL accounts; §14.9: failed-login lockout;
 * build spec §16.1 Class N: sign-in success and failure, MFA enrolment and
 * challenge outcome, session creation and termination, lockout, credential
 * rotation — every outcome here names the Class-N events it must emit).
 *
 * The machine is decision-only over INJECTED facts:
 *   - credentialOk   — the adapter already ran the scrypt verification
 *   - lock           — the lockout decision (below) over the attempt history
 *   - mfaEnrolled    — the user has a VERIFIED TOTP enrolment
 *   - mfaVerifiedNow — this request carried a valid TOTP code (step 2)
 *
 * The OIDC posture (delivery spec AuthN/Z row: Keycloak in production, lab
 * IdP in dev): an OIDC assertion replaces the LOCAL credential step —
 * credentialOk becomes the IdP's verified claim — and the MFA, session and
 * lockout layers remain exactly this machine. The IdP integration itself is
 * the named deployment concern (OIDC_IDP_NOT_WIRED, D-031): the contract
 * this module pins is the same either way, which is why the machine sits
 * in front of the credential source, not behind it.
 * ==========================================================================*/

const { LOCKOUT } = require('./policy.js');

const OUTCOME = Object.freeze({
  ISSUE: 'ISSUE',                 // credential + (MFA done or not required) → session
  CHALLENGE_MFA: 'CHALLENGE_MFA', // credential ok, MFA enrolled, code not yet given
  REFUSED: 'REFUSED',             // named refusal below
});

/* The Class-N ledger events each outcome obliges (§16.1). The adapter emits
 * them through the ledger adapter; pre-tenant failures (no resolvable user →
 * no tenant chain to append to) live in login_attempt, the append-only
 * record — named in D-031. */
const CLASS_N_EVENTS = Object.freeze({
  ISSUE: ['auth.session.created'],
  CHALLENGE_MFA: ['auth.signin.success', 'auth.mfa.challenge'],
  REFUSED_LOCKED: ['auth.lockout.engaged'],
  REFUSED_CREDENTIALS: ['auth.signin.failure'],
  REFUSED_MFA: ['auth.signin.failure', 'auth.mfa.challenge.failed'],
});

function refuse(code, detail) {
  const e = new TypeError(detail ? `${code}: ${detail}` : code);
  e.code = code;
  throw e;
}

/* The lockout decision over the injected failure history: a list of ms
 * instants of FAILED attempts since the last success (the adapter records
 * SUCCESS and clears the list — a remembered password must not deadbolt its
 * owner; the pure layer only ever sees the live streak). The lock ENGAGES at
 * the fifth failure and persists LOCK_MINUTES from that instant — the
 * sliding window decides WHETHER five failures stacked inside it, never how
 * long the engaged lock lives (a lock that evaporates because its oldest
 * evidence aged out of the window would be a lockout with an amnesia
 * symptom). Locked iff the last five failures span at most the window AND
 * now is before engagement + LOCK_MINUTES. */
function lockoutState(failureTimesMs, nowMs) {
  if (!Array.isArray(failureTimesMs)) refuse('AUTH_HISTORY_INVALID', 'the failure history is injected data');
  if (!Number.isFinite(nowMs)) refuse('AUTH_NOW_INVALID', 'now is the injected clock (ms)');
  const windowMs = LOCKOUT.WINDOW_MINUTES * 60 * 1000;
  const lockMs = LOCKOUT.LOCK_MINUTES * 60 * 1000;
  const sorted = [...failureTimesMs].sort((a, b) => a - b);
  const inWindowCount = sorted.filter((t) => nowMs - t < windowMs).length;
  const lastFive = sorted.slice(-LOCKOUT.FAILURE_THRESHOLD);
  if (lastFive.length < LOCKOUT.FAILURE_THRESHOLD) {
    return { locked: false, failures: inWindowCount, until: null };
  }
  const span = lastFive[lastFive.length - 1] - lastFive[0];
  if (span > windowMs) return { locked: false, failures: inWindowCount, until: null };
  /* engagement = the instant the FIFTH failure landed (the latest of the five) */
  const until = lastFive[lastFive.length - 1] + lockMs;
  if (nowMs < until) return { locked: true, until, failures: inWindowCount };
  return { locked: false, failures: inWindowCount, until: null };
}

/* The full sign-in decision. Throws only on malformed inputs; every
 * legitimate business outcome is a returned verdict (a login attempt is
 * never an exception). */
function decide({ credentialOk, lock, mfaEnrolled, mfaVerifiedNow }) {
  if (typeof credentialOk !== 'boolean') refuse('AUTH_DECISION_INVALID', 'credentialOk must be a decided boolean');
  if (!lock || typeof lock.locked !== 'boolean') refuse('AUTH_DECISION_INVALID', 'lock must be a lockoutState() verdict');
  if (lock.locked) {
    return { outcome: OUTCOME.REFUSED, reason: 'AUTH_LOCKED', events: CLASS_N_EVENTS.REFUSED_LOCKED };
  }
  if (!credentialOk) {
    return { outcome: OUTCOME.REFUSED, reason: 'AUTH_INVALID_CREDENTIALS', events: CLASS_N_EVENTS.REFUSED_CREDENTIALS };
  }
  if (mfaEnrolled === true && mfaVerifiedNow !== true) {
    return { outcome: OUTCOME.CHALLENGE_MFA, reason: null, events: CLASS_N_EVENTS.CHALLENGE_MFA };
  }
  return { outcome: OUTCOME.ISSUE, reason: null, events: CLASS_N_EVENTS.ISSUE };
}

module.exports = { OUTCOME, decide, lockoutState, CLASS_N_EVENTS };
