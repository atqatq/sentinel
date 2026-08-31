# M4 Exit Review — Closed loop (`0.5.0`)

**Date:** 2026-09-01 · **HEAD at review:** `245de9b` (CI all 6 jobs green on this exact SHA — Actions-API re-verified at review time, run 33443543159) · **Verdict: M4 EXIT — gate 16 (receipt-matching rules normative) and the milestone's assigned P2 substance (M5 supply-status producers, M6 matching, M7 CF governance, M8 restatement, M10 FX fail-safe) CLOSED; every §6.3 M4 unit delivered contract-first with named proofs; one process gap disclosed in-place (unit 1's per-unit decision record was never appended — D-039 carries its narrative); the wiring/composition follow-ons born in M3/M4 are named and scheduled, never silent. Nothing the §6.3 M4 gate line owed remains open.**

M4 closed the loop the audits said was open: receipts now reconcile against PO lines under normative rules (M6), the reconciliations feed scorecards and efficacy signals instead of hand-run probes, conversion-factor changes are staged, versioned and dual-controlled (M7), the sealed past restates explicitly and lands ledger blocks (M8), a failed FX pin no longer blinds the money layer (M10), and the supply axis renders from defined, derived, refused-by-name facts (M5). Seven units, each landed in the contract-first cadence the audit directive requires — the normative section as its own commit, then the implementation. Six per-unit decision records (D-033…D-038) plus this review's record (D-039); the unit-1 record gap is disclosed below, not papered over. Fifteen unit commits landed between `2e4e022` and `245de9b`; this tranche adds the review and the `0.5.0` release commit. The structural battery grew 794 → 1000 and the live tier 200 → 250, with the live tier earning its keep eleven times across the milestone — every catch invisible to the stub tier.

## Gate-by-gate evidence

### Gate 16 — receipt→PO-line matching rules normative (M6) — **CLOSED**

The audit's finding: "Receipt→PO-line matching rules are unspecified — the hardest reconciliation problem is delegated to nobody," with `reconcileProposal` receiving "receipts as given" and the warning that "until then DoD 5b ('the loop closes') is not verifiable." Named acceptance test `feedback/matching.spec` covering split, amended, cancelled, and returned lines.

- **The rules are normative** (§14.6b, contract commit `2e4e022` before any implementation): line identity = the ingestion keys + schema uniques (`poNumber`, `sku`); proposal→line linkage via the closed task's PO number(s); split GRNs = several receipt events; tolerance bands (±0.95–1.05 adherence, OVER_RECEIVED beyond ordered+5%, position clamps ≥ 0); CANCELLED leaves the loop entirely (outcome CANCELLED, lateByDays void, scorecard due-lines excluded per H2's only-due-lines rule, the in-transit guard RELEASES, RECEIPTS_AFTER_CANCEL flagged); amendments ride `ordered` with latest-amendedAt-wins and AMENDMENT_UNEXPLAINED per the deviation discipline; returns net into fill with GOODS_RETURNED; merge allocation is FIFO-by-raisedAt with ties by refId and the allocation DISCLOSED; unlinked receipts are UNSOLICITED, never dropped, never guessed onto a proposal.
- **The implementation is one canon** (`matchPoLines` in the execution-feedback module, commit `e2dd02b`): `reconcileProposal` is the per-line leaf; the per-proposal aggregates carry the exact §14.6 shape so scorecards (unit 3) and efficacy (unit 4) consume the matching RESULT — no forked derivation anywhere downstream. Honesty rules are structural: no price fact → variance null (never a fabricated zero-variance); waiting consistency pinned; determinism (sorted, deep-equal, JSON round-trip) pinned.
- **The gross/net correction is in the spec text itself**: the export's own arithmetic is GROSS (waiting = ordered − received; returns are credit facts outside the Open-POs export) while fill is NET — the data's semantics govern, the first draft was corrected in-tranche and the correction is recorded in the review of record (Task 53).
- **Proven in CI**: the named proof `feedback/matching` — 27 tests (23 at landing, +3 through unit 3's supplier attribution, +1 through unit 4's duplicate-flag pin) covering the audit's four named cases plus merge FIFO, ties, over-receipt, waiting, UNSOLICITED, no-price, weighted variance, §14.6 shape, PENDING/IGNORED delegation, in-transit release, the refusal family, and determinism. Gate 16's "not verifiable" clause is answered: DoD 5b now has its fixture-verifiable ruleset.

