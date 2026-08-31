'use strict';
/* ============================================================================
 * ledger/jcs.js — RFC 8785 (JSON Canonicalization Scheme) canonicalization.
 *
 * THE canonicalization standard of the H5 ledger (build spec §15.2 item 3,
 * delivery spec §2 "Ledger crypto" row): every hash input is the JCS form of
 * the payload — byte-identical across implementations, so a verifier written
 * in any language reproduces Sentinel's hashes from the same fixtures
 * (fixtures/ledger/jcs-vectors.json, checksum-pinned per the H12 discipline).
 *
 * Normative rules implemented here (RFC 8785 §3.2):
 *   - primitives: true/false/null; numbers per ECMAScript Number::toString
 *     (shortest round-trip; -0 serializes "0"; NaN/Infinity are NOT JSON —
 *     they refuse, they never become "null" the way bare JSON.stringify
 *     would render them);
 *   - strings: JSON escaping per §3.2.2.2 — " and \ escaped, U+0000..U+001F
 *     as \b \t \n \f \r or lowercase \u00xx, every other code point literal
 *     (non-ASCII is NOT \u-escaped);
 *   - objects: keys sorted by UTF-16 code unit order (the relational string
 *     order — explicit comparator, not a default-sort accident), values whose
 *     key maps to undefined are dropped (the JS-binding rule the seal's
 *     canonicalJson already ships — pinned identical by the survival vectors);
 *   - arrays: order preserved (callers pass pre-sorted rows).
 *
 * The plan-service seal (D-022) hashes with its own canonicalJson — sorted
 * keys, JSON.stringify numbers/strings. For every well-formed value the two
 * serializations are byte-identical, so D-022's stored hashes SURVIVE the JCS
 * transition — proven by the H5 vectors (test/ledger.test.js + the
 * plan-service survival suite), never assumed.
 * ==========================================================================*/

function compareUtf16(a, b) {
  /* RFC 8785 §3.2.3 sorts on UTF-16 code units; the relational comparison is
   * exactly that order in JavaScript (no locale, no normalization). */
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalizeJson(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('jcs: NaN/Infinity are not JSON — a hash input may never render them (they would silently become null)');
    }
    if (Object.is(value, -0)) return '0';
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalizeJson(v)).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort(compareUtf16);
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalizeJson(value[k])).join(',') + '}';
  }
  throw new TypeError(`jcs: unsupported value of type ${t}`);
}

module.exports = { canonicalizeJson, compareUtf16 };
