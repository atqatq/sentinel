'use strict';
/* Public contract of the kpi-catalog module (ADR-0001: cross-module access
 * goes through this surface, never through src/ internals). */
module.exports = require('./src/catalog.js');