### The P2 set — item-by-item tally (build spec §15.2)

§6.3's M4 exit reads "Gates: 16 + P2 set." The P2 list is ten items; at this exit each is closed or explicitly M5-scoped:

| P2 item | Status | Where closed |
|---|---|---|
| M5 supply-status producers | **CLOSED** | M4 unit 2 (§14.6c, D-033) — the audit's "status axis must never render from under-specified data" |
| M6 receipt→PO matching | **CLOSED** | M4 unit 1 (§14.6b) — gate 16 itself |
| M7 CF governance + versioning | **CLOSED** | M4 unit 5 (§14.13b, D-036) — the audit's "ungoverned and unversioned" |
| M8 restatement vs sealed DayState | **CLOSED** | M4 unit 6 (§14.16, D-037) — the audit's [S] "undefined" |
| M9 freshness SLO + no-deliveries alarm | CLOSED (carried) | M2 exit (gate 17; DAT-01) |
| M10 FX stale-rate fail-safe | **CLOSED** | M4 unit 7 (§14.17 + ADR-0003, D-038) — the audit's [S] "unspecified" |
| M11 MFA/session policy | CLOSED (carried) | M3 exit (gate M11) |
| M12 CI security gates + SBOM | OPEN — M5 content | §6.3's M5 row names M12; gate 18 |
| M13 egress allow-list | OPEN — M5 content | §6.3's M5 row; gate 18-adjacent |
| M14 ladder-edge warnings | OPEN — M5 content | §6.3's M5 row; `warnings` array follow-on |

Every P2 item the M4 milestone owned is closed; the three that remain were scheduled to M5 by §6.3's own milestone map before M4 began — their openness is the plan, not a slip.

## The seven units — evidence table

| # | Unit | Audit finding | Spec | Contract → impl | Named proof (tests) | Record |
|---|---|---|---|---|---|---|
| 1 | M6 receipt→PO-line matching | M6 [S] "delegated to nobody" | §14.6b | `2e4e022` → `e2dd02b` (+CI `6e7550b`) | `feedback/matching` (27) | D-039 (gap disclosed) |
| 2 | M5 supply-status producers | M5 [S] "under-specified data" | §14.6c | `5a49be5` → `d496ad6` | `ingestion/supply-status-producers` (22) | D-033 |
| 3 | Scorecards fed by matching | H2 canon + §14.6 SRM "the loop's second turn" | §14.6d | `24979a7` → `5a7ab82` | `feedback/scorecard-matching-fed` (16) | D-034 |
| 4 | Efficacy signals fed by matching | M3 [R] "three observations" | §14.6e | `9e94004` → `2e8b436` | `feedback/efficacy-matching-fed` (18) | D-035 |
| 5 | M7 CF governance | M7 [S] "ungoverned and unversioned" | §14.13b | `95bd336` → `55626ee` | `governance/cf-change` (approval 35 → 55) | D-036 |
| 6 | M8 restatement semantics | M8 [S] "undefined" | §14.16 | `0f4c8ff` → `1ae5e73` | `ledger/restatement` (plan +8; 13 door stubs; 6 schema pins; 13 live; 8 matrix) | D-037 |
| 7 | M10 FX fail-safe | M10 [S] "unspecified" | §14.17 + ADR-0003 | `1392ce3` → `245de9b` | `ingestion/fx-fail-safe` (17) + `ops/fx-stale` (7) + door stubs (14) | D-038 |

All seven contract texts landed as their own commit BEFORE the implementation — the audit's directive ("the contract itself must be amended before implementation… silence is the one unacceptable outcome") held for every unit, and the two in-tranche spec corrections (unit 1's gross-vs-net; units 3/4's flag-axis paragraphs) were corrected in the spec text and recorded in the D-records, never edited silently.

## What the milestone built

