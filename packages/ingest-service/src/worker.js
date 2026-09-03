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
 * The §14.26 Mode-B fan-out: the pipeline branches on the FILE'S SHAPE, never
 * on the mode label. One data-carrying bound sheet → the single-grid path
 * (receipts byte-identical to the pre-fan-out worker). Several bound sheets →
 * each rides the IDENTICAL pipeline on a FRESH per-sheet state — one H6
 * register row per kind under the file's checksum, the file's verdict
 * aggregated honestly (any sheet QUARANTINED → the file settles quarantine/;
 * else any APPLIED; else REPLAY_NOOP), one fence per FILE: any sheet's fault
 * rolls back every sheet. The edges are named: MULTI_SHEET_KIND_COLLISION
 * (two data tabs, one kind — the second would silently replay its twin);
 * headers-only tabs are the template's unused state (skipped, disclosed,
 * never registered); WORKBOOK_NO_DATA_ROWS when every bound tab is empty.
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
const xlsx = require('./xlsx.js');
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
 *   delimiter (',' default), asOfMs (epoch, injected clock), avScan?, caps?,
 *   avRequired? (the deployment's declared AV posture — absent means the
 *   fail-closed default true; §14.25 clause 4)
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
  /* Per-run state (§14.26): ONE instance at FILE level for the pre-binding
   * stages and the single-grid path — receipts byte-identical to the
   * pre-fan-out worker — and ONE FRESH instance per sheet when a workbook
   * fans out, so every tab's counters, disclosures, banners, quarantine
   * records and tasks are its own. The task context carries the sheet name
   * in fan-outs (payload.sheet — the 3 a.m. operator reads WHICH tab spoke). */
  const makeRunState = (sheetName) => {
    const ctx = sheetName === undefined ? taskContext : { fileName, checksum, sheetName };
    const disclosures = [];
    const banners = [];
    const tasks = []; // guard tasks, persisted verbatim (severity folded in)
    const pushTask = (task, severity) => { if (task) tasks.push({ ...task, severity }); };
    const quarantineRecords = [];
    const counters = baseCounters();
    const persistTasks = async () => {
      if (tasks.length > 0) await ports.insertDataHealthTasks(tasks, ctx);
    };
    return { sheetName, disclosures, banners, tasks, pushTask, quarantineRecords, counters, persistTasks };
  };
  const fileState = makeRunState();
  const { disclosures, banners, counters } = fileState;

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

  /* ---- the per-grid pipeline (§4 steps 3–8): ONE grid in, ONE honest receipt
   * out. The single-grid file passes the FILE-level state; each fan-out sheet
   * passes a fresh per-sheet state (§14.26) — same code, same order, same
   * refusals, one H6 decision per (kind, checksum). */
  async function runBoundGrid(state, grid) {
    const { disclosures, banners, counters, tasks, pushTask, quarantineRecords, persistTasks } = state;
    // strip tips (formula injection) at the cell level BEFORE anything reads a cell
    const stripped = stage.hardening.stripFormulas(grid);
    grid = stripped.rows;
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
    const KIND = bound.kind;
    /* quarantineRow is born AFTER the bind — the register's kind column never
     * carries a guess, structurally (the old kind_() guard's invariant, now
     * enforced by construction). */
    const quarantineRow = (lineNo, field, raw, reason, detail) => {
      quarantineRecords.push(stage.parse.quarantineRecord({
        fileKind: KIND, rowIndex: lineNo, field, raw, reason, asOf: asOfMs,
        ...(detail !== undefined ? { detail } : {}),
      }));
      counters.rowsQuarantined++;
    };
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
      const fxFallbackByDay = new Map(); // pinnedFor → { count, rate, worstStaleDays } — the M10 fail-safe's per-run tally
      let statusPresent = false, statusDegraded = 0;
      for (const row of conv.converted) {
        row.waitingQtyConverted = row.waitingConverted; // the executor's column name
        /* §14.6c — the Purchase Order Status surface. Present-but-unknown is a
         * wiring error: the row quarantines (PO_STATUS_UNKNOWN), never coerces.
         * Absent/blank degrades to live — the run DISCLOSES the degradation
         * once, and the producer treats the line exactly as an OPEN line. */
        const st = stage.normalize.normalizePoStatus(row.poStatus);
        if (!st.ok) {
          quarantineRowAt(row.__lineNo, 'poStatus', row.poStatus, st.reason, st.detail);
          continue;
        }
        if (st.value === null) statusDegraded++;
        else statusPresent = true;
        row.poStatus = st.value; // normalized | null — the executor stores NULL for degraded
        const money = stage.normalize.normalizeMoney({ amount: row.unitPrice, documentCurrency: row.currency, asOfDay }, settings.currencyCode, rateTable);
        if (!money.ok) {
          quarantineRowAt(row.__lineNo, 'unitPrice', row.unitPrice, money.reason, `document currency ${row.currency}`);
          continue;
        }
        row.tenantUnitPrice = money.tenantValue;
        if (money.rateSource === 'PINNED_USD') {
          if (money.stale) {
            /* M10: the row rode the LAST PINNED rate — stale-visible, counted
             * per pinnedFor day, disclosed once below (ADR-0003 §3). */
            const f = fxFallbackByDay.get(money.rateStale.pinnedFor)
              || { count: 0, rate: money.rate, worstStaleDays: 0 };
            f.count += 1;
            f.worstStaleDays = Math.max(f.worstStaleDays, money.rateStale.staleDays);
            fxFallbackByDay.set(money.rateStale.pinnedFor, f);
          } else { pinnedUsd++; pinnedRate = money.rate; }
        }
        kept.push(row);
      }
      if (pinnedUsd > 0) disclosures.push(`${pinnedUsd} open PO line(s) converted at the pinned USD→${settings.currencyCode} rate ${pinnedRate} for ${asOfDay} (C2)`);
      for (const [pinnedFor, f] of [...fxFallbackByDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        disclosures.push(`${f.count} open PO line(s) converted at the LAST PINNED USD→${settings.currencyCode} rate ${f.rate} (pinned for ${pinnedFor}, ${f.worstStaleDays} day(s) stale) — the pin for ${asOfDay} is missing; the M10 fail-safe keeps the money flowing STALE-VISIBLE (ADR-0003) and DAT-06 pin coverage is breached until the pin job succeeds`);
      }
      if (statusPresent && statusDegraded > 0) {
        disclosures.push(`${statusDegraded} open PO line(s) carried no Purchase Order Status value — degraded to live for the supply axis (§14.6c)`);
      } else if (!statusPresent && kept.length > 0) {
        disclosures.push('the feed carries no Purchase Order Status column — every line degrades to live for the supply axis (§14.6c: live-line degradation, disclosed)');
      }
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

    /* ---- M7 (§14.13b): the items seam's CF classification rides the apply ---- */
    if (applied.cf) {
      for (const t of applied.cf.tasks) tasks.push(t); // CF_INVALID_KEPT rows surface on Data Health
      if (applied.cf.staged > 0) {
        disclosures.push(`${applied.cf.staged} conversion-factor change(s) staged as PENDING versions — the stored factor keeps serving until the gate decides (§14.13b)`);
      }
      if (applied.cf.blanksKept > 0) {
        disclosures.push(`${applied.cf.blanksKept} item row(s) carried no conversion factor — the stored factor kept serving (a blank never wipes, §14.13b)`);
      }
    }

    /* ---- §14.27: the suppliers seam's hold auto-staging rides the apply ---- */
    if (applied.holds) {
      for (const t of applied.holds.tasks) tasks.push(t); // the divergence WARN surfaces on Data Health
      const parts = [];
      if (applied.holds.staged > 0) parts.push(`${applied.holds.staged} staged`);
      if (applied.holds.deduped > 0) parts.push(`${applied.holds.deduped} deduped against an open hold`);
      if (applied.holds.diverged > 0) parts.push(`${applied.holds.diverged} diverged (nothing staged — a human reconciles)`);
      if (parts.length > 0) {
        disclosures.push(`supplier identity change(s) routed to the COOLING_OFF door: ${parts.join(', ')} — the stored identity keeps serving until an eligible verifier opens it (§14.27)`);
      }
    }

    if (quarantineRecords.length > 0) await ports.insertQuarantineRecords(quarantineRecords, applied.fileId);
    if (quarantineRecords.length > 0) await ports.updateQuarantinedCount(applied.fileId, quarantineRecords.length);
    await persistTasks();

    return {
      verdict: 'APPLIED', kind: KIND, fileName, checksum, byteSize, mode, source,
      fileId: applied.fileId, appliedAt: applied.appliedAt, reprocessOf: plan.reprocessOf,
      counters, disclosures, banners, tasksRaised: tasks.length,
    };
  }

  /* ---- 1. the H10 gate: the single choke point ------------------------------- */
  const gateInput = { bytes, declaredName, source, ...(input.caps ? { caps: input.caps } : {}), ...(input.avScan ? { avScan: input.avScan } : {}), ...(input.avRequired === undefined ? {} : { avRequired: input.avRequired }) };
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

  /* ---- 2. decode + grid (text decode; §4.1 workbook extraction) --------------- */
  /* The text path and the workbook path converge on ONE grid variable — from
   * here down the pipeline is deliberately IDENTICAL for both (the workbook
   * never gets a second, softer parser). */
  const sniff = stage.hardening.sniffBytes(bytes);
  let grid = null;

  if (sniff.kind === 'zip') {
    /* §4.1 — the workbook boundary: a real exact-pinned reader in the worker
     * layer (never a hand-rolled XML parser, never a dependency of the pure
     * module), caps bounding the inflated grid memory, then the sheets bound
     * against the kind signatures like any text grid. */
    const wb = await (deps.xlsx ? deps.xlsx.extractWorkbook(bytes, input.caps ? { ...input.caps } : {}) : xlsx.extractWorkbook(bytes));
    if (!wb.ok) {
      const detail = wb.reason === 'WORKBOOK_UNREADABLE'
        ? `${wb.detail || 'the workbook could not be read'}`
        : wb.detail || 'the workbook exceeds the extraction caps';
      await ports.insertDataHealthTasks([{ type: 'DATA_HEALTH', field: 'ingest', severity: 'CRITICAL', detail: `File not parsed (${wb.reason}): ${detail}. Nothing was applied.` }], taskContext);
      return {
        verdict: 'QUARANTINED', stage: 'grid', reason: wb.reason, detail,
        fileName, checksum, byteSize, mode, source,
        counters, disclosures, banners, tasksRaised: 1,
      };
    }
    /* bind each sheet against the kind signatures — the register's kind
     * column never carries a guess, so a sheet that matches nothing binds
     * nothing. The §14.26 fan-out: the pipeline branches on the FILE'S SHAPE,
     * never on the mode label — one data-carrying bound sheet keeps the
     * single-grid path; several bound sheets fan out, one H6 register row per
     * kind under the file's checksum. */
    const boundSheets = [];
    const unboundSheetNames = [];
    for (const sheet of wb.sheets) {
      /* bindGrid's SUCCESS return carries kind+headerRowIndex and NO `bound`
       * field — only failures set bound:false. Match the text path's check
       * (!bound || bound.bound === false), never `bound === true`. */
      const b = stage.binding.bindGrid(sheet.rows);
      if (b && b.bound !== false && b.kind) boundSheets.push({ name: sheet.name, grid: sheet.rows, bound: b });
      else unboundSheetNames.push(sheet.name);
    }
    if (boundSheets.length === 0) {
      const detail = wb.sheets.length === 0
        ? 'the workbook carries no sheets — nothing to bind'
        : `no sheet matched any kind signature (${wb.sheets.length} sheet(s) scanned) — unbound sheet(s): ${unboundSheetNames.map((n) => `'${n}'`).join(', ')} — closest diagnostics ride the bind stage`;
      await ports.insertDataHealthTasks([{ type: 'DATA_HEALTH', field: 'ingest', severity: 'CRITICAL', detail: `File not bound (NO_HEADER_ROW_FOUND): ${detail} Nothing was applied — the file is quarantined whole.` }], taskContext);
      return {
        verdict: 'QUARANTINED', stage: 'bind', reason: 'NO_HEADER_ROW_FOUND', detail,
        fileName, checksum, byteSize, mode, source,
        counters, disclosures, banners, tasksRaised: 1,
      };
    }
    if (unboundSheetNames.length > 0) {
      const boundNames = boundSheets.map((s) => `'${s.name}' (${s.bound.kind})`).join(', ');
      const unbound = unboundSheetNames.map((n) => `'${n}'`).join(', ');
      const detail = `the workbook mixes datasets and sheets that matched no kind signature — bound: ${boundNames}; unbound: ${unbound}. A workbook whose tabs do not all declare their dataset refuses whole (the strict-parse discipline applied to the sheet set); nothing was applied.`;
      await ports.insertDataHealthTasks([{ type: 'DATA_HEALTH', field: 'ingest', severity: 'CRITICAL', detail: `File not bound (NO_HEADER_ROW_FOUND): ${detail}` }], taskContext);
      return {
        verdict: 'QUARANTINED', stage: 'bind', reason: 'NO_HEADER_ROW_FOUND', detail,
        fileName, checksum, byteSize, mode, source,
        counters, disclosures, banners, tasksRaised: 1,
      };
    }
    /* headers-only tabs: the fixed-header template keeps all 8 headers, so an
     * unused tab still BINDS its kind — a bound sheet with no rows under its
     * header is the template's unused state: skipped and disclosed, never
     * registered (a zero-row register row would be noise, not honesty). */
    const dataSheets = boundSheets.filter((s) => s.grid.length > s.bound.headerRowIndex + 1);
    const headersOnly = boundSheets.filter((s) => s.grid.length <= s.bound.headerRowIndex + 1);
    if (dataSheets.length === 0) {
      const names = boundSheets.map((s) => `'${s.name}' (${s.bound.kind})`).join(', ');
      const detail = `every kind-bound sheet (${names}) carried headers only — no data rows under any header. Nothing to ingest, nothing applied. An unused template tab keeps its headers; this refusal means EVERY tab was empty.`;
      await ports.insertDataHealthTasks([{ type: 'DATA_HEALTH', field: 'ingest', severity: 'CRITICAL', detail: `File not applied (WORKBOOK_NO_DATA_ROWS). ${detail}` }], taskContext);
      return {
        verdict: 'QUARANTINED', stage: 'bind', reason: 'WORKBOOK_NO_DATA_ROWS', detail,
        fileName, checksum, byteSize, mode, source,
        counters, disclosures, banners, tasksRaised: 1,
      };
    }
    /* the same-kind collision: two DATA sheets claiming one kind would share
     * the (tenant, kind, checksum) register identity — the second would
     * silently REPLAY the first through the H6 decision. Refuse with the
     * twins named, before any sheet runs. */
    const tabsByKind = new Map();
    for (const s of dataSheets) tabsByKind.set(s.bound.kind, [...(tabsByKind.get(s.bound.kind) || []), s.name]);
    const collisions = [...tabsByKind.entries()].filter(([, names]) => names.length > 1);
    if (collisions.length > 0) {
      const named = collisions.map(([kind, names]) => `${names.map((n) => `'${n}'`).join(' and ')} both bind ${kind}`).join('; ');
      const detail = `the workbook carries duplicate dataset tabs — ${named}. One H6 register row per kind under the file's checksum means ONE data tab per kind; remove or rename the duplicate tab. Nothing was applied.`;
      await ports.insertDataHealthTasks([{ type: 'DATA_HEALTH', field: 'ingest', severity: 'CRITICAL', detail: `File not applied (MULTI_SHEET_KIND_COLLISION). ${detail}` }], taskContext);
      return {
        verdict: 'QUARANTINED', stage: 'bind', reason: 'MULTI_SHEET_KIND_COLLISION', detail,
        fileName, checksum, byteSize, mode, source,
        counters, disclosures, banners, tasksRaised: 1,
      };
    }
    if (headersOnly.length > 0) {
      disclosures.push(`${headersOnly.length} tab(s) carried headers only — ${headersOnly.map((s) => `'${s.name}' (${s.bound.kind})`).join(', ')} — the template's unused state: no data rows, skipped, never registered`);
    }
    if (dataSheets.length === 1) {
      /* the single-grid path — receipts byte-identical to the pre-fan-out worker */
      grid = dataSheets[0].grid;
      disclosures.push(`workbook sheet '${dataSheets[0].name}' bound as ${dataSheets[0].bound.kind} — the extraction is the §4.1 boundary (a real reader in the worker layer), the grid rides the IDENTICAL downstream pipeline as a text file`);
    } else {
      /* ---- §14.26 THE FAN-OUT: one H6 register row per kind ------------------ */
      const map = dataSheets.map((s) => `'${s.name}' → ${s.bound.kind}`).join(', ');
      disclosures.push(`workbook fan-out (Mode-B): ${dataSheets.length} kind-bound sheet(s) — ${map} — one H6 register row per kind under checksum ${checksum.slice(0, 12)}…, one fence per FILE: any sheet's fault rolls back every sheet (ADR-0002)`);
      const sheetReceipts = [];
      for (const s of dataSheets) {
        const st = makeRunState(s.name);
        st.disclosures.push(`workbook sheet '${s.name}' bound as ${s.bound.kind} — the extraction is the §4.1 boundary (a real reader in the worker layer), the grid rides the IDENTICAL downstream pipeline as a text file`);
        /* a throw propagates — the caller's rollback is whole-file (§14.26
         * clause 5); a quarantined sheet is an OUTCOME, not a fault: the loop
         * continues, its register row riding the same committed fence. */
        const one = await runBoundGrid(st, s.grid);
        sheetReceipts.push({ sheetName: s.name, ...one });
      }
      const summed = baseCounters();
      for (const r of sheetReceipts) for (const k of Object.keys(summed)) summed[k] += r.counters[k] || 0;
      /* banners are { message } objects — the file-level aggregate prefixes
       * each with the tab's name, keeping the message intact for the screen */
      for (const r of sheetReceipts) {
        for (const b of r.banners) {
          banners.push(b && typeof b.message === 'string' ? { ...b, message: `[${r.sheetName}] ${b.message}` } : `[${r.sheetName}] ${b}`);
        }
      }
      const aggregated = sheetReceipts.some((r) => r.verdict === 'QUARANTINED')
        ? 'QUARANTINED'
        : sheetReceipts.some((r) => r.verdict === 'APPLIED') ? 'APPLIED' : 'REPLAY_NOOP';
      const part = (verdict, fmt) => sheetReceipts.filter((r) => r.verdict === verdict).map(fmt).join(', ');
      const appliedPart = part('APPLIED', (r) => `'${r.sheetName}' (${r.kind}, ${r.counters.rowsApplied} row(s))`);
      const replayPart = part('REPLAY_NOOP', (r) => `'${r.sheetName}' (${r.kind})`);
      const quarantinedPart = part('QUARANTINED', (r) => `'${r.sheetName}' (${r.kind}${r.reason ? `, ${r.reason}` : ''})`);
      const detail = aggregated === 'QUARANTINED'
        ? `the fan-out split: applied — ${appliedPart || 'none'}; replayed — ${replayPart || 'none'}; quarantined — ${quarantinedPart}. The applied kinds are COMMITTED register rows under this checksum; re-drop the workbook after fixing the named tab — the applied kinds replay as no-ops.`
        : aggregated === 'APPLIED'
          ? `every sheet settled honestly: applied — ${appliedPart}${replayPart ? `; replayed — ${replayPart}` : ''}.`
          : `every sheet replayed — ${replayPart} — re-importing the same workbook changes nothing (§4).`;
      return {
        verdict: aggregated,
        fanout: true,
        sheets: sheetReceipts.map((r) => ({
          sheetName: r.sheetName, kind: r.kind, verdict: r.verdict,
          ...(r.fileId !== undefined ? { fileId: r.fileId } : {}),
          ...(r.appliedAt !== undefined ? { appliedAt: r.appliedAt } : {}),
          ...(r.priorStatus !== undefined ? { priorStatus: r.priorStatus } : {}),
          ...(r.reason !== undefined ? { reason: r.reason } : {}),
          ...(r.detail !== undefined ? { detail: r.detail } : {}),
          counters: r.counters, disclosures: r.disclosures, banners: r.banners, tasksRaised: r.tasksRaised,
        })),
        detail,
        fileName, checksum, byteSize, mode, source,
        counters: summed, disclosures, banners,
        tasksRaised: sheetReceipts.reduce((a, r) => a + (r.tasksRaised || 0), 0),
      };
    }
  } else if (sniff.kind === 'text') {
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
    grid = gridRes.rows;
  } else {
    /* The H10 gate refuses XML and unknown binaries BEFORE this stage —
     * reaching here means the sniff and the gate disagree, a wiring fault,
     * refused loudly. */
    throw new TypeError(`runFileToRows: sniff kind '${sniff.kind}' reached the grid stage — the H10 gate should have refused it`);
  }

  /* ---- 3–8. the shared per-grid pipeline (§4): ONE grid in, ONE honest
   * receipt out — the single-grid path (a text file, or a workbook with one
   * data-carrying sheet) rides the FILE-level state: receipts byte-identical
   * to the pre-fan-out worker (§14.26's shape rule). */
  return runBoundGrid(fileState, grid);
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
