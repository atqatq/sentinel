'use strict';
/* ============================================================================
 * ingest-service — runFileToRows: the file-to-rows worker (M3, D-028).
 *
 * The production caller the H6 layers were built for: one inbound file in,
 * one honest outcome out. dropzone / watched-folder / email-in all call
 * THIS function — the H10 gate is the single choke point and the source is
 * recorded but never consulted.
 *
 * Pipeline (INGESTION_FILE_SPEC §4, the stages this unit owns):
 *   gate (H10) → decode → grid → strip tips → detect kind + drop instruction
 *   rows → whitelist columns → type rows (strict parse, quarantine per row)
 *   → normalize units → C1 (openPO conversion) → C2 (money at the pinned
 *   rate) → inventory code→id resolution → deliveries day-expansion (the
 *   D-026 named unit) + A5 variance guard → category-owner identity →
 *   H6 decision (APPLY vs REPLAY_NOOP) → executor → PERSIST what the pure
 *   layers could only return: the register lifecycle, the quarantine
 *   ledger, the data-health tasks.
 *
 * Transaction contract: the CALLER opens the transaction and sets the GUC
 * fence (ADR-0002) — every port and the executor ride that client. The
 * worker never BEGINs/COMMITs. On an executor fault the caller's transaction
 * rolls back; the worker PROPAGATES — the caller then writes FAILED via
 * markFileFailed in a FRESH transaction (the honest post-rollback state).
 *
 * Honesty rules this file enforces:
 *   - a file refused BEFORE its kind binds (gate, workbook extraction,
 *     grid parse, header binding) writes NO register row — the register's
 *     kind column never carries a guess; the outcome lives as a CRITICAL
 *     data-health task (the /data-health screen's "register-not-yet-
 *     recorded" state names exactly this);
 *   - a file whose kind bound but whose rows ALL quarantine lands
 *     QUARANTINED on the SAME H6 unique apply() uses — a retry reprocesses
 *     the same row, never forks the history;
 *   - REPLAY_NOOP persists NOTHING (re-importing the same file changes
 *     nothing — §4) and returns the prior outcome's identity;
 *   - an APPLIED file reports its quarantines honestly: quarantined_count
 *     on the register row + the ledger rows + the WARN tasks.
 *
 * Determinism: identical bytes + identical ports produce deep-equal
 * receipts (the clock is injected as asOfMs; no Date() anywhere). Typed
 * rows carry __lineNo (the original 1-based file line) for quarantine
 * attribution — the executor reads only its named fields, so the marker
 * never reaches SQL.
 * ==========================================================================*/

const crypto = require('crypto');

const INGESTION = require('../../core/modules/ingestion/index.js');
const DATES = require('../../core/modules/calendar/src/dates.js');
const csv = require('./csv.js');
const expansion = require('./expansion.js');
const rowsLayer = require('./rows.js');

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

const PORT_METHODS = [
  'loadTenantSettings', 'loadUnitCatalog', 'loadFxPin', 'loadConversionFactors',
  'resolveStockRefs', 'resolveUserIdsByEmail', 'loadDailyDeliveriesHistory',
  'markFileQuarantined', 'insertQuarantineRecords', 'insertDataHealthTasks', 'updateQuarantinedCount',
];

function baseCounters() {
  return {
    rowsRead: 0, rowsApplied: 0, rowsQuarantined: 0, unresolvedUnits: 0,
    emptyRows: 0, strippedCells: 0, instructionRowCount: 0, droppedColumns: 0,
  };
}

/**
 * @param {object} deps
 *   hardening / binding / parse / normalize / idempotency — the ingestion
 *     module's stage surfaces (defaults: the real module; injectable);
 *   dates — the calendar module's H4 boundary surface (default: the real one);
 *   executor — { findFile, loadSeenKeys, apply } (makeIngestAdapter bound to
 *     (client, tenantId));
 *   ports — makeIngestWorkerAdapter bound to (client, tenantId).
 * @param {object} input
 *   tenantId, bytes (Uint8Array), declaredName, source ('dropzone' |
 *   'watched-folder' | 'email-in'), mode ('A'|'B', default 'A'),
 *   delimiter (',' default), asOfMs (epoch, injected clock), avScan?, caps?
 */
