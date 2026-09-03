'use strict';
/* Public contract of the procure-service package (ADR-0001: the service
 * surface; the plan-service handler pattern).
 *
 * §14.13c — the CF decide/apply API: the sourcing-controls decision
 * boundary. Semantics live here (HTTP-agnostic, testable without a
 * server); the Next.js route is thin transport only (session resolution,
 * the GUC fence, one transaction). */
module.exports = {
  handleCfDecision: require('./src/cf-api').handleCfDecision,
};
