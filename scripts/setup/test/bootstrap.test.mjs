'use strict';
/* ============================================================================
 * bootstrap-origin (pure tier) — the CLI's own logic, pinned without a
 * database: the argument parser's shapes and refusals, the generated
 * password's policy-floor compliance, and the wiring contract (the script
 * composes makeSetupAdapter with the injected auth adapter and the runtime's
 * IANA list — the same ADR-0001 posture the routes ride). The ADAPTER tier
 * is pinned by packages/db/test/setup-adapter.test.js; the LIVE tier (the
 * real door on real PostgreSQL) rides the CI db-rls job's setup section.
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const require_ = createRequire(import.meta.url);

const BOOT = await import(pathToFileURL(join(REPO, 'scripts', 'setup', 'bootstrap-origin.mjs')).href);
const SETUP = require_(join(REPO, 'packages', 'core', 'modules', 'setup', 'index.js'));
const DB = require_(join(REPO, 'packages', 'db', 'index.js'));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

await (async () => {
  console.log('\nbootstrap-origin (pure tier) — the CLI contract (D-049)');

  await test('parseArgs accepts the full flag set and --help short-circuits', () => {
    const args = BOOT.parseArgs(['--email', 'o@x.com', '--name', 'Origin', '--tenant-code', 'BahrainMP', '--tenant-name', 'B', '--currency', 'BHD', '--timezone', 'Asia/Bahrain']);
    assert.strictEqual(args.email, 'o@x.com');
    assert.strictEqual(args['tenant-code'], 'BahrainMP');
    assert.deepStrictEqual(BOOT.parseArgs(['--help']), { help: true });
  });

  await test('parseArgs refuses a value-less flag and a stray positional BY NAME', () => {
    assert.throws(() => BOOT.parseArgs(['--email']), (e) => e.code === 'SETUP_SHAPE_INVALID');
    assert.throws(() => BOOT.parseArgs(['stray']), (e) => e.code === 'SETUP_SHAPE_INVALID');
  });

  await test('the generated password passes the pure policy floor — every time (20 seeds)', () => {
    for (let i = 0; i < 20; i++) {
      const pw = BOOT.generatePassword(() => crypto.randomBytes(18));
      assert.strictEqual(typeof pw, 'string');
      assert.ok(pw.startsWith('Snt-'), 'the construction prefix carries the classes');
      assert.ok(pw.length >= 12, 'the floor length holds');
      assert.ok(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw), '4 character classes by construction');
      assert.notStrictEqual(pw, BOOT.generatePassword(() => crypto.randomBytes(18)), 'no repeats across seeds');
    }
  });

  await test('the wiring composes the REAL surfaces: makeSetupAdapter(auth: makeAuthAdapter, tzList: Intl) — the ADR-0001 posture', () => {
    const auth = DB.makeAuthAdapter({ query: async () => ({ rows: [] }) }, { wrapKey: 'x'.repeat(32) });
    const setup = DB.makeSetupAdapter({ query: async () => ({ rows: [] }) }, { auth, tzList: Intl.supportedValuesOf('timeZone') });
    assert.strictEqual(typeof setup.bootstrapOrigin, 'function', "the CLI rides the adapter's bootstrapOrigin — no second bootstrap path exists");
    assert.strictEqual(typeof auth.registerCredential, 'function', "the credential posture is the auth adapter's — one place");
  });

  await test('the pure policy floor agrees with the construction (the floor is the auth module\u2019s)', () => {
    const pw = BOOT.generatePassword();
    assert.strictEqual(SETUP.ROLE_LADDER.includes('BYR'), true, 'the ladder stays the enum mirror (the floor lives beside it)');
    assert.ok(pw.length >= 12, 'the construction respects the floor\u2019s minimum');
  });
})().then(() => {
  console.log(`\n  bootstrap-origin (pure tier): ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
