# Precoro Data Readiness & Cutover — Project Specification

**Purpose:** Sentinel starts **empty**. Everything except Origin's bootstrap arrives by ingestion, so
**Sentinel will be exactly as good as Precoro's data on day one.** This project fixes that data *inside
Precoro* before cutover, so the platform launches healthy instead of launching honest-but-useless.

**Why this is a separate project:** it is data and process work owned by the supply-chain team, not
engineering. It runs in parallel with the build and **gates go-live**.

---

## 1. The starting position (measured, not estimated)

| Finding | Measure | Consequence if unfixed |
|---|---|---|
| Supplier lead times missing | **194 / 230 = 84%** | Reorder level **cannot compute**. Those refs are unplannable |
| Precoro planning fields empty | `Min Stock`, `Reorder To`, `Need To Order` = **0 across 11,317 lines** | Nothing to migrate — Sentinel must originate all of it |
| Unit spellings | **50 raw variants** (KG/Kg, CTN/Carton, PCS/Piece…) | Conversion and rollup break silently |
| Inactive items | **548 / 3,993** | Dead SKUs pollute planning and proposals |
| Recipe refs | **1,395**, of which **734 hold >1 SKU** (max 50) | No preferred SKU ⇒ proposals cannot name what to buy |
| Payment terms | free text, 6+ variants ("SOA +45 Days") | DPO cannot compute |
| Warehouses | **26**, kind not classified | Quarantine/staging wrongly counted as available |
| Consumption history | one-day snapshot supplied | Per-SKU rates cannot be seeded |
| Deliveries/day | not present for BahrainMP or QatarMP | **The engine has no demand primitive** |
| QatarMP | no exports at all | Second launch tenant has no data |

---

## 2. Workstreams

Each has an owner, a method, and a **numeric acceptance threshold**. Thresholds are the go-live gate (§4).

**W1 · Supplier lead times** — *Owner: Procurement leads, by category*
Populate `Delivery Period (days)` in Precoro. Method: (a) contractual/agreed lead time where one exists;
(b) otherwise the observed median of `actual receipt − expected delivery` from 6 months of PO history;
(c) otherwise a category default, explicitly marked provisional.
**Threshold: ≥ 90% of suppliers covering active SKUs; 100% of A-class (top 80% of spend).**

**W2 · Unit normalization** — *Owner: Category owners; arbiter: SC Manager*
Collapse 50 spellings to a canonical list (~12 families) and correct each item's unit and conversion factor.
Sentinel keeps the alias map; Precoro should be corrected at source where possible.
**Threshold: 100% of active SKUs map to a canonical unit; conversion factor non-zero and sane.**

**W3 · Recipe-ref coverage & preferred SKU** — *Owner: Category owners*
Every active SKU carries a Recipe Ref. For each multi-SKU ref, nominate the **preferred ordering SKU**
(the one normally purchased) and its primary supplier. This is what makes an order proposal actionable.
**Threshold: 100% active SKUs mapped; preferred SKU set for 100% of multi-SKU refs.**

**W4 · Item lifecycle hygiene** — *Owner: Category owners*
Confirm the 548 inactive items are genuinely dead; mark banned SKUs; retire duplicates.
**Threshold: zero ambiguous items; banned list signed off.**

**W5 · Warehouse classification** — *Owner: Warehouse/Logistics*
Tag each of the 26 locations as COMPANY / 3PL / STAGING / QUARANTINE / CONSIGNMENT / VIRTUAL / INACTIVE.
Determines what counts as *available* versus held.
**Threshold: 100% classified and signed off.**

**W6 · Payment terms structuring** — *Owner: Finance*
Map free text to integer days (SOA+45 → 45; Advance 100% → 0; On Delivery → 0).
**Threshold: 100% of active suppliers carry a numeric term.**

**W7 · Consumption history extraction** — *Owner: SC Analyst*
Export **3+ months** of start/goods-in/goods-out/end per SKU per tenant. This seeds every per-SKU rate.
**Threshold: ≥ 3 complete months for both tenants; ≥ 95% of active SKUs present.**

