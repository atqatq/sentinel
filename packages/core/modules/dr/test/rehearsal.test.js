'use strict';
/* ============================================================================
 * The disaster-recovery restore-rehearsal gate — the H11 named proof
 * `dr/restore-rehearsal-gate` (build spec §14.21; audit H11).
 *
 * The audit's acceptance shape is pinned FIRST: a full valid evidence set
 * PASSES and yields the deterministic record. Then both targets at their
 * boundaries, every refusal verdict, the accumulation order, the
 * undefined-drops lesson, the two-leg scope rule, the Origin-signed
 * closure family and the exact RESTORE_REHEARSAL_RECORDED event payload,
 * and the frozen policy data.
 * ==========================================================================*/
const assert = require('assert');
const DR = require('../index.js');

const SCHEMA = '0009';
const CONFIG = { expectedSchemaVersion: SCHEMA };

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }

/* ---- the evidence fixtures --------------------------------------------------
 * FULL: the signed staging rehearsal's evidence (both legs).
 * RESTORE-ONLY: the CI harness's leg (no wal section — archiving is a
 * deployment property the CI service postgres cannot honestly claim). */
const fullEvidence = (over) => ({
  rehearsal: {
    day: '2026-09-03',
    environment: 'staging',
    runbookVersion: '1.0.0',
    executedBy: 'dr-rehearsal-harness',
    ...over.rehearsal,
  },
  backup: {
    kind: 'logical-dump',
    checksumVerified: true,
    ...over.backup,
  },
  wal: {
    archiving: 'on',
    continuous: true,
    rpoMinutes: 4.5,
    ...over.wal,
  },
  restore: {
    rtoMinutes: 38,
    restoredSchemaVersion: SCHEMA,
    rlsVerified: true,
    chainVerified: true,
    ...over.restore,
  },
});
const restoreOnlyEvidence = (over) => {
  const e = fullEvidence({ wal: undefined, ...over });
  delete e.wal;
  return e;
};

/* ---- the audit's acceptance shape ------------------------------------------ */
console.log('\nThe audit acceptance — a full valid evidence set passes, the record is deterministic');

test('a full valid evidence set PASSES and yields the dated record', () => {
  const r = DR.evaluateRehearsal(fullEvidence({}), CONFIG);
  assert.strictEqual(r.verdict, 'PASS');
  assert.strictEqual(r.scope, 'full');
  assert.deepStrictEqual(r.refusals, []);
  assert.strictEqual(r.record.id, 'dr-rehearsal-2026-09-03-staging');
  assert.strictEqual(r.record.day, '2026-09-03');
  assert.strictEqual(r.record.environment, 'staging');
  assert.strictEqual(r.record.runbookVersion, '1.0.0');
  assert.strictEqual(r.record.backupKind, 'logical-dump');
  assert.strictEqual(r.record.schemaVersion, SCHEMA);
  assert.strictEqual(r.record.rpoMinutes, 4.5);
  assert.strictEqual(r.record.rtoMinutes, 38);
  assert.strictEqual(r.record.walArchiving, true);
  assert.strictEqual(r.record.walContinuous, true);
  assert.strictEqual(r.record.verdict, 'PASS');
});

