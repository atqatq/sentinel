'use strict';
/* ============================================================================
 * makeIngestAdapter(client, tenantId) — the pg-backed executor for the
 * ingestion idempotent upsert wrapper (H6, A7; M2 pipeline wiring).
 *
 * Home rule (mirrors plan-adapter.js / data-health-adapter.js): the db
 * package owns SQL; the pure decision layer
 * (packages/core/modules/ingestion/src/idempotency.js) owns the APPLY vs
 * REPLAY_NOOP decision; the future file-to-rows worker and the app layer
 * inject this adapter behind the ports.
 *
 * One (client, tenantId) adapter, called INSIDE a transaction the caller
 * opened — the GUC fence (`set_config('app.tenant_id', …, true)`, ADR-0002)
 * is the caller's responsibility; every statement ALSO carries an explicit
 * `tenant_id = $1` predicate so the intent is visible regardless of policy
 * evaluation. The adapter never opens, commits or rolls back.
 *
 * The upsert targets are EXACTLY the tenant-leading UNIQUE indexes the H6
 * structural fix created (migration.sql) — the same indexes the RLS
 * deny-matrix proved (J1/J2/J3). The register write is
 * idempotency_key (tenant_id, kind, idem_key) ON CONFLICT DO NOTHING, so a
 * reprocessed file re-registers nothing and the DAT-04 numerator stays
 * honest.
 *
 * Wiring disclosure (never silent): six fact kinds are wired here — items,
 * suppliers (H7 two-branch identity), open_pos, consumption_balances,
 * deliveries (daily rows only — the engine reads daily; weekly/monthly
 * triples are the H8 window's in-memory concern until a day-expansion unit
 * lands), planning_params. inventory_all_dimensions (needs item/warehouse
 * code→id resolution) and category_owners (control-plane identity) refuse
 * with KIND_NOT_WIRED — the wrapper never half-applies a kind whose row
 * mapping is not proven.
 *
 * pg is NOT imported here at all: the client is injected, so structural
 * suites import this contract cleanly without a database or driver.
 * ==========================================================================*/

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const WIRED_KINDS = Object.freeze([
  'items', 'suppliers', 'open_pos', 'consumption_balances', 'deliveries', 'planning_params',
]);

const INGEST_FILE_STATUSES = Object.freeze(['RECEIVED', 'QUARANTINED', 'APPLIED', 'FAILED']);

/* ---- row validation helpers (fail-closed, named codes) ---------------------- */

