'use strict';
/* Public contract of the plan-service module (ADR-0001: cross-module access
 * goes through this surface, never through src/ internals). */
module.exports = {
  runPlan: require('./src/plan').runPlan,
  handlePlanRun: require('./src/handler').handlePlanRun,
  canonicalJson: require('./src/canonicalJson').canonicalJson,
  summarizeRestatementDelta: require('./src/plan').summarizeRestatementDelta,
};
