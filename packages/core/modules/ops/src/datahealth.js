'use strict';
/* ============================================================================
 * Sentinel — the data-health sweep: the unpromised-waiting disclosure
 * becomes the register (§14.6g, D-033's named follow-on).
 *
 * The plan receipt's per-ref supply facts (§14.6c) carry `unpromisedLines` /
 * `unpromisedWaiting` — a live Open-PO line with waiting > 0 and NO promise
 * date can never be late against no promise, and "follow-up without a
 * promise date is blind, and data health should say so". Until this layer,
 * the receipt said so once, into the void. This module derives the task set
 * the §9 register should carry; the WRITER (plan-adapter's
 * syncUnpromisedWaitingTasks) mirrors the register to it, idempotently.
 *
 * Home rules (ADR-0001): pure — no I/O, no clock, no db; every fact enters
 * as a parameter; identical inputs produce deep-equal output. The task
 * objects are the guards' verbatim shape ({ type: 'DATA_HEALTH', field,
 * detail, severity }) so the register's writers consume them unchanged.
 *
 * The register carries GAPS, never confirmations: a ref with
 * `unpromisedLines === 0` yields nothing — data health does not applaud
 * clean refs (the freshness posture: alarms, not numbers).
 * ==========================================================================*/

const TASK_FIELD_PREFIX = 'unpromised-waiting.';

/* ---- refusal family (fail-closed: a wiring error is loud, never guessed) -- */
function refuse(code, detail) {
  throw new TypeError(`unpromisedWaitingTasks: ${code} — ${detail}`);
}

/**
 * unpromisedWaitingTasks(refs)
 *
 *   refs — a plan receipt's refs array (the sealed payload's `refs`), each
 *          `{ ref, supply: { unpromisedLines, unpromisedWaiting, ... } }`
 *          (the §14.6c additive supply facts).
 *
 * Returns (deterministic; sorted by refId):
 *   { tasks: [ { type: 'DATA_HEALTH', field, detail, severity } ],
 *     summary: { refs: <input count>, gapped: <task count>,
 *                unpromisedLines, unpromisedWaiting } }
 *
 * Throws (fail-closed, named): REFS_MALFORMED / REF_MALFORMED.
 */
function unpromisedWaitingTasks(refs) {
  if (!Array.isArray(refs)) {
    refuse('REFS_MALFORMED', 'refs must be the plan receipt\'s refs array — feed the sweep the receipt, not raw supply facts');
  }
  const tasks = [];
  let totalLines = 0;
  let totalWaiting = 0;
  for (const r of refs) {
    if (!r || typeof r.ref !== 'string' || r.ref === ''
        || !r.supply || typeof r.supply !== 'object') {
      refuse('REF_MALFORMED', `every ref carries its id and its §14.6c supply facts — a ref that never computed supply is not silently healthy (got ${JSON.stringify(r && r.ref)})`);
    }
    const lines = r.supply.unpromisedLines;
    const waiting = r.supply.unpromisedWaiting;
    if (!Number.isFinite(lines) || lines < 0) {
      refuse('REF_MALFORMED', `ref ${r.ref} supply.unpromisedLines must be a finite number >= 0, got ${JSON.stringify(lines)}`);
    }
    if (!Number.isFinite(waiting) || waiting < 0) {
      refuse('REF_MALFORMED', `ref ${r.ref} supply.unpromisedWaiting must be a finite number >= 0, got ${JSON.stringify(waiting)}`);
    }
    if (lines === 0) continue;   // gaps only — never confirmations
    totalLines += lines;
    totalWaiting += waiting;
    tasks.push({
      type: 'DATA_HEALTH',
      field: `${TASK_FIELD_PREFIX}${r.ref}`,
      detail: `${lines} open PO line${lines === 1 ? '' : 's'} for ${r.ref} carry waiting units with NO promised delivery date — follow-up without a promise is blind (§14.6c); total waiting ${waiting} planning units.`,
      severity: 'WARN',
    });
  }
  tasks.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return {
    tasks,
    summary: {
      refs: refs.length,
      gapped: tasks.length,
      unpromisedLines: totalLines,
      unpromisedWaiting: totalWaiting,
    },
  };
}

module.exports = { unpromisedWaitingTasks, TASK_FIELD_PREFIX };
