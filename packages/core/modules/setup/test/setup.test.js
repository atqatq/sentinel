'use strict';
/* ============================================================================
 * setup (pure) — the §14.28 validators and the wizard's step derivation.
 * Named proof: setup/origin-bootstrap (the pure tier of it). The executor
 * pins live in packages/db/test/setup-adapter.test.js; the LIVE proof of
 * the door rides the CI db-rls job.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const SETUP = require(path.join(__dirname, '..'));
const TZ = ['Asia/Bahrain', 'Asia/Qatar', 'Asia/Riyadh', 'Europe/London'];

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

(async () => {
  console.log('\nsetup (pure) — the §14.28 command validators (D-049)');

  await test('the role ladder is the 0003 enum, verbatim and frozen', () => {
    assert.deepStrictEqual([...SETUP.ROLE_LADDER], ['O', 'SCM', 'SBR', 'BYR', 'DTA', 'VWR']);
    assert.ok(Object.isFrozen(SETUP.ROLE_LADDER), 'the ladder is frozen data');
  });

  await test('a well-formed tenant command passes and is normalized (trimmed)', () => {
    const r = SETUP.validateTenantCommand({ code: ' BahrainMP ', name: ' Bahrain MP ', currencyCode: 'BHD', timezone: 'Asia/Bahrain' }, { tzList: TZ });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.value, { code: 'BahrainMP', name: 'Bahrain MP', currencyCode: 'BHD', timezone: 'Asia/Bahrain' });
  });

  await test('the tenant command refuses every malformed shape BY NAME, with detail', () => {
    const bad = [
      [{}, 'object'],
      [{ code: 'A', name: 'x', currencyCode: 'BHD', timezone: 'Asia/Bahrain' }, 'code too short'],
      [{ code: 'Has Space', name: 'x', currencyCode: 'BHD', timezone: 'Asia/Bahrain' }, 'code charset'],
      [{ code: 'BahrainMP', name: '', currencyCode: 'BHD', timezone: 'Asia/Bahrain' }, 'name empty'],
      [{ code: 'BahrainMP', name: 'x', currencyCode: 'bhd', timezone: 'Asia/Bahrain' }, 'currency lowercase'],
      [{ code: 'BahrainMP', name: 'x', currencyCode: 'BHD', timezone: 'Mars/Olympus' }, 'unknown zone'],
      [{ code: 'BahrainMP', name: 'x', currencyCode: 'BHD', timezone: '' }, 'timezone empty'],
    ];
    for (const [cmd, why] of bad) {
      const r = SETUP.validateTenantCommand(cmd, { tzList: TZ });
      assert.strictEqual(r.ok, false, why);
      assert.strictEqual(r.reason, 'SETUP_SHAPE_INVALID', why);
      assert.ok(typeof r.detail === 'string' && r.detail.length > 0, why);
    }
  });

  await test('the timezone allowlist is INJECTED — a call without it refuses (no env, no IO)', () => {
    const r = SETUP.validateTenantCommand({ code: 'BahrainMP', name: 'x', currencyCode: 'BHD', timezone: 'Asia/Bahrain' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'SETUP_SHAPE_INVALID');
    assert.ok(/injected/.test(r.detail), 'the refusal names the injection contract');
  });

  await test('a well-formed user command passes; email is normalized to lower-case', () => {
    const r = SETUP.validateUserCommand({ email: ' Buyer@Example.COM ', displayName: 'Procurement Buyer', password: 'Whatever-They-Choose-1', role: 'BYR' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.value, { email: 'buyer@example.com', displayName: 'Procurement Buyer', password: 'Whatever-They-Choose-1', role: 'BYR' });
  });

  await test('an off-ladder role refuses SETUP_ROLE_INVALID — not a shape refusal', () => {
    const r = SETUP.validateUserCommand({ email: 'a@b.co', displayName: 'x', password: 'Whatever-1', role: 'SUPERUSER' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'SETUP_ROLE_INVALID');
  });

  await test('the user command refuses malformed email, empty display name, missing password', () => {
    for (const cmd of [
      { email: 'not-an-email', displayName: 'x', password: 'p' },
      { email: 'a@b.co', displayName: '', password: 'p' },
      { email: 'a@b.co', displayName: 'x', password: '' },
      { email: 'a@b.co', displayName: 'x' },
    ]) {
      const r = SETUP.validateUserCommand(cmd);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, 'SETUP_SHAPE_INVALID');
    }
  });

  await test('a well-formed limits command passes with null (unlimited) ceilings allowed', () => {
    const r = SETUP.validateLimitsCommand({ dualThresholdAmount: 1000, limits: [{ role: 'O', maxSingleAmount: null }, { role: 'SBR', maxSingleAmount: 5000 }, { role: 'SCM', maxSingleAmount: 50000 }] });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.limits.length, 3);
    assert.strictEqual(r.value.limits[0].maxSingleAmount, null);
  });

  await test('the limits command refuses zero/negative/floating garbage thresholds and duplicate roles', () => {
    assert.strictEqual(SETUP.validateLimitsCommand({ dualThresholdAmount: -1, limits: [{ role: 'SBR', maxSingleAmount: 5 }] }).ok, false);
    assert.strictEqual(SETUP.validateLimitsCommand({ dualThresholdAmount: Number.NaN, limits: [{ role: 'SBR', maxSingleAmount: 5 }] }).ok, false);
    assert.strictEqual(SETUP.validateLimitsCommand({ dualThresholdAmount: 1000, limits: [] }).ok, false);
    assert.strictEqual(SETUP.validateLimitsCommand({ dualThresholdAmount: 1000, limits: [{ role: 'SBR', maxSingleAmount: 0 }] }).ok, false);
    const dup = SETUP.validateLimitsCommand({ dualThresholdAmount: 1000, limits: [{ role: 'SBR', maxSingleAmount: 5 }, { role: 'SBR', maxSingleAmount: 6 }] });
    assert.strictEqual(dup.ok, false);
    assert.strictEqual(dup.reason, 'SETUP_SHAPE_INVALID');
    assert.ok(/duplicate/.test(dup.detail));
  });

  console.log('\nsetup (pure) — the wizard\'s remainingSteps (§14.10 order)');

  await test('a fresh deployment names ALL five steps in the §14.10 order', () => {
    const steps = SETUP.remainingSteps({ hasOrigin: false, tenantCount: 0, userCount: 0, hasApprovalLimits: false, hasFirstIngestion: false });
    assert.deepStrictEqual(steps.map((s) => s.step), ['origin', 'tenant', 'users', 'limits', 'ingest']);
    assert.ok(steps.every((s) => typeof s.label === 'string' && typeof s.detail === 'string'));
  });

  await test('completed steps go silent — the register carries GAPS, never confirmations', () => {
    const steps = SETUP.remainingSteps({ hasOrigin: true, tenantCount: 2, userCount: 5, hasApprovalLimits: false, hasFirstIngestion: true });
    assert.deepStrictEqual(steps.map((s) => s.step), ['limits']);
  });

  await test('a fully-set-up deployment is an EMPTY step list — setup is done', () => {
    const steps = SETUP.remainingSteps({ hasOrigin: true, tenantCount: 1, userCount: 2, hasApprovalLimits: true, hasFirstIngestion: true });
    assert.deepStrictEqual(steps, []);
  });

  await test('a malformed overview refuses SETUP_SHAPE_INVALID rather than guessing', () => {
    for (const bad of [null, undefined, 'x', [], 42]) {
      const steps = SETUP.remainingSteps(bad);
      assert.strictEqual(steps.length, 1);
      assert.strictEqual(steps[0].reason, 'SETUP_SHAPE_INVALID');
    }
  });

  await test('a resilient shape (nulls in the counts) keeps the steps OPEN, never crashes', () => {
    const steps = SETUP.remainingSteps({ hasOrigin: true, tenantCount: null, userCount: undefined, hasApprovalLimits: false, hasFirstIngestion: false });
    assert.deepStrictEqual(steps.map((s) => s.step), ['tenant', 'users', 'limits', 'ingest']);
  });
})().then(() => {
  console.log(`\n  setup (pure): ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
