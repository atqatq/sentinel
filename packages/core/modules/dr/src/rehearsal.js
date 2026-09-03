'use strict';
/* ============================================================================
 * dr/rehearsal.js — the restore-rehearsal gate (build spec §14.21; audit
 * H11; named proof `dr/restore-rehearsal-gate`).
 *
 * The audit's finding: the contract had no disaster-recovery layer — no
 * RPO/RTO, no backup/restore requirement, no restore rehearsal. A platform
 * that is the sole holder of planning parameters, hash-chained history and
 * the learning corpus is a single storage accident away from losing all
 * three. The acceptance test is NOT a unit test: it is a documented, dated
 * restore rehearsal — a gate item signed by Origin, logged as a ledger
 * event. THIS module is the verdict layer that evidence passes through;
 * the RUNBOOK is the procedure; the harness (scripts/dr/rehearsal.js) is
 * the CI-adjacent staging drill that proves the restore path on every push.
 *
 * PURE decision layer (the ledger/auth/intelligence posture): the evidence
 * is injected — no IO, no env, no clock, no database. A gate that measures
 * itself cannot be trusted to grade itself. config.expectedSchemaVersion is
 * REQUIRED — a caller that cannot say which schema it expects is a
 * programming error (a loud TypeError), never a silent pass (the
 * unarmed-door posture).
 *
 * THE VERDICT ACCUMULATES, in a normative order (rehearsal metadata →
 * backup → wal → restore): a rehearsal report names EVERY defect — a gate
 * that stops at the first refusal serves nobody at 3 a.m.; the report is
 * the fix-it list. Deterministic: same evidence, same report, byte for
 * byte.
 *
 * THE TWO LEGS: the restore leg (backup + restore) is what any rehearsal
 * can prove — the CI harness proves it on every push. The full gate adds
 * the WAL leg, because RPO is a property of the DEPLOYMENT's archiving
 * cadence, and only the staging/production rehearsal can measure it
 * honestly. closeGate accepts ONLY a full-scope PASS record.
 * ==========================================================================*/

const { parseDateOnly } = require('../../calendar');

/* ---- The targets — frozen policy data, not prose (§14.21) ------------------
 * Loosening a target is a SPEC AMENDMENT, never a code edit. */
const RPO_TARGET_MINUTES = 15;      // continuous WAL archiving — the archive lag IS the worst-case loss
const RTO_TARGET_MINUTES = 240;     // four hours, restore included
const REHEARSAL_CADENCE_DAYS = 90;  // quarterly, plus the one staging rehearsal before cutover (gate 14)

const ENVIRONMENTS = ['staging', 'production'];
const BACKUP_KINDS = ['base-backup', 'logical-dump'];
const ORIGIN_ROLE = 'O';            // the §4 role code — the audit: "a gate item signed by Origin"

function refusal(code, detail) {
  return { code, detail };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/* Undefined drops silently from JSON — the honest absence is null. Any
 * field the schema names that is ABSENT (undefined) is malformed evidence;
 * null or a value violating the field's contract refuses with the field's
 * specific code when one exists. */
function fieldAbsent(v) {
  return v === undefined;
}

/* The day canon is the calendar module's (H4: one canonicalization per
 * system) — a rehearsal that is not DATED is not a rehearsal (the audit's
 * word), so a non-canonical day is malformed evidence. */
function validDay(v) {
  if (typeof v !== 'string') return false;
  return parseDateOnly(v).ok === true;
}

function validInstant(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v);
}

function validPrincipalUuid(v) {
  return typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
}

function requireSection(container, key, refusals) {
  const v = container[key];
  if (fieldAbsent(v)) {
    refusals.push(refusal('REHEARSAL_EVIDENCE_MALFORMED',
      `${key} is absent — undefined drops silently from JSON; the section must be present (null is not a section)`));
    return null;
  }
  if (!isPlainObject(v)) {
    refusals.push(refusal('REHEARSAL_EVIDENCE_MALFORMED', `${key} must be an object`));
    return null;
  }
  return v;
}

