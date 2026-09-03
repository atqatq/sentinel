# RUNBOOK

`RUNBOOK_VERSION: 1.1.0` — stamped; every rehearsal evidence set names the version it followed
(`rehearsal.runbookVersion`), and the gate refuses an unversioned procedure
(`REHEARSAL_RUNBOOK_UNVERSIONED`). Bump this version whenever the procedure changes, and record the
change in `DECISIONS.md` if it moves a contract surface.

This book is the operational half of the disaster-recovery contract (build spec §14.21; audit H11;
named proof `dr/restore-rehearsal-gate`), plus the triage flows the delivery spec's docs table
assigns here: freshness-alarm triage (M9), the quarantine review flow (C4/H10), and the ingestion
incident playbook.

---

## 1. Disaster recovery — targets and posture (H11, gate 14)

**The targets are frozen policy data** (§14.21; loosening one is a spec amendment, never an edit):

| Target | Value | Where it is proven |
|---|---|---|
| RPO — worst-case data loss | ≤ 15 min | the WAL leg of a rehearsal (`wal.rpoMinutes`) |
| RTO — restore duration | ≤ 240 min (4 h) | the restore leg of a rehearsal (`restore.rtoMinutes`) |
| Cadence | quarterly (90 days) + once in staging before cutover | the RUNBOOK schedule (this section) |

**The posture (deployment contract, delivery spec §7.4):**

1. **Continuous WAL archiving** — the production cluster runs `archive_mode = on` with
   `archive_command` shipping segments to durable storage. The archive lag IS the worst-case loss:
   at any moment, at most the un-archived tail can be lost. Monitor `pg_stat_archiver`
   (`last_archived_time`, `failed_count`) daily; a lag over 15 minutes is an incident, not a note.
2. **Nightly logical dump** — `pg_dump -Fc` per database, checksummed (sha256) at creation, retained
   per the backup-retention schedule. The dump is the belt to the WAL braces: it makes the restore
   rehearsal possible without the archive, and the archive makes the dump's data loss bounded.
3. **Roles are cluster-level.** The migrations create the role floor (`sentinel_app`,
   `sentinel_verifier`) with `CREATE ROLE`, and roles are NOT database objects — `pg_dump` restores
   grants, never roles. Any cross-cluster restore begins with `pg_dumpall --roles-only` from the
   source cluster (or the documented role-creation script) BEFORE `pg_restore`, or every GRANT in
   the dump fails.

**The three layers, one gate** (§14.21): the deployment posture above; the PURE verdict module
(`packages/core/modules/dr` — evidence in, verdict out, refusals accumulated in normative order);
and the CI-adjacent harness (`scripts/dr/rehearsal.js`, the CI db-rls job) that proves the restore
path on every push — dump, checksum, DESTROY the source, restore into a clean database, then the
schema sentinel probe, the RLS deny probe and the chain verify. The pre-cutover rehearsal
rehearses a drill that already works.

### 1.1 The restore rehearsal — procedure (the go-live gate item)

Execute top to bottom; every step lands a line in the run sheet (dated, signed at the end). The
rehearsal is FULL scope only: both legs, staging or production, from the versioned RUNBOOK.

