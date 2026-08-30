'use strict';
/* Public contract of the ingestion module (ADR-0001: cross-module access
 * goes through this surface, never through src/ internals). */
module.exports = {
  parse: require('./src/parse.js'),
  filebinding: require('./src/filebinding.js'),
  normalize: require('./src/normalize.js'),
  window: require('./src/window.js'),
  hardening: require('./src/hardening.js'),
};
