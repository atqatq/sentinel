-- ============================================================================
-- Sentinel — 0010_setup: the §14.28 setup doors (the Setup & onboarding
-- phase, D-049).
--
-- What lands here:
--   1. user_credential.must_change — the forced-change posture (§14.10 step
--      1 generalized): the bootstrap Origin and EVERY setup-created account
--      lands with must_change = true and changes its own password at first
--      sign-in. A password the account has never chosen must not govern a
--      setup. Default false keeps every pre-existing row and every existing
--      caller byte-compatible (additive, SCHEMA_VERSION 0010).
--
--   2. setup_create_tenant_with_founder — the repository's FIRST SECURITY
--      DEFINER function, and the reason is the repo's own rule: *there is
--      no bypass, only the door.* The chicken-and-egg is structural:
--      controls_origin_only (0003) requires the grantor to ALREADY hold an
--      active O in the target tenant — a tenant being created has no O, so
--      the founder grant cannot ride the app role's ordinary authority. The
--      alternatives were a CLI per tenant (setup is not a breeze) or
--      loosening controls_origin_only (a security regression); both
--      rejected. The door is the migrator's authority (D-029's disclosed
--      pattern — "the first O per tenant is seeded by the migrator path"),
--      scoped to ONE purpose, callable by sentinel_app ONLY (REVOKE from
--      PUBLIC, GRANT EXECUTE to sentinel_app), and internally fail-closed:
--      the actor must resolve to an app_user with is_origin = true — an
--      unset GUC reads NULL (no row → refused), an empty one errors the
--      ::uuid cast (loud deny), a non-origin user is refused by name — the
--      mfa_gate posture verbatim. ONE statement creates the tenant AND the
--      founder O grant (granted_by = the actor): atomic by construction —
--      a failure leaves no tenant and no half-grant.
--
-- The LIVE proof of the door is the CI db-rls job's setup section; the
-- structural pins are packages/db/test/schema.test.js (M-setup).
-- ============================================================================

ALTER TABLE "user_credential" ADD COLUMN "must_change" BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN "user_credential"."must_change" IS '§14.28: the forced-change posture — the bootstrap Origin and every setup-created account lands true and rotates at first sign-in (POST /api/auth/password clears it through a re-authentication). Default false: pre-existing rows and callers are byte-compatible.';

CREATE OR REPLACE FUNCTION "setup_create_tenant_with_founder"(
  p_code TEXT,
  p_name TEXT,
  p_currency_code TEXT,
  p_timezone TEXT,
  p_actor_id TEXT
) RETURNS UUID AS $$
DECLARE
  v_tenant_id UUID;
  v_is_origin BOOLEAN;
  v_actor UUID;
BEGIN
  -- ---- the fail-closed actor check (the door's whole point) -------------
  -- An unset app.actor_id GUC arrives as NULL; an empty one errors the
  -- ::uuid cast BELOW (loud deny, the 22P02 posture the GUC contract
  -- names). NULL is refused here, by name.
  IF p_actor_id IS NULL OR btrim(p_actor_id) = '' THEN
    RAISE EXCEPTION 'SETUP_NOT_ORIGIN: no actor in the context — the door proves an origin principal before anything writes';
  END IF;
  v_actor := p_actor_id::uuid;
  SELECT is_origin INTO v_is_origin FROM "app_user" WHERE "id" = v_actor;
  IF v_is_origin IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'SETUP_NOT_ORIGIN: actor % is not an origin principal (is_origin is migrator-provisioned; there is no API that grants it)', v_actor;
  END IF;

  -- ---- the shape checks (the boundary validates too; the door re-proves)
  IF p_code IS NULL OR length(btrim(p_code)) < 2 OR length(btrim(p_code)) > 32 THEN
    RAISE EXCEPTION 'SETUP_SHAPE_INVALID: tenant code must be 2..32 characters (got %)', coalesce(p_code, 'NULL');
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) < 1 OR length(btrim(p_name)) > 128 THEN
    RAISE EXCEPTION 'SETUP_SHAPE_INVALID: tenant name must be 1..128 characters';
  END IF;
  IF p_currency_code IS NULL OR p_currency_code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'SETUP_SHAPE_INVALID: currency_code must be a 3-letter uppercase ISO 4217 code';
  END IF;
  IF p_timezone IS NULL OR length(btrim(p_timezone)) < 1 OR length(btrim(p_timezone)) > 64 THEN
    RAISE EXCEPTION 'SETUP_SHAPE_INVALID: timezone must be a non-empty IANA zone name (1..64 characters)';
  END IF;

  -- ---- the atomic unit: the tenant AND its founder O grant --------------
  INSERT INTO "tenant" ("code", "name", "currency_code", "timezone")
    VALUES (btrim(p_code), btrim(p_name), p_currency_code::CHAR(3), btrim(p_timezone))
    RETURNING "id" INTO v_tenant_id;

  INSERT INTO "tenant_role" ("tenant_id", "user_id", "role", "granted_by")
    VALUES (v_tenant_id, v_actor, 'O', v_actor);

  RETURN v_tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- The door is callable ONLY through the app role — never PUBLIC.
REVOKE ALL ON FUNCTION "setup_create_tenant_with_founder"(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "setup_create_tenant_with_founder"(TEXT, TEXT, TEXT, TEXT, TEXT) TO "sentinel_app";

COMMENT ON FUNCTION "setup_create_tenant_with_founder"(TEXT, TEXT, TEXT, TEXT, TEXT) IS
  '§14.28/D-049: the founder door — the migrator''s authority scoped to one purpose (tenant + its first O grant, one atomic statement), fail-closed on is_origin. The repository''s first SECURITY DEFINER: there is no bypass, only the door.';