- **The loop's reconciliation turn (units 1–2)**: receipts, returns, amendments, cancellations and merges reconcile under one matching canon; cancelled commitments leave every sum by construction — the double-order guard can no longer be held hostage by a cancelled line, and the supply facts (`openPO`, `overduePO`, `partialPO`, `supplierIssue`) derive from live lines against an explicit `asOf` with the refusal family closed (`ASOF_REQUIRED` … `LINE_DUPLICATE`). The SQL surface gained `0006_open_po_status`; the ingestion boundary normalizes the Purchase Order Status column (priority-1 ADD; unknown quarantines `PO_STATUS_UNKNOWN`).
- **The loop's learning turns (units 3–4)**: scorecards and efficacy signals compose the UNCHANGED M2/M3 engines over the matching result — attribution follows the delivery (the line's actual supplier), UNSOLICITED evidence reconciles honestly (variance null without a price fact), CANCELLED evidence is excluded and disclosed, the proposal (not the line) is the unit of judgment, and recall rides the inventory join (missedShortages is the dangerous class). The suite caught a real as-built defect here: the aggregate builder could duplicate a rec-raised flag, corrupting every downstream entry count — fixed at the source in `matching.js`, pinned transitively.
- **Governance and the guarded past (units 5–6)**: CF changes stage as PENDING versions, decide under the SoD spine (never the requester), derive explicit re-derivation tasks off the latest seal's sizing basis — a sealed row is judged on the factor it was sized under; the freeze trigger refuses ungoverned factor deltas structurally (`0007_cf_governance`). Restatement is an explicit, reasoned act landing a NEW VERSION chained beside the immutable seal (`0008_restatement`, the chain-guard trigger), with the deterministic as-known-then vs as-known-now delta — and restatement events ARE ledger blocks: the H5 chain's first production writer (one Class-W `RESTATE_DAY` per act, same transaction, §16.3 rule 2).
- **The money layer's fail-safe (unit 7)**: ADR-0003 names the pin table as the source of record (operator-maintained daily sheet inside the closed ecosystem — no runtime internet egress); the resolution order is the money layer's PURE decision (exact pin fresh; last pin ≤ day CONTINUES stale-visible with additive `stale` + `rateStale`; never-pinned refuses `RATE_NOT_PINNED` — the D-015 blanket refusal narrowed, the amendment explicit); staleness is alarmed not graded (`FX_STALE` / `FX_NEVER_PINNED`, owner DTA, DAT-06's 100% daily target makes it binary); the pin door is idempotent and correction-trailed with DELETE refused structurally (`0009_fx_fail_safe`); every pin and correction is a Class-S `FX_PIN` / `FX_CORRECT` block in the SAME transaction — verifyChain proven green live across pin + correction. D-015's owed ADR debt (carried since M1) is paid.

### The decision-record gap — disclosed

Unit 1 landed with its evidence in the spec commit, the implementation commit, the CI commit and the worklog, but **no per-unit DECISIONS row was appended** — a process miss against the cadence units 2–7 held (D-033…D-038). The ledger stays append-only: no retroactive renumbering, no inserted row. D-039 (this review's record) carries unit 1's decision narrative — the gross-vs-net spec correction, the stale-flag re-sync after the net-of-returns override, the cancelled-release defect class closed at contract level, and the token-probe lesson — and this section is the standing disclosure. The exit-review discipline gains a checklist line: every unit's D-record is verified present before the next unit opens.

## Verification summary

| Suite | Count | Where |
|---|---|---|
| planning engine (golden) | 86 | golden-tests job |
| supply-status producers (unit 2 proof) | 22 | golden-tests job |
| execution feedback | 31 | golden-tests job |
| M6 matching (unit 1 proof) | 27 | golden-tests job |
| scorecards fed by matching (unit 3) | 16 | golden-tests job |
| efficacy fed by matching (unit 4) | 18 | golden-tests job |
| KPI catalog | 24 | golden-tests job |
| H4 dates + H9 calendar | 25 + 29 | golden-tests job |
| plan service (+ M8 restatement, unit 6) | 57 | golden-tests job |
| ops freshness + M10 fx-stale (unit 7) | 19 + 7 | golden-tests job |
| approval (+ M7 CF governance, unit 5) | 55 | golden-tests job |
| ledger + auth modules | 50 + 27 | golden-tests job |
| ingestion boundary suites (+ PO status, + FX) | 32, 16, 40, 17, 26, 46, 29 | ingestion job |
| worker + adapters (+ restatement door 13, fx door 14) | 37, 26, 27, 11, 28 | ingestion + db-rls jobs |
| DB schema structural | 51 | db-rls job |
| **Total (structural)** | **1000** | battery green in CI (run 33443543159) |

Live in CI (job `db-rls`, postgres:16): RLS deny-matrix **56** + plan-seal **27** + ingest-replay **40** + SoD **66** + ledger **33** + auth **28** = **250 live checks**. The live tier earned its keep eleven times across the milestone: the int8 lesson firing in the read direction (unit 2), the DEVIATION_UNEXPLAINED duplicate flag (unit 4), the missing sentinel_app GRANT, the severity enum cast and the 17→20 bind misalignment (unit 5), the undefined-KPI-key delta, the LEDGER_ROLE_REQUIRED envelope and the BEFORE-trigger/WITH-CHECK RLS ordering (unit 6), the numeric-string rate, the uuid-typed actor, the `$2`-without-`$1` placeholder and the stub matcher shape (unit 7) — plus unit 1's four stub-tier catches. Migrations `0006` → `0009` (SCHEMA_VERSION 0005 → 0009); package versions at exit: root `0.4.0 → 0.5.0` (this tranche), execution-feedback 1.0.0 → 1.3.0, ingestion 0.3.0 → 0.4.0, ops 0.3.0 → 0.4.0, plan-service 0.3.0 → 0.4.0, db 0.5.0 → 0.8.0; planning-engine unchanged at 1.0.0. Guards clean at this HEAD (forbidden terms, SDS parity 51, UI scope, status-vocabulary binding); golden fixtures 4/4 checksum-verified; apps/web typecheck + next build and packages/ui typecheck ran verbatim locally before each code-tranche push (the Task-51 closure).

## Residuals and scheduled obligations

| Obligation | Lands in | Source |
|---|---|---|
| `XLSX_EXTRACTION_NOT_WIRED` — a real workbook reader behind the H10 gate | **M5** (re-scheduled from M4 — pairs with the pipeline-hardening tranche; tenants remain on CSV behind the gate) | M3-EXIT-REVIEW residual table; D-028 disclosure |
| Freeze-ingestion auto-staging into `supplier_change_hold` (COOLING_OFF) | **M5** (re-scheduled from M4 — rides the worker's staging tranche) | M3-EXIT-REVIEW residual table; D-029 disclosure |
| SRC-05 single-source tile (A15.2/D-013) | **M5** (re-scheduled from M4 — composition on the scorecard surface, pairs with the approvals-tray UI unit) | M3-EXIT-REVIEW residual table |
| Stale-banner dismissal (client state) + freshness-tone promotion into `packages/ui` | with the client-shell unit (carried) | D-025, carried from M2 |
| UNPROMISED_WAITING_DATA_HEALTH_RULE — the sweep lifting disclosed unpromised counts into `data_health_task` | **M5** (born in M4) | D-033 |
| The H2 second arm (past-promise due-ness) with the `SCORECARD_REBUILT` rebuild | **M5** (born in M4) | D-034 |
| CF decide/apply API + approvals-tray wiring | **M5** (born in M4 — the door and gate are adapter/module surfaces; the tray is UI work) | D-036 |
| Screen-12 time-machine composition (versions marked, side-by-side diff) | **M5** (born in M4 — the data path is contract; the UI rides this unit) | D-037 |
| OIDC IdP wiring + login UI screen (`OIDC_IDP_NOT_WIRED`, `FIDO2_NOT_WIRED`) | M5 (carried) | D-031 |
| Precoro R4 `Supplier ID` column in the real export | Cutover project (external dependency) | A8, carried from M1 |
| H11 restore rehearsal as a go-live gate | M5 | gate 14, carried |

Five M3-scheduled residuals were not delivered inside M4 — they are re-scheduled above, each with its reason and its landing point, because silence is the one unacceptable outcome. What M4 owed by its own gate line is closed.

M5 begins the Hardening & release milestone (`0.6.0` → `1.0.0-rc.N`): DR — WAL archiving, restore rehearsal passed and logged (H11, gate 14); CI security gates + SBOM (M12, gate 18); egress allow-list (M13); ladder-edge warnings (M14); perf/load at the §2 profile; pen-test fixes; docs complete — with the loop's wiring follow-ons riding the same tranche. Then the calendar gates: cutover data-readiness W1–W13 (gate 19) and the ≥ 4-week parallel run with divergences explained (gate 20) → `1.0.0` ships.
