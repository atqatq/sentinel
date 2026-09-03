/* ============================================================================
 * repo-root.mjs — the ONE definition of the repo root for the §14.24
 * runner-side scripts (prepare-db.mjs, smoke.mjs) and the named proof that
 * audits them (test/smoke.test.mjs).
 *
 * WHY A SHARED MODULE: each script hardcoding its own dirname() ladder is
 * how the depth bug was born — prepare/smoke sit at scripts/e2e/ (two
 * dirnames up) but the proof sits at scripts/e2e/test/ (three), and a
 * copy-pasted ladder with the wrong count resolves a phantom root
 * ('scripts/packages/db/package.json') that only detonates in CI, where
 * there is no live tier to mask it. Here the ladder exists ONCE, at a
 * known depth (this file lives at scripts/e2e/), and the PROOF EXECUTES
 * this module and asserts the result against the real tree — the depth is
 * proven by running it, not by reading it.
 * ==========================================================================*/
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* scripts/e2e/repo-root.mjs → three dirnames up = the repo root
 * (file → e2e → scripts → root). */
export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
