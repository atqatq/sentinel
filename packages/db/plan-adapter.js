'use strict';
/* ============================================================================
 * makePlanAdapter(client, tenantId, opts?) — the pg-backed loader/saver for
 * the plan-service ports (M2 unit 3 extract; the app layer injects it behind
 * handlePlanRun — delivery-spec §6.3 M2 "engine live").
 *
 * Home rule: the db package owns SQL; the plan-service owns orchestration;
 * apps/web owns transport. This adapter previously lived inline in
 * test/plan-seal-live.js — the live proof now imports THIS module, so the
 * SQL the app serves is byte-for-byte the SQL the live test proves (one
 * source, no drift).
 *
 * RLS (ADR-0002): every query is tenant-scoped twice — the session/transaction
 * GUC `app.tenant_id` (set by the CALLER: per-session in the live test,
 * transaction-local via set_config(..., true) in the app route) fences the
 * rows through RLS, and the explicit `tenant_id = $1` predicates keep the
 * intent visible regardless of policy evaluation. The connecting role must
 * be sentinel_app (NOBYPASSRLS) in production; FORCE binds owners too.
 *
 * M8 restatement (§14.16; 0008_restatement): the seal row stays immutable at
 * revision 1; a restatement is a NEW version chained to its predecessor in
 * plan_seal_restatement (the fork-guard trigger re-proves the pointer
 * structurally). "The seal for this tenant-day" resolves to the CURRENT
 * version — highest restatement revision, else the seal — everywhere:
 *
 *   - saveSeal's replay path compares the recomputed hash against the
 *     CURRENT version (a post-restatement replay of identical inputs is
 *     non-divergent exactly then).
 *   - restateSeal is the DOOR (the resolveCfVersion posture): statement-
 *     first derive under a lock on the anchor seal row (FOR UPDATE works —
 *     plan_seal carries full grants, unlike the ledger), named refusals
 *     BEFORE any insert (RESTATE_PREDECESSOR_MISSING / RESTATE_PREDECESSOR_
 *     MISMATCH — a stale predecessor means a concurrent restatement won;
 *     re-run against the new head), then the version INSERT and the H5
 *     ledger block (Class W, RESTATE_DAY) in the SAME caller transaction —
 *     §16.3 rule 2: the ledger write failing rolls the restatement back
 *     with it. An unlogged restatement must not be possible, and a logged
 *     one must not be un-done.
 *   - loadDayVersions is the time-machine read: every version of a day,
 *     ascending, plus the resolved current — the surface screen 12 renders.
 *
 * opts.ledger arms the door: { hmacKey, actor, role, sessionId, sourceIp,
 * onBehalfOf } — the secret-manager HMAC key + the authenticated session's
 * envelope (the route supplies them; the engine/schema stamps are filled
 * here from the repo constants, never trusted from the caller). UNARMED, a
 * restatement request fails loudly at the service boundary (TypeError) —
 * the door is either armed or the request is refused; never silently
 * ignored (§14.16 wiring posture).
 *
 * pg itself is only touched by connectPlanPool below (lazy require): the
 * structural suites (golden job) import this package without a database or
 * pg installed — the dependency is real (see package.json) but only paid
 * when a caller actually opens a connection.
 * ==========================================================================*/

const E = require('../core/modules/planning-engine');
const { SCHEMA_VERSION } = require('./schema-version');
const ledgerMod = require('./ledger-adapter');

const SEAL_COLS = `tenant_id AS "tenantId", seal_date::text AS "sealDate", engine_version AS "engineVersion",
                    schema_version AS "schemaVersion", payload, payload_hash AS "payloadHash",
                    (extract(epoch from sealed_at) * 1000)::bigint AS "sealedAt"`;

const RESTATE_COLS = `revision, payload, payload_hash AS "payloadHash", prev_revision AS "prevRevision",
                       prev_payload_hash AS "prevPayloadHash", delta, reason,
                       restated_by AS "restatedBy", restated_at AS "restatedAt",
                       engine_version AS "engineVersion", schema_version AS "schemaVersion"`;

const SEAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function restateError(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}

/* §14.6g — the sweep's named refusals (code-carrying, never coerced). */
function sweepError(code, detail) {
  const e = new Error(`SWEEP_${code}: ${detail}`);
  e.code = `SWEEP_${code}`;
  return e;
}

