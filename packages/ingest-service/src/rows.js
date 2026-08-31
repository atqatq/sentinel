'use strict';
/* ============================================================================
 * ingest-service — the rows layer: canonical field specs + strict typing.
 *
 * The gap the worker exists to close: filebinding binds a grid to a kind and
 * an allow-list, but the executor needs TYPED canonical rows — numbers as
 * finite numbers (A5/C4: parse or quarantine, never coerce), dates as the
 * H4 canonical form (date-only UTC, datetimes through the EXPLICIT tenant
 * timezone), booleans as real booleans, unit spellings resolved against the
 * tenant catalog. This layer owns the per-kind field specs — REQUIRED vs
 * optional, numeric bounds, date/unit/bool semantics — derived from exactly
 * two authorities:
 *   - filebinding.js ALIASES (the canonical field names per kind), and
 *   - ingest-adapter.js upserts (the executor's req-str/req-num/optional
 *     argument shapes are the storage contract; a field the executor
 *     requires is REQUIRED here, an optional one is optional).
 *
 * Failure semantics (mirroring the boundary's discipline):
 *   - a field that fails its parse quarantines the ROW (a quarantine_record
 *     with the original line number), never the whole file — §4's "quarantined
 *     whole" governs the STRUCTURAL gates (required columns, header binding),
 *     while per-row corruption rides the quarantine ledger the schema ships;
 *   - a file whose rows ALL quarantine leaves zero survivors — the worker
 *     then quarantines the file whole (nothing half-applies);
 *   - negative on-hand is FLAGGED, not refused (§4: "negative on-hand
 *     flagged") — the row applies and a WARN data-health task is raised;
 *   - supplier `Payment Terms` free text is parsed to days ("SOA +45 Days"
     → 45); unparsable is flagged (row applies, days null), never guessed.
 *
 * Purity: no-db, no-io, no-clock. asOf/tz/catalog are injected.
 *
 * Line attribution: every surviving row carries __lineNo — the ORIGINAL
 * 1-based file line the row was built from — so later per-row stages
 * (unresolved refs, refused money, expansion refusals, the A5 guard)
 * quarantine against the line the operator sees in their spreadsheet.
 * The executor reads only its named fields; the marker never reaches SQL.
 * ==========================================================================*/

/* ---- field spec vocabulary --------------------------------------------------
 * type: 'string' | 'number' | 'date' | 'bool' | 'unit' | 'granularity'
 * required: the executor's req* shape (missing → row quarantine)
 * bounds: {min, max} plausibility window (inclusive; A5/C4)
 * flagNegative: keep a negative value but raise the named WARN (inventory)
 * boolMap: the column's own polarity, from the template header annotation
 *          ("Inactive [1=Inactive 0=Active]" → 1 IS inactive for `inactive`,
 *          "Active [0=Inactive 1=Active]" → 1 IS active for `supplierActive`)
 * --------------------------------------------------------------------------- */
