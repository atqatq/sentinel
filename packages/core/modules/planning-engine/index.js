'use strict';
/* Public contract of the planning-engine module (ADR-0001: cross-module
 * access goes through this surface, never through src/ internals). */
module.exports = require('./src/engine.js');
