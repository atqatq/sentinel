'use strict';
/* ============================================================================
 * Setup adapter (stub client) — the SQL mechanics of the §14.28 setup
 * layer without a database. Named proof: setup/origin-bootstrap (the
 * executor tier; the pure tier is packages/core/modules/setup's own suite;
 * the LIVE proof of the founder door rides the CI db-rls job's setup
 * section). Pins:
 *   - the statement shapes (the door call, the in-transaction GUCs, the
 *     upsert conflict targets, the per-tenant overview reads);
 *   - the zero-statement refusals (the pure validators decide FIRST);
 *   - the named translation of the database's own refusals (23505 →
 *     SETUP_TENANT_CODE_TAKEN / SETUP_EMAIL_TAKEN; 42501 →
 *     SETUP_TARGET_NOT_OWNED; the door's RAISE messages → the SETUP_ family);
 *   - the credential delegation: the injected auth adapter registers every
 *     credential with must_change true — the posture lives in ONE place.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));

const TZ = ['Asia/Bahrain', 'Asia/Qatar'];
const T1 = '22222222-2222-4222-8222-222222222222';
const O1 = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-04T08:00:00.000Z');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

/* A routing stub: regex → rows; everything recorded. */
function stubClient(routes) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      const norm = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: norm, values });
      for (const [re, rows] of routes) {
        if (re.test(norm)) return { rows: typeof rows === 'function' ? rows(values, norm) : rows, rowCount: Array.isArray(rows) ? rows.length : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

/* The injected fake auth adapter — records the credential calls. */
function fakeAuth() {
  const calls = [];
  return {
    calls,
    async registerCredential(a) { calls.push(a); return { rotated: false }; },
  };
}

function make(c, auth) {
  return DB.makeSetupAdapter(c, { auth: auth || fakeAuth(), tzList: TZ, now: () => NOW });
}

const GOOD_TENANT = { code: 'BahrainMP', name: 'Bahrain MP', currencyCode: 'BHD', timezone: 'Asia/Bahrain' };
const GOOD_USER = { email: 'buyer@x.com', displayName: 'Buyer', password: 'Str0ng-Passphrase-1!', role: 'BYR' };

(async () => {
  console.log('\nsetup-adapter (stub) — the bootstrap (§14.28 clause 1)');

  await test('config refuses without the injected auth adapter or the tz allowlist', () => {
    assert.throws(() => DB.makeSetupAdapter(stubClient([]), { tzList: TZ }), /SETUP_CONFIG_AUTH_REQUIRED/);
    assert.throws(() => DB.makeSetupAdapter(stubClient([]), { auth: fakeAuth() }), /SETUP_CONFIG_TZLIST_REQUIRED/);
  });

  await test('the bootstrap walks ONE transaction: pre-checks → origin INSERT (is_origin TRUE) → credential (must_change) → the founder door → COMMIT', async () => {
    const NEW = '99999999-9999-4999-8999-999999999999';
    const c = stubClient([
      [/INSERT INTO app_user/, [{ id: NEW }]],
      [/SELECT setup_create_tenant_with_founder/, [{ tenantId: T1 }]],
    ]);
    const auth = fakeAuth();
    const r = await make(c, auth).bootstrapOrigin({ email: ' O@X.com ', displayName: 'Origin', password: GOOD_USER.password, tenant: GOOD_TENANT });
    assert.ok(c.calls[0].text.startsWith('BEGIN'), 'the transaction opens first');
    assert.strictEqual(r.tenantCode, 'BahrainMP', 'the code is the normalized one');
    assert.strictEqual(r.originUserId, NEW);
    const u = c.calls.find((x) => /INSERT INTO app_user/.test(x.text));
    assert.ok(u && u.values[2] === true, 'is_origin TRUE — the migrator path');
    assert.strictEqual(auth.calls.length, 1);
    assert.strictEqual(auth.calls[0].mustChange, true, 'the bootstrap credential lands must_change (a password never chosen must not govern)');
    const door = c.calls.find((x) => /setup_create_tenant_with_founder/.test(x.text));
    assert.ok(door, 'the founder grant rides the DOOR — one code path even on the admin client');
    assert.strictEqual(door.values[4], r.originUserId, 'the door\u2019s actor is the new origin');
    assert.ok(c.calls.some((x) => x.text === 'COMMIT'));
  });

  await test('the bootstrap refuses an existing origin BY NAME with zero writes', async () => {
    const c = stubClient([
      [/SELECT id FROM app_user WHERE email/, [{ id: O1 }]],
    ]);
    const auth = fakeAuth();
    await assert.rejects(
      () => make(c, auth).bootstrapOrigin({ email: 'o@x.com', displayName: 'Origin', password: GOOD_USER.password, tenant: GOOD_TENANT }),
      (e) => e.code === 'SETUP_ORIGIN_EXISTS');
    assert.strictEqual(auth.calls.length, 0, 'no credential written');
    assert.ok(c.calls.some((x) => x.text === 'ROLLBACK'), 'the transaction rolled back — a failed run leaves nothing');
    assert.ok(!c.calls.some((x) => /INSERT INTO app_user/.test(x.text)));
  });

  await test('the bootstrap refuses a taken tenant code BY NAME', async () => {
    const c = stubClient([
      [/SELECT id FROM tenant WHERE code/, [{ id: T1 }]],
    ]);
    await assert.rejects(
      () => make(c).bootstrapOrigin({ email: 'o@x.com', displayName: 'Origin', password: GOOD_USER.password, tenant: GOOD_TENANT }),
      (e) => e.code === 'SETUP_TENANT_CODE_TAKEN');
  });

  await test('a malformed tenant command sends ZERO statements (the pure layer decided first)', async () => {
    const c = stubClient([]);
    await assert.rejects(
      () => make(c).bootstrapOrigin({ email: 'o@x.com', displayName: 'Origin', password: GOOD_USER.password, tenant: { code: 'A', name: 'x', currencyCode: 'BHD', timezone: 'Asia/Bahrain' } }),
      (e) => e.code === 'SETUP_SHAPE_INVALID');
    assert.strictEqual(c.calls.length, 0);
  });

  console.log('\nsetup-adapter (stub) — the founder door call (clause 3) and accounts (clause 4)');

  await test('createTenant rides the door with the actor param and maps the door\u2019s refusal by name', async () => {
    const c = stubClient([
      [/SELECT setup_create_tenant_with_founder/, [{ tenantId: T1 }]],
    ]);
    const r = await make(c).createTenant({ ...GOOD_TENANT, actorId: O1 });
    assert.strictEqual(r.tenantId, T1);
    const door = c.calls.find((x) => /setup_create_tenant_with_founder/.test(x.text));
    assert.strictEqual(door.values[4], O1);
    const c2 = stubClient([
      [/SELECT setup_create_tenant_with_founder/, () => { const e = new Error('SETUP_NOT_ORIGIN: actor is not an origin principal'); throw e; }],
    ]);
    await assert.rejects(() => make(c2).createTenant({ ...GOOD_TENANT, actorId: O1 }), (e) => e.code === 'SETUP_NOT_ORIGIN');
  });

  await test('createUserWithRole sets BOTH GUCs inside the transaction — controls_origin_only re-proves the O', async () => {
    const NEW = '99999999-9999-4999-8999-999999999999';
    const c = stubClient([
      [/SELECT id, code FROM tenant/, [{ id: T1, code: 'BahrainMP' }]],
      [/INSERT INTO app_user/, [{ id: NEW }]],
    ]);
    const auth = fakeAuth();
    const r = await make(c, auth).createUserWithRole({ ...GOOD_USER, tenantCode: 'BahrainMP', actorId: O1 });
    assert.strictEqual(r.role, 'BYR');
    assert.strictEqual(r.userId, NEW);
    const g1 = c.calls.find((x) => /set_config\('app\.tenant_id'/.test(x.text));
    const g2 = c.calls.find((x) => /set_config\('app\.actor_id'/.test(x.text));
    assert.ok(g1 && g1.values[0] === T1, 'tenant GUC transaction-local');
    assert.ok(g2 && g2.values[0] === O1, 'actor GUC transaction-local');
    assert.strictEqual(auth.calls[0].mustChange, true, 'every setup-created account changes its own password at first sign-in');
    const grant = c.calls.find((x) => /INSERT INTO tenant_role/.test(x.text));
    assert.ok(grant && grant.values[3] === O1, 'granted_by is the acting Origin');
  });

  await test('the database\u2019s 42501 on the grant surfaces named — SETUP_TARGET_NOT_OWNED', async () => {
    const e42501 = Object.assign(new Error('permission denied'), { code: '42501' });
    const c = stubClient([
      [/SELECT id, code FROM tenant/, [{ id: T1, code: 'BahrainMP' }]],
      [/INSERT INTO app_user/, [{ id: '99999999-9999-4999-8999-999999999999' }]],
      [/INSERT INTO tenant_role/, () => { throw e42501; }],
    ]);
    await assert.rejects(
      () => make(c).createUserWithRole({ ...GOOD_USER, tenantCode: 'BahrainMP', actorId: O1 }),
      (e) => e.code === 'SETUP_TARGET_NOT_OWNED');
  });

  await test('an unknown tenant code refuses SETUP_TENANT_UNKNOWN before any write', async () => {
    const c = stubClient([]);
    await assert.rejects(
      () => make(c).createUserWithRole({ ...GOOD_USER, tenantCode: 'Ghost', actorId: O1 }),
      (e) => e.code === 'SETUP_TENANT_UNKNOWN');
    assert.ok(!c.calls.some((x) => /INSERT INTO app_user/.test(x.text)));
  });

  console.log('\nsetup-adapter (stub) — the §16 amendment and the overview');

  await test('amendLimits upserts the config on (tenant_id) and the limits on (tenant_id, role)', async () => {
    const c = stubClient([
      [/SELECT currency_code FROM tenant/, [{ currency_code: 'BHD' }]],
    ]);
    const r = await make(c).amendLimits({
      dualThresholdAmount: 1000, tenantId: T1, actorId: O1,
      limits: [{ role: 'O', maxSingleAmount: null }, { role: 'SBR', maxSingleAmount: 5000 }],
    });
    assert.strictEqual(r.limitsUpdated, 2);
    const cfg = c.calls.find((x) => /INSERT INTO approval_config/.test(x.text));
    assert.ok(/ON CONFLICT \(tenant_id\) DO UPDATE/.test(cfg.text), 'the config upsert\u2019s conflict target');
    const lim = c.calls.filter((x) => /INSERT INTO approval_limit/.test(x.text));
    assert.strictEqual(lim.length, 2);
    assert.ok(/ON CONFLICT \(tenant_id, role\) DO UPDATE/.test(lim[0].text));
    assert.strictEqual(lim[0].values[2], null, 'the unlimited ceiling lands null');
  });

  await test('the overview: registry read crosses tenants BY DESIGN, the RLS\u2019d reads set the GUC PER TENANT, memberships ride the D-050 door', async () => {
    const t2 = '33333333-3333-4333-8333-333333333333';
    const c = stubClient([
      [/SELECT 1 AS ok FROM app_user WHERE is_origin/, [{ ok: 1 }]],
      [/SELECT id, code, name, currency_code/, [{ id: T1, code: 'BahrainMP', name: 'B', currencyCode: 'BHD', timezone: 'Asia/Bahrain', createdAt: NOW }, { id: t2, code: 'QatarMP', name: 'Q', currencyCode: 'QAR', timezone: 'Asia/Qatar', createdAt: NOW }]],
      [/FROM auth_user_tenants/, [{ tenantId: T1, role: 'O' }]],
      [/SELECT u.id, u.email/, [{ id: O1, email: 'o@x.com', displayName: 'O', role: 'O', grantedAt: NOW }]],
      [/FROM approval_config/, []],
      [/FROM approval_limit/, [{ role: 'O', maxSingleAmount: null }]],
      [/FROM ingest_file/, [{ ok: 1 }]],
    ]);
    const r = await make(c).setupOverview({ actorId: O1 });
    assert.strictEqual(r.hasOrigin, true);
    assert.strictEqual(r.tenantCount, 2);
    assert.strictEqual(r.userCount, 1, 'distinct users, deduped across tenants');
    const gucs = c.calls.filter((x) => /set_config\('app\.tenant_id'/.test(x.text));
    assert.strictEqual(gucs.length, 2, 'one GUC set per tenant, INSIDE the one transaction');
    const door = c.calls.find((x) => /FROM auth_user_tenants/.test(x.text));
    assert.ok(door, 'the caller\u2019s memberships ride the D-050 door');
    assert.strictEqual(r.tenants[0].myRole, 'O', 'the caller\u2019s role per tenant comes from the door');
    assert.strictEqual(r.tenants[0].hasFirstIngestion, true, 'the register\u2019s APPLIED row closes the ingestion step');
    assert.strictEqual(r.tenants[0].hasApprovalLimits, false);
    assert.ok(c.calls.some((x) => x.text === 'COMMIT'));
  });

  await test('the overview\u2019s numeric boundary: NUMERIC leaves as a number, null stays null', async () => {
    const c = stubClient([
      [/SELECT 1 AS ok FROM app_user WHERE is_origin/, []],
      [/SELECT id, code, name, currency_code/, [{ id: T1, code: 'B', name: 'B', currencyCode: 'BHD', timezone: 'Asia/Bahrain', createdAt: NOW }]],
      [/FROM auth_user_tenants/, []],
      [/SELECT u.id, u.email/, []],
      [/FROM approval_config/, [{ currencyCode: 'BHD', dualThresholdAmount: '1000.000000' }]],
      [/FROM approval_limit/, [{ role: 'SBR', maxSingleAmount: '5000.000000' }, { role: 'O', maxSingleAmount: null }]],
      [/FROM ingest_file/, []],
    ]);
    const r = await make(c).setupOverview({ actorId: O1 });
    assert.strictEqual(r.tenants[0].approvalConfig.dualThresholdAmount, 1000, 'NUMERIC → number (the read-path boundary, everywhere the same)');
    assert.strictEqual(r.tenants[0].approvalLimits[0].maxSingleAmount, 5000, 'NUMERIC → number');
    assert.strictEqual(r.tenants[0].approvalLimits[1].maxSingleAmount, null, 'null stays null (the unlimited ceiling)');
    assert.strictEqual(r.hasApprovalLimits, true);
  });
})().then(() => {
  console.log(`\n  setup-adapter (stub): ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
