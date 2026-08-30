-- ============================================================================
-- Sentinel — 0001_init: M1 data foundation + row-level security (ADR-0001).
--
-- Hand-written alongside prisma/schema.prisma (the typed contract). What SQL
-- adds that Prisma cannot express:
--   * fail-closed RLS on every tenant-scoped table (ENABLE + FORCE + policy)
--   * the sentinel_app role (NOBYPASSRLS) and its grants
--   * the supplier external-id partial unique (H7)
-- packages/db/test/schema.test.js enforces schema↔SQL consistency;
-- packages/db/test/rls-deny-matrix.js proves the policies live (CI: postgres:16).
--
-- Money and quantities are NUMERIC — never float (build spec §8).
-- Idempotency keys lead with tenant_id everywhere (H6).
-- ============================================================================

-- ---- Enums -----------------------------------------------------------------

CREATE TYPE "warehouse_kind" AS ENUM ('COMPANY', '3PL', 'STAGING', 'QUARANTINE', 'CONSIGNMENT', 'VIRTUAL', 'INACTIVE');
CREATE TYPE "delivery_granularity" AS ENUM ('daily', 'weekly', 'monthly', 'quarterly', 'ytd');
CREATE TYPE "planning_param_source" AS ENUM ('manual', 'calculated', 'override');
CREATE TYPE "ingest_file_status" AS ENUM ('RECEIVED', 'QUARANTINED', 'APPLIED', 'FAILED');
CREATE TYPE "data_health_severity" AS ENUM ('INFO', 'WARN', 'CRITICAL');
CREATE TYPE "data_health_status" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- ---- Tenancy ----------------------------------------------------------------

CREATE TABLE "tenant" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "currency_code" CHAR(3) NOT NULL,
  "timezone" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_code_key" ON "tenant"("code");

CREATE TABLE "app_user" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "is_origin" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

CREATE TABLE "ownership_grant" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "category" TEXT,
  "granted_by" UUID NOT NULL,
  "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "revoked_at" TIMESTAMPTZ(6),
  CONSTRAINT "ownership_grant_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ownership_grant_tenant_id_idx" ON "ownership_grant"("tenant_id");

-- ---- Unit catalog (screen 32 tenant data) ------------------------------------

CREATE TABLE "unit_catalog_entry" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "factor" DECIMAL(18,8),
  "is_base" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "unit_catalog_entry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_catalog_entry_tenant_id_code_key" ON "unit_catalog_entry"("tenant_id","code");

CREATE TABLE "unit_alias" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "catalog_entry_id" UUID NOT NULL,
  "alias" TEXT NOT NULL,
  CONSTRAINT "unit_alias_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_alias_tenant_id_alias_key" ON "unit_alias"("tenant_id","alias");

-- ---- Master data --------------------------------------------------------------

CREATE TABLE "supplier" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "external_id" TEXT,
  "name" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "delivery_period_days" INTEGER,
  "moq_value" DECIMAL(18,6),
  "payment_terms_text" TEXT,
  "payment_term_days" INTEGER,
  "currency_code" CHAR(3),
  "country" TEXT,
  "is_banned" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);
-- Interim identity key per ingestion spec §4 ("Supplier Name"); H7 upgrades
-- identity to the Precoro Supplier ID (priority-1) the moment the export
-- carries it — enforced unique per tenant, NULL until then.
CREATE UNIQUE INDEX "supplier_tenant_id_name_key" ON "supplier"("tenant_id","name");
CREATE UNIQUE INDEX "supplier_tenant_id_external_id_key" ON "supplier"("tenant_id","external_id") WHERE "external_id" IS NOT NULL;

CREATE TABLE "item" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "sku" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "unit_code" TEXT NOT NULL,
  "conversion_factor" DECIMAL(18,8),
  "converted_unit" TEXT,
  "category" TEXT,
  "ingredient_family" TEXT,
  "recipe_ref" TEXT,
  "brand" TEXT,
  "size" TEXT,
  "case_count" INTEGER,
  "price" DECIMAL(18,6),
  "currency_code" CHAR(3),
  "business_unit" TEXT,
  "shelf_life_days" INTEGER,
  "preferred_for_recipe_ref" BOOLEAN NOT NULL DEFAULT false,
  "nutrition_approved" BOOLEAN NOT NULL DEFAULT false,
  "production_approved" BOOLEAN NOT NULL DEFAULT false,
  "is_banned" BOOLEAN NOT NULL DEFAULT false,
  "is_inactive" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "item_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "item_tenant_id_sku_key" ON "item"("tenant_id","sku");

