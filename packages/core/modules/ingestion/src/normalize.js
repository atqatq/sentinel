'use strict';
/* ============================================================================
 * Ingestion boundary v1 — normalization stage (C1 + C2, unit resolution).
 *
 * Pipeline position (INGESTION_FILE_SPEC §1):
 *   detect kind → strip instruction rows → whitelist columns → normalize
 *   units → validate → idempotent upsert
 *
 * Contract line (single philosophy, mirrors engine R3 "refuse, don't guess"):
 *   - Data-level gaps are REFUSED with a stable named reason (unresolved unit
 *     spelling, missing conversion factor, unpinned FX rate, unsupported
 *     currency) and returned for data-health — never guessed, never defaulted.
 *   - A thrown error from this module means the PIPELINE is wired wrong
 *     (stage-composition violation): the parse stage (parse.js) guarantees
 *     that surviving rows carry finite numbers. A string where a number
 *     belongs is a programmer error, not corrupt data.
 *   - tenantCurrency is a MANDATORY argument (mirror of engine R1: an
 *     optional tripwire that the caller forgets is fail-open).
 *
 * Currency surface (V3 build spec §decision 7): "MP local ↔ USD reserve
 * only. USD rate pinned for 24h per tenant-day." A row in any third currency
 * is refused (CURRENCY_NOT_SUPPORTED) — the audit probe (10,000 BHD + 10,000
 * AED summed to 20,000) is exactly what this kills at the boundary.
 * Rate direction is named, not implied: usdToLocalByDay — tenantValue =
 * amount × usdToLocal. Inverted-direction FX errors are a classic silent
 * order-of-magnitude defect; the name IS the guard.
 *
 * Pure core: no-db, no-react, no-framework, no-io, no-clock. asOf / asOfDay
 * are injected; same inputs → same outputs, forever.
 * ==========================================================================*/

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------------------------------------------------------------------------
 * Unit catalog + alias resolution (ingestion spec: "every unit resolves
 * against the canonical catalog → unresolved spellings raise a data-health
 * item"). The catalog is TENANT DATA (screen 32 Reference & Settings); it is
 * always injected here — nothing is hardcoded.
 * -------------------------------------------------------------------------*/

/** Fail-closed catalog validation. Throws on anything that would later
 *  resolve silently wrong: duplicate canonical entries, aliases pointing
 *  outside the canonical set, or two aliases colliding after normalization
 *  (a "last one wins" map is a silent guess — refused here instead). */
function validateUnitCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new TypeError('validateUnitCatalog: catalog must be an object');
  }
  const canonical = catalog.canonical;
  if (!Array.isArray(canonical) || canonical.length === 0) {
    throw new TypeError('validateUnitCatalog: canonical must be a non-empty array');
  }
  const seen = new Set();
  for (const u of canonical) {
    if (typeof u !== 'string' || u.trim() === '') {
      throw new TypeError('validateUnitCatalog: canonical units must be non-empty strings');
    }
    const key = u.trim().toUpperCase();
    if (seen.has(key)) {
      throw new TypeError(`validateUnitCatalog: duplicate canonical unit '${u}'`);
    }
    seen.add(key);
  }
  const aliases = catalog.aliases == null ? {} : catalog.aliases;
  if (typeof aliases !== 'object' || Array.isArray(aliases)) {
    throw new TypeError('validateUnitCatalog: aliases must be an object');
  }
  const aliasSeen = new Map(); // normalized alias -> original key
  for (const [aliasRaw, targetRaw] of Object.entries(aliases)) {
    if (typeof aliasRaw !== 'string' || aliasRaw.trim() === '') {
      throw new TypeError('validateUnitCatalog: alias keys must be non-empty strings');
    }
    if (typeof targetRaw !== 'string' || !seen.has(targetRaw.trim().toUpperCase())) {
      throw new TypeError(`validateUnitCatalog: alias '${aliasRaw}' targets '${targetRaw}' which is not a canonical unit`);
    }
    const key = aliasRaw.trim().toUpperCase();
    if (aliasSeen.has(key) && aliasSeen.get(key) !== aliasRaw.trim()) {
      throw new TypeError(`validateUnitCatalog: aliases '${aliasSeen.get(key)}' and '${aliasRaw}' collide after normalization`);
    }
    aliasSeen.set(key, aliasRaw.trim());
  }
  return true;
}