const FIELD_SPECS = {
  items: {
    sku: { type: 'string', required: true },
    itemName: { type: 'string', required: true },
    price: { type: 'number', required: true, bounds: { min: 0 } },
    currency: { type: 'string', required: false },
    inactive: { type: 'bool', required: false, boolMap: { '1': true, '0': false } },
    unit: { type: 'unit', required: true },
    supplierName: { type: 'string', required: false },
    itemType: { type: 'string', required: false },
    category: { type: 'string', required: false },
    ingredientFamily: { type: 'string', required: false },
    recipeRef: { type: 'string', required: false },
    brand: { type: 'string', required: false },
    size: { type: 'string', required: false },
    caseCount: { type: 'number', required: false, bounds: { min: 0 } },
    conversionFactor: { type: 'number', required: false, bounds: { min: 0 } },
    convertedUnit: { type: 'unit', required: false },
    businessUnit: { type: 'string', required: false },
    countryOfOrigin: { type: 'string', required: false },
    shelfLifeDays: { type: 'number', required: false, bounds: { min: 0, max: 3650 } },
    preferredSkuFlag: { type: 'bool', required: false, boolMap: { '1': true, '0': false } },
    nutritionApproved: { type: 'bool', required: false, boolMap: { '1': true, '0': false } },
    productionApproved: { type: 'bool', required: false, boolMap: { '1': true, '0': false } },
    banned: { type: 'bool', required: false, boolMap: { '1': true, '0': false } },
  },
  inventory_all_dimensions: {
    warehouse: { type: 'string', required: true },
    sku: { type: 'string', required: true },
    itemName: { type: 'string', required: false },
    unit: { type: 'unit', required: true },
    qty: { type: 'number', required: true, flagNegative: true },
    value: { type: 'number', required: true },
  },
  consumption_balances: {
    sku: { type: 'string', required: true },
    itemName: { type: 'string', required: false },
    unit: { type: 'unit', required: false },
    startBalance: { type: 'number', required: true },
    goodsIn: { type: 'number', required: true },
    goodsOut: { type: 'number', required: true },
    stockChanges: { type: 'number', required: true },
    endBalance: { type: 'number', required: true },
    periodStart: { type: 'date', required: true },
    periodEnd: { type: 'date', required: true },
  },
  open_pos: {
    poNumber: { type: 'string', required: true },
    supplierName: { type: 'string', required: false },
    sku: { type: 'string', required: true },
    itemName: { type: 'string', required: false },
    unit: { type: 'unit', required: true },
    expectedDelivery: { type: 'date', required: false },
    poCreationDate: { type: 'date', required: false },
    unitPrice: { type: 'number', required: true, bounds: { min: 0 } },
    receiptDates: { type: 'string', required: false },
    currency: { type: 'string', required: true },
    ordered: { type: 'number', required: true, bounds: { min: 0 } },
    received: { type: 'number', required: true, bounds: { min: 0 } },
    waiting: { type: 'number', required: true, bounds: { min: 0 } },
  },
  deliveries: {
    periodStart: { type: 'date', required: true },
    periodEnd: { type: 'date', required: true },
    granularity: { type: 'granularity', required: true },
    qty: { type: 'number', required: true, bounds: { min: 0 } },
    monthsElapsed: { type: 'number', required: false, bounds: { min: 1, max: 12 } },
    businessUnit: { type: 'string', required: false },
    tenant: { type: 'string', required: false },
  },
  suppliers: {
    supplierName: { type: 'string', required: true },
    supplierActive: { type: 'bool', required: false, boolMap: { '1': true, '0': false } },
    supplierExternalId: { type: 'string', required: false },
    leadTimeDays: { type: 'number', required: false, bounds: { min: 0, max: 365 } },
    moqValue: { type: 'number', required: false, bounds: { min: 0 } },
    paymentTerms: { type: 'string', required: false },
    paymentTermDays: { type: 'number', required: false, bounds: { min: 0, max: 365 } },
    currency: { type: 'string', required: false },
    country: { type: 'string', required: false },
    banned: { type: 'bool', required: false, boolMap: { '1': true, '0': false } },
  },
  planning_params: {
    recipeRef: { type: 'string', required: true },
    leadTimeDays: { type: 'number', required: false, bounds: { min: 0, max: 365 } },
    safetyDays: { type: 'number', required: false, bounds: { min: 0, max: 365 } },
    orderFreqDays: { type: 'number', required: false, bounds: { min: 0, max: 365 } },
    moq: { type: 'number', required: false, bounds: { min: 0 } },
    preferredSku: { type: 'bool', required: false, boolMap: { '1': true, '0': false } },
    shelfLifeDays: { type: 'number', required: false, bounds: { min: 0, max: 3650 } },
    tenant: { type: 'string', required: false },
  },
  category_owners: {
    category: { type: 'string', required: true },
    tenant: { type: 'string', required: false },
    ownerName: { type: 'string', required: false },
    ownerEmail: { type: 'email', required: false },
    role: { type: 'string', required: false },
  },
};

