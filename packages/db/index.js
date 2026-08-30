'use strict';
/* Public contract of the db package. SCHEMA_VERSION is the highest applied
 * migration number — stamped into every plan seal next to ENGINE_VERSION
 * so a production question resolves to the exact code+schema state
 * (delivery spec §6.2, closes the db half of L-07). Bump when 000N lands. */
module.exports = { SCHEMA_VERSION: '0002' };
