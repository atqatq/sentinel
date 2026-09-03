'use strict';
/* ============================================================================
 * makeSetupAdapter(client, config) — the SQL executor of the §14.28 setup
 * layer (the Setup & onboarding phase, D-049; migration 0010_setup).
 *
 * Home rule (the H6/C3/H5/auth pattern): the DECISION layer is the pure
 * setup module (packages/core/modules/setup — the command validators, the
 * role ladder, the wizard's step derivation, consumed through its public
 * surface per ADR-0001); this package owns the SQL mechanics. The database
 * re-proves what it can, THREE ways:
 *   - the founder door (setup_create_tenant_with_founder, SECURITY DEFINER)
 *     re-proves is_origin for tenant creation — the API boundary's Origin
 *     gate is never the only gate;
 *   - controls_origin_only (0003) re-proves the acting Origin's O on every
 *     tenant_role / approval_config / approval_limit write — the grant
 *     transaction sets the GUCs and the RLS does the rest (42501 surfaces
 *     named as SETUP_TARGET_NOT_OWNED);
 *   - the pre-tenant membership reads ride the auth_user_tenants door
 *     (D-050) — the overview's per-tenant reads set the GUC per tenant
 *     inside ONE transaction (set_config is re-settable within a
 *     transaction; it is never set at session scope, where it would poison
 *     the pooled connection).
 *
 * config (all injected — this adapter owns no secrets and no clock):
 *   auth    REQUIRED — a composed auth adapter (makeAuthAdapter's surface):
 *           the bootstrap and user-creation paths delegate credential
 *           registration to it, so the scrypt posture and the pure policy
 *           floor live in exactly ONE place.
 *   tzList  REQUIRED — the IANA zone allowlist for the pure tenant
 *           validator (the boundary passes Intl.supportedValuesOf).
 *   now     optional () => Date (tests pin the clock).
 *
 * Statement-first discipline: the pure validators run BEFORE any statement
 * is built — a malformed command sends ZERO statements. The unique-key
 * collisions (origin exists, tenant code taken, email taken) are the
 * DATABASE's facts: pre-checked for a clean named refusal, and mapped from
 * 23505 as the backstop.
 * ==========================================================================*/

const SETUP = require('../core/modules/setup');

function refuse(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  throw e;
}

/* The door (and the database) speak in RAISE messages and SQLSTATEs; this
 * adapter translates to the §14.28 named family. */
function translateSetupError(e) {
  if (e && e.code && String(e.code).startsWith('SETUP_')) return e; // already named
  const msg = String((e && e.message) || '');
  if (msg.includes('SETUP_NOT_ORIGIN')) return refuse('SETUP_NOT_ORIGIN', msg.split('SETUP_NOT_ORIGIN:')[1] || 'the actor is not an origin principal');
  if (msg.includes('SETUP_SHAPE_INVALID')) return refuse('SETUP_SHAPE_INVALID', msg.split('SETUP_SHAPE_INVALID:')[1] || 'the door refused the shape');
  if (e && e.code === '23505') {
    if (msg.includes('tenant_code_key')) return refuse('SETUP_TENANT_CODE_TAKEN', 'a tenant with that code already exists');
    if (msg.includes('app_user_email_key')) return refuse('SETUP_EMAIL_TAKEN', 'a user with that email already exists');
  }
  if (e && e.code === '42501') return refuse('SETUP_TARGET_NOT_OWNED', 'the database refused the write — the acting principal does not hold an active O in the target tenant (controls_origin_only)');
  return e;
}

async function validateOrThrow(pure, cmd, opts) {
  const v = pure(cmd, opts);
  if (!v.ok) refuse(v.reason, v.detail);
  return v.value;
}

