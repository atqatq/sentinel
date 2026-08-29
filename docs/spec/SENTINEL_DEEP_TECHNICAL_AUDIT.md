# SENTINEL — Deep Technical Audit
## Pre-Deployment Gate Review for a USD 50M Procurement Load

| | |
|---|---|
| **Audit ID** | SENT-AUDIT-002 (deep technical; supersedes the scope of SENTINEL_AUDIT.md) |
| **Date** | 2026-08-29 |
| **Auditor role** | Supply-chain software security, logic & robustness testing |
| **Object under audit** | `Sentinel_Handoff.zip` — 9 specification documents, `engine.js`, `feedback.js`, `engine.test.js` (64 tests), `feedback.test.js` (24 tests), `Sentinel_Ingestion_Template.xlsx` (8 tabs), `Sentinel_System_Graph.html` |
| **Standard applied** | The platform must be safe to carry **USD 50M of annual procurement**: no wrong-quantity or wrong-money movement, no silent data corruption, fraud-resistant approval and learning loops, verifiable audit trail, defensible closed-ecosystem boundary |
| **Consumers of this report** | The implementing developer AI (primary); SC Director / Origin (secondary) |

---

## 1. Executive verdict

**CONDITIONAL — NOT YET READY to carry $50M, with a credible and specific path to ready.**

The two shipped code modules are of genuinely high quality for what they claim to be: the planning engine's formulas were traced line-by-line, both test suites were independently executed (**88/88 passing — 64 engine + 24 feedback — claims verified**), and the empirical probes I ran against the code confirm that the system degrades visibly rather than fabricating plans from absent data. The closed-ecosystem claim holds at the code level: **zero network calls, zero credential literals, zero dynamic code execution, zero write-back paths** exist in the shipped modules. That is rare and worth saying plainly.

However, an audit for a $50M procurement load must apply a different lens than an audit for "does the engine match the workbook." Under that lens this engagement found **40 findings: 4 CRITICAL, 12 HIGH, 14 MEDIUM, 10 LOW**, of which **12 were confirmed by executing probes against the shipped code** rather than by reading. The risk is no longer concentrated where the prior audit located it ("the risk is not in the code, it is in the inputs"). It now sits in three places:

