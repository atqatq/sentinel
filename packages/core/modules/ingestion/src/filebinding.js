'use strict';
/* ============================================================================
 * Sentinel — ingestion boundary v1 core: file-kind signature binding.
 *
 * Contract source: INGESTION_FILE_SPEC §1 (8 kinds, two modes), §2 (allow-list
 * per kind; dropped columns are never persisted, never logged; supplier
 * banking/tax fields must be ASSERTED absent — test-enforced), §3.1 (canonical
 * header map, alias-matched "trimmed, case-folded, never exact-string"),
 * §4 (detect kind → strip instruction rows → whitelist columns).
 *
 * H7 (delivery-spec A8): 'Supplier ID' is the supplier identity key and binds
 * to `supplierExternalId` — the DB carries the partial-unique (tenant_id,
 * external_id) with (tenant_id, name) as the documented interim until Precoro
 * ships the amended R4. The column is therefore in the alias map but NOT in
 * the detection signature: current-template files must keep binding.
 *
 * Signatures are extracted from the shipped template
 * (docs/templates/Sentinel_Ingestion_Template.xlsx, row 2 of each tab) and
 * pinned by fixtures/golden/template_headers.json so template drift fails CI.
 *
 * Purity: no-db, no-react, no-framework, no-io, no clock.
 * ==========================================================================*/

/* ---- header normalization (§3.1: trim, case-fold, alias — never exact) ----- */

function normalizeHeader(h) {
  return String(h === undefined || h === null ? '' : h)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\[[^\]]*\]\s*/g, '')       // strip square-bracket annotations: "[1=Inactive 0=Active]" — parentheses are REAL header content ("Ordered (Quantity)")
    .replace(/\*+/g, '')                    // strip required-markers: "SKU *", "Brand*"
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* ---- per-kind canonical fields + alias maps --------------------------------
 * Keys are normalized headers. Values are canonical field names (INGESTION_FILE_SPEC §3.1).
 * The allow-list is the WHOLE list: anything absent is dropped at the boundary.
 * --------------------------------------------------------------------------- */
const ALIASES = {
  items: {
    'sku': 'sku', 'item name': 'itemName', 'price': 'price', 'currency': 'currency',
    'item currency': 'currency', 'currency code': 'currency', 'inactive': 'inactive',
    'unit': 'unit', 'supplier': 'supplierName', 'item type': 'itemType',
    'category name': 'category', 'category name (required if the code field is empty)': 'category',
    'ingredient family name': 'ingredientFamily',
    'ingredient family name (required if the code field is empty)': 'ingredientFamily',
    'recipe ref name': 'recipeRef',
    'recipe ref name (required if the code field is empty)': 'recipeRef',
    'brand': 'brand', 'size': 'size', 'case count': 'caseCount',
    'conversion factor': 'conversionFactor', 'converted unit name': 'convertedUnit',
    'converted unit name (required if the code field is empty)': 'convertedUnit',
    'business unit name': 'businessUnit', 'country of origin name': 'countryOfOrigin',
    'shelf life days': 'shelfLifeDays', 'preferred sku for recipe ref': 'preferredSkuFlag',
    'nutrition approved': 'nutritionApproved', 'production approved': 'productionApproved',
    'banned': 'banned',
  },
  inventory_all_dimensions: {
    'warehouse': 'warehouse', 'sku': 'sku', 'item name': 'itemName', 'unit': 'unit',
    'quantity': 'qty', 'price': 'price', 'gross total, document currency': 'value',
  },
  consumption_balances: {
    'sku': 'sku', 'item name': 'itemName', 'unit': 'unit', 'start balance': 'startBalance',
    'transfers - goods in': 'goodsIn', 'transfers - goods out': 'goodsOut',
    'stock changes for the whole period': 'stockChanges', 'end balance': 'endBalance',
    'period start': 'periodStart', 'period end': 'periodEnd',
  },
  open_pos: {
    'purchase order #': 'poNumber', 'supplier': 'supplierName', 'sku': 'sku',
    'item name': 'itemName', 'unit': 'unit', 'purchase order delivery date': 'expectedDelivery',
    'purchase order creation date': 'poCreationDate', 'unit price': 'unitPrice',
    'receipt dates': 'receiptDates', 'currency': 'currency', 'item currency': 'currency',
    'currency code': 'currency', 'ordered (quantity)': 'ordered',
    'received (quantity)': 'received', 'waiting (quantity)': 'waiting',
  },
  deliveries: {
    'period start': 'periodStart', 'period end': 'periodEnd',
    'granularity': 'granularity', 'deliveries': 'qty',
    'months elapsed': 'monthsElapsed', 'months elapsed (ytd only)': 'monthsElapsed',
    'business unit': 'businessUnit', 'tenant': 'tenant',
  },
  suppliers: {
    'name': 'supplierName', 'supplier': 'supplierName', 'active': 'supplierActive',
    'supplier id': 'supplierExternalId',
    'delivery period': 'leadTimeDays', 'minimum order total': 'moqValue',
    'payment terms': 'paymentTerms', 'currency code': 'currency', 'currency': 'currency',
    'item currency': 'currency', 'country': 'country', 'payment term days': 'paymentTermDays',
    'banned': 'banned',
  },
  planning_params: {
    'recipe ref name': 'recipeRef', 'lead time days': 'leadTimeDays',
    'safety days': 'safetyDays', 'order frequency days': 'orderFreqDays', 'moq': 'moq',
    'preferred sku': 'preferredSku', 'shelf life days': 'shelfLifeDays', 'tenant': 'tenant',
  },
  category_owners: {
    'category name': 'category', 'tenant': 'tenant', 'owner name': 'ownerName',
    'owner email': 'ownerEmail', 'role': 'role',
  },
};

