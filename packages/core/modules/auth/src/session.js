'use strict';
/* ============================================================================
 * auth/session.js — the session lifecycle decisions and the MFA gate on
 * approval-capable principals (audit M11; §14.9's floor for every principal).
 *
 * The session record is DATA (injected — the adapter's row or a test
 * fixture); this module owns only the DECISIONS:
 *
 *   state(session, now) → ACTIVE | IDLE_EXPIRED | ABSOLUTE_EXPIRED |
 *                          TERMINATED      (named, exhaustive, testable)
 *   mayApprove(session) → { ok: true } | { ok: false, reason: 'AUTH_MFA_REQUIRED' }
 *
 * The idle window slides on ACTIVITY (the adapter's touch updates
 * last_seen_at on every authenticated request); the absolute window NEVER
 * slides — 8 hours after creation the session dies no matter how busy it
 * was. A terminated session is dead unconditionally (logout is forever; the
 * row persists as the Class-N record's subject, never resurrected).
 *
 * The MFA gate: a principal whose role is approval-capable (O/SCM/SBR — the
 * C3 authority, pinned by parity) may cast approval votes ONLY when the
 * session was issued over a VERIFIED second factor (mfa_ok). The gate is
 * decided here, re-proven at the database by the RESTRICTIVE mfa_gate
 * policy on approval (0005_auth) — the API+DB pair D-029's discipline
 * demands, neither layer trusted alone.
 * ==========================================================================*/

const { SESSION, isApprovalCapable } = require('./policy.js');

const STATE = Object.freeze({
  ACTIVE: 'ACTIVE',
  IDLE_EXPIRED: 'IDLE_EXPIRED',
  ABSOLUTE_EXPIRED: 'ABSOLUTE_EXPIRED',
  TERMINATED: 'TERMINATED',
});

function refuse(code, detail) {
  const e = new TypeError(detail ? `${code}: ${detail}` : code);
  e.code = code;
  throw e;
}

/* The exhaustive lifecycle decision. now is the injected instant (ms). */
function state(session, nowMs) {
  if (!session || typeof session !== 'object') {
    refuse('AUTH_SESSION_RECORD_INVALID', 'the session record is injected data');
  }
  if (!Number.isFinite(nowMs)) refuse('AUTH_NOW_INVALID', 'now is the injected clock (ms)');
  if (session.terminatedAt !== null && session.terminatedAt !== undefined) return STATE.TERMINATED;
  if (nowMs >= session.absoluteExpiresAt) return STATE.ABSOLUTE_EXPIRED;
  const idleDeadline = session.lastSeenAt + SESSION.IDLE_MINUTES * 60 * 1000;
  if (nowMs >= idleDeadline) return STATE.IDLE_EXPIRED;
  return STATE.ACTIVE;
}

/* Whether THIS session may carry an approval vote into the controls layer.
 * Non-approval-capable roles never vote (the approval module refuses them
 * anyway — this gate is not their story). Approval-capable roles need the
 * verified second factor; mfa_ok is decided at SESSION ISSUANCE (a factor
 * verified mid-life re-issues a session — it never mutates the live one's
 * posture). */
function mayApprove(session) {
  if (!session || typeof session !== 'object') {
    refuse('AUTH_SESSION_RECORD_INVALID', 'the session record is injected data');
  }
  if (!isApprovalCapable(session.role)) return { ok: true, reason: null };
  if (session.mfaOk !== true) return { ok: false, reason: 'AUTH_MFA_REQUIRED' };
  return { ok: true, reason: null };
}

/* The issuance decision — the ONE door to a live session. The principal and
 * the MFA verdict arrive already verified (the login state machine); this
 * function pins the invariants a session record must carry and derives the
 * absolute expiry from the injected clock (the ONE clock argument — creation
 * and last-seen begin at it). The raw token NEVER passes through here — the
 * adapter hashes it before any statement. */
function issue({ userId, tenantId, role, mfaOk, nowMs, sessionId }) {
  if (typeof userId !== 'string' || !userId) refuse('AUTH_ISSUANCE_INVALID', 'userId (uuid) is required');
  if (typeof tenantId !== 'string' || !tenantId) refuse('AUTH_ISSUANCE_INVALID', 'tenantId (uuid) is required');
  if (typeof role !== 'string' || !role) refuse('AUTH_ISSUANCE_INVALID', 'role is required (the session carries the C3 principal)');
  if (typeof mfaOk !== 'boolean') refuse('AUTH_ISSUANCE_INVALID', 'mfaOk must be an explicit boolean — never guessed');
  if (!Number.isFinite(nowMs)) refuse('AUTH_NOW_INVALID', 'now is the injected clock (ms)');
  return {
    sessionId,
    userId,
    tenantId,
    role,
    mfaOk,
    createdAt: nowMs,
    lastSeenAt: nowMs,
    absoluteExpiresAt: nowMs + SESSION.ABSOLUTE_HOURS * 60 * 60 * 1000,
    terminatedAt: null,
  };
}

module.exports = { STATE, state, mayApprove, issue };
