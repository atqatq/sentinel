-- ============================================================================
-- Sentinel — synthetic seed for local development and the reference stack.
-- NO real business data, ever (D-003): tenants, units and rates below are
-- synthetic placeholders. Run as the migration/owner role.
-- Idempotent: ON CONFLICT DO NOTHING throughout.
-- ============================================================================

-- Tenant alpha (synthetic) ----------------------------------------------------
INSERT INTO tenant (id, code, name, currency_code, timezone)
VALUES ('11111111-1111-4111-8111-111111111111', 'tenant-alpha', 'Tenant Alpha (synthetic)', 'BHD', 'Asia/Bahrain')
ON CONFLICT (code) DO NOTHING;

BEGIN;
SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true);

INSERT INTO unit_catalog_entry (tenant_id, code, name, factor, is_base) VALUES
  ('11111111-1111-4111-8111-111111111111', 'PCS', 'Piece',  NULL,  true),
  ('11111111-1111-4111-8111-111111111111', 'CTN', 'Case',   12.0,  false),
  ('11111111-1111-4111-8111-111111111111', 'KG',  'Kilogram', NULL, true),
  ('11111111-1111-4111-8111-111111111111', 'BTL', 'Bottle', 1.0,   false)
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO unit_alias (tenant_id, catalog_entry_id, alias)
SELECT '11111111-1111-4111-8111-111111111111', e.id, a.alias
FROM (VALUES ('PIECES','PCS'), ('PIECE','PCS'), ('CASES','CTN'), ('BOTTLES','BTL'), ('KILOGRAMS','KG')) AS a(alias, code)
JOIN unit_catalog_entry e ON e.tenant_id = '11111111-1111-4111-8111-111111111111' AND e.code = a.code
ON CONFLICT (tenant_id, alias) DO NOTHING;

INSERT INTO fx_rate_pin (tenant_id, day, usd_to_local, pinned_by) VALUES
  ('11111111-1111-4111-8111-111111111111', '2026-08-30', 0.37600000, 'seed')
ON CONFLICT (tenant_id, day) DO NOTHING;

COMMIT;

-- Tenant beta (synthetic) -------------------------------------------------------
INSERT INTO tenant (id, code, name, currency_code, timezone)
VALUES ('22222222-2222-4222-8222-222222222222', 'tenant-beta', 'Tenant Beta (synthetic)', 'AED', 'Asia/Dubai')
ON CONFLICT (code) DO NOTHING;

BEGIN;
SELECT set_config('app.tenant_id', '22222222-2222-4222-8222-222222222222', true);

INSERT INTO unit_catalog_entry (tenant_id, code, name, factor, is_base) VALUES
  ('22222222-2222-4222-8222-222222222222', 'PCS', 'Piece', NULL, true),
  ('22222222-2222-4222-8222-222222222222', 'BOX', 'Box',  6.0,  false)
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO fx_rate_pin (tenant_id, day, usd_to_local, pinned_by) VALUES
  ('22222222-2222-4222-8222-222222222222', '2026-08-30', 3.67250000, 'seed')
ON CONFLICT (tenant_id, day) DO NOTHING;

COMMIT;