function makeSetupAdapter(client, config) {
  if (!config || typeof config !== 'object') throw new Error('SETUP_CONFIG_REQUIRED');
  if (!config.auth || typeof config.auth.registerCredential !== 'function') {
    throw new Error('SETUP_CONFIG_AUTH_REQUIRED: the credential posture lives in ONE place — inject the composed auth adapter');
  }
  if (!Array.isArray(config.tzList) || config.tzList.length === 0) {
    throw new Error('SETUP_CONFIG_TZLIST_REQUIRED: the IANA allowlist is injected (Intl.supportedValuesOf("timeZone"))');
  }
  const q = (text, values) => client.query(text, values);
  const now = config.now || (() => new Date());
  void now;

  return {
    /* ---- the bootstrap (§14.28 clause 1) ------------------------------ */
    /* The migrator path: the caller passes an ADMIN client (the same trust
     * prepare-db.mjs carries — D-029's disclosed first-O-per-tenant seed,
     * now scripted). ONE transaction: origin user + credential (must_change
     * true) + the first tenant through the founder door + nothing else. A
     * failed run leaves nothing; a completed run re-refuses — a second run
     * that "succeeds" would be a silent no-op hiding a forgotten
     * credential. NOT idempotent BY DESIGN. */
    async bootstrapOrigin({ email, displayName, password, tenant }) {
      const user = await validateOrThrow(SETUP.validateUserCommand, { email, displayName, password, role: 'O' });
      const t = await validateOrThrow(SETUP.validateTenantCommand, tenant, { tzList: config.tzList });
      await q('BEGIN');
      try {
        const dupeUser = await q(`SELECT id FROM app_user WHERE email = $1`, [user.email]);
        if (dupeUser.rows.length > 0) refuse('SETUP_ORIGIN_EXISTS', 'an account with that email already exists — the bootstrap never rotates an existing account');
        const dupeTenant = await q(`SELECT id FROM tenant WHERE code = $1`, [t.code]);
        if (dupeTenant.rows.length > 0) refuse('SETUP_TENANT_CODE_TAKEN', 'a tenant with that code already exists');
        const u = await q(
          `INSERT INTO app_user (email, display_name, is_origin) VALUES ($1, $2, $3) RETURNING id`,
          [user.email, user.displayName, true]);
        const originUserId = u.rows[0].id;
        await config.auth.registerCredential({ userId: originUserId, password: user.password, mustChange: true });
        const tenantId = await q(
          `SELECT setup_create_tenant_with_founder($1, $2, $3, $4, $5) AS "tenantId"`,
          [t.code, t.name, t.currencyCode, t.timezone, originUserId]);
        await q('COMMIT');
        return { originUserId, tenantId: tenantId.rows[0].tenantId, tenantCode: t.code };
      } catch (e) {
        await q('ROLLBACK').catch(() => {});
        throw translateSetupError(e);
      }
    },

    /* ---- the founder door call (§14.28 clause 3) ----------------------- */
    /* The SESSION path: the acting Origin creates a tenant through the
     * SECURITY DEFINER door — ONE atomic statement (tenant + its founder O
     * grant), the door's internal is_origin check the real gate. The
     * caller's GUCs do not gate the door (it bypasses RLS by design); the
     * Class-N emission around it is the route's fence's business. */
    async createTenant({ code, name, currencyCode, timezone, actorId }) {
      const t = await validateOrThrow(SETUP.validateTenantCommand, { code, name, currencyCode, timezone }, { tzList: config.tzList });
      try {
        const r = await q(
          `SELECT setup_create_tenant_with_founder($1, $2, $3, $4, $5) AS "tenantId"`,
          [t.code, t.name, t.currencyCode, t.timezone, actorId]);
        return { tenantId: r.rows[0].tenantId, tenantCode: t.code };
      } catch (e) {
        throw translateSetupError(e);
      }
    },

    /* ---- accounts, roles (§14.28 clause 4) ----------------------------- */
    /* Create the account + its credential (must_change true — every
     * setup-created account changes its own password at first sign-in) +
     * the tenant_role grant in ONE transaction. The grant's GUCs are set
     * INSIDE the transaction (transaction-local, never session scope):
     * controls_origin_only re-proves the acting Origin's O at the row
     * level — the API's Origin gate is never the only gate. */
    async createUserWithRole({ email, displayName, password, role, tenantCode, actorId }) {
      const user = await validateOrThrow(SETUP.validateUserCommand, { email, displayName, password, role });
      if (typeof tenantCode !== 'string' || tenantCode.trim() === '') {
        refuse('SETUP_SHAPE_INVALID', 'tenantCode is required — the grant lands in a named tenant');
      }
      await q('BEGIN');
      try {
        const t = await q(`SELECT id, code FROM tenant WHERE code = $1`, [tenantCode.trim()]);
        if (t.rows.length === 0) refuse('SETUP_TENANT_UNKNOWN', `no tenant with code ${JSON.stringify(tenantCode)}`);
        const tenant = t.rows[0];
        const dupe = await q(`SELECT id FROM app_user WHERE email = $1`, [user.email]);
        if (dupe.rows.length > 0) refuse('SETUP_EMAIL_TAKEN', 'a user with that email already exists');
        await q(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);
        await q(`SELECT set_config('app.actor_id', $1, true)`, [actorId]);
        const u = await q(
          `INSERT INTO app_user (email, display_name, is_origin) VALUES ($1, $2, FALSE) RETURNING id`,
          [user.email, user.displayName]);
        const userId = u.rows[0].id;
        await config.auth.registerCredential({ userId, password: user.password, mustChange: true });
        try {
          await q(
            `INSERT INTO tenant_role (tenant_id, user_id, role, granted_by) VALUES ($1, $2, $3, $4)`,
            [tenant.id, userId, user.role, actorId]);
        } catch (e) {
          if (e && e.code === '42501') throw translateSetupError(e);
          throw e;
        }
        await q('COMMIT');
        return { userId, tenantId: tenant.id, tenantCode: tenant.code, role: user.role };
      } catch (e) {
        await q('ROLLBACK').catch(() => {});
        throw translateSetupError(e);
      }
    },

    /* ---- the §16 amendment (approval config + limits) ------------------ */
    /* The dual-control threshold and the per-role ceilings — the §16
     * tenant-amendable parameters, done once at setup and amendable in-app
     * thereafter. The existing controls_origin_only policies ride the same
     * GUCs; zero new SQL authority. */
    async amendLimits({ dualThresholdAmount, limits, actorId, tenantId }) {
      const v = await validateOrThrow(SETUP.validateLimitsCommand, { dualThresholdAmount, limits });
      await q('BEGIN');
      try {
        const cur = await q(`SELECT currency_code FROM tenant WHERE id = $1`, [tenantId]);
        if (cur.rows.length === 0) refuse('SETUP_TENANT_UNKNOWN', 'the tenant row is gone from the registry');
        await q(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        await q(`SELECT set_config('app.actor_id', $1, true)`, [actorId]);
        await q(
          `INSERT INTO approval_config (tenant_id, currency_code, dual_threshold_amount, updated_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id) DO UPDATE SET
             currency_code = EXCLUDED.currency_code,
             dual_threshold_amount = EXCLUDED.dual_threshold_amount,
             updated_by = EXCLUDED.updated_by`,
          [tenantId, cur.rows[0].currency_code, v.dualThresholdAmount, actorId]);
        for (const l of v.limits) {
          await q(
            `INSERT INTO approval_limit (tenant_id, role, max_single_amount, updated_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, role) DO UPDATE SET
               max_single_amount = EXCLUDED.max_single_amount,
               updated_by = EXCLUDED.updated_by`,
            [tenantId, l.role, l.maxSingleAmount, actorId]);
        }
        await q('COMMIT');
        return { configUpdated: true, limitsUpdated: v.limits.length };
      } catch (e) {
        await q('ROLLBACK').catch(() => {});
        throw translateSetupError(e);
      }
    },

    /* ---- the overview (§14.28 clause 4; the wizard's state) ------------ */
    /* The registry read crosses tenants BY DESIGN (tenant + app_user carry
     * no RLS — cross-tenant tables, ADR-0002); every RLS'd read sets the
     * tenant GUC per tenant INSIDE one transaction. The caller's own
     * memberships ride the D-050 door (the pre-tenant window — no GUC can
     * exist before the resolution it feeds). */
    async setupOverview({ actorId }) {
      await q('BEGIN');
      try {
        const hasOrigin = await q(`SELECT 1 AS ok FROM app_user WHERE is_origin = TRUE LIMIT 1`);
        const tenants = await q(
          `SELECT id, code, name, currency_code AS "currencyCode", timezone, created_at AS "createdAt"
             FROM tenant ORDER BY created_at ASC, code ASC`);
        const memberships = await q(
          `SELECT out_tenant_id AS "tenantId", out_role AS "role" FROM auth_user_tenants($1)`, [actorId]);
        const myRoleByTenant = new Map(memberships.rows.map((m) => [m.tenantId, m.role]));

        const out = [];
        const distinctUsers = new Set();
        let anyLimits = false;
        for (const t of tenants.rows) {
          await q(`SELECT set_config('app.tenant_id', $1, true)`, [t.id]);
          const users = await q(
            `SELECT u.id, u.email, u.display_name AS "displayName", tr.role, tr.granted_at AS "grantedAt"
               FROM tenant_role tr JOIN app_user u ON u.id = tr.user_id
              WHERE tr.tenant_id = $1 AND tr.revoked_at IS NULL
              ORDER BY tr.granted_at ASC`, [t.id]);
          for (const row of users.rows) distinctUsers.add(row.id);
          const cfg = await q(
            `SELECT currency_code AS "currencyCode", dual_threshold_amount AS "dualThresholdAmount"
               FROM approval_config WHERE tenant_id = $1`, [t.id]);
          const lim = await q(
            `SELECT role, max_single_amount AS "maxSingleAmount"
               FROM approval_limit WHERE tenant_id = $1 ORDER BY role ASC`, [t.id]);
          if (cfg.rows.length > 0) anyLimits = true;
          const ingested = await q(
            `SELECT 1 AS ok FROM ingest_file WHERE tenant_id = $1 AND status = 'APPLIED' LIMIT 1`, [t.id]);
          out.push({
            id: t.id, code: t.code, name: t.name,
            currencyCode: t.currencyCode, timezone: t.timezone,
            myRole: myRoleByTenant.get(t.id) || null,
            users: users.rows.map((r) => ({ id: r.id, email: r.email, displayName: r.displayName, role: r.role, grantedAt: r.grantedAt })),
            hasApprovalLimits: cfg.rows.length > 0,
            approvalConfig: cfg.rows[0] ? { currencyCode: cfg.rows[0].currencyCode, dualThresholdAmount: Number(cfg.rows[0].dualThresholdAmount) } : null,
            approvalLimits: lim.rows.map((r) => ({ role: r.role, maxSingleAmount: r.maxSingleAmount === null ? null : Number(r.maxSingleAmount) })),
            hasFirstIngestion: ingested.rows.length > 0,
          });
        }
        await q('COMMIT');
        return {
          hasOrigin: hasOrigin.rows.length > 0,
          tenantCount: out.length,
          userCount: distinctUsers.size,
          hasApprovalLimits: anyLimits,
          tenants: out,
        };
      } catch (e) {
        await q('ROLLBACK').catch(() => {});
        throw e;
      }
    },
  };
}

module.exports = { makeSetupAdapter };
