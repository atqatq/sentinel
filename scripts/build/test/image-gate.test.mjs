// ---------------------------------------------------------------------------
// The image build & the container scan — the named proof `build/image-gate`
// (§14.23; M12's fifth leg arriving).
//
// The dev/runtime environment of this proof carries NO docker daemon — and
// that is the point: the IMAGE CONTRACT is static text. Docker proves the
// reality in CI (the build job builds and scans the image); THIS proof pins
// the shape, so a refactor that re-roots the image, floats a base tag, drops
// the scan or mutes the exit code fails on the same push that changed it —
// before CI ever spends a build minute.
//
// Pinned, per §14.23: the three-stage Dockerfile; every base digest-pinned;
// distroless nonroot runtime; --chown on every runtime COPY; standalone-only
// runtime surface; no credential-shaped ENV in any layer; no shell-exec
// HEALTHCHECK (the probe is the orchestrator's HTTP GET against /health);
// the .dockerignore's context hygiene; next.config's standalone output with
// pg external; the /health route reading its stamps through the PUBLIC
// surfaces (ADR-0001); the CI image-build job — proof before build, Trivy
// pinned and fail-closed on HIGH+CRITICAL, the image SBOM (SPDX-2.3)
// attached; and the two subjects the spec names absent, absent: no worker
// image and no compose file may exist until their own units land them.
// ==========================================================================*/
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

/* scripts/build/test/image-gate.test.mjs → four dirnames up = the repo root. */
const REPO_ROOT = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const DOCKERFILE = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
const DF_LINES = DOCKERFILE.split('\n');
const CI = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const NEXT_CONFIG = readFileSync(join(REPO_ROOT, 'apps', 'web', 'next.config.ts'), 'utf8');
const HEALTH_ROUTE = readFileSync(join(REPO_ROOT, 'apps', 'web', 'src', 'app', 'health', 'route.ts'), 'utf8');
const DOCKERIGNORE = existsSync(join(REPO_ROOT, '.dockerignore'))
  ? readFileSync(join(REPO_ROOT, '.dockerignore'), 'utf8')
  : '';

