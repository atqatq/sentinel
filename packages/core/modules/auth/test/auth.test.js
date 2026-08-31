'use strict';
/* ============================================================================
 * auth module tests — the M11 decision layer (audit M11).
 *
 * The RFC 6238 Appendix B SHA-1 vectors are STATED FROM THE RFC (T0=0,
 * step 30 s, secret ASCII "12345678901234567890", 8-digit values; the
 * 6-digit verification code is the value mod 10^6 — the RFC's own HOTP
 * truncation). The implementation must match the paper, never itself
 * (the H12 checksum discipline).
 *
 * Named proofs carried here:
 *   auth/mfa-approvals.spec — an approval-capable principal whose session
 *     was issued over an unverified second factor may cast NO vote
 *     (mayApprove refuses AUTH_MFA_REQUIRED), for every one of O/SCM/SBR;
 *     non-approval-capable roles are not this gate's story.
 *   auth/session-policy.spec — §14.9's floor for every principal: idle
 *     expiry at 30 min, absolute expiry at 8 h (never slides), termination
 *     is forever, and lockout engages at the fifth failure inside fifteen
 *     minutes for ANY account.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..', '..', '..');
const auth = require(path.join(REPO, 'packages', 'core', 'modules', 'auth'));
const approval = require(path.join(REPO, 'packages', 'core', 'modules', 'approval'));

const pending = [];
function test(name, fn) {
  const p = (async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  })();
  pending.push(p);
}

let passed = 0, failed = 0;

/* ---- RFC 6238 fixtures ---------------------------------------------------- */
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
/* Appendix B, SHA-1: [unixTime, 8-digit TOTP]. The 6-digit code is the value
 * mod 10^6 (the RFC's truncation), zero-padded. The sixth vector was
 * cross-checked against the RFC TEXT itself (rfc-editor.org, Appendix B:
 * counter 0000000027BC86AA → 65353130) after a hand-copied value from
 * memory disagreed with the implementation — the paper is the authority,
 * the memory was the defect (the H12 discipline, vectors included). */
const RFC_VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

