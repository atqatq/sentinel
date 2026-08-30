'use strict';
/* Public contract of the ingestion module (ADR-0001: cross-module access
 * goes through this surface, never through src/ internals). */

/* The canonical dataset kinds (file types) this module ingests — read from
 * this module's own manifest so the surface and the manifest cannot drift.
 * The ops/freshness suite (M9) pins the exact list: a kind added without
 * reviewing ops coverage fails CI there. */
const MANIFEST = require('./sentinel.module.json');
const DATASET_KINDS = Object.freeze([...MANIFEST.ingestionKinds]);

module.exports = {
  DATASET_KINDS,
  parse: require('./src/parse.js'),
  filebinding: require('./src/filebinding.js'),
  normalize: require('./src/normalize.js'),
  window: require('./src/window.js'),
  hardening: require('./src/hardening.js'),
  idempotency: require('./src/idempotency.js'),
};