/* ---- detection signatures: minimum distinctive normalized headers ----------
 * Distinctive keys make kinds unambiguous (e.g. 'transfers - goods in' only
 * exists in consumption; 'ordered (quantity)' only in open POs).
 * --------------------------------------------------------------------------- */
const SIGNATURES = {
  items: ['sku', 'item name', 'price', 'unit', 'item type', 'recipe ref name (required if the code field is empty)', 'conversion factor'],
  inventory_all_dimensions: ['warehouse', 'sku', 'quantity', 'gross total, document currency'],
  consumption_balances: ['sku', 'start balance', 'transfers - goods in', 'transfers - goods out', 'end balance'],
  open_pos: ['purchase order #', 'purchase order delivery date', 'ordered (quantity)', 'received (quantity)', 'waiting (quantity)'],
  suppliers: ['name', 'active', 'delivery period', 'minimum order total', 'payment terms'],
  deliveries: ['period start', 'granularity', 'deliveries', 'period end'],
  planning_params: ['recipe ref name', 'lead time days', 'safety days', 'order frequency days', 'moq'],
  category_owners: ['category name', 'tenant', 'owner name', 'owner email', 'role'],
};

/** Security blocklist (§2): these can NEVER be kept for any kind. */
const NEVER_KEPT = [
  'bank account number', 'account holder name', 'bank name', 'bank address', 'sort code',
  'iban', 'swift/bic', 'swift bic', 'aba routing number', 'ifsc code', 'tax id', 'pan',
  'business registration number', 'legal address', 'phone number',
];

/** Detect the file kind from one header row. Best score wins; ties/none → NO_MATCH. */
function detectFileKind(headers) {
  const normed = (headers || []).map(normalizeHeader);
  let best = null;
  for (const [kind, sig] of Object.entries(SIGNATURES)) {
    const present = sig.filter((s) => normed.includes(s));
    if (present.length === 0) continue;
    const score = present.length / sig.length;
    if (!best || present.length > best.present.length ||
        (present.length === best.present.length && score > best.score)) {
      best = { kind, present, missing: sig.filter((s) => !normed.includes(s)), score };
    }
  }
  if (!best) return { matched: false, reason: 'NO_SIGNATURE_MATCH' };
  return {
    matched: true, kind: best.kind, score: best.score,
    missingRequired: best.missing, matchedOn: best.present,
  };
}

/**
 * §4 pipeline step 1+2: find the header row inside a raw grid.
 * Precoro exports carry instruction banner rows above the header; the header
 * row is the first row that matches a known kind signature. Rows above it are
 * instruction rows — dropped, never parsed as data.
 */
function bindGrid(rawRows) {
  for (let i = 0; i < rawRows.length; i++) {
    const det = detectFileKind(rawRows[i]);
    if (det.matched && det.score === 1) {
      return { kind: det.kind, headerRowIndex: i, instructionRowCount: i, detection: det };
    }
  }
  // partial: report the best detection for the diagnostics, but do not bind
  for (let i = 0; i < rawRows.length; i++) {
    const det = detectFileKind(rawRows[i]);
    if (det.matched) {
      return { kind: det.kind, headerRowIndex: i, instructionRowCount: i, detection: det, bound: false };
    }
  }
  return { bound: false, reason: 'NO_HEADER_ROW_FOUND' };
}

/**
 * §2/§4 pipeline step 3: whitelist columns for a bound kind.
 * Returns kept mappings (canonical field + source index) and dropped indexes
 * WITHOUT content — dropped columns are never persisted, never logged (§2).
 * Throws if an alias map ever tried to keep a blocklisted column.
 */
function applyAllowList(kind, headers) {
  const map = ALIASES[kind];
  if (!map) throw new Error(`unknown kind: ${kind}`);
  const kept = [], dropped = [];
  (headers || []).forEach((h, idx) => {
    const n = normalizeHeader(h);
    if (n === '') return; // empty header cells carry no column
    const field = map[n];
    if (field !== undefined) {
      if (NEVER_KEPT.includes(n)) throw new Error(`blocklisted column mapped for kind ${kind}: index ${idx}`);
      kept.push({ field, sourceIndex: idx });
    } else {
      dropped.push({ sourceIndex: idx }); // content intentionally absent (§2)
    }
  });
  return { kind, kept, dropped, droppedCount: dropped.length };
}

module.exports = { normalizeHeader, detectFileKind, bindGrid, applyAllowList, SIGNATURES, ALIASES, NEVER_KEPT };
