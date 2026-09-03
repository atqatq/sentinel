'use strict';
/* Public contract of the ops module (ADR-0001: cross-module access
 * goes through this surface, never through src/ internals).
 *
 * M9 freshness SLO + missing-deliveries alarm — the facts producer for the
 * kpi-catalog STALE envelope, the D-023 stale-data banner and the
 * data-health screens. Pure and deterministic: the clock is always injected.
 *
 * freshness.DATASET_KINDS re-exports the ingestion module's manifest-derived
 * kind list: the pipeline-vocabulary this module consumes. Consumers of the
 * freshness facts (the app's data-health composition) need the kinds to
 * build the seal-stamp array — they read them HERE, so the app depends on
 * one core surface for the whole freshness contract, and the re-export is
 * bound by test to ingestion's own manifest (surface cannot drift). */
module.exports = {
  freshness: require('./src/freshness.js'),
  fx: require('./src/fx.js'),
  datahealth: require('./src/datahealth.js'),
};
