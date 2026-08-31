'use strict';
/* Public contract of the ingest-service module (ADR-0001: cross-module access
 * goes through this surface, never through src/ internals). */
module.exports = {
  runFileToRows: require('./src/worker').runFileToRows,
  csv: require('./src/csv'),
  expansion: require('./src/expansion'),
  rows: require('./src/rows'),
};
