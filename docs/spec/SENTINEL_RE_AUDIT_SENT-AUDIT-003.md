# SENTINEL — Re-Audit After Remediation (SENT-AUDIT-003)

## Independent Verification of the Absorbed SENT-AUDIT-002 Corrections

| | |
|---|---|
| **Audit ID** | SENT-AUDIT-003 (post-remediation verification; follows SENT-AUDIT-002) |
| **Date** | 2026-08-29 |
| **Auditor role** | Supply-chain software security, logic & robustness testing |
| **Object under audit** | `files.zip` — updated `SENTINEL_V3_BUILD_SPEC.md` (658 lines, +70 vs. v1), `engine.js` (349 lines, +93), `feedback.js` (235 lines, +25), `engine.test.js` (80 tests), `feedback.test.js` (31 tests), nested `Sentinel_Handoff.zip` (now includes SENT-AUDIT-002 itself) |
| **Method** | Every §15.1 claimed fix re-proved positively on **new** inputs (not merely absence of the old bug); all SENT-AUDIT-002 probes re-executed against v2 code; v1 golden suites re-run against v2 modules as a regression net; closed-ecosystem greps re-run; spec text scanned for normative amendment coverage |
| **Evidence codes** | **[E]** executed by probe or test run in this audit · **[R]** read and traced · **[S]** spec/contract text |
| **Consumers** | The implementing developer AI (primary); SC Director / Origin (secondary) |

---

## 1. Executive verdict

**SUBSTANTIALLY VERIFIED — the code remediation is real, honest, and regression-free. The contract work remains open, exactly as the package itself declares.**

Of the nine findings the package claims fixed in code (§15.1), **all nine are genuinely fixed and verified by fresh probes** [E]. The test suites were independently executed: **111/111 passing (80 engine + 31 feedback), matching the spec's own claim** [E]. The v1 golden suites were re-run against the v2 modules: **engine 64/64 unchanged**; feedback 22/24, where the **only 2 failures are the two v1 tests that encoded the M3 defect** (signals firing from 3 observations) — their obsolescence is the intended outcome, not a regression [E]. The closed-ecosystem posture is re-verified clean: **zero network calls, zero credential literals, zero dynamic code execution, zero write-back** in both modules [E].

Three residual defects were found **inside the fixed code** — one of them (C2 containment) material enough to keep a CRITICAL-adjacent exposure alive — plus the previously identified contract backlog, which the package honestly lists as *remaining* (§15.2) rather than pretending closure. **Readiness against the $50M bar is re-scored at 75/100 (was 61), with the path to ~90 unchanged and fully enumerated.**

The one-line summary for the developer AI: **your code fixes passed independent verification; the remaining work is the contract, the four residuals in §4 of this report, and the delivery discipline in the companion V1 Delivery Specification.**

---

## 2. What was verified — the nine fixes, re-proved positively [E]

Each fix was confirmed on inputs constructed to pass *only if the fix is real*, not by re-running the old failing probes alone.

| ID | Claimed fix | Positive verification performed | Verdict |
|---|---|---|---|
| **C1** | `toPlanningUnits()` / `convertPoLines()` convert PO quantities and **refuse** when the factor is absent | 30 CTN × CF 100 → 3,000 units; factor `undefined / null / 0 / −5 / 'abc'` all refused with `value: null` (no guessing); `convertPoLines` splits converted vs. unconverted lines for data-health | **VERIFIED** |
| **C2** | KPIs take `tenantCurrency`; foreign rows set `currencyMixed` / `valuesTrustworthy:false` | Mixed BHD/AED rows with `tenantCurrency: 'BHD'` → `currencyMixed=true`, `valuesTrustworthy=false`, `mixedCurrencies=['AED']` | **VERIFIED (detection)** — containment gap found, see §4 R1 |
| **M1** | KPI counts bind to `displayStatus`; `active` counts only `dataState==='OK'`; `unplanned`/`unplannedShare` exposed | NO_PARAMS ref now counted as *Not Planned* (not *Over Stock*); `unplanned=1`, `unplannedShare=1`; no day-one Over-Stock flood | **VERIFIED** — one residual, see §4 R2 |
| **H1** | Preferred-SKU weighting normalized by conversion factor | With CFs present: 30 CTN (3,000 pcs) × 9 orders now beats 500 PCS × 1 order; `unitNormalized=true` | **VERIFIED** — one residual, see §4 R3 |
| **H2** | Scorecard denominators = due lines only | Perfect supplier + one not-yet-due PO → `fillRate=1.0`, `dueLines=1`, `openLines=1` (was 0.5) | **VERIFIED** |
| **H3** | Quantity-weighted actual price; `MIXED_RECEIPT_PRICES` flag | Partials at 2.0/3.0 → variance 0.5 (was 1.0) with flag set | **VERIFIED** |
| **M2** | `PENDING` outcome inside decision SLA; `actedRate` excludes in-window proposals | 2-day-old proposal → `PENDING` / `PENDING_DECISION`; past-SLA → `IGNORED`; `proposalQuality.pending` counted, `actedRate=null` while any pending | **VERIFIED** |
| **M3** | Efficacy signals require `MIN_SAMPLE=12` + confidence grade | n=11 with 55% stockouts → zero signals, `confidence:'insufficient'`; n=12 → signals fire | **VERIFIED** |
| **M4** | `unitValue` falls back to item-master price when on-hand = 0 | onHand=0 + `masterPrice=2.5` → `unitValue=2.5`, `unitValueFallback=true`, target/max value non-zero | **VERIFIED** |

