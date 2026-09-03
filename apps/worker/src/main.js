'use strict';
/* ============================================================================
 * worker — the poll loop (§14.25 clauses 1, 3, 6).
 *
 * One cycle: the boot sweep's orphans FIRST (crash residue — H6 idempotency
 * makes the reprocessing a no-op), then the unattributed strays (settled
 * failed/_unattributed with a named log line — no tenant, no fence), then the
 * tenant files, claimed one by one and processed through the fence, up to the
 * batch cap. Poison isolation: one file's failure never stops the cycle — the
 * per-file catch isolates it, the loop continues, and the next file is not
 * punished for its neighbor. Drain: the in-flight cycle finishes, the next
 * cycle never starts — a stopped daemon never leaves a half-processed file
 * outside .claiming/.
 *
 * The loop's deps are injected: the named proof pins the SEMANTICS with
 * stubs; index.js wires the real ones. The inbox is created on boot when
 * missing — an empty inbox is a valid, honest idle.
 * ==========================================================================*/

const fs = require('fs');

const claimLayer = require('./claim');
const { processClaim } = require('./runner');

/**
 * @param {object} deps — { config, connect?, resolveTenantByCode?, makeWorkerPorts?,
 *   makeExecutor?, runFileToRows?, faultIdentity?, now?, sleep?, log? }.
 */
function makeLoop(deps) {
  const config = deps.config;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log || ((line) => console.log(`[worker] ${line}`));
  const batchMax = config.batchMax;

  let draining = false;
  let inFlight = null;

  async function processOne(claim) {
    const result = await processClaim(deps, claim);
    const settled = claimLayer.settleFile(config.inbox, claim, result.outcome);
    const label = result.receipt && result.receipt.verdict ? `verdict ${result.receipt.verdict}` : (result.reason ? `reason ${result.reason}` : 'no receipt');
    log(`${claim.originalName} (tenant ${claim.tenantCode}) → ${settled} — ${label}`);
    return result;
  }

  /** One cycle. Returns the counts; never throws — a poisoned file is a
   * settled outcome, not a dead daemon. */
  async function cycle() {
    const counts = { orphans: 0, strays: 0, processed: 0, done: 0, quarantine: 0, failed: 0 };

    /* the boot sweep's orphans FIRST — already claimed, processed directly */
    for (const orphan of claimLayer.listOrphans(config.inbox)) {
      if (counts.processed >= batchMax) break;
      counts.orphans++;
      const r = await processOne(orphan);
      counts[r.outcome]++;
      counts.processed++;
    }

    /* unattributed strays: no tenant — no fence; a named outcome */
    const { tenants, strays } = claimLayer.scanInbox(config.inbox);
    for (const stray of strays) {
      const settled = claimLayer.settleStray(config.inbox, stray);
      counts.strays++;
      log(`'${stray.originalName}' at the inbox root carries no tenant folder → ${settled} (failed/_unattributed — the layout violation is a named outcome, never a silent skip)`);
    }

    /* claim → fence → settle, up to the batch cap */
    for (const item of tenants) {
      if (counts.processed >= batchMax) break;
      const claim = claimLayer.claimFile(item); // atomic rename BEFORE any byte is read
      const r = await processOne(claim);
      counts[r.outcome]++;
      counts.processed++;
    }
    return counts;
  }

  async function run() {
    if (!fs.existsSync(config.inbox)) {
      fs.mkdirSync(config.inbox, { recursive: true });
      log(`inbox created at ${config.inbox} — an empty inbox is a valid, honest idle`);
    }
    while (!draining) {
      inFlight = cycle();
      await inFlight;
      inFlight = null;
      if (draining) break;
      await sleep(config.pollMs);
    }
    log('drained — the in-flight cycle finished, the next cycle never started');
  }

  /** The stop signal: finish the in-flight cycle, start no new one. */
  function drain() {
    draining = true;
    return inFlight || Promise.resolve();
  }

  return { run, drain, cycle };
}

module.exports = { makeLoop };
