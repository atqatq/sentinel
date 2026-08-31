'use strict';
/* ============================================================================
 * makePlanAdapter(client, tenantId) — the pg-backed loader/saver for the
 * plan-service ports (M2 unit 3 extract; the app layer injects it behind
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
 * pg itself is only touched by connectPlanPool below (lazy require): the
 * structural suites (golden job) import this package without a database or
 * pg installed — the dependency is real (see package.json) but only paid
 * when a caller actually opens a connection.
 * ==========================================================================*/

function makePlanAdapter(client, tenantId) {
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
        const cols = `tenant_id AS "tenantId", seal_date::text AS "sealDate", engine_version AS "engineVersion",
                      schema_version AS "schemaVersion", payload, payload_hash AS "payloadHash",
                      (extract(epoch from sealed_at) * 1000)::bigint AS "sealedAt"`;
        const ins = await client.query(
          `INSERT INTO plan_seal (tenant_id, seal_date, engine_version, schema_version, payload, payload_hash, sealed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, seal_date) DO NOTHING RETURNING ${cols}`,
          [tenantId, s.sealDate, s.engineVersion, s.schemaVersion, JSON.stringify(s.payload), s.payloadHash, s.sealedBy]);
        if (ins.rows.length) return { replayed: false, seal: ins.rows[0] };
        const sel = await client.query(
          `SELECT ${cols} FROM plan_seal WHERE tenant_id = $1 AND seal_date = $2`, [tenantId, s.sealDate]);
        return { replayed: true, seal: sel.rows[0] };
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