function checkString(section, key, refusals, absentCode, wrongCode, absentDetail, wrongDetail) {
  const v = section[key];
  if (fieldAbsent(v)) {
    refusals.push(refusal(absentCode, absentDetail));
    return;
  }
  if (v === null || typeof v !== 'string' || v === '') {
    refusals.push(refusal(wrongCode, wrongDetail));
  }
}

function checkMinutes(section, key, refusals, breachCode, target, label) {
  const v = section[key];
  if (fieldAbsent(v)) {
    refusals.push(refusal('REHEARSAL_EVIDENCE_MALFORMED',
      `${key} is absent — undefined drops silently from JSON (the honest absence is null; a number is required here)`));
    return;
  }
  if (!isFiniteNumber(v) || v < 0) {
    refusals.push(refusal('REHEARSAL_EVIDENCE_MALFORMED', `${key} must be a finite non-negative number, got ${JSON.stringify(v)}`));
    return;
  }
  if (v > target) {
    refusals.push(refusal(breachCode, `${label}: measured ${v} min against the ${target} min target (§14.21 — the target is frozen policy data)`));
  }
}

function checkBooleanTrue(section, key, refusals, unverifiedCode, detail) {
  const v = section[key];
  if (fieldAbsent(v)) {
    refusals.push(refusal('REHEARSAL_EVIDENCE_MALFORMED', `${key} is absent — undefined drops silently from JSON`));
    return;
  }
  if (v !== true) {
    refusals.push(refusal(unverifiedCode, detail));
  }
}

function checkEnum(section, key, refusals, allowed, invalidCode, absentDetail, invalidDetail) {
  const v = section[key];
  if (fieldAbsent(v)) {
    refusals.push(refusal('REHEARSAL_EVIDENCE_MALFORMED', absentDetail));
    return;
  }
  if (!allowed.includes(v)) {
    refusals.push(refusal(invalidCode, invalidDetail));
  }
}

/* ---- The arms (shared by both legs) ---------------------------------------- */

function checkRehearsalMetadata(rehearsal, refusals) {
  /* day — the audit's acceptance is DATED */
  const d = rehearsal.day;
  if (fieldAbsent(d)) {
    refusals.push(refusal('REHEARSAL_EVIDENCE_MALFORMED', 'rehearsal.day is absent — undefined drops silently from JSON (a rehearsal must be dated)'));
  } else if (!validDay(d)) {
    refusals.push(refusal('REHEARSAL_EVIDENCE_MALFORMED', `rehearsal.day must be a canonical H4 date (YYYY-MM-DD, real calendar day), got ${JSON.stringify(d)}`));
  }
  /* executedBy — the operator or the harness job, named */
  checkString(rehearsal, 'executedBy', refusals,
    'REHEARSAL_EVIDENCE_MALFORMED', 'REHEARSAL_EVIDENCE_MALFORMED',
    'rehearsal.executedBy is absent — undefined drops silently from JSON (who executed must be named)',
    'rehearsal.executedBy must be a non-empty string');
  /* environment — a developer laptop is not a rehearsal venue */
  checkEnum(rehearsal, 'environment', refusals, ENVIRONMENTS,
    'REHEARSAL_ENVIRONMENT_INVALID',
    'rehearsal.environment is absent — undefined drops silently from JSON',
    `rehearsal.environment must be one of ${ENVIRONMENTS.join(' | ')} (§14.21: the venue is staging or production)`);
  /* runbookVersion — an unversioned procedure is not a procedure */
  checkString(rehearsal, 'runbookVersion', refusals,
    'REHEARSAL_EVIDENCE_MALFORMED', 'REHEARSAL_RUNBOOK_UNVERSIONED',
    'rehearsal.runbookVersion is absent — undefined drops silently from JSON',
    'rehearsal.runbookVersion must name the RUNBOOK version the rehearsal followed (docs/RUNBOOK.md)');
}

