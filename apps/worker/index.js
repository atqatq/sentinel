'use strict';
/* ============================================================================
 * sentinel-worker — the daemon entry (§14.25 clause 1).
 *
 * Nothing listens: no port, no EXPOSE, no HTTP healthcheck — the poll loop's
 * liveness IS the process, and the orchestrator's restart policy is the
 * watchdog. The stop signals drain: the in-flight file finishes, the next
 * cycle never starts. A boot refusal exits non-zero with its named reason —
 * dead on arrival must say so, not idle.
 * ==========================================================================*/

const { loadConfig } = require('./src/config');
const { makeLoop } = require('./src/main');

const config = loadConfig(process.env); // a refusal here is the boot contract working
const log = (line) => console.log(`[worker] ${line}`);
const loop = makeLoop({ config, log });

let exitCode = 0;
process.on('SIGTERM', () => { void loop.drain(); });
process.on('SIGINT', () => { void loop.drain(); });
process.on('unhandledRejection', (e) => {
  exitCode = 1;
  log(`unhandled rejection — the daemon stops loudly, never zombies on: ${e && e.message}`);
  process.exit(exitCode);
});

log(`sentinel-worker polling ${config.inbox} every ${config.pollMs}ms (batch ≤ ${config.batchMax}) — nothing listens; the liveness IS the process`);
loop.run().then(
  () => process.exit(exitCode),
  (e) => { log(`the loop died loudly: ${e && e.message}`); process.exit(1); }
);