/* Canonical fields the allow-list keeps but the executor does not store —
 * the worker's report DISCLOSES each kind's dropped fields, never silently. */
const EXECUTOR_DROPPED = Object.freeze({
  items: ['supplierName', 'itemType', 'countryOfOrigin'],
  inventory_all_dimensions: ['itemName'],
  consumption_balances: ['itemName', 'unit'],
  open_pos: ['supplierName', 'itemName'],
  deliveries: ['tenant'],
  suppliers: [],
  planning_params: ['tenant'],
  category_owners: ['tenant', 'ownerName', 'role'],
});

/* planning_params: the param dimensions that fold into the executor's
 * single `params` JSON object per recipeRef (the storage shape). */
const PARAM_DIMENSIONS = Object.freeze(['leadTimeDays', 'safetyDays', 'orderFreqDays', 'moq', 'preferredSku', 'shelfLifeDays']);

const GRANULARITIES = Object.freeze(['daily', 'weekly', 'monthly', 'quarterly', 'ytd']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYMENT_DAYS_RE = /(\d+)\s*(?:days?|d)\s*$/i;

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.replace(/\s+/g, ' ').trim() === '');
}

/** Parse supplier free-text payment terms to days ("SOA +45 Days" → 45).
 * Returns {ok:true, days} | {ok:false} — the caller flags, never guesses. */
function parsePaymentTermsDays(text) {
  if (typeof text !== 'string') return { ok: false };
  const m = text.trim().match(PAYMENT_DAYS_RE);
  if (!m) return { ok: false };
  const days = Number(m[1]);
  return Number.isFinite(days) ? { ok: true, days } : { ok: false };
}

/**
 * Build typed canonical rows for one bound file.
 *
 * @param {object} input
 *   kind, grid (string[][]), headerRowIndex, kept (filebinding allow-list),
 *   asOfMs (epoch), tz ({iana} — the H4 explicit tenant setting),
 *   catalog (the tenant unit catalog), deps: { parse, normalize, dates }
 * @returns {rows, quarantines, flags, unresolvedUnits, emptyRows}
 *   rows         — canonical rows for the executor (planning_params rows
 *                  carry their `params` object folded)
 *   quarantines  — parse.js quarantine records (fileKind/rowIndex/field/raw/
 *                  reason[/detail]) — rowIndex is the ORIGINAL file line
 *                  number (grid index + 1)
 *   flags        — { field, rowIndex, detail } WARN items that keep their row
 *   unresolvedUnits — count of UNRESOLVED_UNIT quarantines (the honest counter
 *                  the Data Upload screen renders)
 */
