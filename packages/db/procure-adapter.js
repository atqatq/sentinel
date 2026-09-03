'use strict';
/* ============================================================================
 * makeProcureAdapter(client, tenantId) — the SQL executor of the C3
 * financial-controls workflow (0003_controls): proposal → approval → PO,
 * the value tiers' reads, and the supplier-change-hold lifecycle.
 *
 * Home rule (the H6 pattern): the DECISION lives in the pure approval module
 * (packages/core/modules/approval — the caller runs it first and calls this
 * adapter only with a green verdict); this package owns the SQL mechanics.
 * The database re-proves every invariant the module proved — the RESTRICTIVE
 * sod_binding policy binds each approval to the app.actor_id GUC and refuses
 * the raiser; the proposal_state_guard trigger requires the tier's votes and
 * the supplier_identity_freeze trigger refuses any identity change outside
 * the verified hold. A buggy caller cannot out-vote the database.
 *
 * GUCs (ADR-0002 fence, extended): app.tenant_id (set by the caller,
 * transaction-local) fences RLS; app.actor_id binds approvals to the
 * authenticated principal; app.hold_apply_id is set INSIDE resolveHold(APPLY)
 * — the only door through the supplier freeze; app.cf_apply_id is set INSIDE
 * resolveCfVersion(APPLY) — the only door through the item_cf_freeze (M7,
 * §14.13b).
 *
 * Statement-first discipline (the H6 executor lesson): multi-write methods
 * build every statement before the first one issues — a malformed intent
 * throws with zero statements sent, nothing half-applies.
 *
 * pg is never imported here; the client is injected. The structural suites
 * import this package without a database; the LIVE proof is
 * test/sod-live.js (CI db-rls job).
 * ==========================================================================*/

const { deriveRederiveTasks: CF_DERIVE } = require('../core/modules/approval/src/cf.js');

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/* §14.13c — the API's read ports refuse by name (code-carrying, never coerced). */
function cfError(code, detail) {
  const e = new Error(`${code}: ${detail}`);
  e.code = code;
  return e;
}

const PROPOSAL_COLS = `id, tenant_id AS "tenantId", code, state, raised_by AS "raisedBy",
    supplier_id AS "supplierId", currency_code AS "currencyCode", total_amount AS "totalAmount",
    note, created_at AS "createdAt", updated_at AS "updatedAt"`;