test('the record is deterministic — same evidence, same record, byte for byte', () => {
  const a = DR.evaluateRehearsal(fullEvidence({}), CONFIG).record;
  const b = DR.evaluateRehearsal(fullEvidence({}), CONFIG).record;
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

test('a not-a-real calendar day is malformed evidence (the H4 canon — the calendar module decides)', () => {
  const r = DR.evaluateRehearsal(fullEvidence({ rehearsal: { day: '2026-02-30' } }), CONFIG);
  assert.strictEqual(r.verdict, 'FAIL');
  assert.ok(r.refusals.some((x) => x.code === 'REHEARSAL_EVIDENCE_MALFORMED' && x.detail.includes('2026-02-30')));
});

/* ---- the targets at their boundaries ---------------------------------------- */
console.log('\nThe targets — frozen policy data, pinned at the boundary');

test('RPO exactly 15 passes; 15.01 refuses REHEARSAL_RPO_BREACH naming the target', () => {
  assert.strictEqual(DR.evaluateRehearsal(fullEvidence({ wal: { rpoMinutes: 15 } }), CONFIG).verdict, 'PASS');
  const r = DR.evaluateRehearsal(fullEvidence({ wal: { rpoMinutes: 15.01 } }), CONFIG);
  assert.strictEqual(r.verdict, 'FAIL');
  const breach = r.refusals.find((x) => x.code === 'REHEARSAL_RPO_BREACH');
  assert.ok(breach, 'expected REHEARSAL_RPO_BREACH');
  assert.ok(breach.detail.includes('15'));
});

test('RTO exactly 240 passes; 240.01 refuses REHEARSAL_RTO_BREACH naming the target', () => {
  assert.strictEqual(DR.evaluateRehearsal(fullEvidence({ restore: { rtoMinutes: 240 } }), CONFIG).verdict, 'PASS');
  const r = DR.evaluateRehearsal(fullEvidence({ restore: { rtoMinutes: 240.01 } }), CONFIG);
  const breach = r.refusals.find((x) => x.code === 'REHEARSAL_RTO_BREACH');
  assert.ok(breach, 'expected REHEARSAL_RTO_BREACH');
  assert.ok(breach.detail.includes('240'));
});

test('the constants are the frozen numbers (15 / 240 / 90) and the verdict sets are exact', () => {
  assert.strictEqual(DR.RPO_TARGET_MINUTES, 15);
  assert.strictEqual(DR.RTO_TARGET_MINUTES, 240);
  assert.strictEqual(DR.REHEARSAL_CADENCE_DAYS, 90);
  assert.deepStrictEqual(DR.ENVIRONMENTS, ['staging', 'production']);
  assert.deepStrictEqual(DR.BACKUP_KINDS, ['base-backup', 'logical-dump']);
  assert.strictEqual(DR.ORIGIN_ROLE, 'O');
});

/* ---- the refusal family ------------------------------------------------------ */
console.log('\nThe refusal family — every defect named, the order normative');

test('archiving off refuses REHEARSAL_WAL_ARCHIVING_OFF — named BEFORE the RPO breach when both are wrong (the order pin)', () => {
  const r = DR.evaluateRehearsal(fullEvidence({ wal: { archiving: 'off', rpoMinutes: 999 } }), CONFIG);
  assert.strictEqual(r.verdict, 'FAIL');
  const codes = r.refusals.map((x) => x.code);
  const archIdx = codes.indexOf('REHEARSAL_WAL_ARCHIVING_OFF');
  const rpoIdx = codes.indexOf('REHEARSAL_RPO_BREACH');
  assert.ok(archIdx !== -1 && rpoIdx !== -1, `both expected, got ${codes.join(',')}`);
  assert.ok(archIdx < rpoIdx, 'archiving-off must be named before the RPO breach');
});

test('a non-continuous archive refuses REHEARSAL_WAL_NOT_CONTINUOUS (a gap is silent data loss)', () => {
  const r = DR.evaluateRehearsal(fullEvidence({ wal: { continuous: false } }), CONFIG);
  assert.ok(r.refusals.some((x) => x.code === 'REHEARSAL_WAL_NOT_CONTINUOUS'));
});

test('an unverified checksum refuses REHEARSAL_CHECKSUM_UNVERIFIED — verified BEFORE the restore', () => {
  const r = DR.evaluateRehearsal(fullEvidence({ backup: { checksumVerified: false } }), CONFIG);
  assert.ok(r.refusals.some((x) => x.code === 'REHEARSAL_CHECKSUM_UNVERIFIED'));
});

test('a folder copy is not a backup — REHEARSAL_BACKUP_INVALID', () => {
  const r = DR.evaluateRehearsal(fullEvidence({ backup: { kind: 'folder-copy' } }), CONFIG);
  assert.ok(r.refusals.some((x) => x.code === 'REHEARSAL_BACKUP_INVALID'));
});

test('a schema mismatch refuses REHEARSAL_SCHEMA_MISMATCH naming both versions', () => {
  const r = DR.evaluateRehearsal(fullEvidence({ restore: { restoredSchemaVersion: '0007' } }), CONFIG);
  const m = r.refusals.find((x) => x.code === 'REHEARSAL_SCHEMA_MISMATCH');
  assert.ok(m, 'expected REHEARSAL_SCHEMA_MISMATCH');
  assert.ok(m.detail.includes('0007') && m.detail.includes(SCHEMA));
});

test('an unproven RLS posture refuses REHEARSAL_RLS_UNVERIFIED', () => {
  const r = DR.evaluateRehearsal(fullEvidence({ restore: { rlsVerified: null } }), CONFIG);
  assert.ok(r.refusals.some((x) => x.code === 'REHEARSAL_RLS_UNVERIFIED'));
});

test('an unverified chain refuses REHEARSAL_CHAIN_UNVERIFIED — restored data is not the restored system', () => {
  const r = DR.evaluateRehearsal(fullEvidence({ restore: { chainVerified: false } }), CONFIG);
  assert.ok(r.refusals.some((x) => x.code === 'REHEARSAL_CHAIN_UNVERIFIED'));
});

test('a developer laptop is not a rehearsal venue — REHEARSAL_ENVIRONMENT_INVALID', () => {
  const r = DR.evaluateRehearsal(fullEvidence({ rehearsal: { environment: 'developer-laptop' } }), CONFIG);
  assert.ok(r.refusals.some((x) => x.code === 'REHEARSAL_ENVIRONMENT_INVALID'));
});

test('an unversioned procedure is not a procedure — REHEARSAL_RUNBOOK_UNVERSIONED', () => {
  const r = DR.evaluateRehearsal(fullEvidence({ rehearsal: { runbookVersion: '' } }), CONFIG);
  assert.ok(r.refusals.some((x) => x.code === 'REHEARSAL_RUNBOOK_UNVERSIONED'));
});

test('undefined drops silently from JSON — the absent field is REHEARSAL_EVIDENCE_MALFORMED (the honest absence is null)', () => {
  const r = DR.evaluateRehearsal(fullEvidence({ wal: { rpoMinutes: undefined } }), CONFIG);
  assert.strictEqual(r.verdict, 'FAIL');
  assert.ok(r.refusals.some((x) => x.code === 'REHEARSAL_EVIDENCE_MALFORMED' && x.detail.includes('rpoMinutes')));
});

test('multiple defects ACCUMULATE in the normative order, stable across runs (the 3 a.m. fix-it list)', () => {
  const bad = fullEvidence({
    rehearsal: { environment: 'developer-laptop', runbookVersion: null },
    backup: { kind: 'folder-copy', checksumVerified: false },
    restore: { rtoMinutes: 999 },
  });
  const a = DR.evaluateRehearsal(bad, CONFIG);
  const b = DR.evaluateRehearsal(bad, CONFIG);
  assert.strictEqual(a.verdict, 'FAIL');
  assert.ok(a.refusals.length >= 4, `expected >=4 refusals, got ${a.refusals.length}`);
  assert.strictEqual(JSON.stringify(a.refusals), JSON.stringify(b.refusals));
  const codes = a.refusals.map((x) => x.code);
  const envIdx = codes.indexOf('REHEARSAL_ENVIRONMENT_INVALID');
  const backupIdx = codes.indexOf('REHEARSAL_BACKUP_INVALID');
  const rtoIdx = codes.indexOf('REHEARSAL_RTO_BREACH');
  assert.ok(envIdx < backupIdx && backupIdx < rtoIdx, `order wrong: ${codes.join(',')}`);
});

test('non-object evidence refuses malformed; the unarmed config is a loud TypeError, never a silent pass', () => {
  const r = DR.evaluateRehearsal('the cat sat on the mat', CONFIG);
  assert.strictEqual(r.verdict, 'FAIL');
  assert.strictEqual(r.refusals[0].code, 'REHEARSAL_EVIDENCE_MALFORMED');
  assert.throws(() => DR.evaluateRehearsal(fullEvidence({}), {}), TypeError);
  assert.throws(() => DR.evaluateRehearsal(fullEvidence({}), null), TypeError);
  assert.throws(() => DR.evaluateRehearsal(fullEvidence({}), { expectedSchemaVersion: '' }), TypeError);
});

/* ---- the two legs and the scope rule ----------------------------------------- */
console.log('\nThe two legs — the CI restore leg is honest, and it cannot close the gate');

test('evaluateRestore passes the CI leg (no wal section) — scope restore, no RPO fields invented', () => {
  const r = DR.evaluateRestore(restoreOnlyEvidence({}), CONFIG);
  assert.strictEqual(r.verdict, 'PASS');
  assert.strictEqual(r.scope, 'restore');
  assert.strictEqual(r.record.scope, 'restore');
  assert.ok(!('rpoMinutes' in r.record) && !('walArchiving' in r.record), 'the restore record must not claim the WAL leg');
});

test('evaluateArchiving judges the WAL leg alone (the deployment rehearsal\'s arm)', () => {
  const okR = DR.evaluateArchiving({ wal: { archiving: 'on', continuous: true, rpoMinutes: 10 } });
  assert.strictEqual(okR.verdict, 'PASS');
  const badR = DR.evaluateArchiving({ wal: { archiving: 'off', continuous: true, rpoMinutes: 10 } });
  assert.strictEqual(badR.verdict, 'FAIL');
  assert.ok(badR.refusals.some((x) => x.code === 'REHEARSAL_WAL_ARCHIVING_OFF'));
});

test('a restore-only record cannot close gate 14 — GATE_SCOPE_INCOMPLETE', () => {
  const rec = DR.evaluateRestore(restoreOnlyEvidence({}), CONFIG).record;
  const g = DR.closeGate(rec, { signedBy: '11111111-1111-4111-8111-111111111111', signedRole: 'O', signedAt: '2026-09-03T09:00:00.000Z' });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'GATE_SCOPE_INCOMPLETE');
});

/* ---- the closure — the signed record is the ledger event ---------------------- */
console.log('\nThe closure — Origin signs, ONE Class-W RESTORE_REHEARSAL_RECORDED event');

test('a full PASS record + the Origin signoff yields the exact §16.2 event payload', () => {
  const rec = DR.evaluateRehearsal(fullEvidence({}), CONFIG).record;
  const g = DR.closeGate(rec, {
    signedBy: '11111111-1111-4111-8111-111111111111',
    signedRole: 'O',
    signedAt: '2026-09-03T09:00:00.000Z',
  });
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.event.class, 'W');
  assert.strictEqual(g.event.entity, 'dr_rehearsal');
  assert.strictEqual(g.event.entityId, 'dr-rehearsal-2026-09-03-staging');
  assert.strictEqual(g.event.action, 'RESTORE_REHEARSAL_RECORDED');
  assert.strictEqual(g.event.outcome, 'success');
  assert.strictEqual(g.event.before, null);
  assert.strictEqual(g.event.reason, null);
  assert.strictEqual(g.event.after.signedBy, '11111111-1111-4111-8111-111111111111');
  assert.strictEqual(g.event.after.signedRole, 'O');
  assert.strictEqual(g.event.after.signedAt, '2026-09-03T09:00:00.000Z');
  assert.deepStrictEqual(g.event.after.record, rec);
});

