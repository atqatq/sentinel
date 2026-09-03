'use strict';
/* ============================================================================
 * worker — the fence per file (§14.25 clauses 2, 4, 5; ADR-0002).
 *
 * ONE pg client per file: connect → resolve the tenant ABOVE the fence (the
 * plan route's session posture: identity resolves first, then produces the
 * fence's value) → BEGIN → set_config('app.tenant_id', …, true) → the
 * adapters bound to (client, tenantId) through the db package's public
 * surface (ADR-0001) → runFileToRows with source 'watched-folder' and
 * asOfMs = now() (the daemon is the clock's injection point; the library
 * stays clock-free) → COMMIT → the client closes. The GUC dies with the
 * transaction; the fence is per file by construction.
 *
 * The fault path (§14.25 clause 5): ROLLBACK always. The FAILED register
 * write through markFileFailed happens ONLY when the fault carries the file's
 * BOUND identity (kind included) — markFileFailed's own contract forbids a
 * kind-less row ("a pre-binding refusal is never registered"), and the
 * watched-folder daemon cannot honestly name a kind for a file whose pipeline
 * faulted before binding: the folder and the log are the residue, the register
 * carries no guess. The future transports (dropzone, queue payload) WILL know
 * the kind — the same runner writes FAILED properly through the injected
 * fault-identity hook. A receipt the runtime cannot name is a bug: it lands
 * failed/, never done/.
 *
 * Every dep is injectable so the named proof pins the SEMANTICS without a
 * live database; the defaults are the real production surfaces.
 * ==========================================================================*/

const fs = require('fs');

const MODE = 'A'; // INGESTION_FILE_SPEC §1 Mode A — the watched-folder runtime's mode
const SOURCE = 'watched-folder';

/* The real surfaces load LAZILY (the db package's own posture: a contract
 * imports cleanly without a database) — the named proof injects stubs and
 * never touches them; production uses the defaults. */
function realDb() { return require('@sentinel/db'); }
function realIngestService() { return require('@sentinel/ingest-service'); }

/** The outcome mapping — EXHAUSTIVE over what runFileToRows can return or
 * throw. An unrecognized verdict is a bug: failed/, never done/. */
function outcomeForVerdict(verdict) {
  if (verdict === 'APPLIED' || verdict === 'REPLAY_NOOP') return 'done';
  if (verdict === 'QUARANTINED') return 'quarantine';
  return 'failed';
}

function defaultFaultIdentity(error, claim) {
  // The watched-folder daemon cannot name a kind for a faulted file — the
  // pipeline propagates raw faults and the register's kind column never
  // carries a guess (markFileFailed refuses kind-less writes by contract).
  // The queue/dropzone transports inject the hook that returns the identity.
  return null;
}

async function closeClient(client) {
  if (client && typeof client.end === 'function') {
    try { await client.end(); } catch { /* already gone — the release is the point */ }
  }
}

/**
 * Process one claimed file through the fence.
 *
 * @param {object} deps — injectable: databaseUrl, connect?, resolveTenantByCode?,
 *   makeWorkerPorts?, makeExecutor?, runFileToRows?, faultIdentity?, now?, avRequired?.
 * @param {object} claim — { tenantCode, originalName, claimedPath }.
 * @returns {Promise<{outcome: 'done'|'quarantine'|'failed', reason?: string, receipt?: object}>}
 */
async function processClaim(deps, claim) {
  const connect = deps.connect || ((url) => realDb().connectPlanClient(url));
  const resolveTenant = deps.resolveTenantByCode || realDb().resolveTenantByCode;
  const makePorts = deps.makeWorkerPorts || realDb().makeIngestWorkerAdapter;
  const makeExecutor = deps.makeExecutor || realDb().makeIngestAdapter;
  const run = deps.runFileToRows || realIngestService().runFileToRows;
  const faultIdentity = deps.faultIdentity || defaultFaultIdentity;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});

  let client = null;
  let tenantId = null;
  try {
    const bytes = new Uint8Array(fs.readFileSync(claim.claimedPath)); // read AFTER the claim — the rename already happened

    client = await connect(deps.databaseUrl);

    /* identity resolves ABOVE the fence — it produces the fence's value */
    const tenant = await resolveTenant(client, claim.tenantCode);
    if (!tenant || typeof tenant.id !== 'string' || tenant.id === '') {
      return { outcome: 'failed', reason: 'UNKNOWN_TENANT_CODE' }; // no fence, no register — a fence needs a tenant
    }
    tenantId = tenant.id;

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    const ports = makePorts(client, tenantId);
    const executor = makeExecutor(client, tenantId);
    const receipt = await run(
      { ports, executor },
      { tenantId, bytes, declaredName: claim.originalName, source: SOURCE, mode: MODE, asOfMs: now(), avRequired: deps.avRequired === undefined ? true : deps.avRequired }
    );

    await client.query('COMMIT');
    const outcome = outcomeForVerdict(receipt && receipt.verdict);
    if (receipt && typeof receipt.verdict === 'string' && outcome === 'failed') {
      log(`unrecognized verdict '${receipt.verdict}' — a receipt the runtime cannot name is a bug: failed/, never done/`);
    }
    return { outcome, receipt };
  } catch (error) {
    /* ---- the fault path: the transaction dies, the file still settles ---- */
    try { if (client) await client.query('ROLLBACK'); } catch { /* the connection may already be gone */ }

    const identity = faultIdentity(error, claim); // null for the watched folder — the register carries no guess
    if (identity && tenantId && client) {
      try {
        /* the honest post-rollback state, in a FRESH transaction */
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await makePorts(client, tenantId).markFileFailed(identity);
        await client.query('COMMIT');
      } catch (faultWriteError) {
        /* no database, no register — the folder and the log are the residue */
        log(`FAILED register write also faulted (${faultWriteError.message}) — the file still settles failed/; no database, no register`);
      }
    } else {
      log(`no FAILED register write: ${identity ? 'the tenant fence was never opened' : 'the fault carries no bound file identity — a pre-binding refusal is never registered'}`);
    }
    return { outcome: 'failed', reason: error.message, fault: error };
  } finally {
    await closeClient(client);
  }
}

module.exports = { processClaim, outcomeForVerdict, MODE, SOURCE };