function makeProcureAdapter(client, tenantId) {
  const q = (text, values) => client.query(text, values);

  /* node-pg ships NUMERIC as a STRING (the int8 lesson from the H6 boundary,
   * caught live again): every numeric the decision layer does MATH on leaves
   * this adapter as a finite JS number — never a string that would make the
   * tier comparisons type-refuse, never a silent NaN. */
  const num = (v, name) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('INVALID_NUMERIC_BOUNDARY: ' + name);
    return n;
  };

  return {
    /* ---- reads (the decision layer's inputs) ------------------------------ */

    /* The tenant's tier config + the role limits, in one call. */
    loadControls: async () => {
      const cfg = await q(
        `SELECT currency_code AS "currencyCode", dual_threshold_amount AS "dualThresholdAmount"
           FROM approval_config WHERE tenant_id = $1`, [tenantId]);
      const limits = await q(
        `SELECT role, max_single_amount AS "maxSingleAmount"
           FROM approval_limit WHERE tenant_id = $1 ORDER BY role`, [tenantId]);
      return {
        config: cfg.rows[0] ? {
          currencyCode: cfg.rows[0].currencyCode,
          dualThresholdAmount: num(cfg.rows[0].dualThresholdAmount, 'dual_threshold_amount'),
        } : null,
        limits: limits.rows.map((r) => ({ role: r.role, maxSingleAmount: num(r.maxSingleAmount, 'max_single_amount') })),
      };
    },

    /* The proposal with its lines and decision rows — the review input. */
    loadProposalByCode: async (code) => {
      const head = await q(
        `SELECT ${PROPOSAL_COLS} FROM proposal WHERE tenant_id = $1 AND code = $2`,
        [tenantId, code]);
      if (!head.rows.length) return null;
      const lines = await q(
        `SELECT sku, item_id AS "itemId", qty, unit_code AS "unitCode", unit_price AS "unitPrice"
           FROM proposal_line WHERE tenant_id = $1 AND proposal_id = $2 ORDER BY sku`,
        [tenantId, head.rows[0].id]);
      const approvals = await q(
        `SELECT approver_id AS "approverId", decision, reason, created_at AS "createdAt"
           FROM approval WHERE tenant_id = $1 AND proposal_id = $2 ORDER BY created_at`,
        [tenantId, head.rows[0].id]);
      const p = head.rows[0];
      return {
        proposal: { ...p, totalAmount: num(p.totalAmount, 'total_amount') },
        lines: lines.rows.map((l) => ({ ...l, qty: num(l.qty, 'qty'), unitPrice: num(l.unitPrice, 'unit_price') })),
        approvals: approvals.rows,
      };
    },

    /* ---- the workflow writes ---------------------------------------------- */

    /* raise: any authenticated member may raise (the SoD invariant binds
     * APPROVAL, not the raise). Statements built first, then issued. */
    raiseProposal: async ({ code, raisedBy, supplierId, currencyCode, totalAmount, note, lines }) => {
      if (!code || !raisedBy || !currencyCode || typeof totalAmount !== 'number' || !Array.isArray(lines) || lines.length === 0) {
        throw new Error('INVALID_PROPOSAL_INTENT');
      }
      const stmts = [
        { text: `INSERT INTO proposal (tenant_id, code, raised_by, supplier_id, currency_code, total_amount, note)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${PROPOSAL_COLS}`,
          values: [tenantId, code, raisedBy, supplierId || null, currencyCode, totalAmount, note || null] },
        ...lines.map((l) => ({
          text: `INSERT INTO proposal_line (tenant_id, proposal_id, item_id, sku, qty, unit_code, unit_price)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          values: [tenantId, null, l.itemId || null, l.sku, l.qty, l.unitCode, l.unitPrice],
        })),
      ];
      const head = await q(stmts[0].text, stmts[0].values);
      const proposalId = head.rows[0].id;
      for (const s of stmts.slice(1)) await q(s.text, [tenantId, proposalId, ...s.values.slice(2)]);
      return head.rows[0];
    },

    /* One decision row. The caller has the module's green verdict; the
     * sod_binding policy and the reject-dismiss trigger do the rest. */
    recordApproval: async ({ proposalId, approverId, decision, reason }) => {
      const r = await q(
        `INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, approver_id AS "approverId", decision, reason`,
        [tenantId, proposalId, approverId, decision, reason]);
      return r.rows[0];
    },

    /* State advances ride the proposal_state_guard trigger — the WHERE on the
     * prior state keeps the transition explicit; the trigger refuses
     * everything the tiers do not license. */
    advanceProposal: async ({ proposalId, from, to }) => {
      const r = await q(
        `UPDATE proposal SET state = $3, updated_at = now()
           WHERE tenant_id = $1 AND id = $2 AND state = $4
         RETURNING ${PROPOSAL_COLS}`,
        [tenantId, proposalId, to, from]);
      if (!r.rows.length) throw new Error('PROPOSAL_ADVANCE_REFUSED');
      return r.rows[0];
    },

    /* Conversion: the PO document + its lines + the state advance, all built
     * before the first INSERT. UNIQUE (proposal_id) makes a second conversion
     * of the same proposal structurally impossible. */
    convertProposal: async ({ proposalId, poCode, convertedBy, lines }) => {
      const head = await q(
        `SELECT ${PROPOSAL_COLS} FROM proposal WHERE tenant_id = $1 AND id = $2 AND state = 'APPROVED'`,
        [tenantId, proposalId]);
      if (!head.rows.length) throw new Error('PROPOSAL_NOT_APPROVED');
      const p = head.rows[0];
      const po = await q(
        `INSERT INTO purchase_order (tenant_id, code, proposal_id, supplier_id, currency_code, total_amount, converted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, code, proposal_id AS "proposalId", total_amount AS "totalAmount"`,
        [tenantId, poCode, proposalId, p.supplierId, p.currencyCode, p.totalAmount, convertedBy]);
      const poId = po.rows[0].id;
      for (const l of lines) {
        await q(
          `INSERT INTO po_line (tenant_id, po_id, item_id, sku, qty, unit_code, unit_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, poId, l.itemId || null, l.sku, l.qty, l.unitCode, l.unitPrice]);
      }
      await q(
        `UPDATE proposal SET state = 'CONVERTED', updated_at = now()
           WHERE tenant_id = $1 AND id = $2 AND state = 'APPROVED'`,
        [tenantId, proposalId]);
      return po.rows[0];
    },

    /* ---- the supplier-identity freeze ------------------------------------- */

    /* Stage the hold: the frozen delta (ALL five fields, from/to as strings)
     * is stored verbatim; the stored identity keeps serving. requestedBy NULL
     * = pipeline-originated (any eligible verifier may verify it). */
    stageSupplierHold: async ({ supplierId, changedFields, requestedBy }) => {
      const r = await q(
        `INSERT INTO supplier_change_hold (tenant_id, supplier_id, changed_fields, requested_by)
         VALUES ($1,$2,$3,$4)
         RETURNING id, supplier_id AS "supplierId", state, requested_by AS "requestedBy", requested_at AS "requestedAt"`,
        [tenantId, supplierId, JSON.stringify(changedFields), requestedBy || null]);
      return r.rows[0];
    },

    loadActiveHold: async (supplierId) => {
      const r = await q(
        `SELECT id, supplier_id AS "supplierId", changed_fields AS "changedFields", state,
                requested_by AS "requestedBy", verification_reference AS "verificationReference"
           FROM supplier_change_hold
          WHERE tenant_id = $1 AND supplier_id = $2 AND state = 'COOLING_OFF'
          ORDER BY requested_at DESC LIMIT 1`, [tenantId, supplierId]);
      return r.rows[0] || null;
    },

    /* The ONLY door through the freeze. APPLY: verify-gate facts are stamped,
     * app.hold_apply_id is set transaction-locally, the supplier row is moved
     * to the held values (the trigger demands an EXACT delta match), and the
     * hold lands APPLIED — one transaction, the caller's. REJECT: the hold
     * lands REJECTED and the stored identity simply keeps serving. */
    resolveHold: async ({ holdId, supplierId, changedFields, verifiedBy, reference, decision }) => {
      if (decision === 'REJECT') {
        const r = await q(
          `UPDATE supplier_change_hold
              SET state = 'REJECTED', verified_by = $3, verification_reference = $4, resolved_at = now()
            WHERE tenant_id = $1 AND id = $2 AND state = 'COOLING_OFF'
         RETURNING id, state`,
          [tenantId, holdId, verifiedBy, reference || null]);
        if (!r.rows.length) throw new Error('HOLD_NOT_PENDING');
        return r.rows[0];
      }
      if (decision !== 'APPLY') throw new Error('INVALID_HOLD_DECISION');
      if (!reference || reference.trim() === '') throw new Error('MISSING_VERIFICATION_REFERENCE');
      /* Statement-first: the supplier UPDATE is fully built from the stored
       * delta before anything issues. */
      const upd = {
        text: `UPDATE supplier
                  SET external_id = $3, name = $4, payment_term_days = $5::int,
                      payment_terms_text = $6, currency_code = $7
                WHERE tenant_id = $1 AND id = $2`,
        values: [tenantId, supplierId,
          changedFields.external_id.to, changedFields.name.to,
          changedFields.payment_term_days.to, changedFields.payment_terms_text.to,
          changedFields.currency_code.to],
      };
      await q(`SELECT set_config('app.hold_apply_id', $1, true)`, [holdId]);
      await q(upd.text, upd.values);
      const done = await q(
        `UPDATE supplier_change_hold
            SET state = 'APPLIED', verified_by = $3, verification_reference = $4, resolved_at = now()
          WHERE tenant_id = $1 AND id = $2 AND state = 'COOLING_OFF'
       RETURNING id, state`,
        [tenantId, holdId, verifiedBy, reference]);
      if (!done.rows.length) throw new Error('HOLD_NOT_PENDING');
      return done.rows[0];
    },

    /* ---- M7 (§14.13b): the conversion-factor door -------------------------
     * The ONLY path through the item_cf_freeze trigger. The caller runs the
     * pure gate first (cf.decideCfVersion — eligible decider, never the
     * requester, PENDING only); this adapter owns the SQL mechanics:
     *
     *   APPLY: the version is locked FOR UPDATE (state re-proved),
     *     app.cf_apply_id is set transaction-locally, the item's factor moves
     *     to the version's EXACT target (the trigger demands id + tenant + sku
     *     + state + to_value to match — a GUC on the wrong version raises
     *     CF_VERSION_MISMATCH), the version lands EFFECTIVE, and the latest
     *     seal's sizing basis is walked (cf.deriveRederiveTasks) to raise the
     *     re-derivation tasks — one WARN per affected ref, inserted in the
     *     same transaction. Explicit re-derivation, never a silent rebase.
     *   REJECT: the version lands REJECTED with its required reason; the
     *     stored factor simply keeps serving. */
    loadPendingCfVersion: async (sku) => {
      const r = await q(
        `SELECT id, tenant_id AS "tenantId", sku, version, from_value, to_value, state::text AS state, requested_by AS "requestedBy"
           FROM item_cf_version
          WHERE tenant_id = $1 AND sku = $2 AND state = 'PENDING'
          ORDER BY version DESC LIMIT 1`, [tenantId, sku]);
      if (!r.rows[0]) return null;
      const row = r.rows[0];
      /* NUMERIC crosses the asNum boundary — node-pg ships DECIMAL as strings
       * (the int8 lesson, read direction); a null FROM stays null. */
      const from = row.from_value === null ? null : Number(row.from_value);
      const to = Number(row.to_value);
      return { ...row, fromValue: from, toValue: to, from: from === null ? null : String(from), to: String(to) };
    },

    /* ---- §14.13c: the API's read ports ----------------------------------
     * The decision boundary loads the version BY ID (the state re-proved,
     * not assumed — the loaded row is what the gate judges) and the latest
     * seal PAYLOAD (the APPLY leg's re-derivation walk — the §14.13b third
     * audit leg needs the sizing basis, never just the hash). RLS scopes
     * both: another tenant's version is indistinguishable from no version. */
    loadCfVersionById: async (versionId) => {
      if (typeof versionId !== 'string' || !UUID_RE.test(versionId)) {
        throw cfError('CF_VERSION_ID_INVALID', `versionId must be the version uuid, got ${JSON.stringify(versionId)}`);
      }
      const r = await q(
        `SELECT id, tenant_id AS "tenantId", sku, version, from_value, to_value, state::text AS state, requested_by AS "requestedBy"
           FROM item_cf_version
          WHERE tenant_id = $1 AND id = $2 AND state = 'PENDING'`, [tenantId, versionId]);
      if (!r.rows[0]) return null;
      const row = r.rows[0];
      const from = row.from_value === null ? null : Number(row.from_value);
      const to = Number(row.to_value);
      return { ...row, fromValue: from, toValue: to, from: from === null ? null : String(from), to: String(to) };
    },

    loadLatestSealPayload: async () => {
      const r = await q(
        `SELECT payload FROM plan_seal
          WHERE tenant_id = $1
          ORDER BY seal_date DESC LIMIT 1`, [tenantId]);
      return r.rows[0] ? r.rows[0].payload : null;
    },

    resolveCfVersion: async ({ versionId, decidedBy, decision, reason, latestSeal }) => {
      if (decision === 'REJECT') {
        if (!reason || typeof reason !== 'string' || reason.trim() === '') throw new Error('MISSING_REASON');
        const r = await q(
          `UPDATE item_cf_version
              SET state = 'REJECTED', decided_by = $3, decision_reason = $4, decided_at = now()
            WHERE tenant_id = $1 AND id = $2 AND state = 'PENDING'
       RETURNING id, state::text AS state, sku, version`,
          [tenantId, versionId, decidedBy, reason]);
        if (!r.rows.length) throw new Error('VERSION_NOT_PENDING');
        return { ...r.rows[0], tasksInserted: 0 };
      }
      if (decision !== 'APPLY') throw new Error('INVALID_CF_DECISION');

      /* Statement-first: the re-derivation bundle is derived BEFORE anything
       * writes — a malformed seal refuses with zero statements issued. The
       * to_value read back from the locked row is the value the item moves
       * to; the core's CF_INVALID gate has already refused an unfit target. */
      const lock = await q(
        `SELECT id, sku, version, from_value, to_value, state::text AS state
           FROM item_cf_version
          WHERE tenant_id = $1 AND id = $2 AND state = 'PENDING'
          FOR UPDATE`, [tenantId, versionId]);
      if (!lock.rows.length) throw new Error('VERSION_NOT_PENDING');
      const v = lock.rows[0];
      /* NUMERIC crosses the asNum boundary (the int8 lesson, read direction);
       * a null FROM stays null — Number(null) is 0, which would lie. */
      v.fromValue = v.from_value === null ? null : Number(v.from_value);
      v.toValue = Number(v.to_value);
      v.from = v.fromValue === null ? null : String(v.fromValue);
      v.to = String(v.toValue);
      const derive = CF_DERIVE(latestSeal, v);

      await q(`SELECT set_config('app.cf_apply_id', $1, true)`, [versionId]);
      await q(
        `UPDATE item SET conversion_factor = $3
          WHERE tenant_id = $1 AND sku = $2`,
        [tenantId, v.sku, v.toValue]);
      const done = await q(
        `UPDATE item_cf_version
            SET state = 'EFFECTIVE', decided_by = $3, decided_at = now()
          WHERE tenant_id = $1 AND id = $2 AND state = 'PENDING'
     RETURNING id, state::text AS state, sku, version`,
        [tenantId, versionId, decidedBy]);
      if (!done.rows.length) throw new Error('VERSION_NOT_PENDING');

      let tasksInserted = 0;
      if (derive.tasks.length > 0) {
        /* the worker's insertDataHealthTasks payload shape: type/severity are
         * columns, never payload members — the door ships the same shape. */
        const payloads = derive.tasks.map((x) => { const p = { ...x }; delete p.type; delete p.severity; return JSON.stringify(p); });
        const ins = await q(
          `INSERT INTO data_health_task (tenant_id, task_type, severity, status, payload)
           SELECT $1, 'DATA_HEALTH', f.severity::data_health_severity, 'OPEN', f.payload::jsonb
             FROM unnest($2::text[], $3::jsonb[]) AS f(severity, payload)`,
          [tenantId, derive.tasks.map((x) => x.severity), payloads]);
        tasksInserted = ins.rowCount;
      }
      return {
        ...done.rows[0], sku: v.sku, to: v.to, from: v.from,
        refsAffected: derive.refsAffected, refsUnaffected: derive.refsUnaffected,
        tasksInserted,
      };
    },

    /* Role grants (Origin's act — the controls_origin_only policy re-proves
     * the granter's role at the database). */
    grantRole: async ({ userId, role, grantedBy }) => {
      const r = await q(
        `INSERT INTO tenant_role (tenant_id, user_id, role, granted_by)
         VALUES ($1,$2,$3,$4)
         RETURNING id, user_id AS "userId", role`,
        [tenantId, userId, role, grantedBy]);
      return r.rows[0];
    },
  };
}

module.exports = { makeProcureAdapter };
