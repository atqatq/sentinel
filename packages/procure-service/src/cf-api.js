'use strict';
/* ============================================================================
 * procure-service — the sourcing-controls decision API (§14.13c, D-036's
 * scheduled follow-on).
 *
 * handleCfDecision — the API boundary of the conversion-factor decision
 * gate (HTTP-agnostic, the handlePlanRun pattern): the transport semantics
 * that make §14.13b's governance REACHABLE. This package owns NO governance
 * arithmetic: the pure gate (approval module's cf.decideCfVersion) decides,
 * the Class-D denial record travels UNCHANGED through the ledger's append
 * door (the D-029 consumption posture), and the SQL door
 * (procure-adapter.resolveCfVersion — the ONLY path through the
 * item_cf_freeze) executes. The API composes gate → record → door in the
 * caller's transaction; it never re-implements a denominator, a gate, or a
 * trigger.
 *
 * deps (all injected):
 *   loadCfVersion(versionId)  — the pending version BY ID, state re-proved
 *                               (procure-adapter.loadCfVersionById); null
 *                               when the id names nothing in this tenant
 *                               (RLS makes another tenant's version
 *                               indistinguishable from no version);
 *   loadLatestSeal()          — the latest plan_seal payload (or null) for
 *                               the APPLY leg's re-derivation walk;
 *   resolveCfVersion(...)     — the door (procure-adapter);
 *   ledger.appendDenialRecord — the armed ledger door for the Class-D
 *                               refusal records; ARMED ONLY by the
 *                               deployment's HMAC key + the session's
 *                               envelope — an anonymous denial record
 *                               cannot exist, and an unarmed deployment
 *                               refuses loudly (TypeError → 500): a
 *                               denial never leaves no trace.
 *
 * Statuses (the plan-handler mapping, adversarially honest):
 *   200  the decision receipt (APPLIED | REJECTED)
 *   400  request-shape (INVALID_REQUEST)
 *   403  a gate denial (the record the ledger now carries, returned so the
 *        tray can render the why)
 *   404  CF_VERSION_NOT_FOUND
 *   500  wiring (a bug, not a refusal — the transaction rolls back with it)
 * ==========================================================================*/

const CF = require('../../core/modules/approval').cf;

async function handleCfDecision(request, deps) {
  try {
    const shape = validateRequest(request);
    if (shape) return shape;
    assertDeps(deps);

    const { actor, versionId, decision, reason } = request;

    /* (1) the pending version, BY ID — the state re-proved, not assumed;
     * the loaded row is what the gate judges, never a fabricated object. */
    const version = await deps.loadCfVersion(versionId);
    if (!version) {
      return { status: 404, json: {
        verdict: 'REFUSED', reason: 'CF_VERSION_NOT_FOUND',
        detail: `no pending conversion-factor version ${JSON.stringify(versionId)} in this tenant — another tenant's version is indistinguishable from no version, which is the point`,
      } };
    }

    /* (2) the pure gate — UNCHANGED. A refusal yields the Class-D denial
     * record, which travels UNCHANGED through the armed ledger door. */
    const verdict = CF.decideCfVersion({ version, actor, decision, reason });
    if (!verdict.ok) {
      const block = await deps.ledger.appendDenialRecord(verdict.denial);
      return { status: 403, json: {
        verdict: 'REFUSED', reason: verdict.denial.reason || 'CF_DECISION_DENIED',
        denial: verdict.denial, ledger: { seq: block.seq, hash: block.hash },
      } };
    }

    /* (3) the door — UNCHANGED. The latest seal rides the APPLY leg (the
     * §14.13b third audit leg: explicit re-derivation tasks, never a silent
     * rebase). */
    const latestSeal = decision === 'APPLY' ? await deps.loadLatestSeal() : null;
    const receipt = await deps.resolveCfVersion({
      versionId, decidedBy: actor.userId, decision, reason, latestSeal,
    });
    return { status: 200, json: {
      verdict: decision === 'APPLY' ? 'APPLIED' : 'REJECTED',
      ...receipt,
    } };
  } catch (e) {
    return { status: 500, json: { verdict: 'ERROR', message: e && e.message ? e.message : String(e) } };
  }
}

/* Request-shape refusals (400-class) — the gate never sees a malformed
 * request. The ACTOR arrives merged by the transport (the session's
 * envelope, the plan route's pattern: the route refuses a body-carried
 * identity by name, then merges the session's). A missing or malformed
 * actor here is the TRANSPORT's fault — the boundary refuses loudly. */
function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, json: { verdict: 'REFUSED', reason: 'INVALID_REQUEST', detail: 'request body required' } };
  }
  if (!request.actor || typeof request.actor !== 'object'
      || typeof request.actor.userId !== 'string' || request.actor.userId === ''
      || typeof request.actor.role !== 'string' || request.actor.role === '') {
    return { status: 400, json: {
      verdict: 'REFUSED', reason: 'IDENTITY_REQUIRED',
      detail: 'the actor envelope ({userId, role}) comes from the SESSION — the transport resolves it and merges it; a body-carried identity is the plan route\'s retired interim',
    } };
  }
  if (typeof request.versionId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(request.versionId)) {
    return { status: 400, json: { verdict: 'REFUSED', reason: 'INVALID_REQUEST', detail: 'versionId must be the version uuid' } };
  }
  if (request.decision !== 'APPLY' && request.decision !== 'REJECT') {
    return { status: 400, json: { verdict: 'REFUSED', reason: 'INVALID_REQUEST', detail: 'decision must be APPLY | REJECT' } };
  }
  if (request.decision === 'REJECT' && (typeof request.reason !== 'string' || request.reason.trim() === '')) {
    return { status: 400, json: { verdict: 'REFUSED', reason: 'INVALID_REQUEST', detail: 'a REJECT carries its reason — the why is part of the record, not a formality' } };
  }
  return null;
}

/* The ports posture: either wired or loud. An unarmed ledger is the wiring
 * error (a denial that leaves no trace must not be possible). */
function assertDeps(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('handleCfDecision: deps object required ({loadCfVersion, loadLatestSeal, resolveCfVersion, ledger})');
  }
  for (const p of ['loadCfVersion', 'loadLatestSeal', 'resolveCfVersion']) {
    if (typeof deps[p] !== 'function') {
      throw new TypeError(`handleCfDecision: deps.${p} must be a function — the §14.13c API is either wired or refused, never silently skipped`);
    }
  }
  if (!deps.ledger || typeof deps.ledger.appendDenialRecord !== 'function') {
    throw new TypeError('handleCfDecision: deps.ledger.appendDenialRecord is REQUIRED — the ledger door is armed by the deployment (HMAC key + the session envelope); UNARMED the API refuses loudly: a Class-D denial never leaves no trace (§16.1)');
  }
}

module.exports = { handleCfDecision };