function checkBackup(backup, refusals) {
  checkEnum(backup, 'kind', refusals, BACKUP_KINDS,
    'REHEARSAL_BACKUP_INVALID',
    'backup.kind is absent — undefined drops silently from JSON',
    `backup.kind must be one of ${BACKUP_KINDS.join(' | ')} — a folder copy is not a backup`);
  checkBooleanTrue(backup, 'checksumVerified', refusals,
    'REHEARSAL_CHECKSUM_UNVERIFIED',
    'backup.checksumVerified must be true — the checksum is verified BEFORE the restore, or the backup is a hypothesis');
}

function checkRestore(restore, expectedSchemaVersion, refusals) {
  checkMinutes(restore, 'rtoMinutes', refusals,
    'REHEARSAL_RTO_BREACH', RTO_TARGET_MINUTES, 'RTO');
  const v = restore.restoredSchemaVersion;
  if (fieldAbsent(v)) {
    refusals.push(refusal('REHEARSAL_EVIDENCE_MALFORMED', 'restore.restoredSchemaVersion is absent — undefined drops silently from JSON'));
  } else if (v !== expectedSchemaVersion) {
    refusals.push(refusal('REHEARSAL_SCHEMA_MISMATCH',
      `restored schema ${JSON.stringify(v)} against expected ${JSON.stringify(expectedSchemaVersion)} — a restore that lands the wrong migrations is not the system`));
  }
  checkBooleanTrue(restore, 'rlsVerified', refusals,
    'REHEARSAL_RLS_UNVERIFIED',
    'restore.rlsVerified must be true — the RLS posture is re-proven on the restored copy, not assumed');
  checkBooleanTrue(restore, 'chainVerified', refusals,
    'REHEARSAL_CHAIN_UNVERIFIED',
    'restore.chainVerified must be true — a restore that loses the chain\'s continuity has restored data, not the system');
}

function checkWal(wal, refusals) {
  const a = wal.archiving;
  if (fieldAbsent(a)) {
    refusals.push(refusal('REHEARSAL_EVIDENCE_MALFORMED', 'wal.archiving is absent — undefined drops silently from JSON'));
  } else if (a !== 'on') {
    refusals.push(refusal('REHEARSAL_WAL_ARCHIVING_OFF',
      `wal.archiving must be the literal 'on' — the evidence does not show archiving on, whatever the reason (got ${JSON.stringify(a)})`));
  }
  checkBooleanTrue(wal, 'continuous', refusals,
    'REHEARSAL_WAL_NOT_CONTINUOUS',
    'wal.continuous must be true — no gaps in the archive between the backup cut and the restore point');
  checkMinutes(wal, 'rpoMinutes', refusals,
    'REHEARSAL_RPO_BREACH', RPO_TARGET_MINUTES, 'RPO');
}

/* ---- The record (PASS only) -------------------------------------------------
 * Deterministic: same evidence, same record, byte for byte. The id embeds
 * the day and the venue — the dated artifact the audit asks for. */
function buildRecord(rehearsal, backup, restore, config, scope, wal) {
  const record = {
    id: `dr-rehearsal-${rehearsal.day}-${rehearsal.environment}`,
    day: rehearsal.day,
    environment: rehearsal.environment,
    runbookVersion: rehearsal.runbookVersion,
    executedBy: rehearsal.executedBy,
    backupKind: backup.kind,
    checksumVerified: true,
    rtoMinutes: restore.rtoMinutes,
    schemaVersion: config.expectedSchemaVersion,
    rlsVerified: true,
    chainVerified: true,
    scope,
    verdict: 'PASS',
    refusals: [],
  };
  if (scope === 'full') {
    record.walArchiving = true;
    record.walContinuous = true;
    record.rpoMinutes = wal.rpoMinutes;
  }
  return record;
}

