'use strict';
/* Public contract of the dr module (ADR-0001: cross-module access goes
 * through this surface, never through src/ internals).
 *
 * The H11 restore-rehearsal gate (§14.21): the verdict layer over
 * disaster-recovery evidence — the targets are frozen policy data
 * (RPO 15 / RTO 240 / quarterly cadence), the verdict ACCUMULATES every
 * defect in a normative order (the 3 a.m. fix-it list), the two legs
 * (restore / archiving) are separable because RPO belongs to the
 * deployment, and the Origin-signed closure yields the ONE Class-W
 * RESTORE_REHEARSAL_RECORDED event the ledger door re-proves. Pure —
 * no IO, no env, no clock, no database; the day canon is the calendar
 * module's (H4).
 */
module.exports = {
  ...require('./src/rehearsal.js'),
};
