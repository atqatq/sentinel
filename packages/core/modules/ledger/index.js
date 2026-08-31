'use strict';
/* Public contract of the ledger module (ADR-0001: cross-module access goes
 * through this surface, never through src/ internals).
 *
 * The H5 ledger decision layer (gate 11, M3): RFC 8785 (JCS) canonicalization,
 * the keyed HMAC-SHA256 block hash over seq ‖ prevHash ‖ canonicalJson(payload),
 * the §16.2 required-fields gate with payload hygiene (no secrets/PII), the
 * pure chain verifier, and the Class-D consumption path the C3 controls layer
 * feeds (D-029: the denial shape is consumed verbatim, never forked). Pure and
 * deterministic — the HMAC key is injected (secret-manager port, never env,
 * never code); the instant is canonicalized to UTC milliseconds (H4).
 *
 * Tamper-evidence is completed at the database: 0004_ledger denies
 * UPDATE/DELETE to every actor including Origin (grants + RLS + triggers)
 * and the live proof (ledger-live.js, CI db-rls job) walks the real chain.
 */
module.exports = {
  jcs: require('./src/jcs.js'),
  hash: require('./src/hash.js'),
  blocks: require('./src/blocks.js'),
  verify: require('./src/verify.js'),
  records: require('./src/records.js'),
};
