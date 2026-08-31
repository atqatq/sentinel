'use strict';
/* Public contract of the auth module (ADR-0001: cross-module access goes
 * through this surface, never through src/ internals).
 *
 * The M11 authentication decision layer (gate M11, M3; audit M11 fix):
 * the session-policy floor §14.9 grants to Origin extended to EVERY
 * principal (30 min idle / 8 h absolute), the RFC 6238 TOTP second factor
 * MANDATORY for every approval-capable role, the failed-login lockout for
 * all accounts, the password policy floor, and the sign-in state machine —
 * shaped so an OIDC assertion (Keycloak in production, lab IdP in dev)
 * replaces the local credential step without moving anything else.
 *
 * Pure and deterministic: the clock is injected, the entropy is injected,
 * the attempt history is injected, the session record is data. Every
 * invariant decided here is ENFORCED AGAIN at the database (0005_auth: the
 * RESTRICTIVE mfa_gate policy refuses an approval INSERT without a verified
 * second factor; login_attempt is append-only) — the API+DB pair, neither
 * layer trusted alone.
 */
module.exports = {
  policy: require('./src/policy.js'),
  totp: require('./src/totp.js'),
  password: require('./src/password.js'),
  session: require('./src/session.js'),
  login: require('./src/login.js'),
};
