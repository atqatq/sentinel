'use strict';
/* The migration contract constant, in its own module so both the package
 * index and the adapters (plan-adapter arms the M8 ledger door with it)
 * can carry the stamp without a circular require. Bump when 000N lands. */
module.exports = { SCHEMA_VERSION: '0008' };
