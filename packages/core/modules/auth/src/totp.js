'use strict';
/* ============================================================================
 * auth/totp.js — RFC 6238 TOTP verification (the §10.1 second factor, made
 * mandatory for every approval-capable role by the audit M11 fix).
 *
 *   TOTP(K, T) = truncate(HMAC-SHA1(K, counter(T))) mod 10^digits
 *   counter(T) = floor(UnixSeconds(T) / 30)
 *
 * The implementation is the RFC verbatim: the 8-byte big-endian counter,
 * HMAC-SHA1 (RFC 2104) over the base32-decoded (RFC 4648 §6) secret, dynamic
 * truncation on the low four bits, mod 10^6. The RFC 6238 Appendix B SHA-1
 * test vectors are pinned in the suite STATED FROM THE RFC — never computed
 * by this code (the H12 checksum discipline; the implementation must match
 * the paper, not itself).
 *
 * Verification is decision-only: verify(secret, code, nowMs, lastUsedStep)
 * returns { ok, matchedStep } or { ok: false, code: named refusal }. The
 * ±1 step window absorbs clock drift; REPLAY is refused by the caller's
 * lastUsedStep (matchedStep must be STRICTLY greater) — the window never
 * widens to accommodate a reused code.
 * ==========================================================================*/

const crypto = require('crypto');
const { TOTP: POLICY } = require('./policy.js');

function refuse(code, detail) {
  const e = new TypeError(detail ? `${code}: ${detail}` : code);
  e.code = code;
  throw e;
}

/* RFC 4648 §6 base32 (A–Z, 2–7); padding optional, lowercase tolerated on
 * input — enrolment secrets arrive from authenticator apps that disagree
 * about case and padding, and the secret's ENTROPY is unaffected. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  if (typeof input !== 'string') refuse('TOTP_SECRET_INVALID', 'the TOTP secret must be a base32 string');
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  if (clean.length === 0) refuse('TOTP_SECRET_INVALID', 'the TOTP secret is empty');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) refuse('TOTP_SECRET_INVALID', `non-base32 character ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/* The hotp truncation (RFC 4226 §5.3) shared by every TOTP verification. */
function hotp(keyBuf, counter, digits) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const bin = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

function stepOf(nowMs) {
  if (!Number.isFinite(nowMs)) refuse('TOTP_NOW_INVALID', 'nowMs must be a finite number (the clock is injected)');
  return Math.floor(nowMs / 1000 / POLICY.STEP_SECONDS);
}

/* Verify one 6-digit code against the secret at the injected instant.
 * lastUsedStep: the highest step already ACCEPTED for this enrolment (null
 * for a fresh enrolment). A match at a step ≤ lastUsedStep is a replay —
 * refused by name even though the code itself is cryptographically fresh. */
function verify(secret, code, nowMs, lastUsedStep) {
  if (typeof code !== 'string' || !new RegExp(`^\\d{${POLICY.DIGITS}}$`).test(code)) {
    return { ok: false, reason: 'AUTH_MFA_INVALID' };
  }
  const keyBuf = base32Decode(secret);
  const current = stepOf(nowMs);
  for (let drift = -POLICY.WINDOW_STEPS; drift <= POLICY.WINDOW_STEPS; drift++) {
    const step = current + drift;
    if (step < 0) continue;
    if (lastUsedStep !== null && lastUsedStep !== undefined && step <= lastUsedStep) continue;
    if (hotp(keyBuf, step, POLICY.DIGITS) === code) {
      return { ok: true, matchedStep: step };
    }
  }
  return { ok: false, reason: 'AUTH_MFA_INVALID' };
}

/* The enrolment pairing: what the authenticator app should currently show —
 * used by the enrolment flow's confirmation step and by tests to build a
 * code at an arbitrary pinned instant (never a shortcut past verify). */
function codeAt(secret, nowMs) {
  return hotp(base32Decode(secret), stepOf(nowMs), POLICY.DIGITS);
}

module.exports = { verify, codeAt, base32Decode, stepOf, hotp };