**W8 · Deliveries history & daily routine** — *Owner: Ops / SC Manager*
Supply historical deliveries per day (matching the consumption window) **and stand up the daily entry
routine with a named owner and backup before go-live.** This is the single most important input.
**Threshold: history supplied; daily entry demonstrated for 14 consecutive days pre-cutover.**

**W9 · Shelf life for perishables** — *Owner: Category owners + Nutrition*
Capture `Shelf Life Days` for fresh categories so order quantities are capped before spoilage.
**Threshold: 100% of Fresh/Dairy/Protein/Bakery SKUs.**

**W10 · Approval baseline** — *Owner: Nutrition & Production leads*
Set the current nutrition/production approval state per SKU so Sentinel starts from truth, not blank.
**Threshold: 100% of active SKUs flagged.**

**W11 · Price baseline for savings** — *Owner: Procurement + Finance*
Establish the baseline set: last price per SKU, budget price where one exists, benchmark where available.
Without a baseline, savings cannot be measured from day one.
**Threshold: previous-price baseline 100%; budget baseline for A-class.**

**W12 · QatarMP data set** — *Owner: Qatar SC lead*
Produce the equivalent exports for Qatar, or complete the combined ingestion template.
**Threshold: full template accepted by the validator with zero blocking errors.**

**W13 · Category ownership confirmation** — *Owner: SC Director*
Confirm owner per (category × tenant), including cross-tenant/regional grants, with real user identities
and emails (current sheet has display names only).
**Threshold: 100% categories owned in every live tenant.**

---

## 3. Sequence

| Phase | Duration | Contents |
|---|---|---|
| **P0 · Baseline** | week 1 | Freeze a measurement snapshot; publish the readiness dashboard; assign owners |
| **P1 · Structural** | weeks 2–4 | W2 units · W5 warehouses · W6 terms · W4 lifecycle *(no dependencies; unblocks everything)* |
| **P2 · Planning inputs** | weeks 3–6 | W1 lead times · W3 recipe/preferred SKU · W9 shelf life · W13 ownership |
| **P3 · History** | weeks 5–7 | W7 consumption · W8 deliveries · W11 price baseline · W10 approvals |
| **P4 · Qatar** | weeks 5–8 | W12 |
| **P5 · Dry run** | week 8 | Full ingestion into a Sentinel staging tenant; validator report; fix; re-run |
| **P6 · Parallel run** | weeks 9–12 | Sentinel runs alongside Excel; compare proposals weekly; investigate every divergence |
| **P7 · Cutover** | week 13 | Gate review (§4) → Excel DDS retired → Sentinel is the planning system of record |

Weekly readiness review; a workstream below threshold at P5 blocks its category, not the whole launch —
**partial go-live by category is allowed and preferred over delay.**

---

## 4. Go-live gate (all must hold, per tenant)

1. Lead times ≥ 90% (100% A-class) · 2. Units 100% canonical · 3. Recipe-ref coverage 100% and preferred
SKU on every multi-SKU ref · 4. Warehouses 100% classified · 5. Payment terms 100% numeric ·
6. ≥ 3 months consumption for ≥ 95% of active SKUs · 7. Deliveries entered daily for 14 consecutive days ·
8. Shelf life on 100% of perishables · 9. Every category owned · 10. Parallel run ≥ 4 weeks with divergences
explained · 11. A dry-run ingestion completes with zero blocking validation errors.

**Rollback:** the Excel DDS stays live and updated throughout P6 and for 4 weeks after cutover. Reverting
means resuming the workbook — no data migration is required, because Sentinel never becomes Precoro's
system of record.

---

## 5. What this project explicitly does *not* do
- It does not put planning parameters into Precoro. Precoro's planning fields stay empty by design;
  **Sentinel owns planning.** W1/W6 populate *supplier* attributes, not planning policy.
- It does not migrate history into Sentinel by database load. Everything enters through the ingestion
  pipeline, so the pipeline is proven by the act of loading.
- It does not touch banking, tax or payment identity data, which Sentinel discards at ingestion.
