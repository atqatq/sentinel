'use strict';
/* Public contract of the planning-engine module (ADR-0001: cross-module
 * access goes through this surface, never through src/ internals).
 * supply.js is the M5 producer layer (§14.6c) beside the classifier it feeds. */
module.exports = {
  ...require('./src/engine.js'),
  ...require('./src/supply.js'),
};