**Test-count and reproducibility claims:** 111/111 executed and matching the spec text (§15 preamble) [E]. `conversionFactor` now appears 6× in `engine.js` (was 0×) [E]. The nested handoff zip now ships SENT-AUDIT-002 itself, and the spec's §15 traceability table maps every fix to its finding ID [R].

**Golden regression (V1–V12 binding properties):** the full v1 engine suite passes 64/64 on v2 code — formula fidelity, two-rate discipline, honest degradation, seasonality no-op, double-order guard, parameter provenance, and the shelf-life guard did not regress [E]. The two v1 feedback failures are the M3-defect-encoding tests ("stockouts after following advice → raise safety days", "overstock with no stockouts → lower safety and order frequency"), which used 3-observation fixtures; they are obsolete by design and should be **deleted from the v1 suite canon** to stop the test-count drift SENT-AUDIT-002 flagged (46/60/64 → now 64/80, 22/31) [E].

**Closed-ecosystem re-verification [E]:**
```
rg "fetch|axios|http|net\.|tls|WebSocket"          → exit 1 (clean)
rg -i "password|secret|token|apikey|credential"    → exit 1 (clean)
rg "eval\(|new Function|child_process|exec\(|spawn" → exit 1 (clean)
```

---

## 3. Probe ledger (this audit)

| Probe | Construction | Result |
|---|---|---|
| R3-01…03 | C1 positive: conversion, refusal ×5 factor shapes, line splitting | **C1 VERIFIED** ×3 |
| R3-04 | C2 detection: mixed rows + `tenantCurrency` → flag trio | **VERIFIED** |
| R3-05 | **C2 containment gap**: mixed rows + flag armed — does the sum exclude the foreign row? | **GAP CONFIRMED** — `actualInvValue=20000` still includes the AED row |
| R3-06 | **C2 arming gap**: same rows, no `opts` passed | **GAP CONFIRMED** — `currencyMixed=false`, silent sum |
| R3-07 | M1 counts on NO_PARAMS ref | **VERIFIED** |
| R3-08 | **M1 residual**: portfolio where `active=0` | **GAP CONFIRMED** — `serviceLevel=1` vacuous fallback |
| R3-09 | H1 with CFs: physical-volume ranking | **VERIFIED** |
| R3-10 | **H1 residual**: same members, CFs absent | **GAP CONFIRMED** — raw-denomination ranking, warning only |
| R3-11 | H2 due-lines-only scorecard | **VERIFIED** |
| R3-12 | H3 weighted variance + mixed flag | **VERIFIED** |
| R3-13 | M2 PENDING / IGNORED / actedRate triple | **VERIFIED** |
| R3-14 | M3 sample floor at n=11 vs n=12 | **VERIFIED** |
| R3-15 | M4 masterPrice fallback | **VERIFIED** |
| L-series re-run (13 probes from SENT-AUDIT-002) | Old defect constructions against v2 | 8 no longer reproduce (L1, L4, L6, L7, L10 + informational); **L8, L11, L12 still reproduce** — consistent with the package's own "remaining" list; L2/L9 remain, documented M14/LOW |

Probe scripts preserved at `/home/z/my-project/scripts/audit_probes_v2.js`, `audit_probes_round2_v2.js`, `audit_probes_round3_v2.js` for re-execution after the next remediation round.

---

## 4. New findings — residuals inside the fixed code

Severity under the $50M bar as defined in SENT-AUDIT-002 (CRITICAL = wrong money/quantity movement at scale; HIGH = systematically corrupts a money or learning signal; MEDIUM = degraded fidelity that must be pinned before first use; LOW = hygiene).

### R1 · C2 containment is fail-open — the flag exists, the corrupted number is still returned. **HIGH** [E]

