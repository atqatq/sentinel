#!/usr/bin/env node
/**
 * A12 gate: ui/sds-theme-token-parity
 *
 * Verifies packages/ui/theme/tokens.css against the token tables in
 * docs/design/README.md — the design handoff is the visual-truth authority.
 * Editing one without the other fails this gate.
 *
 * Strictly checked (table-parseable in the README):
 *   - dark neutrals  (:root)            — "Neutrals — dark" table
 *   - light neutrals (light override)   — "Neutrals — light theme override" table
 *   - brand                              — "`--brand:`" declaration line
 *   - status dark + light pairs          — "Status — semantic only" table
 *   - dv categorical/sequential/diverging — backticked hex lists
 *   - density row tokens                 — "Density" table (compact/comfortable)
 *
 * Not strictly checked (prose in the README, ported by hand): spacing scale,
 * radii, shadows, type roles, fonts. Values are normalized before compare
 * (case, whitespace, leading-dot decimals).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const README = path.join(ROOT, 'docs', 'design', 'README.md');
const TOKENS = path.join(ROOT, 'packages', 'ui', 'theme', 'tokens.css');

let failed = 0;
const fail = (msg) => { failed++; console.error('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

/** Normalize a color value for comparison. */
function norm(v) {
  return v.trim().toLowerCase().replace(/\s+/g, '').replace(/([^0-9])\.([0-9])/g, '$10.$2');
}

/** Extract `--name: value;` assignments from a CSS block string. */
function parseAssignments(css) {
  const out = new Map();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(css)) !== null) out.set(m[1], m[2].trim());
  return out;
}

/** Split tokens.css into its three cascade blocks (comments stripped first,
 *  so selector mentions inside header comments cannot mislead the search). */
function parseTokenBlocks(rawCss) {
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (startMarker) => {
    const i = css.indexOf(startMarker);
    if (i === -1) return '';
    const open = css.indexOf('{', i);
    let depth = 1, j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    return css.slice(open + 1, j - 1);
  };
  return {
    root: block(':root'),
    light: block('[data-sds-theme="light"]'),
    compact: block('[data-sds-density="compact"]'),
  };
}

