'use strict';
/* ============================================================================
 * Ingestion boundary v1 — idempotent upsert wrapper (H6, A7).
 *
 * Contract source: INGESTION_FILE_SPEC §4 ("Idempotency: re-importing the
 * same file changes nothing" + the per-kind key list), build spec §15.2 H6
 * ("Prefix every key with tenant"), delivery spec A7 / gate 12 with the
 * named proof `ingest/idempotent-per-tenant-replay`, and the M1 exit
 * review's scheduled residual: "the application-level idempotent upsert
 * wrapper (replay → no-op) is pipeline wiring and lands with the ingestion
 * worker" (M2).
 *
 * Why this is load-bearing: the database already refuses collisions
 * structurally (every UNIQUE index leads with tenant_id — migration.sql's
 * H6 note; the RLS deny-matrix proved a same-tenant replay violates 23505
 * while the other tenant sails through). But a constraint violation is an
 * ERROR, not a workflow. The application layer needs the decision BEFORE
 * the write: this file computes the per-row idempotency keys, compares them
 * with the tenant's register, and turns a re-import into a REPLAY_NOOP —
 * the same file applied twice changes nothing, deterministically, per
 * tenant — instead of a 23505 stack trace. DAT-04 ("Duplicate-hit rate %
 * — idempotency keys seen before") is fed by the same numbers.
 *
 * Tenant scoping is STRUCTURAL, not string-prefixed: the key this module
 * derives is the row's BUSINESS identity; the register
 * (idempotency_key: UNIQUE tenant_id + kind + idem_key) supplies the
 * tenant dimension by column, exactly as the schema comment states
 * ("the idempotency key IS tenant-scoped by construction"). Deriving the
 * key from the row alone is what makes the same fixture portable across
 * tenants while their rows stay independent.
 *
 * Decision rights (kept narrow, mirroring the pipeline's other stages):
 *   - keys derive from the CANONICAL fields the earlier stages produced —
 *     date canonicalization is the boundary's H4 obligation upstream and is
 *     not re-guessed here;
 *   - intra-file duplicate keys COLLAPSE deterministically: last occurrence
 *     wins (equivalent to sequential upsert of the file's rows), the
 *     collapse is disclosed in the plan, never silent (spec §4: "duplicate
 *     keys collapsed deterministically");
 *   - a prior ingest_file row with status APPLIED for the same
 *     (tenant, kind, checksum) → REPLAY_NOOP carrying the prior outcome's
 *     identity; any other prior status (RECEIVED / QUARANTINED / FAILED)
 *     → APPLY reprocessing THE SAME register row (the adapter updates it —
 *     a retry must not fork the file history);
 *   - fail-closed: a row without its key fields, an unknown kind, a
 *     malformed checksum, an unknown file status or mode is REFUSED, never
 *     coerced — the strict-parse discipline applied to identity.
 *
 * Pure: no-db, no-react, no-framework, no-io, no-clock. Deterministic:
 * identical inputs produce deep-equal, JSON-round-trip-stable plans.
 * The SQL executor lives in packages/db/ingest-adapter.js (the db package
 * owns SQL); this module owns the decision.
 * ==========================================================================*/

const MANIFEST = require('../sentinel.module.json');
const DATASET_KINDS = Object.freeze([...MANIFEST.ingestionKinds]);
const KIND_SET = new Set(DATASET_KINDS);

/* ingest_file_status values (migrations/0001_init) — the wrapper reads a
 * prior row's status and must refuse anything outside the enum. */
const INGEST_FILE_STATUSES = Object.freeze(['RECEIVED', 'QUARANTINED', 'APPLIED', 'FAILED']);

/* INGESTION_FILE_SPEC §1: Mode A (raw Precoro exports) / Mode B (the
 * combined template workbook) — "both produce identical results". */
const FILE_MODES = Object.freeze(['A', 'B']);

const CHECKSUM_RE = /^[0-9a-f]{64}$/;

/* ---- per-kind key rules -----------------------------------------------------
 * INGESTION_FILE_SPEC §4 names six keys — Item `SKU`; Inventory
 * `SKU+Warehouse`; PO `PO Number+SKU`; Supplier `Supplier ID` (the H7/A8
 * identity key, `Name` interim until the amended R4 ships); Deliveries
 * `Tenant+Date`; Params `Recipe Ref+Tenant` — where the `Tenant` element
 * is carried by the register's tenant_id column (H6 structural), so the
 * derived key holds the remaining business fields. The two kinds the six-
 * key list does not name take their identity from the schema's structural
 * uniques: consumption_balance (tenant, sku, period_start, period_end) and
 * category_owner (tenant, category). Field names are the canonical bound
 * fields (filebinding.js ALIASES).
 * --------------------------------------------------------------------------- */
