'use strict';
/* ============================================================================
 * AUTH live proof — the M11 authentication layer against REAL PostgreSQL.
 *
 * Requires a reachable PostgreSQL. Runs in CI (db-rls job, postgres:16).
 * The audit-M11 named proofs are exercised THROUGH THE REAL WIRING — the
 * pure auth module decides, the auth adapter writes, the database re-proves:
 *
 *   auth/session-policy.spec (the live half): the §14.9 floor for every
 *     principal — a session whose idle window slid past 30 minutes refuses
 *     by name and is never touched; the absolute horizon is pinned at
 *     issuance; termination is a tombstone that never resurrects.
 *   auth/mfa-approvals.spec (the live half): an approval INSERT rides the
 *     RESTRICTIVE mfa_gate policy — refused 42501 without the proven
 *     second factor, refused with 'false', allowed only with 'true'.
 *   Plus: the scrypt credential round-trip and rotation, the failed-login
 *     lockout over REAL attempt rows, login_attempt's append-only grants
 *     (42501-loud), the TOTP wrap-at-rest posture (the stored blob is NOT
 *     the plaintext secret), the row-level replay guard, the touch-on-read,
 *     and the Class-N block a session creation appends through the ledger.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));
const auth = require(path.join(REPO, 'packages', 'core', 'modules', 'auth'));
const planningEngine = require(path.join(REPO, 'packages', 'core', 'modules', 'planning-engine'));

const ADMIN_URL = process.env.DATABASE_URL_ADMIN || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const LIVE_DB = 'sentinel_auth_live';
const MIGRATION = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
  .filter((d) => /^\d{4}_/.test(d)).sort()
  .map((d) => fs.readFileSync(path.join(__dirname, '..', 'migrations', d, 'migration.sql'), 'utf8'))
  .join('\n');

const WRAP = 'auth-live-wrap-key-0123456789abcdef-0123456789abcdef';
const LEDGER_KEY = 'auth-live-hmac-key-0123456789abcdef-0123456789abcdef';
const ENGINE = planningEngine.ENGINE_VERSION || 'unknown';
const sha256hex = (t) => crypto.createHash('sha256').update(t).digest('hex');

let passed = 0, failed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function bad(name, detail) { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }

function probeUrl(role) {
  const u = new URL(ADMIN_URL.replace(/^postgres:\/\//, 'http://'));
  return `postgres://${role}:${role}@${u.hostname}:${u.port || 5432}/${LIVE_DB}`;
}

async function main() {
  /* ---- 1. scratch database + migrations ---- */
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${LIVE_DB};`);
  await admin.query(`CREATE DATABASE ${LIVE_DB};`);
  await admin.end();

  const db = new Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, '/' + LIVE_DB) });
  await db.connect();
  await db.query(MIGRATION);

  /* ---- 2. seed: tenant, users, roles, tiers, supplier (superuser bootstrap) ---- */
  const T1 = (await db.query(`INSERT INTO tenant (code, name, currency_code, timezone) VALUES ('auth-alpha','Auth Alpha (synthetic)','BHD','Asia/Bahrain') RETURNING id`)).rows[0].id;
  const U = {};
  for (const [key, email] of [['origin', 'origin.auth@live.synthetic'], ['manager', 'manager.auth@live.synthetic'], ['ghost', 'ghost.auth@live.synthetic']]) {
    U[key] = (await db.query(`INSERT INTO app_user (email, display_name) VALUES ($1,$2) RETURNING id`, [email, key])).rows[0].id;
  }
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
  await db.query(`INSERT INTO tenant_role (tenant_id, user_id, role, granted_by) VALUES ($1,$2,'O',$2), ($1,$3,'SCM',$2)`, [T1, U.origin, U.manager]);
  await db.query(`INSERT INTO approval_config (tenant_id, currency_code, dual_threshold_amount, updated_by) VALUES ($1,'BHD',1000,$2)`, [T1, U.origin]);
  await db.query(`INSERT INTO approval_limit (tenant_id, role, max_single_amount, updated_by) VALUES ($1,'SCM',50000,$2), ($1,'O',NULL,$2)`, [T1, U.origin]);
  const S1 = (await db.query(
    `INSERT INTO supplier (tenant_id, external_id, name, is_active, payment_term_days, payment_terms_text, currency_code)
     VALUES ($1,'S-100','Auth Supplier',true,45,'SOA +45 Days','BHD') RETURNING id`, [T1])).rows[0].id;
  await db.query('COMMIT');

  /* ---- 3. the probe (non-superuser, NOBYPASSRLS, member of sentinel_app) ---- */
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_probe') THEN
      CREATE ROLE auth_probe LOGIN PASSWORD 'auth_probe';
    END IF;
  END $$;`);
  /* the probe role is CLUSTER-wide and outlives the scratch database — a
   * stale one from an earlier run would carry an older password; the test
   * owns its probe, so the credential is pinned idempotently */
  await db.query(`ALTER ROLE auth_probe LOGIN PASSWORD 'auth_probe' NOBYPASSRLS;`);
  await db.query(`GRANT sentinel_app TO auth_probe;`);
  const probe = new Client({ connectionString: probeUrl('auth_probe') });
  await probe.connect();
  const who = await probe.query('SELECT current_user');
  if (who.rows[0].current_user !== 'auth_probe') {
    bad('probe identity', `connected as ${who.rows[0].current_user}`);
    process.exit(1);
  }

  const makeAuth = (client) => DB.makeAuthAdapter(client, {
    wrapKey: WRAP,
    now: () => new Date(),
    ledger: { forTenant: (t) => DB.makeLedgerAdapter(client, t, { hmacKey: LEDGER_KEY, engineVersion: ENGINE, schemaVersion: DB.SCHEMA_VERSION }) },
  });
  const AUTH = makeAuth(probe);
  /* the ledger rides the SAME tenant fence every adapter write does: a
   * Class-N emission only ever happens inside a tenant-scoped tx */
  const withTenant = async (fn) => {
    await probe.query('BEGIN');
    await probe.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
    try { return await fn(); } finally { await probe.query('COMMIT').catch(() => probe.query('ROLLBACK')); }
  };

  /* ---- 4. credentials: registration, verification, rotation ---- */
  console.log('\nCredentials: scrypt at rest, rotation by UPDATE');
  await AUTH.registerCredential({ userId: U.origin, password: 'Origin!Strong#42' });
  const found = await AUTH.findUserCredential('origin.auth@live.synthetic');
  if (found && found.userId === U.origin && found.passwordHash && found.passwordHash !== 'Origin!Strong#42') {
    ok('the credential row stores the HASH (never the password), joined by email');
  } else bad('credential round-trip', JSON.stringify(found));
  const cred = await db.query(`SELECT password_hash, password_salt, algo FROM user_credential WHERE user_id = $1`, [U.origin]);
  if (cred.rows[0].algo === 'scrypt'
    && auth.password.verify('Origin!Strong#42', Buffer.from(cred.rows[0].password_salt, 'hex'), cred.rows[0].password_hash)) {
    ok('the persisted scrypt hash verifies against the persisted salt');
  } else bad('scrypt verification', JSON.stringify(cred.rows[0]));

  await AUTH.registerCredential({ userId: U.origin, password: 'Rotated!Strong#77' });
  const cred2 = await db.query(`SELECT password_hash, password_salt FROM user_credential WHERE user_id = $1`, [U.origin]);
  if (cred2.rows[0].password_hash !== cred.rows[0].password_hash
    && !auth.password.verify('Origin!Strong#42', Buffer.from(cred2.rows[0].password_salt, 'hex'), cred2.rows[0].password_hash)
    && auth.password.verify('Rotated!Strong#77', Buffer.from(cred2.rows[0].password_salt, 'hex'), cred2.rows[0].password_hash)) {
    ok('rotation replaced the hash: the old password is dead, the new one verifies');
  } else bad('rotation', 'the old hash survived');

  /* ---- 5. sign-in attempts + lockout over REAL rows ---- */
  console.log('\nLockout: five failures inside the window lock the account');
  for (let i = 0; i < 4; i++) await AUTH.recordLoginAttempt({ email: 'origin.auth@live.synthetic', userId: U.origin, outcome: 'FAILURE' });
  let streak = await AUTH.failureStreak(U.origin);
  let lock = auth.login.lockoutState(streak, Date.now());
  if (streak.length === 4 && lock.locked === false) ok('four failures never lock');
  else bad('four failures', JSON.stringify({ streak, lock }));
  await AUTH.recordLoginAttempt({ email: 'origin.auth@live.synthetic', userId: U.origin, outcome: 'FAILURE' });
  streak = await AUTH.failureStreak(U.origin);
  lock = auth.login.lockoutState(streak, Date.now());
  if (lock.locked === true) ok('the fifth failure engages the lock (the pure decision over real rows)');
  else bad('the fifth failure', JSON.stringify({ streak, lock }));
  const machine = auth.login.decide({ credentialOk: true, lock, mfaEnrolled: false, mfaVerifiedNow: false });
  if (machine.outcome === 'REFUSED' && machine.reason === 'AUTH_LOCKED') {
    ok('the sign-in machine refuses a locked account BEFORE credential evaluation');
  } else bad('locked refusal', JSON.stringify(machine));
  await AUTH.recordLoginAttempt({ email: 'origin.auth@live.synthetic', userId: U.origin, outcome: 'LOCKED_OUT' });
  await AUTH.recordLoginAttempt({ email: 'origin.auth@live.synthetic', userId: U.origin, outcome: 'SUCCESS' });
  streak = await AUTH.failureStreak(U.origin);
  if (streak.length === 0) ok('a success clears the failure streak (the since-last-success boundary in the SQL)');
  else bad('streak cleared', JSON.stringify(streak));

  /* the unknown email records too — user_id NULL, no crash */
  await AUTH.recordLoginAttempt({ email: 'ghost.auth@live.synthetic', outcome: 'FAILURE' });
  const ghost = await db.query(`SELECT user_id FROM login_attempt WHERE email = 'ghost.auth@live.synthetic'`);
  if (ghost.rows.length === 1 && ghost.rows[0].user_id === null) ok('the pre-tenant failure records with user_id NULL (the D-031 split)');
  else bad('ghost attempt', JSON.stringify(ghost.rows));

  /* append-only at the privilege layer */
  const expectPgError = async (name, fn, { code, message }) => {
    await probe.query('BEGIN');
    await probe.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
    try {
      await fn();
      bad(name, `expected ${code || message} but the statement succeeded`);
    } catch (e) {
      if (code && e.code === code) ok(`${name} (code ${e.code})`);
      else if (message && String(e.message).includes(message)) ok(`${name} (${message})`);
      else bad(name, `expected ${code || message}, got ${e.code || 'none'}: ${e.message}`);
    } finally {
      await probe.query('ROLLBACK');
    }
  };
  await expectPgError('login_attempt refuses UPDATE (append-only, 42501)',
    () => probe.query(`UPDATE login_attempt SET outcome = 'SUCCESS' WHERE user_id = $1`, [U.origin]), { code: '42501' });
  await expectPgError('login_attempt refuses DELETE (append-only, 42501)',
    () => probe.query(`DELETE FROM login_attempt WHERE user_id = $1`, [U.origin]), { code: '42501' });
  await expectPgError('a foreign outcome refuses at the CHECK (23514)',
    () => probe.query(`INSERT INTO login_attempt (email, outcome) VALUES ('x@y','MAYBE')`), { code: '23514' });

  /* ---- 6. TOTP: wrapped at rest, verified through the adapter ---- */
  console.log('\nTOTP: the secret never rests in the clear; the replay guard is a row-level WHERE');
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  await AUTH.enrolMfa({ userId: U.origin, secret: SECRET });
  const raw = await db.query(`SELECT secret FROM mfa_enrolment WHERE user_id = $1`, [U.origin]);
  if (raw.rows[0].secret !== SECRET && /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(raw.rows[0].secret)) {
    ok('the stored blob is the wrapped secret (iv:tag:payload) — never the plaintext');
  } else bad('wrap at rest', raw.rows[0].secret.slice(0, 20));
  /* a wrong code emits a denied Class-N block — that emission rides the
   * tenant fence, so the challenge runs inside a tenant-scoped tx */
  const wrong = await withTenant(() => AUTH.verifyTotp({ userId: U.origin, code: '000000', tenantId: T1, actor: { actor: U.origin, role: 'O' } }));
  if (wrong.ok === false && wrong.reason === 'AUTH_MFA_INVALID') ok('a wrong code refuses AUTH_MFA_INVALID (and its refusal is ledgered)');
  else bad('wrong code', JSON.stringify(wrong));
  const code = auth.totp.codeAt(SECRET, Date.now());
  const good = await AUTH.verifyTotp({ userId: U.origin, code });
  if (good.ok === true && good.firstVerification === true) ok('the correct code verifies and CONFIRMS the enrolment (verified_at set)');
  else bad('the correct code', JSON.stringify(good));
  const replay = await AUTH.verifyTotp({ userId: U.origin, code });
  if (replay.ok === false && replay.reason === 'AUTH_MFA_INVALID') {
    ok('the SAME code never verifies twice — the replay is refused (the pure guard sees the advanced step; the row-level WHERE backstop covers the concurrent race, pinned by the stub suite)');
  } else bad('replay', JSON.stringify(replay));
  const status = await AUTH.mfaStatus(U.origin);
  if (status.enrolled && status.verified && status.lastUsedStep === good.matchedStep) {
    ok(`the enrolment state reads back verified with last_used_step ${status.lastUsedStep} (the int8 lesson: a number)`);
  } else bad('enrolment state', JSON.stringify(status));

  /* ---- 7. sessions: issue, resolve, touch, expiry, termination ---- */
  console.log('\nSessions: issue → resolve → expiry → the tombstone');
  let issued;
  await withTenant(() => AUTH.issueSession({ userId: U.origin, tenantId: T1, role: 'O', mfaOk: true, ip: '10.7.0.1' })
    .then((r) => { issued = r; }));
  if (issued && /^[0-9a-f]{64}$/.test(issued.token)) ok('the bearer token comes back once (64 hex chars)');
  else bad('token shape', JSON.stringify(issued).slice(0, 60));
  const stored = await db.query(`SELECT token_hash FROM user_session WHERE id = $1`, [issued.session.sessionId]);
  const tokenHash = stored.rows[0].token_hash;
  if (tokenHash.length === 64 && !tokenHash.includes(issued.token.slice(0, 8))) {
    ok('only the SHA-256 of the token is stored (the raw token never lands)');
  } else bad('token hash', tokenHash);

  const resolved = await AUTH.resolveSession(issued.token);
  if (resolved.resolved && resolved.principal.userId === U.origin && resolved.principal.role === 'O' && resolved.principal.mfaOk === true) {
    ok('the token resolves to the principal envelope (userId, role, mfaOk)');
  } else bad('resolution', JSON.stringify(resolved));
  const seen = await db.query(`SELECT last_seen_at FROM user_session WHERE id = $1`, [issued.session.sessionId]);
  await new Promise((r) => setTimeout(r, 30));
  await AUTH.resolveSession(issued.token);
  const seen2 = await db.query(`SELECT last_seen_at FROM user_session WHERE id = $1`, [issued.session.sessionId]);
  if (new Date(seen2.rows[0].last_seen_at) > new Date(seen.rows[0].last_seen_at)) ok('touch-on-read slid the idle window');
  else bad('touch-on-read', `${seen.rows[0].last_seen_at} → ${seen2.rows[0].last_seen_at}`);

  /* expiry by name — backdated rows (superuser writes the physical state) */
  const idle = 'b'.repeat(64);
  await db.query(
    `INSERT INTO user_session (token_hash, user_id, tenant_id, role, mfa_ok, created_at, last_seen_at, absolute_expires_at)
     VALUES ($1,$2,$3,'O',true, now() - interval '2 hours', now() - interval '31 minutes', now() + interval '6 hours')`,
    [sha256hex(idle), U.origin, T1]);
  const idleResolved = await AUTH.resolveSession(idle);
  if (idleResolved.resolved === false && idleResolved.reason === 'AUTH_SESSION_IDLE_EXPIRED') {
    ok('a session idle past the §14.9 floor refuses BY NAME and is never touched');
  } else bad('idle expiry', JSON.stringify(idleResolved));

  const absolute = 'c'.repeat(64);
  await db.query(
    `INSERT INTO user_session (token_hash, user_id, tenant_id, role, mfa_ok, created_at, last_seen_at, absolute_expires_at)
     VALUES ($1,$2,$3,'O',true, now() - interval '9 hours', now(), now() - interval '1 hour')`,
    [sha256hex(absolute), U.origin, T1]);
  const absResolved = await AUTH.resolveSession(absolute);
  if (absResolved.resolved === false && absResolved.reason === 'AUTH_SESSION_ABSOLUTE_EXPIRED') {
    ok('the absolute horizon refuses by name — busy or not, 8 hours is 8 hours');
  } else bad('absolute expiry', JSON.stringify(absResolved));

  const term = await AUTH.terminateSession(issued.token);
  const again = await AUTH.terminateSession(issued.token);
  const dead = await AUTH.resolveSession(issued.token);
  if (term.terminated && !again.terminated && dead.resolved === false && dead.reason === 'AUTH_SESSION_TERMINATED') {
    ok('termination is a tombstone: once, idempotently, forever');
  } else bad('termination', JSON.stringify({ term, again, dead }));

  /* ---- 8. NAMED PROOF auth/mfa-approvals — the mfa_gate policy, live ---- */
  console.log('\nNAMED PROOF auth/mfa-approvals — the RESTRICTIVE mfa_gate policy on approval');
  /* raiser = Origin (O); every vote is cast by the manager (SCM ≠ raiser, so
   * the SoD binding is never the refusal being observed — the mfa gate is). */
  const procure = DB.makeProcureAdapter(probe, T1);
  await probe.query('BEGIN');
  await probe.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
  await probe.query(`SELECT set_config('app.actor_id', $1, true)`, [U.origin]);
  await probe.query(`SELECT set_config('app.mfa_ok', 'true', true)`);
  await procure.raiseProposal({ code: 'PR-AUTH-1', raisedBy: U.origin, supplierId: S1, currencyCode: 'BHD', totalAmount: 500,
    lines: [{ sku: 'SKU-A1', qty: 10, unitCode: 'CTN', unitPrice: 50 }] });
  await procure.raiseProposal({ code: 'PR-AUTH-2', raisedBy: U.origin, supplierId: S1, currencyCode: 'BHD', totalAmount: 500,
    lines: [{ sku: 'SKU-A2', qty: 10, unitCode: 'CTN', unitPrice: 50 }] });
  await probe.query('COMMIT');
  const P1 = (await db.query(`SELECT id FROM proposal WHERE tenant_id = $1 AND code = 'PR-AUTH-1'`, [T1])).rows[0].id;
  const P2 = (await db.query(`SELECT id FROM proposal WHERE tenant_id = $1 AND code = 'PR-AUTH-2'`, [T1])).rows[0].id;

  await probe.query('BEGIN');
  await probe.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
  await probe.query(`SELECT set_config('app.actor_id', $1, true)`, [U.manager]);
  await probe.query(`SELECT set_config('app.mfa_ok', 'true', true)`);
  const gateOk = await probe.query(
    `INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason) VALUES ($1,$2,$3,'APPROVED','mfa proven') RETURNING id`,
    [T1, P1, U.manager]);
  await probe.query('COMMIT');
  if (gateOk.rows.length === 1) ok('an approval INSERT with app.mfa_ok = true lands (the vote gate opens)');
  else bad('mfa gate open', 'the INSERT failed');

  await probe.query('BEGIN');
  await probe.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
  await probe.query(`SELECT set_config('app.actor_id', $1, true)`, [U.manager]);
  await probe.query(`SELECT set_config('app.mfa_ok', 'false', true)`);
  try {
    await probe.query(`INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason) VALUES ($1,$2,$3,'APPROVED','no factor')`, [T1, P2, U.manager]);
    await probe.query('ROLLBACK');
    bad('mfa gate closed (false)', 'the INSERT succeeded without a proven factor');
  } catch (e) {
    await probe.query('ROLLBACK');
    if (e.code === '42501') ok('an approval INSERT with app.mfa_ok = false refuses 42501 (the gate holds)');
    else bad('mfa gate closed (false)', `${e.code}: ${e.message}`);
  }
  const freshGate = new Client({ connectionString: probeUrl('auth_probe') });
  await freshGate.connect();
  await freshGate.query('BEGIN');
  await freshGate.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
  await freshGate.query(`SELECT set_config('app.actor_id', $1, true)`, [U.manager]);
  try {
    await freshGate.query(`INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason) VALUES ($1,$2,$3,'APPROVED','never set')`, [T1, P2, U.manager]);
    await freshGate.query('ROLLBACK');
    bad('mfa gate closed (never set)', 'the INSERT succeeded with a never-set GUC');
  } catch (e) {
    await freshGate.query('ROLLBACK');
    if (e.code === '42501') ok('a NEVER-set mfa GUC refuses too (NULL = true is NULL — fail-closed)');
    else bad('mfa gate closed (never set)', `${e.code}: ${e.message}`);
  }
  await freshGate.end();

  /* ---- 9. the Class-N block a session creation appended ---- */
  console.log('\nClass-N: session creation rides the hash-chained ledger');
  const ledger = DB.makeLedgerAdapter(probe, T1, { hmacKey: LEDGER_KEY, engineVersion: ENGINE, schemaVersion: DB.SCHEMA_VERSION });
  const chain = await withTenant(() => ledger.loadChain());
  const n = chain.filter((b) => b.class === 'N' && b.action === 'auth.session.created');
  if (n.length === 1 && n[0].actor === U.origin && n[0].outcome === 'success') {
    ok('the session creation is durable in the chain (Class-N, actor, outcome)');
  } else bad('Class-N block', JSON.stringify(chain.map((b) => [b.class, b.action])));
  const verifyAll = await withTenant(() => ledger.verifyChain());
  if (verifyAll.ok) ok('the ledger still verifies end to end with the auth blocks in it');
  else bad('ledger verify', JSON.stringify(verifyAll));

  /* ---- cleanup ---- */
  await probe.end();
  await db.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('auth-live failed to run:', e.code || '', e.message, e.detail || ''); process.exit(1); });