/** Parse the README tables into {root: Map, light: Map} of expected tokens. */
function parseReadme(md) {
  const expected = { root: new Map(), light: new Map(), compact: new Map() };
  const lines = md.split('\n');

  const sectionOf = (name) => {
    // Only real level-3 headings count — stray mentions elsewhere must not match.
    const start = lines.findIndex((l) => l.startsWith('### ') && l.includes(name));
    return start === -1 ? null : start;
  };

  // Table rows between this heading and the next heading of any level.
  const tableRows = (startIdx) => {
    const rows = [];
    for (let i = startIdx; i < lines.length; i++) {
      const l = lines[i];
      if (i > startIdx && l.startsWith('#')) break;
      if (/^\s*\|/.test(l) && !/^\s*\|[\s:-]+\|/.test(l)) rows.push(l);
    }
    return rows;
  };

  // Cell accessor: strips surrounding backticks the README uses for code.
  const cell = (row, idx) => {
    const cells = row.split('|').map((c) => c.trim()).slice(1, -1);
    return (cells[idx] || '').replace(/^`+|`+$/g, '');
  };

  // 1. Dark neutrals
  let s = sectionOf('### Neutrals — dark');
  if (s === null) fail('README: dark-neutrals section not found');
  else for (const r of tableRows(s + 1)) {
    const name = cell(r, 0);
    if (/^--[a-z0-9-]+$/.test(name)) expected.root.set(name, cell(r, 1));
  }

  // 2. Light neutrals override
  s = sectionOf('### Neutrals — light theme override');
  if (s === null) fail('README: light-neutrals section not found');
  else for (const r of tableRows(s + 1)) {
    const name = cell(r, 0);
    if (/^--[a-z0-9-]+$/.test(name)) expected.light.set(name, cell(r, 1));
  }

  // 3. Brand
  s = sectionOf('### Brand');
  if (s === null) fail('README: brand section not found');
  else {
    for (let i = s; i < lines.length; i++) {
      const m = lines[i].match(/`--brand:\s*(#[0-9A-Fa-f]{6})`/);
      if (m) { expected.root.set('--brand', m[1]); break; }
    }
    if (!expected.root.has('--brand')) fail('README: --brand declaration not found');
  }

  // 4. Status pairs (Token | Dark | Light | Applied to)
  s = sectionOf('### Status — semantic only');
  if (s === null) fail('README: status section not found');
  else for (const r of tableRows(s + 1)) {
    const name = cell(r, 0);
    if (/^--[a-z0-9-]+$/.test(name)) {
      expected.root.set(name, cell(r, 1));   // dark
      expected.light.set(name, cell(r, 2));  // light
    }
  }

  // 5. DV palettes — backticked hex lists
  s = sectionOf('### Data-visualisation palette');
  if (s === null) fail('README: dv palette section not found');
  else {
    const hexes = (line) => (line.match(/#[0-9A-Fa-f]{6}/g) || []);
    let divCount = 0;
    for (let i = s + 1; i < Math.min(s + 15, lines.length); i++) {
      const l = lines[i];
      if (l.startsWith('###')) break;
      if (l.includes('Categorical')) {
        // Label and hex list may be split across two lines in the handoff.
        const hs = hexes(l).length ? hexes(l) : hexes(lines[i + 1] || '');
        hs.forEach((h, k) => expected.root.set(`--dv-${k + 1}`, h));
      } else if (l.includes('Sequential')) {
        hexes(l).forEach((h, k) => expected.root.set(`--dv-seq-${k + 1}`, h));
      } else if (l.includes('Diverging')) {
        const h = hexes(l);
        if (h.length === 3) {
          expected.root.set('--dv-div-low', h[0]);
          expected.root.set('--dv-div-mid', h[1]);
          expected.root.set('--dv-div-high', h[2]);
        }
        divCount = h.length;
      }
    }
    if (divCount !== 3) fail(`README: diverging palette should list 3 hexes, found ${divCount}`);
  }

  // 6. Density (Token | Compact | Comfortable)
  s = sectionOf('### Density');
  if (s === null) fail('README: density section not found');
  else for (const r of tableRows(s + 1)) {
    const name = cell(r, 0).split(' ')[0];
    if (/^--[a-z0-9-]+$/.test(name)) {
      expected.compact.set(name, cell(r, 1)); // compact
      expected.root.set(name, cell(r, 2));    // comfortable (default)
    }
  }

  return expected;
}

function main() {
  const md = fs.readFileSync(README, 'utf8');
  const css = fs.readFileSync(TOKENS, 'utf8');
  const blocks = parseTokenBlocks(css);
  const expected = parseReadme(md);

  const actual = {
    root: parseAssignments(blocks.root),
    light: parseAssignments(blocks.light),
    compact: parseAssignments(blocks.compact),
  };

  let checked = 0;
  for (const [blockName, expMap] of Object.entries(expected)) {
    for (const [name, value] of expMap) {
      checked++;
      const got = actual[blockName].get(name);
      if (got === undefined) {
        fail(`${blockName}: ${name} missing from tokens.css`);
      } else if (norm(got) !== norm(value)) {
        fail(`${blockName}: ${name} = ${got} but README says ${value}`);
      }
    }
  }

  // Guard the reverse direction for color tokens: nothing status/neutral/brand
  // may appear in tokens.css that the README does not declare.
  const known = new Set([
    ...expected.root.keys(), ...expected.light.keys(), ...expected.compact.keys(),
  ]);
  const colorRe = /^--(canvas|surface|raised|hover|line|line-strong|text(?:-2|-3|-disabled)?|inv|brand|ok|warn|critical|info|pending|muted|dv(-[a-z0-9]+)*)$/;
  for (const [blockName, actMap] of Object.entries(actual)) {
    for (const name of actMap.keys()) {
      if (colorRe.test(name) && !known.has(name)) {
        fail(`${blockName}: ${name} exists in tokens.css but is not declared in the README tables`);
      }
    }
  }

  if (failed > 0) {
    console.error(`\nsds-token-parity: ${failed} mismatch(es), ${checked} tokens checked`);
    process.exit(1);
  }
  ok(`SDS token parity holds — ${checked} tokens match the design handoff`);
}

main();