async function runFileToRows(deps, input) {
  if (!deps || typeof deps !== 'object') throw new TypeError('runFileToRows: deps are required');
  if (!input || typeof input !== 'object') throw new TypeError('runFileToRows: input is required');
  const { ports, executor } = deps;
  if (!ports || typeof ports !== 'object' || PORT_METHODS.some((k) => typeof ports[k] !== 'function')) {
    const missing = PORT_METHODS.filter((k) => !ports || typeof ports[k] !== 'function');
    throw new TypeError(`runFileToRows: ports missing required methods: ${missing.join(', ')}`);
  }
  if (!executor || typeof executor.findFile !== 'function' || typeof executor.loadSeenKeys !== 'function' || typeof executor.apply !== 'function') {
    throw new TypeError('runFileToRows: deps.executor must be the H6 adapter surface (findFile / loadSeenKeys / apply)');
  }
  const { tenantId, bytes, declaredName = '', source = 'dropzone', mode = 'A', delimiter = ',', asOfMs } = input;
  if (typeof tenantId !== 'string' || tenantId.trim() === '') throw new TypeError('runFileToRows: tenantId must be a non-empty string');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('runFileToRows: bytes must be a Uint8Array/Buffer');
  if (!Number.isFinite(asOfMs)) throw new TypeError('runFileToRows: asOfMs must be a finite epoch-ms number (the injected clock)');
  if (!['A', 'B'].includes(mode)) throw new TypeError(`runFileToRows: mode '${String(mode)}' is not an INGESTION_FILE_SPEC §1 mode (A|B)`);

  const stage = {
    hardening: deps.hardening || INGESTION.hardening,
    binding: deps.binding || INGESTION.filebinding,
    parse: deps.parse || INGESTION.parse,
    normalize: deps.normalize || INGESTION.normalize,
    idempotency: deps.idempotency || INGESTION.idempotency,
    dates: deps.dates || DATES,
  };
  const fileName = declaredName === '' ? '(unnamed)' : declaredName;
  const checksum = sha256Hex(bytes);
  const byteSize = bytes.byteLength;
  const taskContext = { fileName, checksum };
  const disclosures = [];
  const banners = [];
  const tasks = []; // guard tasks, persisted verbatim (severity folded in)
  const pushTask = (task, severity) => { if (task) tasks.push({ ...task, severity }); };
  const quarantineRecords = [];
  const counters = baseCounters();

  const persistTasks = async () => {
    if (tasks.length > 0) await ports.insertDataHealthTasks(tasks, taskContext);
  };

  /* ---- 0. tenant settings: currency (C2) + timezone (H4) -------------------- */
  const settings = await ports.loadTenantSettings();
  if (!settings || typeof settings.currencyCode !== 'string' || typeof settings.timezone !== 'string') {
    return {
      verdict: 'QUARANTINED', stage: 'tenant', reason: 'TENANT_SETTINGS_UNAVAILABLE',
      detail: 'the tenant row (currency_code, timezone) is missing — the run refuses rather than guessing a default',
      fileName, checksum, byteSize, mode, source,
      counters, disclosures, banners, tasksRaised: 0,
    };
  }
  const tz = { iana: settings.timezone };
  const asOfDay = stage.dates.localDateOfInstant(asOfMs, tz); // the tenant-day this run pins rates to
  if (typeof asOfDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDay)) {
    return {
      verdict: 'QUARANTINED', stage: 'tenant', reason: 'INVALID_TENANT_TIMEZONE',
      detail: `tenant timezone '${settings.timezone}' did not resolve on this runtime (H4: dates convert with the EXPLICIT tenant setting, never a default)`,
      fileName, checksum, byteSize, mode, source,
      counters, disclosures, banners, tasksRaised: 0,
    };
  }

  const quarantineRow = (lineNo, field, raw, reason, detail) => {
    quarantineRecords.push(stage.parse.quarantineRecord({
      fileKind: kind_(), rowIndex: lineNo, field, raw, reason, asOf: asOfMs,
      ...(detail !== undefined ? { detail } : {}),
    }));
    counters.rowsQuarantined++;
  };
  let KIND = null;
  const kind_ = () => {
    if (KIND === null) throw new TypeError('worker bug: quarantineRow called before the kind bound');
    return KIND;
  };

  /* ---- 1. the H10 gate: the single choke point ------------------------------- */
  const gateInput = { bytes, declaredName, source, ...(input.caps ? { caps: input.caps } : {}), ...(input.avScan ? { avScan: input.avScan } : {}) };
  const gate = await stage.hardening.gateInboundFile(gateInput);
  if (gate.verdict === 'REFUSE') {
    // Pre-binding refusal: NO register row (kind unknown) — CRITICAL task only.
    await ports.insertDataHealthTasks([{ ...gate.task, severity: 'CRITICAL' }], taskContext);
    return {
      verdict: 'QUARANTINED', stage: 'gate', reason: gate.reason, detail: gate.detail,
      fileName, checksum, byteSize, mode, source,
      counters, disclosures, banners: gate.banner ? [gate.banner] : banners, tasksRaised: 1,
    };
  }

  /* ---- 2. decode + grid (text payloads; workbook extraction is a named follow-on) --- */
  const sniff = stage.hardening.sniffBytes(bytes);
  if (sniff.kind !== 'text') {
    const detail = 'the workbook passed the H10 gate structurally, but XLSX byte extraction is a named follow-on unit (XLSX_EXTRACTION_NOT_WIRED) — drop the CSV export or the template tab; no hand-rolled XML parser grows inside a pure module';
    await ports.insertDataHealthTasks([{ type: 'DATA_HEALTH', field: 'ingest', severity: 'CRITICAL', detail: `File not applied (XLSX_EXTRACTION_NOT_WIRED). ${detail}` }], taskContext);
    return {
      verdict: 'QUARANTINED', stage: 'grid', reason: 'XLSX_EXTRACTION_NOT_WIRED', detail,
      fileName, checksum, byteSize, mode, source,
      counters, disclosures, banners, tasksRaised: 1,
    };
  }
  const enc = sniff.encoding === 'UTF-16LE' ? 'utf-16le' : sniff.encoding === 'UTF-16BE' ? 'utf-16be' : 'utf-8';
  let text = new TextDecoder(enc, { fatal: true }).decode(bytes);
  text = text.replace(/^\uFEFF/, '');

  const gridRes = csv.parseGrid(text, { delimiter });
  if (!gridRes.ok) {
    await ports.insertDataHealthTasks([{ type: 'DATA_HEALTH', field: 'ingest', severity: 'CRITICAL', detail: `File not parsed (${gridRes.reason}): ${gridRes.detail || ''}. Nothing was applied.` }], taskContext);
    return {
      verdict: 'QUARANTINED', stage: 'grid', reason: gridRes.reason, detail: gridRes.detail,
      fileName, checksum, byteSize, mode, source,
      counters, disclosures, banners, tasksRaised: 1,
    };
  }

  // strip tips (formula injection) at the cell level BEFORE anything reads a cell
  const stripped = stage.hardening.stripFormulas(gridRes.rows);
  const grid = stripped.rows;
  if (stripped.count > 0) disclosures.push(`${stripped.count} formula-injection cell(s) neutralized with the OWASP apostrophe escape (H10) — any that claimed a numeric column now fail the strict parser`);

  /* ---- 3. bind the kind + drop instruction rows ------------------------------- */
  const bound = stage.binding.bindGrid(grid);
  if (!bound || bound.bound === false) {
    const reason = (bound && bound.reason) || 'NO_HEADER_ROW_FOUND';
    const det = bound && bound.detection ? `closest signature '${bound.detection.kind}' at score ${bound.detection.score}` : 'no kind signature matched any row';
    await ports.insertDataHealthTasks([{ type: 'DATA_HEALTH', field: 'ingest', severity: 'CRITICAL', detail: `File not bound (${reason}): ${det}. Nothing was applied — the file is quarantined whole.` }], taskContext);
    return {
      verdict: 'QUARANTINED', stage: 'bind', reason, detail: det,
      fileName, checksum, byteSize, mode, source,
      counters, disclosures, banners, tasksRaised: 1,
    };
  }
  KIND = bound.kind;
  if (bound.instructionRowCount > 0) disclosures.push(`${bound.instructionRowCount} instruction row(s) above the header dropped — never parsed as data`);
  if (bound.detection && Array.isArray(bound.detection.missingRequired) && bound.detection.missingRequired.length > 0) {
    disclosures.push(`partial signature match (score ${bound.detection.score}): missing ${bound.detection.missingRequired.join(', ')}`);
  }

  /* ---- 4. allow-list ----------------------------------------------------------- */
  const headers = grid[bound.headerRowIndex];
  const allow = stage.binding.applyAllowList(KIND, headers);
  if (allow.droppedCount > 0) disclosures.push(`${allow.droppedCount} column(s) outside the ${KIND} allow-list dropped at the boundary — never persisted, never logged`);
  for (const f of rowsLayer.EXECUTOR_DROPPED[KIND] || []) {
    if (allow.kept.some((k) => k.field === f)) disclosures.push(`canonical field '${f}' is kept by the allow-list but has no storage column for ${KIND} — typed, then dropped at the executor shape`);
  }

  /* ---- 5. typed canonical rows (strict parse; quarantine per row) --------------- */
  const catalog = await ports.loadUnitCatalog();
  stage.normalize.validateUnitCatalog(catalog); // a corrupt tenant catalog refuses the RUN, not row by row
  const typed = rowsLayer.buildTypedRows({
    kind: KIND, grid, headerRowIndex: bound.headerRowIndex, kept: allow.kept,
    asOfMs, tz, catalog,
    deps: { parse: stage.parse, normalize: stage.normalize, dates: stage.dates },
  });
  for (const q of typed.quarantines) { quarantineRecords.push(q); counters.rowsQuarantined++; }
  for (const flag of typed.flags) {
    pushTask({ type: 'DATA_HEALTH', field: flag.field, fileKind: KIND, detail: `${flag.field} flagged at line ${flag.rowIndex}: ${flag.detail}` }, 'WARN');
  }
  if (typed.unresolvedUnits > 0) {
    pushTask({ type: 'DATA_HEALTH', field: 'unit', fileKind: KIND, detail: `${typed.unresolvedUnits} unit spelling(s) did not resolve against the tenant catalog — their rows were quarantined, never guessed.` }, 'WARN');
  }
  counters.rowsRead = grid.length - bound.headerRowIndex - 1;
  counters.emptyRows = typed.emptyRows;
  counters.unresolvedUnits = typed.unresolvedUnits;
  counters.strippedCells = stripped.count;
  counters.instructionRowCount = bound.instructionRowCount;
  counters.droppedColumns = allow.droppedCount;

  let rows = typed.rows;
  const rateTable = await ports.loadFxPin(asOfDay);
  const quarantineRowAt = (lineNo, field, raw, reason, detail) => quarantineRow(lineNo, field, raw, reason, detail);

  /* ---- 6. kind enrichments ------------------------------------------------------- */

  if (KIND === 'open_pos') {
    const cfBySku = await ports.loadConversionFactors();
    const conv = stage.normalize.convertOpenPoRows(rows, cfBySku, asOfMs);
    for (const u of conv.unconverted) {
      quarantineRowAt(rows[u.rowIndex].__lineNo, 'waiting', u.waiting, u.reason, `sku ${u.sku}`);
    }
    const kept = [];
    let pinnedUsd = 0, pinnedRate = null;
    for (const row of conv.converted) {
      row.waitingQtyConverted = row.waitingConverted; // the executor's column name
      const money = stage.normalize.normalizeMoney({ amount: row.unitPrice, documentCurrency: row.currency, asOfDay }, settings.currencyCode, rateTable);
      if (!money.ok) {
        quarantineRowAt(row.__lineNo, 'unitPrice', row.unitPrice, money.reason, `document currency ${row.currency}`);
        continue;
      }
      row.tenantUnitPrice = money.tenantValue;
      if (money.rateSource === 'PINNED_USD') { pinnedUsd++; pinnedRate = money.rate; }
      kept.push(row);
    }
    if (pinnedUsd > 0) disclosures.push(`${pinnedUsd} open PO line(s) converted at the pinned USD→${settings.currencyCode} rate ${pinnedRate} for ${asOfDay} (C2)`);
    rows = kept;
  }

  if (KIND === 'inventory_all_dimensions') {
    const skus = [...new Set(rows.map((r) => r.sku))];
    const codes = [...new Set(rows.map((r) => r.warehouse))];
    const refs = await ports.resolveStockRefs(skus, codes);
    disclosures.push(`inventory value normalized in the tenant currency (${settings.currencyCode}) — the export carries no currency column, so the document currency IS the tenant currency (rate 1, disclosed; a USD-document tenant amends the export)`);
    const kept = [];
    for (const row of rows) {
      if (!refs.items[row.sku]) {
        quarantineRowAt(row.__lineNo, 'sku', row.sku, 'UNRESOLVED_ITEM_SKU', 'no item master row for this SKU — resolve the master first');
        continue;
      }
      if (!refs.warehouses[row.warehouse]) {
        quarantineRowAt(row.__lineNo, 'warehouse', row.warehouse, 'UNRESOLVED_WAREHOUSE', 'no warehouse row for this code');
        continue;
      }
      const money = stage.normalize.normalizeMoney({ amount: row.value, documentCurrency: settings.currencyCode, asOfDay }, settings.currencyCode, rateTable);
      if (!money.ok) { quarantineRowAt(row.__lineNo, 'value', row.value, money.reason); continue; }
      row.itemId = refs.items[row.sku];
      row.warehouseId = refs.warehouses[row.warehouse];
      row.quantity = row.qty; // the executor's column name
      row.valueDocument = row.value;
      row.documentCurrency = money.documentCurrency;
      row.tenantValue = money.tenantValue;
      kept.push(row);
    }
    rows = kept;
  }

  if (KIND === 'category_owners') {
    const emails = [...new Set(rows.map((r) => r.ownerEmail).filter(Boolean))];
    const users = await ports.resolveUserIdsByEmail(emails);
    for (const row of rows) row.userId = (row.ownerEmail && users[row.ownerEmail]) || null;
    const resolved = rows.filter((r) => r.userId).length;
    if (resolved < rows.length) disclosures.push(`${rows.length - resolved} category owner(s) have no Sentinel user yet — owner_email kept, user_id null (honest control-plane identity)`);
  }

  if (KIND === 'deliveries') {
    const history = await ports.loadDailyDeliveriesHistory();
    const mean7 = trailingMean7(history);
    // expand first (coarse rows must be judged per-day against a DAILY baseline), then guard
    const daily = [];
    let expandedFrom = 0;
    for (const row of rows) {
      const ex = expansion.expandDeliveriesRow(row);
      if (!ex.ok) {
        quarantineRowAt(row.__lineNo, 'granularity', `${row.periodStart}..${row.periodEnd} ${row.granularity}`, ex.reason, ex.detail);
        if (ex.task) pushTask(ex.task, 'WARN');
        if (ex.banner) banners.push(ex.banner);
        continue;
      }
      if (ex.disclosure) { disclosures.push(`line ${row.__lineNo}: ${ex.disclosure}`); expandedFrom++; }
      for (const d of ex.rows) daily.push({ ...d, __lineNo: row.__lineNo });
    }
    const guarded = [];
    if (mean7 > 0) {
      const bounds = { min: mean7 / 2, max: mean7 * 1.5 }; // the §4 ±50% confirmation band
      for (const row of daily) {
        /* the band check is the worker's (§4); the A5 guard provides the
         * quarantine + trailing-mean substitution + task + banner on breach */
        if (row.qty < bounds.min || row.qty > bounds.max) {
          const g = stage.parse.deliveriesGuard({ value: row.qty, field: 'qty', history, bounds, fileKind: KIND, rowIndex: row.__lineNo, asOf: asOfMs });
          if (g.baseline === 'TRAILING_7D_MEAN') {
            row.qty = g.substituteWith;
            pushTask(g.task, 'WARN');
            banners.push(g.banner);
            disclosures.push(`line ${row.__lineNo}: deliveries breached the ±50% band (${bounds.min.toFixed(2)}..${bounds.max.toFixed(2)}) — running on the trailing 7-day mean (${g.substituteWith}) until confirmed`);
            guarded.push(row);
          } else {
            quarantineRowAt(row.__lineNo, 'qty', row.qty, g.quarantined.reason, g.baseline === 'NO_VALID_BASELINE' ? 'breach with no valid baseline — treated as missing until confirmed' : undefined);
          }
        } else {
          guarded.push(row);
        }
      }
    } else {
      for (const row of daily) guarded.push(row);
    }
    rows = guarded;
  }

  /* ---- 7. survivors check ---------------------------------------------------------- */
  if (rows.length === 0) {
    const reg = await ports.markFileQuarantined({ kind: KIND, mode, fileName, checksum, byteSize, rowCount: counters.rowsRead, quarantinedCount: quarantineRecords.length });
    if (quarantineRecords.length > 0) await ports.insertQuarantineRecords(quarantineRecords, reg.fileId);
    await persistTasks();
    return {
      verdict: 'QUARANTINED', stage: 'validate', reason: 'NO_SURVIVOR_ROWS',
      detail: `every one of the ${counters.rowsRead} data row(s) quarantined — nothing was applied (the file is quarantined whole)`,
      fileName, checksum, byteSize, mode, source, kind: KIND,
      fileId: reg.fileId, counters, disclosures, banners, tasksRaised: tasks.length,
    };
  }

  /* ---- 8. the H6 decision + the proven executor ------------------------------------- */
  const [seen, prior] = [await executor.loadSeenKeys(KIND), await executor.findFile(KIND, checksum)];
  const plan = stage.idempotency.planIngestFile({ tenantId, kind: KIND, checksum, fileName, byteSize, mode, rows, seen, prior });
  for (const d of plan.disclosures) disclosures.push(d);

  if (plan.action === 'REPLAY_NOOP') {
    // §4: re-importing the same file changes nothing — this run persists NOTHING
    return {
      verdict: 'REPLAY_NOOP', kind: KIND, fileName, checksum, byteSize, mode, source,
      fileId: plan.fileId, priorStatus: plan.priorStatus, appliedAt: plan.appliedAt,
      counters: { ...counters, rowsApplied: 0, duplicateHits: plan.duplicateHits, newKeys: plan.newKeys },
      disclosures, banners, tasksRaised: 0,
    };
  }

  const applied = await executor.apply(plan); // faults propagate: the caller rolls back and writes FAILED in a fresh transaction
  counters.rowsApplied = applied.rowsApplied;
  counters.keysRegistered = applied.keysRegistered;
  counters.duplicateHits = plan.duplicateHits;
  counters.newKeys = plan.newKeys;

  if (quarantineRecords.length > 0) await ports.insertQuarantineRecords(quarantineRecords, applied.fileId);
  if (quarantineRecords.length > 0) await ports.updateQuarantinedCount(applied.fileId, quarantineRecords.length);
  await persistTasks();

  return {
    verdict: 'APPLIED', kind: KIND, fileName, checksum, byteSize, mode, source,
    fileId: applied.fileId, appliedAt: applied.appliedAt, reprocessOf: plan.reprocessOf,
    counters, disclosures, banners, tasksRaised: tasks.length,
  };
}

/** Trailing-7-distinct-date mean of the tenant's confirmed daily deliveries. */
function trailingMean7(history) {
  const byDate = new Map();
  for (const h of history || []) if (!byDate.has(h.date)) byDate.set(h.date, h.qty);
  const last7 = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7).map((e) => e[1]);
  if (last7.length === 0) return 0;
  return last7.reduce((a, b) => a + b, 0) / last7.length;
}

module.exports = { runFileToRows };