**Pre-flight (the WAL leg's evidence comes from here):**

1. Confirm archiving on the SOURCE cluster: `SHOW archive_mode` → must be `on`; check
   `pg_stat_archiver.last_archived_time` — the lag defines `wal.rpoMinutes` (the measured
   worst-case loss window). A lag over 15 minutes: STOP — fix archiving first; the rehearsal would
   honestly fail (`REHEARSAL_RPO_BREACH`).
2. Confirm archive continuity across the backup window (no gaps between the base backup's start and
   the restore point) → `wal.continuous`. `pg_waldump` on the segment span, or the archive tool's
   gap report.
3. Take or locate the backup: a base backup (`pg_basebackup`) or the latest nightly logical dump
   (`backup.kind: 'base-backup' | 'logical-dump'`). A folder copy is not a backup — the gate refuses
   it (`REHEARSAL_BACKUP_INVALID`).
4. Checksum the backup artifact (sha256) and VERIFY the checksum against the recorded digest BEFORE
   restoring (`backup.checksumVerified`).

**Execute (the restore leg's timing):**

5. Restore into a CLEAN staging cluster (never over a live dataset). Cross-cluster: restore roles
   first (see the posture note). Start the clock before the first restore command; stop it when the
   last verification probe returns — that duration is `restore.rtoMinutes`.
6. For a base backup: restore the base, then replay WAL to the restore point. For a logical dump:
   `pg_restore --no-owner --dbname=<clean>`.

**Post-restore verification (every probe is evidence):**

7. Schema sentinels — confirm the migration floor survived: `ledger_block` (0004),
   `plan_seal_restatement` (0008), `fx_rate_pin` (0009), and the founder door
   `setup_create_tenant_with_founder` (0010 — the first FUNCTION sentinel, probed in `pg_proc`:
   0010's identity object is the §14.28 setup door, D-049). The highest sentinel present is the
   restored schema version → `restore.restoredSchemaVersion`; the gate compares it against the
   expected `SCHEMA_VERSION` (`REHEARSAL_SCHEMA_MISMATCH` otherwise).
8. RLS probes — `plan_seal` and `ledger_block` must carry `ENABLE + FORCE ROW LEVEL SECURITY`; as
   the app role (never a superuser), a cross-tenant SELECT returns nothing and the deny matrix is
   re-run green → `restore.rlsVerified`.
9. Chain verify — walk the restored ledger through the read-side verifier under the read-only
   `sentinel_verifier` role: `verifyChain` green, block count matches the pre-dump count →
   `restore.chainVerified`.

**Evaluate and close:**

10. Collect the evidence object (`rehearsal`, `backup`, `wal`, `restore`) and run it through the
    gate: `evaluateRehearsal(evidence, { expectedSchemaVersion: SCHEMA_VERSION })`. Every refusal is
    a fix-it item — the report names ALL of them, in order; re-rehearse after any fix.
11. On PASS: **Origin signs** — `closeGate(record, { signedBy, signedRole: 'O', signedAt })`. Only
    Origin closes gate 14 (`GATE_ROLE_INVALID` otherwise); the literal `system` never signs.
12. Land ONE Class-W `RESTORE_REHEARSAL_RECORDED` block through the ledger's append door with the
    signer's session envelope (§16.3 rule 2 posture). The rehearsal is thereby answerable by the
    same tamper-evident chain it just proved it can restore.
13. Archive the run sheet (evidence + record + refusals if any) with the rehearsal date. The
    schedule: quarterly from the last PASS record's `day`; the next due date is the last day + 90
    (`REHEARSAL_CADENCE_DAYS`).

### 1.2 The refusal family — what each means, what to do

| Refusal | Meaning | Fix |
|---|---|---|
| `REHEARSAL_EVIDENCE_MALFORMED` | the evidence object violates the schema (an undefined field, a non-canonical day, a non-number duration) | fix the collector — `undefined` drops silently from JSON; the honest absence is null, and here a real value is required |
| `REHEARSAL_BACKUP_INVALID` | the backup kind is not `base-backup` / `logical-dump` | take a real backup; a folder copy is not a backup |
| `REHEARSAL_CHECKSUM_UNVERIFIED` | the checksum was not verified before the restore | verify the digest against the recorded one; re-dump if it mismatches |
| `REHEARSAL_WAL_ARCHIVING_OFF` | the evidence does not show archiving on | fix `archive_mode` / `archive_command` on the source cluster; re-rehearse |
| `REHEARSAL_WAL_NOT_CONTINUOUS` | a gap in the archive between backup cut and restore point | locate the gap; restore from a later base backup inside a continuous span |
| `REHEARSAL_RPO_BREACH` | measured loss window > 15 min | reduce the archive lag (more frequent `archive_timeout`, faster shipping); re-measure |
| `REHEARSAL_RTO_BREACH` | restore duration > 240 min | rehearse with parallel restore (`pg_restore -j`), faster storage, or a standing warm replica |
| `REHEARSAL_SCHEMA_MISMATCH` | the restored schema version ≠ the expected `SCHEMA_VERSION` | re-apply migrations on the restored copy or restore from a complete dump; never "fix" by editing data |
| `REHEARSAL_RLS_UNVERIFIED` | the RLS posture was not re-proven on the restored copy | re-run the deny matrix against the restore; check grants/roles came along |
| `REHEARSAL_CHAIN_UNVERIFIED` | the hash chain did not verify green on the restored copy | investigate the restore path (truncation, encoding); the chain is the system's memory — a restore that loses it is not a restore |
| `REHEARSAL_ENVIRONMENT_INVALID` | the venue is not staging/production | rehearse where it counts — a developer laptop proves nothing |
| `REHEARSAL_RUNBOOK_UNVERSIONED` | the evidence does not name the RUNBOOK version followed | stamp the run sheet with this book's version |
| `GATE_SCOPE_INCOMPLETE` | a restore-only (CI-leg) record was offered to `closeGate` | run the FULL rehearsal (both legs) in staging |
| `GATE_REHEARSAL_NOT_PASSED` | a non-PASS record was offered to `closeGate` | fix the refusals first; the report is the list |
| `GATE_NOT_SIGNED` / `GATE_ROLE_INVALID` | the signoff is missing, not a principal uuid, not the instant shape, or not Origin (`O`) | Origin signs — that is the audit's acceptance, verbatim |

---

## 2. Freshness-alarm triage (M9, DAT-01)

The freshness machinery (`packages/core/modules/ops`) evaluates, per tenant and file kind, the hours
since the last successful seal: ≤ 26 h fresh; > 26 h stale (banner); > 36 h ALARM — a DATA_HEALTH
task naming the channel, owner DTA. A file type with no seal ever is ALARM with a null age — never
fresh by silence. The deliveries dataset carries its own `MISSING_DELIVERIES` channel with a
tenant-amendable cadence threshold (daily preferred default), because the engine's H8 gate refuses
rate seeding on silent deliveries.

Triage:

1. **Name the channel** — the alarm names tenant, file kind and age; check whether the source file
   simply has not arrived (the common case) or arrived and failed (see §4).
2. **Not arrived** — chase the export schedule at the source system; the tenant's timezone is a
   display concern, the age is computed on the H4 canon.
3. **Arrived but not sealed** — the worker's run log names the stage (parse → convert → upsert →
   plan); jump to §4 if the refusal is an ingestion one.
4. **The FX channels** — `FX_STALE` / `FX_NEVER_PINNED` (owner DTA, binary because DAT-06's target
   is 100% daily): re-pin through the pin door (`correctRate` for a different rate — never an
   overwrite; DELETE is refused structurally). The run continues stale-visible on the last pinned
   rate ≤ the day, and the banner names `staleDays`.
5. **Close the loop** — the alarm clears on the next successful seal; a repeated alarm on the same
   channel across 3 days is a data-health task escalation, not a new triage.

## 3. Quarantine review flow (C4 / H10)

Strict-parse failures, bound breaches, unknown file kinds, zip/XXE/AV refusals and PO_STATUS_UNKNOWN
rows land in quarantine — never silently coerced (the `nz('1,200') === 0` disease is refused by
design). Review:

1. Open the quarantine list per import run (the run id resolves every quarantined row to its file,
   sheet and row).
2. For each row, decide **fix-at-source** (the default: the file is wrong; re-export and re-upload)
   or **discard** (the row is genuinely junk). There is no third option that edits data inside
   Sentinel — correction happens at the source of truth.
3. Discards are logged with the reviewer and the reason; the ledger carries the refusal trail
   (Class D) already.
4. A quarantine spike (whole file, whole sheet) is an ingestion incident (§4), not a row-by-row
   review.

## 4. Ingestion incident playbook

1. **Stop** — do not re-upload the same file hoping for a different verdict; ingestion is
   idempotent per tenant and file (H6), so a re-run after a fix is safe and a re-run without a fix
   replays the same refusals.
2. **Read the run's disclosure lines** — the worker names every gate that refused and why (strict
   parse, conversion, bounds, window alignment H8, supplier identity H7, FX RATE_NOT_PINNED).
3. **Fix at the source** — the export template, the conversion factors, the FX pin (§2 step 4) or
   the supplier identity mapping; then re-upload. The replay is a no-op for already-ingested rows
   and lands only the fixed delta.
4. **The window guard (H8)** — if the deliveries history does not cover the consumption window, the
   run refuses to seed rates; upload the longer deliveries history first.
5. **Escalate** — if a refusal is wrong (the gate refuses good data), capture the file shape, the
   refusal code and the run id; the refusal families are contract surfaces (§14.x) and a wrong
   refusal is a bug against the spec, fixed in code, never bypassed in ops.
