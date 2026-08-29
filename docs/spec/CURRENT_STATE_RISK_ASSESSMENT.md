# Current State — Data & Spreadsheet Risk Assessment

**Scope:** the datasets and workbooks running the company's supply chain today (Precoro exports plus the per-market
Excel DDS workbooks for Riyadh, Bahrain, Qatar and Kuwait).
**Method:** direct forensic inspection of the live files — every figure below is measured, not estimated.
**Purpose:** state plainly what the current setup risks, so the cutover work is prioritised by exposure
rather than by convenience.

---

## 1. Executive summary

The business runs a supply chain of **~4,000 SKUs across 26 warehouses in 6+ markets on spreadsheets**, against a
transactional system that holds **no planning data whatsoever**. The two halves of a working supply chain
exist in different places and neither can see the other:

- **Precoro** has the transactional backbone — requisitions, POs, receipts, a multi-warehouse ledger,
  ~109,138 BHD of inventory in Bahrain alone — and **zero planning parameters**.
- **The Excel DDS workbooks** have the planning brain — safety stock, reorder points, EOQ — and **no
  transactional spine**, no access control, no audit trail, and no cross-market view.

The consequence is that **no one can answer "what should we order today, and did we order it?" from a
system.** It is answered from memory, spreadsheets and individual judgement. That is the central risk;
everything below is a symptom of it.

---

## 2. Measured findings and what each one costs

### 2.1 Precoro holds no planning data at all — **critical**
`Minimum Stock Level`, `Reorder To` and `Need To Order` are present as fields and **empty on all 11,317
stock lines — 100%**.
**Risk:** the system of record cannot signal a shortage. Replenishment depends entirely on a person
remembering to look. There is no systematic early warning anywhere in the transactional stack.

### 2.2 84% of suppliers have no lead time — **critical**
**194 of 230 suppliers** have a blank `Delivery Period`.
**Risk:** a reorder point is mathematically `(lead time + safety days) × daily usage`. With no lead time the
calculation is undefined, so for the large majority of the supplier base **there is no defensible reorder
point** — buying is reaction, not planning. This single gap invalidates planning for most of the catalogue.

### 2.3 The demand primitive lives outside the supply-chain stack — **medium** *(revised)*
Deliveries are captured in **deliveries dashboard**, and are available daily, weekly, monthly, quarterly or
YTD. They are **not** in Precoro and not in the planning workbooks.
**Risk:** the number that should drive every planning calculation sits in a separate system and reaches
planning only when a person transcribes it. That makes forward projection manual, inconsistent between
markets, and dependent on someone remembering. It is a **transcription and integration gap, not an absence
of data** — materially less severe than a missing primitive, but it still means demand is not systematically
connected to replenishment today.
*Mitigation in Sentinel:* deliveries are entered at any granularity and normalized to a per-day rate on the
exact basis the magnification uses, so monthly or YTD figures give the same answer as daily input. A future
integration with deliveries dashboard would remove the transcription step entirely.

### 2.4 Purchase orders cannot be measured against reality — **high**
The PO export carries **no creation date and no unit price**; creation date exists only as a report filter.
**Risk:** supplier lead-time performance, price drift and realized savings are **unmeasurable from system
data**. Supplier negotiations are conducted without evidence, and claimed savings cannot be verified.

### 2.5 Consumption data arrives undated — **high**
The Inventory Report has no period columns; the date range is a report parameter only.
**Risk:** a consumption figure with no period is uninterpretable. Rates must be reconstructed by hand, and
any error propagates silently into every downstream calculation.

### 2.6 Warehouse types are unusable — **high**
The `Type` column reads `All` on every row, across 26 locations that include quarantine
("Rejected/under inspection"), staging (kitchen and dispatch shop floors), 3PL, consignment and virtual
write-off locations.
**Risk:** **stock that cannot be used is counted as if it can.** Quarantined and staged goods inflate
apparent availability, so the business believes it has cover it does not have — a direct stockout mechanism.

### 2.7 Unit chaos — **high**
**50 distinct unit spellings** for roughly a dozen real units (KG/Kg, CTN/Carton, PCS/Piece/pieces,
BTL/Bottle).
**Risk:** conversion errors are silent and can be order-of-magnitude. A carton treated as a piece is a 500×
error in a purchase quantity. Nothing in the current setup detects it.

### 2.8 Recipe Reference is many-to-one and unresolved — **high**
**1,395 recipe refs; 734 hold more than one SKU; one holds 50.** There is no recorded "preferred" SKU.
**Risk:** planning happens at ref level but buying happens at SKU level, and the bridge lives only in
buyers' heads. When the person who knows is away, the wrong SKU or the wrong supplier gets ordered.