`portfolioKPIs` detects foreign-currency rows but still **sums them into `actualInvValue`** (probe R3-05: flag set, `actualInvValue=20000`). Worse, the tripwire only arms if the caller remembers to pass `opts.tenantCurrency` (probe R3-06: without it, `currencyMixed=false` and the sum is silent). The spec's fix note says normalization happens at ingestion — correct — but defense-in-depth that fails open is a laminated sign on an unlocked door. A UI that ignores a boolean flag renders a corrupted DIO on day one of a $50M portfolio.

**Required fix (fail-closed):** (a) make `tenantCurrency` a **mandatory** argument — move it out of `opts` and throw on absence; (b) when any row carries a currency other than the tenant currency, set `actualInvValue/targetInvValueBottomUp/maxInvValue/actualDIO = null` and expose `kpiWithheld: true` instead of the poisoned sum. A withheld KPI with a reason is an operational event; a wrong KPI is a wrong steering decision.
**Acceptance tests:** `kpi/tenant-currency-mandatory.spec` (call without currency throws), `kpi/mixed-currency-withholds-value.spec` (mixed rows → null + `kpiWithheld`, never a number), `kpi/normalized-rows-sum.spec` (post-normalization rows sum normally).

### R2 · `serviceLevel` still reads 100% when nothing is plannable. **MEDIUM** [E]

The M1 fix changed the denominator to `active` but kept the vacuous fallback `active > 0 ? … : 1` — a portfolio that is 100% unplanned reports a perfect service level (probe R3-08: `active=0, serviceLevel=1`). This is the same day-one KPI lie M1 was written to kill, surviving through a different door. `unplannedShare` is now exposed, which mitigates but does not close it: dashboards render the number they are given.

**Required fix:** `active === 0 → serviceLevel = null` and the UI renders "insufficient plannable data — N refs not yet planned" instead of a percentage.
**Acceptance test:** `kpi/service-level-null-when-unplannable.spec`.

### R3 · H1 without conversion factors re-creates the unit bias, warn-only. **MEDIUM** [E]

When any candidate SKU lacks a usable factor, `resolveOrderingSku` falls back to ranking **raw purchase denominations** (probe R3-10: 500 PCS beats 30 CTN ≈ 3,000 pcs on raw numbers, `unitNormalized:false` + warning). C1's philosophy is *refuse rather than guess*; H1's is *warn and proceed*. The same class of error should not have two different failure philosophies — and the winner steers real POs.

**Required fix:** when any active member lacks a usable factor, do **not** rank on mixed denominations — degrade to the recency rule (`source:'recent'`) or return `unresolved`, and raise a data-health task to backfill the missing factor.
**Acceptance test:** `sku/missing-cf-degrades-to-recency.spec`.

### R4 · Shelf-life cap still rounds up. **LOW** [E]

Cap 31 vs. true 30.6-day cover (round-2 probe re-run). Known LOW (L-02); fix with `Math.floor` on the cap only, one test. Carry into M5.

### R5 · Confirmation of the already-triaged items. **INFO** [E]

Still present and correctly documented as open contract work, not silent: L2 dead ladder branch (M14), L8 mixed date parsing (H4, P1), L11 `nz('1,200')===0` (C4, P0 — engine `nz` unchanged by design pending ingestion strict parsing). No action beyond the existing backlog; listed so the record shows re-audit visibility, not oversight.

---

## 5. Contract-state assessment

The package's own §15.2 divides the remaining work into P0 (C3 financial controls, C4 strict numerics, H5 ledger posture, H6 tenant idempotency, H7 supplier identity, H8 rate-window alignment), P1 (H4, H9, H10, H11, H12) and P2 (M5–M14). **This division is correct, complete against SENT-AUDIT-002, and honestly labeled** [R]. What §15.2 is *not* — yet — is normative spec text: the items live as a remediation TODO list, not as amended §10/§14.x clauses with acceptance tests wired into §13. Until they are transcribed into the contract proper, an implementer obeying the spec over all other documents is still building the gaps. The companion **SENTINEL V1 Delivery Specification** makes that transcription M0's exit criterion, so this audit will not repeat the "absorbed ≠ amended" warning a third time.

Two H12 items remain materially open [E]: no golden fixtures (redacted DDS/Precoro extracts) ship in the package, and no checksums manifest exists; the test-count claim (111) is now correct and CI-verifiable, which is one of three sub-items closed.

---

## 6. Re-scored $50M readiness gate

