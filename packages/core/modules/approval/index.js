'use strict';
/* Public contract of the approval module (ADR-0001: cross-module access
 * goes through this surface, never through src/ internals).
 *
 * The C3 financial-controls decision layer (gate 5, M3): the SoD invariant
 * (approver ≠ raiser), value-tiered approval limits, dual control above the
 * configurable threshold, and the supplier-identity change freeze — decided
 * here, ENFORCED twice (this layer AND the database: the RESTRICTIVE
 * sod_binding policy + the proposal_state_guard / supplier_identity_freeze
 * triggers). Pure and deterministic: the principal, the tiers, the prior
 * votes and the hold rows are always injected. Every refusal carries a
 * Class-D-shaped denial record; the ledger write that makes it durable is
 * H5's (the decision shape is fixed here so the ledger consumes it verbatim).
 */
module.exports = {
  roles: require('./src/roles.js'),
  decide: require('./src/decide.js'),
  freeze: require('./src/freeze.js'),
};