function requireConfig(config) {
  /* The unarmed-door posture: a caller that cannot say which schema it
   * expects is a programming error — loud, never a silent pass. */
  if (!config || typeof config !== 'object' || typeof config.expectedSchemaVersion !== 'string' || config.expectedSchemaVersion === '') {
    throw new TypeError('evaluateRehearsal: config.expectedSchemaVersion is REQUIRED — name the SCHEMA_VERSION the restored copy must carry');
  }
  return config;
}

/* ---- evaluateRestore — the restore leg (what any rehearsal can prove) -------
 * evidence: { rehearsal, backup, restore } — the CI harness's leg. */
function evaluateRestore(evidence, config) {
  requireConfig(config);
  const scope = 'restore';
  if (!isPlainObject(evidence)) {
    return { verdict: 'FAIL', refusals: [refusal('REHEARSAL_EVIDENCE_MALFORMED', 'the evidence must be an object')], record: null, scope };
  }
  const refusals = [];
  const rehearsal = requireSection(evidence, 'rehearsal', refusals);
  const backup = requireSection(evidence, 'backup', refusals);
  const restore = requireSection(evidence, 'restore', refusals);
  /* Normative accumulation order: rehearsal metadata → backup → restore. */
  if (rehearsal) checkRehearsalMetadata(rehearsal, refusals);
  if (backup) checkBackup(backup, refusals);
  if (restore) checkRestore(restore, config.expectedSchemaVersion, refusals);

  if (refusals.length > 0) {
    return { verdict: 'FAIL', refusals, record: null, scope };
  }
  return { verdict: 'PASS', refusals: [], record: buildRecord(rehearsal, backup, restore, config, scope, null), scope };
}

/* ---- evaluateArchiving — the WAL leg (what the deployment rehearsal proves) -
 * evidence: { wal } — the staging/production leg that measures the RPO. */
function evaluateArchiving(evidence) {
  const scope = 'wal';
  if (!isPlainObject(evidence)) {
    return { verdict: 'FAIL', refusals: [refusal('REHEARSAL_EVIDENCE_MALFORMED', 'the evidence must be an object')], record: null, scope };
  }
  const refusals = [];
  const wal = requireSection(evidence, 'wal', refusals);
  if (wal) checkWal(wal, refusals);
  if (refusals.length > 0) {
    return { verdict: 'FAIL', refusals, record: null, scope };
  }
  return { verdict: 'PASS', refusals: [], record: null, scope };
}

/* ---- evaluateRehearsal — the FULL gate (both legs) ---------------------------
 * evidence: { rehearsal, backup, wal, restore } — the signed staging
 * rehearsal's evidence. PASS here is what closeGate accepts. */
function evaluateRehearsal(evidence, config) {
  requireConfig(config);
  const scope = 'full';
  if (!isPlainObject(evidence)) {
    return { verdict: 'FAIL', refusals: [refusal('REHEARSAL_EVIDENCE_MALFORMED', 'the evidence must be an object')], record: null, scope };
  }
  const refusals = [];
  const rehearsal = requireSection(evidence, 'rehearsal', refusals);
  const backup = requireSection(evidence, 'backup', refusals);
  const wal = requireSection(evidence, 'wal', refusals);
  const restore = requireSection(evidence, 'restore', refusals);
  /* Normative accumulation order: rehearsal metadata → backup → wal → restore. */
  if (rehearsal) checkRehearsalMetadata(rehearsal, refusals);
  if (backup) checkBackup(backup, refusals);
  if (wal) checkWal(wal, refusals);
  if (restore) checkRestore(restore, config.expectedSchemaVersion, refusals);

  if (refusals.length > 0) {
    return { verdict: 'FAIL', refusals, record: null, scope };
  }
  return { verdict: 'PASS', refusals: [], record: buildRecord(rehearsal, backup, restore, config, scope, wal), scope };
}

