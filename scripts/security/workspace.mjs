// ---------------------------------------------------------------------------
// Workspace enumeration — shared by the M12 security gates (§14.18).
// The pnpm-workspace.yaml globs are the single source of truth; this module
// expands them minimally (trailing-* globs only) so every gate walks exactly
// the workspace pnpm would, and never more.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function workspaceGlobs() {
  const text = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s+"?([^"#]+?)"?\s*$/);
    if (m) globs.push(m[1]);
  }
  return globs;
}

// Expand a glob of the form `prefix/*` or a literal path. Anything fancier
// refuses — the workspace file is ours, and an unexpanded glob must be loud,
// never silently skipped (fail-closed, the repo's one philosophy).
export function expandGlob(root, glob) {
  if (!glob.includes('*')) return [glob];
  if (!glob.endsWith('*')) throw new Error(`WORKSPACE_GLOB_UNSUPPORTED: ${glob}`);
  const base = glob.slice(0, -1); // keep trailing slash
  const abs = join(root, base);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => base + d.name);
}

// Every workspace project directory (with a package.json), root excluded —
// the root manifest is the workspace itself, walked separately by callers.
export function enumerateProjects(root = REPO_ROOT) {
  const dirs = [];
  for (const glob of workspaceGlobs()) {
    for (const dir of expandGlob(root, glob)) {
      if (existsSync(join(root, dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs.sort();
}

// Every package.json in the workspace, root INCLUDED (its devDependencies
// ship to CI and must obey the same pinning rule).
export function enumeratePackageJsonFiles(root = REPO_ROOT) {
  const files = ['package.json'];
  for (const dir of enumerateProjects(root)) {
    files.push(join(dir, 'package.json'));
  }
  return files;
}
