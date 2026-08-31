'use strict';
/* ============================================================================
 * ledger/records.js — the Class-D consumption path (the D-029 promise).
 *
 * The approval module (C3, the previous M3 unit) fixed the DENIAL RECORD
 * shape — { class:'D', outcome:'denied', actor, role, action, entity,
 * entityId, reason } — "so the ledger consumes it verbatim, never a forked
 * format". This file is that consumption: the record travels through
 * UNCHANGED into a §16.2 block; the envelope context (tenant, session, the
 * version stamps, the instant) arrives from the caller.
 *
 * Every §16.1 class writes to the SAME ledger (class is a field, not a
 * separate store) — buildBlock is the general path; denialToBlock is the
 * named contract for the refusal records the controls layer already emits.
 * ==========================================================================*/

const { buildBlock } = require('./blocks.js');

function refusal(code, detail) {
  const e = new TypeError(detail ? `${code}: ${detail}` : code);
  e.code = code;
  throw e;
}

function denialToBlock(denial, ctx) {
  if (!denial || typeof denial !== 'object') {
    refusal('LEDGER_DENIAL_SHAPE', 'a denial record object is required');
  }
  if (denial.class !== 'D' || denial.outcome !== 'denied') {
    refusal('LEDGER_DENIAL_SHAPE', `expected the approval module's Class-D record (class 'D', outcome 'denied'), got class ${JSON.stringify(denial.class)} outcome ${JSON.stringify(denial.outcome)}`);
  }
  for (const f of ['actor', 'action', 'entity', 'reason']) {
    if (denial[f] === undefined) {
      refusal('LEDGER_DENIAL_SHAPE', `the denial record is missing "${f}" — a forked format cannot be consumed verbatim`);
    }
  }
  return buildBlock({
    class: denial.class,
    outcome: denial.outcome,
    actor: denial.actor,
    role: denial.role === undefined ? null : denial.role,
    action: denial.action,
    entity: denial.entity,
    entityId: denial.entityId === undefined ? null : denial.entityId,
    reason: denial.reason,
    before: null,
    after: null,
    tenantId: ctx.tenantId,
    onBehalfOf: ctx.onBehalfOf === undefined ? null : ctx.onBehalfOf,
    sourceIp: ctx.sourceIp === undefined ? null : ctx.sourceIp,
    sessionId: ctx.sessionId === undefined ? null : ctx.sessionId,
    engineVersion: ctx.engineVersion,
    schemaVersion: ctx.schemaVersion,
    at: ctx.at,
  });
}

module.exports = { denialToBlock };
