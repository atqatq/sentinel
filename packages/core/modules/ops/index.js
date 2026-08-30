'use strict';
/* Public contract of the ops module (ADR-0001: cross-module access
 * goes through this surface, never through src/ internals).
 *
 * M9 freshness SLO + missing-deliveries alarm — the facts producer for the
 * kpi-catalog STALE envelope and the D-023 stale-data banner. Pure and
 * deterministic: the clock is always injected. */
module.exports = {
  freshness: require('./src/freshness.js'),
};