const KEY_FIELDS = Object.freeze({
  items: ['sku'],
  inventory_all_dimensions: ['sku', 'warehouse'],
  consumption_balances: ['sku', 'periodStart', 'periodEnd'],
  open_pos: ['poNumber', 'sku'],
  deliveries: ['periodStart', 'periodEnd', 'granularity'],
  planning_params: ['recipeRef'],
  category_owners: ['category'],
});

/** Collapse internal whitespace and trim — §3.1's header discipline applied
 * to key values. Case is preserved: code spelling is identity. */
function normalizePart(value, field) {
  if (value === undefined || (typeof value === 'string' && value.replace(/\s+/g, ' ').trim() === '')) {
    throw new TypeError(`MISSING_IDEMPOTENCY_KEY: key field '${field}' is empty/missing — a row without its idempotency key can never be applied idempotently`);
  }
  if (typeof value !== 'string') {
    throw new TypeError(`INVALID_IDEMPOTENCY_KEY: key field '${field}' must be a string, got ${value === null ? 'null' : typeof value}`);
  }
  return value.replace(/\s+/g, ' ').trim();
}

function supplierKeyParts(row) {
  /* H7: Supplier ID is the identity key the moment the export carries it;
   * the identity BASE is part of the key so an external-ID identity and a
   * name identity can never alias the same register slot. */
  if (row.supplierExternalId !== undefined && row.supplierExternalId !== null) {
    return ['ext', normalizePart(row.supplierExternalId, 'supplierExternalId')];
  }
  return ['name', normalizePart(row.supplierName, 'supplierName')];
}

/**
 * The idempotency key of one upsert-ready row — JSON.stringify of the
 * normalized key parts: collision-proof (no separator ambiguity), stable
 * across processes, and printable enough for DAT-04 operations queries.
 */
function idempotencyKey(kind, row) {
  if (!KIND_SET.has(kind)) {
    throw new TypeError(`UNKNOWN_DATASET_KIND: '${String(kind)}' is not an ingestion dataset kind`);
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`INVALID_ROW: idempotencyKey expects a row object for kind '${kind}'`);
  }
  let parts;
  if (kind === 'suppliers') {
    parts = supplierKeyParts(row);
  } else {
    parts = KEY_FIELDS[kind].map((f) => normalizePart(row[f], f));
  }
  return JSON.stringify(parts);
}

/* ---- input validation (fail-closed, named codes) --------------------------- */

function requireString(v, code, what) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new TypeError(`${code}: ${what} must be a non-empty string`);
  }
  return v;
}

function validateSeen(seen) {
  if (seen === undefined || seen === null) return new Set();
  const arr = Array.isArray(seen) ? seen
    : (seen instanceof Set ? [...seen] : null);
  if (arr === null) throw new TypeError('INVALID_SEEN: seen must be an array or Set of idempotency-key strings');
  const set = new Set();
  for (const k of arr) {
    if (typeof k !== 'string') throw new TypeError('INVALID_SEEN: every seen entry must be a string idempotency key');
    set.add(k);
  }
  return set;
}

function validatePrior(prior) {
  if (prior === undefined || prior === null) return null;
  if (typeof prior !== 'object' || Array.isArray(prior)) {
    throw new TypeError('INVALID_PRIOR: prior must be a { status, id?, appliedAt? } ingest_file row');
  }
  if (!INGEST_FILE_STATUSES.includes(prior.status)) {
    throw new TypeError(`INVALID_PRIOR: prior.status '${String(prior.status)}' is not an ingest_file_status`);
  }
  if (prior.id !== undefined && prior.id !== null && (typeof prior.id !== 'string' || prior.id.trim() === '')) {
    throw new TypeError('INVALID_PRIOR: prior.id, when present, must be a non-empty string');
  }
  if (prior.appliedAt !== undefined && prior.appliedAt !== null
      && (typeof prior.appliedAt !== 'number' || !Number.isFinite(prior.appliedAt))) {
    throw new TypeError('INVALID_PRIOR: prior.appliedAt, when present, must be a finite epoch-ms number or null');
  }
  return prior;
}

/* ---- the decision ----------------------------------------------------------- */

/**
 * planIngestFile({ tenantId, kind, checksum, fileName, byteSize, mode,
 *                  rows, seen?, prior? })
 *
 * Returns the apply decision for one validated, upsert-ready file:
 *
 *   { action: 'APPLY',  tenantId, kind, checksum, fileName, byteSize, mode,
 *     rows: [{ key, row }...]          — collapsed: first-occurrence ORDER,
 *                                        LAST occurrence's payload,
 *     collapsedKeys: [{ key, occurrences }...] — only keys seen >1 time,
 *     reprocessOf: prior id or null    — the SAME ingest_file row is updated,
 *     keysIngested, duplicateHits, newKeys,   — DAT-04 numerator/denominator,
 *     disclosures: [...], idempotent: true }
 *
 *   { action: 'REPLAY_NOOP', tenantId, kind, checksum,
 *     fileId, priorStatus: 'APPLIED', appliedAt,   — the prior outcome's identity
 *     keysIngested, duplicateHits, newKeys: 0, rowsApplied: 0, rows: [],
 *     disclosures: [...], idempotent: true }
 *
 * The caller loads `seen` and `prior` through ports (packages/db/
 * ingest-adapter.js: loadSeenKeys / findFile) — this module never touches a
 * database. `duplicateHits` counts collapsed keys ALREADY IN THE REGISTER
 * (honest accounting, computed from seen — never assumed from the replay
 * decision); DAT-04's ratio is the KPI layer's job (the screen restates no
 * spec number).
 */
