'use strict';
/* ============================================================================
 * setup/index.js — the §14.28 setup layer's PURE decision surface (the
 * Setup & onboarding phase, D-049). ADR-0001: everything that DECIDES lives
 * here; the SQL executor is @sentinel/db's makeSetupAdapter, the transport
 * is the /api/setup routes, the screens are /setup.
 *
 * Pure and deterministic: injected inputs only, no clock, no IO, no env.
 * The timezone allowlist is INJECTED (the boundary passes
 * Intl.supportedValuesOf('timeZone')) so the module stays environment-free.
 *
 * Every refusal is a named contract surface (the SETUP_* family, §14.28
 * clause 7): the API returns them verbatim, the screens render them
 * verbatim, and the database re-proves the origin rules itself (the
 * founder door's is_origin check — the API+DB pair).
 * ==========================================================================*/

const validate = require('./src/validate');
const steps = require('./src/steps');

module.exports = {
  ROLE_LADDER: validate.ROLE_LADDER,
  validateTenantCommand: validate.validateTenantCommand,
  validateUserCommand: validate.validateUserCommand,
  validateLimitsCommand: validate.validateLimitsCommand,
  remainingSteps: steps.remainingSteps,
};
