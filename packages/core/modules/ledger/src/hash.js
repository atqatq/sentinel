'use strict';
/* ============================================================================
 * ledger/hash.js — the H5 block hash: keyed HMAC-SHA256 (build spec §15.2
 * item 3, §11 as amended).
 *
 *   hash = hex( HMAC-SHA256( key, UTF8( seq ‖ prevHash ‖ canonicalJson(payload) )))
 *
 * The §11 construction (seq ‖ prevHash ‖ canonicalJson(payload)) is kept
 * verbatim; H5 upgrades the bare SHA256 to a KEYED HMAC-SHA256 so a database
 * writer cannot forge history without the key, and upgrades the
 * canonicalization to RFC 8785 (jcs.js). Unambiguity of the concatenation:
 * seq is decimal digits, prevHash is ALWAYS exactly 64 lowercase hex chars
 * (enforced here and re-checked by a column CHECK in 0004_ledger), and
 * canonicalJson(payload) always begins with '{' or '[' — the field boundaries
 * cannot shift.
 *
 * THE KEY IS INJECTED. It never lives in code, never in the database, and
 * this module never reads process.env — the runtime obtains it from the
 * secret manager through its port and hands it here. Genesis prevHash is 64
 * zeros. Key rotation is a disclosed non-goal for V1 (D-030): the chain binds
 * hashes, not key ids, so rotation is a future amendment, not a silent
 * afterthought.
 * ==========================================================================*/

const crypto = require('crypto');
const { canonicalizeJson } = require('./jcs.js');

const GENESIS = '0'.repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;

function refuse(code, detail) {
  const e = new TypeError(detail ? `${code}: ${detail}` : code);
  e.code = code;
  throw e;
}

function requireKey(hmacKey) {
  if (typeof hmacKey !== 'string' || hmacKey.length < 32) {
    refuse('LEDGER_KEY_WEAK', 'the HMAC key is injected by the caller (secret manager port) and must be a string of at least 32 chars');
  }
  return hmacKey;
}

/* The block hash over the §16.2 payload fields (seq is concatenated, never
 * inside the hashed JSON — §11's formula as amended by H5). */
function blockHash(hmacKey, seq, prevHash, canonicalPayload) {
  requireKey(hmacKey);
  if (!Number.isInteger(seq) || seq < 1) {
    refuse('LEDGER_SEQ_INVALID', `expected a positive integer, got ${seq}`);
  }
  if (typeof prevHash !== 'string' || !HEX64.test(prevHash)) {
    refuse('LEDGER_PREV_HASH_INVALID', 'prevHash must be 64 lowercase hex chars (GENESIS is 64 zeros)');
  }
  if (typeof canonicalPayload !== 'string') {
    refuse('LEDGER_PAYLOAD_CANONICAL_REQUIRED', 'hash the canonicalJson STRING, never a live object');
  }
  const hmac = crypto.createHmac('sha256', hmacKey);
  hmac.update(String(seq) + prevHash + canonicalPayload, 'utf8');
  return hmac.digest('hex');
}

/* Canonical payload string for the §16.2 field set — the single construction
 * every writer and verifier shares. */
function canonicalPayloadOf(payload) {
  return canonicalizeJson(payload);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

module.exports = { blockHash, canonicalPayloadOf, sha256Hex, GENESIS, HEX64 };
