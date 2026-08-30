-- ============================================================================
-- Sentinel — 0002_plan_seal: the engine-live sealed snapshot (M2 unit 3).
--
-- The daily seal (build spec §11): at day close / recompute, a snapshot per
-- tenant stores the full computed state + payload hash. This table is the
-- M2 slice of that contract: one seal per tenant per seal_date.
--
--   * UNIQUE (tenant_id, seal_date) — H6 in spirit: the same tenant-day never
--     collides across tenants, and a replay within the tenant hits exactly
--     this index. Restatement semantics (M8) own any future re-seal of an
--     already-sealed day; until then the seal is immutable and a divergent
--     replay is DISCLOSED, never silently applied.
--   * payload JSONB — the full computed state (refs, portfolio, dataState,
--     basis, disclosures). payload_hash = SHA256 over the canonical JSON of
--     the payload (canonicalJson in plan-service; RFC 8785 JCS arrives with
--     the H5 ledger in M3 and is expected to reproduce these hashes).
--   * engine_version + schema_version — the L-07 stamps (delivery spec §6.2):
--     any behavior question resolves to an exact code+schema state.
--   * Fail-closed RLS per ADR-0002, same as every tenant-scoped table.
-- ============================================================================

CREATE TABLE "plan_seal" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "seal_date" DATE NOT NULL,
  "engine_version" TEXT NOT NULL,
  "schema_version" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "sealed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "sealed_by" TEXT,
  CONSTRAINT "plan_seal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "plan_seal_tenant_id_seal_date_key" ON "plan_seal"("tenant_id","seal_date");

ALTER TABLE "plan_seal" ADD CONSTRAINT "plan_seal_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "plan_seal" TO "sentinel_app";

ALTER TABLE "plan_seal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_seal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plan_seal" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
