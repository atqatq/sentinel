'use strict';
/* ============================================================================
 * makeIngestWorkerAdapter(client, tenantId) — the pg-backed SQL surface of
 * the file-to-rows worker (M3, D-028): the tenant settings, unit catalog,
 * FX pin, conversion-factor and code→id resolution ports the pipeline reads
 * through, plus the persistence half the H6 layers deliberately left to the
 * production caller — the file register's failure lifecycle
 * (QUARANTINED / FAILED — the APPLIED side stays inside ingest-adapter.apply,
 * atomic with the rows it applies), the quarantine_record ledger, and the
 * data_health_task register the /data-health screen has been waiting on
 * (D-025: "persisted by the ingestion worker when it lands" — this is that
 * landing).
 *
 * Home rule (plan-adapter / data-health-adapter / ingest-adapter precedent):
 * the db package owns SQL; the worker (packages/ingest-service) owns the
 * pipeline semantics; the caller owns the transaction. One (client,
 * tenantId) adapter called INSIDE a transaction the caller opened — the GUC
 * fence (`set_config('app.tenant_id', …, true)`, ADR-0002) is the caller's
 * responsibility; every statement ALSO carries an explicit tenant_id
 * predicate or writes through a tenant-scoped column so the intent is
 * visible regardless of policy evaluation. The adapter never opens, commits
 * or rolls back.
 *
 * pg is NOT imported here: the client is injected, so structural suites
 * prove this contract without a database or driver (the live half rides the
 * db-rls job like its siblings).
 * ==========================================================================*/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* The severities data_health_severity ships (migrations/0001_init). A task
 * without an explicit severity defaults to WARN — the honest floor for
 * "something was quarantined/substituted/flagged"; whole-file refusals pass
 * CRITICAL from the worker. Anything else refuses here, at the SQL boundary,
 * never as a silent default row. */
const TASK_SEVERITIES = Object.freeze(['INFO', 'WARN', 'CRITICAL']);

/** Shared lifecycle writer for markFileQuarantined / markFileFailed — the
 * SAME H6 unique apply() upserts, same in-place discipline, applied_at
 * reset so a quarantined/failed row never advertises a stale success. */
async function upsertFileStatus(client, t, file, status) {
  if (!file || typeof file !== 'object') {
    throw new TypeError(`markFile*: file must be a { kind, mode, fileName, checksum, byteSize, rowCount?, quarantinedCount? } object`);
  }
  if (!file.kind || typeof file.kind !== 'string') {
    throw new TypeError('markFile*: kind must be a non-empty string (a pre-binding refusal is never registered)');
  }
  if (typeof file.mode !== 'string' || !['A', 'B'].includes(file.mode)) {
    throw new TypeError(`markFile*: mode '${String(file.mode)}' is not an INGESTION_FILE_SPEC §1 mode (A|B)`);
  }
  if (typeof file.fileName !== 'string' || file.fileName.trim() === '') {
    throw new TypeError('markFile*: fileName must be a non-empty string');
  }
  if (typeof file.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(file.checksum)) {
    throw new TypeError('markFile*: checksum must be a lowercase 64-hex sha256');
  }
  if (!Number.isInteger(file.byteSize) || file.byteSize < 0) {
    throw new TypeError('markFile*: byteSize must be a non-negative integer');
  }
  const rowCount = file.rowCount === undefined || file.rowCount === null ? null : file.rowCount;
  const quarantined = file.quarantinedCount === undefined || file.quarantinedCount === null ? null : file.quarantinedCount;
  const r = await client.query(
    `INSERT INTO ingest_file (tenant_id, kind, mode, file_name, checksum_sha256, byte_size, status, row_count, quarantined_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, kind, checksum_sha256) DO UPDATE SET
       status='${status}', applied_at=NULL, row_count=$8, quarantined_count=$9,
       file_name=EXCLUDED.file_name, byte_size=EXCLUDED.byte_size, mode=EXCLUDED.mode
     RETURNING id`,
    [t, file.kind, file.mode, file.fileName, file.checksum, file.byteSize, status, rowCount, quarantined]);
  return { fileId: r.rows[0].id };
}

