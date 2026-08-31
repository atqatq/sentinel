'use strict';
/* Public contract of the db package. SCHEMA_VERSION is the highest applied
 * migration number — stamped into every plan seal next to ENGINE_VERSION
 * so a production question resolves to the exact code+schema state
 * (delivery spec §6.2, closes the db half of L-07). Bump when 000N lands.
 *
 * plan-adapter is the pg-backed ports adapter for the plan-service (the
 * single SQL source shared by apps/web and the live proof); data-health-adapter
 * is the read-side single SQL source for the data-health facts surface;
 * ingest-adapter is the executor of the H6 idempotent upsert wrapper (the
 * decision lives in the ingestion module — this package owns the SQL);
 * ledger-adapter is the executor of the H5 hash-chained ledger (the decision
 * lives in the ledger module — this package owns the SQL).
 * pg is touched lazily so this contract imports cleanly without a database. */
module.exports = {
  SCHEMA_VERSION: '0005',
  makePlanAdapter: require('./plan-adapter').makePlanAdapter,
  connectPlanClient: require('./plan-adapter').connectPlanClient,
  pgDriver: require('./plan-adapter').pgDriver,
  makeDataHealthAdapter: require('./data-health-adapter').makeDataHealthAdapter,
  resolveTenantByCode: require('./data-health-adapter').resolveTenantByCode,
  makeIngestAdapter: require('./ingest-adapter').makeIngestAdapter,
  INGEST_WIRED_KINDS: require('./ingest-adapter').WIRED_KINDS,
  makeProcureAdapter: require('./procure-adapter').makeProcureAdapter,
  makeLedgerAdapter: require('./ledger-adapter').makeLedgerAdapter,
  makeAuthAdapter: require('./auth-adapter').makeAuthAdapter,
};
