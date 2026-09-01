// ---------------------------------------------------------------------------
// M12 gate 1 — dependency audit (§14.18). Verdict: fail on high+.
//
// The verdict logic is PURE and exported: the CI step runs this CLI against
// the real lockfile, and the named proof `security/gates` runs the SAME
// function against recorded advisory payloads — including the deliberately
// vulnerable fixture (a real advisory shape for a known-vulnerable range)
// that must be CAUGHT and named. The advisory database is live data; a new
// advisory turning a green tree red overnight is the gate WORKING.
// ---------------------------------------------------------------------------
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RANK = { low: 1, moderate: 2, high: 3, critical: 4 };
export const FAIL_AT = 'high';

// payload = pnpm audit --json output: { advisories: { <id>: {module_name,
// severity, vulnerable_versions, github_advisory_id, title, ...} } }
export function auditVerdict(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('AUDIT_PAYLOAD_MALFORMED: not an object');
  }
  const advisories = payload.advisories;
  if (advisories === null || typeof advisories !== 'object' || Array.isArray(advisories)) {
    throw new Error('AUDIT_PAYLOAD_MALFORMED: advisories missing');
  }
  const failing = [];
  for (const a of Object.values(advisories)) {
    const sev = String(a.severity ?? '').toLowerCase();
    if (!(sev in RANK)) throw new Error(`AUDIT_SEVERITY_UNKNOWN: ${JSON.stringify(a.severity)}`);
    if (RANK[sev] >= RANK[FAIL_AT]) {
      failing.push({
        module: String(a.module_name ?? ''),
        severity: sev,
        id: String(a.github_advisory_id ?? a.url ?? 'unknown'),
        range: String(a.vulnerable_versions ?? ''),
        title: String(a.title ?? ''),
      });
    }
  }
  return { ok: failing.length === 0, failing, total: Object.keys(advisories).length };
}

export function main(argv = process.argv) {
  let stdout = '';
  try {
    stdout = execSync('pnpm audit --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // pnpm audit may exit non-zero when it finds advisories; the JSON still
    // arrives on stdout — the verdict is OURS to compute, never pnpm's.
    stdout = err.stdout || '';
    if (!stdout.trim()) {
      console.error('audit gate: pnpm audit produced no output —', err.message);
      process.exit(1);
    }
  }
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    console.error('audit gate: unparseable pnpm audit output (first 200 chars):', stdout.slice(0, 200));
    process.exit(1);
  }
  const v = auditVerdict(payload);
  if (!v.ok) {
    console.error(`audit gate: FAIL — ${v.failing.length} advisory(ies) at severity ${FAIL_AT}+:`);
    for (const f of v.failing) {
      console.error(`  ${f.module} ${f.severity} ${f.id} (vulnerable: ${f.range}) — ${f.title}`);
    }
    process.exit(1);
  }
  console.log(`audit gate: clean — ${v.total} advisory(ies), none at ${FAIL_AT}+`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
