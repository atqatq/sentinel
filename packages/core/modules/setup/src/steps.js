'use strict';
/* ============================================================================
 * setup/src/steps.js — the wizard's honest state machine (§14.28 clause 6).
 *
 * §14.10: "Until step 3 completes, screens show first-run empty states that
 * name the missing dataset — never a spinner, never fabricated placeholder
 * rows." The Overview step renders FROM this derivation: the setup state is
 * DATA, and the remaining steps are computed, never guessed client-side.
 *
 * Deterministic: the §14.10 flow order (origin → tenant → users → limits →
 * first ingestion); completed steps are silent (the register carries GAPS,
 * never confirmations).
 * ==========================================================================*/

/* The step order is the §14.10 flow. Each entry names the overview fact
 * that CLOSES it (a boolean or a minimum count) plus the screen-facing
 * label and the detail the empty state renders. */
const STEP_DEFS = Object.freeze([
  {
    id: 'origin',
    label: 'Bootstrap the Origin account',
    detail: 'run scripts/setup/bootstrap-origin.mjs — the first Origin and its first tenant arrive together, in one transaction',
    isClosed: (o) => o.hasOrigin === true,
  },
  {
    id: 'tenant',
    label: 'Create additional tenants',
    detail: 'each tenant is created through the founder door — the acting Origin holds its first O by construction',
    isClosed: (o) => typeof o.tenantCount === 'number' && o.tenantCount >= 1,
  },
  {
    id: 'users',
    label: 'Create user accounts and roles',
    detail: 'every account lands with must_change — each user changes their own password at first sign-in',
    isClosed: (o) => typeof o.userCount === 'number' && o.userCount >= 2,
  },
  {
    id: 'limits',
    label: 'Set the approval limits',
    detail: 'the dual-control threshold and the per-role ceilings — the §16 amendment, done once at setup',
    isClosed: (o) => o.hasApprovalLimits === true,
  },
  {
    id: 'ingest',
    label: 'Run the first ingestion',
    detail: 'upload the template workbook — the worker\'s own pipeline runs in-process, the receipt is the worker\'s own',
    isClosed: (o) => o.hasFirstIngestion === true,
  },
]);

function remainingSteps(overview) {
  if (!overview || typeof overview !== 'object' || Array.isArray(overview)) {
    return [{ ok: false, reason: 'SETUP_SHAPE_INVALID', detail: 'the overview must be an object' }];
  }
  const out = [];
  for (const def of STEP_DEFS) {
    let closed = false;
    try { closed = def.isClosed(overview) === true; } catch (e) { closed = false; }
    if (!closed) out.push({ step: def.id, label: def.label, detail: def.detail });
  }
  return out;
}

module.exports = { STEP_DEFS, remainingSteps };
