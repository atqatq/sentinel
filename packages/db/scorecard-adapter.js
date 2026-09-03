'use strict';
/* ============================================================================
 * scorecard-adapter — the §14.6f rollup door: the SQL executor of the
 * SCORECARD_REBUILT Class-S event (the §16.1 "scorecard rollup" machine
 * write; D-034's scheduled follow-on delivered).
 *
 * The scorecard itself is PURE — `rebuildScorecard` (the execution-feedback
 * module) derives the H2 second arm, composes the unchanged §14.6d wiring
 * and yields the ONE Class-S block payload. Nothing in that decision layer
 * touches a database. This adapter is the WRITING side: it takes the pure
 * event payload UNCHANGED (the D-029 consumption posture — the decision
 * layer's shape travels verbatim) and appends it through the ledger's
 * append door in the CALLER'S transaction (§16.3 rule 2 — a failed append
 * rolls the business write the rebuild serves back with it; an unlogged
 * scorecard must not be possible, and a logged one must not be un-done:
 * the ledger's immutability layers hold).
 *
 * Class-S envelope (§16.1): actor 'system', role null — a rollup is a
 * machine write; a manual trigger rides onBehalfOf (the operator) with the
 * trigger and job id already named in the event's reason by the pure layer.
 * The engine/schema stamps ride the event payload (opts.engineVersion /
 * schemaVersion when the pure layer was called; the door refuses a payload
 * missing either — L-07: a score question must resolve to an exact code
 * state, and the door never labels the chain on the caller's behalf).
 *
 * The ledger door is armed only by opts.ledger ({ hmacKey }) — UNARMED, a
 * recordRebuild call fails loudly (TypeError): either armed or refused,
 * never silently unlogged (the §14.16/§14.17 wiring posture).
 *
 * Statement-first discipline (the restateSeal posture): every argument is
 * validated BEFORE the first statement touches the database; refusals are
 * named (code-carrying Errors), never coerced. RLS scopes every statement
 * to the bound tenant (the GUC is the caller's transaction's).
 *
 * pg is never imported here; the client is injected. The structural suites
 * import this package without a database; the LIVE proof is
 * test/scorecard-live.js (CI db-rls job).
 * ==========================================================================*/

const ledgerMod = require('./ledger-adapter');

function scorecardError(code, detail) {
  const e = new Error(`SCORECARD_${code}: ${detail}`);
  e.code = `SCORECARD_${code}`;
  return e;
}

function makeScorecardAdapter(client, tenantId, opts) {
  if (!tenantId) throw new Error('SCORECARD_TENANT_REQUIRED');
  /* The ledger door: armed only when the caller supplies the secret-manager
   * key. The envelope is the SYSTEM's (§16.1 Class S). */
  const ledgerAdapter = opts && opts.ledger && opts.ledger.hmacKey
    ? ledgerMod.makeLedgerAdapter(client, tenantId, {
        hmacKey: opts.ledger.hmacKey,
        actor: 'system',
        role: null,
        onBehalfOf: null,
        sourceIp: null,
        sessionId: null,
        /* the L-07 stamps arrive on the EVENT (appendBlock's input merges
         * OVER this envelope) and the door refuses an event without them —
         * the adapter never invents a label */
        engineVersion: null,
        schemaVersion: null,
      })
    : null;

  return {
    /** Record one scorecard rebuild. event: the pure `rebuildScorecard`
     *  result's event payload — validated here BEFORE anything is sent
     *  (statement-first). meta: { onBehalfOf? } — a manual trigger's
     *  operator rides the block's onBehalfOf. Returns
     *  { recorded, seq, hash } — the chain receipt. */
    recordRebuild: ledgerAdapter ? async (event, meta) => {
      if (!event || typeof event !== 'object') {
        throw scorecardError('EVENT_REQUIRED', 'the rebuild event payload is required — feed the door the pure layer\'s event, not a hand-made block');
      }
      if (event.class !== 'S') {
        throw scorecardError('EVENT_CLASS_INVALID', `a scorecard rollup is a Class-S event, got ${JSON.stringify(event.class)} (§16.1)`);
      }
      if (event.action !== 'SCORECARD_REBUILT') {
        throw scorecardError('EVENT_ACTION_INVALID', `the rollup action is SCORECARD_REBUILT, got ${JSON.stringify(event.action)}`);
      }
      if (event.entity !== 'supplier_scorecard') {
        throw scorecardError('EVENT_ENTITY_INVALID', `the rollup entity is supplier_scorecard, got ${JSON.stringify(event.entity)}`);
      }
      if (typeof event.entityId !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(event.entityId)) {
        throw scorecardError('EVENT_ASOF_INVALID', `entityId is the asOf canonical day, got ${JSON.stringify(event.entityId)} (H4)`);
      }
      if (event.before !== null) {
        throw scorecardError('EVENT_BEFORE_INVALID', 'a rollup writes no business value — before is null (the pure layer guarantees it; a hand-made payload refuses here)');
      }
      if (!event.after || typeof event.after !== 'object' || event.after.asOf !== event.entityId
          || !Array.isArray(event.after.suppliers)
          || !Number.isFinite(event.after.dueLines) || !Number.isFinite(event.after.pastPromiseDue)) {
        throw scorecardError('EVENT_AFTER_INVALID', 'after carries { asOf, suppliers, dueLines, pastPromiseDue } — the rollup receipt the audit trail answers from');
      }
      if (typeof event.reason !== 'string' || !event.reason.includes('trigger=')) {
        throw scorecardError('EVENT_TRIGGER_REQUIRED', 'the reason names the trigger (§16.1 Class S: every machine write carries its trigger)');
      }
      if (event.engineVersion == null || event.schemaVersion == null) {
        throw scorecardError('EVENT_STAMPS_REQUIRED', 'the L-07 stamps ride the payload (engineVersion/schemaVersion) — the door never labels the chain on the caller\'s behalf');
      }
      const m = meta || {};
      if (m.onBehalfOf !== undefined && m.onBehalfOf !== null && (typeof m.onBehalfOf !== 'string' || !m.onBehalfOf.trim())) {
        throw scorecardError('OPERATOR_INVALID', 'onBehalfOf names the manual trigger\'s operator (a user uuid), or stays null for the schedule');
      }
      /* The SAME transaction (§16.3 rule 2): a failed append throws and the
       * caller's ROLLBACK takes the business write with it. */
      const block = await ledgerAdapter.appendBlock({
        class: event.class,
        entity: event.entity,
        entityId: event.entityId,
        action: event.action,
        outcome: event.outcome || 'success',
        before: null,
        after: event.after,
        onBehalfOf: m.onBehalfOf || null,
        reason: event.reason,
        engineVersion: event.engineVersion,
        schemaVersion: event.schemaVersion,
      });
      return { recorded: true, seq: block.seq, hash: block.hash };
    } : undefined,
  };
}

module.exports = { makeScorecardAdapter };
