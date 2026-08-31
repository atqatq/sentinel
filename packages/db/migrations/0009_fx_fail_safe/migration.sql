-- ============================================================================
-- Sentinel — 0009_fx_fail_safe: the M10 FX fail-safe (audit M10).
--
-- The audit's [S] finding: "FX stale-rate behaviour is unspecified. The FX
-- pin is 24h per tenant-day; nothing says what happens when the FX job fails
-- (block conversions? last-pinned value with a staleness flag?). Fix:
-- fail-safe policy (continue on last pinned rate, mark all derived money
-- stale-visible, alarm); source of record named." Build spec §14.17 and
-- ADR-0003 are the contract; the fx-adapter is the door.
--
-- The fx_rate_pin TABLE itself has existed since 0001 (the C2 pin: one rate
-- per tenant-day, direction named in the column). What lands HERE is the
-- table's integrity posture, now that a WRITER exists:
--
--   * Rate sanity is structural: usd_to_local must be > 0 — the door
--     refuses RATE_INVALID (positive finite) before any statement, and this
--     CHECK is the raw-SQL backstop. A zero or negative "rate" would invert
--     money silently; it cannot exist in the source of record.
--   * Pins are never deleted: correctRate is the door's only change path
--     (reason + diff + a Class-S FX_CORRECT block — the correction trail IS
--     the history). DELETE is revoked from the app role AND refused by a
--     trigger for EVERY role (the plan_seal append-only posture): correct
--     again, never un-pin.
--   * UPDATE stays granted (the correction door needs it), RLS ENABLE +
--     FORCE and the tenant_isolation policy already hold from 0001 — every
--     statement remains scoped to the bound tenant.
--
-- No new table: the source of record's shape was decided in 0001 and does
-- not change. The fail-safe RESOLUTION (exact pin fresh; last pin ≤ the day
-- continues stale-visible; never-pinned refuses RATE_NOT_PINNED) is the
-- money layer's pure decision (ingestion fx.js) — the database stores pins,
-- it never decides policy.
-- ============================================================================

-- The raw-SQL backstop of RATE_INVALID: a non-positive rate cannot exist.
ALTER TABLE "fx_rate_pin" ADD CONSTRAINT "fx_rate_pin_rate_positive" CHECK ("usd_to_local" > 0);

-- Append-only: pins are corrected, never erased. The app role loses DELETE;
-- the trigger refuses it for every role (including the owner — FORCE makes
-- RLS bind the owner, and this guard is the write-path equivalent).
REVOKE DELETE ON "fx_rate_pin" FROM "sentinel_app";

CREATE OR REPLACE FUNCTION "fx_rate_pin_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'FX_RATE_PIN_IMMUTABLE: pins are corrected through the door (correctRate), never deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "fx_rate_pin_no_delete"
  BEFORE DELETE ON "fx_rate_pin"
  FOR EACH ROW EXECUTE FUNCTION "fx_rate_pin_append_only"();
