'use strict';
/* ============================================================================
 * sourcing-adapter — the SRC-05 evidence read (the Suppliers tile; build
 * spec §16.5 SRC-05 / A15.2). One read, RLS-scoped, statement-first.
 *
 * The KPI's formula lives in the pure kpi-catalog module (evaluateSrc05);
 * this adapter owns ONLY the evidence rows that feed it:
 *   - the ACTIVE categories from the item master (the denominator: a
 *     category holding ≥ 1 non-inactive item);
 *   - the DISTINCT approved-supplier counts per category from the sourcing
 *     evidence (open PO lines joined to their supplier — approved = the
 *     supplier row is_active and NOT is_banned);
 *   - the PO lines that could NOT be attributed to a category+supplier pair
 *     (item_id or supplier_id unresolved) — counted and disclosed, never
 *     silently dropped (an under-count would impersonate a healthier mix).
 *
 * The tenant predicate is explicit in every statement (the shape the stub
 * tier pins); RLS is the fence (the GUC is the caller's transaction's).
 * pg is never imported here; the client is injected.
 * ==========================================================================*/

function makeSourcingAdapter(client, tenantId) {
  const q = (text, values) => client.query(text, values);

  return {
    /* The §16 freshness stamp for the SRC-05 evaluation: the latest seal's
     * sealed_at, epoch-ms (the int8 cast discipline). null = never sealed —
     * the evaluator then refuses (no freshness stamp, no KPI). */
    loadLastSealStamp: async () => {
      const r = await q(
        `SELECT (extract(epoch from sealed_at) * 1000)::bigint AS "sealedAtMs"
           FROM plan_seal
          WHERE tenant_id = $1
          ORDER BY seal_date DESC LIMIT 1`, [tenantId]);
      return r.rows[0] ? Number(r.rows[0].sealedAtMs) : null;
    },

    loadCategorySupplierEvidence: async () => {
      const categories = (await q(
        `SELECT category, COUNT(*)::int AS "itemCount"
           FROM item
          WHERE tenant_id = $1 AND category IS NOT NULL AND NOT is_inactive
          GROUP BY category`, [tenantId])).rows;

      const evidence = (await q(
        `SELECT i.category AS category, COUNT(DISTINCT o.supplier_id)::int AS "supplierCount"
           FROM open_po_line o
           JOIN item i ON i.id = o.item_id AND i.tenant_id = o.tenant_id
           JOIN supplier s ON s.id = o.supplier_id
          WHERE o.tenant_id = $1 AND s.is_active AND NOT s.is_banned AND i.category IS NOT NULL
          GROUP BY i.category`, [tenantId])).rows;

      const attribution = (await q(
        `SELECT COUNT(*)::int AS "openLines",
                COUNT(*) FILTER (WHERE item_id IS NULL OR supplier_id IS NULL)::int AS "unattributed"
           FROM open_po_line
          WHERE tenant_id = $1`, [tenantId])).rows[0] || { openLines: 0, unattributed: 0 };

      const evidenceByCategory = new Map(evidence.map((r) => [r.category, r.supplierCount]));
      return {
        categories: categories.map((c) => ({
          category: c.category,
          itemCount: c.itemCount,
          /* an active category with no evidence row is UNSOURCED (null) —
           * never 0-and-hidden, never folded into single-source */
          supplierCount: evidenceByCategory.has(c.category) ? evidenceByCategory.get(c.category) : null,
        })),
        openLines: attribution.openLines,
        unattributedLines: attribution.unattributed,
      };
    },
  };
}

module.exports = { makeSourcingAdapter };