/** Resolve a raw unit spelling against the catalog. Returns
 *  {ok:true, unit} with the CANONICAL name, or
 *  {ok:false, reason} with MISSING | NOT_A_STRING | UNRESOLVED_UNIT.
 *  UNRESOLVED_UNIT is a data-health item, not an exception (ingestion spec
 *  line: unresolved spellings raise a data-health item). */
function resolveUnit(raw, catalog) {
  validateUnitCatalog(catalog);
  if (raw === null || raw === undefined) return { ok: false, reason: 'MISSING' };
  if (typeof raw !== 'string') return { ok: false, reason: 'NOT_A_STRING', raw };
  const key = raw.trim().toUpperCase();
  if (key === '') return { ok: false, reason: 'MISSING' };
  for (const u of catalog.canonical) {
    if (u.trim().toUpperCase() === key) return { ok: true, unit: u };
  }
  const aliases = catalog.aliases || {};
  for (const [aliasRaw, targetRaw] of Object.entries(aliases)) {
    if (aliasRaw.trim().toUpperCase() === key) return { ok: true, unit: targetRaw };
  }
  return { ok: false, reason: 'UNRESOLVED_UNIT', raw: String(raw) };
}

/* ---------------------------------------------------------------------------
 * C1 — conversion applied AT INGESTION, before openPO reaches the engine
 * (build spec §15.1 C1: "Ingestion must call this before openPO reaches the
 * engine"). Purchase units (CTN, BTL) → planning units via the item-master
 * Conversion Factor. Refuses when the factor is absent or unusable — a
 * missed conversion is an order-of-magnitude error in BOTH directions.
 * -------------------------------------------------------------------------*/

/** rows: parse-stage survivors — `waiting` is a finite number, `sku` a
 *  string. cfBySku: map SKU → conversion factor from the items feed.
 *  Stage-composition violation (non-finite waiting) throws TypeError.
 *  Unconvertible rows are RETURNED for data-health with stable reason codes:
 *  MISSING_CONVERSION_FACTOR (engine R3 raises the same code) or
 *  INVALID_CONVERSION_FACTOR (present but ≤ 0 / non-finite). */
function convertOpenPoRows(rows, cfBySku, asOf) {
  if (!Array.isArray(rows)) {
    throw new TypeError('convertOpenPoRows: rows must be an array');
  }
  const out = { converted: [], unconverted: [], convertedCount: 0 };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Number.isFinite(row.waiting)) {
      throw new TypeError(`convertOpenPoRows: row ${i} 'waiting' is not a finite number — parse stage must run first`);
    }
    const cfRaw = cfBySku ? cfBySku[row.sku] : undefined;
    if (cfRaw === undefined || cfRaw === null) {
      out.unconverted.push({ rowIndex: i, sku: row.sku, waiting: row.waiting, reason: 'MISSING_CONVERSION_FACTOR', asOf });
      continue;
    }
    const cf = Number(cfRaw);
    if (!Number.isFinite(cf) || cf <= 0) {
      out.unconverted.push({ rowIndex: i, sku: row.sku, waiting: row.waiting, reason: 'INVALID_CONVERSION_FACTOR', asOf });
      continue;
    }
    out.converted.push({ ...row, waitingConverted: row.waiting * cf, conversionFactor: cf });
    out.convertedCount++;
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * C2 — money normalized AT INGESTION: store documentCurrency AND tenantValue
 * at the pinned rate. The engine (R1) already withholds KPIs when mixed
 * currencies reach it; this function keeps them from reaching it at all.
 * -------------------------------------------------------------------------*/

/** Fail-closed rate-table validation. Shape:
 *  { usdToLocalByDay: { 'YYYY-MM-DD': <positive finite number> } }
 *  Keys must match the strict day shape — a typo'd key ('2026-1-5') would
 *  silently miss its pin and fail every row that day; refuse the TABLE
 *  instead. Rates must be positive finite. */
function validateRateTable(rateTable) {
  if (!rateTable || typeof rateTable !== 'object' || Array.isArray(rateTable)) {
    throw new TypeError('validateRateTable: rateTable must be an object');
  }
  const byDay = rateTable.usdToLocalByDay;
  if (!byDay || typeof byDay !== 'object' || Array.isArray(byDay)) {
    throw new TypeError('validateRateTable: usdToLocalByDay must be an object');
  }
  for (const [day, rate] of Object.entries(byDay)) {
    if (!DAY_KEY_RE.test(day)) {
      throw new TypeError(`validateRateTable: day key '${day}' is not YYYY-MM-DD`);
    }
    const r = Number(rate);
    if (!Number.isFinite(r) || r <= 0) {
      throw new TypeError(`validateRateTable: rate for ${day} must be a positive finite number`);
    }
  }
  return true;
}

