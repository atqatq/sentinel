'use strict';
/* ============================================================================
 * makeDataHealthAdapter(client, tenantId) — the pg-backed read adapter for
 * the data-health facts surface (M2 data-health screens; the app layer
 * composes these rows with the ops freshness module behind injected deps).
 *
 * Home rule (the plan-adapter precedent): the db package owns SQL; the
 * composition owns semantics; apps/web owns transport. One SQL source —
 * whatever reads these facts in the app serves exactly these queries.
 *
 * What it reads, and why these are the right sources (D-025):
 *   - DAT-01 asks for "hours since the last successful per-tenant seal,
 *     worst across file types". A file type's successful ingest IS an
 *     APPLIED ingest_file row — `max(applied_at)` per kind is the
 *     "last successful seal" stamp the ops module evaluates. A kind with
 *     no APPLIED row maps to null (never sealed) — silence is never
 *     freshness, the ops module turns that into ALARM with a null age.
 *   - The gap register renders from data_health_task rows (the guards'
 *     DATA_HEALTH output, persisted by the ingestion worker when it lands).
 *   - The honest empty state distinguishes "nothing ever arrived" from
 *     "files arrived, none applied yet" — both are ALARM pipelines, but
 *     the screen names the difference instead of implying health.
 *
 * RLS (ADR-0002): every tenant-scoped query is fenced twice — the session/
 * transaction GUC `app.tenant_id` (set by the CALLER: transaction-local via
 * set_config(..., true) in the app route) fences the rows through RLS, and
 * the explicit `tenant_id = $1` predicate keeps the intent visible
 * regardless of policy evaluation. The connecting role must be sentinel_app
 * (NOBYPASSRLS) in production; FORCE binds owners too.
 *
 * resolveTenantByCode is deliberately NOT tenant-scoped: `tenant` is the
 * registry above the fence (no tenant_isolation policy by design — the
 * code is the public display identity the tenant switcher carries), and it
 * returns only the uuid the fence needs. It is a lookup, not a read of
 * tenant data.
 *
 * All timestamps leave this adapter as epoch-ms NUMBERS (the
 * `(extract(epoch …) * 1000)::bigint` cast comes back as a string through
 * pg — converted here so the composition layer stays pure arithmetic).
 * ==========================================================================*/

/* The tenant registry lookup — see the header note: unfenced by design,
 * returns the minimal identity the fence needs plus display fields. */
async function resolveTenantByCode(client, code) {
  const r = await client.query(
    `SELECT id, code, name FROM tenant WHERE code = $1`,
    [code]
  );
  return r.rows[0] || null;
}

function makeDataHealthAdapter(client, tenantId) {
  return {
    /* Per-kind last successful ingest stamp (epoch-ms number or null when
     * the kind never applied). Only kinds present in the table come back;
     * the composition folds this over the ops DATASET_KINDS list. */
    lastAppliedStampByKind: async () =>
      (await client.query(
        `SELECT kind,
                (extract(epoch FROM max(applied_at)) * 1000)::bigint AS "lastAppliedAtMs"
           FROM ingest_file
          WHERE tenant_id = $1 AND status = 'APPLIED'
          GROUP BY kind`,
        [tenantId]
      )).rows.map((r) => ({ kind: r.kind, lastAppliedAtMs: r.lastAppliedAtMs === null ? null : Number(r.lastAppliedAtMs) })),

    /* Open register entries — everything not resolved, newest first, with a
     * stable id tiebreak so the order is deterministic for a given state. */
    listOpenTasks: async () =>
      (await client.query(
        `SELECT id, task_type AS "taskType", severity, status, payload,
                (extract(epoch FROM created_at) * 1000)::bigint  AS "createdAtMs",
                (extract(epoch FROM resolved_at) * 1000)::bigint AS "resolvedAtMs"
           FROM data_health_task
          WHERE tenant_id = $1 AND status <> 'RESOLVED'
          ORDER BY created_at DESC, id`,
        [tenantId]
      )).rows.map((r) => ({
        id: r.id,
        taskType: r.taskType,
        severity: r.severity,
        status: r.status,
        payload: r.payload ?? null,
        createdAtMs: Number(r.createdAtMs),
        resolvedAtMs: r.resolvedAtMs === null || r.resolvedAtMs === undefined ? null : Number(r.resolvedAtMs),
      })),

    /* "Closed this month" — resolved within the window the composition
     * derives (UTC month start of the injected asOf). */
    countResolvedSince: async (sinceMs) => {
      const r = await client.query(
        `SELECT count(*)::int AS n
           FROM data_health_task
          WHERE tenant_id = $1 AND status = 'RESOLVED' AND resolved_at >= to_timestamp($2 / 1000.0)`,
        [tenantId, sinceMs]
      );
      return r.rows[0].n;
    },

    /* The honest-empty-state inputs: how many files ever arrived, and how
     * many ever applied. Two numbers, no interpretation — the screen names
     * the state, it does not imply health. */
    countIngestFiles: async () => {
      const r = await client.query(
        `SELECT count(*)::int AS received,
                count(*) FILTER (WHERE status = 'APPLIED')::int AS applied
           FROM ingest_file
          WHERE tenant_id = $1`,
        [tenantId]
      );
      return { received: r.rows[0].received, applied: r.rows[0].applied };
    },
  };
}

module.exports = { makeDataHealthAdapter, resolveTenantByCode };