/* ---- closeGate — the signed record is the ledger event ----------------------
 * record: the PASS record from evaluateRehearsal (FULL scope only).
 * signoff: { signedBy (principal uuid, never 'system'), signedRole ('O' —
 * Origin; the audit: "a gate item signed by Origin"), signedAt (canonical
 * UTC instant) }.
 *
 * → { ok: true, event } where event is the §16.2 payload the ledger's
 * append door re-proves: ONE Class-W RESTORE_REHEARSAL_RECORDED block —
 * the rehearsal answerable by the same tamper-evident chain it just proved
 * it can restore.
 * → { ok: false, reason, detail } for the closure refusal family. */
function closeGate(record, signoff) {
  if (!isPlainObject(record)) {
    return { ok: false, reason: 'GATE_REHEARSAL_NOT_PASSED', detail: 'closeGate needs the record evaluateRehearsal returned — an object, not ' + typeof record };
  }
  if (record.scope !== 'full') {
    return { ok: false, reason: 'GATE_SCOPE_INCOMPLETE', detail: `scope ${JSON.stringify(record.scope)} cannot close gate 14 — the CI restore leg proves the drill works; only the FULL rehearsal (both legs) closes the gate` };
  }
  if (record.verdict !== 'PASS') {
    return { ok: false, reason: 'GATE_REHEARSAL_NOT_PASSED', detail: `verdict ${JSON.stringify(record.verdict)} — only a PASS record closes the gate` };
  }
  if (!isPlainObject(signoff)) {
    return { ok: false, reason: 'GATE_NOT_SIGNED', detail: 'the audit\'s acceptance is a gate item SIGNED by Origin — signoff { signedBy, signedRole, signedAt } is required' };
  }
  if (fieldAbsent(signoff.signedBy) || !validPrincipalUuid(signoff.signedBy)) {
    return { ok: false, reason: 'GATE_NOT_SIGNED', detail: 'signoff.signedBy must be the signing principal\'s uuid — never the literal \'system\'' };
  }
  if (fieldAbsent(signoff.signedRole)) {
    return { ok: false, reason: 'GATE_NOT_SIGNED', detail: 'signoff.signedRole is absent — undefined drops silently from JSON' };
  }
  if (signoff.signedRole !== ORIGIN_ROLE) {
    return { ok: false, reason: 'GATE_ROLE_INVALID', detail: `signoff.signedRole must be the Origin role code '${ORIGIN_ROLE}' — gate 14 is Origin's to close (the audit: "a gate item signed by Origin"), got ${JSON.stringify(signoff.signedRole)}` };
  }
  if (fieldAbsent(signoff.signedAt)) {
    return { ok: false, reason: 'GATE_NOT_SIGNED', detail: 'signoff.signedAt is absent — undefined drops silently from JSON' };
  }
  if (!validInstant(signoff.signedAt)) {
    return { ok: false, reason: 'GATE_NOT_SIGNED', detail: 'signoff.signedAt must be a canonical UTC instant (RFC 3339, Z) — the ledger door re-proves the shape' };
  }
  return {
    ok: true,
    event: {
      class: 'W',
      entity: 'dr_rehearsal',
      entityId: record.id,
      action: 'RESTORE_REHEARSAL_RECORDED',
      outcome: 'success',
      before: null,
      after: {
        record,
        signedBy: signoff.signedBy,
        signedRole: signoff.signedRole,
        signedAt: signoff.signedAt,
      },
      reason: null,
    },
  };
}

module.exports = {
  RPO_TARGET_MINUTES,
  RTO_TARGET_MINUTES,
  REHEARSAL_CADENCE_DAYS,
  ENVIRONMENTS,
  BACKUP_KINDS,
  ORIGIN_ROLE,
  evaluateRestore,
  evaluateArchiving,
  evaluateRehearsal,
  closeGate,
};
