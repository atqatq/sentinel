'use strict';
/* ============================================================================
 * worker — the scan / claim / settle mechanics (§14.25 clauses 2, 3, 5).
 *
 * The claim is an ATOMIC RENAME into <inbox>/<TENANT_CODE>/.claiming/ BEFORE
 * any byte is read: POSIX rename is atomic, so two pollers cannot both claim
 * one file, and no file is ever processed in place where a second scan could
 * double-claim it. Dotfiles and dot-directories are invisible to the scan —
 * editor residue and the claim directory itself must never be mistaken for
 * work. Orphaned claims (crash residue) are returned to the boot cycle as its
 * first batch; H6's idempotency makes the reprocessing a no-op (REPLAY_NOOP),
 * so recovery is safe by construction, not by bookkeeping.
 *
 * The outcome mapping is EXHAUSTIVE (§14.25 clause 5): every claimed file
 * settles into exactly one folder — done/ (APPLIED, REPLAY_NOOP),
 * quarantine/ (QUARANTINED), failed/ (thrown, unrecognized) — and the tenant
 * segment is preserved so the folder an operator walks still says whose file
 * it was. A root-level file carries no tenant claim at all and lands in
 * failed/_unattributed/ — the layout violation is a named outcome, never a
 * silent skip.
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const OUTCOMES = Object.freeze(['done', 'quarantine', 'failed']);
const UNATTRIBUTED = '_unattributed';

/**
 * One scan of the inbox. Tenant folders (directories, not dot-directories)
 * yield their claimable regular files; a regular file at the inbox ROOT is
 * unattributed — the daemon cannot know a tenant for it, so it never claims
 * one, it settles it to failed/_unattributed/ with a named log line.
 *
 * @returns {{ tenants: Array<{tenantCode: string, originalName: string, inboxPath: string}>,
 *             strays: Array<{originalName: string, inboxPath: string}> }}
 */
function scanInbox(inbox) {
  const tenants = [];
  const strays = [];
  for (const entry of fs.readdirSync(inbox, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // dotfiles and dot-directories are invisible
    const full = path.join(inbox, entry.name);
    if (entry.isDirectory()) {
      for (const f of fs.readdirSync(full, { withFileTypes: true })) {
        if (f.name.startsWith('.') || !f.isFile()) continue;
        tenants.push({ tenantCode: entry.name, originalName: f.name, inboxPath: path.join(full, f.name) });
      }
    } else if (entry.isFile()) {
      strays.push({ originalName: entry.name, inboxPath: full });
    }
  }
  return { tenants, strays };
}

/** Files orphaned inside a tenant's .claiming/ — crash residue the boot
 * cycle processes FIRST (§14.25 clause 3). Already claimed; nothing renames. */
function listOrphans(inbox) {
  const orphans = [];
  for (const entry of fs.readdirSync(inbox, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const claimDir = path.join(inbox, entry.name, '.claiming');
    if (!fs.existsSync(claimDir)) continue;
    for (const f of fs.readdirSync(claimDir, { withFileTypes: true })) {
      if (f.name.startsWith('.') || !f.isFile()) continue;
      orphans.push({ tenantCode: entry.name, originalName: f.name, claimedPath: path.join(claimDir, f.name) });
    }
  }
  return orphans;
}

/** The claim: rename into the tenant's .claiming/ before any byte is read. */
function claimFile(item) {
  const claimDir = path.join(path.dirname(item.inboxPath), '.claiming');
  fs.mkdirSync(claimDir, { recursive: true });
  const claimedPath = path.join(claimDir, item.originalName);
  fs.renameSync(item.inboxPath, claimedPath); // atomic — a second poller's rename of the same source fails
  return { tenantCode: item.tenantCode, originalName: item.originalName, claimedPath };
}

/** The settle: exactly one outcome folder per claimed file, tenant segment
 * preserved. Returns the settled path so the log can name it. */
function settleFile(inbox, claim, outcome) {
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(`settleFile: outcome '${String(outcome)}' is not one of ${OUTCOMES.join(' | ')} — the mapping is exhaustive, never invented`);
  }
  const tenantSegment = claim.tenantCode || UNATTRIBUTED;
  const dir = path.join(inbox, outcome, tenantSegment);
  fs.mkdirSync(dir, { recursive: true });
  const settledPath = path.join(dir, claim.originalName);
  fs.renameSync(claim.claimedPath, settledPath);
  return settledPath;
}

/** A root-level stray: settled unattributed, never processed (no tenant —
 * no fence; §14.25 clause 2's named limit). */
function settleStray(inbox, stray) {
  const dir = path.join(inbox, 'failed', UNATTRIBUTED);
  fs.mkdirSync(dir, { recursive: true });
  const settledPath = path.join(dir, stray.originalName);
  fs.renameSync(stray.inboxPath, settledPath);
  return settledPath;
}

module.exports = { scanInbox, listOrphans, claimFile, settleFile, settleStray, OUTCOMES, UNATTRIBUTED };
