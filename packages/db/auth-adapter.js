'use strict';
/* ============================================================================
 * makeAuthAdapter(client, config) — the SQL executor of the M11
 * authentication layer (0005_auth): credential registration and rotation,
 * sign-in attempts and the lockout history, TOTP enrolment and challenge
 * verification, session issuance/resolution/touch/termination.
 *
 * Home rule (the H6/C3/H5 pattern): the DECISION layer is the pure auth
 * module (packages/core/modules/auth — the policy floor, RFC 6238, the
 * session lifecycle, the sign-in machine, consumed through its public
 * surface per ADR-0001); this package owns the SQL mechanics. The database
 * re-proves what it can: login_attempt is append-only (SELECT, INSERT
 * grants only — the ledger pattern), and the RESTRICTIVE mfa_gate policy on
 * approval refuses an approval INSERT whose session was not proven MFA-ok.
 *
 * config (all injected — this adapter owns no secrets and no clock):
 *   wrapKey   REQUIRED (32+ chars) — the key that wraps TOTP secrets at
 *             rest (AES-256-GCM; the AES key is derived as SHA-256 of the
 *             injected string). The key never touches the database — the
 *             H5 posture.
 *   ledger    optional { forTenant(tenantId) → ledgerAdapter | null } —
 *             the Class-N emitter (§16.1). Auth events that resolve to a
 *             tenant append through the ledger adapter; pre-tenant events
 *             (a failed login for an unknown email) live in login_attempt
 *             only. Named in D-031.
 *   now       optional () => Date (tests pin the clock).
 *   rng       optional (n) => Buffer (tests pin the entropy).
 *
 * Statement-first discipline: the pure layer decides BEFORE any statement
 * is built — a refused login sends exactly one INSERT (the audit trail)
 * and nothing else.
 *
 * The raw bearer token NEVER lands in a statement: the adapter hashes it
 * (SHA-256) before the INSERT/SELECT, and only the hash is stored — a
 * database read cannot mint a session.
 * ==========================================================================*/

const crypto = require('crypto');
const auth = require('../core/modules/auth');

const AES_ALGO = 'aes-256-gcm';

