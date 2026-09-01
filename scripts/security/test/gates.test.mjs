// ---------------------------------------------------------------------------
// M12 CI security gates — the named proof `security/gates` (§14.18).
// THE AUDIT'S NAMED ACCEPTANCE SHAPE (SENTINEL_DEEP_TECHNICAL_AUDIT M12 [S]):
// "Acceptance test: CI config review + one deliberately vulnerable fixture
// dependency caught."
//
// This suite is the CI config review, machine-checked: the gate surface is
// parsed out of the REAL workflow text, so a gate removed or weakened fails
// the same push that removed it. Every verdict logic the gates use is pinned
// against fixtures — including the deliberately vulnerable dependency audit
// payload (a real advisory shape for a known-vulnerable range) that MUST be
// caught and named.
// ==========================================================================*/
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { auditVerdict, FAIL_AT } from '../audit-gate.mjs';
import { evaluateLicense, verdictForPackage, ALLOWED, splitTopLevel } from '../license-gate.mjs';
import { checkPinning, isExact } from '../pinning-gate.mjs';
import { scanContent, collectRuntimeFiles, RUNTIME_DIRS } from '../closed-ecosystem-gate.mjs';
import { enumeratePackageJsonFiles, REPO_ROOT } from '../workspace.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const CI = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const GITLEAKS = readFileSync(join(REPO_ROOT, '.gitleaks.toml'), 'utf8');
const ROOT_PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

// The security job block: from its id line to the next job id (two-space indent).
const jobBlock = (() => {
  const lines = CI.split('\n');
  const start = lines.findIndex((l) => /^  security:\s*$/.test(l));
  assert.ok(start >= 0, 'ci.yml has no `security:` job');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-z][a-z0-9-]*:\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
})();

console.log('CI config review — the gate surface, machine-checked:');

