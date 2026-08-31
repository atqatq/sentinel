-- ============================================================================
-- Sentinel — 0005_auth: the M11 authentication layer (gate M11, M3).
--
-- What lands here (audit M11 fix; delivery spec AuthN/Z row; build spec
-- §10.1, §14.9, §16.1 Class N):
--   1. user_credential — the LOCAL-credential hash store (the lab/bootstrap
--      path, §14.10; production credentials live in the OIDC IdP per the
--      delivery spec AuthN/Z row). One row per user; rotation is an UPDATE
--      tracked by updated_at. The hash is node-native scrypt (N=2^15, r=8,
--      64-byte key) — the named Argon2id deviation is D-031's: zero native
--      deps, memory-hard class, and the IdP owns production passwords.
--   2. mfa_enrolment — the RFC 6238 TOTP second factor. The secret is
--      WRAPPED AT REST by the adapter with an injected AES-256-GCM key
--      (the H5 key posture: the key never touches the database); the row
--      carries the enrolment state (enrolled → verified) and the replay
--      guard (last_used_step — only steps STRICTLY greater may verify).
--   3. user_session — the issued session. The bearer token is stored ONLY
--      as its SHA-256 hash (a database read cannot mint a session); idle
--      is DERIVED from last_seen_at + the §14.9 30-minute floor (no column
--      to drift); the absolute horizon is pinned at issuance (8 hours —
--      it never slides); termination is a tombstone, never a DELETE.
--   4. login_attempt — the append-only pre-tenant audit record: every
--      sign-in attempt with its outcome (SUCCESS | FAILURE | LOCKED_OUT).
--      SELECT, INSERT grants ONLY — the ledger's immutability pattern
--      (any UPDATE/DELETE is 42501-loud). Failed logins of users that
--      cannot resolve to a tenant live HERE; the hash-chained ledger
--      carries the Class-N blocks for every tenant-resolvable auth event
--      (§16.1 Class N) — the split is named in D-031.
--
-- RLS POSTURE (the honest boundary, D-031): these four tables are the
-- PRE-TENANT auth layer — the session RESOLUTION runs BEFORE a tenant GUC
-- exists, so a tenant_isolation fence is structurally impossible on them
-- (the bootstrap read cannot be scoped by what it is about to produce).
-- They are reachable only through sentinel_app; the token is hashed; the
-- secret is wrapped; the tenant DATA behind the session stays fenced by
-- the ADR-0002 policies exactly as before. No RLS is armed here — by
-- design, disclosed, not overlooked.
--
-- The MFA gate on approvals: a RESTRICTIVE INSERT policy on approval
-- (mfa_gate) requires current_setting('app.mfa_ok', true) = 'true'. A
-- never-set GUC reads NULL (refused), an EMPTY one (a session that has run
-- transaction-local set_config before) reads '' (refused) — fail-closed
-- for every shape, the API+DB pair the audit M11 fix demands.
-- ============================================================================

CREATE TABLE "user_credential" (
  "user_id" UUID NOT NULL,
  "password_hash" TEXT NOT NULL,
  "password_salt" TEXT NOT NULL,
  "algo" TEXT NOT NULL DEFAULT 'scrypt',
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "user_credential_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "user_credential_user_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE
);
COMMENT ON TABLE "user_credential" IS 'M11: the local-credential hash (lab/bootstrap path; production passwords live in the OIDC IdP). scrypt N=2^15/r=8/64B, salted; rotation is an UPDATE. Never plaintext, never reversible.';

CREATE TABLE "mfa_enrolment" (
  "user_id" UUID NOT NULL,
  "secret" TEXT NOT NULL,
  "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "verified_at" TIMESTAMPTZ(6),
  "last_used_step" BIGINT,
  CONSTRAINT "mfa_enrolment_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "mfa_enrolment_user_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE
);
COMMENT ON TABLE "mfa_enrolment" IS 'M11: the RFC 6238 TOTP enrolment. The secret is wrapped at rest with an injected AES-256-GCM key (never in the clear, the key never in the database). last_used_step is the replay guard: a code at or below it refuses even inside the ±1 step window.';

CREATE TABLE "user_session" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "token_hash" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "role" "user_role" NOT NULL,
  "mfa_ok" BOOLEAN NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "terminated_at" TIMESTAMPTZ(6),
  "created_ip" TEXT,
  CONSTRAINT "user_session_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_session_user_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE,
  CONSTRAINT "user_session_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "user_session_token_hash_key" ON "user_session"("token_hash");
CREATE INDEX "user_session_user_id_idx" ON "user_session"("user_id");
COMMENT ON TABLE "user_session" IS 'M11: the issued session. token_hash = SHA-256 of the bearer token (the raw token never lands). Idle = last_seen_at + the §14.9 30-minute floor (derived, never stored); absolute_expires_at never slides; terminated_at is a tombstone — no DELETE for any actor.';

-- The append-only sign-in audit trail: every attempt, every outcome, no
-- rewrite for any actor (SELECT, INSERT grants only — the ledger pattern).
CREATE TABLE "login_attempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "user_id" UUID,
  "at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "outcome" TEXT NOT NULL,
  "ip" TEXT,
  CONSTRAINT "login_attempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "login_attempt_outcome_check" CHECK ("outcome" IN ('SUCCESS', 'FAILURE', 'LOCKED_OUT')),
  CONSTRAINT "login_attempt_user_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE SET NULL
);
CREATE INDEX "login_attempt_user_at_idx" ON "login_attempt"("user_id", "at");
COMMENT ON TABLE "login_attempt" IS 'M11: the pre-tenant audit record of every sign-in attempt (SUCCESS | FAILURE | LOCKED_OUT). Append-only — the grants refuse UPDATE/DELETE loudly (42501). Lockout decisions read the failure streak since the last success.';

-- append-only: the sign-in audit trail no actor may rewrite
GRANT SELECT, INSERT ON "login_attempt" TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE ON "user_credential" TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE ON "mfa_enrolment" TO "sentinel_app";
GRANT SELECT, INSERT, UPDATE ON "user_session" TO "sentinel_app";

-- ---- The MFA gate on approvals (the DB half of the M11 gate) ---------------
-- An approval vote (either decision — casting a vote is the privileged act)
-- may only be written by a session the boundary has proven MFA-ok. The GUC
-- shapes, fail-closed every way: never-set → NULL = 'true' is NULL → refused;
-- EMPTY (a reused pooled session) → '' ≠ 'true' → refused; 'false' → refused;
-- 'true' → passes. The pure layer's mayApprove() decided the same thing
-- before any statement was built (the API+DB pair).
CREATE POLICY "mfa_gate" ON "approval" AS RESTRICTIVE FOR INSERT TO PUBLIC
  WITH CHECK (current_setting('app.mfa_ok', true) = 'true');
