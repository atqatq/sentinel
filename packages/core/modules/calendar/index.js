'use strict';
/* Public contract of the calendar module (ADR-0001: cross-module access
 * goes through this surface, never through src/ internals). */
module.exports = {
  ...require('./src/dates.js'),
  ...require('./src/calendar.js'),
};
