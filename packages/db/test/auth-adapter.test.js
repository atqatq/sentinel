'use strict';
/* ============================================================================
 * Auth adapter (stub client) — the SQL mechanics of the M11 authentication
 * layer without a database. The LIVE proof (auth-live.js) walks the real
 * flows in CI; this suite pins the statement shapes, the secret-wrapping
 * posture, the token-hash discipline and the fail-closed refusals that the
 * live proof then re-proves against real PostgreSQL:
 *   - the raw bearer token NEVER lands in a statement (only its SHA-256);
 *   - the TOTP secret is wrapped at rest (AES-256-GCM, injected key) and
 *     unwraps only under the same key;
 *   - the pure layer decides BEFORE any statement (a weak password, a
 *     malformed enrolment, a bad attempt-outcome send zero statements);
 *   - the int8 lesson: last_used_step leaves the adapter as a number.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));
const auth = require(path.join(REPO, 'packages', 'core', 'modules', 'auth'));

const pending = [];
function test(name, fn) {
  const p = (async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  })();
  pending.push(p);
}

let passed = 0, failed = 0;

const T1 = '22222222-2222-4222-8222-222222222222';
const U1 = '11111111-1111-4111-8111-111111111111';
const WRAP = 'auth-stub-wrap-key-0123456789abcdef-0123456789abcdef';
const NOW = new Date('2026-08-31T08:00:00.000Z');

/* The stub client: records every statement, routes configured rows back. */
function stubClient({ findUser = null, sessionRow = null, mfaRow = null, streak = [], updateCount = 1, tenantRow = null } = {}) {
  const calls = [];
  return {
    calls,
    updateCount,
    async query(text, values) {
      const norm = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: norm, values });
      if (/FROM app_user u LEFT JOIN user_credential/.test(norm)) return { rows: findUser ? [findUser] : [], rowCount: findUser ? 1 : 0 };
      if (/FROM tenant_role tr JOIN tenant t/.test(norm)) return { rows: tenantRow ? [tenantRow] : [], rowCount: tenantRow ? 1 : 0 };
      if (/SELECT at FROM login_attempt/.test(norm)) return { rows: streak.map((t) => ({ at: new Date(t) })), rowCount: streak.length };
      if (/SELECT user_id FROM user_credential/.test(norm)) return { rows: [], rowCount: 0 };
      if (/SELECT secret, verified_at/.test(norm)) return { rows: mfaRow ? [mfaRow] : [], rowCount: mfaRow ? 1 : 0 };
      if (/FROM user_session s JOIN app_user u/.test(norm)) return { rows: sessionRow ? [sessionRow] : [], rowCount: sessionRow ? 1 : 0 };
      return { rows: [], rowCount: /UPDATE/.test(norm) ? updateCount : 0 };
    },
  };
}

function make(c, over) {
  return DB.makeAuthAdapter(c, Object.assign({ wrapKey: WRAP, now: () => NOW }, over || {}));
}

const STRONG = 'Str0ngEnough!Pass';