### 2.9 Payment terms are prose — **medium**
Free text across six-plus variants ("SOA +45 Days", "Advance 100%", "On Delivery").
**Risk:** DPO and working-capital planning cannot be computed. Cash-flow impact of buying decisions is
invisible at the moment the decision is made.

### 2.10 Master-data hygiene — **medium**
**548 of 3,993 items inactive**; country of origin sparsely populated; supplier country spellings
inconsistent ("Bahrain", "Kingdom of Bahrain", "BAHRAIN").
**Risk:** dead SKUs pollute analysis and proposals; local-vs-import decisions can't be made from data.

### 2.11 Sensitive data in circulation — **medium, but escalating**
The supplier export includes **bank account numbers, IBANs, SWIFT/BIC, sort codes, routing numbers, tax IDs
and business registration numbers** — and this file is emailed and shared as a spreadsheet.
**Risk:** every copy is an uncontrolled financial-data disclosure and a credible payment-fraud vector
(supplier bank-detail substitution is one of the most common B2B frauds). There is no access control on a
spreadsheet once it is sent.

---

## 3. Structural risks of running on spreadsheets

**No single version of truth.** Per-market workbooks have drifted: different columns, sheet-name typos
("Invenotry"), stale archive tabs, `#N/A` and `#VALUE!` artefacts left in live calculations. Riyadh's
workbook is materially more mature than Bahrain's — so the same company plans the same category two
different ways, and neither market can see the other.

**Key-person dependency.** The planning logic lives inside formulas that a handful of people understand. If
the author of the Riyadh DDS leaves, the method leaves with them. There is no documentation, no tests, and
no way to verify a formula is still correct after an edit.

**No audit trail.** Nothing records who changed a safety-stock value, when, or why. A parameter can be
altered — deliberately or by mis-click — and there is no way to detect it, attribute it, or roll it back.
For a business of this size this is also a governance and audit-readiness problem.

**No access control.** A spreadsheet is all-or-nothing. Anyone with the file can change any number in any
market, including cost and supplier data.

**Silent failure.** Spreadsheets fail quietly — a dragged formula, a mis-sorted column, a hardcoded value
overwriting a reference. There is no validation layer, so an error persists until someone notices a physical
consequence, i.e. after the stockout or the over-order.

**No feedback loop.** Nothing compares what was recommended to what was bought, or what was promised to what
arrived. The organisation cannot learn from its own purchasing history because that history is never closed
against its intent.

**Fragility at scale.** These files are 6–12MB with heavy array formulas. They are slow, they corrupt, and
one of the files supplied for this analysis (`ingredient-stats.xlsx`) **would not open at all** — invalid
stylesheet XML. That is not a hypothetical failure mode; it already happened.

---

## 4. Aggregate exposure

| Risk | Mechanism | Business consequence |
|---|---|---|
| **Stockout** | No reorder signal (2.1), no lead time (2.2), unusable stock counted as available (2.6) | Production stoppage, menu substitution, customer-facing failure |
| **Over-order & waste** | No shelf-life constraint in any current calculation; MOQ applied without cover check | Spoilage of fresh goods; cash tied up in stock |
| **Cash inefficiency** | DIO unmanaged per market; DPO uncomputable (2.9) | Working capital held longer than necessary |
| **Value leakage** | Price drift unmeasurable (2.4); savings unverifiable | Paying above benchmark without detection |
| **Wrong-item purchasing** | Unresolved ref→SKU bridge (2.8), unit confusion (2.7) | Wrong goods, wrong quantities, emergency re-buys |
| **Fraud / disclosure** | Bank details in circulating spreadsheets (2.11) | Payment diversion; regulatory exposure |
| **Continuity** | Key-person formulas, no audit, corruptible files | Planning capability lost with a person or a file |

---

## 5. Why this is worth fixing now, not later

Three of these risks compound with growth. Every new market multiplies the workbook drift. Every new SKU
adds another unit spelling and another unmapped recipe ref. Every month without closed-loop data is a month
of purchasing history that can never be learned from, because the link between intent and outcome was never
recorded.

The corrective work is not primarily software. **Sentinel cannot fix bad inputs** — it will faithfully
compute a wrong answer from a wrong lead time. The data-readiness project (see `PRECORO_CUTOVER_PROJECT_SPEC.md`)
is therefore the substance of the risk reduction; the platform is what makes the improvement durable,
auditable and repeatable across markets.
