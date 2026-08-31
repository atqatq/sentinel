-- ============================================================================
-- Sentinel — 0004_ledger: the H5 tamper-evident ledger (gate 11, M3).
--
-- What lands here (delivery spec A6 / build spec §11 as amended by §15.2
-- item 3 + §16 log scope):
--   1. ledger_block — the ONE hash-chained sequence for every log class
--      (W/A/N/S/D — class is a field, not a separate store, §16.1). Columns
--      are exactly the §16.2 required fields; before/after carry the diff
--      payloads; reason is enforced present on denials by CHECK.
--   2. The H5 crypto posture lives in the APPLICATION (the pure ledger
--      module): hash = HMAC-SHA256(key, seq ‖ prevHash ‖ canonicalJson(payload))
--      with an injected secret-manager key — the key never touches the
--      database. The database's job is the CHAIN STRUCTURE: a composite PK
--      (tenant_id, seq) makes duplicates and forks structurally impossible,
--      and the ledger_chain_guard trigger refuses a block that does not hang
--      off its predecessor (seq must continue at 1 with GENESIS prev = 64
--      zeros; else seq = last+1 with prev = last hash).
--   3. No actor, INCLUDING Origin, may UPDATE or DELETE a ledger block
--      (H5/§16.3 rule 1) — three independent layers:
--        a. PRIVILEGES: sentinel_app is granted SELECT, INSERT only — any
--           write attempt is refused loudly (42501 permission denied).
--        b. RLS: FORCE + restrictive ledger_append_only / ledger_no_delete
--           policies (USING false) — even a role granted UPDATE/DELETE later
--           sees zero mutable rows (the honest silent-filter semantics).
--        c. TRIGGER: ledger_immutable refuses any UPDATE/DELETE that ever
--           reaches the table — including a superuser bypassing RLS (the
--           honest boundary: concealment holds against in-app roles, not
--           against direct infrastructure access — §10's note verbatim).
--   4. The verification job runs under a DISTINCT READ-ONLY role:
--      sentinel_verifier (NOLOGIN, NOBYPASSRLS) may SELECT the whole chain
--      cross-tenant (ledger_verifier_read policy) and holds no other
--      privilege on this table — the H5 verification posture.
--   5. Deny-by-default (§16.3 rule 2): the ledger write participates in the
--      business transaction — the live proof (test/ledger-live.js) forces a
--      ledger failure and shows the business change roll back with it.
--
-- GUC contract: app.tenant_id fences reads and the chain-guard lookup per
-- the ADR-0002 pattern (fail-closed current_setting(…, true)).
-- The LIVE proof of everything above is test/ledger-live.js (CI db-rls job).
-- ============================================================================

CREATE TYPE "ledger_class" AS ENUM ('W', 'A', 'N', 'S', 'D');
CREATE TYPE "ledger_outcome" AS ENUM ('success', 'denied', 'error');

-- ---- The ledger: one sequence per tenant, every class, append-only ----------
CREATE TABLE "ledger_block" (
  "seq" BIGINT NOT NULL CHECK ("seq" >= 1),
  "class" "ledger_class" NOT NULL,
  "tenant_id" UUID NOT NULL,
  "actor" TEXT NOT NULL,
  "on_behalf_of" UUID,
  "role" TEXT,
  "source_ip" TEXT,
  "session_id" TEXT,
  "entity" TEXT NOT NULL,
  "entity_id" TEXT,
  "action" TEXT NOT NULL,
  "outcome" "ledger_outcome" NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "reason" TEXT,
  "engine_version" TEXT NOT NULL,
  "schema_version" TEXT NOT NULL,
  "at" TIMESTAMPTZ(6) NOT NULL,
  "prev_hash" TEXT NOT NULL CHECK ("prev_hash" ~ '^[0-9a-f]{64}$'),
  "hash" TEXT NOT NULL CHECK ("hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ledger_block_pkey" PRIMARY KEY ("tenant_id", "seq"),
  -- §16.2: a reason is required for denials (and overrides) — the DB agrees
  -- with the pure gate, a reasonless denial cannot exist even via raw SQL.
  CONSTRAINT "ledger_reason_required_for_denials" CHECK ("outcome" <> 'denied' OR "reason" IS NOT NULL)
);
CREATE INDEX "ledger_block_tenant_at_idx" ON "ledger_block"("tenant_id","at" DESC);
CREATE INDEX "ledger_block_tenant_class_idx" ON "ledger_block"("tenant_id","class");
COMMENT ON TABLE "ledger_block" IS 'H5: the hash-chained audit ledger. hash = HMAC-SHA256(key, seq || prev_hash || canonicalJson(payload)) computed in the application (injected secret-manager key — never stored here). prev_hash of seq 1 is 64 zeros (GENESIS). No UPDATE/DELETE for any actor including Origin: grants (SELECT, INSERT only) + RLS restrictive policies + ledger_immutable triggers.';

ALTER TABLE "ledger_block" ADD CONSTRAINT "ledger_block_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Appends only: the app role never receives UPDATE or DELETE on the ledger.
GRANT SELECT, INSERT ON "ledger_block" TO "sentinel_app";

-- The distinct read-only verifier role (H5: the verification job).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sentinel_verifier') THEN
    CREATE ROLE "sentinel_verifier" NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO "sentinel_verifier";
GRANT SELECT ON "ledger_block" TO "sentinel_verifier";

-- ---- RLS: tenant isolation (the ADR-0002 pattern) + the H5 denies ----------
ALTER TABLE "ledger_block" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_block" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ledger_block" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- No actor, including Origin, mutates the chain: even a future role that is
-- GRANTed UPDATE/DELETE finds zero mutable rows (restrictive policies AND
-- with tenant_isolation; USING(false) filters silently — the loud refusals
-- are the missing grants and the trigger below).
CREATE POLICY "ledger_append_only" ON "ledger_block" AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (false);
CREATE POLICY "ledger_no_delete" ON "ledger_block" AS RESTRICTIVE FOR DELETE TO PUBLIC USING (false);

-- The verifier reads EVERY tenant's chain — that is the job — under a role
-- that can do nothing else.
CREATE POLICY "ledger_verifier_read" ON "ledger_block" AS PERMISSIVE FOR SELECT TO "sentinel_verifier" USING (true);

-- ---- The chain guard (structural backstop of the hash chain) ---------------
-- The application computes hashes and allocates seq under a row lock on the
-- current tail (the adapter). This trigger makes a WRONG append structurally
-- impossible even from raw SQL: seq must continue the tenant's sequence and
-- prev_hash must be the current tail's hash (GENESIS = 64 zeros for seq 1).
-- Concurrency: two appends racing the same seq collide on the composite PK
-- (23505) — the chain never forks, the loser retries.
CREATE OR REPLACE FUNCTION "ledger_chain_guard"() RETURNS trigger AS $$
DECLARE
  last_seq BIGINT;
  last_hash TEXT;
BEGIN
  SELECT l.seq, l.hash INTO last_seq, last_hash FROM "ledger_block" l
    WHERE l.tenant_id = NEW.tenant_id
    ORDER BY l.seq DESC
    LIMIT 1;
  IF last_seq IS NULL THEN
    IF NEW.seq <> 1 THEN
      RAISE EXCEPTION 'LEDGER_SEQ_MUST_START_AT_ONE';
    END IF;
    IF NEW.prev_hash <> repeat('0', 64) THEN
      RAISE EXCEPTION 'LEDGER_GENESIS_PREV_HASH';
    END IF;
  ELSE
    IF NEW.seq <> last_seq + 1 THEN
      RAISE EXCEPTION 'LEDGER_SEQ_GAP';
    END IF;
    IF NEW.prev_hash <> last_hash THEN
      RAISE EXCEPTION 'LEDGER_PREV_HASH_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_chain_guard_trigger"
  BEFORE INSERT ON "ledger_block"
  FOR EACH ROW EXECUTE FUNCTION "ledger_chain_guard"();

-- ---- The immutability triggers (the loud layer above RLS) -------------------
-- Fires for ANY role whose UPDATE/DELETE ever reaches the table — including
-- the table owner and a superuser (RLS-bypassing) connection. The named code
-- is what the live proof asserts and what the refused-mutation record
-- carries (§16.4 ledger/origin-cannot-mutate: the attempt is itself logged —
-- the application appends a Class-D block after the refusal).
CREATE OR REPLACE FUNCTION "ledger_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_immutable_update_trigger"
  BEFORE UPDATE ON "ledger_block"
  FOR EACH ROW EXECUTE FUNCTION "ledger_immutable"();

CREATE TRIGGER "ledger_immutable_delete_trigger"
  BEFORE DELETE ON "ledger_block"
  FOR EACH ROW EXECUTE FUNCTION "ledger_immutable"();