| # | Gate | v1 status | v3 status | Ref |
|---|---|---|---|---|
| 1 | Engine formulas verified, tests green | PASS | **PASS** | V1, V2 |
| 2 | Golden verification reproducible from package | OPEN | **OPEN** (fixtures + checksums still absent) | H12 |
| 3 | Unit conversion implemented and tested | OPEN | **PASS** (code; ingestion must call it — contract note) | C1 |
| 4 | Currency normalization before engine/KPIs | OPEN | **PARTIAL** — detection in; containment fail-open (R1) | C2 |
| 5 | SoD + dual control + thresholds in spec and code | OPEN | **OPEN** (contract) | C3 |
| 6 | Strict numerics + plausibility bounds | OPEN | **OPEN** (contract) | C4 |
| 7 | Preferred-SKU weighting unit-safe | OPEN | **PASS with residual** (R3 missing-CF fallback) | H1 |
| 8 | Scorecards due-line-correct | OPEN | **PASS** | H2 |
| 9 | Weighted-price variance and savings | OPEN | **PASS** | H3 |
| 10 | Canonical dates; day-basis calendar | OPEN | **OPEN** | H4, H9 |
| 11 | Ledger keyed + canonicalization + Origin carve-out | OPEN | **OPEN** (contract) | H5 |
| 12 | Tenant-scoped idempotency + supplier identity | OPEN | **OPEN** (contract) | H6, H7 |
| 13 | Ingestion hardening + email-in controls | OPEN | **OPEN** (contract) | H10 |
| 14 | DR: RPO/RTO + restore rehearsal | OPEN | **OPEN** (contract) | H11 |
| 15 | KPI layer dataState-aware | OPEN | **PARTIAL** (counts fixed; serviceLevel residual R2) | M1 |
| 16 | Receipt-matching rules normative | OPEN | **OPEN** | M6 |
| 17 | Freshness SLO + no-deliveries alarm | OPEN | **OPEN** | M9 |
| 18 | CI security gates + SBOM | OPEN | **OPEN** | M12 |
| 19 | Cutover data-readiness gates W1–W13 | OPEN | **OPEN** (external) | Cutover §4 |
| 20 | Parallel run ≥ 4 weeks, divergences explained | OPEN | **OPEN** (external) | Cutover §4 |

**Tally: 5 PASS · 3 PARTIAL · 12 OPEN** (v1 baseline: 1 PASS · 0 PARTIAL · 19 OPEN).

## 7. Re-scored readiness

| Dimension | SENT-AUDIT-002 | Now | Rationale |
|---|---|---|---|
| Engine correctness & fidelity | 88 | **93** | C1/M1/H1/M4 verified in code; residuals R2/R3 minor and named |
| Data integrity & governance | 66 | **72** | Conversion + provenance strengthened; idempotency, supplier identity, window alignment still contract-open |
| Security & fraud resistance | 58 | **60** | No new code surface; C3/H5 remain the dominant gap — unchanged by this round |
| Learning-loop trustworthiness | 64 | **80** | H2/H3/M2/M3 verified fixed; H4 + M6 remain |
| Robustness & operability | 62 | **67** | C1 refusal semantics + C2 detection; strict numerics and DR still open |
| Closed-ecosystem assurance | 74 | **76** | Greps re-verified clean [E]; runtime boundary controls (H10/M13) pending |
| **Composite** | **61** | **75** | With the P0/P1 contract work + residuals R1–R3 closed and gates 19–20 evidenced, the modelled composite remains **~90+** |

## 8. Directive to the developer AI (ordered, with the residuals first)

1. **Fix R1–R3 now** — all three are small diffs in already-touched functions, each with its acceptance test named in §4. R1 is the only one that can misstate money; do it before any UI consumes `portfolioKPIs`.
2. **Transcribe §15.2 into the contract** — every P0/P1/P2 item becomes a normative §10/§14.x clause with its acceptance test named in §13, and each business decision lands in `DECISIONS.md`. M0 exit criterion in the V1 Delivery Specification.
3. **Retire the two obsolete v1 feedback tests** from the canon and ship the golden fixtures + checksums manifest (H12), so gate 2 can close.
4. **Adopt the V1 Delivery Specification** (companion document) as the build plan of record: stack, repo, TDD obligations, SemVer + Conventional Commits, milestone gates M0–M5, CI/CD with the five security gates, and the 20-gate Definition of Done for `1.0.0`.
5. **Re-run this audit's probe battery** (`audit_probes*_v2.js`) as a regression suite after every remediation — they are written to be lifted into the repo as `core/**/__audit__/` tests verbatim.

Where this report and the build spec disagree, the business decides explicitly and records it in `DECISIONS.md`. Silence remains the one unacceptable outcome.
