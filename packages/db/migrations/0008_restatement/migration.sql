-- ============================================================================
-- Sentinel — 0008_restatement: the M8 restatement semantics (audit M8).
--
-- The audit's [S] finding: "Late-arriving consumption restates history;
-- DayStates are immutable. Does the time machine show the sealed (wrong)
-- state forever, with current data diverging silently?" Fix (build spec
-- §14.16): restatement events are ledger blocks; the time machine marks
-- resealed states and diffs "as known then" vs "as known now."
--
-- What lands here:
--   plan_seal_restatement — the VERSION chain of a sealed tenant-day. The
--   original seal (plan_seal, 0002) stays immutable at revision 1; every
--   restatement is a NEW row chained to its predecessor:
--     * revision >= 2, UNIQUE (tenant_id, seal_date, revision) — a day's
--       versions are a total order; a racing append collides (23505) and
--       the loser retries against the new head. The chain cannot fork.
--     * prev_revision + prev_payload_hash name the predecessor EXACTLY
--       (revision 1 = the seal row itself, which MUST exist — the composite
--       FK into plan_seal holds the anchor there). The
--       plan_seal_restatement_chain_guard trigger re-proves the pointer
--       structurally, the ledger_chain_guard posture: a wrong predecessor
--       is impossible even from raw SQL.
--     * delta JSONB — the deterministic "as known then vs as known now"
--       summary (refs changed, driver changed, KPI keys changed; the pure
--       summarizer in plan-service owns the shape).
--     * reason NOT NULL — a restatement is an explicit, justified act
--       (RESTATE_REASON_REQUIRED at the service boundary; the database
--       agrees with the gate, a reasonless restatement cannot exist even
--       via raw SQL — the ledger_reason_required posture).
--     * restated_by NOT NULL — an anonymous restatement cannot exist; the
--       actor is the authenticated session's, the same identity the ledger
--       block carries.
--   * Append-only (§16.3 rule 1 applied to the seal's own history):
--     sentinel_app is granted SELECT, INSERT only; RLS ENABLE + FORCE with
--     the tenant_isolation policy (ADR-0002); a trigger refuses any
--     UPDATE/DELETE that ever reaches the table — you can restate again,
--     never un-state.
--   * The ledger block itself rides the SAME transaction in the
--     application (§16.3 rule 2: the ledger write failing rolls the
--     restatement back with it) — the restatement door in the db package
--     composes both inserts; this migration carries no ledger changes.
--
-- The current state of a day = its highest revision here, else the seal
-- row. Readers resolve "the seal for this tenant-day" there (the
-- replay-divergence comparison in plan-adapter, the time machine read
-- surface, the day-vs-day diff).
-- ============================================================================

CREATE TABLE "plan_seal_restatement" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "seal_date" DATE NOT NULL,
  "revision" INT NOT NULL CHECK ("revision" >= 2),
  "payload" JSONB NOT NULL,
  "payload_hash" TEXT NOT NULL CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  "prev_revision" INT NOT NULL CHECK ("prev_revision" >= 1),
  "prev_payload_hash" TEXT NOT NULL CHECK ("prev_payload_hash" ~ '^[0-9a-f]{64}$'),
  "delta" JSONB NOT NULL,
  "reason" TEXT NOT NULL CHECK (length("reason") > 0),
  "engine_version" TEXT NOT NULL,
  "schema_version" TEXT NOT NULL,
  "restated_by" TEXT NOT NULL,
  "restated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "plan_seal_restatement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "plan_seal_restatement_tenant_date_revision_key" ON "plan_seal_restatement"("tenant_id","seal_date","revision");
CREATE INDEX "plan_seal_restatement_tenant_date_idx" ON "plan_seal_restatement"("tenant_id","seal_date");

ALTER TABLE "plan_seal_restatement" ADD CONSTRAINT "plan_seal_restatement_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- The anchor: there is no restatement of a day that was never sealed.
ALTER TABLE "plan_seal_restatement" ADD CONSTRAINT "plan_seal_restatement_day_fkey" FOREIGN KEY ("tenant_id","seal_date") REFERENCES "plan_seal"("tenant_id","seal_date") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append only: the app role never receives UPDATE or DELETE.
GRANT SELECT, INSERT ON "plan_seal_restatement" TO "sentinel_app";

ALTER TABLE "plan_seal_restatement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_seal_restatement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "plan_seal_restatement" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---- The fork guard (structural backstop of the version chain) -------------
-- The application derives the revision and predecessor pointer under a lock
-- on the anchor seal row (the door). This trigger makes a WRONG append
-- structurally impossible even from raw SQL: revision 2 must name the seal
-- row (which must exist, prev hash = the seal's hash); revision N > 2 must
-- name revision N-1 with its exact hash. Concurrency: two appends racing
-- the same revision collide on the UNIQUE index (23505) — the chain never
-- forks, the loser retries.
CREATE OR REPLACE FUNCTION "plan_seal_restatement_chain_guard"() RETURNS trigger AS $$
DECLARE
  head_rev INT;
  head_hash TEXT;
  seal_hash TEXT;
BEGIN
  SELECT r.revision, r.payload_hash INTO head_rev, head_hash
    FROM "plan_seal_restatement" r
   WHERE r.tenant_id = NEW.tenant_id AND r.seal_date = NEW.seal_date
   ORDER BY r.revision DESC
   LIMIT 1;
  IF head_rev IS NULL THEN
    IF NEW.prev_revision <> 1 THEN
      RAISE EXCEPTION 'RESTATE_PREDECESSOR_MISMATCH';
    END IF;
    SELECT p.payload_hash INTO seal_hash FROM "plan_seal" p
      WHERE p.tenant_id = NEW.tenant_id AND p.seal_date = NEW.seal_date;
    IF seal_hash IS NULL THEN
      RAISE EXCEPTION 'RESTATE_PREDECESSOR_MISSING';
    END IF;
    IF NEW.prev_payload_hash <> seal_hash THEN
      RAISE EXCEPTION 'RESTATE_PREDECESSOR_MISMATCH';
    END IF;
  ELSE
    IF NEW.prev_revision <> head_rev THEN
      RAISE EXCEPTION 'RESTATE_PREDECESSOR_MISMATCH';
    END IF;
    IF NEW.prev_payload_hash <> head_hash THEN
      RAISE EXCEPTION 'RESTATE_PREDECESSOR_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_seal_restatement_chain_guard_trigger"
  BEFORE INSERT ON "plan_seal_restatement"
  FOR EACH ROW EXECUTE FUNCTION "plan_seal_restatement_chain_guard"();

-- ---- The immutability trigger (the loud layer above the missing grants) ----
-- Fires for ANY role whose UPDATE/DELETE ever reaches the table — including
-- the table owner and a superuser (RLS-bypassing) connection. The named code
-- is what the live proof asserts.
CREATE OR REPLACE FUNCTION "plan_seal_restatement_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'RESTATEMENT_APPEND_ONLY';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_seal_restatement_no_update_trigger"
  BEFORE UPDATE ON "plan_seal_restatement"
  FOR EACH ROW EXECUTE FUNCTION "plan_seal_restatement_append_only"();

CREATE TRIGGER "plan_seal_restatement_no_delete_trigger"
  BEFORE DELETE ON "plan_seal_restatement"
  FOR EACH ROW EXECUTE FUNCTION "plan_seal_restatement_append_only"();

COMMENT ON TABLE "plan_seal_restatement" IS 'M8 §14.16: the version chain of a sealed tenant-day. Revision 1 is the plan_seal row itself (immutable); each restatement is a new revision chained by prev_revision + prev_payload_hash, guarded by plan_seal_restatement_chain_guard (the ledger_chain_guard posture). Append-only: SELECT/INSERT grants + RLS + the append_only trigger. Restatement events ride the H5 ledger (Class W, RESTATE_DAY) in the same transaction.';