test('an unsigned closure refuses GATE_NOT_SIGNED; the literal system actor refuses too', () => {
  const rec = DR.evaluateRehearsal(fullEvidence({}), CONFIG).record;
  assert.strictEqual(DR.closeGate(rec, null).reason, 'GATE_NOT_SIGNED');
  assert.strictEqual(DR.closeGate(rec, {}).reason, 'GATE_NOT_SIGNED');
  assert.strictEqual(
    DR.closeGate(rec, { signedBy: 'system', signedRole: 'O', signedAt: '2026-09-03T09:00:00.000Z' }).reason,
    'GATE_NOT_SIGNED');
});

test('a non-Origin signature refuses GATE_ROLE_INVALID — gate 14 is Origin\'s to close', () => {
  const rec = DR.evaluateRehearsal(fullEvidence({}), CONFIG).record;
  const g = DR.closeGate(rec, {
    signedBy: '11111111-1111-4111-8111-111111111111',
    signedRole: 'SCM',
    signedAt: '2026-09-03T09:00:00.000Z',
  });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'GATE_ROLE_INVALID');
});

test('a FAIL record cannot be closed — GATE_REHEARSAL_NOT_PASSED', () => {
  const bad = DR.evaluateRehearsal(fullEvidence({ wal: { rpoMinutes: 999 } }), CONFIG);
  assert.strictEqual(bad.verdict, 'FAIL');
  const g = DR.closeGate(bad.record, { signedBy: '11111111-1111-4111-8111-111111111111', signedRole: 'O', signedAt: '2026-09-03T09:00:00.000Z' });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'GATE_REHEARSAL_NOT_PASSED');
});

console.log(`\ndr/restore-rehearsal-gate: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