function planIngestFile(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('INVALID_INPUT: planIngestFile expects a { tenantId, kind, checksum, fileName, byteSize, mode, rows } object');
  }
  const tenantId = requireString(input.tenantId, 'INVALID_TENANT', 'tenantId');
  const kind = requireString(input.kind, 'INVALID_KIND', 'kind');
  if (!KIND_SET.has(kind)) {
    throw new TypeError(`UNKNOWN_DATASET_KIND: '${kind}' is not an ingestion dataset kind`);
  }
  const checksum = requireString(input.checksum, 'INVALID_CHECKSUM', 'checksum');
  if (!CHECKSUM_RE.test(checksum)) {
    throw new TypeError('INVALID_CHECKSUM: checksum must be a lowercase 64-hex sha256');
  }
  const fileName = requireString(input.fileName, 'INVALID_FILE_NAME', 'fileName');
  const byteSize = input.byteSize;
  if (!Number.isInteger(byteSize) || byteSize < 0) {
    throw new TypeError('INVALID_BYTE_SIZE: byteSize must be a non-negative integer');
  }
  const mode = requireString(input.mode, 'INVALID_MODE', 'mode');
  if (!FILE_MODES.includes(mode)) {
    throw new TypeError(`INVALID_MODE: mode '${mode}' is not an INGESTION_FILE_SPEC §1 mode (A|B)`);
  }
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    throw new TypeError('EMPTY_ROWS: rows must be a non-empty array — an apply of zero rows is never a real file');
  }
  const seen = validateSeen(input.seen);
  const prior = validatePrior(input.prior);

  /* ---- collapse intra-file duplicates: first-occurrence order, last payload */
  const byKey = new Map();
  const occurrences = new Map();
  for (const row of input.rows) {
    const key = idempotencyKey(kind, row);
    occurrences.set(key, (occurrences.get(key) || 0) + 1);
    byKey.set(key, { key, row }); // last occurrence's payload wins
  }
  const rows = [...byKey.values()];
  const collapsedKeys = [...occurrences.entries()]
    .filter(([, n]) => n > 1)
    .map(([key, n]) => ({ key, occurrences: n }));

  const keysIngested = rows.length;
  let duplicateHits = 0;
  for (const r of rows) if (seen.has(r.key)) duplicateHits++;
  const newKeys = keysIngested - duplicateHits;

  /* ---- replay: the SAME file was already APPLIED — changes nothing --------- */
  if (prior && prior.status === 'APPLIED') {
    return {
      action: 'REPLAY_NOOP',
      tenantId, kind, checksum, fileName, byteSize, mode,
      fileId: prior.id !== undefined ? prior.id : null,
      priorStatus: 'APPLIED',
      appliedAt: prior.appliedAt !== undefined ? prior.appliedAt : null,
      keysIngested, duplicateHits, newKeys: keysIngested - duplicateHits,
      rowsApplied: 0,
      rows: [],
      disclosures: [
        'replay-no-op: ingest_file (tenant, kind, checksum) is already APPLIED — no rows re-applied, applied_at unchanged',
      ],
      idempotent: true,
    };
  }

  /* ---- apply (fresh, or reprocessing a RECEIVED/QUARANTINED/FAILED row) --- */
  const disclosures = [];
  if (prior) {
    disclosures.push(`reprocess: prior ingest_file row (status ${prior.status}) is updated in place — a retry never forks the file history`);
  }
  for (const c of collapsedKeys) {
    disclosures.push(`duplicate keys collapsed deterministically: ${c.key} occurred ${c.occurrences} times — last occurrence applied, order kept at first occurrence`);
  }
  if (seen.size > 0 && duplicateHits > 0) {
    disclosures.push(`${duplicateHits} of ${keysIngested} keys are already in this tenant's register (DAT-04 re-upload hygiene) — upserted in place, never duplicated`);
  }

  return {
    action: 'APPLY',
    tenantId, kind, checksum, fileName, byteSize, mode,
    rows,
    collapsedKeys,
    reprocessOf: prior && prior.id ? prior.id : null,
    keysIngested, duplicateHits, newKeys,
    disclosures,
    idempotent: true,
  };
}

module.exports = {
  DATASET_KINDS,
  INGEST_FILE_STATUSES,
  FILE_MODES,
  KEY_FIELDS,
  idempotencyKey,
  planIngestFile,
};