/* A stage block: from its FROM line to the next FROM line. */
function stages() {
  const out = [];
  let cur = null;
  for (const line of DF_LINES) {
    if (/^FROM\s/.test(line)) {
      if (cur) out.push(cur);
      cur = { from: line.trim(), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) out.push(cur);
  return out;
}
const STAGES = stages();
const RUNTIME = STAGES[STAGES.length - 1];

/* The CI image-build job block: from its id line to the next job id. */
const BUILD_JOB = (() => {
  const lines = CI.split('\n');
  const start = lines.findIndex((l) => /^  image-build:\s*$/.test(l));
  assert.ok(start >= 0, 'ci.yml has no `image-build:` job (§7.1 step 7)');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-z][a-z0-9-]*:\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
})();

console.log('The image contract — the Dockerfile, machine-checked:');

test('one Dockerfile at the repo root, exactly THREE stages: deps → build → runtime', () => {
  assert.strictEqual(STAGES.length, 3, `expected 3 stages, found ${STAGES.length}`);
  assert.match(STAGES[0].from, /^FROM .* AS deps$/);
  assert.match(STAGES[1].from, /^FROM .* AS build$/);
  assert.match(STAGES[2].from, /^FROM .* AS runtime$/);
});

test('every base image is pinned BY DIGEST — a floating tag is an unpinned dependency', () => {
  const stageNames = STAGES.map((s) => s.from.match(/ AS (\w+)$/)?.[1]);
  for (const s of STAGES) {
    const base = s.from.replace(/^FROM\s+/, '').replace(/\s+AS\s+\w+$/, '');
    if (stageNames.includes(base)) continue; // an intra-file stage reference, not a registry pull
    assert.match(s.from, /@sha256:[0-9a-f]{64}(\s+AS|$)/, `digest-pinned: ${s.from}`);
    assert.ok(!/\blatest\b/.test(s.from), `no floating latest: ${s.from}`);
  }
});

test('the builder is node:22.22-bookworm-slim; the runtime is distroless nodejs22 nonroot', () => {
  assert.match(STAGES[0].from, /^FROM node:22\.22-bookworm-slim@sha256:/);
  assert.match(STAGES[2].from, /^FROM gcr\.io\/distroless\/nodejs22-debian12:nonroot@sha256:/);
});

test('runtime runs non-root: USER nonroot explicit, AFTER the copies, nothing re-roots it', () => {
  const userLine = RUNTIME.lines.findIndex((l) => /^USER\s+nonroot\s*$/.test(l));
  assert.ok(userLine >= 0, 'USER nonroot must be explicit in the runtime stage');
  const lastCopy = RUNTIME.lines.reduce((acc, l, i) => (/^COPY\s/.test(l) ? i : acc), -1);
  assert.ok(userLine > lastCopy, 'USER must follow every COPY — nothing runs as root after it');
  assert.ok(!/USER\s+root/.test(DOCKERFILE), 'no stage may switch back to root');
});

test('every runtime COPY carries --chown=nonroot:nonroot', () => {
  const copies = RUNTIME.lines.filter((l) => /^COPY\s/.test(l));
  assert.ok(copies.length > 0, 'the runtime stage must copy the standalone output');
  for (const c of copies) {
    assert.match(c, /^COPY --from=build --chown=nonroot:nonroot /, `--chown required: ${c.trim()}`);
  }
});

test('the runtime carries ONLY the traced standalone surface — never the toolchain, never full node_modules', () => {
  const copies = RUNTIME.lines.filter((l) => /^COPY\s/.test(l)).map((l) => l.trim());
  assert.ok(copies.some((c) => /\/app\/apps\/web\/\.next\/standalone \.\/$/.test(c)), 'the standalone bundle is copied');
  assert.ok(copies.some((c) => /\.next\/static \.\/apps\/web\/\.next\/static$/.test(c)), 'the static assets ride beside it');
  for (const c of copies) {
    assert.ok(!/node_modules/.test(c), `a node_modules COPY would smuggle the toolchain: ${c}`);
    assert.ok(!/\/src\b/.test(c), `no source tree in runtime: ${c}`);
  }
});

test('EXPOSE 3000 is the only listener; the CMD is exec-form node apps/web/server.js', () => {
  const exposes = DF_LINES.filter((l) => /^EXPOSE\s/.test(l));
  assert.deepStrictEqual(exposes.map((l) => l.trim()), ['EXPOSE 3000'], 'exactly one EXPOSE: 3000');
  const cmd = DF_LINES.filter((l) => /^CMD\s/.test(l));
  assert.deepStrictEqual(cmd.map((l) => l.trim()), ['CMD ["apps/web/server.js"]'], 'exec-form CMD, the standalone server');
});

test('no credential-shaped ENV carries a value in ANY layer', () => {
  const envLines = [];
  let inEnv = false;
  for (const line of DF_LINES) {
    if (/^ENV\s/.test(line)) { inEnv = true; envLines.push(line); if (!/\\\s*$/.test(line)) inEnv = false; continue; }
    if (inEnv) { envLines.push(line); if (!/\\\s*$/.test(line)) inEnv = false; }
  }
  const creds = envLines.filter((l) => /\b[A-Z0-9_]*(SECRET|PASSWORD|TOKEN|DATABASE_URL|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=/i.test(l));
  assert.deepStrictEqual(creds, [], 'no credential-shaped variable may be baked into a layer');
});

test('no HEALTHCHECK shell exec exists — the probe is the orchestrator HTTP GET against /health', () => {
  assert.ok(!/^HEALTHCHECK/m.test(DOCKERFILE), 'distroless has no shell; a HEALTHCHECK would be a lie or an exec-form curl that does not exist');
  assert.ok(/\/health/.test(HEALTH_ROUTE), 'the /health route is the probe target');
});

test('the .dockerignore refuses the context carries: .git, node_modules, .next, .env', () => {
  for (const needed of ['^\\.git$', '^\\*\\*/node_modules$', '^\\*\\*/\\.next$', '^\\.env']) {
    assert.match(DOCKERIGNORE, new RegExp(needed, 'm'), `dockerignore must exclude ${needed}`);
  }
});

console.log('The build contract — next.config and /health:');

test('next.config declares output: "standalone" and keeps pg external to the bundle', () => {
  assert.match(NEXT_CONFIG, /output:\s*"standalone"/, 'the traced bundle is the ONLY dependency story the runtime trusts');
  assert.match(NEXT_CONFIG, /serverExternalPackages:\s*\["pg"\]/, 'pg stays a real Node dependency of the route runtime');
});

test('/health reads its stamps through the PUBLIC surfaces (ADR-0001), never src/ internals', () => {
  assert.match(HEALTH_ROUTE, /from "@sentinel\/module-planning-engine"/, 'ENGINE_VERSION via the module surface');
  assert.match(HEALTH_ROUTE, /from "@sentinel\/db"/, 'SCHEMA_VERSION via the package surface');
  assert.match(HEALTH_ROUTE, /ENGINE_VERSION/, 'the engine stamp rides the response');
  assert.match(HEALTH_ROUTE, /SCHEMA_VERSION/, 'the schema stamp rides the response');
});

test('/health is dynamic and uncacheable — the probe must answer for the RUNNING process', () => {
  assert.match(HEALTH_ROUTE, /export const dynamic = "force-dynamic"/, 'a statically optimized health page would echo the build, not the process');
  assert.match(HEALTH_ROUTE, /"no-store"/, 'no cache may stand between the probe and the truth');
});

console.log('The CI build job — the scan gates the moment the image exists:');

test('the image-build job is merge-blocking: it needs the fast gates and runs the proof BEFORE the build', () => {
  assert.match(BUILD_JOB, /needs:\s*\[guard, security, web-shell\]/, 'the build rides behind the gates');
  assert.match(BUILD_JOB, /node scripts\/build\/test\/image-gate\.test\.mjs/, 'the structural proof runs in CI');
  const proofIdx = BUILD_JOB.indexOf('node scripts/build/test/image-gate.test.mjs');
  const buildIdx = BUILD_JOB.indexOf('docker build');
  assert.ok(proofIdx >= 0 && buildIdx > proofIdx, 'the proof precedes the docker build — shape first, spend after');
});

test('the docker build produces sentinel-web:ci (§6.2 naming; no push on PRs)', () => {
  assert.match(BUILD_JOB, /docker build --tag sentinel-web:ci \./, 'the release artifact is built and scanned locally in CI');
  assert.ok(!/docker push/.test(BUILD_JOB), 'pushing rides the release workflow, never the PR gate');
});

test('Trivy is pinned, scans the image, and is FAIL-CLOSED on HIGH+CRITICAL (unfixed counts)', () => {
  assert.match(BUILD_JOB, /uses: aquasecurity\/trivy-action@v0\.36\.0/, 'the action is version-pinned');
  assert.match(BUILD_JOB, /version: v0\.74\.0/, 'the TOOL version is part of the gate identity (the gitleaks posture)');
  assert.match(BUILD_JOB, /image-ref: sentinel-web:ci/, 'the scan subject is the built image');
  assert.match(BUILD_JOB, /exit-code: 1/, 'a HIGH+ finding fails the job — the gate is not a report');
  assert.match(BUILD_JOB, /severity: HIGH,CRITICAL/, 'the threshold matches §14.18 high+');
  assert.match(BUILD_JOB, /ignore-unfixed: false/, 'unfixed base-image CVEs count — the image is the runtime whole world');
});

test('the IMAGE SBOM (SPDX-2.3) is generated from the built image and attached to the run', () => {
  assert.match(BUILD_JOB, /uses: anchore\/sbom-action@v0\.24\.2/, 'the SBOM action is version-pinned');
  assert.match(BUILD_JOB, /image: sentinel-web:ci/, 'the SBOM subject is the image, not the repo (two subjects, two artifacts)');
  assert.match(BUILD_JOB, /format: spdx-json/, 'SPDX-2.3, the §14.18 format');
  assert.match(BUILD_JOB, /artifact-name: sentinel-web-image-sbom/, 'the artifact is named and attached');
});

test('the two named absences HOLD: no worker image and no compose file until their units land them', () => {
  assert.ok(!existsSync(join(REPO_ROOT, 'Dockerfile.worker')), 'a worker image with no daemon to exec is a lie in a tag (§14.23)');
  assert.ok(!existsSync(join(REPO_ROOT, 'docker', 'compose.yaml')), 'the compose file lands with the e2e-smoke unit that exercises it (§14.23)');
});

console.log('\n' + (failed === 0
  ? `build/image-gate: ${passed} passed — the image contract is machine-checked; docker proves the reality in CI`
  : `build/image-gate: ${passed} passed, ${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);