/** row: { amount, documentCurrency, asOfDay } — amount is a parse-stage
 *  survivor (finite number; non-finite throws). tenantCurrency is MANDATORY
 *  (throws when absent — R1 mirror). rateTable is validated on every call
 *  (cheap; a malformed table must never be ingested against).
 *
 *  Outcomes:
 *   - documentCurrency === tenantCurrency → rate 1, rateSource 'LOCAL'.
 *   - documentCurrency === 'USD'          → rate from usdToLocalByDay[asOfDay],
 *                                           rateSource 'PINNED_USD'; no pin
 *                                           for that day → RATE_NOT_PINNED.
 *   - anything else                        → CURRENCY_NOT_SUPPORTED
 *                                           (Decision 7: local ↔ USD only).
 *  Success: { ok:true, tenantValue, rate, rateSource, documentCurrency,
 *             tenantCurrency, asOfDay }. */
function normalizeMoney(row, tenantCurrency, rateTable) {
  if (!row || typeof row !== 'object') {
    throw new TypeError('normalizeMoney: row must be an object');
  }
  if (!Number.isFinite(row.amount)) {
    throw new TypeError('normalizeMoney: row.amount is not a finite number — parse stage must run first');
  }
  if (typeof tenantCurrency !== 'string' || tenantCurrency.trim() === '') {
    throw new TypeError('normalizeMoney: tenantCurrency is required (fail-closed money layer, R1 mirror)');
  }
  const tenant = tenantCurrency.trim().toUpperCase();
  if (typeof row.documentCurrency !== 'string' || row.documentCurrency.trim() === '') {
    return { ok: false, reason: 'MISSING_CURRENCY' };
  }
  const doc = row.documentCurrency.trim().toUpperCase();
  const asOfDay = row.asOfDay;

  if (doc === tenant) {
    return { ok: true, tenantValue: row.amount, rate: 1, rateSource: 'LOCAL', documentCurrency: doc, tenantCurrency: tenant, asOfDay };
  }
  if (doc === 'USD') {
    validateRateTable(rateTable);
    const byDay = rateTable.usdToLocalByDay;
    const has = asOfDay != null && Object.prototype.hasOwnProperty.call(byDay, asOfDay);
    if (!has) {
      return { ok: false, reason: 'RATE_NOT_PINNED', documentCurrency: doc, tenantCurrency: tenant, asOfDay };
    }
    const rate = Number(byDay[asOfDay]);
    return { ok: true, tenantValue: row.amount * rate, rate, rateSource: 'PINNED_USD', documentCurrency: doc, tenantCurrency: tenant, asOfDay };
  }
  return { ok: false, reason: 'CURRENCY_NOT_SUPPORTED', documentCurrency: doc, tenantCurrency: tenant, asOfDay };
}

/* ---------------------------------------------------------------------------
 * §14.6c — the Purchase Order Status surface, normalized to the closed
 * vocabulary. Trim + case-fold (the §3.1 header discipline, applied to the
 * VALUE); the three lifecycle states are the only words the supply-status
 * producer accepts. Absent is NOT an error — the caller degrades to
 * live-line and discloses the degradation once per run. Present-but-unknown
 * is the INVALID_CONVERSION_FACTOR posture: never coerced, quarantined by
 * name (PO_STATUS_UNKNOWN).
 * -------------------------------------------------------------------------*/
const PO_STATUS_VOCABULARY = ['OPEN', 'CANCELLED', 'CLOSED'];

function normalizePoStatus(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null, degraded: true };
  const s = String(raw).trim();
  if (s === '') return { ok: true, value: null, degraded: true }; // a blank cell carries no claim
  const u = s.toUpperCase();
  if (PO_STATUS_VOCABULARY.includes(u)) return { ok: true, value: u, degraded: false };
  return { ok: false, reason: 'PO_STATUS_UNKNOWN', detail: `"${s.slice(0, 60)}" is not one of ${PO_STATUS_VOCABULARY.join(' | ')}` };
}

module.exports = {
  validateUnitCatalog,
  resolveUnit,
  convertOpenPoRows,
  validateRateTable,
  normalizeMoney,
  normalizePoStatus,
  PO_STATUS_VOCABULARY,
};
