'use strict';
/* ============================================================================
 * canonicalJson — deterministic serialization for the seal payload hash.
 *
 * The seal's integrity claim is SHA256(canonicalJson(payload)); two runs over
 * identical data MUST produce the identical hash, so key insertion order and
 * row order must not matter. Rules:
 *   - object keys sorted lexicographically (undefined values dropped);
 *   - arrays keep order (callers pass pre-sorted rows — plan.js sorts);
 *   - numbers via JSON.stringify (IEEE-754 shortest round-trip).
 *
 * RFC 8785 (JCS) is the ledger standard arriving with H5 in M3; JCS's number
 * serialization (ES6 Number::toString) matches JSON.stringify's for doubles,
 * so these hashes are expected to survive the JCS migration unchanged. Any
 * divergence will be proven by the H5 cross-implementation vectors, never
 * assumed away.
 * ==========================================================================*/

function canonicalJson(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${t}`);
}

module.exports = { canonicalJson };
