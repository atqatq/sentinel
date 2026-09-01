// ---------------------------------------------------------------------------
// M12 gate 6 — closed-ecosystem egress grep (§14.18). The CI backstop.
//
// The runtime surface — the src trees of the app, packages and modules, the
// db adapters, the workers; NEVER tests, docs, scripts or migrations —
// carries no egress call: no http(s):// URL literal outside localhost, no
// egress HTTP client, no raw http/https/net module require. The closed
// ecosystem's network surface is its own PostgreSQL and its own HTTP API
// (ADR-0003's posture, grep-enforced per commit).
//
// The scanner is PURE (path + content → violations); the named proof
// `security/gates` plants egress calls in fixture contents and asserts they
// are caught, and that relative fetches and localhost URLs pass.
// The M13 egress ALLOW-LIST policy rides its own section; this is the gate
// that stops an egress call from landing silently.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './workspace.mjs';

// Runtime roots: production code only. Tests are deliberately EXCLUDED —
// they may stub transports and parse fixture URLs; docs may cite URLs; the
// gates themselves may call pnpm (scripts/ are tooling, not runtime).
export const RUNTIME_DIRS = [
  'apps/web/src',
  'packages/ui/src',
  'packages/plan-service/src',
  'packages/ingest-service/src',
  'packages/db', // runtime adapters at the package root; test/ and migrations/ excluded below
  ...listModuleSrc(),
];

function listModuleSrc() {
  const base = join(REPO_ROOT, 'packages', 'core', 'modules');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `packages/core/modules/${d.name}/src`)
    .filter((p) => existsSync(join(REPO_ROOT, p)));
}

const EXCLUDED = /(^|\/)(test|tests|migrations|node_modules|\.next)(\/|$)/;
const RUNTIME_CODE = /\.(js|mjs|cjs|jsx|ts|tsx)$/;

export const EGRESS_PATTERNS = [
  { name: 'URL_LITERAL', re: /https?:\/\/[^\s'"<>()]+/i },
  { name: 'EGRESS_CLIENT', re: /\baxios\b/ },
  { name: 'EGRESS_CLIENT', re: /\bXMLHttpRequest\b/ },
  { name: 'EGRESS_CLIENT', re: /\bundici\b/ },
  { name: 'EGRESS_CLIENT', re: /\bnode-fetch\b/ },
  { name: 'EGRESS_HTTP_MODULE', re: /require\(\s*['"]https?['"]\s*\)/ },
  { name: 'EGRESS_HTTP_MODULE', re: /from\s+['"]https?['"]/ },
  { name: 'EGRESS_HTTP_MODULE', re: /import\s*\(\s*['"]https?['"]\s*\)/ },
  { name: 'EGRESS_NET_MODULE', re: /require\(\s*['"]net['"]\s*\)/ },
  { name: 'EGRESS_NET_MODULE', re: /from\s+['"]net['"]/ },
];

const LOCALHOST = /localhost|127\.0\.0\.1/;

// PURE: (relative path, content) → violations. The path decides nothing
// except nothing — tests/docs exclusion is the WALKER's job; the scanner is
// honest about every file it is handed.
export function scanContent(relPath, content) {
  const violations = [];
  const lines = String(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const p of EGRESS_PATTERNS) {
      const m = lines[i].match(p.re);
      if (!m) continue;
      if (p.name === 'URL_LITERAL' && LOCALHOST.test(m[0])) continue; // the ecosystem's own surface
      violations.push({ path: relPath, line: i + 1, pattern: p.name, snippet: lines[i].trim().slice(0, 120) });
    }
  }
  return violations;
}

export function collectRuntimeFiles(root = REPO_ROOT) {
  const files = [];
  for (const dir of RUNTIME_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    walk(abs, root, files);
  }
  return files;
}

function walk(abs, root, files) {
  const rel = relative(root, abs).split(sep).join('/');
  if (EXCLUDED.test(rel)) return;
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) walk(join(abs, name), root, files);
    return;
  }
  if (RUNTIME_CODE.test(rel)) files.push({ rel, abs });
}

export function main() {
  const violations = [];
  let scanned = 0;
  for (const f of collectRuntimeFiles()) {
    scanned++;
    violations.push(...scanContent(f.rel, readFileSync(f.abs, 'utf8')));
  }
  if (violations.length) {
    console.error(`closed-ecosystem gate: FAIL — ${violations.length} egress call(s) in the runtime surface:`);
    for (const v of violations) console.error(`  ${v.path}:${v.line} [${v.pattern}] ${v.snippet}`);
    process.exit(1);
  }
  console.log(`closed-ecosystem gate: clean — ${scanned} runtime files, no egress surface`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
