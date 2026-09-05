-- ============================================================================
-- Sentinel — synthetic seed for local development and the reference stack.
-- NO real business data, ever (D-003): tenants, units and rates below are
-- synthetic placeholders. Run as the migration/owner role.
-- Idempotent: ON CONFLICT DO NOTHING throughout.
-- ============================================================================

-- Tenant alpha (synthetic) ----------------------------------------------------
INSERT INTO tenant (id, code, name, currency_code, timezone)
VALUES ('11111111-1111-4111-8111-111111111111', 'tenant-alpha', 'Tenant Alpha (synthetic)', 'BHD', 'Asia/Bahrain')
ON CONFLICT DO NOTHING; -- no target: covers the PK (id) AND the code unique

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
ON CONFLICT DO NOTHING; -- no target: covers the PK (id) AND the code unique

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

-- C3 financial controls (0003_controls; D-029) --------------------------------
-- Synthetic principals and the DEFAULT tiers. These are PLACEHOLDERS the
-- Origin amends per tenant in production (§16: tenant-amendable parameters) —
-- no real names, no real thresholds (D-003). Seeded as the migrator path
-- (superuser bootstrap): the first Origin per tenant cannot grant itself the
-- role through the Origin-only RLS policy, by construction.
INSERT INTO app_user (id, email, display_name, is_origin) VALUES
  ('aaaaaaa1-0000-4000-8000-000000000001', 'origin@sentinel.synthetic',  'Synthetic Origin',   true),
  ('aaaaaaa1-0000-4000-8000-000000000002', 'manager@sentinel.synthetic', 'Synthetic SCM',      false),
  ('aaaaaaa1-0000-4000-8000-000000000003', 'senior@sentinel.synthetic',  'Synthetic SBR',      false),
  ('aaaaaaa1-0000-4000-8000-000000000004', 'buyer@sentinel.synthetic',   'Synthetic BYR',      false)
ON CONFLICT (email) DO NOTHING;

BEGIN;
SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true);
SELECT set_config('app.actor_id',  'aaaaaaa1-0000-4000-8000-000000000001', true);

INSERT INTO tenant_role (tenant_id, user_id, role, granted_by) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaa1-0000-4000-8000-000000000001', 'O',   'aaaaaaa1-0000-4000-8000-000000000001'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaa1-0000-4000-8000-000000000002', 'SCM', 'aaaaaaa1-0000-4000-8000-000000000001'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaa1-0000-4000-8000-000000000003', 'SBR', 'aaaaaaa1-0000-4000-8000-000000000001'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaa1-0000-4000-8000-000000000004', 'BYR', 'aaaaaaa1-0000-4000-8000-000000000001')
ON CONFLICT (tenant_id, user_id) WHERE "revoked_at" IS NULL DO NOTHING;

INSERT INTO approval_config (tenant_id, currency_code, dual_threshold_amount, updated_by) VALUES
  ('11111111-1111-4111-8111-111111111111', 'BHD', 1000.000000, 'aaaaaaa1-0000-4000-8000-000000000001')
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO approval_limit (tenant_id, role, max_single_amount, updated_by) VALUES
  ('11111111-1111-4111-8111-111111111111', 'SBR', 5000.000000,  'aaaaaaa1-0000-4000-8000-000000000001'),
  ('11111111-1111-4111-8111-111111111111', 'SCM', 50000.000000, 'aaaaaaa1-0000-4000-8000-000000000001'),
  ('11111111-1111-4111-8111-111111111111', 'O',   NULL,         'aaaaaaa1-0000-4000-8000-000000000001')
ON CONFLICT (tenant_id, role) DO NOTHING;
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', '22222222-2222-4222-8222-222222222222', true);
SELECT set_config('app.actor_id',  'aaaaaaa1-0000-4000-8000-000000000001', true);

INSERT INTO tenant_role (tenant_id, user_id, role, granted_by) VALUES
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaa1-0000-4000-8000-000000000001', 'O',   'aaaaaaa1-0000-4000-8000-000000000001'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaa1-0000-4000-8000-000000000002', 'SCM', 'aaaaaaa1-0000-4000-8000-000000000001'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaa1-0000-4000-8000-000000000003', 'SBR', 'aaaaaaa1-0000-4000-8000-000000000001'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaa1-0000-4000-8000-000000000004', 'BYR', 'aaaaaaa1-0000-4000-8000-000000000001')
ON CONFLICT (tenant_id, user_id) WHERE "revoked_at" IS NULL DO NOTHING;

INSERT INTO approval_config (tenant_id, currency_code, dual_threshold_amount, updated_by) VALUES
  ('22222222-2222-4222-8222-222222222222', 'AED', 10000.000000, 'aaaaaaa1-0000-4000-8000-000000000001')
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO approval_limit (tenant_id, role, max_single_amount, updated_by) VALUES
  ('22222222-2222-4222-8222-222222222222', 'SBR', 50000.000000, 'aaaaaaa1-0000-4000-8000-000000000001'),
  ('22222222-2222-4222-8222-222222222222', 'SCM', 500000.000000,'aaaaaaa1-0000-4000-8000-000000000001'),
  ('22222222-2222-4222-8222-222222222222', 'O',   NULL,         'aaaaaaa1-0000-4000-8000-000000000001')
ON CONFLICT (tenant_id, role) DO NOTHING;
COMMIT;
