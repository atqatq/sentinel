// ---------------------------------------------------------------------------
// M12 gate 3 — license scan (§14.18). Fail-closed.
//
// Every workspace project's dependency tree is walked with license-checker
// (pinned exact as a root devDependency) and every third-party license
// expression is evaluated: OR passes if ANY operand is allow-listed, AND
// passes only if ALL are, anything else — including UNKNOWN and UNLICENSED
// third-party — refuses. First-party @sentinel/* workspace packages are
// exempt by exact name prefix, never by version.
//
// The evaluator is PURE and exported; the named proof `security/gates` pins
// it against expression fixtures (GPL refuses, OR any-of passes, AND
// all-of refuses, parenthesized nesting, the asterisk form, UNKNOWN refuses).
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, enumerateProjects } from './workspace.mjs';

const allowlist = JSON.parse(
  readFileSync(join(REPO_ROOT, 'scripts', 'security', 'license-allowlist.json'), 'utf8'),
);
export const ALLOWED = allowlist.allowed;
export const FIRST_PARTY_PREFIX = '@sentinel/';

// Split on a separator that sits at paren depth 0 — so "(A OR B) AND C"
// splits on the AND, never on its inner OR.
export function splitTopLevel(expr, separator) {
  const s = String(expr);
  const parts = [];
  let depth = 0, current = '', i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && s.startsWith(separator, i)) {
      parts.push(current);
      current = '';
      i += separator.length;
      continue;
    }
    current += ch;
    i++;
  }
  parts.push(current);
  return parts;
}

// Strip one layer of parens ONLY if the opener matches the closer (the last
// char) — "(A) OR (B)" keeps its operands' parens for the leaf level.
function stripOuterParens(s) {
  const t = s.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return t;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') {
      depth--;
      if (depth === 0 && i < t.length - 1) return t; // closes early — not a single wrapper
    }
  }
  return t.slice(1, -1).trim();
}

function evalExpr(expr, allowed) {
  const t = stripOuterParens(String(expr).trim());
  if (!t) return { ok: false, reason: 'EMPTY_EXPRESSION' };
  const orParts = splitTopLevel(t, ' OR ');
  if (orParts.length > 1) {
    const verdicts = orParts.map((p) => evalLeaf(p, allowed));
    return { ok: verdicts.some((v) => v.ok), reason: verdicts.some((v) => v.ok) ? 'ANY_OF' : 'NONE_ALLOWED' };
  }
  const andParts = splitTopLevel(t, ' AND ');
  if (andParts.length > 1) {
    const verdicts = andParts.map((p) => evalLeaf(p, allowed));
    const ok = verdicts.every((v) => v.ok);
    return { ok, reason: ok ? 'ALL_OF' : 'ALL_OF_UNALLOWED' };
  }
  return evalLeaf(t, allowed);
}

function evalLeaf(operand, allowed) {
  const t = stripOuterParens(operand.trim().replace(/\*+$/, '').trim());
  if (!t) return { ok: false, reason: 'EMPTY_EXPRESSION' };
  if (/\s+OR\s+/.test(t) || /\s+AND\s+/.test(t)) return evalExpr(t, allowed); // nested
  const ok = allowed.some((a) => String(a).toLowerCase() === t.toLowerCase());
  return { ok, reason: ok ? 'ALLOWED' : 'NOT_ALLOWED' };
}

// expression: a license-checker `licenses` value — string or array.
// An array (dual/multi-license reports) is any-of.
export function evaluateLicense(expression, allowed = ALLOWED) {
  const exprs = Array.isArray(expression) ? expression : [expression];
  for (const e of exprs) {
    if (typeof e !== 'string' || !e.trim()) {
      return { ok: false, reason: 'EMPTY_EXPRESSION', expression: String(e) };
    }
  }
  for (const e of exprs) {
    const verdict = evalExpr(e, allowed);
    if (verdict.ok) return { ...verdict, expression: e };
  }
  const last = exprs[exprs.length - 1];
  const verdict = evalExpr(last, allowed);
  return { ...verdict, expression: last };
}

export function verdictForPackage(name, licenses, allowed = ALLOWED) {
  if (String(name).startsWith(FIRST_PARTY_PREFIX)) return { ok: true, reason: 'FIRST_PARTY' };
  return evaluateLicense(licenses, allowed);
}

export function main() {
  const bin = join(REPO_ROOT, 'node_modules', '.bin', 'license-checker');
  const violations = [];
  let packages = 0;
  for (const dir of enumerateProjects()) {
    let out;
    try {
      out = execFileSync(bin, ['--start', join(REPO_ROOT, dir), '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (err) {
      console.error(`license gate: license-checker failed for ${dir} —`, err.message);
      process.exit(1);
    }
    let tree;
    try {
      tree = JSON.parse(out);
    } catch {
      console.error(`license gate: unparseable license-checker output for ${dir}`);
      process.exit(1);
    }
    for (const [name, info] of Object.entries(tree)) {
      packages++;
      const v = verdictForPackage(name, info.licenses);
      if (!v.ok) violations.push({ name, licenses: String(info.licenses), reason: v.reason, foundIn: dir });
    }
  }
  if (violations.length) {
    console.error(`license gate: FAIL — ${violations.length} package(s) outside the allow-list:`);
    for (const x of violations) console.error(`  ${x.name} [${x.licenses}] (${x.reason}) in ${x.foundIn}`);
    process.exit(1);
  }
  console.log(`license gate: clean — ${packages} package entries, all allow-listed or first-party`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
