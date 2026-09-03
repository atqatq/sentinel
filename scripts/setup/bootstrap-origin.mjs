#!/usr/bin/env node
'use strict';
/* ============================================================================
 * bootstrap-origin.mjs — the §14.28 clause-1 bootstrap (D-049; named proof
 * setup/origin-bootstrap).
 *
 * The migrator path, scripted: the SAME trust prepare-db.mjs carries
 * (DATABASE_URL_ADMIN — the deployment's admin connection), because
 * D-029's disclosed pattern (the first O per tenant is seeded by the
 * migrator path) IS this step. ONE transaction via makeSetupAdapter's
 * bootstrapOrigin: the Origin account (is_origin TRUE, credential
 * must_change TRUE) + the first tenant through the founder door.
 *
 * The generated password prints ONCE and is never stored in plaintext.
 * The bootstrap is NOT idempotent BY DESIGN: a completed run re-refuses
 * (SETUP_ORIGIN_EXISTS) — a second run that "succeeds" would be a silent
 * no-op hiding a forgotten credential.
 *
 * Usage:
 *   node scripts/setup/bootstrap-origin.mjs \
 *     --email origin@example.com --name 'Operations Origin' \
 *     --tenant-code BahrainMP --tenant-name 'Bahrain MP' \
 *     --currency BHD --timezone Asia/Bahrain [--password '...']
 *
 * Env: DATABASE_URL_ADMIN (default postgres://postgres:postgres@127.0.0.1:5433/sentinel),
 *      SESSION_WRAP_KEY (32+ chars — the auth adapter's injected posture).
 * ==========================================================================*/

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = join(__dirname, '..', '..');
const require_ = createRequire(join(REPO, 'packages', 'db', 'package.json'));

const DB = require_(join(REPO, 'packages', 'db', 'index.js'));

function usage() {
  console.log(`Usage:
  node scripts/setup/bootstrap-origin.mjs \\
    --email <origin email> --name '<display name>' \\
    --tenant-code <code> --tenant-name '<tenant name>' \\
    --currency <ISO 4217> --timezone <IANA zone> [--password <initial password>]

Env: DATABASE_URL_ADMIN (admin connection; the migrator path),
     SESSION_WRAP_KEY (32+ chars — the auth adapter's injected wrap key).`);
}

export function refuseCode(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}

/* The arg parser is exported (with the generator below) so the named proof
 * can pin it without a database. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (!a.startsWith('--')) throw refuseCode('SETUP_SHAPE_INVALID', `unexpected argument '${a}'`);
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw refuseCode('SETUP_SHAPE_INVALID', `--${key} needs a value`);
    args[key] = value;
    i++;
  }
  return args;
}

/* The generated password passes the pure policy floor BY CONSTRUCTION,
 * not by luck: the prefix carries upper/lower/other ('-'), and two digits
 * derived from the random buffer are appended — a 0.4%-per-char lottery on
 * base64url's digit distribution would otherwise flake the classes (the
 * suite's own pin caught exactly that). Prints ONCE, never stored. */
export function generatePassword(rng) {
  const random = (rng || (() => randomBytes(18)))();
  const digits = `${random[0] % 10}${random[1] % 10}`;
  return 'Snt-' + random.toString('base64url') + digits;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    usage();
    process.exit(1);
  }
  if (parsed.help) { usage(); process.exit(0); }

  const required = ['email', 'name', 'tenant-code', 'tenant-name', 'currency', 'timezone'];
  for (const k of required) {
    if (typeof parsed[k] !== 'string' || parsed[k].trim() === '') {
      console.error(`✗ SETUP_SHAPE_INVALID: --${k} is required`);
      usage();
      process.exit(1);
    }
  }

  const wrapKey = process.env.SESSION_WRAP_KEY || '';
  if (wrapKey.length < 32) {
    console.error('✗ SESSION_WRAP_KEY is not configured (32+ chars required) — the auth adapter refuses to register a credential without its injected wrap key.');
    process.exit(1);
  }

  const password = parsed.password || generatePassword();
  const generated = !parsed.password;

  const adminUrl = process.env.DATABASE_URL_ADMIN || 'postgres://postgres:postgres@127.0.0.1:5433/sentinel';
  const { Client } = require_('pg');
  const db = new Client({ connectionString: adminUrl });
  await db.connect();

  try {
    const setup = DB.makeSetupAdapter(db, {
      auth: DB.makeAuthAdapter(db, { wrapKey }),
      tzList: Intl.supportedValuesOf('timeZone'),
    });
    const r = await setup.bootstrapOrigin({
      email: parsed.email,
      displayName: parsed.name,
      password,
      tenant: {
        code: parsed['tenant-code'],
        name: parsed['tenant-name'],
        currencyCode: parsed.currency,
        timezone: parsed.timezone,
      },
    });
    console.log('✓ the Origin bootstrap landed — ONE transaction, nothing half-committed:');
    console.log(`    origin user : ${parsed.email} (${r.originUserId})`);
    console.log(`    first tenant: ${r.tenantCode} (${r.tenantId})`);
    console.log('    founder role: O — granted_by the origin, by the door');
    console.log('');
    if (generated) {
      console.log('  THE PASSWORD — printed ONCE, never stored in plaintext:');
      console.log(`    ${password}`);
      console.log('');
    } else {
      console.log('  password: provided via --password (not printed).');
    }
    console.log('  The account lands with must_change — sign in at / and rotate the');
    console.log('  password before anything else (a password the account has never');
    console.log('  chosen must not govern a setup). Then the /setup wizard carries');
    console.log('  the rest: tenants, accounts, roles, limits, first ingestion');
    console.log('  (§14.10 — no seed script, ever).');
  } catch (e) {
    const code = e && e.code ? e.code : 'SETUP_BOOTSTRAP_FAILED';
    console.error(`✗ ${code}: ${e.message.replace(/^[A-Z_]+: /, '')}`);
    if (code === 'SETUP_ORIGIN_EXISTS') {
      console.error('  The bootstrap is not idempotent BY DESIGN — a completed run re-refuses.');
      console.error("  Rotate the existing account's credential instead (POST /api/auth/password).");
    }
    process.exit(1);
  } finally {
    await db.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) void main();
