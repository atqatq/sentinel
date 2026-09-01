// ---------------------------------------------------------------------------
// M12 gate 5 — dependency pinning (§14.18). The practice, generalized.
//
// Every package.json in the workspace (root included) must pin: every entry
// in `dependencies` and `devDependencies` is an EXACT version or the
// `workspace:*` protocol. Caret, tilde, star, >=, and x ranges refuse.
// `peerDependencies` are exempt — a library declares its compatibility range
// there; the CONSUMER's exact pin is what ships.
//
// The checker is PURE and exported; the named proof `security/gates` pins it
// against range fixtures and walks the REAL workspace (which must pass).
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, enumeratePackageJsonFiles } from './workspace.mjs';

// Exact semver: major.minor.patch with optional prerelease/build segments.
const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

export function isExact(range) {
  if (typeof range !== 'string') return false;
  if (range.startsWith('workspace:')) return true; // the pnpm protocol — resolved by the workspace itself
  return EXACT.test(range);
}

export function checkPinning(pkg) {
  if (pkg === null || typeof pkg !== 'object') throw new Error('PINNING_PAYLOAD_MALFORMED');
  const violations = [];
  for (const section of ['dependencies', 'devDependencies']) {
    const deps = pkg[section];
    if (deps === undefined) continue;
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
      throw new Error(`PINNING_PAYLOAD_MALFORMED: ${section}`);
    }
    for (const [name, range] of Object.entries(deps)) {
      if (!isExact(range)) violations.push({ name, range: String(range), section });
    }
  }
  return violations; // peerDependencies exempt by contract
}

export function main() {
  const violations = [];
  for (const rel of enumeratePackageJsonFiles()) {
    const abs = rel === 'package.json' ? join(REPO_ROOT, 'package.json') : join(REPO_ROOT, rel);
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      console.error(`pinning gate: unparseable ${rel} —`, err.message);
      process.exit(1);
    }
    for (const v of checkPinning(pkg)) violations.push({ file: rel, ...v });
  }
  if (violations.length) {
    console.error(`pinning gate: FAIL — ${violations.length} non-exact range(s):`);
    for (const v of violations) console.error(`  ${v.file}: ${v.name}@${v.range} (${v.section})`);
    process.exit(1);
  }
  console.log('pinning gate: clean — every dependency across the workspace is exact or workspace-protocol');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