function buildTypedRows(input) {
  const { kind, grid, headerRowIndex, kept, asOfMs, tz, catalog, deps } = input;
  const specs = FIELD_SPECS[kind];
  if (!specs) throw new TypeError(`buildTypedRows: no field specs for kind '${kind}'`);
  const rows = [];
  const quarantines = [];
  const flags = [];
  let unresolvedUnits = 0;
  let emptyRows = 0;

  const quarantine = (rowIndex, field, raw, reason, detail) => {
    const rec = deps.parse.quarantineRecord({
      fileKind: kind, rowIndex, field, raw, reason, asOf: asOfMs,
      ...(detail !== undefined ? { detail } : {}),
    });
    quarantines.push(rec);
    return rec;
  };

  const headers = grid[headerRowIndex];
  for (let gi = headerRowIndex + 1; gi < grid.length; gi++) {
    const gridRow = grid[gi];
    const lineNo = gi + 1; // the original file line number (1-based)
    if (gridRow.every((c) => isBlank(c))) { emptyRows++; continue; }

    const row = {};
    let rowOk = true;
    for (const { field, sourceIndex } of kept) {
      const spec = specs[field];
      if (!spec) continue; // an alias without a storage/typing rule rides as absent
      const raw = gridRow[sourceIndex];
      const cellHasContent = !isBlank(raw);

      if (!cellHasContent) {
        if (spec.required) { quarantine(lineNo, field, raw ?? '', 'MISSING'); rowOk = false; }
        continue; // optional absent → field stays off the row (executor nulls it)
      }
      const value = String(raw).replace(/\s+/g, ' ').trim();

      if (spec.type === 'string') {
        row[field] = value;
      } else if (spec.type === 'email') {
        if (!EMAIL_RE.test(value)) { quarantine(lineNo, field, value, 'INVALID_EMAIL'); rowOk = false; continue; }
        row[field] = value.toLowerCase();
      } else if (spec.type === 'number') {
        const parsed = deps.parse.parseQuantity(raw, {
          field, bounds: spec.bounds, fileKind: kind, rowIndex: lineNo, asOf: asOfMs,
        });
        if (!parsed.ok) { quarantines.push(parsed.quarantine); rowOk = false; continue; }
        if (spec.flagNegative && parsed.value < 0) {
          flags.push({ field, rowIndex: lineNo, detail: `negative ${field} (${parsed.value}) — kept, flagged per §4 "negative on-hand flagged"` });
        }
        row[field] = parsed.value;
      } else if (spec.type === 'bool') {
        const key = value.toLowerCase();
        if (!(key in spec.boolMap)) { quarantine(lineNo, field, value, 'INVALID_BOOLEAN', `expected one of ${Object.keys(spec.boolMap).join('/')}`); rowOk = false; continue; }
        row[field] = spec.boolMap[key];
      } else if (spec.type === 'date') {
        const conv = deps.dates.toCanonicalDate(value, tz);
        if (!conv.ok) { quarantine(lineNo, field, value, conv.reason === 'MISSING_DATE' ? 'MISSING' : 'INVALID_DATE', conv.detail || conv.reason); rowOk = false; continue; }
        row[field] = conv.value; // the H4 canonical form: date-only UTC YYYY-MM-DD
      } else if (spec.type === 'unit') {
        const res = deps.normalize.resolveUnit(value, catalog);
        if (!res.ok) {
          if (res.reason === 'MISSING' && !spec.required) continue;
          quarantine(lineNo, field, value, res.reason === 'MISSING' ? 'MISSING' : 'UNRESOLVED_UNIT', res.detail || (res.raw !== undefined ? `not in the tenant unit catalog: ${res.raw}` : undefined));
          if (res.reason === 'UNRESOLVED_UNIT') unresolvedUnits++;
          rowOk = false; continue;
        }
        row[field] = res.unit;
      } else if (spec.type === 'granularity') {
        const key = value.toLowerCase();
        if (!GRANULARITIES.includes(key)) { quarantine(lineNo, field, value, 'INVALID_GRANULARITY', `expected one of ${GRANULARITIES.join('/')}`); rowOk = false; continue; }
        row[field] = key;
      } else {
        throw new TypeError(`buildTypedRows: unknown spec type '${spec.type}' for ${kind}.${field}`);
      }
    }
    if (!rowOk) continue;

    if (kind === 'planning_params') {
      // fold the param dimensions into the executor's single params object
      const params = {};
      for (const dim of PARAM_DIMENSIONS) {
        if (row[dim] !== undefined) { params[dim] = row[dim]; delete row[dim]; }
      }
      row.params = params;
    }
    if (kind === 'suppliers' && row.paymentTermDays === undefined && row.paymentTerms !== undefined) {
      // §4: free-text terms parsed to days; unparsable is flagged, never guessed
      const days = parsePaymentTermsDays(row.paymentTerms);
      if (days.ok) row.paymentTermDays = days.days;
      else flags.push({ field: 'paymentTerms', rowIndex: lineNo, detail: `payment terms '${row.paymentTerms}' did not parse to days — stored as text, days left blank` });
    }
    row.__lineNo = lineNo; // original 1-based file line — quarantine attribution for later stages
    rows.push(row);
  }

  return { rows, quarantines, flags, unresolvedUnits, emptyRows };
}

module.exports = { FIELD_SPECS, EXECUTOR_DROPPED, PARAM_DIMENSIONS, GRANULARITIES, buildTypedRows, parsePaymentTermsDays };