function assertSealDate(v, code) {
  if (typeof v !== 'string' || !SEAL_DATE_RE.test(v)) {
    throw restateError(code || 'RESTATE_SEAL_DATE_INVALID', `sealDate must be a YYYY-MM-DD string, got ${JSON.stringify(v)}`);
  }
}

function assertHash(v, field) {
  if (typeof v !== 'string' || !HASH_RE.test(v)) {
    throw restateError('RESTATE_HASH_INVALID', `${field} must be a 64-hex sha256 string, got ${JSON.stringify(v)}`);
  }
}

function makePlanAdapter(client, tenantId, opts) {
  /* The ledger door: armed only when the caller supplies the secret-manager
   * key + session envelope. The stamps are the repo's own constants — a
   * caller-supplied stamp would let a deployment mislabel the chain. */
  const ledgerAdapter = opts && opts.ledger
    ? ledgerMod.makeLedgerAdapter(client, tenantId, Object.assign({}, opts.ledger, {
        engineVersion: E.ENGINE_VERSION,
        schemaVersion: SCHEMA_VERSION,
      }))
    : null;

  return {
    loader: {
      loadTenant: async () => (await client.query(
        `SELECT code, currency_code AS "currencyCode", timezone FROM tenant WHERE id = $1`, [tenantId])).rows[0] || null,
      loadPlanInputs: async () => ({
        paramsByRef: Object.fromEntries((await client.query(
          `SELECT recipe_ref, params FROM planning_param WHERE tenant_id = $1`, [tenantId])).rows.map((r) => [r.recipe_ref, r.params])),
        items: (await client.query(
          `SELECT sku, recipe_ref AS "recipeRef", conversion_factor AS "conversionFactor", converted_unit AS "convertedUnit",
                  price, shelf_life_days AS "shelfLifeDays", preferred_for_recipe_ref AS "preferredForRecipeRef"
             FROM item WHERE tenant_id = $1 ORDER BY sku`, [tenantId])).rows,
        stock: (await client.query(
          `SELECT i.sku, s.quantity, s.tenant_value AS "tenantValue"
             FROM stock_line s JOIN item i ON i.id = s.item_id WHERE s.tenant_id = $1 ORDER BY i.sku`, [tenantId])).rows,
        openPo: (await client.query(
          `SELECT o.sku, o.po_number AS "poNumber", o.waiting_qty_converted AS "waitingQtyConverted",
                  o.received_qty AS "received", o.expected_delivery::text AS "expectedDelivery",
                  o.status, COALESCE(s.is_banned, false) AS "supplierBanned"
             FROM open_po_line o LEFT JOIN supplier s ON s.id = o.supplier_id
            WHERE o.tenant_id = $1 ORDER BY o.sku, o.po_number`, [tenantId])).rows,
        consumption: (await client.query(
          `SELECT sku, period_start::text AS start, period_end::text AS "end",
                  start_balance AS "startBalance", goods_in AS "goodsIn", goods_out AS "goodsOut", end_balance AS "endBalance"
             FROM consumption_balance WHERE tenant_id = $1 ORDER BY sku, period_start`, [tenantId])).rows,
        deliveries: (await client.query(
          `SELECT day::text AS start, day::text AS "end", deliveries
             FROM delivery_day WHERE tenant_id = $1 AND granularity = 'daily' ORDER BY day`, [tenantId])).rows,
        latestSeal: (await client.query(
          `SELECT seal_date::text AS "sealDate", payload_hash AS "payloadHash"
             FROM plan_seal WHERE tenant_id = $1 ORDER BY seal_date DESC LIMIT 1`, [tenantId])).rows[0] || null,
      }),
    },
    saver: {
      saveSeal: async (s) => {
        const ins = await client.query(
          `INSERT INTO plan_seal (tenant_id, seal_date, engine_version, schema_version, payload, payload_hash, sealed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, seal_date) DO NOTHING RETURNING ${SEAL_COLS}`,
          [tenantId, s.sealDate, s.engineVersion, s.schemaVersion, JSON.stringify(s.payload), s.payloadHash, s.sealedBy]);
        if (ins.rows.length) {
          return { replayed: false, seal: Object.assign({}, ins.rows[0], { revision: 1, source: 'seal' }) };
        }
        /* Replay: the stored day resolves to its CURRENT version — highest
         * restatement revision, else the seal row (§14.16). The divergence
         * comparison at the service boundary is against what the day says
         * NOW, not what it said first. */
        const cur = await client.query(
          `SELECT ${RESTATE_COLS} FROM plan_seal_restatement
            WHERE tenant_id = $1 AND seal_date = $2
            ORDER BY revision DESC LIMIT 1`, [tenantId, s.sealDate]);
        if (cur.rows.length) {
          return { replayed: true, seal: Object.assign({}, cur.rows[0], {
            tenantId, sealDate: s.sealDate, source: 'restatement',
            sealedAt: cur.rows[0].restatedAt,
          }) };
        }
        const sel = await client.query(
          `SELECT ${SEAL_COLS} FROM plan_seal WHERE tenant_id = $1 AND seal_date = $2`, [tenantId, s.sealDate]);
        return { replayed: true, seal: Object.assign({}, sel.rows[0], { revision: 1, source: 'seal' }) };
      },

      /* The M8 door — armed only with opts.ledger (see header). Throws the
       * named restateError codes; the caller's transaction owns commit and
       * rollback (the route BEGINs; the live test holds one open tx). */
      restateSeal: ledgerAdapter ? async (s) => {
        /* Statement-first: a malformed argument sends ZERO statements. */
        assertSealDate(s && s.sealDate);
        assertHash(s.payloadHash, 'payloadHash');
        assertHash(s.prevPayloadHash, 'prevPayloadHash');
        if (!Number.isSafeInteger(s.prevRevision) || s.prevRevision < 1) {
          throw restateError('RESTATE_PREDECESSOR_INVALID', `prevRevision must be a safe integer >= 1, got ${JSON.stringify(s.prevRevision)}`);
        }
        if (!s.payload || typeof s.payload !== 'object' || Array.isArray(s.payload)) {
          throw restateError('RESTATE_PAYLOAD_INVALID', 'payload must be the computed state object');
        }
        if (!s.delta || typeof s.delta !== 'object' || Array.isArray(s.delta)) {
          throw restateError('RESTATE_DELTA_INVALID', 'delta must be the as-known-then vs as-known-now summary');
        }
        if (typeof s.reason !== 'string' || s.reason.trim() === '') {
          throw restateError('RESTATE_REASON_REQUIRED', 'a restatement must carry a reason (the database CHECK agrees)');
        }
        if (typeof s.restatedBy !== 'string' || s.restatedBy === '') {
          throw restateError('RESTATE_ACTOR_REQUIRED', 'an anonymous restatement cannot exist');
        }
        if (typeof s.engineVersion !== 'string' || s.engineVersion === '' ||
            typeof s.schemaVersion !== 'string' || s.schemaVersion === '') {
          throw restateError('RESTATE_STAMP_INVALID', 'engineVersion and schemaVersion stamps are required (L-07)');
        }
        /* The anchor lock (the resolveCfVersion posture): plan_seal carries
         * full grants, so FOR UPDATE is available to sentinel_app — racing
         * restatements of the same day serialize here; the head read that
         * follows sees the winner's committed revision (READ COMMITTED
         * snapshots at statement start, which is after the wait). */
        const anchor = await client.query(
          `SELECT payload_hash FROM plan_seal
            WHERE tenant_id = $1 AND seal_date = $2 FOR UPDATE`, [tenantId, s.sealDate]);
        if (!anchor.rows.length) {
          throw restateError('RESTATE_PREDECESSOR_MISSING',
            `no seal row for ${s.sealDate} — there is no restatement of a day that was never sealed`);
        }
        const head = await client.query(
          `SELECT revision, payload_hash AS "payloadHash" FROM plan_seal_restatement
            WHERE tenant_id = $1 AND seal_date = $2
            ORDER BY revision DESC LIMIT 1`, [tenantId, s.sealDate]);
        const headRow = head.rows[0] || null;
        const expectedPrevRevision = headRow ? headRow.revision : 1;
        const expectedPrevHash = headRow ? headRow.payloadHash : anchor.rows[0].payload_hash;
        if (s.prevRevision !== expectedPrevRevision || s.prevPayloadHash !== expectedPrevHash) {
          throw restateError('RESTATE_PREDECESSOR_MISMATCH',
            `predecessor moved: the day's current revision is ${expectedPrevRevision} ` +
            `(caller named ${s.prevRevision}) — re-run against the new head`);
        }
        const revision = expectedPrevRevision + 1;
        const ins = await client.query(
          `INSERT INTO plan_seal_restatement
             (tenant_id, seal_date, revision, payload, payload_hash,
              prev_revision, prev_payload_hash, delta, reason,
              engine_version, schema_version, restated_by)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
          RETURNING ${RESTATE_COLS}`,
          [tenantId, s.sealDate, revision, JSON.stringify(s.payload), s.payloadHash,
           s.prevRevision, s.prevPayloadHash, JSON.stringify(s.delta), s.reason,
           s.engineVersion, s.schemaVersion, s.restatedBy]);
        /* The ledger block — the SAME transaction (§16.3 rule 2). A failed
         * append throws and the caller's ROLLBACK takes the version row
         * with it. The block carries pointers + delta, never a third copy
         * of the payload. */
        const block = await ledgerAdapter.appendBlock({
          class: 'W',
          entity: 'plan_seal',
          entityId: s.sealDate,
          action: 'RESTATE_DAY',
          outcome: 'success',
          before: { revision: s.prevRevision, payloadHash: s.prevPayloadHash },
          after: { revision, payloadHash: s.payloadHash, delta: s.delta },
          reason: s.reason,
        });
        const row = ins.rows[0];
        return {
          revision: row.revision,
          prevRevision: row.prevRevision,
          prevPayloadHash: row.prevPayloadHash,
          payloadHash: row.payloadHash,
          delta: row.delta,
          restatedAt: row.restatedAt,
          ledger: { seq: block.seq, hash: block.hash },
          seal: Object.assign({}, row, {
            tenantId, sealDate: s.sealDate, source: 'restatement',
          }),
        };
      } : undefined,

      /* The time-machine read (§14.16): every version of the day ascending,
       * the seal first, plus the resolved current. null = the day was never
       * sealed. RLS + the explicit predicate scope it to the tenant. */
      loadDayVersions: async (sealDate) => {
        assertSealDate(sealDate, 'RESTATE_SEAL_DATE_INVALID');
        const seal = await client.query(
          `SELECT ${SEAL_COLS}, 1 AS revision, 'seal' AS source
             FROM plan_seal WHERE tenant_id = $1 AND seal_date = $2`, [tenantId, sealDate]);
        if (!seal.rows.length) return null;
        const rest = await client.query(
          `SELECT ${RESTATE_COLS}, 'restatement' AS source
             FROM plan_seal_restatement
            WHERE tenant_id = $1 AND seal_date = $2
            ORDER BY revision ASC`, [tenantId, sealDate]);
        const versions = [...seal.rows, ...rest.rows];
        return { sealDate, versions, current: versions[versions.length - 1] };
      },

      /* §14.6g — the unpromised-waiting sweep: the register MIRRORS the
       * receipt's disclosure, idempotently, in the run's transaction:
       *   insert   — a desired field with no OPEN row lands (WARN,
       *              task_type DATA_HEALTH, payload carrying the field, the
       *              counts and the asOf of the raising run);
       *   no-op    — a desired field whose OPEN row exists is left alone
       *              (the same gap is not re-raised, not re-dated, not
       *              duplicated);
       *   resolve  — an OPEN `unpromised-waiting.*` row whose field is no
       *              longer desired RESOLVES (status RESOLVED, resolved_at
       *              stamped); rows are never deleted — the audit trail is
       *              the resolution.
       * Statement-first: the task shape validates BEFORE any statement; the
       * writer owns ONLY its field family (a foreign field refuses — the
       * sweep does not gentrify other guards' tasks). The sync rides the
       * caller's transaction (§16.3 rule 2's posture): a failed write rolls
       * the seal back with it. */
      syncUnpromisedWaitingTasks: async (tasks, context) => {
        if (!Array.isArray(tasks)) {
          throw sweepError('TASKS_MALFORMED', 'tasks must be the pure derivation\'s array (ops.datahealth.unpromisedWaitingTasks)');
        }
        const ctx = context || {};
        if (ctx.asOf !== undefined && (typeof ctx.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ctx.asOf))) {
          throw sweepError('ASOF_INVALID', `context.asOf must be a canonical YYYY-MM-DD day (H4), got ${JSON.stringify(ctx.asOf)}`);
        }
        const fields = [];
        const payloads = [];
        for (const t of tasks) {
          if (!t || typeof t !== 'object' || t.type !== 'DATA_HEALTH') {
            throw sweepError('TASK_MALFORMED', 'every task is a { type: \'DATA_HEALTH\', field, detail, severity } guard object');
          }
          if (typeof t.field !== 'string' || !t.field.startsWith('unpromised-waiting.')) {
            throw sweepError('FIELD_FOREIGN', `the sweep owns only the 'unpromised-waiting.*' family, got ${JSON.stringify(t.field)} — other guards' tasks are not gentrified`);
          }
          if (typeof t.detail !== 'string' || t.detail === '') {
            throw sweepError('TASK_MALFORMED', `task ${t.field} carries no detail — the register names the gap, never a bare field`);
          }
          const severity = t.severity === undefined ? 'WARN' : t.severity;
          if (severity !== 'WARN') {
            throw sweepError('SEVERITY_INVALID', `the sweep raises WARN (a missing promise is a data gap, not an outage), got ${JSON.stringify(severity)}`);
          }
          fields.push(t.field);
          const payload = { field: t.field, detail: t.detail };
          if (ctx.asOf !== undefined) payload.raisedAsOf = ctx.asOf;
          payloads.push(payload);
        }
        /* Resolve first, then insert — one direction, no re-dating of live
         * gaps. The UPDATE's NOT-ALL keeps every still-disclosed field open. */
        const upd = fields.length
          ? await client.query(
              `UPDATE data_health_task SET status = 'RESOLVED', resolved_at = now()
                WHERE tenant_id = $1 AND status = 'OPEN' AND task_type = 'DATA_HEALTH'
                  AND payload->>'field' LIKE 'unpromised-waiting.%'
                  AND NOT (payload->>'field' = ANY($2::text[]))`,
              [tenantId, fields])
          : await client.query(
              `UPDATE data_health_task SET status = 'RESOLVED', resolved_at = now()
                WHERE tenant_id = $1 AND status = 'OPEN' AND task_type = 'DATA_HEALTH'
                  AND payload->>'field' LIKE 'unpromised-waiting.%'`,
              [tenantId]);
        const ins = fields.length
          ? await client.query(
              `INSERT INTO data_health_task (tenant_id, task_type, severity, status, payload)
               SELECT $1, 'DATA_HEALTH', 'WARN', 'OPEN', f.payload::jsonb
                 FROM unnest($2::jsonb[]) AS f(payload)
                WHERE NOT EXISTS (
                  SELECT 1 FROM data_health_task d
                   WHERE d.tenant_id = $1 AND d.status = 'OPEN'
                     AND d.task_type = 'DATA_HEALTH'
                     AND d.payload->>'field' = f.payload->>'field')`,
              /* the node-pg array contract (the live tier's lesson, the
               * ingest-worker's pattern): a JS array of JSON STRINGS —
               * node-pg serializes the array into the Postgres array
               * literal; a pre-stringified JSON document would be parsed
               * AS an array literal and refuse (malformed array literal) */
              [tenantId, payloads.map((p) => JSON.stringify(p))])
          : { rowCount: 0 };
        /* The register's open count — the receipt's number is the
         * register's, never recomputed by the reader. */
        const open = await client.query(
          `SELECT count(*)::int AS n FROM data_health_task
            WHERE tenant_id = $1 AND status = 'OPEN' AND task_type = 'DATA_HEALTH'
              AND payload->>'field' LIKE 'unpromised-waiting.%'`, [tenantId]);
        return { inserted: ins.rowCount, resolved: upd.rowCount, open: open.rows[0].n };
      },
    },
  };
}

/* Lazy pg access for callers that need to OPEN a connection (the app route);
 * require is deferred so this package stays importable in no-database
 * environments (golden-test job has no pg installed). */
function pgDriver() {
  try {
    return require('pg');
  } catch (e) {
    throw new TypeError(
      'pg is required to open a plan connection — install it in the importing context (' +
      (e && e.message ? e.message : String(e)) + ')'
    );
  }
}

/* One pooled pg Client per plan run. The GUC is NOT set here: the caller owns
 * the transaction (BEGIN / set_config / COMMIT) so the whole run — reads,
 * seal write, RLS fencing — is one atomic tenant-scoped unit. */
async function connectPlanClient(connectionString) {
  const { Client } = pgDriver();
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

module.exports = { makePlanAdapter, connectPlanClient, pgDriver };