function makeIngestWorkerAdapter(client, tenantId) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('makeIngestWorkerAdapter: client must be a pg client with .query');
  }
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new TypeError('makeIngestWorkerAdapter: tenantId must be a non-empty string');
  }
  const t = tenantId.trim();

  return {
    TASK_SEVERITIES,

    /* ---- pipeline read ports --------------------------------------------- */

    /** The tenant settings the boundary needs: currency (C2 money
     * normalization is mandatory — R1 mirror) and timezone (H4 — datetimes
     * convert at the boundary with the EXPLICIT tenant setting, never the
     * server's). Returns null when the tenant row is gone — the worker
     * refuses the run rather than guessing a default. */
    async loadTenantSettings() {
      const r = await client.query(
        `SELECT currency_code AS "currencyCode", timezone FROM tenant WHERE id = $1`,
        [t]);
      return r.rows[0] || null;
    },

    /** The tenant's unit catalog (screen 32 Reference & Settings data) in
     * the exact shape validateUnitCatalog/resolveUnit consume: canonical
     * codes + alias→code. Alias→entry is a JOIN, so an alias can never
     * point outside the tenant's own catalog. */
    async loadUnitCatalog() {
      const canon = await client.query(
        `SELECT code FROM unit_catalog_entry WHERE tenant_id = $1 ORDER BY code`,
        [t]);
      const aliases = await client.query(
        `SELECT a.alias AS alias, e.code AS code
           FROM unit_alias a
           JOIN unit_catalog_entry e ON e.id = a.catalog_entry_id
          WHERE a.tenant_id = $1
          ORDER BY a.alias`,
        [t]);
      return {
        canonical: canon.rows.map((r) => r.code),
        aliases: Object.fromEntries(aliases.rows.map((r) => [r.alias, r.code])),
      };
    },

    /** The USD→local rate window for ONE run day, in the rate-table shape
     * normalizeMoney validates: { usdToLocalByDay: { 'YYYY-MM-DD': rate } }.
     * The M10 fail-safe (§14.17, ADR-0003): the window carries the LATEST
     * pin at-or-before the run day — the exact day's pin when it exists,
     * otherwise the last pinned rate (the money layer then resolves the
     * policy: exact → fresh; earlier → STALE-VISIBLE fallback with the
     * disclosure; never → RATE_NOT_PINNED from the money layer's own named
     * reason, never invented here). An EMPTY table means NO pin ≤ the run
     * day exists — that and only that is the refusal case. */
    async loadFxPin(day) {
      if (typeof day !== 'string' || !DAY_RE.test(day)) {
        throw new TypeError(`loadFxPin: day must be a YYYY-MM-DD string, got '${String(day)}'`);
      }
      const r = await client.query(
        `SELECT day::text AS day, usd_to_local FROM fx_rate_pin
          WHERE tenant_id = $1 AND day <= $2 ORDER BY day DESC LIMIT 1`,
        [t, day]);
      const table = { usdToLocalByDay: {} };
      if (r.rows[0]) {
        const rate = Number(r.rows[0].usd_to_local);
        if (!Number.isFinite(rate) || rate <= 0) {
          throw new TypeError(`loadFxPin: pinned rate for ${r.rows[0].day} is not a positive finite number`);
        }
        table.usdToLocalByDay[r.rows[0].day] = rate;
      }
      return table;
    },

    /** SKU → conversion factor from the tenant's item master (C1: openPO
     * waiting quantities convert AT INGESTION). Only usable factors are
     * returned — a null/absent factor maps to MISSING_CONVERSION_FACTOR at
     * the conversion stage, an unusable number refuses here (a corrupt
     * master must not silently convert). */
    async loadConversionFactors() {
      const r = await client.query(
        `SELECT sku, conversion_factor FROM item
          WHERE tenant_id = $1 AND conversion_factor IS NOT NULL`,
        [t]);
      const bySku = {};
      for (const row of r.rows) {
        const cf = Number(row.conversion_factor);
        if (!Number.isFinite(cf) || cf <= 0) {
          throw new TypeError(`loadConversionFactors: item '${row.sku}' has a non-usable conversion_factor '${String(row.conversion_factor)}'`);
        }
        bySku[row.sku] = cf;
      }
      return bySku;
    },

    /** Batch code→id resolution for stock_line (inventory_all_dimensions).
     * Codes are tenant-scoped; ids come back only for what EXISTS — the
     * caller quarantines unresolved rows per-row (UNRESOLVED_ITEM_SKU /
     * UNRESOLVED_WAREHOUSE), it never invents an id. */
    async resolveStockRefs(skus, warehouseCodes) {
      const items = {};
      if (Array.isArray(skus) && skus.length > 0) {
        const r = await client.query(
          `SELECT sku, id FROM item WHERE tenant_id = $1 AND sku = ANY($2::text[])`,
          [t, skus]);
        for (const row of r.rows) items[row.sku] = row.id;
      }
      const warehouses = {};
      if (Array.isArray(warehouseCodes) && warehouseCodes.length > 0) {
        const r = await client.query(
          `SELECT code, id FROM warehouse WHERE tenant_id = $1 AND code = ANY($2::text[])`,
          [t, warehouseCodes]);
        for (const row of r.rows) warehouses[row.code] = row.id;
      }
      return { items, warehouses };
    },

    /** Batch email→user_id resolution for category_owners. app_user is a
     * GLOBAL registry (email unique per migration) — the lookup is
     * deliberately unfenced like resolveTenantByCode: it is identity
     * resolution above the fence, not a read of tenant data. An unknown
     * email resolves to nothing; the row keeps owner_email with user_id
     * NULL (honest: the owner exists in the ERP feed, not yet in Sentinel). */
    async resolveUserIdsByEmail(emails) {
      const byEmail = {};
      if (Array.isArray(emails) && emails.length > 0) {
        const r = await client.query(
          `SELECT email, id FROM app_user WHERE email = ANY($1::text[])`,
          [emails]);
        for (const row of r.rows) byEmail[row.email] = row.id;
      }
      return byEmail;
    },

    /** The tenant's daily deliveries history — the A5 ±50% confirmation
     * guard's baseline (trailing-7-day mean of valid entries). Daily rows
     * only: coarser granularities never enter delivery_day (the worker
     * expands them upstream), so this IS the confirmed daily actuals. */
    async loadDailyDeliveriesHistory() {
      const r = await client.query(
        `SELECT day::text AS day, deliveries FROM delivery_day
          WHERE tenant_id = $1 AND granularity = 'daily' ORDER BY day`,
        [t]);
      return r.rows.map((row) => {
        const qty = Number(row.deliveries);
        if (!Number.isFinite(qty)) {
          throw new TypeError(`loadDailyDeliveriesHistory: deliveries for ${row.day} is not a finite number`);
        }
        return { date: row.day, qty };
      });
    },

    /* ---- persistence half -------------------------------------------------- */

    /** Register lifecycle: a file that failed BEFORE the executor could
     * apply it (gate refusal, bind/parse/validation quarantine) lands as
     * QUARANTINED — same H6 unique, same in-place discipline as apply()
     * (a retry reprocesses the SAME row, never forks the history). A
     * pre-binding refusal has no kind and is NOT registered here — the
     * caller records it as a data-health task + quarantine record instead
     * (the register's kind column never carries a guess). */
    async markFileQuarantined(file) {
      return upsertFileStatus(client, t, file, 'QUARANTINED');
    },

    /** Register lifecycle: an unexpected pipeline fault AFTER binding
     * (kind known, transaction still usable). Post-apply SQL faults roll
     * the caller's transaction back — the FAILED row is then written in a
     * FRESH transaction by the caller, which is why this is a separate
     * statement and not part of apply(). */
    async markFileFailed(file) {
      return upsertFileStatus(client, t, file, 'FAILED');
    },

    /** The quarantine ledger — one batched INSERT for the run's per-row
     * records (parse refusals, unresolved units/refs, flagged terms). Row
     * context is the guard's own record shape; ingest_file_id links the
     * run's register row when one exists (pre-binding refuses have none). */
    async insertQuarantineRecords(records, ingestFileId) {
      if (!Array.isArray(records)) {
        throw new TypeError('insertQuarantineRecords: records must be an array');
      }
      if (records.length === 0) return 0;
      if (ingestFileId !== undefined && ingestFileId !== null && (typeof ingestFileId !== 'string' || !UUID_RE.test(ingestFileId))) {
        throw new TypeError('insertQuarantineRecords: ingestFileId must be a uuid when present');
      }
      const ids = records.map(() => (ingestFileId === undefined || ingestFileId === null ? null : ingestFileId));
      const r = await client.query(
        `INSERT INTO quarantine_record
           (tenant_id, ingest_file_id, kind, row_index, field, raw_value, reason_code, detail)
         SELECT $1, f.id, f.kind, f.row_index, f.field, f.raw_value, f.reason_code, f.detail
           FROM unnest($2::uuid[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[])
                AS f(id, kind, row_index, field, raw_value, reason_code, detail)`,
        [t, ids, records.map((q) => String(q.fileKind)),
          records.map((q) => (q.rowIndex === undefined || q.rowIndex === null ? null : Number(q.rowIndex))),
          records.map((q) => (q.field === undefined || q.field === null ? null : String(q.field))),
          records.map((q) => (q.raw === undefined || q.raw === null ? null : String(q.raw))),
          records.map((q) => String(q.reason)),
          records.map((q) => (q.detail === undefined || q.detail === null ? null : String(q.detail)))]);
      return r.rowCount;
    },

    /** The data-health register — the guards' DATA_HEALTH tasks, persisted
     * verbatim. Payload shape: the guard's task object (field, detail,
     * fileKind…) MINUS `type` (it becomes the task_type column) PLUS the
     * run context (source file, checksum) so the screen can name the file
     * that raised the gap. Severity: the task's own when it carries one,
     * WARN otherwise — the honest floor; the worker raises whole-file
     * refusals as CRITICAL upstream. Unknown severity refuses here. */
    async insertDataHealthTasks(tasks, context) {
      if (!Array.isArray(tasks)) {
        throw new TypeError('insertDataHealthTasks: tasks must be an array');
      }
      if (tasks.length === 0) return 0;
      const ctx = context || {};
      const rows = tasks.map((task) => {
        if (!task || typeof task !== 'object' || task.type !== 'DATA_HEALTH') {
          throw new TypeError('insertDataHealthTasks: every task must be a { type: \'DATA_HEALTH\', field, detail } guard object');
        }
        const severity = task.severity === undefined ? 'WARN' : task.severity;
        if (!TASK_SEVERITIES.includes(severity)) {
          throw new TypeError(`insertDataHealthTasks: severity '${String(severity)}' is not a data_health_severity`);
        }
        const payload = { ...task };
        delete payload.type;
        delete payload.severity;
        if (ctx.fileName !== undefined) payload.sourceFile = ctx.fileName;
        if (ctx.checksum !== undefined) payload.checksum = ctx.checksum;
        return { severity, payload };
      });
      const r = await client.query(
        `INSERT INTO data_health_task (tenant_id, task_type, severity, status, payload)
         SELECT $1, 'DATA_HEALTH', f.severity::data_health_severity, 'OPEN', f.payload::jsonb
           FROM unnest($2::text[], $3::jsonb[]) AS f(severity, payload)`,
        [t, rows.map((r2) => r2.severity), rows.map((r2) => JSON.stringify(r2.payload))]);
      return r.rowCount;
    },

    /** Post-apply count fix-up: apply() stamps row_count = applied rows
     * atomically with them; the run's per-row quarantines are known only
     * after the full pipeline. One UPDATE, tenant-fenced, by id. */
    async updateQuarantinedCount(fileId, quarantinedCount) {
      if (typeof fileId !== 'string' || !UUID_RE.test(fileId)) {
        throw new TypeError('updateQuarantinedCount: fileId must be a uuid string');
      }
      if (!Number.isInteger(quarantinedCount) || quarantinedCount < 0) {
        throw new TypeError('updateQuarantinedCount: quarantinedCount must be a non-negative integer');
      }
      const r = await client.query(
        `UPDATE ingest_file SET quarantined_count = $3
          WHERE id = $2 AND tenant_id = $1`,
        [t, fileId, quarantinedCount]);
      return r.rowCount;
    },
  };
}

module.exports = { makeIngestWorkerAdapter, TASK_SEVERITIES };
