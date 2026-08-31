-- ============================================================================
-- Sentinel — 0003_controls: the C3 financial-controls layer (gate 5, M3).
--
-- What lands here (delivery spec A4 / audit C3 / build spec §15.2 P0-1):
--   1. Roles as regional data: tenant_role (user × tenant → one active role,
--      §10's six codes). Grant/revoke authority = Origin only, enforced at
--      RLS (a restrictive policy reads the actor's own role back).
--   2. Value-tiered approval: approval_config (the per-tenant dual-control
--      threshold, Origin-amendable) + approval_limit (per-role single-approval
--      ceiling; NULL = unlimited). Defaults are seed data, never code.
--   3. The proposal → approval → PO workflow: proposal (lifecycle
--      OPEN → APPROVED → CONVERTED → DISMISSED, design-spec screen 5),
--      proposal_line, the append-only approval decision rows, and the
--      purchase_order / po_line documents Sentinel issues (no Precoro
--      write-back anywhere).
--   4. The SoD invariant: approver ≠ raiser, enforced at the API (the pure
--      decision module) AND at the database — a RESTRICTIVE RLS policy on
--      approval binds every decision to the authenticated actor GUC
--      (app.actor_id), refuses self-approval via a proposal subquery, and
--      refuses ineligible approvers. A state-guard trigger is the backstop:
--      OPEN → APPROVED requires the tier's vote count from distinct,
--      eligible, within-limit approvers; REJECTED dismisses.
--   5. The supplier-identity change freeze: any UPDATE of a supplier's
--      identity/remittance fields (external_id, name, payment_term_days,
--      payment_terms_text, currency_code — banking fields are discarded at
--      ingestion, so this is the Sentinel-visible surface) is refused outright
--      unless it executes under a COOLING_OFF supplier_change_hold whose
--      stored delta matches exactly (out-of-band verification happened).
--
-- GUC contract (the ADR-0002 fence, extended — fail-closed by the same
-- construction):
--   app.tenant_id     — the tenant scope (unchanged).
--   app.actor_id      — the authenticated principal (UUID). Unset → NULL →
--                       restrictive checks fail (denied). Set-then-reset → ''
--                       → the ::uuid cast errors (22P02) → loud deny.
--   app.hold_apply_id — set (transaction-local) ONLY by the verified
--                       hold-apply path; the supplier trigger refuses any
--                       identity-bearing supplier change without it.
-- The LIVE proof of all of it is test/sod-live.js (CI db-rls job).
-- ============================================================================

CREATE TYPE "user_role" AS ENUM ('O', 'SCM', 'SBR', 'BYR', 'DTA', 'VWR');
CREATE TYPE "proposal_state" AS ENUM ('OPEN', 'APPROVED', 'CONVERTED', 'DISMISSED');
CREATE TYPE "approval_decision" AS ENUM ('APPROVED', 'REJECTED');
CREATE TYPE "supplier_hold_state" AS ENUM ('COOLING_OFF', 'APPLIED', 'REJECTED');

-- ---- 1. Roles are regional data (build spec §10) ---------------------------
-- One active role per (tenant, user); history is append-only (revoked_at).
-- The first Origin per tenant is seeded by the migrator path (superuser
-- bootstrap — the same path seed.sql uses; disclosed in D-029).
CREATE TABLE "tenant_role" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "user_role" NOT NULL,
  "granted_by" UUID NOT NULL,
  "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "revoked_at" TIMESTAMPTZ(6),
  CONSTRAINT "tenant_role_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_role_tenant_user_active_key" ON "tenant_role"("tenant_id","user_id") WHERE "revoked_at" IS NULL;
CREATE INDEX "tenant_role_user_id_idx" ON "tenant_role"("user_id");

-- ---- 2. The value tiers (C3): Origin-amendable, per tenant -----------------
CREATE TABLE "approval_config" (
  "tenant_id" UUID NOT NULL,
  "currency_code" CHAR(3) NOT NULL,
  "dual_threshold_amount" DECIMAL(18,6) NOT NULL CHECK ("dual_threshold_amount" >= 0),
  "updated_by" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "approval_config_pkey" PRIMARY KEY ("tenant_id")
);

-- max_single_amount NULL = the role has no ceiling (Origin). Defaults are
-- seed data (seed.sql), never hardcoded control values in code.
CREATE TABLE "approval_limit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "role" "user_role" NOT NULL,
  "max_single_amount" DECIMAL(18,6) CHECK ("max_single_amount" IS NULL OR "max_single_amount" >= 0),
  "updated_by" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "approval_limit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "approval_limit_tenant_role_key" UNIQUE ("tenant_id","role")
);

-- ---- 3. The workflow: proposal → approval → PO -----------------------------
-- OrderProposal(lifecycle) — design-spec screen 5; raised_by is the SoD
-- raiser. The raiser is any authenticated member; the INVARIANT is that
-- approval differs (audit C3: "the approving principal must differ from the
-- raising principal").
CREATE TABLE "proposal" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "state" "proposal_state" NOT NULL DEFAULT 'OPEN',
  "raised_by" UUID NOT NULL,
  "supplier_id" UUID,
  "currency_code" CHAR(3) NOT NULL,
  "total_amount" DECIMAL(18,6) NOT NULL CHECK ("total_amount" > 0),
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "proposal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "proposal_tenant_code_key" ON "proposal"("tenant_id","code");
CREATE INDEX "proposal_tenant_state_idx" ON "proposal"("tenant_id","state");

CREATE TABLE "proposal_line" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "proposal_id" UUID NOT NULL,
  "item_id" UUID,
  "sku" TEXT NOT NULL,
  "qty" DECIMAL(18,6) NOT NULL CHECK ("qty" > 0),
  "unit_code" TEXT NOT NULL,
  "unit_price" DECIMAL(18,6) NOT NULL CHECK ("unit_price" >= 0),
  CONSTRAINT "proposal_line_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "proposal_line_proposal_id_idx" ON "proposal_line"("proposal_id");

-- Append-only decision rows. UNIQUE (proposal, approver) is dual-control's
-- distinctness at the structural level: one decision per approver, ever.
-- reason is NOT NULL — §16.2: a reason is required for denials (and a
-- denial-shaped record travels with every refusal; the ledger write that
-- makes it durable is H5, the very next M3 unit — disclosed in D-029).
CREATE TABLE "approval" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "proposal_id" UUID NOT NULL,
  "approver_id" UUID NOT NULL,
  "decision" "approval_decision" NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "approval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "approval_proposal_approver_key" UNIQUE ("proposal_id","approver_id")
);

-- The PO Sentinel issues on conversion — a document of record only; there is
-- no write-back to Precoro anywhere (design-spec screen 5).
CREATE TABLE "purchase_order" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "proposal_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "currency_code" CHAR(3) NOT NULL,
  "total_amount" DECIMAL(18,6) NOT NULL CHECK ("total_amount" > 0),
  "converted_by" UUID NOT NULL,
  "converted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "purchase_order_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_order_tenant_code_key" ON "purchase_order"("tenant_id","code");
CREATE UNIQUE INDEX "purchase_order_proposal_id_key" ON "purchase_order"("proposal_id");

CREATE TABLE "po_line" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "po_id" UUID NOT NULL,
  "item_id" UUID,
  "sku" TEXT NOT NULL,
  "qty" DECIMAL(18,6) NOT NULL CHECK ("qty" > 0),
  "unit_code" TEXT NOT NULL,
  "unit_price" DECIMAL(18,6) NOT NULL CHECK ("unit_price" >= 0),
  CONSTRAINT "po_line_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "po_line_po_id_idx" ON "po_line"("po_id");

-- ---- 4. The supplier-identity change freeze (C3) ---------------------------
-- changed_fields carries ALL five frozen fields with from/to (null-preserving,
-- JSON scalars as strings) — the trigger compares the applied row against the
-- held delta EXACTLY, so the apply path cannot smuggle an extra change in.
CREATE TABLE "supplier_change_hold" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "changed_fields" JSONB NOT NULL,
  "state" "supplier_hold_state" NOT NULL DEFAULT 'COOLING_OFF',
  "requested_by" UUID,
  "verification_reference" TEXT,
  "verified_by" UUID,
  "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "supplier_change_hold_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "supplier_change_hold_tenant_supplier_idx" ON "supplier_change_hold"("tenant_id","supplier_id","state");

-- ---- Foreign keys -----------------------------------------------------------
ALTER TABLE "tenant_role" ADD CONSTRAINT "tenant_role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_role" ADD CONSTRAINT "tenant_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_role" ADD CONSTRAINT "tenant_role_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_config" ADD CONSTRAINT "approval_config_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_limit" ADD CONSTRAINT "approval_limit_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_raised_by_fkey" FOREIGN KEY ("raised_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proposal_line" ADD CONSTRAINT "proposal_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proposal_line" ADD CONSTRAINT "proposal_line_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval" ADD CONSTRAINT "approval_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval" ADD CONSTRAINT "approval_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval" ADD CONSTRAINT "approval_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_converted_by_fkey" FOREIGN KEY ("converted_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "po_line" ADD CONSTRAINT "po_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "po_line" ADD CONSTRAINT "po_line_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_change_hold" ADD CONSTRAINT "supplier_change_hold_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_change_hold" ADD CONSTRAINT "supplier_change_hold_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_role" TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "approval_config" TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "approval_limit" TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "proposal" TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "proposal_line" TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "approval" TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_order" TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "po_line" TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "supplier_change_hold" TO "sentinel_app";

-- ---- RLS: tenant isolation (the ADR-0002 pattern, every new table) ---------
ALTER TABLE "tenant_role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_role" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_role" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE "approval_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_config" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "approval_config" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE "approval_limit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_limit" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "approval_limit" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE "proposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "proposal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "proposal" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE "proposal_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "proposal_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "proposal_line" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE "approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "approval" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE "purchase_order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "purchase_order" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE "po_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "po_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "po_line" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE "supplier_change_hold" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_change_hold" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "supplier_change_hold" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---- C3 enforcement at the database layer ----------------------------------
-- The SoD invariant is a RESTRICTIVE policy: it ANDs with tenant_isolation, so
-- no permissive policy can grant around it. Unqualified columns in policy
-- expressions resolve to the target row; the target table is qualified
-- explicitly everywhere to avoid the inner-scope shadowing trap.

-- approval: the decision is bound to the authenticated actor (identity
-- forging is dead — you can only ever cast YOUR OWN approval), the actor
-- cannot be the raiser (approver ≠ raiser, the A4 invariant), and the actor
-- holds an approval-eligible role (§10: O/SCM/SBR — BYR/DTA/VWR never).
CREATE POLICY "sod_binding" ON "approval" AS RESTRICTIVE FOR INSERT TO PUBLIC
  WITH CHECK (
    approval.approver_id = current_setting('app.actor_id', true)::uuid
    AND approval.approver_id <> (SELECT p.raised_by FROM proposal p WHERE p.id = approval.proposal_id)
    AND EXISTS (
      SELECT 1 FROM tenant_role tr
      WHERE tr.tenant_id = approval.tenant_id
        AND tr.user_id = approval.approver_id
        AND tr.revoked_at IS NULL
        AND tr.role IN ('O', 'SCM', 'SBR')
    )
  );

-- approval is append-only: a decision cannot be edited or retracted — H5's
-- no-mutation posture arrives at the ledger, but the decision rows themselves
-- never needed it to be honest.
CREATE POLICY "approval_append_only" ON "approval" AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (false);
CREATE POLICY "approval_no_delete" ON "approval" AS RESTRICTIVE FOR DELETE TO PUBLIC USING (false);

-- Role grants, tier config and limits are Origin's to change (§10: "Create
-- users / edit permissions" — O only). The restrictive policy reads the
-- actor's own active role back from tenant_role. Bootstrap: the first O per
-- tenant is seeded by the migrator path (disclosed in D-029).
CREATE POLICY "controls_origin_only" ON "tenant_role" AS RESTRICTIVE FOR INSERT TO PUBLIC
  WITH CHECK (
    tenant_role.granted_by = current_setting('app.actor_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM tenant_role actor
      WHERE actor.tenant_id = tenant_role.tenant_id
        AND actor.user_id = current_setting('app.actor_id', true)::uuid
        AND actor.revoked_at IS NULL
        AND actor.role = 'O'
    )
  );
CREATE POLICY "controls_origin_only_update" ON "tenant_role" AS RESTRICTIVE FOR UPDATE TO PUBLIC
  USING (
    EXISTS (
      SELECT 1 FROM tenant_role actor
      WHERE actor.tenant_id = tenant_role.tenant_id
        AND actor.user_id = current_setting('app.actor_id', true)::uuid
        AND actor.revoked_at IS NULL
        AND actor.role = 'O'
    )
  );
CREATE POLICY "tenant_role_no_delete" ON "tenant_role" AS RESTRICTIVE FOR DELETE TO PUBLIC USING (false);

CREATE POLICY "controls_origin_only" ON "approval_config" AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (
    EXISTS (
      SELECT 1 FROM tenant_role actor
      WHERE actor.tenant_id = approval_config.tenant_id
        AND actor.user_id = current_setting('app.actor_id', true)::uuid
        AND actor.revoked_at IS NULL
        AND actor.role = 'O'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM tenant_role actor
      WHERE actor.tenant_id = approval_config.tenant_id
        AND actor.user_id = current_setting('app.actor_id', true)::uuid
        AND actor.revoked_at IS NULL
        AND actor.role = 'O'
    )
  );
CREATE POLICY "controls_origin_only" ON "approval_limit" AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (
    EXISTS (
      SELECT 1 FROM tenant_role actor
      WHERE actor.tenant_id = approval_limit.tenant_id
        AND actor.user_id = current_setting('app.actor_id', true)::uuid
        AND actor.revoked_at IS NULL
        AND actor.role = 'O'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM tenant_role actor
      WHERE actor.tenant_id = approval_limit.tenant_id
        AND actor.user_id = current_setting('app.actor_id', true)::uuid
        AND actor.revoked_at IS NULL
        AND actor.role = 'O'
    )
  );

-- ---- The proposal state guard (the DB-level dual-control backstop) ---------
-- The decision layer decides; this trigger makes a wrong state change
-- IMPOSSIBLE even for a buggy caller or a manual statement: OPEN → APPROVED
-- requires the tier's vote count (1 at-or-below the dual threshold, 2 above —
-- "above threshold demands dual control") from distinct (UNIQUE
-- proposal+approver), eligible, within-limit, non-raiser approvers; the
-- proposal total must equal its lines and carry the tenant currency at that
-- moment. A REJECTED decision dismisses (terminal — a rejected proposal is
-- re-raised as a new proposal, never revived).
CREATE OR REPLACE FUNCTION "proposal_state_guard"() RETURNS trigger AS $$
DECLARE
  cfg DECIMAL(18,6);
  need INTEGER;
  have INTEGER;
  line_total DECIMAL(18,6);
  tenant_currency CHAR(3);
  vote RECORD;
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'OPEN' AND NEW.state = 'DISMISSED' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'APPROVED' AND NEW.state = 'CONVERTED' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'OPEN' AND NEW.state = 'APPROVED' THEN
    SELECT currency_code INTO tenant_currency FROM tenant WHERE tenant.id = NEW.tenant_id;
    IF tenant_currency IS NULL OR NEW.currency_code <> tenant_currency THEN
      RAISE EXCEPTION 'CURRENCY_NOT_TENANT_CURRENCY';
    END IF;
    SELECT COALESCE(SUM(l.qty * l.unit_price), 0) INTO line_total FROM proposal_line l WHERE l.proposal_id = NEW.id;
    IF line_total <> NEW.total_amount THEN
      RAISE EXCEPTION 'PROPOSAL_TOTAL_MISMATCH';
    END IF;
    SELECT dual_threshold_amount INTO cfg FROM approval_config WHERE approval_config.tenant_id = NEW.tenant_id;
    IF cfg IS NULL THEN
      RAISE EXCEPTION 'APPROVAL_CONFIG_MISSING';
    END IF;
    need := CASE WHEN NEW.total_amount > cfg THEN 2 ELSE 1 END;
    have := 0;
    FOR vote IN
      SELECT a.approver_id, tr.role AS role, al.max_single_amount AS max_single
      FROM approval a
      JOIN tenant_role tr ON tr.tenant_id = a.tenant_id AND tr.user_id = a.approver_id AND tr.revoked_at IS NULL
      LEFT JOIN approval_limit al ON al.tenant_id = a.tenant_id AND al.role = tr.role
      WHERE a.proposal_id = NEW.id AND a.decision = 'APPROVED'
    LOOP
      IF vote.approver_id = NEW.raised_by THEN
        RAISE EXCEPTION 'SOD_SELF_APPROVAL';
      END IF;
      IF vote.role NOT IN ('O', 'SCM', 'SBR') THEN
        RAISE EXCEPTION 'APPROVER_NOT_ELIGIBLE';
      END IF;
      IF vote.max_single IS NOT NULL AND NEW.total_amount > vote.max_single THEN
        RAISE EXCEPTION 'APPROVAL_LIMIT_EXCEEDED';
      END IF;
      have := have + 1;
    END LOOP;
    IF have < need THEN
      RAISE EXCEPTION 'DUAL_CONTROL_NOT_SATISFIED';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'INVALID_PROPOSAL_TRANSITION';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "proposal_state_guard_trigger"
  BEFORE UPDATE ON "proposal"
  FOR EACH ROW EXECUTE FUNCTION "proposal_state_guard"();

-- A REJECTED decision dismisses the proposal in the same statement — no
-- caller can leave a rejected vote on an OPEN proposal.
CREATE OR REPLACE FUNCTION "approval_reject_dismisses"() RETURNS trigger AS $$
BEGIN
  IF NEW.decision = 'REJECTED' THEN
    UPDATE proposal SET state = 'DISMISSED', updated_at = now() WHERE proposal.id = NEW.proposal_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "approval_reject_dismisses_trigger"
  AFTER INSERT ON "approval"
  FOR EACH ROW EXECUTE FUNCTION "approval_reject_dismisses"();

-- ---- The supplier-identity change freeze ------------------------------------
-- A direct identity/remittance change is refused outright (fail-closed). The
-- ONLY path through is the verified hold: app.hold_apply_id set
-- transaction-locally by applyVerifiedHold, the hold COOLING_OFF on this
-- supplier, and the new row carrying EXACTLY the held delta. The old identity
-- keeps serving until that moment — the cooling-off the audit asked for.
CREATE OR REPLACE FUNCTION "supplier_identity_freeze"() RETURNS trigger AS $$
DECLARE
  hold_id TEXT;
  hold_delta JSONB;
BEGIN
  IF NEW.external_id IS DISTINCT FROM OLD.external_id
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.payment_term_days IS DISTINCT FROM OLD.payment_term_days
     OR NEW.payment_terms_text IS DISTINCT FROM OLD.payment_terms_text
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code THEN
    hold_id := current_setting('app.hold_apply_id', true);
    IF hold_id IS NULL OR hold_id = '' THEN
      RAISE EXCEPTION 'SUPPLIER_IDENTITY_FROZEN';
    END IF;
    SELECT h.changed_fields INTO hold_delta FROM supplier_change_hold h
      WHERE h.id = hold_id::uuid
        AND h.tenant_id = NEW.tenant_id
        AND h.supplier_id = NEW.id
        AND h.state = 'COOLING_OFF';
    IF hold_delta IS NULL THEN
      RAISE EXCEPTION 'SUPPLIER_HOLD_MISMATCH';
    END IF;
    IF (NEW.external_id IS DISTINCT FROM (hold_delta->'external_id'->>'to'))
       OR (NEW.name IS DISTINCT FROM (hold_delta->'name'->>'to'))
       OR (NEW.payment_term_days::TEXT IS DISTINCT FROM (hold_delta->'payment_term_days'->>'to'))
       OR (NEW.payment_terms_text IS DISTINCT FROM (hold_delta->'payment_terms_text'->>'to'))
       OR (NEW.currency_code::TEXT IS DISTINCT FROM (hold_delta->'currency_code'->>'to')) THEN
      RAISE EXCEPTION 'SUPPLIER_HOLD_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "supplier_identity_freeze_trigger"
  BEFORE UPDATE ON "supplier"
  FOR EACH ROW EXECUTE FUNCTION "supplier_identity_freeze"();
