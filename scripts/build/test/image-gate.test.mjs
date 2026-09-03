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
// attached. Pinned, per §14.25: the worker image's three stages (deps →
// deploy → runtime), the pnpm deploy pruned tree plus the SIX core modules
// the require topology escapes into, the same digest pins and the same
// nonroot posture, NO EXPOSE and NO HEALTHCHECK (nothing listens — the
// liveness IS the process), the CI job building and scanning BOTH images
// under one gate and one waiver set, one image SBOM per subject. The one
// named absence that remains is the compose walk's third service — the
// worker joins the smoke stack in the e2e unit's own amendment, when the
// smoke walks a file.
//
// The WAIVER DISCIPLINE (§14.23): the gate's first real run fired on six
// libssl3 CVEs in the distroless base pending upstream's rebuild — the
// waivers live in .trivyignore, each naming its CVE with a fix status and a
// retirement condition, and THIS proof pins the file's exact entry set: a
// waiver can never grow, shrink or drift silently.
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
const WORKER_DOCKERFILE = readFileSync(join(REPO_ROOT, 'Dockerfile.worker'), 'utf8');
const WDF_LINES = WORKER_DOCKERFILE.split('\n');
const CI = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const NEXT_CONFIG = readFileSync(join(REPO_ROOT, 'apps', 'web', 'next.config.ts'), 'utf8');
const HEALTH_ROUTE = readFileSync(join(REPO_ROOT, 'apps', 'web', 'src', 'app', 'health', 'route.ts'), 'utf8');
const DOCKERIGNORE = existsSync(join(REPO_ROOT, '.dockerignore'))
  ? readFileSync(join(REPO_ROOT, '.dockerignore'), 'utf8')
  : '';
const TRIVYIGNORE = existsSync(join(REPO_ROOT, '.trivyignore'))
  ? readFileSync(join(REPO_ROOT, '.trivyignore'), 'utf8')
  : '';

