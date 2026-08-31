-- =============================================================================
-- 0007_cf_governance — conversion-factor governance (M7, §14.13b; audit M7)
--
-- The audit's M7 finding: CF multiplies consumption, PO conversion (C1) and
-- order sizing; nothing gated a CF edit, versioned it, or handled in-flight
-- rows sized under the old factor. The contract is §14.13b; this migration is
-- the database half of the pair (the pure core is approval/cf.js — neither is
-- trusted alone, the API+DB pair A4 demands):
--
--   item_cf_version — the versioned change ledger. One row per proposed
--     factor change, monotonic version per (tenant, sku), from/to preserved,
--     state PENDING → EFFECTIVE | REJECTED. requested_by NULL = staged by the
--     pipeline (ingestion-originated) and may be decided by any eligible
--     principal; a user-requested version can never be decided by its
--     requester (the SoD spine the approval module enforces twice).
--
--   item_cf_freeze — the fail-closed backstop: ANY conversion_factor delta on
--     item is refused unless app.cf_apply_id names a PENDING version row for
--     exactly this tenant + sku whose to_value EQUALS the new factor (the
--     exact-target discipline of supplier_identity_freeze's delta match).
--     There is no bypass, only the door. The ungoverned path raises
--     CF_CHANGE_UNGOVERNED; a GUC without a matching PENDING version raises
--     CF_VERSION_MISMATCH. The stored factor keeps serving until the door
--     opens — planning is never hostage to an unreviewed master edit.
-- =============================================================================

CREATE TYPE "cf_version_state" AS ENUM ('PENDING', 'EFFECTIVE', 'REJECTED');

-- ---- The version ledger -----------------------------------------------------
CREATE TABLE "item_cf_version" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "sku" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "from_value" DECIMAL(18,8),
  "to_value" DECIMAL(18,8) NOT NULL,
  "state" "cf_version_state" NOT NULL DEFAULT 'PENDING',
  "requested_by" UUID,
  "requested_reason" TEXT,
  "decided_by" UUID,
  "decision_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "decided_at" TIMESTAMPTZ(6),

  CONSTRAINT "item_cf_version_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "item_cf_version_tenant_sku_version_key"
  ON "item_cf_version" ("tenant_id", "sku", "version");
CREATE INDEX "item_cf_version_tenant_sku_state_idx"
  ON "item_cf_version" ("tenant_id", "sku", "state");
-- The door's lookup: id + state (FOR UPDATE inside the applying transaction).
CREATE INDEX "item_cf_version_state_idx" ON "item_cf_version" ("state");

ALTER TABLE "item_cf_version" ADD CONSTRAINT "item_cf_version_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "item_cf_version" ADD CONSTRAINT "item_cf_version_requested_by_fkey"
  FOREIGN KEY ("requested_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "item_cf_version" ADD CONSTRAINT "item_cf_version_decided_by_fkey"
  FOREIGN KEY ("decided_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "item_cf_version" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_cf_version" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "item_cf_version" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "item_cf_version" TO "sentinel_app";

-- ---- The fail-closed backstop ------------------------------------------------
-- Mirrors supplier_identity_freeze: a factor delta without the door open is
-- refused outright; a door open on the WRONG version (tenant/sku/target) is
-- refused too — the apply path cannot smuggle a different value in.
CREATE OR REPLACE FUNCTION "item_cf_freeze"() RETURNS trigger AS $$
DECLARE
  apply_id TEXT;
  matched INTEGER;
BEGIN
  IF NEW.conversion_factor IS DISTINCT FROM OLD.conversion_factor THEN
    apply_id := current_setting('app.cf_apply_id', true);
    IF apply_id IS NULL OR apply_id = '' THEN
      RAISE EXCEPTION 'CF_CHANGE_UNGOVERNED';
    END IF;
    SELECT COUNT(*) INTO matched FROM item_cf_version v
      WHERE v.id = apply_id::uuid
        AND v.tenant_id = NEW.tenant_id
        AND v.sku = NEW.sku
        AND v.state = 'PENDING'
        AND v.to_value = NEW.conversion_factor;
    IF matched = 0 THEN
      RAISE EXCEPTION 'CF_VERSION_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "item_cf_freeze_trigger"
  BEFORE UPDATE ON "item"
  FOR EACH ROW EXECUTE FUNCTION "item_cf_freeze"();
