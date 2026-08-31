'use strict';
/* ============================================================================
 * auth/password.js — the local-credential hash and the password policy floor
 * (build spec §10.1 credential handling; audit M11: a password policy for ALL
 * accounts, not only Origin).
 *
 * §10.1 mandates "Argon2id hash (or bcrypt cost ≥ 12). Never plaintext, never
 * reversible." THIS module uses node's native scrypt (RFC 7914) — N=2^15,
 * r=8, p=1, 64-byte key — a memory-hard KDF in the same class, ZERO
 * dependencies (the ADR-0001 no-native-deps discipline the repo is built
 * on). The deviation is named, not silent: production credentials live in
 * the OIDC IdP (delivery spec AuthN/Z row — Keycloak self-host), which
 * implements Argon2id natively; this local path exists for the lab/bootstrap
 * (§14.10) and the D-031 record carries the split.
 *
 * The salt is INJECTED by the caller (crypto.randomBytes at the adapter —
 * the same injectable-entropy discipline as the ledger's HMAC key and the
 * session token). Comparison is timingSafeEqual — never ===.
 * ==========================================================================*/

const crypto = require('crypto');
const { PASSWORD: POLICY } = require('./policy.js');

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
/* node caps scrypt's memory by default (32 MB); N=2^15 × r=8 needs 32 MiB of
 * working space — the ceiling must be raised explicitly or the KDF refuses
 * to run at all. 64 MiB is the honest allowance for this parameter set. */
const MAXMEM = 64 * 1024 * 1024;

function refuse(code, detail) {
  const e = new TypeError(detail ? `${code}: ${detail}` : code);
  e.code = code;
  throw e;
}

/* The one-way hash. password is the only secret input; salt is 16+ random
 * bytes injected by the caller and persisted beside the hash. */
function hash(password, salt) {
  if (typeof password !== 'string' || password.length === 0) {
    refuse('AUTH_PASSWORD_INVALID', 'the password must be a non-empty string');
  }
  if (!Buffer.isBuffer(salt) || salt.length < 16) {
    refuse('AUTH_SALT_INVALID', 'the salt must be a Buffer of at least 16 random bytes (injected entropy)');
  }
  return crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAXMEM }).toString('hex');
}

/* Constant-time verification. Wrong shapes return false — they never throw
 * to the caller (a login form must not distinguish malformed input from a
 * wrong password at this layer; the boundary owns UX). */
function verify(password, salt, expectedHex) {
  if (typeof password !== 'string' || !Buffer.isBuffer(salt) || typeof expectedHex !== 'string') return false;
  const actual = Buffer.from(expectedHex, 'hex');
  const expected = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAXMEM });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/* The policy floor: MIN_LENGTH characters across MIN_CLASSES of
 * {lower, upper, digit, other}. Returns null when the password passes, else
 * the named refusal. The CLASSES are checked, never the CONTENT — no
 * dictionary here, no judgement, just the named floor. */
function check(password) {
  if (typeof password !== 'string' || password.length < POLICY.MIN_LENGTH) {
    return 'AUTH_PASSWORD_TOO_SHORT';
  }
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;
  if (classes < POLICY.MIN_CLASSES) return 'AUTH_PASSWORD_CLASS_MISSING';
  return null;
}

/* Random entropy ports — the ADAPTER calls these at the boundary; the pure
 * layer only pins the SIZES so every caller draws the same amount. */
const ENTROPY = { SALT_BYTES: 16, TOKEN_BYTES: 32 };
function randomSalt(rng) {
  const draw = rng || crypto.randomBytes;
  return draw(ENTROPY.SALT_BYTES);
}
function randomToken(rng) {
  const draw = rng || crypto.randomBytes;
  return draw(ENTROPY.TOKEN_BYTES).toString('hex');
}

module.exports = { hash, verify, check, randomSalt, randomToken, SCRYPT, ENTROPY };