/* A stage block: from its FROM line to the next FROM line. */
function stagesOf(lines) {
  const out = [];
  let cur = null;
  for (const line of lines) {
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
const STAGES = stagesOf(DF_LINES);
const RUNTIME = STAGES[STAGES.length - 1];
const WSTAGES = stagesOf(WDF_LINES);
const WRUNTIME = WSTAGES[WSTAGES.length - 1];

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

console.log('The worker image contract — Dockerfile.worker, the §14.25 posture:');

function envLinesOf(lines) {
  const envLines = [];
  let inEnv = false;
  for (const line of lines) {
    if (/^ENV\s/.test(line)) { inEnv = true; envLines.push(line); if (!/\\\s*$/.test(line)) inEnv = false; continue; }
    if (inEnv) { envLines.push(line); if (!/\\\s*$/.test(line)) inEnv = false; }
  }
  return envLines;
}

function assertDistrolessNonroot(stages, runtime, label) {
  const stageNames = stages.map((s) => s.from.match(/ AS (\w+)$/)?.[1]);
  for (const s of stages) {
    const base = s.from.replace(/^FROM\s+/, '').replace(/\s+AS\s+\w+$/, '');
    if (stageNames.includes(base)) continue;
    assert.match(s.from, /@sha256:[0-9a-f]{64}(\s+AS|$)/, `${label} digest-pinned: ${s.from}`);
    assert.ok(!/\blatest\b/.test(s.from), `${label} no floating latest: ${s.from}`);
  }
  assert.match(stages[stages.length - 1].from, /^FROM gcr\.io\/distroless\/nodejs22-debian12:nonroot@sha256:/, `${label} the runtime is distroless nonroot`);
  const userLine = runtime.lines.findIndex((l) => /^USER\s+nonroot\s*$/.test(l));
  assert.ok(userLine >= 0, `${label} USER nonroot must be explicit in the runtime stage`);
  const lastCopy = runtime.lines.reduce((acc, l, i) => (/^COPY\s/.test(l) ? i : acc), -1);
  assert.ok(userLine > lastCopy, `${label} USER must follow every COPY`);
  for (const c of runtime.lines.filter((l) => /^COPY\s/.test(l))) {
    assert.match(c, /--chown=nonroot:nonroot/, `${label} every runtime COPY carries --chown: ${c.trim()}`);
  }
}

test('the worker image is three stages — deps → deploy → runtime (deploy prunes; runtime carries the pruned tree only)', () => {
  assert.strictEqual(WSTAGES.length, 3, `expected 3 stages, found ${WSTAGES.length}`);
  assert.match(WSTAGES[0].from, /^FROM .* AS deps$/);
  assert.match(WSTAGES[1].from, /^FROM .* AS deploy$/);
  assert.match(WSTAGES[2].from, /^FROM .* AS runtime$/);
});

test('the worker image inherits the §14.23 posture verbatim: digest pins, distroless nonroot, USER after the copies, --chown on every runtime COPY', () => {
  assertDistrolessNonroot(WSTAGES, WRUNTIME, 'worker');
  assert.match(WSTAGES[0].from, /^FROM node:22\.22-bookworm-slim@sha256:/, 'the SAME builder digest as the web image');
});

test('NOTHING listens: no EXPOSE, no HEALTHCHECK — the poll loop\'s liveness IS the process (§14.25 clause 1)', () => {
  assert.deepStrictEqual(WDF_LINES.filter((l) => /^EXPOSE\s/.test(l)), [], 'the worker opens no port — an EXPOSE would be a lie about a listener that does not exist');
  assert.ok(!/^HEALTHCHECK/m.test(WORKER_DOCKERFILE), 'no shell to exec and no HTTP surface to probe — the restart policy is the watchdog');
});

test('the CMD is exec-form node index.js — the daemon; no credential-shaped ENV in any layer', () => {
  const cmd = WDF_LINES.filter((l) => /^CMD\s/.test(l));
  assert.deepStrictEqual(cmd.map((l) => l.trim()), ['CMD ["index.js"]'], 'exec-form CMD, the poll loop');
  const creds = envLinesOf(WDF_LINES).filter((l) => /\b[A-Z0-9_]*(SECRET|PASSWORD|TOKEN|DATABASE_URL|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=/i.test(l));
  assert.deepStrictEqual(creds, [], 'DATABASE_URL rides environment at exec — it is never baked into a layer');
});

test('the deploy stage carries the require topology\'s SIX core modules — the pruned tree is complete, never "copied just in case"', () => {
  const deploy = WSTAGES[1];
  assert.match(deploy.lines.join('\n'), /pnpm --filter @sentinel\/worker deploy --prod --config\.node-linker=hoisted \/out/, 'pnpm deploy is the pruner, HOISTED so the workspace packages are real directories — the default isolated layout hides them behind .pnpm symlinks and a require from the symlink\u0027s REALPATH would resolve the modules\u0027 relative ../core escapes against the store, where the placed modules cannot reach them (the first CI run\u0027s lesson, pinned)');
  for (const mod of ['setup', 'ingestion', 'calendar', 'planning-engine', 'approval', 'ledger', 'auth']) {
    assert.match(deploy.lines.join('\n'), new RegExp(`cp -r packages/core/modules/${mod} /out/node_modules/@sentinel/core/modules/`), `the ${mod} module rides the escapee topology (db and ingest-service reach ../core)`);
  }
  assert.ok(!/packages\/core\/modules\/intelligence/.test(WORKER_DOCKERFILE), 'modules without a caller stay OUT of the runtime — a bigger tree is a bigger SBOM, never a safer one');
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

test('the worker image joins the same job: sentinel-worker:ci built from Dockerfile.worker (§14.25)', () => {
  assert.match(BUILD_JOB, /docker build --tag sentinel-worker:ci --file Dockerfile\.worker \./, 'the worker image is built from ITS Dockerfile in the SAME merge-blocking job');
  const webIdx = BUILD_JOB.indexOf('docker build --tag sentinel-web:ci');
  const workerIdx = BUILD_JOB.indexOf('docker build --tag sentinel-worker:ci');
  assert.ok(webIdx < workerIdx, 'the web image builds first — the ordering the e2e stack consumes');
});

test('the worker image is scanned under the SAME gate: Trivy pinned, HIGH+CRITICAL, exit-code 1, ignore-unfixed false', () => {
  const workerScan = BUILD_JOB.slice(BUILD_JOB.indexOf('image-ref: sentinel-worker:ci') - 600, BUILD_JOB.indexOf('image-ref: sentinel-worker:ci') + 400);
  assert.match(workerScan, /version: v0\.74\.0/, 'the tool version is part of the gate identity');
  assert.match(workerScan, /exit-code: 1/, 'fail-closed');
  assert.match(workerScan, /severity: HIGH,CRITICAL/, 'the threshold matches §14.18 high+');
  assert.match(workerScan, /ignore-unfixed: false/, 'unfixed counts on BOTH images');
});

test('one image SBOM per subject: sentinel-web AND sentinel-worker, each named and attached', () => {
  assert.match(BUILD_JOB, /artifact-name: sentinel-web-image-sbom/, 'the web image\'s SBOM');
  assert.match(BUILD_JOB, /image: sentinel-worker:ci/, 'the SBOM subject is the worker image');
  assert.match(BUILD_JOB, /artifact-name: sentinel-worker-image-sbom/, 'the worker image\'s SBOM, named and attached');
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

test('the worker image EXISTS now — its unit landed the daemon (§14.25); the compose stack is the e2e unit\'s (root compose.yaml)', () => {
  assert.ok(existsSync(join(REPO_ROOT, 'Dockerfile.worker')), 'the daemon (apps/worker) exists — the image that execs it must exist; an absent image would now be the lie');
  assert.ok(existsSync(join(REPO_ROOT, 'compose.yaml')), 'the e2e-smoke unit landed the compose file where it is exercised (§14.24)');
});

console.log('The waiver discipline — named, reasoned, retiring; never a mute button:');

const WAIVED = ['CVE-2026-31789', 'CVE-2026-28387', 'CVE-2026-28388', 'CVE-2026-28389', 'CVE-2026-28390', 'CVE-2026-45447'];

function waiverBlocks() {
  const blocks = [];
  let comments = [];
  for (const line of TRIVYIGNORE.split('\n')) {
    if (/^#/.test(line)) { comments.push(line); continue; }
    const id = line.trim();
    if (id) { blocks.push({ id, comments }); comments = []; }
  }
  return blocks;
}

test('the .trivyignore entry set is EXACTLY the pinned six — a waiver can never grow, shrink or drift silently', () => {
  assert.ok(TRIVYIGNORE.length > 0, 'the waiver file exists (the first scan fired on the libssl3 class, §14.23)');
  const ids = waiverBlocks().map((b) => b.id).sort();
  assert.deepStrictEqual(ids, [...WAIVED].sort(), 'any change to the entry set is a reviewed diff beside the spec text that justified it');
});

test('every waiver names its CVE, cites the fix status, and states the retirement condition', () => {
  for (const b of waiverBlocks()) {
    const text = b.comments.join(' ');
    assert.ok(text.includes(b.id), `${b.id}: the reason comment must name the CVE`);
    assert.match(text, /(FIXED|no fixed package)/i, `${b.id}: the fix status must be on the record`);
    assert.match(text, /pending rebuild/i, `${b.id}: the retirement condition (the distroless rebuild) must be stated`);
  }
});

test('ignore-unfixed stays FALSE — the waiver file names six CVEs, an UNNAMED future one still fails the build', () => {
  assert.match(BUILD_JOB, /ignore-unfixed: false/, 'muting all unfixed findings would be a mute button wearing a waiver clothes');
  assert.match(BUILD_JOB, /exit-code: 1/, 'the gate stays fail-closed for everything the waiver file does not name');
});

console.log('\n' + (failed === 0
  ? `build/image-gate: ${passed} passed — the image contract is machine-checked; docker proves the reality in CI`
  : `build/image-gate: ${passed} passed, ${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);