CREATE TABLE "warehouse" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "warehouse_kind" NOT NULL,
  "cbm_capacity" DECIMAL(18,6),
  "period_cost" DECIMAL(18,6),
  CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "warehouse_tenant_id_code_key" ON "warehouse"("tenant_id","code");

CREATE TABLE "stock_line" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "item_id" UUID NOT NULL,
  "warehouse_id" UUID NOT NULL,
  "quantity" DECIMAL(18,6) NOT NULL,
  "unit_code" TEXT NOT NULL,
  "value_document" DECIMAL(18,6) NOT NULL,
  "document_currency" CHAR(3) NOT NULL,
  "tenant_value" DECIMAL(18,6) NOT NULL,
  CONSTRAINT "stock_line_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "stock_line_tenant_id_item_id_warehouse_id_key" ON "stock_line"("tenant_id","item_id","warehouse_id");

-- ---- Operational feeds ----------------------------------------------------------

CREATE TABLE "open_po_line" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "po_number" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "item_id" UUID,
  "supplier_id" UUID,
  "ordered_qty" DECIMAL(18,6) NOT NULL,
  "received_qty" DECIMAL(18,6) NOT NULL,
  "waiting_qty" DECIMAL(18,6) NOT NULL,
  "waiting_qty_converted" DECIMAL(18,6),
  "unit_code" TEXT NOT NULL,
  "unit_price" DECIMAL(18,6) NOT NULL,
  "currency_code" CHAR(3) NOT NULL,
  "tenant_unit_price" DECIMAL(18,6) NOT NULL,
  "expected_delivery" DATE,
  "receipt_dates" TEXT,
  "po_created_at" DATE,
  CONSTRAINT "open_po_line_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "open_po_line_tenant_id_po_number_sku_key" ON "open_po_line"("tenant_id","po_number","sku");
CREATE INDEX "open_po_line_tenant_id_expected_delivery_idx" ON "open_po_line"("tenant_id","expected_delivery");

CREATE TABLE "consumption_balance" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "sku" TEXT NOT NULL,
  "period_start" DATE NOT NULL,
  "period_end" DATE NOT NULL,
  "start_balance" DECIMAL(18,6) NOT NULL,
  "goods_in" DECIMAL(18,6) NOT NULL,
  "goods_out" DECIMAL(18,6) NOT NULL,
  "stock_changes" DECIMAL(18,6) NOT NULL,
  "end_balance" DECIMAL(18,6) NOT NULL,
  CONSTRAINT "consumption_balance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "consumption_balance_tenant_sku_period_key" ON "consumption_balance"("tenant_id","sku","period_start","period_end");

CREATE TABLE "delivery_day" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  "granularity" "delivery_granularity" NOT NULL,
  "deliveries" DECIMAL(18,6) NOT NULL,
  "months_elapsed" INTEGER,
  "business_unit" TEXT,
  CONSTRAINT "delivery_day_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "delivery_day_tenant_id_day_key" ON "delivery_day"("tenant_id","day");

CREATE TABLE "planning_param" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "recipe_ref" TEXT NOT NULL,
  "params" JSONB NOT NULL,
  "source" "planning_param_source" NOT NULL,
  CONSTRAINT "planning_param_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "planning_param_tenant_id_recipe_ref_key" ON "planning_param"("tenant_id","recipe_ref");

CREATE TABLE "category_owner" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "category" TEXT NOT NULL,
  "owner_email" TEXT,
  "user_id" UUID,
  CONSTRAINT "category_owner_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "category_owner_tenant_id_category_key" ON "category_owner"("tenant_id","category");

-- ---- Ingestion control plane ------------------------------------------------------

CREATE TABLE "ingest_file" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "checksum_sha256" TEXT NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "status" "ingest_file_status" NOT NULL DEFAULT 'RECEIVED',
  "row_count" INTEGER,
  "quarantined_count" INTEGER,
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "applied_at" TIMESTAMPTZ(6),
  CONSTRAINT "ingest_file_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ingest_file_tenant_kind_checksum_key" ON "ingest_file"("tenant_id","kind","checksum_sha256");

CREATE TABLE "quarantine_record" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "ingest_file_id" UUID,
  "kind" TEXT NOT NULL,
  "row_index" INTEGER,
  "field" TEXT,
  "raw_value" TEXT,
  "reason_code" TEXT NOT NULL,
  "detail" TEXT,
  "as_of" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "quarantine_record_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "quarantine_record_tenant_id_reason_code_idx" ON "quarantine_record"("tenant_id","reason_code");

CREATE TABLE "data_health_task" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "task_type" TEXT NOT NULL,
  "severity" "data_health_severity" NOT NULL DEFAULT 'WARN',
  "status" "data_health_status" NOT NULL DEFAULT 'OPEN',
  "payload" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "data_health_task_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "data_health_task_tenant_id_status_idx" ON "data_health_task"("tenant_id","status");