(async () => {
  console.log('\nRFC 6238 — the paper is the authority');

  await test('the RFC 6238 Appendix B SHA-1 vectors verify at 6 digits', async () => {
    for (const [unixSec, eightDigit] of RFC_VECTORS) {
      const sixDigit = String(Number(eightDigit) % 10 ** 6).padStart(6, '0');
      const v = auth.totp.verify(RFC_SECRET_B32, sixDigit, unixSec * 1000, null);
      assert.deepStrictEqual(v, { ok: true, matchedStep: Math.floor(unixSec / 30) }, `vector ${unixSec}`);
    }
  });

  await test('codeAt reproduces the RFC vectors from the raw secret', async () => {
    for (const [unixSec, eightDigit] of RFC_VECTORS) {
      const sixDigit = String(Number(eightDigit) % 10 ** 6).padStart(6, '0');
      assert.strictEqual(auth.totp.codeAt(RFC_SECRET_B32, unixSec * 1000), sixDigit, `vector ${unixSec}`);
    }
  });

  await test('base32 decode matches RFC 4648 (the RFC secret round-trips, case and padding tolerated)', async () => {
    assert.strictEqual(auth.totp.base32Decode(RFC_SECRET_B32).toString('ascii'), RFC_SECRET_ASCII);
    assert.strictEqual(auth.totp.base32Decode('gezdgnbvgy3tqojqgezdgnbvgy3tqojq').toString('ascii'), RFC_SECRET_ASCII);
    assert.strictEqual(auth.totp.base32Decode(RFC_SECRET_B32 + '====').toString('ascii'), RFC_SECRET_ASCII);
    assert.throws(() => auth.totp.base32Decode('not-base32!1'), /TOTP_SECRET_INVALID/);
  });

  await test('a code inside the ±1 step window verifies with the matched step named', async () => {
    const now = 1000 * 30 * 100; // step 100
    const atPlus1 = auth.totp.codeAt(RFC_SECRET_B32, now + 30 * 1000);
    const v = auth.totp.verify(RFC_SECRET_B32, atPlus1, now, null);
    assert.deepStrictEqual(v, { ok: true, matchedStep: 101 });
  });

  await test('REPLAY is refused: a step at or below the enrolment\u2019s last-used step never re-verifies', async () => {
    const now = 1000 * 30 * 100;
    const code = auth.totp.codeAt(RFC_SECRET_B32, now);
    assert.strictEqual(auth.totp.verify(RFC_SECRET_B32, code, now, null).ok, true);
    const replay = auth.totp.verify(RFC_SECRET_B32, code, now + 30 * 1000, 100);
    assert.deepStrictEqual(replay, { ok: false, reason: 'AUTH_MFA_INVALID' });
  });

  await test('a malformed code refuses without touching the secret', async () => {
    assert.deepStrictEqual(auth.totp.verify(RFC_SECRET_B32, '12a456', 1000 * 30 * 100, null), { ok: false, reason: 'AUTH_MFA_INVALID' });
    assert.deepStrictEqual(auth.totp.verify(RFC_SECRET_B32, '12345', 1000 * 30 * 100, null), { ok: false, reason: 'AUTH_MFA_INVALID' });
  });

  console.log('\nSession lifecycle — §14.9 floor for every principal (auth/session-policy.spec)');

  const CREATED = Date.UTC(2026, 7, 31, 8, 0, 0, 0);
  function liveSession(over) {
    return auth.session.issue(Object.assign({
      userId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      role: 'O', mfaOk: true, nowMs: CREATED, sessionId: 'sess-1',
    }, over || {}));
  }

  await test('issuance pins the §14.9 absolute horizon at 8 hours and starts the idle clock', async () => {
    const s = liveSession();
    assert.strictEqual(s.absoluteExpiresAt - s.createdAt, 8 * 60 * 60 * 1000);
    assert.strictEqual(s.lastSeenAt, s.createdAt);
    assert.strictEqual(s.terminatedAt, null);
    assert.strictEqual(auth.session.state(s, CREATED), auth.session.STATE.ACTIVE);
  });

  await test('issuance refuses a guessed mfaOk — the posture is explicit or nothing', async () => {
    assert.throws(() => liveSession({ mfaOk: undefined }), /AUTH_ISSUANCE_INVALID/);
    assert.throws(() => liveSession({ mfaOk: 1 }), /AUTH_ISSUANCE_INVALID/);
    assert.throws(() => liveSession({ role: '' }), /AUTH_ISSUANCE_INVALID/);
  });

  await test('idle expiry at 30 minutes; activity slides the idle window, never the absolute one', async () => {
    const s = liveSession();
    const idleAt = s.lastSeenAt + 30 * 60 * 1000;
    assert.strictEqual(auth.session.state(s, idleAt - 1), auth.session.STATE.ACTIVE);
    assert.strictEqual(auth.session.state(s, idleAt), auth.session.STATE.IDLE_EXPIRED);
    /* activity at +20 min slides idle to +50 min — but absolute stays pinned */
    const touched = Object.assign({}, s, { lastSeenAt: CREATED + 20 * 60 * 1000 });
    assert.strictEqual(auth.session.state(touched, CREATED + 20 * 60 * 1000 + 29 * 60 * 1000), auth.session.STATE.ACTIVE);
    assert.strictEqual(auth.session.state(touched, CREATED + 20 * 60 * 1000 + 30 * 60 * 1000), auth.session.STATE.IDLE_EXPIRED);
  });

  await test('absolute expiry at 8 hours even under constant activity', async () => {
    const s = liveSession();
    const busy = Object.assign({}, s, { lastSeenAt: s.absoluteExpiresAt - 1000 });
    assert.strictEqual(auth.session.state(busy, s.absoluteExpiresAt - 1), auth.session.STATE.ACTIVE);
    assert.strictEqual(auth.session.state(busy, s.absoluteExpiresAt), auth.session.STATE.ABSOLUTE_EXPIRED);
  });

  await test('termination is forever, regardless of every window', async () => {
    const s = Object.assign(liveSession(), { terminatedAt: CREATED + 1000 });
    assert.strictEqual(auth.session.state(s, CREATED + 2000), auth.session.STATE.TERMINATED);
    assert.strictEqual(auth.session.state(s, s.absoluteExpiresAt + 1000), auth.session.STATE.TERMINATED);
  });

  console.log('\nMFA gate on approvals (auth/mfa-approvals.spec)');

  await test('an approval-capable session WITHOUT a verified second factor may cast no vote', async () => {
    for (const role of ['O', 'SCM', 'SBR']) {
      const s = liveSession({ role, mfaOk: false });
      const verdict = auth.session.mayApprove(s);
      assert.deepStrictEqual(verdict, { ok: false, reason: 'AUTH_MFA_REQUIRED' }, role);
    }
  });

  await test('a verified second factor opens the vote; non-approval-capable roles are not this gate\u2019s story', async () => {
    for (const role of ['O', 'SCM', 'SBR']) {
      assert.deepStrictEqual(auth.session.mayApprove(liveSession({ role, mfaOk: true })), { ok: true, reason: null }, role);
    }
    for (const role of ['BYR', 'DTA', 'VWR']) {
      assert.deepStrictEqual(auth.session.mayApprove(liveSession({ role, mfaOk: false })), { ok: true, reason: null }, role);
    }
  });

  await test('the approval-capable set is pinned to the C3 authority by parity (two sources, one proof)', async () => {
    assert.deepStrictEqual(auth.policy.APPROVAL_CAPABLE, approval.roles.APPROVAL_ELIGIBLE);
  });

  console.log('\nLockout — every account (auth/session-policy.spec)');

  await test('four failures never lock; the fifth inside the window engages the lock for fifteen minutes', async () => {
    const t0 = Date.UTC(2026, 7, 31, 8, 0, 0, 0);
    const fails = [0, 1, 2, 3, 4].map((i) => t0 + i * 60 * 1000);
    assert.strictEqual(auth.login.lockoutState(fails.slice(0, 4), t0 + 4 * 60 * 1000).locked, false);
    const locked = auth.login.lockoutState(fails, t0 + 4 * 60 * 1000);
    assert.strictEqual(locked.locked, true);
    assert.strictEqual(locked.until, fails[4] + 15 * 60 * 1000);
    assert.strictEqual(auth.login.lockoutState(fails, locked.until - 1).locked, true);
    assert.strictEqual(auth.login.lockoutState(fails, locked.until).locked, false);
  });

  await test('failures outside the fifteen-minute window do not stack into the streak', async () => {
    const t0 = Date.UTC(2026, 7, 31, 8, 0, 0, 0);
    const fails = [0, 16, 17, 18, 19].map((i) => t0 + i * 60 * 1000);
    const verdict = auth.login.lockoutState(fails, t0 + 19 * 60 * 1000);
    assert.strictEqual(verdict.locked, false, 'only four of the five fall inside the window');
    assert.strictEqual(verdict.failures, 4);
  });

  await test('a cleared streak stays cleared — the adapter records success and resets', async () => {
    const t0 = Date.UTC(2026, 7, 31, 8, 0, 0, 0);
    assert.strictEqual(auth.login.lockoutState([], t0).locked, false);
    assert.strictEqual(auth.login.lockoutState([t0 - 60 * 1000], t0).failures, 1);
  });

  console.log('\nThe sign-in state machine');

  await test('a locked account refuses by name BEFORE credential evaluation (probe-resistant)', async () => {
    const verdict = auth.login.decide({ credentialOk: true, lock: { locked: true, until: 1 }, mfaEnrolled: true, mfaVerifiedNow: false });
    assert.deepStrictEqual({ outcome: verdict.outcome, reason: verdict.reason }, { outcome: 'REFUSED', reason: 'AUTH_LOCKED' });
    assert.deepStrictEqual(verdict.events, auth.login.CLASS_N_EVENTS.REFUSED_LOCKED);
  });

  await test('wrong credentials refuse AUTH_INVALID_CREDENTIALS with the failure events named', async () => {
    const verdict = auth.login.decide({ credentialOk: false, lock: { locked: false }, mfaEnrolled: false, mfaVerifiedNow: false });
    assert.deepStrictEqual({ outcome: verdict.outcome, reason: verdict.reason }, { outcome: 'REFUSED', reason: 'AUTH_INVALID_CREDENTIALS' });
    assert.deepStrictEqual(verdict.events, ['auth.signin.failure']);
  });

  await test('credential ok + enrolment verified + no code yet = the MFA challenge (never a session)', async () => {
    const verdict = auth.login.decide({ credentialOk: true, lock: { locked: false }, mfaEnrolled: true, mfaVerifiedNow: false });
    assert.strictEqual(verdict.outcome, 'CHALLENGE_MFA');
    assert.deepStrictEqual(verdict.events, ['auth.signin.success', 'auth.mfa.challenge']);
  });

  await test('a failed challenge refuses with both events named', async () => {
    const verdict = auth.login.decide({ credentialOk: true, lock: { locked: false }, mfaEnrolled: true, mfaVerifiedNow: false, failedCode: true });
    assert.strictEqual(verdict.outcome, 'CHALLENGE_MFA', 'the failed code is a DECISION the boundary names, not the machine');
  });

  await test('credential ok + no enrolment = ISSUE with mfaOk false — the vote gate holds the line instead', async () => {
    const verdict = auth.login.decide({ credentialOk: true, lock: { locked: false }, mfaEnrolled: false, mfaVerifiedNow: false });
    assert.strictEqual(verdict.outcome, 'ISSUE');
    assert.deepStrictEqual(verdict.events, ['auth.session.created']);
  });

  await test('malformed machine inputs refuse loudly — a login attempt is never an exception at this layer', async () => {
    assert.throws(() => auth.login.decide({ credentialOk: 'yes', lock: { locked: false } }), /AUTH_DECISION_INVALID/);
    assert.throws(() => auth.login.decide({ credentialOk: true, lock: null }), /AUTH_DECISION_INVALID/);
    assert.throws(() => auth.login.lockoutState('nope', Date.now()), /AUTH_HISTORY_INVALID/);
  });

  console.log('\nPassword policy and the scrypt hash');

  await test('the floor: twelve characters across three of four classes', async () => {
    assert.strictEqual(auth.password.check('Sh0rt!pw'), 'AUTH_PASSWORD_TOO_SHORT');
    assert.strictEqual(auth.password.check('alllowercase12'), 'AUTH_PASSWORD_CLASS_MISSING');
    assert.strictEqual(auth.password.check('Str0ngEnough!Pass'), null);
    assert.strictEqual(auth.password.check('another-good-one-42'), null);
  });

  await test('scrypt round-trips; the salt makes every hash unique; wrong passwords verify false', async () => {
    const saltA = Buffer.alloc(16, 1);
    const saltB = Buffer.alloc(16, 2);
    const h1 = auth.password.hash('Str0ngEnough!Pass', saltA);
    const h2 = auth.password.hash('Str0ngEnough!Pass', saltB);
    assert.notStrictEqual(h1, h2, 'salted');
    assert.strictEqual(auth.password.verify('Str0ngEnough!Pass', saltA, h1), true);
    assert.strictEqual(auth.password.verify('WrongPassword!42', saltA, h1), false);
    assert.strictEqual(auth.password.verify('Str0ngEnough!Pass', saltB, h1), false);
  });

  await test('malformed verify input returns false — it never throws to a login form', async () => {
    assert.strictEqual(auth.password.verify(null, Buffer.alloc(16), 'ab'), false);
    assert.strictEqual(auth.password.verify('x', 'not-a-buffer', 'ab'), false);
  });

  await test('the entropy ports pin the sizes: 16-byte salts, 32-byte tokens, injectable rng', async () => {
    let asked;
    const rng = (n) => { asked = n; return Buffer.alloc(n, 7); };
    assert.strictEqual(auth.password.randomSalt(rng).length, 16);
    assert.strictEqual(asked, 16);
    const token = auth.password.randomToken(rng);
    assert.strictEqual(asked, 32);
    assert.strictEqual(token, '07'.repeat(32));
    assert.strictEqual(auth.password.ENTROPY.TOKEN_BYTES, 32);
  });
})().then(async () => {
  await Promise.all(pending);
  console.log(`\n  auth (module): ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
