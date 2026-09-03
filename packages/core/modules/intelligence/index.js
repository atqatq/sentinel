'use strict';
/* Public contract of the intelligence module (ADR-0001: cross-module
 * access goes through this surface, never through src/ internals).
 *
 * The M13 egress allow-list door (§14.20): the closed ecosystem's one
 * governed exception. classifyEgress is the fail-closed verdict layer every
 * outbound Intelligence request passes BEFORE any transport can exist; the
 * §16.4 log envelope carries the prompt hash + field allow-list, never the
 * content. Pure — no IO, no env, no fetch, no credential values.
 */
module.exports = {
  ...require('./src/policy.js'),
};