(async () => {
  console.log('\nConfig discipline');

  await test('the adapter refuses to construct without a config or a real wrap key', async () => {
    assert.throws(() => DB.makeAuthAdapter(null), /AUTH_CONFIG_REQUIRED/);
    assert.throws(() => DB.makeAuthAdapter(null, { wrapKey: 'short' }), /AUTH_CONFIG_WRAP_KEY_REQUIRED/);
  });

  console.log('\nCredentials');

  await test('the password policy floor refuses BEFORE any statement', async () => {
    const c = stubClient();
    await assert.rejects(() => make(c).registerCredential({ userId: U1, password: 'short' }), /AUTH_PASSWORD_TOO_SHORT/);
    await assert.rejects(() => make(c).registerCredential({ userId: U1, password: 'alllowercase12' }), /AUTH_PASSWORD_CLASS_MISSING/);
    assert.strictEqual(c.calls.length, 0);
  });

  await test('registration sends one salted scrypt INSERT with the conflict-rotation shape', async () => {
    const c = stubClient();
    const r = await make(c).registerCredential({ userId: U1, password: STRONG });
    assert.strictEqual(r.rotated, false);
    assert.strictEqual(c.calls.length, 2);
    assert.ok(/INSERT INTO user_credential/.test(c.calls[1].text));
    assert.ok(/ON CONFLICT \(user_id\) DO UPDATE/.test(c.calls[1].text), 'rotation rides the same statement');
    const saltHex = c.calls[1].values[2];
    assert.strictEqual(saltHex.length, 32, '16 random bytes as hex');
    assert.ok(/'scrypt'/.test(c.calls[1].text), 'the algo is a named literal in the statement');
    assert.strictEqual(new Date(c.calls[1].values[3]).toISOString(), NOW.toISOString());
    const round = auth.password.verify(STRONG, Buffer.from(saltHex, 'hex'), c.calls[1].values[1]);
    assert.strictEqual(round, true, 'the persisted hash verifies against the persisted salt');
  });

  await test('the existence probe drives the rotated disclosure', async () => {
    const c = stubClient();
    await make(c).registerCredential({ userId: U1, password: STRONG });
    const c2 = stubClient();
    c2.query = async (text, values) => {
      const norm = text.replace(/\s+/g, ' ').trim();
      c2.calls.push({ text: norm, values });
      if (/SELECT user_id FROM user_credential/.test(norm)) return { rows: [{ user_id: U1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const r = await make(c2).registerCredential({ userId: U1, password: STRONG });
    assert.strictEqual(r.rotated, true);
  });

  await test('findUserCredential reads the app_user LEFT JOIN by email', async () => {
    const c = stubClient({ findUser: { userId: U1, email: 'o@x', isOrigin: true, displayName: 'O', passwordHash: 'h', passwordSalt: 's' } });
    const r = await make(c).findUserCredential('o@x');
    assert.strictEqual(r.userId, U1);
    assert.strictEqual(r.isOrigin, true);
    assert.ok(/FROM app_user u LEFT JOIN user_credential c ON c\.user_id = u\.id/.test(c.calls[0].text));
    assert.strictEqual(c.calls[0].values[0], 'o@x');
  });

  console.log('\nSign-in attempts and the lockout history');

  await test('an attempt outcome outside the named three refuses before any statement', async () => {
    const c = stubClient();
    await assert.rejects(() => make(c).recordLoginAttempt({ email: 'x@y', outcome: 'MAYBE' }), /AUTH_ATTEMPT_OUTCOME_INVALID/);
    assert.strictEqual(c.calls.length, 0);
  });

  await test('the attempt INSERT carries the outcome verbatim; unknown users record null user_id', async () => {
    const c = stubClient();
    await make(c).recordLoginAttempt({ email: 'ghost@x', outcome: 'FAILURE' });
    assert.ok(/INSERT INTO login_attempt/.test(c.calls[0].text));
    assert.strictEqual(c.calls[0].values[1], null);
    await make(c).recordLoginAttempt({ email: 'o@x', userId: U1, outcome: 'SUCCESS' });
    assert.strictEqual(c.calls[1].values[1], U1);
    assert.strictEqual(c.calls[1].values[3], 'SUCCESS');
  });

  await test('failureStreak selects failures SINCE the last success and hands back ms instants', async () => {
    const t = Date.UTC(2026, 7, 31, 7, 55, 0, 0);
    const c = stubClient({ streak: [t - 60000, t] });
    const streak = await make(c).failureStreak(U1);
    assert.deepStrictEqual(streak, [t - 60000, t]);
    assert.ok(/at > COALESCE\(\(SELECT max\(at\) FROM login_attempt/.test(c.calls[0].text), 'the since-last-success boundary is in the SQL');
  });

  console.log('\nTOTP — wrapped at rest, unwrapped only under the injected key');

  await test('a malformed enrolment secret refuses before any statement', async () => {
    const c = stubClient();
    await assert.rejects(() => make(c).enrolMfa({ userId: U1, secret: 'not base32!!' }), /TOTP_SECRET_INVALID/);
    assert.strictEqual(c.calls.length, 0);
  });

  await test('the stored secret is the WRAPPED blob — never the plaintext; it unwraps under the same key only', async () => {
    const c = stubClient();
    await make(c).enrolMfa({ userId: U1, secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });
    assert.ok(/INSERT INTO mfa_enrolment/.test(c.calls[0].text), 'the enrolment INSERT is the only statement');
    const stored = c.calls[0].values[1];
    assert.notStrictEqual(stored, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.match(stored, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/, 'iv:tag:payload');
    const [iv, tag, payload] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm',
      crypto.createHash('sha256').update(WRAP).digest(), Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    assert.strictEqual(Buffer.concat([decipher.update(Buffer.from(payload, 'hex')), decipher.final()]).toString(), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  await test('mfaStatus unwraps the secret and converts the BIGINT step to a number (the int8 lesson)', async () => {
    const wrapped = (() => {
      const iv = Buffer.alloc(12, 1); const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(WRAP).digest(), iv);
      const enc = Buffer.concat([cipher.update('GEZDGNBVGY3TQOJQ', 'utf8'), cipher.final()]);
      return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
    })();
    const c = stubClient({ mfaRow: { secret: wrapped, verifiedAt: new Date(NOW), lastUsedStep: '987654' } });
    const s = await make(c).mfaStatus(U1);
    assert.strictEqual(s.enrolled, true);
    assert.strictEqual(s.verified, true);
    assert.strictEqual(s.secret, 'GEZDGNBVGY3TQOJQ');
    assert.strictEqual(s.lastUsedStep, 987654);
    assert.strictEqual(typeof s.lastUsedStep, 'number');
  });

  await test('mfaStatus on an unenrolled user reports honestly without statements of shame', async () => {
    const c = stubClient();
    const s = await make(c).mfaStatus(U1);
    assert.deepStrictEqual(s, { enrolled: false, verified: false, secret: null, lastUsedStep: null });
  });

  console.log('\nThe challenge — verify, advance the guard, refuse the replay');

  await test('a good code advances last_used_step with the row-level replay backstop in the WHERE', async () => {
    const wrapped = (() => {
      const iv = Buffer.alloc(12, 1); const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(WRAP).digest(), iv);
      const enc = Buffer.concat([cipher.update('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'utf8'), cipher.final()]);
      return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
    })();
    const c = stubClient({ mfaRow: { secret: wrapped, verifiedAt: null, lastUsedStep: null } });
    const code = auth.totp.codeAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', NOW.getTime());
    const r = await make(c).verifyTotp({ userId: U1, code });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.firstVerification, true, 'verified_at was NULL — this code confirmed the enrolment');
    const upd = c.calls.find((x) => /UPDATE mfa_enrolment/.test(x.text));
    assert.ok(upd, 'the guard advanced');
    assert.ok(/last_used_step IS NULL OR last_used_step < \$2/.test(upd.text), 'the row-level replay backstop rides the WHERE');
  });

  await test('a row-level loss (concurrent verifier) refuses as AUTH_MFA_REPLAY', async () => {
    const wrapped = (() => {
      const iv = Buffer.alloc(12, 1); const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(WRAP).digest(), iv);
      const enc = Buffer.concat([cipher.update('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'utf8'), cipher.final()]);
      return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
    })();
    const c = stubClient({ mfaRow: { secret: wrapped, verifiedAt: new Date(NOW), lastUsedStep: 100000 }, updateCount: 0 });
    const code = auth.totp.codeAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', NOW.getTime());
    const r = await make(c).verifyTotp({ userId: U1, code });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'AUTH_MFA_REPLAY');
  });

  await test('a wrong code refuses AUTH_MFA_INVALID; an unenrolled user refuses by name', async () => {
    const wrapped = (() => {
      const iv = Buffer.alloc(12, 1); const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(WRAP).digest(), iv);
      const enc = Buffer.concat([cipher.update('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'utf8'), cipher.final()]);
      return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
    })();
    const c = stubClient({ mfaRow: { secret: wrapped, verifiedAt: null, lastUsedStep: null } });
    const r = await make(c).verifyTotp({ userId: U1, code: '000000' });
    assert.strictEqual(r.reason, 'AUTH_MFA_INVALID');
    const c2 = stubClient();
    const r2 = await make(c2).verifyTotp({ userId: U1, code: '123456' });
    assert.strictEqual(r2.reason, 'AUTH_MFA_NOT_ENROLLED');
  });

  console.log('\nSessions — the token is hashed, never stored');

  await test('issuance stores ONLY the token hash; the raw token comes back exactly once', async () => {
    const c = stubClient();
    const r = await make(c).issueSession({ userId: U1, tenantId: T1, role: 'O', mfaOk: true });
    assert.match(r.token, /^[0-9a-f]{64}$/);
    const ins = c.calls.find((x) => /INSERT INTO user_session/.test(x.text));
    assert.ok(ins);
    const storedHash = ins.values[1];
    assert.strictEqual(storedHash, crypto.createHash('sha256').update(r.token).digest('hex'));
    assert.ok(!JSON.stringify(ins.values).includes(r.token), 'the raw token never rides a statement');
    assert.strictEqual(ins.values[5], true, 'mfa_ok explicit');
  });

  await test('resolution reads by hash, touches on read, and maps every non-ACTIVE state by name', async () => {
    const token = 'a'.repeat(64);
    const live = stubClient({ sessionRow: {
      id: 'sess-1', userId: U1, tenantId: T1, role: 'O', mfaOk: true,
      createdAt: new Date(NOW.getTime() - 60000), lastSeenAt: new Date(NOW.getTime() - 60000),
      absoluteExpiresAt: new Date(NOW.getTime() + 8 * 3600 * 1000), terminatedAt: null,
    } });
    const ok = await make(live).resolveSession(token);
    assert.strictEqual(ok.resolved, true);
    /* §14.28: the principal grows mustChange (additive) — the forced-change
     * posture rides every resolution, so routes can refuse a must-change
     * session by name (SESSION_MUST_CHANGE) before anything writes. */
    assert.deepStrictEqual(ok.principal, { userId: U1, role: 'O', mfaOk: true, isOrigin: false, mustChange: false, tenantCode: undefined });
    const touch = live.calls.find((x) => /UPDATE user_session SET last_seen_at/.test(x.text));
    assert.ok(touch, 'touch-on-read slides the idle window');

    const idle = stubClient({ sessionRow: {
      id: 'sess-1', userId: U1, tenantId: T1, role: 'O', mfaOk: true,
      createdAt: new Date(NOW.getTime() - 3600 * 1000), lastSeenAt: new Date(NOW.getTime() - 31 * 60 * 1000),
      absoluteExpiresAt: new Date(NOW.getTime() + 3600 * 1000), terminatedAt: null,
    } });
    const expired = await make(idle).resolveSession(token);
    assert.strictEqual(expired.resolved, false);
    assert.strictEqual(expired.reason, 'AUTH_SESSION_IDLE_EXPIRED');
    assert.ok(!idle.calls.some((x) => /UPDATE user_session SET last_seen_at/.test(x.text)), 'an expired session is never touched');

    const dead = stubClient({ sessionRow: {
      id: 'sess-1', userId: U1, tenantId: T1, role: 'O', mfaOk: true,
      createdAt: new Date(NOW.getTime() - 3600 * 1000), lastSeenAt: new Date(NOW.getTime() - 60000),
      absoluteExpiresAt: new Date(NOW.getTime() + 3600 * 1000), terminatedAt: new Date(NOW.getTime() - 1000),
    } });
    const terminated = await make(dead).resolveSession(token);
    assert.strictEqual(terminated.reason, 'AUTH_SESSION_TERMINATED');

    const unknown = stubClient();
    assert.strictEqual((await make(unknown).resolveSession('nope')).reason, 'AUTH_SESSION_UNKNOWN');
  });

  await test('termination is an UPDATE tombstone; an already-dead session reports honestly', async () => {
    const c = stubClient({ updateCount: 0 });
    const r = await make(c).terminateSession('x');
    assert.strictEqual(r.terminated, false);
    const c2 = stubClient();
    const r2 = await make(c2).terminateSession('x');
    assert.strictEqual(r2.terminated, true);
    assert.ok(/terminated_at IS NULL$/.test(c2.calls[0].text.trim()), 'the tombstone never double-writes');
  });

  await test('the tenant switcher refuses a zero-row move — no live session, no move', async () => {
    const c = stubClient({ updateCount: 0 });
    await assert.rejects(() => make(c).setSessionTenant('x', T1), /AUTH_SESSION_TENANT_UNCHANGED/);
    const c2 = stubClient();
    const r = await make(c2).setSessionTenant('x', T1);
    assert.strictEqual(r.moved, true);
  });

  console.log('\nClass-N emission — tenant-resolvable events ride the ledger');

  await test('session creation appends a Class-N block through the injected ledger factory', async () => {
    const blocks = [];
    const ledger = { appendBlock: async (b) => { blocks.push(b); return { seq: 1 }; } };
    const c = stubClient();
    await make(c, { ledger: { forTenant: (t) => (t === T1 ? ledger : null) } })
      .issueSession({ userId: U1, tenantId: T1, role: 'O', mfaOk: true });
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].class, 'N');
    assert.strictEqual(blocks[0].action, 'auth.session.created');
    assert.strictEqual(blocks[0].actor, U1);
  });

  await test('no ledger wired = no emission, no crash (login_attempt carries the record)', async () => {
    const c = stubClient();
    const r = await make(c).issueSession({ userId: U1, tenantId: T1, role: 'BYR', mfaOk: false });
    assert.ok(r.token);
  });

  console.log('\nattemptLogin — the composed sign-in flow');

  const wrappedSecret = (() => {
    const iv = Buffer.alloc(12, 1); const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(WRAP).digest(), iv);
    const enc = Buffer.concat([cipher.update('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
  })();
  const USER = { userId: U1, email: 'o@x', isOrigin: false, displayName: 'O', passwordHash: null, passwordSalt: null };
  const salt = Buffer.alloc(16, 3);
  USER.passwordHash = auth.password.hash(STRONG, salt);
  USER.passwordSalt = salt.toString('hex');
  const TENANT = { tenantId: T1, tenantCode: 'auth-alpha', role: 'O' };

  await test('an unknown email and a wrong password both refuse by name, attempt recorded', async () => {
    const c = stubClient();
    const r = await make(c).attemptLogin({ email: 'ghost@x', password: STRONG });
    assert.strictEqual(r.outcome, 'REFUSED');
    assert.strictEqual(r.reason, 'AUTH_INVALID_CREDENTIALS');
    const attempt = c.calls.find((x) => /INSERT INTO login_attempt/.test(x.text));
    assert.ok(attempt && attempt.values[1] === null, 'the unknown user records with user_id null');
    const c2 = stubClient({ findUser: USER });
    const r2 = await make(c2).attemptLogin({ email: 'o@x', password: 'WrongPassword!99' });
    assert.strictEqual(r2.reason, 'AUTH_INVALID_CREDENTIALS');
  });

  await test('a user with no active tenant_role refuses AUTH_NO_TENANT — never a silent empty session', async () => {
    const c = stubClient({ findUser: USER });
    const r = await make(c).attemptLogin({ email: 'o@x', password: STRONG });
    assert.strictEqual(r.outcome, 'REFUSED');
    assert.strictEqual(r.reason, 'AUTH_NO_TENANT');
  });

  await test('a locked account refuses AUTH_LOCKED with the attempt outcome LOCKED_OUT', async () => {
    const t0 = Date.UTC(2026, 7, 31, 7, 58, 0, 0);
    const c = stubClient({ findUser: USER, tenantRow: TENANT, streak: [0, 1, 2, 3, 4].map((i) => t0 + i * 60000) });
    const r = await make(c).attemptLogin({ email: 'o@x', password: STRONG });
    assert.strictEqual(r.outcome, 'REFUSED');
    assert.strictEqual(r.reason, 'AUTH_LOCKED');
    const attempt = c.calls.find((x) => /INSERT INTO login_attempt/.test(x.text));
    assert.ok(attempt && attempt.values[3] === 'LOCKED_OUT');
  });

  await test('an enrolled user\u2019s password step returns CHALLENGE_MFA — no session exists yet', async () => {
    const c = stubClient({ findUser: USER, tenantRow: TENANT, mfaRow: { secret: wrappedSecret, verifiedAt: new Date(NOW), lastUsedStep: null } });
    const r = await make(c).attemptLogin({ email: 'o@x', password: STRONG });
    assert.strictEqual(r.outcome, 'CHALLENGE_MFA');
    assert.strictEqual(r.tenantCode, 'auth-alpha');
    assert.ok(!c.calls.some((x) => /INSERT INTO user_session/.test(x.text)), 'no session at the challenge step');
  });

  await test('the code step issues the session with mfa_ok true and the tenant_role as the C3 principal', async () => {
    const c = stubClient({ findUser: USER, tenantRow: TENANT, mfaRow: { secret: wrappedSecret, verifiedAt: new Date(NOW), lastUsedStep: null } });
    const code = auth.totp.codeAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', NOW.getTime());
    const r = await make(c).attemptLogin({ email: 'o@x', password: STRONG, code });
    assert.strictEqual(r.outcome, 'ISSUE');
    assert.strictEqual(r.principal.role, 'O');
    assert.strictEqual(r.principal.mfaOk, true);
    const ins = c.calls.find((x) => /INSERT INTO user_session/.test(x.text));
    assert.ok(ins && ins.values[5] === true, 'mfa_ok explicit true');
  });

  await test('a user with no enrolment issues mfa_ok false — the vote gate holds the line instead', async () => {
    const c = stubClient({ findUser: USER, tenantRow: TENANT, mfaRow: null });
    const r = await make(c).attemptLogin({ email: 'o@x', password: STRONG });
    assert.strictEqual(r.outcome, 'ISSUE');
    assert.strictEqual(r.principal.mfaOk, false);
  });

  await test('a wrong code at the MFA step refuses AUTH_MFA_INVALID and records the failure', async () => {
    const c = stubClient({ findUser: USER, tenantRow: TENANT, mfaRow: { secret: wrappedSecret, verifiedAt: new Date(NOW), lastUsedStep: null } });
    const r = await make(c).attemptLogin({ email: 'o@x', password: STRONG, code: '000000' });
    assert.strictEqual(r.outcome, 'REFUSED');
    assert.strictEqual(r.reason, 'AUTH_MFA_INVALID');
  });

  /* ---- M-setup — §14.28: must_change + the re-authenticated rotation ----- */
  console.log('\n  M-setup — must_change and the rotation unit (D-049)');

  await test('registerCredential writes must_change when told — the setup posture', async () => {
    const c = stubClient({});
    await make(c).registerCredential({ userId: U1, password: STRONG, mustChange: true });
    const ins = c.calls.find((x) => /INSERT INTO user_credential/.test(x.text));
    assert.ok(ins, 'the credential INSERT missing');
    assert.ok(/must_change/.test(ins.text), 'the statement carries the must_change column');
    assert.strictEqual(ins.values[4], true, 'must_change lands TRUE (a password never chosen must not govern)');
  });

  await test('registerCredential without the flag stays byte-compatible — false', async () => {
    const c = stubClient({});
    await make(c).registerCredential({ userId: U1, password: STRONG });
    const ins = c.calls.find((x) => /INSERT INTO user_credential/.test(x.text));
    assert.strictEqual(ins.values[4], false, 'omitted mustChange → false (the pre-existing callers\u2019 shape)');
  });

  await test('resolveSession exposes mustChange from the LEFT JOIN — additive on the principal', async () => {
    const c = stubClient({ sessionRow: {
      id: 'sess-1', userId: U1, tenantId: T1, role: 'O', mfaOk: true, mustChange: true,
      createdAt: new Date(NOW.getTime() - 60000), lastSeenAt: new Date(NOW.getTime() - 60000),
      absoluteExpiresAt: new Date(NOW.getTime() + 8 * 3600 * 1000), terminatedAt: null,
    } });
    const ok = await make(c).resolveSession('tok');
    assert.strictEqual(ok.resolved, true);
    assert.strictEqual(ok.principal.mustChange, true, 'the forced-change posture rides every resolution');
    const sel = c.calls[0];
    assert.ok(/LEFT JOIN user_credential c ON c\.user_id = u\.id/.test(sel.text), 'the resolution joins the credential table');
    assert.ok(/c\.must_change AS "mustChange"/.test(sel.text), 'the SELECT names must_change');
  });

  await test('the ISSUE verdict carries mustChange from the credential row', async () => {
    const c = stubClient({ findUser: Object.assign({}, USER, { mustChange: true }), tenantRow: TENANT, mfaRow: null });
    const r = await make(c).attemptLogin({ email: 'o@x', password: STRONG });
    assert.strictEqual(r.outcome, 'ISSUE');
    assert.strictEqual(r.principal.mustChange, true, 'the login boundary hands the interstitial its fact');
  });

  await test('a wrong CURRENT password refuses the rotation by name — a rotation is a re-authentication', async () => {
    const c = stubClient({ findUser: Object.assign({}, USER, { passwordHash: auth.password.hash(STRONG, Buffer.alloc(16, 7)), passwordSalt: Buffer.alloc(16, 7).toString('hex'), mustChange: true }) });
    const r = await make(c).rotateCredential({ email: 'o@x', currentPassword: 'totally-wrong-Password-1!', newPassword: 'Another-Str0ng-Passphrase-9!', token: 'tok' });
    assert.strictEqual(r.outcome, 'REFUSED');
    assert.strictEqual(r.reason, 'AUTH_PASSWORD_CURRENT_INVALID');
    assert.ok(!c.calls.some((x) => /INSERT INTO user_credential/.test(x.text)), 'zero credential writes on a failed re-auth');
    const attempt = c.calls.find((x) => /INSERT INTO login_attempt/.test(x.text));
    assert.ok(attempt && attempt.values[3] === 'FAILURE', 'the failed re-auth is an audit record');
  });

  await test('a weak NEW password is refused by the pure floor before any statement', async () => {
    const c = stubClient({ findUser: Object.assign({}, USER, { passwordHash: auth.password.hash(STRONG, Buffer.alloc(16, 7)), passwordSalt: Buffer.alloc(16, 7).toString('hex') }) });
    const r = await make(c).rotateCredential({ email: 'o@x', currentPassword: STRONG, newPassword: 'short', token: 'tok' });
    assert.strictEqual(r.outcome, 'REFUSED');
    assert.strictEqual(r.reason, 'AUTH_PASSWORD_TOO_SHORT', 'the policy floor’s own code rides the refusal');
    assert.strictEqual(c.calls.length, 0, 'ZERO statements — the floor decided before the transaction even opened');
  });

  await test('the happy rotation clears must_change, keeps the caller\u2019s session, and terminates the others', async () => {
    const c = stubClient({ findUser: Object.assign({}, USER, { passwordHash: auth.password.hash(STRONG, Buffer.alloc(16, 7)), passwordSalt: Buffer.alloc(16, 7).toString('hex'), mustChange: true }), tenantRow: TENANT });
    const ledgerCalls = [];
    const fakeLedger = { appendBlock: async (b) => { ledgerCalls.push(b); return { ok: true }; } };
    const token = 'the-bearer-token';
    const r = await make(c, { ledger: { forTenant: () => fakeLedger } }).rotateCredential({ email: 'o@x', currentPassword: STRONG, newPassword: 'Another-Str0ng-Passphrase-9!', token });
    assert.strictEqual(r.outcome, 'ROTATED');
    const upd = c.calls.find((x) => /INSERT INTO user_credential/.test(x.text));
    assert.ok(upd && upd.values[4] === false, 'must_change cleared through the re-authenticated door');
    const others = c.calls.find((x) => /UPDATE user_session SET terminated_at/.test(x.text) && /token_hash <> /.test(x.text));
    assert.ok(others, 'the others-termination statement present');
    assert.ok(!others.values[1].includes(token), 'the RAW token never lands — only its SHA-256 excludes the caller');
    assert.strictEqual(ledgerCalls.length, 1, 'one Class-N block per active tenant membership');
    assert.strictEqual(ledgerCalls[0].action, 'auth.credential.rotated');
    assert.strictEqual(ledgerCalls[0].class, 'N');
    assert.strictEqual(ledgerCalls[0].reason, 'forced-change-cleared');
    assert.strictEqual(r.othersTerminated, 1, 'the stub counts the others-termination');
  });
})().then(async () => {
  await Promise.all(pending);
  console.log(`\n  auth-adapter (stub): ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