-- H6: the idempotency key IS tenant-scoped by construction — the UNIQUE
-- constraint leads with tenant_id, so the same key for two tenants never
-- collides and a replay within one tenant hits exactly this index.
CREATE TABLE "idempotency_key" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "idem_key" TEXT NOT NULL,
  "file_checksum" TEXT,
  "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "idempotency_key_tenant_kind_key_key" ON "idempotency_key"("tenant_id","kind","idem_key");

-- C2 / Decision 7: the pinned per-tenant-day USD→local rate. The pinning
-- service and its FX ADR land with the M4 FX fail-safe (M10).
CREATE TABLE "fx_rate_pin" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  "usd_to_local" DECIMAL(18,8) NOT NULL,
  "pinned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "pinned_by" TEXT,
  CONSTRAINT "fx_rate_pin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "fx_rate_pin_tenant_id_day_key" ON "fx_rate_pin"("tenant_id","day");

-- ---- Foreign keys -----------------------------------------------------------------

ALTER TABLE "ownership_grant" ADD CONSTRAINT "ownership_grant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ownership_grant" ADD CONSTRAINT "ownership_grant_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_catalog_entry" ADD CONSTRAINT "unit_catalog_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_alias" ADD CONSTRAINT "unit_alias_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_alias" ADD CONSTRAINT "unit_alias_catalog_entry_id_fkey" FOREIGN KEY ("catalog_entry_id") REFERENCES "unit_catalog_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "item" ADD CONSTRAINT "item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_line" ADD CONSTRAINT "stock_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_line" ADD CONSTRAINT "stock_line_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_line" ADD CONSTRAINT "stock_line_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "open_po_line" ADD CONSTRAINT "open_po_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "open_po_line" ADD CONSTRAINT "open_po_line_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "open_po_line" ADD CONSTRAINT "open_po_line_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "consumption_balance" ADD CONSTRAINT "consumption_balance_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_day" ADD CONSTRAINT "delivery_day_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_param" ADD CONSTRAINT "planning_param_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "category_owner" ADD CONSTRAINT "category_owner_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "category_owner" ADD CONSTRAINT "category_owner_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ingest_file" ADD CONSTRAINT "ingest_file_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quarantine_record" ADD CONSTRAINT "quarantine_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quarantine_record" ADD CONSTRAINT "quarantine_record_ingest_file_id_fkey" FOREIGN KEY ("ingest_file_id") REFERENCES "ingest_file"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "data_health_task" ADD CONSTRAINT "data_health_task_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fx_rate_pin" ADD CONSTRAINT "fx_rate_pin_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---- Application role ---------------------------------------------------------------

-- The app NEVER connects as superuser or owner. RLS does not bind superusers
-- and BYPASSRLS roles, so the role is created NOBYPASSRLS and the tables are
-- FORCEd (owner subject too). Migration/seed windows connect as the owner and
-- set app.tenant_id explicitly per tenant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sentinel_app') THEN
    CREATE ROLE "sentinel_app" NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "sentinel_app";

-- ---- Row-level security (ADR-0001) -----------------------------------------------------
-- Fail-closed tenant isolation on every tenant-scoped table:
--   * current_setting('app.tenant_id', true) → NULL when the GUC is unset
--     → comparison is NULL → zero rows on read, rejection on write.
--   * a non-UUID GUC value fails the ::uuid cast → statement errors out.
--   * FORCE binds the table owner as well; only superusers/BYPASSRLS bypass,
--     and the app role is neither.
-- Every tenant-scoped table carries tenant_id NOT NULL and appears below.
-- The deny-matrix test proves each row of this contract against a live server.

ALTER TABLE "ownership_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ownership_grant" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ownership_grant" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "unit_catalog_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_catalog_entry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "unit_catalog_entry" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "unit_alias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_alias" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "unit_alias" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "supplier" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "item" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "warehouse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "warehouse" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "warehouse" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "stock_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stock_line" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "open_po_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "open_po_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "open_po_line" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "consumption_balance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consumption_balance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "consumption_balance" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "delivery_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_day" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "delivery_day" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "planning_param" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "planning_param" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "planning_param" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "category_owner" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "category_owner" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "category_owner" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "ingest_file" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingest_file" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ingest_file" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "quarantine_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quarantine_record" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "quarantine_record" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "data_health_task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_health_task" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "data_health_task" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "idempotency_key" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_key" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "idempotency_key" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "fx_rate_pin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fx_rate_pin" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "fx_rate_pin" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
