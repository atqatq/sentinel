'use strict';
/* Public contract of the db package. SCHEMA_VERSION is the highest applied
 * migration number — stamped into every plan seal next to ENGINE_VERSION
 * so a production question resolves to the exact code+schema state
 * (delivery spec §6.2, closes the db half of L-07). Bump when 000N lands.
 *
 * plan-adapter is the pg-backed ports adapter for the plan-service (the
 * single SQL source shared by apps/web and the live proof); pg is touched
 * lazily so this contract imports cleanly without a database. */
module.exports = {
  SCHEMA_VERSION: '0002',
  makePlanAdapter: require('./plan-adapter').makePlanAdapter,
  connectPlanClient: require('./plan-adapter').connectPlanClient,
  pgDriver: require('./plan-adapter').pgDriver,
};
