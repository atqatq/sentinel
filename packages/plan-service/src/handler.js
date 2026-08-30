'use strict';
/* ============================================================================
 * handlePlanRun — the API boundary of the engine-live run (HTTP-agnostic).
 *
 * Maps receipts to statuses:
 *   SEALED / REPLAYED        → 200 (the receipt IS the response body)
 *   REFUSED with task        → 422 (a data-health refusal: H8, R1 currency,
 *                              corrupt conversion, invalid driver…)
 *   REFUSED without task     → 400 (request-shape violation)
 *   wiring TypeError         → 500 (VERDICT ERROR — a bug, not a refusal)
 *
 * The transport (the Next.js route handler that imports this function and
 * injects the pg-backed loader/saver) lands with the UI-shell unit; the API
 * SEMANTICS live here so they are testable without a server.
 * ==========================================================================*/

const { runPlan } = require('./plan');

async function handlePlanRun(request, deps) {
  try {
    const receipt = await runPlan(request, deps);
    if (receipt.verdict === 'REFUSED') {
      return { status: receipt.task ? 422 : 400, json: receipt };
    }
    return { status: 200, json: receipt };
  } catch (e) {
    return { status: 500, json: { verdict: 'ERROR', message: e && e.message ? e.message : String(e) } };
  }
}

module.exports = { handlePlanRun };