test('the security job is named for the milestone and runs unconditionally', () => {
  assert.ok(/name:\s*Security gates \(M12/.test(jobBlock), 'job name must cite M12');
  assert.ok(!/continue-on-error/.test(jobBlock), 'a gate that can be bypassed without a record is not a gate');
  assert.ok(!/if:\s*$/.test(jobBlock) && !/if:\s*\S/.test(jobBlock), 'no conditional skip in the security job');
});

test('gate 1 dependency audit — the pure wrapper is the step, fail-on-high+ contract wired', () => {
  assert.ok(jobBlock.includes('node scripts/security/audit-gate.mjs'), 'audit gate step must run the wrapper');
  assert.strictEqual(FAIL_AT, 'high');
});

test('gate 2 secret scanning — gitleaks pinned, full history, default ruleset unmodified', () => {
  assert.ok(jobBlock.includes('gitleaks/gitleaks-action@v2'), 'the gitleaks action must be pinned');
  assert.ok(jobBlock.includes('GITLEAKS_VERSION: v8.24.3'), 'the gitleaks binary version must be pinned');
  assert.ok(jobBlock.includes('fetch-depth: 0'), 'full history requires fetch-depth 0');
  assert.ok(!/\[\[rules\]\]/.test(GITLEAKS), 'no custom rules — the default ruleset runs UNMODIFIED');
  assert.ok(/\[extend\]/.test(GITLEAKS) && /useDefault\s*=\s*true/.test(GITLEAKS), 'extend defaults');
  assert.ok(/^\[allowlist\]$/m.test(GITLEAKS), 'the singular [allowlist] form (array-of-tables is silently ignored)');
});

test('gate 2 allowlist — the naming discipline: exactly one entry, and it names why', () => {
  const descriptions = [...GITLEAKS.matchAll(/^description\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  assert.strictEqual(descriptions.length, 1, `exactly one allowlist entry, found ${descriptions.length}`);
  assert.ok(/RFC 6238/.test(descriptions[0]), 'the entry must NAME why it is safe (the RFC 6238 vector)');
  assert.ok(GITLEAKS.includes('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 'the RFC 6238 Appendix-B vector is the allowed secret');
  assert.ok(/regexTarget\s*=\s*"secret"/.test(GITLEAKS), 'allowlist targets the secret exactly — nothing wider than necessary');
});

test('gate 3 license scan — the expression-evaluated fail-closed gate is the step', () => {
  assert.ok(jobBlock.includes('node scripts/security/license-gate.mjs'), 'license gate step');
  for (const lic of ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'MPL-2.0', 'CC-BY-3.0', 'CC-BY-4.0', 'Unicode-3.0']) {
    assert.ok(ALLOWED.includes(lic), `allow-list carries ${lic}`);
  }
  assert.strictEqual(ALLOWED.length, 13);
});

test('gate 4 SBOM — Syft SPDX-2.3 generated and published per run', () => {
  assert.ok(jobBlock.includes('anchore/sbom-action@v0'), 'the Syft action must be pinned');
  assert.ok(jobBlock.includes('format: spdx-json'), 'SPDX JSON format (§10 DoD 5 pairs it with the checksums manifest)');
  assert.ok(jobBlock.includes('artifact-name: sentinel-sbom.spdx.json'), 'the artifact is published with the run');
});

test('gate 5 pinning — the exact-version gate is the step', () => {
  assert.ok(jobBlock.includes('node scripts/security/pinning-gate.mjs'), 'pinning gate step');
});

test('gate 6 closed-ecosystem grep — the egress backstop is the step', () => {
  assert.ok(jobBlock.includes('node scripts/security/closed-ecosystem-gate.mjs'), 'egress gate step');
});

test('the gates run on an installed frozen lockfile, and the proof reviews the gates', () => {
  assert.ok(jobBlock.includes('pnpm install --frozen-lockfile'), 'the license scan and audit need the resolved tree');
  assert.ok(jobBlock.includes('node scripts/security/test/gates.test.mjs'), 'the named proof runs IN the job it audits');
});

test('the battery chains the proof — a removed gate fails locally too', () => {
  assert.ok(ROOT_PKG.scripts['test:security']?.includes('gates.test.mjs'), 'test:security exists');
  assert.ok(ROOT_PKG.scripts.test.includes('test:security'), 'the root battery chains test:security');
});

console.log('dependency audit — the deliberately vulnerable fixture is CAUGHT:');

test('a real advisory shape for a known-vulnerable range is caught and NAMED', () => {
  // CVE-2021-23337 / GHSA-c2qf-rxjj-qqgw — lodash command injection, fixed 4.17.21.
  const payload = { advisories: { a1: { module_name: 'lodash', severity: 'high', github_advisory_id: 'GHSA-c2qf-rxjj-qqgw', vulnerable_versions: '<4.17.21', title: 'Command Injection in lodash' } } };
  const v = auditVerdict(payload);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.failing.length, 1);
  assert.strictEqual(v.failing[0].module, 'lodash');
  assert.strictEqual(v.failing[0].severity, 'high');
  assert.strictEqual(v.failing[0].id, 'GHSA-c2qf-rxjj-qqgw');
  assert.strictEqual(v.failing[0].range, '<4.17.21');
});

test('moderate-only findings are reported without failing (the §7.1 posture: fail on high+)', () => {
  const payload = { advisories: { a1: { module_name: 'postcss', severity: 'moderate', github_advisory_id: 'GHSA-qx2v-qp2m-jg93', vulnerable_versions: '<8.5.10' } } };
  const v = auditVerdict(payload);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.total, 1);
});

test('critical fails like high', () => {
  const payload = { advisories: { a1: { module_name: 'x', severity: 'critical', github_advisory_id: 'GHSA-zz' } } };
  assert.strictEqual(auditVerdict(payload).ok, false);
});

test('a malformed advisory payload refuses loudly — never silently passes', () => {
  assert.throws(() => auditVerdict({}));
  assert.throws(() => auditVerdict(null));
  assert.throws(() => auditVerdict({ advisories: { a1: { module_name: 'x', severity: 'apocalyptic' } } }), /AUDIT_SEVERITY_UNKNOWN/);
});

console.log('license gate — expressions, fail-closed:');

test('plain allow-listed and refused licenses', () => {
  assert.strictEqual(evaluateLicense('MIT').ok, true);
  assert.strictEqual(evaluateLicense('mit').ok, true, 'case-insensitive');
  assert.strictEqual(evaluateLicense('Apache-2.0').ok, true);
  assert.strictEqual(evaluateLicense('GPL-3.0-only').ok, false, 'copyleft refuses');
  assert.strictEqual(evaluateLicense('UNKNOWN').ok, false, 'unknown refuses');
  assert.strictEqual(evaluateLicense('UNLICENSED').ok, false, 'unlicensed third-party refuses');
});

test('OR is any-of; AND is all-of', () => {
  assert.strictEqual(evaluateLicense('(MIT OR Apache-2.0)').ok, true);
  assert.strictEqual(evaluateLicense('(GPL-3.0-only OR MIT)').ok, true, 'any allowed operand passes an OR');
  assert.strictEqual(evaluateLicense('(GPL-3.0-only OR CC-BY-NC-4.0)').ok, false);
  assert.strictEqual(evaluateLicense('(MIT AND CC-BY-4.0)').ok, true);
  assert.strictEqual(evaluateLicense('(MIT AND GPL-2.0-only)').ok, false, 'one unallowed AND operand refuses');
});

test('nesting and the asterisk form', () => {
  assert.strictEqual(evaluateLicense('(MIT OR (GPL-2.0-only AND MIT)*)').ok, true);
  assert.strictEqual(evaluateLicense('MIT*').ok, true);
  assert.strictEqual(splitTopLevel('(A OR B) AND C', ' AND ').length, 2, 'inner OR never splits an AND');
  assert.strictEqual(evaluateLicense('(A OR B) AND MIT').ok, false, 'unresolvable operand refuses');
});

test('the first-party exemption is by exact name prefix, never by version', () => {
  assert.strictEqual(verdictForPackage('@sentinel/db@0.8.0', 'UNLICENSED').ok, true);
  assert.strictEqual(verdictForPackage('@sentinel/db@0.8.0', 'UNLICENSED').reason, 'FIRST_PARTY');
  assert.strictEqual(verdictForPackage('@sentinelx/everything', 'GPL-3.0-only').ok, false, 'the prefix is exact');
});

console.log('pinning gate — the practice, generalized:');

test('ranges refuse; exact and workspace protocol pass', () => {
  assert.strictEqual(isExact('^1.2.3'), false);
  assert.strictEqual(isExact('~1.2.3'), false);
  assert.strictEqual(isExact('*'), false);
  assert.strictEqual(isExact('>=1.2.3'), false);
  assert.strictEqual(isExact('1.x'), false);
  assert.strictEqual(isExact('1.2.3'), true);
  assert.strictEqual(isExact('8.23.0'), true);
  assert.strictEqual(isExact('1.2.3-beta.1'), true, 'exact prerelease pins');
  assert.strictEqual(isExact('workspace:*'), true);
  assert.strictEqual(isExact('workspace:^'), true, 'the protocol is resolved by the workspace');
});

test('peerDependencies are exempt — the consumer pin is what ships', () => {
  const v = checkPinning({ dependencies: { a: '1.2.3' }, peerDependencies: { react: '^19.0.0' } });
  assert.strictEqual(v.length, 0);
});

test('the REAL workspace passes — every dependency exact or workspace-protocol', () => {
  const violations = [];
  for (const rel of enumeratePackageJsonFiles()) {
    const abs = rel === 'package.json' ? join(REPO_ROOT, 'package.json') : join(REPO_ROOT, rel);
    for (const x of checkPinning(JSON.parse(readFileSync(abs, 'utf8')))) violations.push(`${rel}: ${x.name}@${x.range}`);
  }
  assert.strictEqual(violations.length, 0, violations.join('; '));
});

test('the pinning gate refuses malformed input', () => {
  assert.throws(() => checkPinning(null));
  assert.throws(() => checkPinning({ dependencies: 'not-an-object' }));
});

console.log('closed-ecosystem gate — the egress surface:');

test('egress URL literals are caught; localhost is the ecosystem, not egress', () => {
  assert.strictEqual(scanContent('a.js', "const u = 'https://api.external.example/v1';").length, 1);
  assert.strictEqual(scanContent('a.js', "const u = 'http://localhost:5432/db';").length, 0);
  assert.strictEqual(scanContent('a.js', "const u = 'http://127.0.0.1:5432/db';").length, 0);
  const v = scanContent('a.js', 'fetch("https://evil.example")');
  assert.strictEqual(v[0].pattern, 'URL_LITERAL');
  assert.strictEqual(v[0].line, 1);
});

test('egress clients and raw http/net modules are caught', () => {
  assert.ok(scanContent('a.js', "import axios from 'axios';").some((v) => v.pattern === 'EGRESS_CLIENT'));
  assert.ok(scanContent('a.js', 'const x = new XMLHttpRequest();').some((v) => v.pattern === 'EGRESS_CLIENT'));
  assert.ok(scanContent('a.js', "const http = require('https');").some((v) => v.pattern === 'EGRESS_HTTP_MODULE'));
  assert.ok(scanContent('a.js', "import net from 'net';").some((v) => v.pattern === 'EGRESS_NET_MODULE'));
  assert.ok(scanContent('a.js', 'await import("https")').some((v) => v.pattern === 'EGRESS_HTTP_MODULE'));
});

test('relative fetch and the node builtins the closed ecosystem needs are not egress', () => {
  assert.strictEqual(scanContent('a.js', "const r = await fetch('/api/plan', {method:'POST'});").length, 0);
  assert.strictEqual(scanContent('a.js', "import { createCipheriv } from 'node:crypto';").length, 0);
  assert.strictEqual(scanContent('a.js', "import { createCipheriv } from 'crypto';").length, 0);
  assert.strictEqual(scanContent('a.js', "import { scryptSync } from 'node:crypto';").length, 0);
});

test('the REAL runtime surface is egress-clean, and the walker excludes tests/docs/scripts', () => {
  const files = collectRuntimeFiles();
  assert.ok(files.length > 50, `the runtime surface is walked (${files.length} files)`);
  for (const f of files) {
    assert.ok(!/(^|\/)(test|tests|migrations|node_modules|\.next)\//.test(f.rel), `walker excludes non-runtime: ${f.rel}`);
  }
  const violations = [];
  for (const f of files) {
    violations.push(...scanContent(f.rel, readFileSync(join(REPO_ROOT, f.rel), 'utf8')));
  }
  assert.strictEqual(violations.length, 0, violations.map((v) => `${v.path}:${v.line} ${v.pattern}`).join('; '));
});

test('the runtime dir list covers every module src tree', () => {
  for (const dir of RUNTIME_DIRS) {
    if (dir.startsWith('packages/core/modules/')) {
      assert.ok(dir.endsWith('/src'), `module surface must be src: ${dir}`);
    }
  }
  assert.ok(RUNTIME_DIRS.includes('apps/web/src') && RUNTIME_DIRS.includes('packages/db'), 'app + db surfaces walked');
});

console.log('\n' + (failed === 0
  ? `security/gates: ${passed} passed — the gate surface is machine-checked, the vulnerable fixture is caught, the runtime surface is egress-clean`
  : `security/gates: ${passed} passed, ${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);