function refuse(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  throw e;
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function aesKey(wrapKey) {
  return crypto.createHash('sha256').update(String(wrapKey), 'utf8').digest();
}

function wrapSecret(secret, wrapKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGO, aesKey(wrapKey), iv);
  const enc = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

function unwrapSecret(wrapped, wrapKey) {
  const [ivHex, tagHex, encHex] = String(wrapped).split(':');
  if (!ivHex || !tagHex || !encHex) refuse('AUTH_SECRET_WRAP_INVALID', 'the wrapped secret does not carry iv/tag/payload');
  const decipher = crypto.createDecipheriv(AES_ALGO, aesKey(wrapKey), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

function makeAuthAdapter(client, config) {
  if (!config || typeof config !== 'object') throw new Error('AUTH_CONFIG_REQUIRED');
  if (typeof config.wrapKey !== 'string' || config.wrapKey.length < 32) {
    throw new Error('AUTH_CONFIG_WRAP_KEY_REQUIRED: the wrap key is injected by the caller (32+ chars)');
  }
  const q = (text, values) => client.query(text, values);
  const now = config.now || (() => new Date());
  const rng = config.rng || ((n) => crypto.randomBytes(n));
  const ledgerFor = (config.ledger && config.ledger.forTenant) || (() => null);

  /* Class-N emission: append through the ledger adapter when the event
   * resolves to a tenant; never let an audit failure pass silently — the
   * §16.3 deny-by-default rule rides here too (a ledger failure aborts the
   * caller's transaction). */
  function emit(tenantId, block, envelope) {
    const ledger = ledgerFor(tenantId);
    if (!ledger) return null; // pre-tenant event — login_attempt carries it
    /* the §16.2 gate requires EVERY field: an auth event carries no diffs
     * (before/after are explicit nulls, never undefined) and the envelope
     * supplies the session identity + version stamps */
    return ledger.appendBlock(Object.assign(
      { class: 'N', outcome: 'success', before: null, after: null, reason: null },
      envelope,
      block));
  }

  return {
    /* ---- credentials ------------------------------------------------- */
    /* Register or ROTATE the local credential. The pure policy floor runs
     * first — a weak password sends zero statements.
     *
     * mustChange (§14.28, additive): the forced-change posture. The setup
     * bootstrap and every setup-created account lands TRUE (a password the
     * account has never chosen must not govern a setup or a tenant); the
     * re-authenticated rotation route clears it with false. Omitted → false
     * on INSERT (the DDL default) and an explicit false on UPDATE — the
     * pre-existing callers' behavior is byte-compatible. */
    async registerCredential({ userId, password, mustChange = false }) {
      if (typeof mustChange !== 'boolean') refuse('AUTH_CREDENTIAL_MUST_CHANGE_INVALID', 'mustChange must be a boolean when provided');
      const policyRefusal = auth.password.check(password);
      if (policyRefusal) refuse(policyRefusal, 'the password policy floor refused before any statement');
      const salt = auth.password.randomSalt(rng);
      const hash = auth.password.hash(password, salt);
      const existing = await q(`SELECT user_id FROM user_credential WHERE user_id = $1`, [userId]);
      await q(
        `INSERT INTO user_credential (user_id, password_hash, password_salt, algo, must_change, updated_at)
         VALUES ($1, $2, $3, 'scrypt', $5, $4)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash,
           password_salt = EXCLUDED.password_salt, algo = 'scrypt', must_change = EXCLUDED.must_change,
           updated_at = EXCLUDED.updated_at`,
        [userId, hash, salt.toString('hex'), now(), mustChange === true]);
      return { rotated: existing.rows.length > 0 };
    },

    /* The §14.28 rotation: re-authenticate → rotate → clear must_change →
     * terminate every OTHER live session. ONE transaction the adapter owns
     * (§16.3 rule 2 — the statements live or die together): a rotation is a
     * re-authentication, never a bearer act, and a security event, not a
     * preference. The caller's OWN session survives (it holds the fresh
     * cookie contract); every other live session of the user takes the
     * tombstone. */
    async rotateCredential({ email, currentPassword, newPassword, token, ip = null }) {
      if (typeof email !== 'string' || !email) refuse('AUTH_DECISION_INVALID', 'email is required');
      if (typeof currentPassword !== 'string' || !currentPassword) refuse('AUTH_DECISION_INVALID', 'currentPassword is required');
      if (typeof newPassword !== 'string' || !newPassword) refuse('AUTH_DECISION_INVALID', 'newPassword is required');
      /* the pure policy floor runs FIRST — a weak replacement sends zero
       * statements (the statement-first discipline, verbatim) */
      const policyRefusal = auth.password.check(newPassword);
      if (policyRefusal) return { outcome: 'REFUSED', reason: policyRefusal };
      await q('BEGIN');
      try {
        const found = await this.findUserCredential(email);
        const credentialOk = Boolean(
          found && found.passwordHash && found.passwordSalt &&
          auth.password.verify(currentPassword, Buffer.from(found.passwordSalt, 'hex'), found.passwordHash));
        if (!found || !credentialOk) {
          await this.recordLoginAttempt({ email, userId: found ? found.userId : null, outcome: 'FAILURE', ip });
          await q('COMMIT');
          return { outcome: 'REFUSED', reason: 'AUTH_PASSWORD_CURRENT_INVALID' };
        }
        await this.registerCredential({ userId: found.userId, password: newPassword, mustChange: false });
        let others = { rowCount: 0 };
        if (token) {
          others = await q(
            `UPDATE user_session SET terminated_at = $3
              WHERE user_id = $1 AND terminated_at IS NULL AND token_hash <> $2`,
            [found.userId, sha256hex(String(token)), now()]);
        }
        /* one Class-N block PER active tenant membership — a credential
         * rotation affects every tenant the user serves, so every tenant's
         * ledger carries it; a user with no membership is the pre-tenant
         * shape (the tombstones + the credential UPDATE are the records). */
        const memberships = await this.listUserTenants(found.userId);
        for (const m of memberships) {
          await emit(m.tenantId, {
            entity: 'user_credential', entityId: found.userId, action: 'auth.credential.rotated',
            outcome: 'success', reason: found.mustChange === true ? 'forced-change-cleared' : 'voluntary',
          }, { actor: found.userId, role: m.role });
        }
        await q('COMMIT');
        return { outcome: 'ROTATED', othersTerminated: others.rowCount || 0 };
      } catch (e) {
        await q('ROLLBACK').catch(() => {});
        throw e;
      }
    },

    /* Look up the user + credential by email. Returns the facts the pure
     * login machine needs, or null for an unknown email (the boundary
     * records the attempt either way — user enumeration is the boundary's
     * response-shape concern, not the adapter's). */
    async findUserCredential(email) {
      const r = await q(
        `SELECT u.id AS "userId", u.email, u.is_origin AS "isOrigin", u.display_name AS "displayName",
                c.password_hash AS "passwordHash", c.password_salt AS "passwordSalt",
                c.must_change AS "mustChange"
           FROM app_user u LEFT JOIN user_credential c ON c.user_id = u.id
          WHERE u.email = $1`, [email]);
      return r.rows[0] || null;
    },

    /* ---- sign-in attempts + lockout ----------------------------------- */
    async recordLoginAttempt({ email, userId, outcome, ip }) {
      if (!['SUCCESS', 'FAILURE', 'LOCKED_OUT'].includes(outcome)) {
        refuse('AUTH_ATTEMPT_OUTCOME_INVALID', `outcome must be SUCCESS | FAILURE | LOCKED_OUT, got ${JSON.stringify(outcome)}`);
      }
      await q(
        `INSERT INTO login_attempt (email, user_id, at, outcome, ip) VALUES ($1, $2, $3, $4, $5)`,
        [email, userId === undefined ? null : userId, now(), outcome, ip === undefined ? null : ip]);
    },

    /* The failure history SINCE the last success — the injected fact the
     * pure lockoutState() decides over (successes clear the streak). */
    async failureStreak(userId, until) {
      const r = await q(
        `SELECT at FROM login_attempt
          WHERE user_id = $1 AND outcome = 'FAILURE'
            AND at > COALESCE((SELECT max(at) FROM login_attempt
                                WHERE user_id = $1 AND outcome = 'SUCCESS'), to_timestamp(0))
          ORDER BY at ASC`, [userId]);
      void until;
      return r.rows.map((row) => new Date(row.at).getTime());
    },

    /* ---- TOTP ---------------------------------------------------------- */
    async enrolMfa({ userId, secret }) {
      /* confirm the secret is decodable base32 BEFORE it is wrapped — a
       * malformed enrolment must never persist (the pure layer's decoder
       * is the gate; it throws on bad input). */
      auth.totp.base32Decode(secret);
      const wrapped = wrapSecret(secret, config.wrapKey);
      await q(
        `INSERT INTO mfa_enrolment (user_id, secret, enrolled_at, verified_at, last_used_step)
         VALUES ($1, $2, $3, NULL, NULL)
         ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret,
           enrolled_at = EXCLUDED.enrolled_at, verified_at = NULL, last_used_step = NULL`,
        [userId, wrapped, now()]);
      return { enrolled: true };
    },

    async mfaStatus(userId) {
      const r = await q(
        `SELECT secret, verified_at AS "verifiedAt", last_used_step AS "lastUsedStep"
           FROM mfa_enrolment WHERE user_id = $1`, [userId]);
      const row = r.rows[0];
      if (!row) return { enrolled: false, verified: false, secret: null, lastUsedStep: null };
      return {
        enrolled: true,
        verified: row.verifiedAt !== null,
        secret: unwrapSecret(row.secret, config.wrapKey),
        lastUsedStep: row.lastUsedStep === null ? null : Number(row.lastUsedStep),
      };
    },

    /* The challenge step: unwrap → pure RFC 6238 verify (±1 step, replay
     * refused below the enrolment's last-used step) → advance the guard.
     * The row-level UPDATE carries the replay backstop: a concurrent
     * verifier of the SAME step finds zero rows and is refused. */
    async verifyTotp({ userId, code, tenantId, actor }) {
      const status = await this.mfaStatus(userId);
      if (!status.enrolled) return { ok: false, reason: 'AUTH_MFA_NOT_ENROLLED' };
      const verdict = auth.totp.verify(status.secret, code, now().getTime(), status.lastUsedStep);
      if (!verdict.ok) {
        if (tenantId) {
          /* AWAITED — a fire-and-forget statement on a shared connection
           * interleaves protocol frames with the caller's next statement
           * and reads GUC state from whatever transaction happens to be
           * current when the round-trip lands (live-caught: the emission's
           * tail SELECT raced the caller's ROLLBACK and read the EMPTY GUC
           * as ''::uuid → 22P02). The ledger write is part of THIS
           * transaction, exactly as §16.3 rule 2 wants it. */
          await emit(tenantId, { entity: 'mfa_enrolment', entityId: userId, action: 'auth.mfa.challenge.failed', outcome: 'denied', reason: 'AUTH_MFA_INVALID' }, actor || {});
        }
        return { ok: false, reason: 'AUTH_MFA_INVALID' };
      }
      const upd = await q(
        `UPDATE mfa_enrolment SET last_used_step = $2,
            verified_at = COALESCE(verified_at, $3)
          WHERE user_id = $1 AND (last_used_step IS NULL OR last_used_step < $2)`,
        [userId, verdict.matchedStep, now()]);
      if (upd.rowCount === 0) return { ok: false, reason: 'AUTH_MFA_REPLAY' };
      return { ok: true, matchedStep: verdict.matchedStep, firstVerification: status.verified === false };
    },

    /* ---- sessions ------------------------------------------------------ */
    /* Issue the session: pure layer pins the record, the adapter stores
     * only the token HASH and returns the raw token once — the only moment
     * it exists outside the boundary's response. */
    async issueSession({ userId, tenantId, role, mfaOk, ip }) {
      const at = now().getTime();
      const token = auth.password.randomToken(rng);
      const sessionId = crypto.randomUUID();
      const record = auth.session.issue({ userId, tenantId, role, mfaOk, nowMs: at, sessionId });
      await q(
        `INSERT INTO user_session
           (id, token_hash, user_id, tenant_id, role, mfa_ok, created_at, last_seen_at, absolute_expires_at, created_ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [sessionId, sha256hex(token), userId, tenantId, role, mfaOk,
         new Date(record.createdAt), new Date(record.lastSeenAt), new Date(record.absoluteExpiresAt), ip === undefined ? null : ip]);
      await emit(tenantId, { entity: 'user_session', entityId: sessionId, action: 'auth.session.created', outcome: 'success' }, { actor: userId, role });
      return { token, session: record };
    },

    /* Resolve a bearer token to a LIVE session (touch-on-read slides the
     * idle window; every non-ACTIVE state is returned named, never thrown
     * — the boundary maps it to 401 with the reason). */
    async resolveSession(token, opts) {
      const o = opts || {};
      const r = await q(
        `SELECT s.id, s.user_id AS "userId", s.tenant_id AS "tenantId", s.role, s.mfa_ok AS "mfaOk",
                s.created_at AS "createdAt", s.last_seen_at AS "lastSeenAt",
                s.absolute_expires_at AS "absoluteExpiresAt", s.terminated_at AS "terminatedAt",
                u.is_origin AS "isOrigin", t.code AS "tenantCode",
                c.must_change AS "mustChange"
           FROM user_session s JOIN app_user u ON u.id = s.user_id
           JOIN tenant t ON t.id = s.tenant_id
           LEFT JOIN user_credential c ON c.user_id = u.id
          WHERE s.token_hash = $1`, [sha256hex(String(token || ''))]);
      const row = r.rows[0];
      if (!row) return { resolved: false, reason: 'AUTH_SESSION_UNKNOWN' };
      const session = {
        sessionId: row.id, userId: row.userId, tenantId: row.tenantId, role: row.role,
        mfaOk: row.mfaOk === true,
        isOrigin: row.isOrigin === true,
        mustChange: row.mustChange === true,
        tenantCode: row.tenantCode,
        createdAt: new Date(row.createdAt).getTime(),
        lastSeenAt: new Date(row.lastSeenAt).getTime(),
        absoluteExpiresAt: new Date(row.absoluteExpiresAt).getTime(),
        terminatedAt: row.terminatedAt === null ? null : new Date(row.terminatedAt).getTime(),
      };
      const state = auth.session.state(session, now().getTime());
      if (state !== auth.session.STATE.ACTIVE) {
        return { resolved: false, reason: 'AUTH_SESSION_' + state, session };
      }
      if (!o.noTouch) {
        await q(`UPDATE user_session SET last_seen_at = $2 WHERE id = $1 AND terminated_at IS NULL`, [session.sessionId, now()]);
      }
      return { resolved: true, session, principal: { userId: session.userId, role: session.role, mfaOk: session.mfaOk, isOrigin: session.isOrigin, mustChange: session.mustChange, tenantCode: session.tenantCode } };
    },

    async terminateSession(token) {
      const r = await q(
        `UPDATE user_session SET terminated_at = $2 WHERE token_hash = $1 AND terminated_at IS NULL`,
        [sha256hex(String(token || '')), now()]);
      return { terminated: r.rowCount === 1 };
    },

    /* The tenant switcher's door: the boundary validates membership FIRST
     * (an active tenant_role, or Origin); this update is the write. */
    async setSessionTenant(token, tenantId) {
      const r = await q(
        `UPDATE user_session SET tenant_id = $2 WHERE token_hash = $1 AND terminated_at IS NULL`,
        [sha256hex(String(token || '')), tenantId]);
      if (r.rowCount !== 1) refuse('AUTH_SESSION_TENANT_UNCHANGED', 'no live session for that token');
      return { moved: true };
    },

    /* The login boundary's tenant resolution: the user's FIRST active
     * tenant_role (granted_at order — deterministic), with the tenant CODE
     * the display layer reads. Origin-without-a-role refuses by name at
     * the boundary (the §14.10 bootstrap is its own named work, D-031). */
    async resolveUserTenant(userId) {
      const r = await q(
        `SELECT tr.tenant_id AS "tenantId", t.code AS "tenantCode", tr.role
           FROM tenant_role tr JOIN tenant t ON t.id = tr.tenant_id
          WHERE tr.user_id = $1 AND tr.revoked_at IS NULL
          ORDER BY tr.granted_at ASC LIMIT 1`, [userId]);
      return r.rows[0] || null;
    },

    /* The active tenant_roles of a user — the switcher's lawful menu. */
    async listUserTenants(userId) {
      const r = await q(
        `SELECT tr.tenant_id AS "tenantId", t.code AS "tenantCode", tr.role
           FROM tenant_role tr JOIN tenant t ON t.id = tr.tenant_id
          WHERE tr.user_id = $1 AND tr.revoked_at IS NULL
          ORDER BY tr.granted_at ASC`, [userId]);
      return r.rows;
    },

    /* Membership check for the switcher: an active role in THAT tenant. */
    async hasTenantRole(userId, tenantId) {
      const r = await q(
        `SELECT 1 AS ok FROM tenant_role
          WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL LIMIT 1`, [userId, tenantId]);
      return r.rows.length > 0;
    },

    /* ---- the composed sign-in flow ------------------------------------ */
    /* attemptLogin — the WHOLE sign-in machine over ONE injected client,
     * in ONE transaction the adapter owns (the auth layer's single
     * multi-statement atomic unit: attempts, Class-N emissions and the
     * session issuance live or die together, §16.3 rule 2). The route
     * passes a DEDICATED pool client; the pure layer decides, this method
     * sequences, the database re-proves.
     *
     * Two-step by design (the stateless challenge, D-031):
     *   attemptLogin({email, password})            → CHALLENGE_MFA | ISSUE | REFUSED
     *   attemptLogin({email, password, code})      → the MFA step — the
     *     credentials are RE-verified (the server keeps no challenge state)
     *
     * The session's role is the C3 principal: the tenant_role the login
     * binds (first active, granted_at order). A user with no active
     * tenant_role refuses AUTH_NO_TENANT — the §14.10 bootstrap is named
     * work, never a silent empty session. */
    async attemptLogin({ email, password, code = null, ip = null }) {
      if (typeof email !== 'string' || !email) refuse('AUTH_DECISION_INVALID', 'email is required');
      if (typeof password !== 'string' || !password) refuse('AUTH_DECISION_INVALID', 'password is required');
      await q('BEGIN');
      try {
        const found = await this.findUserCredential(email);
        const credentialOk = Boolean(
          found && found.passwordHash && found.passwordSalt &&
          auth.password.verify(password, Buffer.from(found.passwordSalt, 'hex'), found.passwordHash));
        if (!found || !credentialOk) {
          await this.recordLoginAttempt({ email, userId: found ? found.userId : null, outcome: 'FAILURE', ip });
          await q('COMMIT');
          return { outcome: 'REFUSED', reason: 'AUTH_INVALID_CREDENTIALS' };
        }
        const userId = found.userId;
        const tenant = await this.resolveUserTenant(userId);
        if (!tenant) {
          await this.recordLoginAttempt({ email, userId, outcome: 'FAILURE', ip });
          await q('COMMIT');
          return { outcome: 'REFUSED', reason: 'AUTH_NO_TENANT' };
        }
        await q(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.tenantId]);

        const streak = await this.failureStreak(userId);
        const lock = auth.login.lockoutState(streak, now().getTime());
        if (lock.locked) {
          await this.recordLoginAttempt({ email, userId, outcome: 'LOCKED_OUT', ip });
          await q('COMMIT');
          return { outcome: 'REFUSED', reason: 'AUTH_LOCKED', until: lock.until };
        }

        const mfa = await this.mfaStatus(userId);
        let mfaVerifiedNow = false;
        if (mfa.enrolled && code !== null) {
          const totp = await this.verifyTotp({ userId, code, tenantId: tenant.tenantId, actor: { actor: userId, role: tenant.role } });
          if (!totp.ok) {
            await this.recordLoginAttempt({ email, userId, outcome: 'FAILURE', ip });
            await q('COMMIT');
            return { outcome: 'REFUSED', reason: totp.reason === 'AUTH_MFA_REPLAY' ? 'AUTH_MFA_REPLAY' : 'AUTH_MFA_INVALID' };
          }
          mfaVerifiedNow = true;
        }
        const verdict = auth.login.decide({ credentialOk, lock, mfaEnrolled: mfa.enrolled, mfaVerifiedNow });
        if (verdict.outcome === auth.login.OUTCOME.REFUSED) {
          await this.recordLoginAttempt({ email, userId, outcome: 'FAILURE', ip });
          await q('COMMIT');
          return { outcome: 'REFUSED', reason: verdict.reason };
        }
        if (verdict.outcome === auth.login.OUTCOME.CHALLENGE_MFA) {
          await this.recordLoginAttempt({ email, userId, outcome: 'SUCCESS', ip });
          await q('COMMIT');
          return { outcome: 'CHALLENGE_MFA', tenantCode: tenant.tenantCode };
        }
        /* ISSUE — the session's role is the tenant_role the login binds;
         * mfa_ok is the verdict the machine just proved, never a guess */
        const issued = await this.issueSession({
          userId, tenantId: tenant.tenantId, role: tenant.role,
          mfaOk: mfaVerifiedNow === true,
          ip,
        });
        await this.recordLoginAttempt({ email, userId, outcome: 'SUCCESS', ip });
        await q('COMMIT');
        return {
          outcome: 'ISSUE',
          token: issued.token,
          session: issued.session,
          principal: { userId, tenantId: tenant.tenantId, tenantCode: tenant.tenantCode, role: tenant.role, mfaOk: issued.session.mfaOk, mustChange: found.mustChange === true },
        };
      } catch (e) {
        await q('ROLLBACK').catch(() => {});
        throw e;
      }
    },
  };
}

module.exports = { makeAuthAdapter };