1. **The unit-and-currency seam.** The single most dangerous transformation in the system — converting PO quantities from purchase units to planning units (× conversion factor) — exists only as a warning in a table (SENTINEL_AUDIT.md §C) and in zero lines of shipped code and zero tests. The engine and portfolio KPIs are also **currency-blind**: the data profile itself documents four item currencies (BHD 3,909 · AED 47 · SAR 30 · USD 7), yet `portfolioKPIs` sums `invValue` with no currency dimension. A verified probe sums BHD and AED as if they were one currency. At $50M this is not an edge case; it is the money layer.
2. **The contract, not the code, is missing the financial-control layer.** Segregation of duties (a buyer approving their own proposal), dual control above value thresholds, and approval limits appear nowhere in the 588-line build spec. The hash-chained ledger is tamper-*evident* but not tamper-*resistant* (no keyed hash, canonicalization undefined, and Origin's "override any rule" supremacy is not carved out for the ledger it is supposed to witness). Disaster recovery — RPO/RTO, backup testing — is entirely absent from the contract.
3. **The handoff package cannot reproduce its own verification claims.** The Riyadh DDS workbooks, the real Precoro export fixtures, and `Category_Buyers.xlsx` referenced as golden sources and fixtures are **not in the zip**. Test-count claims drift across documents (46 vs 60 vs 64). A developer AI receiving this package cannot re-verify "byte-identical to Riyadh DDS" — it can only inherit the claim. For a system that will move $50M, verification must be reproducible, not inherited.

The prior audit's 82/100 score is fair for its stated scope (logic, functionality, data coherence, mapping). Rescored against the $50M bar in §9 of this report, the platform's readiness is **61/100 today**, rising to **~90** if the P0/P1 backlog in §8 is closed and the cutover data-readiness gates hold. The delta is dominated by findings that are cheap to fix *now* and catastrophic to discover *after* go-live.

**What the developer AI must internalize:** the engine is not the problem — do not "improve" its verified formulas (§3 lists what must not regress). The work is at the seams: ingestion normalization, the money layer, the approval control layer, the ledger's cryptographic posture, and converting the spec's prose assurances into named, testable requirements.

---

## 2. Method and evidence base

Every finding in this report carries one of three evidence grades, and the report separates them deliberately so the developer AI can calibrate trust.

- **[E] Empirically confirmed** — reproduced by executing a probe against `engine.js`/`feedback.js` in this audit. The consolidated probe suite (14 probes, two rounds) is included as Appendix A. These are facts, not opinions.
- **[R] Code-read** — established by line-level reading of the shipped modules; deterministic consequences of visible code.
- **[S] Specification analysis** — a gap, contradiction, or untestable assurance in the contract documents themselves. These cannot be "run"; they become real the moment an implementer follows the spec literally, which is exactly how a developer AI will behave.

Independent verification performed for this audit: both test suites executed from a clean extraction (64 + 24 passing, matching the current files, *not* matching some older count claims); a two-round empirical probe suite, consolidated to 14 probes in Appendix A of which 12 confirmed; grep-level scans of shipped code for network egress, secrets, dynamic execution, and write-back verbs (all clean; one intentional `new Date()` nondeterminism noted at feedback.js:44); cross-document consistency checks on test counts, fixture lists, status vocabularies, and idempotency keys; and inspection of the 8-tab ingestion template (tab structure conforms to INGESTION_FILE_SPEC.md §3.3).

---

## 3. Verified and credited — what must NOT regress

The developer AI will receive remediation instructions from this report. Equally binding are the properties below, which were **independently verified and must be preserved**. Any refactor that silently breaks one of these is a regression against this audit.

| # | Verified property | Evidence |
|---|---|---|
| V1 | **88/88 tests pass** as shipped (64 engine, 24 feedback) | Executed in this audit |
| V2 | **Formula fidelity to the Riyadh DDS** (`J=L/22`, `R=N×J`, `S=(M+N)×J`, `T=max(P,O×J)`, `U=T+R`, `V=R+T/2`, order qty Z) — engine.js:37–124 implements exactly the §6 formula block of the build spec | [R] line-trace |
| V3 | **Two-rate discipline**: run-out uses the historical rate only (engine.js:58–59, 69); safety/reorder/EOQ use the magnified rate only. Never crossed | [R] + tests |
| V4 | **Honest degradation**: no usage → `NO_USAGE`; no params → `NO_PARAMS`; no lead → `NO_LEAD_TIME`. The engine never fabricates a plan from absent data — confirmed by execution | [E] probes L1/L1b harness |
| V5 | **Seasonality overlay is a safe no-op** when unconfigured (`factors default 1.0`; zero/invalid factors ignored rather than zeroing demand) — engine.js:233–237 | [R] + tests |
| V6 | **Double-order guard is arithmetically sound**, including the over-receipt clamp that can never produce a negative open position — feedback.js:193–205 | [R] + tests |
| V7 | **Parameter provenance** (override ▸ calculated ▸ manual) resolves correctly and the optimizer can only write `calculated` — engine.js:157–170 | [R] + tests |
| V8 | **Shelf-life guard** caps order quantity and flags `moqExceedsShelfLife` instead of silently over-ordering — engine.js:83–92 | [R] + tests |
| V9 | **Closed ecosystem at code level**: no network calls, no credential literals, no eval/child_process, no write-back verbs in shipped modules | [E] grep sweep |
| V10 | **Ingestion security design intent is correct**: column allow-list, banking-field discard asserted by test, ±40% row-count gate, deliveries ±50% variance guard, quarantine-whole-file (never half-apply) | [S] INGESTION_FILE_SPEC.md §2, §4 |
| V11 | **Origin model honesty**: the spec itself states the boundary of concealment ("holds against in-app users, not against direct database/infrastructure access") — V3 spec §10.1 | [S] |
| V12 | **Valuation-on-on-hand vs planning-on-available** distinction is correctly implemented and documented — engine.js:43–47, 72 | [R] |

---

## 4. Findings

Severity definitions under the $50M bar: **CRITICAL** = can directly cause wrong-quantity or wrong-money movement at scale, or destroy fraud-resistance/auditability, or present operators a false portfolio picture on day one. **HIGH** = systematically corrupts a learning, scorecard, or money signal, or leaves a surface the $50M bar cannot accept. **MEDIUM** = degraded fidelity or unspecified behaviour that must be pinned before the milestone that first needs it. **LOW** = hygiene.

### 4.1 CRITICAL

---

**C1 · The openPO × conversion-factor conversion does not exist — the known #1 unit trap is a comment, not code. [S, corroborated by R]**

SENTINEL_AUDIT.md §C states it precisely: `openPO` sourced from Precoro's `Waiting (Quantity)` "**must be × conversion factor before use — POs are in purchase units, planning is in converted units. A missed conversion here is an order-of-magnitude error**." The grep-verified fact is that `conversionFactor` appears once in `engine.js` (in a comment describing the Consumption sheet) and **zero times in `feedback.js`**; no shipped code performs the conversion, and no test in either suite exercises it. The `inTransitPosition` guard (feedback.js:193) compares PO quantities to receipts in whatever unit the caller passes; `computeRef` consumes `ref.openPO` raw (engine.js:48).

*Why this is critical at $50M:* purchase units are precisely where the 50-spelling unit chaos lives (CTN vs PCS is a 500× error by the risk assessment's own measurement). If the ingestion layer is implemented naively — which a developer AI following the current spec literally *will* do, because no normative conversion step exists in INGESTION_FILE_SPEC.md §4's pipeline either — then every "covered by open PO" reading can be wrong by orders of magnitude in both directions: suppressed proposals (stockouts believed covered) or duplicate orders (guard fails to suppress). This error is *silent*: both quantities are plausible-looking numbers.

*Required fix:* make the conversion a named pipeline stage with its own golden fixtures — PO line in purchase units × CF → planning units — asserted by a test whose fixture contains a CTN-based PO line and a PCS-based planning ref. Add the same conversion to `inTransitPosition` inputs and to `supplyStatus`'s `overduePO`/`partialPO` producers. Acceptance test: `ingestion/po-unit-conversion.spec` — a PO for 10 CTN with CF 100 must raise ref-level `openPO` by exactly 1,000 planning units, and the double-order guard must suppress a proposal at the ref until receipts reach 1,000.

---

**C2 · The money layer is currency-blind. [E-confirmed, R]**

The data profile (V3 spec §2) documents mixed item currencies: BHD 3,909 · AED 47 · SAR 30 · USD 7 items, and inventory valuation carried as `Gross Total, Document Currency` per line. The engine takes `invValue` as a bare number (engine.js:49), `unitValue` derives from it (engine.js:72), and `portfolioKPIs` aggregates `actualInvValue += c.invValue` across refs with no currency dimension (engine.js:183). A probe confirmed: 10,000 (BHD) + 10,000 (AED) aggregates to `actualInvValue = 20,000` — the true figure is ≈ 11,023 BHD. The build spec's currency machinery (Local↔USD toggle, 24h-pinned FX per tenant-day, §1.1 decision 7) addresses *display* conversion; **no document specifies at which layer values are normalized into tenant reporting currency before the engine or KPIs see them**, and no test covers it.

*Why this is critical:* every KPI that management will steer the business by — actual DIO, target inventory value, max inventory value, savings roll-ups — inherits the error. With AED/SAR/USD lines present today and imports growing at $50M scale, the distortion is not hypothetical; it is already in the data shape. A wrong DIO target silently re-prices every reorder decision upward or downward.

*Required fix:* normalize to tenant currency at ingestion (store per-line `documentCurrency` AND `tenantValue` computed at the pinned day rate); the engine consumes one currency only; re-derive `tenantValue` on FX re-pin, not on read. Add a mixed-currency fixture to `portfolioKPIs` tests with a tolerance-based assertion. Acceptance test: `core/currency-normalization.spec` — refs valued 1,000 BHD + 3,800 AED + 500 USD with pinned rates produce an `actualInvValue` within 0.001 BHD of the hand-computed sum.

---

**C3 · The contract contains no financial-control layer: segregation of duties, dual control, and value thresholds are absent. [S]**

The permission matrix (V3 spec §10) grants "Approve proposals / POs" to Origin, Director, Manager, Sr Buyer; proposals flow `OPEN → APPROVED → CONVERTED` (§4 screen 7) with no rule anywhere that **the approving principal must differ from the raising principal**, no **dual-approval threshold** above a value, and no **approval limit** by role (a Sr Buyer and the Director have identical approval power over a 40,000 BHD PO and a 4 BHD one). The §14.6 reconciliation chain correctly computes adherence from imported facts — but adherence is a *learning* control, not a *preventive* one. Supplier bank-detail substitution fraud (named as a live risk in CURRENT_STATE_RISK_ASSESSMENT.md §2.11) typically enters through exactly this seam: a legitimate-looking proposal, self-approved, converted to a PO.

*Why this is critical:* the platform's entire accountability thesis collapses if one compromised or colluding account can raise and approve its own spend. At $50M/year this is the single most likely fraud vector, and the spec — the document the developer AI treats as "the contract that wins" — is silent on it.

*Required fix (spec changes, then code):* add to §10 a **SoD invariant** (approver ≠ raiser, enforced at data layer, test per role pair), **value-tiered approval** (e.g., tier thresholds configurable by Origin, dual approval above tier 2, all tiers part of the seeded permission matrix), and **supplier bank-detail change freeze** (any supplier master change touching remittance data triggers a cooling-off state with out-of-band verification — even though Sentinel discards banking fields, supplier *identity* changes still reroute physical goods and invoices). Encode all three as tests in the §13 permissions obligations. Acceptance test: `permissions/sod.spec` — the raiser's approval is rejected at API *and* RLS layer; `approvals/dual-control.spec` — a proposal above tier-2 remains `OPEN` with one approval and becomes `APPROVED` only after a second, distinct, eligible approver.

---

**C4 · Corrupt numerics are silently coerced to zero, and quantity-bearing imports lack plausibility bounds. [E-confirmed for coercion; S for bounds]**

`nz()` (engine.js:12) is the engine's universal input sanitizer: `Number('1,200')` is `NaN`, so `nz('1,200') === 0` — **confirmed by execution**. The same coercion silently converts any misparsed quantity, lead time, MOQ, or price to a well-behaved zero. The system's lauded "fails visibly" property (SENTINEL_AUDIT.md §C) is true for *absent* data but false for *corrupt* data: a thousand-separator typo in a deliveries cell becomes zero demand (a missing `Delivery Period` blank becomes lead 0 → `NO_LEAD_TIME`, which is visible — but a corrupted `12,000` → `1200` passes every gate and *doubles* nothing, it just lies). The ±50% deliveries variance guard (INGESTION_FILE_SPEC.md §4) is the only plausibility bound in the entire contract, it applies to one dataset of eight, and its **confirmation workflow is unspecified** — who confirms, within what SLA, and whether the engine runs on the anomalous value or the trailing mean in the interim. Inventory, consumption, and PO imports have no bounds at all; a fat-fingered inventory quantity flows straight into `computeRef` and fires real order proposals.

*Why this is critical:* the workbook era's defining failure mode was "silent failure — an error persists until someone notices a physical consequence." `nz()` plus unbounded imports reproduces that failure mode inside the new platform, with the added authority of a "verified engine" behind it.

*Required fix:* (a) strict numeric parsing at the ingestion boundary — a cell that fails parse goes to the validation quarantine with the row, column and raw value in the import log; `nz()` semantics restricted to *genuinely optional* fields only; (b) extend plausibility bounds to every quantity-bearing kind: inventory vs trailing mean and vs valuation sanity, consumption vs trailing σ, PO quantities vs item history; out-of-bounds rows quarantine for confirmation; (c) specify the deliveries-guard confirmation semantics: on breach, the day's value is quarantined, the engine runs on the trailing 7-day mean, a data-health task fires to the named owner, and the UI banner names the substituted value. Acceptance tests: `ingestion/strict-numeric.spec` (corrupt cell quarantines whole file), `ingestion/plausibility-bounds.spec` (inventory 10× trailing mean quarantines), `pipeline/deliveries-confirmation.spec` (engine output during quarantined day equals trailing-mean output, and the UI banner is asserted).

---

### 4.2 HIGH

---

**H1 · Preferred-SKU selection is biased by purchase unit. [E-confirmed]**

`resolveOrderingSku` weights candidates by `purchasedQty × (1 + purchaseCount)` (engine.js:217) on raw purchase quantities. Confirmed probe: a SKU purchased 30 CTN over 9 orders (physically 3,000 pieces) *loses* to a SKU purchased 500 PCS in 1 order (physically 500 pieces) — the carton-denominated member's history is divided by the pack size before the comparison even starts. This reproduces, inside the new platform, the exact order-of-magnitude distortion the risk assessment flagged for units (§2.7), now steering *which SKU gets bought* for 734 multi-SKU refs. Required fix: normalize `purchasedQty` by conversion factor to planning units before weighting (fall back to raw only when CF is unavailable — and surface that fallback as a data-health item). Acceptance test: `core/preferred-sku.spec` — the physically-larger history wins regardless of denomination.

**H2 · Supplier scorecards count not-yet-due POs as 0% fill rate. [E-confirmed]**

`supplierScorecard` computes `fillRate` as the mean over all lines with nulls contributing zero (feedback.js:170). Confirmed probe: a supplier with one perfect delivery and one not-yet-due open PO reads `fillRate = 0.5`. Because the scorecard feeds preferred-supplier selection (§14.6, "the loop's second turn"), systematically deflated scores will steer sourcing away from suppliers who simply have open orders in flight — an actively harmful signal. `avgLateDays` returns 0 (not null) on no-late-lines, conflating "all on time" with "no data." Required fix: fill-rate and on-time denominators include only lines that are due (received, or past promised date); null-vs-zero semantics separated. Acceptance test: `feedback/scorecard-due-lines.spec` reproducing the probe and asserting the corrected outcome.

**H3 · Price variance and realized savings use the last receipt's price, not the quantity-weighted average. [E-confirmed]**

`reconcileProposal` takes `lastReceipt.unitPrice` as the actual price (feedback.js:66–68), and `realizedSaving` multiplies `(baseline − actual) × qty` on that basis. Confirmed probe: two 500-unit partials at 2.0 and 3.0 report `priceVariance = 1.0` where the truth is 0.5 — a 100% overstatement. Food commodities routinely price partials differently; the spec's flagship claim that savings are "realized rather than claimed" (§14.6) and the entire §11 Pricing/Savings screen rest on this number. Required fix: actual price = Σ(receipt qty × receipt price) ÷ Σ receipt qty over the commitment's receipts; flag mixed-price commitments. Acceptance test: `feedback/weighted-price.spec` with the two-partial fixture.

**H4 · Date handling mixes date-only (UTC) and datetime (local) parsing; lateness can flip by a day. [E-confirmed]**

`days()` (feedback.js:16–20) parses via `new Date(string)`. In this runtime, `new Date('2026-08-23')` (UTC midnight) and `new Date('2026-08-23T02:00:00')` (local) differ by 2h — confirmed. Precoro exports carry date-only and datetime formats across columns (`Receipt Dates`, delivery dates, creation date). A receipt timestamped late in a UTC+3 business day can cross the midnight boundary in one parse but not the other, flipping `lateByDays > 0` and with it OTIF classification, `LATE` flags, and every `realizedLeadDays` observation feeding lead-time learning. Required fix: mandate one canonical temporal form at ingestion (date-only, UTC, `YYYY-MM-DD`; datetimes converted at the boundary with the tenant timezone made an explicit tenant setting), and do date math in day units, not milliseconds, for date-only values. Acceptance test: `feedback/date-canonicalization.spec` with a boundary-time receipt fixture.

**H5 · The ledger is tamper-evident, not tamper-resistant, and Origin supremacy is not carved out for it. [S]**

§11 defines `hash = SHA256(seq ‖ prevHash ‖ canonicalJson(payload))`: (a) an unkeyed hash — anyone with write access to the ledger table (including a DBA, and by the spec's own admission Origin's concealment "holds [nothing] against direct database access") can rewrite history and recompute the entire chain forward from any block; the only countermeasure is the daily WORM anchor, which narrows but does not close the window to the last anchor interval; (b) `canonicalJson` is undefined — JSON canonicalization is notoriously ambiguous (key order, number formatting, unicode); if writer and verifier canonicalize differently, verification either false-fails or, worse, is performed with the same writer-side function and false-passes; (c) §10.1 grants Origin power to "override any rule, permission or grant" and to "purge or restore the system" with no carve-out — taken literally, Origin can purge ledger blocks, dissolving the very property ("tamper-evident even to Origin") the architecture advertises. Required fix: HMAC-SHA256 with a key held in the secret manager (rotation procedure specified), RFC 8785 (JCS) named as the canonicalization standard with cross-implementation test vectors, a **hard invariant that no actor including Origin can update/delete `LedgerBlock` rows** (RLS deny + trigger + tested), purge restricted to business tables with the ledger retained, and the nightly verification job running under a distinct read-only DB role with alerting on failure. Acceptance tests: `ledger/tamper-detection.spec` (mutate any field → verify fails), `ledger/origin-cannot-purge.spec` (origin session attempts DELETE → denied and itself recorded), `ledger/canonicalization.spec` against published JCS vectors.

**H6 · Idempotency keys omit the tenant dimension. [S]**

INGESTION_FILE_SPEC.md §4: keys are Item `SKU`; Inventory `SKU+Warehouse`; PO `PO Number+SKU`; Supplier `Name`; Deliveries `Tenant+Date`; Params `Recipe Ref+Tenant`. Only two of six keys carry the tenant. The upload model is per-tenant (§3.3), and the same catalogue SKU will legitimately exist in BahrainMP and QatarMP with different stock, prices, or params; a `SKU`-keyed item upsert means the second tenant's import *overwrites or collides with* the first's. Required fix: every key prefixed with tenant (`Tenant+SKU`, `Tenant+SKU+Warehouse`, `Tenant+PO#+SKU`, `Tenant+SupplierIdentity`, `Tenant+RecipeRef`); Deliveries/Params keys corrected to match. Acceptance test: `ingestion/multi-tenant-idempotency.spec` — identical fixture imported into two tenants yields two independent rows and re-import changes nothing in either.

**H7 · Supplier identity is a free-text name; the report spec asks Precoro for no supplier ID. [S]**

R4's grain is "one row per supplier" keyed (per H6) by `Name`. Supplier names in the wild are not unique and drift in spelling; the consequence chain is: duplicate/fragmented supplier records → split spend and scorecard history → wrong OTIF and lead-time learning → wrong preferred-supplier routing — all silent. Precoro certainly maintains a stable supplier identifier, but PRECORO_REPORT_SPEC.md R4 never requests it. Required fix: add `Supplier ID` to R4 as a **priority-1 [ADD]** (it is as blocking as PO creation date for the learning loop's integrity), make it the idempotency key with `Name` as display-only; specify a merge workflow for historical duplicates. Acceptance test: `ingestion/supplier-identity.spec` — same ID different spelling merges; different IDs same spelling do not.

**H8 · The consumption-rate denominator's window alignment is asserted by no one. [S]**

The rate that seeds all demand is `consumptionConverted ÷ histTotalDeliveries` (engine.js:25–28). This is only meaningful if both numerator and denominator cover the **same window**. The docs never pin this: the consumption export is "3-month history at load" (R3), while the deliveries figure cited from Riyadh (737,750) is described as "historical total" without a window. If T is 3-month consumption and deliveries are all-time, every rate in the system is silently understated by the window ratio, and *every* reorder point, safety stock, and order quantity with it. The engine test (`seedConsPerDelivery(8800, 737750)`) mirrors the formula without testing window semantics. Required fix: state window alignment as a normative ingestion invariant; the pipeline validates that the deliveries history's date range covers the consumption window before seeding, and refuses (quarantine + data-health item) otherwise. Acceptance test: `ingestion/rate-window-alignment.spec` — mismatched windows block seeding with a human-readable reason. Also: obtain written confirmation from the Riyadh DDS author of the workbook's own window convention, and record it in DECISIONS.md.

**H9 · Day-basis ambiguity: working-day constants vs calendar-day inputs. [S]**

`WD = 22` divides monthly history into daily rates (engine.js:9, 60), and `deliveriesPerDay × 22` magnifies forward. "Deliveries per day" is entered daily by Ops (tab 6, tenant × day) — but is the number *deliveries on that calendar date* (including Fridays) or *per working day*? Ramadan shortens GCC working weeks materially. If Ops enters calendar-day counts and the engine treats them as working-day counts feeding a 22-day month, demand is mis-stated by roughly the working/calendar ratio (~18–25% around Ramadan) — in either direction depending on convention. This ambiguity is inherited from the workbook, which is fine for a spreadsheet one team owns and fatal for a system two+ tenants will feed. Required fix: define the day-basis normatively in the ingestion spec and template instructions (recommended: **calendar-day actuals** as input; engine converts via tenant working-day calendar; WD becomes a per-tenant, per-period calendar-derived value, not a global 22); add a calendar module to `packages/core` with golden tests including a Ramadan window. Acceptance test: `core/working-calendar.spec` — a tenant calendar with a 10-day Ramadan closure produces the documented demand adjustment, and a flat-calendar tenant is byte-identical to today's output.

**H10 · Ingestion file hardening and the email-in channel are absent from the contract. [S]**

The Data Upload screen specifies "watched-folder/email-in states" (§4 screen 28) — an unauthenticated-by-default attack channel — and the pipeline parses attacker-influencable XLSX files. No requirement exists for: file-type sniffing by magic bytes (not extension/name), zip-bomb and sheet-size caps (decompression ratio, row/cell ceilings), formula stripping on ingest *and* on any re-export (spreadsheet formula injection `=cmd|…` protecting the buyers who re-open exports), XML external entity hardening in the parser, and AV scanning. The precedent is in the package itself: `ingredient-stats.xlsx` arrived **corrupt (invalid stylesheet XML)**. The ±40% row-count gate guards volume, not content. Required fix: a §14.x "Ingestion file hardening" section with the above as named, tested requirements; email-in requires a signed/allow-listed sender scheme plus the same pipeline (never a separate fast path). Acceptance tests: `ingestion/zip-bomb.spec`, `ingestion/magic-bytes.spec`, `ingestion/formula-stripping.spec` (a formula-carrying cell round-trips as inert text), and a corpus test including the known-corrupt file shape.

**H11 · The contract has no disaster-recovery layer: no RPO/RTO, no backup/restore requirement, no restore rehearsal. [S]**

The cutover plan's rollback story ("the Excel DDS stays live for 4 weeks") is *business* continuity, not *technical* recovery. Nothing in §8, §11, or §12 requires: backup cadence and retention, point-in-time recovery, off-site/region redundancy, a tested RPO/RTO, or a restore rehearsal gate before go-live. A platform that is the sole holder of planning parameters, hash-chained history, and the learning corpus is a single storage accident away from losing all three. Required fix: add DR to the Definition of Done — RPO ≤ 15 min via WAL archiving or stated alternative; RTO ≤ 4 h; nightly logical backup + continuous WAL; quarterly restore rehearsal logged as a ledger event; backup restore tested in CI-adjacent staging at least once before cutover. Acceptance test: a documented, dated restore rehearsal (not a unit test — a gate item signed by Origin).

**H12 · The handoff package cannot reproduce its own verification claims. [S]**

The build spec asserts the engine is "byte-identical" to the Riyadh MATURE DDS and the handoff lists as inputs "real-shape fixtures" and `Category_Buyers.xlsx` — **none of these files are in the zip**. Test-count claims drift: 46/46 (V3 spec header and M0), 60 (handoff input table), 64 (actual file, verified). A developer AI cannot re-verify golden compatibility; it can only inherit the claim — and it is told "where anything disagrees with [the spec], it wins," while the spec itself disagrees with the shipped tests' count. Required fix: republish the handoff with (a) the two DDS workbooks or a redacted golden-extraction fixture set generated from them, (b) the real Precoro export fixtures and Category_Buyers seed (sanitized of supplier banking data, which R4 already excludes), (c) one canonical test count in CI (enforce `count ≥ 88` with named suites), (d) a checksums manifest. Until then, treat "byte-identical" as **unreproducible inheritance**, and have the developer AI re-derive the golden fixtures from any surviving workbook copy *before* touching engine formulas.

---

### 4.3 MEDIUM

**M1 · The KPI layer binds to raw `status`, resurrecting the A1 defect one level up. [E-confirmed]** `portfolioKPIs` counts `c.status` (engine.js:186) and computes `serviceLevel = 1 − shortages/active` where `active` excludes `reorderPct === null` rows (engine.js:187, 195). Confirmed probes: a consuming-but-unplanned ref reports raw status **'Over Stock'** (its `maxStock` is 0 and branch 1 fires first) and lands in the KPI's Over-Stock count while displaying 'Not Planned' in the UI; and `serviceLevel = 1.0` while the sole consuming ref is unplanned. On day one — Precoro planning fields 100% empty, by documented design — the Command Center would show an Over-Stock flood and a perfect service level over a dormant catalogue. Fix: `portfolioKPIs` must consume `displayStatus`/`dataState` (or exclude non-`OK` dataStates from counts and report an explicit `unplannedShare` KPI). Acceptance test: `core/kpi-datastate.spec` asserting both probe cases corrected.

**M2 · Proposal outcome taxonomy lacks PENDING; acted-rate is distorted during the decision window. [E-confirmed]** A 2-day-old proposal with no buyer action classifies as `IGNORED` with `NO_COMMITMENT` (feedback.js:43–51) — confirmed — and `proposalQuality` counts it as not-acted, so `actedRate` reads 0 while decisions are still within any reasonable SLA. Buyer scorecards (§14.13) judge humans on this. Fix: add `PENDING` (age < SLA) distinct from `IGNORED` (age ≥ SLA or explicitly dismissed); make SLA per-tenant config; escalate on breach (already intended by §14.6). Acceptance test: `feedback/pending-vs-ignored.spec`.

**M3 · `parameterEfficacy` fires parameter-change signals from three observations. [R]** With `n ≥ 3` (feedback.js:121), one stockout among three followed proposals (33% > 20%) emits an "increase safetyDays" signal (feedback.js:124). `leadTimeEstimate` has confidence gating; this function has none, yet it trains the optimizer. Fix: require `n ≥ 12` and the same high-confidence gate, or scale thresholds by sample size; expose `n` next to every signal. Acceptance test: `feedback/efficacy-min-sample.spec`.

**M4 · `unitValue` collapses to 0 when on-hand is 0, zeroing target/max valuation for in-flight refs. [R]** engine.js:72 — a ref with stock on order but zero on hand (a normal state during ramp-up or after a stockout) gets `unitValue = 0`, hence `targetInvValue = maxInvValue = 0`, understating portfolio target value exactly when the item matters most. Fix: fall back to the item master price (already ingested as `Price *`) when on-hand is 0; flag the substitution. Acceptance test: `core/unitvalue-fallback.spec`.

**M5 · Supply-status producers (`overduePO`, `partialPO`, `supplierIssue`) are unspecified. [S]** `supplyStatus` (engine.js:143–151) consumes fields no export defines and no code derives. Derivation needs an "as of" date, timezone, and rules (overdue = today > promised date AND waiting > 0? partial = received > 0 AND waiting > 0?). Fix: define producers in the ingestion spec with unit-converted inputs (see C1) and tests; the status axis must never render from under-specified data. Acceptance test: `ingestion/supply-status-producers.spec`.

**M6 · Receipt→PO-line matching rules are unspecified — the hardest reconciliation problem is delegated to nobody. [S]** `reconcileProposal` receives `receipts` as given. Real matching involves PO amendments, split GRNs, merged POs, over-receipt tolerance, returns/credits, and cancellations (R5 supplies `Purchase Order Status` including cancelled, which the feedback module never handles). Fix: a normative matching section (keys, tolerance, cancellation and amendment semantics) in the ingestion spec or §14.6, with fixture tests; until then DoD 5b ("the loop closes") is not verifiable. Acceptance test: `feedback/matching.spec` covering split, amended, cancelled, and returned lines.

**M7 · Conversion-factor changes are ungoverned and unversioned. [S]** CF multiplies consumption, PO conversion (C1), and order sizing; the risk assessment calls CF errors order-of-magnitude. Nothing gates a CF edit, versions it, or handles in-flight proposals sized under the old factor (adherenceQty compares quantities across unit bases). Fix: CF changes are a permissioned, approval-gated, versioned change (like price changes); open proposals carry a units snapshot; a CF change raises re-derivation tasks. Acceptance test: `governance/cf-change.spec`.

**M8 · Restatement semantics vs sealed DayState are undefined. [S]** Late-arriving consumption restates history; DayStates are immutable. Does the time machine show the sealed (wrong) state forever, with current data diverging silently? Fix: restatement events are ledger blocks; the time machine marks resealed states and diffs "as known then" vs "as known now." Acceptance test: `ledger/restatement.spec`.

**M9 · Freshness SLO and the no-deliveries alarm are prose, not requirements. [S]** §5 of the ingestion spec says the missing-deliveries case "is the one to alarm on" — but no SLO, no alert target, no UI stale-data banner requirement exists in the build spec or DoD. Fix: data-freshness SLO per kind (e.g., ≤ 26 h), pipeline success-rate metric, named alarm on missing deliveries, and a stale-data banner component on every board. Acceptance test: `ops/freshness-alarm.spec` (simulate a missed drop → alarm + banner asserted).

**M10 · FX stale-rate behaviour is unspecified. [S]** The FX pin is 24h per tenant-day; nothing says what happens when the FX job fails (block conversions? last-pinned value with a staleness flag?). Fix: fail-safe policy (continue on last pinned rate, mark all derived money stale-visible, alarm); source of record named. Acceptance test: `ops/fx-stale.spec`.

**M11 · Authentication policy for non-origin users is unspecified. [S]** Session idle/absolute limits, MFA, password policy, and lockout exist only for Origin (§10.1, §14.9). Directors and Sr Buyers approve spend. Fix: MFA mandatory for all approval-capable roles; session policy at least as strict as Origin's; lockout for all accounts. Acceptance test: `auth/mfa-approvals.spec`, `auth/session-policy.spec`.

**M12 · CI has no security gates. [S]** §13's CI runs lint/typecheck/tests. No dependency audit, secret scanning (gitleaks-class), license scan, SBOM, or container scanning is required — for a system whose handoff explicitly fears credential leakage (non-negotiable 5). Fix: add all five as merge-blocking gates; pin dependencies (the charts library is already pinned — generalize the practice). Acceptance test: CI config review + one deliberately vulnerable fixture dependency caught.

**M13 · The Intelligence node needs a data-egress classification and a prompt-injection stance. [S]** Sending procurement data to a third-party LLM is an egress boundary in a "closed ecosystem." No field allow-list, no cross-tenant prompt policy, no injection stance (supplier/item names and task comments are attacker-influencable text; generated tasks are approval-gated — good — state it as the *designed* containment). Fix: an egress allow-list (aggregates and item/ref names only; no prices-per-supplier beyond what the analysis requires, no personnel data), tenant-scoped prompts unless Origin explicitly consolidates, and a documented injection threat model entry. Acceptance test: `intelligence/egress-allowlist.spec` (a prompt containing a disallowed field is rejected before the API call).

**M14 · Status-ladder internal inconsistencies (workbook heritage) — document, do not silently fix. [E-confirmed]** Three properties verified: branch 7 (`available > maxStock + maxStock×0.2`, engine.js:135) is mathematically identical to branch 1 and unreachable; a display/trigger band exists at `1.0 ≤ reorderPct < 1.01` where status reads 'Below Reorder' but `orderRecQty = 0`; negative available classifies as 'Below Safety' (red, not silent — but an impossible state should be *detected*, not classified). Fix: keep the ladder byte-compatible (golden rule), add a `warnings` array to `computeRef` output (dead-branch note, impossible-state detection), and document the band in §6. Acceptance test: `core/ladder-edges.spec` pinning current behaviour + warnings.

---

### 4.4 LOW / informational

| ID | Finding | Evidence | Note |
|---|---|---|---|
| L-01 | `nz()` accepts thousand-separated strings as 0 | [E] probe L11 | Covered by C4's strict parsing; engine inputs must be pre-validated numbers only |
| L-02 | Shelf-life cap rounds with `Math.round`, can exceed true cover by <1 unit | [E] probe L9v2 (cap 31 vs 30.6) | Use `floor` for the cap as a matter of principle; magnitude trivial |
| L-03 | `effectiveDeliveriesPerDay` converts a legitimate 0 factor (closed period) to 1 | [R] engine.js:235 | Document; provide explicit "market closed" calendar entry instead |
| L-04 | `leadTimeEstimate` `mean`/`spread` are outlier-sensitive (mean 78.7 on 11×4d + one 900d) while `suggested` (p80) is robust | [E] probes L5v2 | p80's percentile robustness is a *credit*; suppress or winsorize mean/spread in UI |
| L-05 | `avgLateDays` returns 0 (not null) when no late lines | [R] feedback.js:171 | Distinguish "all on time" from "no data" (folded into H2) |
| L-06 | `reconcileProposal` defaults `asOf` to `new Date()` — nondeterministic in pipelines | [R] feedback.js:44 | Require explicit `asOf` in all service callers; keep default for UX only |
| L-07 | Engine outputs carry no engine-version stamp | [R] | Add `engineVersion` to `computeRef` output for time-machine and ledger diffs |
| L-08 | `DEVIATION_UNEXPLAINED` never fires on the no-commitment path | [R] feedback.js:43–51 | Correct as designed (nothing deviated yet); confirm intent in spec text |
| L-09 | `WD`/`WK` are module constants; spec calls them "configurable" without saying per-tenant or per-period | [S] §6 | Resolved by H9's calendar module |
| L-10 | The 0.21 staging factor is a magic number inside `portfolioKPIs` | [R] engine.js:193 | Promote to a named, sourced setting with workbook provenance |

---

## 5. Closed-ecosystem assessment (end-to-end)

The user-level requirement is that Sentinel operates as a closed ecosystem end to end. The architecture is genuinely designed for this — pull-only ingestion, no write-back, banking fields discarded at source — and the shipped code honours it. The complete boundary inventory, with this audit's verdict per boundary:

| Boundary | Direction | Code/spec status | Verdict & required control |
|---|---|---|---|
| Precoro → Sentinel (file exports) | In | Pipeline spec'd; hardening absent | **H10** controls required; pull-only confirmed |
| Email-in / watched folder | In | Named as UI states; zero controls spec'd | Treat as hostile input: sender allow-list + full pipeline, never a fast path (H10) |
| Precoro write-back | Out | **Prohibited**; grep-verified absent in code | Keep the prohibition test-enforced at CI level (grep gate), not just by convention |
| PDF order exports | Out | Spec'd (§4 screen 7) | Apply formula-stripping on export (H10); no banking data by construction |
| Slack bridge | Out | Named (M4); no content/security policy | Signed webhooks, secret from env, content allow-list (no pricing detail beyond need) — add to §14 |
| Anthropic (Intelligence) | Out | Origin-only, server-side key | Good posture; **M13** egress allow-list + injection stance required |
| FX rate source | In | Named as a setting; source unnamed | Name the source; stale-rate fail-safe (M10) |
| WORM / off-site anchor | Out | Spec'd (§11) | Make the nightly anchor result an alarmed, monitored job (M9-class) |
| Human-side files (email, chat) | Out of band | Out of scope for code | Covered by governance, not code — note in the threat model |

**Verdict:** the ecosystem is closed by design and by code today. The four boundaries that will actually exist at runtime without shipped controls — email-in, Slack, the LLM path, and the FX feed — are exactly where the closed property will silently erode if the developer AI implements them from current prose. All four have named fixes in this report; none are expensive; all are cheap relative to one fraud incident.

---

## 6. Spec-contract gaps to resolve before M1 (the developer AI's first reading list)

These are the points where the contract itself must be amended *before* implementation, because an implementer following the current text literally will bake the gaps into the system. Each maps to a finding above: financial controls (C3), ingestion hardening (C4, H10), multi-tenant idempotency (H6), supplier identity (H7), rate window (H8), day-basis calendar (H9), ledger cryptography and the Origin carve-out (H5), DR gates (H11), unit-conversion pipeline stage (C1), currency normalization layer (C2), receipt-matching rules (M6), supply-status producers (M5), freshness SLO (M9), FX fail-safe (M10), non-origin authn (M11), CI security gates (M12), Intelligence egress policy (M13), PENDING outcome (M2), restatement semantics (M8), CF governance (M7). Where the spec and this report disagree, the business should decide explicitly and record the resolution in DECISIONS.md — silence is the one unacceptable outcome, because this contract is the document the implementer is instructed to obey over all others.

---

## 7. The $50M readiness gate (go/no-go checklist)

Evaluated against today's package. A gate marked **OPEN** must close before cutover; the mapping is to findings and backlog items.

| # | Gate | Status | Ref |
|---|---|---|---|
| 1 | Engine formulas verified against golden source, tests green | **PASS** (inherited; see gate 2) | V1, V2 |
| 2 | Golden verification reproducible from the package itself | **OPEN** — fixtures missing | H12 |
| 3 | PO/planning unit conversion implemented and tested | **OPEN** | C1 |
| 4 | Currency normalization before engine/KPIs | **OPEN** | C2 |
| 5 | SoD + dual control + thresholds in spec and code | **OPEN** | C3 |
| 6 | Strict numerics + plausibility bounds on all quantity feeds | **OPEN** | C4 |
| 7 | Preferred-SKU weighting unit-safe | **OPEN** | H1 |
| 8 | Scorecards due-line-correct (fill rate, on-time) | **OPEN** | H2 |
| 9 | Weighted-price variance and savings | **OPEN** | H3 |
| 10 | Canonical dates; day-basis calendar | **OPEN** | H4, H9 |
| 11 | Ledger keyed + canonicalization + Origin carve-out | **OPEN** | H5 |
| 12 | Tenant-scoped idempotency + supplier identity | **OPEN** | H6, H7 |
| 13 | Ingestion file hardening + email-in controls | **OPEN** | H10 |
| 14 | DR: RPO/RTO + restore rehearsal | **OPEN** | H11 |
| 15 | KPI layer dataState-aware | **OPEN** | M1 |
| 16 | Receipt-matching rules normative | **OPEN** | M6 |
| 17 | Freshness SLO + no-deliveries alarm | **OPEN** | M9 |
| 18 | CI security gates + SBOM | **OPEN** | M12 |
| 19 | Cutover data-readiness gates W1–W13 (external project) | **OPEN** (out of code scope, unchanged) | Cutover spec §4 |
| 20 | Parallel run ≥ 4 weeks with divergences explained | **OPEN** (external) | Cutover spec §4 |

Gates 1 and 19–20 originate outside this audit's scope; all others are closed by the backlog below.

---

## 8. Prioritized remediation backlog for the developer AI

**P0 — before writing any ingestion code (the seams that poison everything downstream):**
1. Amend the build spec with C3 (SoD/dual-control/thresholds), H5 (ledger), H6 (idempotency), H7 (supplier ID), H8 (rate window), H9 (calendar), H10 (hardening), H11 (DR), M6, M9, M10, M12, M13 — one §14.x per item, each with its acceptance test named in §13's obligations.
2. Implement the **unit-conversion pipeline stage** (C1) with golden fixtures *before* the inventory/PO upserts exist, so the upserts cannot be written without it.
3. Implement **currency normalization** (C2) in the ingestion layer and strip currency-bearing aggregation from `portfolioKPIs` inputs.
4. Replace lenient numerics with strict parsing + plausibility bounds (C4); specify deliveries-confirmation semantics.
5. Fix `resolveOrderingSku` weighting (H1) and `supplierScorecard` denominators (H2) — small diffs, existing suites extended.

**P1 — before M3 (SOURCE) ships money-moving workflows:**
6. Weighted-price variance/savings (H3); date canonicalization (H4); PENDING outcome (M2); efficacy confidence gating (M3); unitValue fallback (M4).
7. Ledger hardening: HMAC, JCS, Origin carve-out, external verification role (H5).
8. Receipt-matching specification + implementation with fixture corpus (M6); supply-status producers (M5).
9. AuthN/MFA for approval roles (M11); CI security gates (M12); Intelligence egress allow-list (M13).

**P2 — before cutover:**
10. KPI dataState-awareness (M1) — must land before first real ingestion, not before M3; move to P0 if ingestion precedes M2 milestones.
11. CF governance (M7); restatement semantics (M8); freshness SLO/alarming (M9); FX fail-safe (M10); engine version stamping (L-07); ladder edge warnings (M14).
12. Republish the handoff package (H12): fixtures, checksums, canonical test counts, DECISIONS.md entries for every spec amendment above.

Every P0/P1 item carries its acceptance test in the finding text; the Definition of Done for this remediation is that all twenty gates in §7 read PASS, with the two external gates evidenced by the cutover project.

---

## 9. Rescoring against the $50M bar

The prior audit scored 82/100 conditional on the data-readiness project. That score rewards planning capability created — legitimate for its scope. Rescored for the mandate this audit was given (carry $50M safely), weighting integrity, control, and failure behaviour:

| Dimension | Prior | Rescored | Rationale |
|---|---|---|---|
| Engine correctness & fidelity | 95 | 88 | Formulas verified; unit/currency seams and edge classification gaps (M1, M14, H1) deducted from what was credited to the engine layer |
| Data integrity & governance | 90 | 66 | Idempotency keys (H6), supplier identity (H7), window alignment (H8), CF governance (M7), restatement (M8) all open |
| Security & fraud resistance | 80 | 58 | SoD/dual-control absent (C3), ledger posture (H5), ingestion hardening (H10), authn scope (M11), CI gates (M12) |
| Learning-loop trustworthiness | 80 | 64 | Weighted-price (H3), scorecard denominators (H2), date handling (H4), matching rules (M6), efficacy gating (M3) |
| Robustness & operability | 75 | 62 | Strict numerics (C4), freshness SLO (M9), FX fail-safe (M10), DR absence (H11) |
| Closed-ecosystem assurance | 85 | 74 | Code-clean today (V9); runtime boundaries without controls (H10, M13) |
| **Composite readiness** | **82** | **61** | With the P0/P1 backlog closed and cutover gates met, the modelled composite is **~90** — the package is architecturally capable of the bar; it is not yet contractually or operationally there |

The 29-point gap between 61 and 90 is, almost entirely, work that is *specified in this report to acceptance-test level* and small in code size. The asymmetry that matters: every CRITICAL here costs days to fix now and would cost orders, cash, or auditability if discovered in production — which is precisely why this gate exists.

---

## Appendix A — Empirical probe log (executed against shipped code)

| Probe | Construction | Result |
|---|---|---|
| L1 | NO_PARAMS ref → `computeRef` → `portfolioKPIs` | **CONFIRMED** — raw status 'Over Stock' in KPI counts while displayStatus 'Not Planned' |
| L1b | Same ref → serviceLevel | **CONFIRMED** — serviceLevel 1.0 while unplanned |
| L2 | statusOf branch equivalence | **CONFIRMED** — branch 7 unreachable (identical to branch 1) |
| L3 | negative available classification | Not silent — lands 'Below Safety' (kept as M14, impossible-state detection) |
| L4 | Preferred-SKU weight across purchase units | **CONFIRMED (round 2)** — 30 CTN × 9 orders (3,000 pcs) loses to 500 PCS × 1 order |
| L5 | Lead-time outlier robustness | **CREDIT** — p80 robust at n = 12/17/25/40; mean/spread distorted (kept as L-04) |
| L6 | Two partial receipts at different prices | **CONFIRMED** — variance 1.0 reported vs 0.5 true |
| L7 | Scorecard with not-yet-due PO | **CONFIRMED** — fillRate 0.5 for a perfect supplier |
| L8 | Date-only vs datetime parsing | **CONFIRMED** — 2h divergence in runtime; day-flip possible on lateness thresholds |
| L9 | Shelf-life cap rounding | **CONFIRMED (round 2)** — cap 31 vs true cover 30.6 (kept as L-02, trivial) |
| L10 | Proposal within SLA, no action | **CONFIRMED (round 2)** — outcome IGNORED, actedRate 0 (kept as M2) |
| L11 | `nz('1,200')` | **CONFIRMED** — 0 |
| L12 | Mixed-currency aggregation | **CONFIRMED** — BHD+AED summed as one currency |
| L13 | conversionFactor presence in shipped code | **CONFIRMED** — 0 occurrences in feedback.js; conversion unimplemented (C1) |
| L14 | `days()` rounding behaviour | Benign at half-day boundaries; combined with L8 requires canonicalization (H4) |

## Appendix B — Independent test execution

```
$ node engine.test.js    → 64 passed, 0 failed
$ node feedback.test.js  → 24 passed, 0 failed
$ rg "fetch|axios|http|net\.|tls|WebSocket" engine.js feedback.js        → NONE
$ rg -i "password|secret|token|apikey|credential" engine.js feedback.js  → NONE
$ rg "eval\(|new Function|child_process|exec\(|spawn" *.js               → NONE
$ rg -i "POST|PUT|PATCH|writeback|write-back" engine.js feedback.js      → comments/function names only
```

Template inspection: `Sentinel_Ingestion_Template.xlsx` contains the 8 tabs named in INGESTION_FILE_SPEC.md §3.3 (`1_ITEMS` … `8_CATEGORY_OWNERS`) — conforms.

## Appendix C — Document inventory audited

`SENTINEL_V3_BUILD_SPEC.md` (588 lines, contract) · `SENTINEL_DESIGN_SPEC.md` (SDS) · `SENTINEL_AUDIT.md` (prior audit) · `INGESTION_FILE_SPEC.md` · `PRECORO_REPORT_SPEC.md` · `PRECORO_CUTOVER_PROJECT_SPEC.md` · `CURRENT_STATE_RISK_ASSESSMENT.md` · `CLAUDE_CODE_HANDOFF.md` · `Sentinel_System_Graph.html` · `engine.js` (256) · `feedback.js` (210) · `engine.test.js` (318) · `feedback.test.js` (205) · `Sentinel_Ingestion_Template.xlsx`. Note: this audit's scope is logic, security, robustness and systems integrity; the SDS visual system was reviewed only where it intersects robustness (status vocabulary, empty states) and is otherwise out of scope.