function reqStr(row, field, where) {
  const v = row[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new TypeError(`INVALID_ROW: ${where} field '${field}' must be a non-empty string`);
  }
  return v.trim();
}
function reqDate(row, field, where) {
  const v = reqStr(row, field, where);
  if (!DATE_RE.test(v)) throw new TypeError(`INVALID_DATE: ${where} field '${field}' must be a UTC calendar date YYYY-MM-DD, got '${v}'`);
  return v;
}
function reqNum(row, field, where) {
  const v = row[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`INVALID_ROW: ${where} field '${field}' must be a finite number`);
  }
  return v;
}
function optStr(row, field, where) {
  const v = row[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new TypeError(`INVALID_ROW: ${where} field '${field}' must be a string when present`);
  return v.trim() === '' ? null : v.trim();
}
function optNum(row, field, where) {
  const v = row[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`INVALID_ROW: ${where} field '${field}' must be a finite number when present`);
  return v;
}
function optBool(row, field, where) {
  const v = row[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') throw new TypeError(`INVALID_ROW: ${where} field '${field}' must be a boolean when present`);
  return v;
}

/* ---- per-kind upserts --------------------------------------------------------
 * Each builder validates its row, returns { text, values }. `t` is the
 * tenant uuid placeholder value; row values follow. Every statement carries
 * tenant_id = $t explicitly (double fence with the caller's GUC).
 * --------------------------------------------------------------------------- */

function upsertItem(t, row, where) {
  const text = `
    INSERT INTO item (tenant_id, sku, name, unit_code, conversion_factor, converted_unit, category,
                      ingredient_family, recipe_ref, brand, size, case_count, price, currency_code,
                      business_unit, shelf_life_days, preferred_for_recipe_ref, nutrition_approved,
                      production_approved, is_banned, is_inactive)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT (tenant_id, sku) DO UPDATE SET
      name=EXCLUDED.name, unit_code=EXCLUDED.unit_code, conversion_factor=EXCLUDED.conversion_factor,
      converted_unit=EXCLUDED.converted_unit, category=EXCLUDED.category,
      ingredient_family=EXCLUDED.ingredient_family, recipe_ref=EXCLUDED.recipe_ref,
      brand=EXCLUDED.brand, size=EXCLUDED.size, case_count=EXCLUDED.case_count,
      price=EXCLUDED.price, currency_code=EXCLUDED.currency_code, business_unit=EXCLUDED.business_unit,
      shelf_life_days=EXCLUDED.shelf_life_days, preferred_for_recipe_ref=EXCLUDED.preferred_for_recipe_ref,
      nutrition_approved=EXCLUDED.nutrition_approved, production_approved=EXCLUDED.production_approved,
      is_banned=EXCLUDED.is_banned, is_inactive=EXCLUDED.is_inactive`;
  const values = [t, reqStr(row, 'sku', where), reqStr(row, 'itemName', where), reqStr(row, 'unit', where),
    optNum(row, 'conversionFactor', where), optStr(row, 'convertedUnit', where), optStr(row, 'category', where),
    optStr(row, 'ingredientFamily', where), optStr(row, 'recipeRef', where), optStr(row, 'brand', where),
    optStr(row, 'size', where), optNum(row, 'caseCount', where), optNum(row, 'price', where),
    optStr(row, 'currency', where), optStr(row, 'businessUnit', where), optNum(row, 'shelfLifeDays', where),
    optBool(row, 'preferredSkuFlag', where), optBool(row, 'nutritionApproved', where),
    optBool(row, 'productionApproved', where), optBool(row, 'banned', where), optBool(row, 'inactive', where)];
  return { text, values };
}

function upsertSupplier(t, row, where) {
  const name = reqStr(row, 'supplierName', where);
  const common = {
    isActive: optBool(row, 'supplierActive', where), lead: optNum(row, 'leadTimeDays', where),
    moq: optNum(row, 'moqValue', where), terms: optStr(row, 'paymentTerms', where),
    termDays: optNum(row, 'paymentTermDays', where), currency: optStr(row, 'currency', where),
    country: optStr(row, 'country', where), banned: optBool(row, 'banned', where),
  };
  const cols = `tenant_id, external_id, name, is_active, delivery_period_days, moq_value,
                payment_terms_text, payment_term_days, currency_code, country, is_banned`;
  const sets = `name=EXCLUDED.name, is_active=EXCLUDED.is_active, delivery_period_days=EXCLUDED.delivery_period_days,
                moq_value=EXCLUDED.moq_value, payment_terms_text=EXCLUDED.payment_terms_text,
                payment_term_days=EXCLUDED.payment_term_days, currency_code=EXCLUDED.currency_code,
                country=EXCLUDED.country, is_banned=EXCLUDED.is_banned`;
  if (row.supplierExternalId !== undefined && row.supplierExternalId !== null) {
    /* H7 identity key: the partial unique (tenant_id, external_id) WHERE external_id IS NOT NULL */
    const ext = reqStr(row, 'supplierExternalId', where);
    return { text: `INSERT INTO supplier (${cols}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET ${sets}`,
      values: [t, ext, name, common.isActive, common.lead, common.moq, common.terms, common.termDays, common.currency, common.country, common.banned] };
  }
  /* Interim identity per ingestion spec §4 / migration comment: (tenant_id, name) */
  return { text: `INSERT INTO supplier (${cols}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (tenant_id, name) DO UPDATE SET ${sets}`,
    values: [t, null, name, common.isActive, common.lead, common.moq, common.terms, common.termDays, common.currency, common.country, common.banned] };
}

function upsertOpenPoLine(t, row, where) {
  return {
    text: `
    INSERT INTO open_po_line (tenant_id, po_number, sku, ordered_qty, received_qty, waiting_qty,
                              waiting_qty_converted, unit_code, unit_price, currency_code,
                              tenant_unit_price, expected_delivery, receipt_dates, po_created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (tenant_id, po_number, sku) DO UPDATE SET
      ordered_qty=EXCLUDED.ordered_qty, received_qty=EXCLUDED.received_qty, waiting_qty=EXCLUDED.waiting_qty,
      waiting_qty_converted=EXCLUDED.waiting_qty_converted, unit_code=EXCLUDED.unit_code,
      unit_price=EXCLUDED.unit_price, currency_code=EXCLUDED.currency_code,
      tenant_unit_price=EXCLUDED.tenant_unit_price, expected_delivery=EXCLUDED.expected_delivery,
      receipt_dates=EXCLUDED.receipt_dates, po_created_at=EXCLUDED.po_created_at`,
    values: [t, reqStr(row, 'poNumber', where), reqStr(row, 'sku', where), reqNum(row, 'ordered', where),
      reqNum(row, 'received', where), reqNum(row, 'waiting', where), optNum(row, 'waitingQtyConverted', where),
      reqStr(row, 'unit', where), reqNum(row, 'unitPrice', where), reqStr(row, 'currency', where),
      reqNum(row, 'tenantUnitPrice', where), optStr(row, 'expectedDelivery', where),
      optStr(row, 'receiptDates', where), optStr(row, 'poCreationDate', where)],
  };
}

function upsertConsumptionBalance(t, row, where) {
  return {
    text: `
    INSERT INTO consumption_balance (tenant_id, sku, period_start, period_end, start_balance,
                                     goods_in, goods_out, stock_changes, end_balance)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (tenant_id, sku, period_start, period_end) DO UPDATE SET
      start_balance=EXCLUDED.start_balance, goods_in=EXCLUDED.goods_in, goods_out=EXCLUDED.goods_out,
      stock_changes=EXCLUDED.stock_changes, end_balance=EXCLUDED.end_balance`,
    values: [t, reqStr(row, 'sku', where), reqDate(row, 'periodStart', where), reqDate(row, 'periodEnd', where),
      reqNum(row, 'startBalance', where), reqNum(row, 'goodsIn', where), reqNum(row, 'goodsOut', where),
      reqNum(row, 'stockChanges', where), reqNum(row, 'endBalance', where)],
  };
}

function upsertDeliveryDay(t, row, where) {
  const granularity = reqStr(row, 'granularity', where);
  if (granularity !== 'daily') {
    throw new TypeError(`DELIVERIES_NON_DAILY_NOT_WIRED: ${where} granularity '${granularity}' — the engine reads daily rows; day-expansion for other granularities is a named future unit, never silent`);
  }
  const start = reqDate(row, 'periodStart', where);
  const end = reqDate(row, 'periodEnd', where);
  if (start !== end) {
    throw new TypeError(`INVALID_DAILY_ROW: ${where} a daily delivery row must have periodStart === periodEnd, got '${start}'..'${end}'`);
  }
  return {
    text: `
    INSERT INTO delivery_day (tenant_id, day, granularity, deliveries, months_elapsed, business_unit)
    VALUES ($1,$2,'daily',$3,$4,$5)
    ON CONFLICT (tenant_id, day) DO UPDATE SET
      deliveries=EXCLUDED.deliveries, months_elapsed=EXCLUDED.months_elapsed, business_unit=EXCLUDED.business_unit`,
    values: [t, start, reqNum(row, 'qty', where), optNum(row, 'monthsElapsed', where), optStr(row, 'businessUnit', where)],
  };
}

function upsertPlanningParam(t, row, where) {
  const params = row.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError(`INVALID_ROW: ${where} field 'params' must be a JSON object`);
  }
  return {
    text: `
    INSERT INTO planning_param (tenant_id, recipe_ref, params, source)
    VALUES ($1,$2,$3::jsonb,'manual')
    ON CONFLICT (tenant_id, recipe_ref) DO UPDATE SET
      params=EXCLUDED.params, source='manual'`,
    values: [t, reqStr(row, 'recipeRef', where), JSON.stringify(params)],
  };
}

const UPSERTS = {
  items: upsertItem,
  suppliers: upsertSupplier,
  open_pos: upsertOpenPoLine,
  consumption_balances: upsertConsumptionBalance,
  deliveries: upsertDeliveryDay,
  planning_params: upsertPlanningParam,
};

/* ---- the adapter ------------------------------------------------------------- */

function makeIngestAdapter(client, tenantId) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('makeIngestAdapter: client must be a pg client with .query');
  }
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new TypeError('makeIngestAdapter: tenantId must be a non-empty string');
  }
  const t = tenantId.trim();

  return {
    WIRED_KINDS,

    /** The prior ingest_file row for (tenant, kind, checksum) — the wrapper's
     * replay port. Returns { id, status, appliedAt } or null. applied_at is
     * an int8: node-pg delivers bigint as a STRING, and the decision layer's
     * port contract demands a finite epoch-ms NUMBER — convert at the
     * boundary (null stays null: Number(null) is 0, which would lie). */
    async findFile(kind, checksum) {
      const r = await client.query(
        `SELECT id, status::text AS status, (extract(epoch from applied_at) * 1000)::bigint AS "appliedAt"
           FROM ingest_file WHERE tenant_id = $1 AND kind = $2 AND checksum_sha256 = $3`,
        [t, kind, checksum]);
      if (!r.rows[0]) return null;
      return {
        id: r.rows[0].id,
        status: r.rows[0].status,
        appliedAt: r.rows[0].appliedAt === null ? null : Number(r.rows[0].appliedAt),
      };
    },

    /** This tenant's registered keys for a kind — the wrapper's seen port. */
    async loadSeenKeys(kind) {
      const r = await client.query(
        `SELECT idem_key FROM idempotency_key WHERE tenant_id = $1 AND kind = $2 ORDER BY idem_key`,
        [t, kind]);
      return r.rows.map((x) => x.idem_key);
    },

    /**
     * Execute an APPLY plan produced by planIngestFile. Caller owns the
     * transaction (BEGIN / set_config GUC / COMMIT); every statement is
     * tenant-fenced. Returns { fileId, appliedAt, rowsApplied, keysRegistered }.
     */
    async apply(plan) {
      if (!plan || typeof plan !== 'object' || plan.action !== 'APPLY') {
        throw new TypeError('apply: expected an APPLY plan from planIngestFile — a REPLAY_NOOP must never reach the database');
      }
      if (plan.tenantId !== t) {
        throw new TypeError(`TENANT_MISMATCH: plan tenant ${plan.tenantId} does not match adapter tenant ${t}`);
      }
      if (!Array.isArray(plan.rows) || plan.rows.length === 0) {
        throw new TypeError('apply: plan.rows must be a non-empty [{ key, row }] array');
      }
      const upsert = UPSERTS[plan.kind];
      if (!upsert) {
        throw new TypeError(`KIND_NOT_WIRED: kind '${plan.kind}' has no proven row mapping in this adapter — the disclosure is recorded in DECISIONS.md, never applied blind`);
      }

      /* Pre-validate EVERY row and build every statement BEFORE any write:
       * a malformed row refuses the whole plan with zero statements issued —
       * the wrapper can never half-apply, even outside a transaction. */
      const stmts = plan.rows.map((entry, i) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.key !== 'string' || entry.key === '') {
          throw new TypeError(`apply: plan.rows[${i}] must be a { key, row } pair with a non-empty string key`);
        }
        if (entry.row === null || typeof entry.row !== 'object' || Array.isArray(entry.row)) {
          throw new TypeError(`apply: plan.rows[${i}].row must be an object`);
        }
        return upsert(t, entry.row, `plan.rows[${i}] (${plan.kind})`);
      });

      /* 1. the file register row — INSERT or UPDATE IN PLACE on the H6 unique
       *    (tenant, kind, checksum): a reprocessed FAILED/RECEIVED file never
       *    forks the file history. Ends APPLIED atomically with the rows. */
      const file = await client.query(
        `INSERT INTO ingest_file (tenant_id, kind, mode, file_name, checksum_sha256, byte_size, status, row_count, applied_at)
         VALUES ($1,$2,$3,$4,$5,$6,'APPLIED',$7,now())
         ON CONFLICT (tenant_id, kind, checksum_sha256) DO UPDATE SET
           status='APPLIED', applied_at=now(), row_count=EXCLUDED.row_count,
           file_name=EXCLUDED.file_name, byte_size=EXCLUDED.byte_size, mode=EXCLUDED.mode
         RETURNING id, (extract(epoch from applied_at) * 1000)::bigint AS "appliedAt"`,
        [t, plan.kind, plan.mode, plan.fileName, plan.checksum, plan.byteSize, plan.rows.length]);

      /* 2. the fact rows — ON CONFLICT on the tenant-leading uniques. */
      for (const stmt of stmts) {
        await client.query(stmt.text, stmt.values);
      }

      /* 3. the register — the DAT-04 ledger. DO NOTHING: a reprocessed file
       *    re-registers nothing and never inflates the seen-before count. */
      const keys = await client.query(
        `INSERT INTO idempotency_key (tenant_id, kind, idem_key, file_checksum)
         SELECT $1, $2, k, $3 FROM unnest($4::text[]) AS k
         ON CONFLICT (tenant_id, kind, idem_key) DO NOTHING`,
        [t, plan.kind, plan.checksum, plan.rows.map((r) => r.key)]);

      return {
        fileId: file.rows[0].id,
        appliedAt: Number(file.rows[0].appliedAt),
        rowsApplied: plan.rows.length,
        keysRegistered: keys.rowCount,
      };
    },

    /** Status vocabulary of the file register (structural suites / callers). */
    INGEST_FILE_STATUSES,
  };
}

module.exports = { makeIngestAdapter, WIRED_KINDS };
