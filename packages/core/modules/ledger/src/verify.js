'use strict';
/* ============================================================================
 * ledger/verify.js — the pure chain verifier (the read side of H5).
 *
 * Walks a tenant's blocks in seq order and re-proves EVERY property the
 * writer claimed (build spec §11 "verification job re-walks the chain
 * nightly"; H5: under a distinct read-only role — the role is the SQL side,
 * migration 0004_ledger; this file is the walk itself):
 *
 *   1. seq continuity — 1..n, no gaps, no forks (the composite PK made a
 *      duplicate structurally impossible; this proves the survivor chain);
 *   2. hash linkage — block 1 hangs off GENESIS (64 zeros); block n hangs
 *      off block n-1's hash;
 *   3. hash correctness — HMAC-SHA256(key, seq ‖ prevHash ‖
 *      canonicalJson(payload)) recomputed from the STORED payload fields,
 *      byte-for-byte;
 *   4. §16.2 integrity — every stored payload still passes the required-
 *      fields gate (a field that went missing from a payload is itself a
 *      detected corruption).
 *
 * Tamper-evidence, not tamper-resistance: alteration is DETECTED here and
 * made IMPOSSIBLE at the database (0004_ledger: grants, RLS, triggers). The
 * verifier NEVER throws for a broken chain — it reports the first break with
 * its seq and reason, because a verifier that dies mid-walk answers fewer
 * questions than one that finishes. A WRONG KEY is a detected condition, not
 * an error: every hash mismatches, which is exactly how a verifier proves it
 * holds the same key the writer held.
 * ==========================================================================*/

const { buildBlock, PAYLOAD_FIELDS } = require('./blocks.js');
const { blockHash, canonicalPayloadOf, GENESIS } = require('./hash.js');

/* Rebuilds the hashed payload from a stored row's fields — the exact key set
 * blocks.js validated at write time. */
function payloadOfRow(row) {
  const payload = {};
  for (const f of PAYLOAD_FIELDS) payload[f] = row[f];
  return payload;
}

function verifyChain(rows, hmacKey) {
  if (!Array.isArray(rows)) throw new TypeError('verifyChain: rows must be an array ordered by seq');
  let prev = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const seq = i + 1;
    if (!row || typeof row !== 'object') {
      return { ok: false, verified: i, brokenAt: seq, reason: 'ROW_NOT_AN_OBJECT' };
    }
    if (!Number.isInteger(row.seq) || row.seq !== seq) {
      return { ok: false, verified: i, brokenAt: seq, reason: `LEDGER_SEQ_GAP: stored seq ${row.seq}, chain expects ${seq}` };
    }
    const expectedPrev = prev === null ? GENESIS : prev;
    if (row.prevHash !== expectedPrev) {
      return { ok: false, verified: i, brokenAt: seq, reason: 'LEDGER_PREV_HASH_MISMATCH: the block does not hang off its predecessor' };
    }
    try {
      const payload = buildBlock(payloadOfRow(row));
      const canonical = canonicalPayloadOf(payload);
      const expected = blockHash(hmacKey, row.seq, row.prevHash, canonical);
      if (row.hash !== expected) {
        return { ok: false, verified: i, brokenAt: seq, reason: 'LEDGER_HASH_MISMATCH: the stored hash is not the hash of the stored payload' };
      }
    } catch (e) {
      return { ok: false, verified: i, brokenAt: seq, reason: `LEDGER_PAYLOAD_CORRUPT: ${e.code || e.message}` };
    }
    prev = row.hash;
  }
  return { ok: true, verified: rows.length };
}

module.exports = { verifyChain, payloadOfRow };
