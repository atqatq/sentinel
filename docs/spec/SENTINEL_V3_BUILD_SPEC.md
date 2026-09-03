# Sentinel — Master Build Specification (v3)

**Supersedes:** the SCCT-2 build prompt and all earlier Sentinel specs. Where this document and
any prior document disagree, **this one wins**.

**Status of the logic core:** the planning engine is already implemented as a pure module and
**unit-tested 117/117** (`engine.js` / `engine.test.js`). Its formulas were decoded cell-by-cell from
the Riyadh DDS and re-verified against `MATURE_-_RIYADH_SUPPLY_CHAIN_DDS.xlsx` — **byte-identical**.
Do not re-derive them. Guard them with the existing golden tests.

**Build order:** UX/UI first (§3–§5), then logic (§6–§7), then backend (§8–§11).

---

## 1. What Sentinel is

A multi-tenant supply-chain **planning, sourcing and intelligence platform** that sits *on top of*
Precoro (the system of record). Precoro records transactions; Sentinel supplies the planning brain,
the accountability layer and the analytics that Precoro structurally cannot.

**The gap, proven by the data:** Precoro exposes `Minimum Stock Level`, `Reorder To` and
`Need To Order` on every stock line — and across all **11,317** lines they are **100% empty**. There
is no safety stock, no reorder point, no EOQ, no daily usage anywhere in the transactional system.
That is precisely what Sentinel owns.

### 1.1 Locked decisions (do not revisit)
| # | Decision |
|---|---|
| 1 | Name: **Sentinel**. |
| 2 | Hierarchy: **Category → Recipe Reference → SKU**. Planning computes at **Recipe Reference**. |
| 3 | Five nodes: **PLAN · SOURCE · INVENTORY · OPERATIONS · SRM**. |
| 4 | Tenants = **Mountain Peaks (MP)**. v1: **BahrainMP, QatarMP**. Later: KMP, UMP, OMP, KSA, UK. |
| 5 | **Deliveries** are the only raw demand primitive. Source: **deliveries dashboard**. Accepted at daily, weekly, monthly, quarterly or YTD granularity and normalized to a per-day rate by `normalizeDeliveries()`. |
| 6 | **No Precoro API.** File-based ingestion only, **pull-only, never writes back**. |
| 7 | Currency: **MP local ↔ USD reserve** only. USD rate **pinned for 24h** per tenant-day. |
| 8 | **Superuser = origin = root.** One root; multiple superusers not above it. |
| 9 | Consolidated all-MP view: **superuser and above only**, gated at screen *and* data layer. |
| 10 | Intelligence view: **origin-only**, via **Anthropic API key held server-side** (never a Pro login). |
| 11 | Immutability: **hash-chained append-only ledger**, with date-state selection and date-vs-date compare. |
| 12 | Savings measured against **four baselines**: previous price, budget, benchmark, best available quote. |

---

## 2. Real data profile (observed — these are SCALE TARGETS, not seed data)

> **Sentinel ships empty. There is no seed data.** Origin instantiates settings, permissions, roles,
> accounts and tenants; **every business record arrives through ingestion** (§14.10). The figures below are
> what production data looks like — use them to size virtualization, indexes, performance budgets and
> **test fixtures**. Test fixtures are not seeds: they live in the test suite and never populate a running app.

| Entity | Reality |
|---|---|
| Items | **3,993** (3,445 active / 548 inactive). Types: Inventory 3,937 · Non-Inventory 44 · Service 8 · Shipping 4 |
| Recipe References | **1,395** — **734 have >1 SKU**, max **50** SKUs on one ref. Never assume 1:1 |
| Categories | **24** in item master; **19** in the buyer-accountability matrix |
| Suppliers | **230** (187 active). **194 = 84% have no lead time** — the flagship data gap |
| Payment terms | SOA+45 (80) · Advance 100% (39) · SOA+30 (34) · On Delivery (17) · Cash (14) · SOA+60 (13) |
| Warehouses | **26** — company, 3PL (Supplier C), consignment, staging (kitchen/dispatch shop floor), quarantine (rejected/under inspection), virtual (write-offs, inter-company), inactive |
| Stock lines | **11,317**; valuation **109,138 BHD**; BU split Core 92,893 (85%) · Retail 8,544 · Market 6,996 |
| Units | **50 raw spellings** (KG/Kg, CTN/Carton, PCS/Piece, BTL/Bottle…) → collapse to ~12 canonical families |
| SKU prefixes | FI (1,871) · PM (619) · AAF (128) · CSH (125) · NF (114) · BBS (109) … |
| Business units | Core 3,129 · Retail 440 · Lola 194 · Market 151 · On-demand 9 · B2B 1 |
| Currencies | Items: BHD 3,909 · AED 47 · SAR 30 · USD 7. Suppliers: BHD 218 |
| Deliveries | Riyadh DDS: historical total 737,750; current **12,000/day** driver |

**Category ownership is assignment-based and cross-tenant.** The seed matrix is per-tenant (columns:
BMP, UMP, KMP, Riyadh, Jeddah, Oman, Qatar, UK) — e.g. Protein Items → Owner A (BMP) / Owner B (UMP) /
Owner C (KMP) — but **Packaging – Imported** already has one owner (Owner D) spanning every tenant.
That is the general case, not an exception: **roles are becoming regional**.

Model ownership as a set of grants: `(user × category × tenant) → owner`, so **one user may own a category
in many tenants**, and any role — not just Category Owner — may hold cross-tenant grants. A user's
**accessible tenant set** is the union of their grants; the MP switcher shows exactly that set and lets them
switch context to work in another tenant. Every grant is **permissioned** (granted by a role authorised in
the permission matrix), audit-logged, and revocable. Routing (e.g. reorder-breach → category owner) resolves
against *(category, tenant)* so the right person is targeted in the right market.

---

## 3. UX/UI — design system

> **Authoritative source: `SENTINEL_DESIGN_SPEC.md` (Sentinel Design System, SDS).** It supersedes the
> summary below and the retired "Astryx" direction. The essentials are repeated here for engineers.

Dark-first, flat, tonal, dense but calm. Robustness comes from **alignment and rhythm**, not chrome.
Chroma is reserved for status, data and brand; interactive chrome is neutral.

- **Grid:** 8px base. Spacing scale 4/8/12/16/24/32. Page padding 24; card padding 16; section gap 20.
- **Tables:** header row 32px, body rows 40px, 12px cell padding. Numerics right-aligned, **JetBrains Mono,
  tabular-nums, decimals aligned**. One hairline header underline; near-invisible row separators.
- **Elevation:** flat. No drop shadows — separate with a background step (bg ↔ surface) + spacing.
- **Borders:** dividers ~8% white on dark / ~6% black on light. Cards near-borderless. Inputs **filled**
  (subtle n100); border appears on focus only (blue ring).
- **Type:** Figtree (headings 600, −0.02em; body/table 13px; eyebrows 11px uppercase +0.06em).
  JetBrains Mono for every figure, code, ID and money. Silkscreen pixel font **only** for the logo wordmark.
- **Tokens (dark):** bg `#141414` · surface `#1e1e1e` · text `#ededed` · divider `#2e2e2e` ·
  n900→n100 neutral ramp · accent `#ededed` (on-accent `#171717`).
  **Light:** bg `#f1f1f1` · surface `#ffffff` · text `#171717`.
- **Semantic:** green `#4cc38a` · red `#ff8080` · blue `#54a9ff` · orange `#ffa64d` · purple `#b48cff`
  (light: `#007004` / `#a50c25` / `#0171E3` / `#D66100` / `#6b3ecc`).
- **Currency display:** BHD 3dp · KWD 3dp · QAR 2dp · SAR 2dp · USD 2dp. Always mono, code suffix.

### 3.1 Status language (two independent axes — never merge them)
**Inventory status** (7): `OK` green · `Below Reorder` orange · `Below Safety` red · `Zero Stock` red ·
`Over Stock` blue · `Follow-up with Supplier` purple · `Inactive` neutral.
Pill = colored text on `color-mix(color 14%, transparent)` + 6px leading dot.

**Supply status** (independent, additive): `Normal` · `Follow-up with Supplier` · `Partial Delivery` ·
`Late PO` · `Supplier Issue`. Render as a **distinct outline/ghost pill** so the axes never blur — an
item can be healthy *and* have a late PO.

### 3.2 Global shell
Left rail (238px, collapsible to 64px): logo; nav grouped by the five nodes + planes; item = icon +
label + mono count badge; active = n100 fill + 3px accent bar; user chip pinned bottom.
Top bar: page title + subtitle · global search · **⌘K command palette** · **MP switcher** ·
**Local↔USD toggle** · **date/day-state control** · theme toggle · context primary action.

---

## 4. Information architecture — screens

**PLAN**
1. **Command Center** — KPI strip (inventory value vs target, DIO vs target, shortages, service level,
   deliveries today/YTD); stock-health rollup; top shortages by run-out; open work; overdue POs; data-health panel.
2. **MRP Board** — the engine board. Status chips with live counts (all 7), filters (status / category /
   warehouse / BU / **inactive** / **unapproved-nutrition** / **unapproved-production**), virtualized to
   4,000+ rows, row → member-SKU modal. Stock column shows **Available**.
3. **MRP Future** — forward view with demand buffer, shortage and order amount.
4. **Planning Profiles** — the 4 editable params (lead, safetyDays, orderFreq, MOQ) with derived
   read-only columns (→ Safety · Reorder · EOQ · Max · Cycle · Status) recomputing live.
5. **Parameter Optimization** — *dedicated page* for auto-optimization vs manual weights, **plus** an
   in-line comparison mode on Planning Profiles. Shows, per ref: `calculated | manual | override | ACTIVE`
   with the source tagged, a proposed-vs-current delta, and **accept / reject / accept-all** (proposals
   never auto-apply). Manual weight sliders for EOQ, reorder, safety, DIO.
6. **Demand & Forecast** — deliveries/day entry and history, weekly/monthly forecast, run-rate windows.

**SOURCE**
7. **Order Proposals** — engine-triggered, grouped by supplier, MOQ/order-total checks, lifecycle
   `OPEN → APPROVED → CONVERTED → DISMISSED`, → draft PR/PO, PDF export (no write-back).
8. **Purchase Orders** — open/close, receiving progress (ordered/received/waiting), promised vs actual
   (feeds lead-time observations), overdue follow-ups.
9. **Purchase Requisitions** — open/create/close/follow-up.
10. **Imports & Shipments** — regional vs international, import lead times, shipment lines,
    **landed-cost allocation** (freight/duty/clearing → per-SKU), local vs imported price comparison.
11. **Pricing** — SKU price by supplier, multi-year price-change history, average moving price per
    category and per recipe reference, **price-change approval queue**.
12. **Savings** — per SKU / category / recipe ref / tenant / YTD, against all **four baselines**.

**INVENTORY**
13. **Inventory Explorer** — 26 warehouses (company / 3PL / consignment / staging / quarantine / virtual),
    on-hand vs Available, BU split, value heat, zero-stock and dead-stock views.
14. **Warehouse Cost** — cost per warehouse and **cost per CBM** by week / month / year; occupancy.
15. **Transfers & Staging** — in-flight transfer plans + reconciliation state; movement ledger
    (receipt/issue/transfer/adjustment/return/quarantine/release) **read-only, from ingestion** —
    execution happens in Precoro (§14.7 boundary).
16. **Quarantine** — qty, reason, date, source (ingested, read-only); disposition **recommendations** with
    reason codes — the disposition itself posts in Precoro.
17. **IRA / Cycle Count** — accuracy % over time by counter, variance sessions, recount flags — measured
    from ingested data; stock corrections post in Precoro.

**OPERATIONS**
18. **Tasks** — List / Board / Calendar / My tasks; deadlines, updates, files, comments, watchers,
    subtasks, **custom fields**; auto-generated tasks (reorder breach → category owner; overdue PO → buyer).
19. **Projects & Meetings** — project grouping, meeting agendas/minutes linked to tasks.
20. **Approvals** — SKU nutrition/food-philosophy approval, production approval, price-change approval;
    **permissioned set-approved action**; approval history.
21. **Business Continuity** — plans for unavailable SKUs, substitutes, risk register.
22. **Lifecycle & Governance** — inactive/banned categories, refs, SKUs, suppliers, warehouses.

**SRM**
23. **Suppliers** — master, terms, payment-term days, lead time (with observed-value suggestion + one-click backfill).
24. **Supplier Scorecards** — OTIF, fill rate, avg/median lead days, spend ranking, single-source risk.
25. **Supplier Coverage — RETIRED as a standalone screen (Amendment A15).** Its duties fold into existing
    screens: suppliers by recipe reference → the per-ref **member SKU table** (`PREFERRED` / `ALTERNATE` /
    `SPOT` roles, screen 24's evidence surface); quotes → best-available baseline → **Preferred SKU**
    selection with pin rationale. Screen IDs are stable identifiers — 25 is retired, never renumbered.
    KPI SRC-05 now sources from the Supplier Scorecards single-source tile (§16, A15.2).

**PLANES**
26. **Analytics** — analysis and tenant×tenant comparison at SKU / recipe-ref / category / price / spend /
    savings / top-consumption; COGS monthly-quarterly-yearly; targets (COGS, Capex, Opex, DIO).
27. **Intelligence** *(origin-only)* — Claude-generated versioned `.md` per MP + consolidated; reader pane;
    "generate follow-up tasks (needs approval)". Unobtrusive entry; does not advertise itself.
28. **Data Upload** — drop zone + watched-folder/email-in states; pipeline stepper (detect → strip tips →
    normalize → validate → upsert → recompute → snapshot → tasks); import history; validation/quarantine state.
29. **Users & Permissions** — user CRUD, roles, and the **permission matrix grid** (§10).
30. **Audit & Time Machine** — action + transaction logs; **select any date to view system state**;
    **compare two dates** side-by-side with a diff; chain-integrity indicator.
31. **Item Master / Item 360** — SKU console, raw→canonical unit, price history, per-item engine preview.
32. **Reference & Settings** — unit catalog + alias coverage, categories, GL, FX, custom-field registry,
    Slack integration, notification rules, i18n (EN default, AR-ready RTL).
33. **Module Management** *(Origin-only)* — the plugin registry: every module with state
    `REGISTERED · ENABLED · PAUSED · DISABLED · FAULTED`, health/last-fault, pinned version, dependency
    map, add / enable / pause / upgrade / disable / remove flow, per-module ledger history (§14.15). The
    architectural control surface for the modular platform.
34. **Tenant KPI Dashboard** — per-tenant, grant-scoped. Seven KPI groups (Sourcing · Inventory ·
    Data Health · Team Productivity · Project Milestones · Food Philosophy & Production Adherence ·
    Inventory Value charts); every KPI card shows value, delta vs target band, sparkline, owner
    role, source dataset and a **freshness stamp** from the last sealed ingest feeding it; tenant
    scope switcher limited to the viewer's grants; warehouse-level inventory-value charts exclude
    quarantine/staging from the Available overlay (§14.2); each card drills into its underlying
    screen; CSV/PDF export. Catalog, formulas, owners and cadence are defined in §16 and rendered
    by the `kpi-catalog` module; review cadence is W-16 in the Atlas. Refresh: post-seal daily
    plus on every recompute; a KPI without fresh sealed data renders an explicit *stale* state —
    it never guesses.

---

## 5. Key interactions (must be demonstrable)
1. Edit a planning param → the row's Safety/Reorder/EOQ/Max/Cycle/Status recompute **instantly**
   (optimistic), and the change is audit-logged with its provenance source.
2. Set a supplier lead time → all its items flip out of the no-lead-time state.
3. Drop a Precoro export → kind auto-detected, tip rows stripped, units normalized, idempotent upsert,
   engine recomputed, day snapshot written, auto-tasks fired, import logged.
4. Reorder-point breach → task auto-assigned to the **category owner for that tenant**.
5. Approve a proposal → draft PO grouped by supplier with MOQ check → PDF export.
6. Select a past date → the whole system renders as of that date; pick a second date → diff view.
7. Toggle Local↔USD → all money re-renders at the **pinned** rate for that day.
8. A BYR outside their category is blocked by RBAC; the attempt is logged.

---

## 6. Engine — canonical logic (verified; do not re-derive)

Constants `WD=22`, `WK=4` (configurable). All per Recipe Reference, per tenant.

```
consumptionUnit      = start + goodsIn − end − goodsOut
consumptionConverted = consumptionUnit × conversionFactor
consPerDelivery      = consumptionConverted ÷ histTotalDeliveries     ← the stable RATE
magnifiedMonthly (L) = Σ member consPerDelivery × deliveriesPerDay × 22
dailyConsumption (J) = L ÷ 22        weeklyUsage (K) = L ÷ 4
histDaily            = histMonthly ÷ 22        ← run-out uses HISTORICAL rate, not J

available            = onHand − quarantine − reserved − damaged      ← planning stock
safetyStock   (R)    = safetyDays × J
reorderLevel  (S)    = (leadTime + safetyDays) × J
eoq           (T)    = max(MOQ, orderFreq × J)
maxStock      (U)    = T + R
cycleStock    (V)    = R + T/2
runOut               = available ÷ histDaily            (null ⇒ "NC")
reorderPct           = available ÷ reorderLevel         (null ⇒ "NC")
unitValue            = invValue ÷ onHand                ← valuation on ON-HAND
targetInvValue (X)   = unitValue × cycleStock
maxInvValue    (Y)   = unitValue × maxStock
orderQty       (Z)   = max(MOQ, available < S ? T + (S − available) : T)
orderProposal        = available < S ? orderQty : 0
```

**Status ladder** (first match wins, evaluated on **available**):
`available > U×1.2 → Over Stock` · `reorderPct = NC → OK (display Inactive)` · `available = 0 → Zero Stock` ·
`available < R → Below Safety` · `openPO > 0 → Follow-up with Supplier` · `reorderPct < 101% → Below Reorder` ·
`available > U + 20% → Over Stock` · else `OK`.

**Ladder edges (workbook heritage — documented, never silently fixed; §14.19):** branch 7
(`available > U + 20%`) is algebraically identical to branch 1 (`available > U×1.2`) and unreachable —
kept for golden compatibility with the workbook, never edited or deleted; a display/trigger band exists
at `1.0 ≤ reorderPct < 1.01` where the status reads `Below Reorder` while the order trigger
`orderRecQty` is 0 — `orderRecQty` is the trigger of record and raises no proposal from the band; a
negative `available` is an impossible state the workbook classifies `Below Safety` — red, never silent,
and additionally detected. `computeRef` returns a `warnings` array (`LADDER_DEAD_BRANCH_7`,
`REORDER_DISPLAY_TRIGGER_BAND`, `NEGATIVE_AVAILABLE`) observing these edges beside the ladder; the
ladder itself is untouched.

**Data state (audit A1 — critical):** `reorderPct` is null both when consumption is zero *and* when planning
parameters are absent. Since Precoro's planning fields are 100% empty, without a discriminator every active
ref would read `Inactive` on go-live. The engine therefore returns
`dataState ∈ {OK, NO_USAGE, NO_PARAMS, NO_LEAD_TIME}`.

**Display rule:** `displayStatus(c)` → `NO_USAGE → 'Inactive'` · `NO_PARAMS → 'Not Planned'` ·
`NO_LEAD_TIME → 'No Lead Time'` · else the ladder status. **Bind every screen to `displayStatus`, never to
raw `status`.** The raw ladder stays byte-compatible with the workbook.

**Portfolio KPIs:** `dailyCOGS = cogsPct × avgRevPerDelivery × deliveriesPerDay` ·
`targetInvValue = targetDIO × dailyCOGS` (×0.79 without staging) · `actualDIO = invValue ÷ dailyCOGS` ·
`serviceLevel = 1 − shortages ÷ activeRefs`.

**Parameter provenance:** `resolveParam({manual, calculated, override}) → {value, source}` —
override ▸ calculated ▸ manual. Auto-optimization writes `calculated`; manual weight writes `override`.

---

## 7. New logic to build (each needs its own unit tests)

**Landed cost.** Allocate shipment charges (freight, duty, clearing, insurance) across shipment lines by a
configurable basis (value / weight / volume / qty) → `landedUnitCost = unitPrice + allocatedCharges ÷ qty`.
Feeds valuation, local-vs-imported comparison, savings and COGS. Local deliveries use the same model with
zero or local-freight charges.

**Savings.** Compute per SKU per event against all four baselines; store each separately, never blended:
`previousPrice` (last price on record) · `budget` (planned price for the period) · `benchmark` (category/
market reference) · `bestQuote` (best available supplier quote). `saving = (baseline − actualPrice) × qty`.
Roll up to recipe ref, category, tenant, YTD.

**Average moving price.** Weighted moving average per SKU, rolled to recipe ref and category:
`AMP = Σ(qty × price) ÷ Σ qty` over the window; recomputed on each receipt.

**Working capital.** `DIO = inventoryValue ÷ dailyCOGS` · `DPO = Σ(payable × termDays) ÷ Σ payable`
from supplier payment terms.

**Warehouse cost / CBM.** `costPerCBM = periodCost ÷ occupiedCBM` for week / month / year; allocate to
category and recipe ref by stored volume.

**Auto-optimization.** Given trailing consumption, variability, lead-time observations and service-level
target, propose `safetyDays`, `orderFreq`, `MOQ`, `targetDIO`. Writes `calculated` only — **never applies
directly**; surfaces as a proposal with delta and rationale for accept/reject. Manual weights bias the
objective (cost vs service vs DIO).

**Lead-time observation.** `deltaDays = actualReceipt − promisedDelivery` per PO line → per-supplier
avg/median/std → suggested backfill for the 194 blank lead times (one-click apply, audit-logged).

---

## 8. Backend architecture

**Stack:** TypeScript strict end-to-end. Next.js (App Router) or React+Vite + Fastify/NestJS; **PostgreSQL**;
Prisma or Drizzle; Zod at every boundary; TanStack Query + Table (virtualized) + **TanStack Charts** for all visualisation;
Redis + BullMQ for jobs.

> **Charting note (verified Aug 2026):** the legacy `TanStack/react-charts` repo was **archived 13 May 2026**
> and is unmaintained — do not use it. Use **`@tanstack/charts`** with `@tanstack/charts/react`. It is on the
> **alpha line** (latest published 0.16.0) and may ship breaking changes between minor versions, so **pin an
> exact version** and wrap every chart in a local `<Chart*>` adapter component so the dependency can be
> swapped without touching screens. Recharts/ECharts are acceptable fallbacks if alpha churn blocks a release —
> record the choice in `DECISIONS.md`.
Monorepo: `apps/web` · `packages/core` (pure engine — no DB/React imports) · `packages/db` · `packages/integrations`.

**Why PostgreSQL:** Row-Level Security for tenant isolation and the origin/superuser bypass enforced at the
*database* layer; `NUMERIC` for all money/quantities (never float); materialized views + window functions for
MRP aggregation at 4,000+ refs; JSONB for custom fields, permission matrix and day-state payloads;
partitioning for the multi-decade snapshot and ledger chain; `pgcrypto` for hashing and secret encryption.

**Module container (rev 1.2 directive — full rules in `SENTINEL_V1_DELIVERY_SPEC.md` §1A):** Sentinel is a
**module container with a protected core**, fully modular and plugin-like. The core = ledger, RBAC/RLS,
ingestion boundary, module registry, audit. Everything else is a **module** with a manifest
(`sentinel.module.json`): id, version, dependencies, permission scopes, ingestion kinds, UI surface points,
ledger event types. Modules: Master Data · Replenishment Engine · Demand · Supplier Intelligence ·
Exception & Accountability · Integration Gateway · Analytics · Intelligence (Claude) · Ledger & Audit (core).

**Isolation guarantees (each acceptance-tested, amendment A13):**

- **Crash isolation** — per-module BullMQ queues, watchdogs and UI error boundaries: a broken, hanging or
  OOM-killed module degrades only its own surfaces; every other module, the shell and the ledger keep serving.
- **Circuit breakers + health probes** — repeated failure opens the module's circuit (`MODULE_UNAVAILABLE`),
  raises a `MODULE_FAULT` ledger event and a red card on Data Health; recovery on green probes.
- **Origin-only runtime control** — screen 33 lists every module with state `REGISTERED · ENABLED ·
  PAUSED · DISABLED · FAULTED`; add / enable / pause / upgrade / disable / remove are ledgered
  (`MODULE_ENABLED` / `MODULE_DISABLED` / `MODULE_PAUSED` / `MODULE_RESUMED` / `MODULE_UPGRADED` /
  `MODULE_REMOVED`); disabled modules are **cold** (no routes, no jobs) and dependents degrade
  **visibly**, never silently. Paused modules are **quiesced** — in-flight jobs drain, the queue is held,
  state is kept — built for maintenance windows and as the staging step of every upgrade.
- **Adding functionality = registering a module** — in-repo `modules/` packages for V1; external plugin
  loading stays out of scope for the closed ecosystem. Core must boot and pass the security baseline with
  every optional module removed.
- **Upgrades are staged, gated and reversible** — compatibility check (manifest semver + dependency
  versions) → auto-pause → artifact swap → module golden smoke + contract tests → resume on the new
  version; any red gate rolls back automatically to the pinned previous version. One module upgrades
  independently; siblings never redeploy. (Acceptance: `modules/upgrade-stages-and-rolls-back`.)
- **LLM-authored module changes are untrusted contributor diffs** — every LLM-coded upgrade/change passes
  the same gates as any human change (typecheck, golden suite, import-boundary grep, purity), carries a
  named human reviewer plus Origin promotion approval, and records provenance (model, artifact hash,
  reviewer) as a ledger block. No direct-to-production hot patch exists. (Acceptance:
  `modules/llm-authored-diff-gated`.)

**Jobs:** nightly rate refresh, forecast run, scorecard rollup, exception digest, snapshot sealing,
FX pin (24h), Slack dispatch. Idempotent, logged, retry-safe.

---

## 9. Data model — core entities

`Tenant(MP)` · `Category` · `OwnershipGrant(user × category × tenant, grantedBy, grantedAt, revokedAt)` —
cross-tenant, many per user; a user's accessible tenant set is the union of their grants · `RecipeRef` ·
`Item(SKU)` · `UnitCatalog(canonical, aliases[], factor)` · `Supplier` · `SupplierTerms(paymentTermDays)` ·
`Warehouse(kind: COMPANY|3PL|CONSIGNMENT|STAGING|QUARANTINE|VIRTUAL|INACTIVE, cbmCapacity, periodCost)` ·
`StockLine(item × warehouse)` · `InventoryMovement` · `PurchaseRequisition` · `PurchaseOrder/POLine` ·
`Shipment/ShipmentCharge` (landed cost) · `PriceHistory(sku, supplier, price, effectiveFrom)` ·
`PriceChangeRequest(approvalChain)` · `Quote` · `PlanningParam(manual, calculated, override, source)` ·
`ParameterProposal` · `DeliveryDay(tenant, date, deliveriesPerDay)` · `ConsumptionRate(sku, consPerDelivery)` ·
`OrderProposal(lifecycle)` · `Task(+customFields, files, comments, watchers)` · `Project` · `Meeting` ·
`Approval(type: NUTRITION|PRODUCTION|PRICE_CHANGE, state, approver)` · `ContinuityPlan` ·
`LeadTimeObservation` · `SupplierScorecard` · `Target(cogs, capex, opex, dio)` · `FxRate(pinned24h)` ·
`CustomFieldDef(entity, key, type)` · `User` · `Role` · `Permission(role × resource × action × tenantScope)` · `OriginOverride(action, reason, at)` · `AuditEvent` · `LedgerBlock` ·
`DayState(tenant, date, payloadHash)` · `ImportLog` · `IntelligenceDoc(md, version, tenant)`.

**Approval flags on Item:** `nutritionApproved`, `productionApproved`, `bannedFlag`, `inactiveFlag` — all
filterable on the MRP Board and Item Master; setting them is a **permissioned action**, audit-logged.

---

## 10. Roles & permission table

Roles (stable short codes — canonical in the matrix, the ledger `role` field and UI pills; full names
remain display names): **O** (Origin/Root = superuser) · **SCM** (Supply Chain Manager) · **SBR** (Senior /
Strategic Buyer) · **BYR** (Buyer) · **DTA** (Analyst) · **VWR** (Viewer). The former Supply Chain Director
was removed as a duplicate of the Manager — its capability column was identical in every row.

The permission table is **data, not code** — a grid editable by superuser:
`(role × resource × action × tenantScope) → allow`, where `action ∈ {create, read, update, delete, upload,
download, approve}` and resource = each screen/entity. BYRs are additionally **category-scoped**.

| Capability | O | SCM | SBR | BYR | DTA | VWR |
|---|---|---|---|---|---|---|
| Consolidated all-MP view | ✅ | — | — | — | — | — |
| Intelligence view | ✅ | — | — | — | — | — |
| Create users / edit permissions | ✅ | — | — | — | — | — |
| Purge / restore system | ✅ | — | — | — | — | — |
| Edit planning params | ✅ | ✅ | ✅ | scoped | — | — |
| Approve proposals / POs | ✅ | ✅ | ✅ | — | — | — |
| Set SKU approved (nutrition/production) | ✅ | ✅ | — | — | — | — |
| Approve price change | ✅ | ✅ | — | — | — | — |
| Upload data | ✅ | ✅ | ✅ | ✅ | — | — |
| Download / export | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Read dashboards & analytics | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Defaults only — every cell is editable in the matrix. Roles are **regional**: a user's tenant access is the
union of their `(user × category × tenant)` grants (§2), and the MP switcher exposes exactly that set.

### 10.1 Origin (root) — supreme, visible authority
Origin is **not concealed**. It appears as an identified principal and holds **supreme authority: it sits
above the permission matrix and can override any rule, permission or grant**, in any tenant. It can create
or revoke grants, rewrite any permission cell, and purge or restore the system. Supremacy does **not** mean
invisibility — every origin action writes a ledger block like any other actor (§11), which is what keeps
unlimited power accountable.

**Credential handling (build requirement — do not shortcut):**
- Origin username/password are **configuration, never code** — injected via environment variables or a
  secret manager (e.g. `SENTINEL_ORIGIN_USER`, `SENTINEL_ORIGIN_PASSWORD_HASH`). **No credential literal may
  appear in source, spec, seed data, fixtures, logs, or the repository.**
- Persist only an **Argon2id** hash (or bcrypt cost ≥ 12). Never plaintext, never reversible encryption.
- Because origin overrides everything, require a **second factor** (TOTP or FIDO2/WebAuthn passkey) and
  **re-authentication for destructive actions** (purge, restore, permission rewrite, mass override).
- Rate-limit and lock out failed origin logins; alert on every origin sign-in; support rotation without redeploy.
- Bootstrap via a **one-time setup flow** that forces a password change and enrols the second factor.
- **Treat any origin password transmitted over chat, email or ticketing as compromised and rotate it before
  go-live.**
*(Honest boundary: concealment holds against in-app users, not against direct database/infrastructure access.)*

---

## 11. Immutability — hash-chained ledger & time machine

Every action and transaction appends a `LedgerBlock`:
`{ seq, tenantId, actor, entity, entityId, action, diffJson, at, prevHash, hash }` where
`hash = SHA256(seq ‖ prevHash ‖ canonicalJson(payload))`. Any alteration breaks the chain and is
**detectable even by origin** — this is the property that makes the audit trustworthy.

- **Daily seal:** at day close, a `DayState` snapshot per tenant stores the full computed state + payload hash,
  and a Merkle root over the day's blocks is anchored (and replicated to WORM/off-site storage).
- **Time machine:** pick any date → system renders that sealed state. Pick a second date → **side-by-side
  diff** (stock, status changes, params, prices, tasks, value) with a chain-integrity indicator.
- Retention: decades, partitioned by tenant + date; verification job re-walks the chain nightly.

---

## 12. Definition of done
1. Clean checkout runs with one command (migrate + dev) and comes up **empty** into the Origin bootstrap
   (§14.10) — **no seed data**. Screens show first-run empty states; zero console errors. Performance is
   proven against §2 scale using **test fixtures**, not a populated database.
2. Golden engine tests pass — byte-compatible with §6; new-logic modules (§7) each unit-tested.
3. Param edit recalculates instantly and is audit-logged with provenance; optimizer proposals never auto-apply.
4. Precoro export imports idempotently with kind detection, column allow-list (banking fields provably
   discarded), unit normalization and import log; a full first-ingestion brings an empty system to life.
5. Proposal → approval → draft PO → PDF completes; no write-back path exists anywhere in the codebase.
5b. **The loop closes:** a task closed with a PO number reconciles on the next import; adherence, realized
   lead time and realized savings appear; the in-transit guard provably suppresses a duplicate proposal;
   an observed lead time reaches the supplier as a `calculated` suggestion awaiting acceptance.
6. RBAC blocks out-of-scope access; permission matrix editable; origin gating verified on Consolidated + Intelligence.
7. Ledger chain verifies; date-state view and date-vs-date diff work across a seeded multi-month history.
8. MRP board p95 < 500 ms at 4,000+ refs; a11y ≥ 90 on Command Center; AR-ready RTL structure.
9. README + `DECISIONS.md` + OpenAPI spec delivered.
10. **Module isolation proven** (§8 container directive / A13): kill-test, circuit-breaker and
    disable-cold suites green; core security baseline passes with all optional modules removed; screen 33
    add / enable / pause / upgrade / disable / remove flows fully ledger-audited, including the automatic
    rollback proof (`modules/upgrade-stages-and-rolls-back`).

---

## 13. Development method — TDD is mandatory

All development is **test-driven**. The engine already demonstrates the standard: pure functions, decoded
from the source of truth, covered by 117 passing tests before any UI touched them. Every module follows it.

**The cycle, per unit of behaviour:** write a failing test that encodes the requirement → implement the
minimum to pass → refactor with tests green → commit. **No production code without a test that failed first.**

**Coverage obligations**
- `packages/core` (engine + new logic in §7): **golden tests** for every formula and every status branch;
  boundary cases at each threshold (`×1.2`, `<101%`, zero/NC); property tests for scaling behaviour
  (e.g. doubling deliveries/day doubles derived levels while run-out, being historical, does not move).
- **Landed cost, savings (all four baselines), AMP, DIO/DPO, warehouse cost-per-CBM, optimizer, lead-time
  observation** — each gets its own suite; none may ship untested.
- **Permissions**: a test per matrix cell class, including cross-tenant grants, category-scoped buyers, and
  origin override (asserting the override is *recorded*, not just permitted).
- **Ledger**: chain verification, tamper detection (mutate a block → verification fails), day-seal, and
  date-vs-date diff.
- **Ingestion**: fixture-driven — real Precoro export shapes, tip-row stripping, 50→12 unit normalization,
  idempotent re-import (importing twice changes nothing), unmapped-SKU reporting.
- **Integration/E2E** (Playwright): upload → recompute → status change → auto-task → proposal → approval →
  draft PO → PDF; param edit → instant recompute + audit entry; RBAC denial; time-machine diff.

**Rules**
1. Tests are the specification of record for behaviour; where a test and prose disagree, fix one deliberately.
2. Engine stays pure and framework-free — no DB or React imports in `packages/core`.
3. CI runs lint, typecheck, unit, integration, e2e and a fresh-seed check; red build blocks merge.
4. Regression tests are added for every bug before the fix.
5. Report coverage per module; core domain logic is held to a high bar (target ≥ 90%).

---

# 14. Resolutions — gap decisions (authoritative; supersedes anything above)

## 14.1 Which SKU gets ordered (Recipe Ref → PO line)
Planning stays at Recipe Ref; ordering resolves to exactly one SKU by
`resolveOrderingSku(members, {preferredSku})`, in this order:
1. **Pinned `preferredSku`** — set by the category owner (mirrors what the team does today: pick the SKU
   normally bought from the usual supplier). Wins always.
2. **Purchase-weight winner** — highest `purchasedQty × (1 + purchaseCount)` over the trailing window,
   **active SKUs only**. This reproduces "the one we always order" without anyone configuring it.
3. **Most recently purchased** active SKU.
4. **Unresolved** → the proposal still shows the quantity but is **not approvable**, and a data-health item
   is raised ("preferred SKU required"). Never guess.

Supplier follows the chosen SKU's primary supplier by the same evidence; the proposal shows alternates so a
buyer can switch, and switching records a reason. Cutover W3 pre-populates pins for all 734 multi-SKU refs.
*Implemented + tested.*

## 14.2 Warehouse grain
**Aggregate.** Planning sums availability across all locations of a tenant; distribution between warehouses
is handled separately by Transfers (§14.7). Quarantine/staging/virtual locations are excluded from available
via warehouse `kind` (cutover W5), so aggregation never counts stock that cannot be used.

## 14.3 Shelf life (fresh-food guard)
`Shelf Life Days` per SKU (category default, ref/SKU override). Order quantity is capped at
`shelfLifeDays × dailyConsumption`. **MOQ still wins** — where MOQ exceeds the cap, sizing cannot fix it, so
the engine sets `moqExceedsShelfLife` and the proposal is flagged for renegotiation or split delivery rather
than silently over-ordering. Non-perishables (`shelfLifeDays = 0/absent`) are uncapped. *Implemented + tested.*

## 14.4 Rate invalidation
Unchanged for v1 by decision. `consPerDelivery` is refreshed only on re-ingestion of consumption history.
**v2:** recipe-change invalidation and predicted-vs-actual drift detection.

## 14.4b Deliveries input — granularity
Source is **deliveries dashboard**. Any granularity is accepted and normalized on the **same basis the
magnification uses** (`WD = 22`), so the conversion cancels exactly: monthly input `M` gives
`DPD = M/22`, and `magnifiedMonthly = rate × DPD × 22 = rate × M`. Divisors: daily 1 · weekly 5.5 ·
monthly 22 · quarterly 66 · YTD `22 × monthsElapsed`. The 22 is a convention, not a calendar claim —
exactness comes from using the identical basis on both sides. Coarser input lowers the recorded
`confidence` (daily high · weekly medium · monthly+ low) because it smooths away day-to-day signal;
invalid or negative input is **rejected, never silently zeroed into a plan**. *Implemented + tested.*

## 14.5 TSRC / seasonality overlay
*(Read as Trend · Seasonality · Random · Cyclical time-series decomposition.)* Applied **only** as a
multiplier on projected deliveries per day — the primitive — never on the formulas:
`effectiveDPD = baseDPD × trend × seasonal × cyclical` (residual is never applied to a plan).
All factors default to **1.0**, so an unconfigured system is byte-identical to the verified baseline; this is
the property that makes the overlay safe. A `DemandProfile` holds calendar windows (Ramadan, Eid, summer,
school terms) per tenant with a factor and a rationale; the MRP board shows which factor is active and what
the flat-baseline number would have been. *Implemented + tested.*

## 14.6 Closing the loop — the execution feedback subsystem
*(Implemented as `feedback.js`, 24 unit tests passing. This is not a report; it is the mechanism by which
Sentinel learns. Open-loop, the platform advises forever and never discovers it was wrong.)*

**Chain of record:**
`PROPOSAL (engine) → DECISION (buyer + reason code) → COMMITMENT (PO) → EXECUTION (GRN) → RECONCILIATION → SIGNALS`

**Capture.** A proposal task closes with **structured fields — PO number, supplier, SKU, ordered qty, unit
price, expected date** — plus PO/GRN PDFs as evidence. PDFs are audit; the PO number is what makes
reconciliation possible. **Any deviation in qty, SKU or supplier requires a reason code** from a controlled
list (`PRICE_TOO_HIGH · SUPPLIER_MOQ · SHELF_LIFE · CASH_CONSTRAINT · BULK_OPPORTUNITY ·
SUPPLIER_UNAVAILABLE · FORECAST_DISAGREE · ORDER_CONSOLIDATION · STOCK_ON_WAY · QUALITY_HOLD · OTHER`).
An unexplained deviation teaches nothing, so it is flagged `DEVIATION_UNEXPLAINED` and counts against
data health, not against the buyer.

**Reconciliation** (`reconcileProposal`) classifies every proposal as
`FOLLOWED · MODIFIED · SUBSTITUTED · IGNORED`, and derives `adherenceQty`, `fillRate`, `realizedLeadDays`,
`lateByDays`, `priceVariance`, with flags `SKU_SUBSTITUTED · SUPPLIER_CHANGED · SHORT_DELIVERED · LATE ·
PRICE_ABOVE_EXPECTED`. A PO with **no** matching proposal is `UNSOLICITED` — buying with no signal, which
exposes where the engine is blind.

### What each node actually receives (this is the point)

| Node | Signal | Effect |
|---|---|---|
| **PLAN** | `realizedLeadDays` → `leadTimeEstimate()` | **Closes the 84%-missing-lead-time gap from observed reality** instead of asking 230 suppliers to fill a form. Default basis **p80, not median** — planning on the median stocks out half the time. Returns `n`/`confidence`; **never invents a lead time from no data**. Suggestion is applied via the parameter-provenance `calculated` slot, so a human still accepts it. |
| **PLAN** | `parameterEfficacy()` | The optimizer's **training signal**: stockouts *after advice was followed* ⇒ raise safety days; persistent overstock ⇒ lower safety/order frequency. Crucially it **only judges FOLLOWED cases** — a stockout after the buyer ignored us is not a parameter failure. |
| **PLAN** | `proposalQuality()` | Precision *and* **recall**: shortages that occurred with **no proposal ever raised** (`missedShortages`) are the dangerous class and are invisible to an adherence-only view. |
| **SOURCE** | `realizedSaving()` | Savings count **only on receipt at the actual price**, per baseline, never blended. A missing baseline stays `null` rather than silently becoming zero. Kills the "claimed savings" problem. |
| **SOURCE** | `priceVariance`, reason-code mix | Price drift vs expectation; `SUPPLIER_MOQ` frequency exposes MOQ friction; `ORDER_CONSOLIDATION` reveals batching behaviour to design around. |
| **INVENTORY** | `inTransitPosition()` | **The double-order guard.** Committed-but-undelivered quantity suppresses a repeat proposal — otherwise every daily run re-orders the same shortage until the truck arrives. Over-receipt can never produce a negative open position. |
| **INVENTORY** | GRN posting | Receipt writes an inventory movement, updates on-hand and available, and closes the PO line — the physical loop, not just the paper one. |
| **OPERATIONS** | proposal age, `NO_COMMITMENT` | Ageing proposals escalate up the org tree; unexplained deviations and unclosed tasks surface on the Data Health board. |
| **SRM** | `supplierScorecard()` | OTIF requires **both** on-time and in-full (not the average of the two), plus fill rate, average lateness, price adherence, quarantine rate, and a per-supplier lead-time estimate. This scorecard then feeds **preferred-supplier selection** for the ordering SKU — the loop's second turn. |
| **ANALYTICS** | adherence + realized savings | BYR scorecard (§14.13) is judged on *realized* outcomes, not claimed ones. |
| **INTELLIGENCE** | divergence patterns | Claude analyses *why* advice is refused — systematic `FORECAST_DISAGREE` in one category is a model problem, not a compliance problem. |

**Non-negotiable:** reconciliation is **evidence-based, not self-reported**. Adherence is computed from the
imported PO/GRN facts, never from a checkbox someone ticks.

### 14.6b Receipt→PO-line matching — the normative rules (audit M6; gate 16; named proof `feedback/matching`)

*(§14.6 classifies a proposal once a commitment and its receipts are KNOWN. This section is the contract for
how receipts become known — the matching rules the audit found "delegated to nobody" [M6]. Until these rules
are normative, DoD 5b "the loop closes" is not verifiable. The implementation is the pure matching layer in
the execution-feedback module; `reconcileProposal` remains the per-line leaf it consumes.)*

**Line identity and keys.** A PO line is identified by `(poNumber, sku)` — the same business identity the
ingestion layer keys (`open_pos`) and the schema uniques (`open_po_line`). A proposal links to its PO lines
through the **closed task's PO number(s)** (§14.6 Capture: "the PO number is what makes reconciliation
possible"): a proposal carries the poNumber set it was ordered against. Receipts and returns are **events**
per line — `(poNumber, sku, type: receipt|return, qty, at, unitPrice?)` — split GRNs are several receipt
events for one line. The matching layer receives facts; it never invents them.

**Tolerance.** The §14.6 bands stand: proposal adherence (Σ ordered ÷ proposed) is FOLLOWED within
**0.95–1.05**. At the PO line, receipts beyond **ordered + 5%** are flagged `OVER_RECEIVED` — the excess is
a fact to investigate, never silently absorbed; the in-transit position still clamps at zero (over-receipt
can never produce a negative open position).

**Cancellation.** A PO line whose status is `CANCELLED` (the "Purchase Order Status" surface) leaves the
loop: its outcome is `CANCELLED`, its lateness is void (`lateByDays` null — a cancelled promise is not a
late one), and it is **excluded from adherence denominators and scorecard due-lines** (H2's rule: only DUE
lines count — a cancelled line is not due). The in-transit guard **releases** a cancelled line's open
quantity: the truck is not coming, and suppressing the re-order on a cancelled PO is the double-order guard
failing in the opposite direction. Receipts observed after cancellation are flagged
`RECEIPTS_AFTER_CANCEL` — an anomaly to investigate, reported, never hidden.

**Amendment.** An amendment fact is `{poNumber, sku, field, from, to, amendedAt, reasonCode?}`. Only the
ordered quantity is amendable in this contract (`field: 'ordered'`); the **latest** `amendedAt` wins; fill
rate, in-transit and the in-transit guard compute against the **amended** ordered quantity, and proposal
adherence is judged on it too — the proposal was still the signal. The deviation discipline extends to
amendments: a missing `reasonCode` is flagged `AMENDMENT_UNEXPLAINED` and counts against data health, not
against the buyer; the line carries `AMENDED`. Amendments referencing an unknown line are a wiring error
and refuse by name.

**Returns / credits.** A return event reduces received quantity: fill rate recomputes honestly (a fully
returned line is `SHORT_DELIVERED` with `GOODS_RETURNED`), and the in-transit clamp keeps every position
≥ 0. Returns are facts about the supplier and the goods, disclosed on the line — never averaged away.

**Split and merge.** One proposal answered by several PO lines is a **split**: the aggregate reconciles the
Σ of the lines' (amended) ordered quantities against the proposal, flags `SPLIT_ACROSS_POS`, and reports
per-line evidence. One PO line answering several proposals (an `ORDER_CONSOLIDATION` merge) is allocated
**deterministically — FIFO by proposal `raisedAt`** (ties by refId for reproducibility), with the
allocation itself disclosed in the result; a silently averaged merge would poison every downstream score.
A PO line answering **no** known proposal is reported `unlinked` — the §14.6 `UNSOLICITED` surface.

**Honesty rules.** When the export carries no unit price (the known Open-POs gap), price variance is
**null**, never a fabricated zero-variance. A `waiting` quantity that disagrees with the export's own
arithmetic — `ordered − received` (gross: returns are credit facts outside the Open-POs export) — beyond
rounding is flagged `WAITING_INCONSISTENT` — disclosed, not corrected. The in-transit position rides gross
receipts too (what is still expected to arrive); fill rate rides **net** of returns (what the tenant
actually kept). Identical inputs produce identical output; every malformed shape (unknown event type,
non-finite quantity, unknown status value, unsupported amendment field) refuses with a named error. **The
aggregate feeds the §14.6 shape unchanged** — outcomes, adherence, fill rate, lateness, price variance,
flags — so every downstream node (scorecards, efficacy, the double-order guard) consumes matching output
exactly as it consumed reconciliation output, with the new flags additive.

### 14.6c Supply-status producers — the normative derivation (audit M5; named proof `ingestion/supply-status-producers`)

*(§14.6b closed how receipts become known; this section closes what the supply axis may render. The audit's
M5: `supplyStatus` consumed fields — `overduePO`, `partialPO`, `supplierIssue` — that no export defined and
no code derived, and the axis would render from nothing while claiming to render from facts. Until these
producers are normative, the second ontology axis is under-specified data wearing a vocabulary. The
implementation is the pure producer in the planning-engine module, beside the classifier it feeds;
`supplyStatus` itself is unchanged — this section defines only what may enter it.)*

**The facts.** Per ref, per plan cycle, the supply facts are `{openPO, overduePO, partialPO, supplierIssue}`,
derived from the tenant's stored Open-POs lines against an **explicit `asOf`** — the plan run's canonical UTC
date (H4). There is no clock in the producer: identical inputs produce identical output, and a run without
`asOf` refuses by name. Line inputs are the §14.6b identities `(poNumber, sku)` carrying: `waiting` in
**planning units** (C1 converted at ingestion — the producer refuses a non-finite waiting as the wiring error
it is), `received` (absent = 0), `expectedDelivery` (the promised date, canonical day form), `status` (the
Purchase Order Status surface, below), and `supplierBanned` (joined from supplier master `is_banned` — the
producer consumes the flag, it never queries).

**Liveness — cancelled and closed lines leave the loop.** A line is **live** iff its status is `OPEN` or
absent. `CANCELLED` and `CLOSED` lines contribute nothing to any supply sum — the §14.6b rationale applies
verbatim: the truck is not coming, and counting a dead commitment as expected stock is the double-order guard
failing in the opposite direction, now on the status axis (a ref whose POs were all cancelled must not wear
"Follow-up with Supplier"). A dead line still carrying waiting > 0 means the export disagrees with the PO
lifecycle — it is disclosed (`WAITING_ON_CANCELLED` / `WAITING_ON_CLOSED` classes, counts + quantities),
never silently absorbed.

**The rules.** `openPO` = Σ waiting over **live** lines, in the order given (the caller's deterministic
ordering; the same sum the engine consumes as its in-transit input — one canon, no forked aggregate).
`overduePO` = Σ live waiting where a promised date exists and `expectedDelivery < asOf` (canonical day-string
comparison — no timezone arithmetic; both operands are H4 canonical dates). `partialPO` = Σ live waiting
where `received > 0` (the truck came, not in full). `supplierIssue` = true iff any live line's supplier is
banned — a barred source with open commitments is a supplier issue by definition; returns and lateness are
normal business and must never synthesize this flag. A live line with waiting > 0 and **no** promised date
can never be late against no promise: it counts in `openPO` (and `partialPO`), never in `overduePO`, and is
disclosed (`UNPROMISED_WAITING`) — follow-up without a promise date is blind, and data health should say so.

**The export obligation.** The Open-POs export gains `Purchase Order Status` — **priority-1 ADD** (the audit
itself cites the source report carrying it; template column provided, cutover W1). Ingestion normalizes the
value to the closed vocabulary **`OPEN | CANCELLED | CLOSED`** (trim + case-fold); a present-but-unknown
value quarantines the row (`PO_STATUS_UNKNOWN` — the INVALID_CONVERSION_FACTOR posture: present-but-unusable
is never coerced). While the feed omits the column, every line degrades to live and the run **discloses**
the degradation once — the same posture §14.6b's matching layer already takes for an absent status fact.

**Refusals and honesty.** Every malformed shape refuses with a named error: duplicate `(poNumber, sku)`
identity, non-finite quantities, unknown status value, non-canonical `asOf` or `expectedDelivery`. The
producer receives facts and never invents them; the classification order
(Supplier Issue > Late PO > Partial Delivery > Follow-up > Normal) is the engine's and does not change here.
The plan receipt carries the facts, the label and the disclosure counts **additively**, and the engine's
`openPO` input becomes the live-line sum — a cancelled line can no longer hold a ref's inventory status
hostage, exactly as §14.6b already stopped it holding the guard hostage.

### 14.6d The loop's second turn — supplier scorecards fed by matching (audit M4 scorecards; named proof `feedback/scorecard-matching-fed`)

*(§14.6b made the matching rules normative and promised that every downstream node — scorecards, efficacy,
the double-order guard — consumes matching output "exactly as it consumed reconciliation output, with the
new flags additive". This section is the scorecard half of that promise: how §14.6's SRM row
(`supplierScorecard()`, the instrument that steers preferred-supplier selection) is FED. The audit's M4
scorecards item. The scorecard engine itself is NOT re-defined here — its M2 H2 semantics (due-lines only,
OTIF as on-time AND in-full, `avgLateDays` null-vs-zero honesty, the lead-time estimate, price adherence,
quarantine rate) are the canon this wiring composes, never re-implements.)*

**Attribution follows the delivery, not the intent.** Evidence attributes to the **PO line's actual
supplier** (the export's Supplier column, `supplierName` on the line input): a supplier scorecard measures
who delivered. The leaf's `SUPPLIER_CHANGED` flag remains the disclosure that execution deviated from the
proposal's intent — the deviation is visible where it happened, and the scorecard is not asked to
adjudicate it. To make the matching result self-contained for downstream attribution, the line result
carries `supplier` (additive; the unlinked surface carries it too), and an **UNSOLICITED line — a real
delivery from a real supplier with no known proposal behind it — is evidence as well**: its own line-fact
reconciliation (fill net of returns against the ordered quantity, lateness against the promised date when
both dates exist, price variance **null** — no expected price exists to vary from) attributes to the
line's supplier and counts in that supplier's denominators exactly when the H2 rule makes any line due.
A line that names **no supplier** lands in the result's `unattributed` surface — real evidence is never
silently dropped onto a guess, and never silently discarded.

**What never becomes evidence.** A `CANCELLED` line is not due (§14.6b verbatim: a cancelled promise is
not a late one) — its void fill and void lateness fall out of the H2 denominators by the same rule that
already excludes not-yet-due lines, and the wiring **discloses** the exclusion per supplier
(`cancelledLines`) instead of letting it vanish. The scorecard engine's own due-line filter
(fill AND lateness known) does this work; the wiring's pin is that the filter's EXCLUSION of cancelled
evidence is asserted by the named proof, not left to accident.

**Additive signals.** The per-supplier entry exposes the flag rollup (`flagCounts` — flag → the number of
that supplier's **lines** carrying the flag, whether it rides the line result (the line-level facts:
`PO_CANCELLED`, `RECEIPTS_AFTER_CANCEL`, `GOODS_RETURNED`, `OVER_RECEIVED`, `WAITING_INCONSISTENT`,
`AMENDED`, `AMENDMENT_UNEXPLAINED`) or its evidence (the reconciliation flags: `LATE`, `SHORT_DELIVERED`,
`SUPPLIER_CHANGED`, `UNSOLICITED`, …); a flag present at both levels is one line's fact, counted once).
The proposal-level topology flags — `SPLIT_ACROSS_POS`, `PART_CANCELLED` — name the buyer's task, not the
supplier: they stay on the §14.6b aggregates and never fuse onto one supplier's card. The wiring also
discloses per supplier: `unsolicitedLines` (evidence from the unlinked surface) alongside the engine's
own `dueLines`/`openLines`.

**Determinism and refusal.** Suppliers are returned sorted by name; identical inputs produce deep-equal
output; the result survives a JSON round-trip. The wiring consumes a `matchPoLines` RESULT — a malformed
shape (non-array `lines`, evidence that is not an array) refuses with a named error, the §14.6b posture.
The scorecard rebuild itself is scheduled work (`SCORECARD_REBUILT`, §15.4) and will carry an explicit
asOf when it lands; the H2 second arm — an unreceived line **past its promised date** counting as due —
belongs to that scheduled rebuild (the data for it is already on the evidence), and is named here so the
obligation stays visible: it is a scheduled follow-on, never a silent descope.

### 14.6e The loop's learning turn — efficacy signals fed by matching (audit M3 efficacy; named proof `feedback/efficacy-matching-fed`)

*(§14.6b made the matching rules normative and promised that every downstream node — scorecards, efficacy,
the double-order guard — consumes matching output "exactly as it consumed reconciliation output, with the
new flags additive". §14.6d delivered the scorecard half; this section is the efficacy half: how §14.6's
PLAN rows — `parameterEfficacy()`, `proposalQuality()`, and `realizedLeadDays → leadTimeEstimate()` — are
FED. The audit's M3 finding verified the engines' gating (`MIN_SAMPLE=12` + confidence grade) in
isolation; the milestone item is the wiring that makes the signals real: the chain of record terminates
in SIGNALS, and an unwired signal is open-loop all over again. The engines themselves are NOT re-defined
here — the M3 canon (FOLLOWED-only judgment, the sample floor, the confidence grade), the M2 canon
(PENDING inside the decision SLA, `actedRate` excluding in-window proposals, recall counting missed
shortages) and the lead-time canon (p80 basis, `n`/`confidence` returned, never a lead time invented from
no data) are what this wiring composes, never re-implements.)*

**The unit of judgment is the proposal.** The wiring consumes the §14.6b matching result's per-proposal
aggregates — the §14.6 shape, one entry per `refId`. A proposal raised once and split across three POs is
ONE judgment with `SPLIT_ACROSS_POS` as its fact, never three: a split commitment is one decision the
optimizer made, and counting its lines separately would manufacture sample size the tenant never earned —
the exact disease the M3 floor exists to stop. Because the proposal IS the axis of judgment here, the
proposal-level topology flags (`SPLIT_ACROSS_POS`, `PART_CANCELLED`, `PO_CANCELLED`) ride the wiring's
flag rollup — the §14.6d supplier-axis exclusion (topology flags name the buyer's task, not the supplier)
does not transfer: on the efficacy axis the proposal is the task. The rollup stays additive and
per-proposal (`flagCounts`: flag → the number of proposals carrying it), and it rides the AGGREGATES' own
flags — the leaf-derived facts (`DEVIATION_UNEXPLAINED`, `LATE`, `SHORT_DELIVERED`, `SUPPLIER_CHANGED`,
`SKU_SUBSTITUTED`, `PRICE_ABOVE_EXPECTED`, `MIXED_RECEIPT_PRICES`, `GOODS_RETURNED`, …) and the topology
facts the aggregate builder itself raises. The §14.6b LINE-level facts (`AMENDED`,
`AMENDMENT_UNEXPLAINED`, `RECEIPTS_AFTER_CANCEL`, `OVER_RECEIVED`, `WAITING_INCONSISTENT`) stay on the
line results where §14.6b put them: under the merge topology a line can answer several proposals, and a
line fact that cannot name exactly one proposal is never fused onto one — the data-health obligation
those flags carry is discharged on the line, not on the learning turn.

**The join is inventory's, not matching's.** Whether advice WORKED is an inventory fact — did the ref
stock out anyway, did it pile up — and no PO fact can manufacture it: the caller supplies the
post-decision observations (`{refId, stockedOutAfter, overstockedAfter}`) and the wiring joins them to
the aggregates by `refId`. Booleans, strictly: an observation whose outcome arrives as a truthy-coercing
string is the `nz()` disease inside a training signal, and refuses by name. A proposal with no
observation is not a clean outcome — it is an UNOBSERVED one, and the wiring discloses the join
(`observed` / `unobserved`) so a signal's evidence base is always auditable. The wiring never invents
observations; the engines' honesty does the rest — only FOLLOWED cases are judged (a stockout after the
buyer ignored us is not a parameter failure), and the sample floor stands.

**What never becomes judged.** A `CANCELLED` proposal is not advice followed: its aggregate falls out of
the FOLLOWED denominators by the engine's own filter, and the wiring DISCLOSES the exclusion
(`cancelledProposals`) instead of letting it vanish. An `UNSOLICITED` delivery is not the engine's advice
at all — it lives on the §14.6b unlinked surface, never enters proposal-level efficacy (praising the
engine for the buyer's self-correction, or blaming it, would both be fiction), and is never reclassified
as "warned" in recall. A no-commitment proposal rides its leaf outcome — PENDING inside the decision SLA,
IGNORED past it (M2) — into `proposalQuality`'s pending/decided counts, unchanged.

**Recall rides the same join.** Stockout observations feed `proposalQuality` through the same `refId`
join: a shortage the engine never proposed for is a `missedShortages` fact — the dangerous class,
invisible to an adherence-only view — with `missedRefs` sorted, deterministically. The wiring never
edits the engine's recall arithmetic; it guarantees the input is complete and honest. An observation
naming no known proposal is itself disclosed (`unmatchedObservations`): the stockouts among them are
exactly `quality.missedShortages`, the overstocks among them are inventory facts the learning turn cannot
use today — neither is silently dropped, the §14.6d posture (evidence is never discarded onto a guess,
never silently vanished).

**Lead time from observed reality.** The aggregates carry `realizedLeadDays` (the §14.6b lead span, day
units on the H4 canon) — `leadTimeEstimate()` consumes them unchanged: p80 basis, `n`/`confidence`
returned, never a suggested lead time from no data. The portfolio estimate rides the wiring's result
(`leadTime`); feeding per-ref observations into the planning slot remains the application layer's
composition of this same output.

**Determinism and refusal.** The history is sorted by `refId`; identical inputs produce deep-equal
output; the result survives a JSON round-trip. The wiring consumes a `matchPoLines` RESULT — a malformed
shape (a `proposals` field that is not an array, an aggregate without its `refId` or `outcome`) refuses
`WIRING_MALFORMED`, the §14.6d posture; an observation without a `refId`, or carrying a non-boolean
outcome, refuses `OBSERVATION_MALFORMED`; two observations naming one `refId` refuse
`OBSERVATION_DUPLICATE` — one ref, one post-decision outcome; the ambiguity is not averaged away.

### 14.6f The scorecard rebuild — the H2 second arm, past-promise due-ness (D-034 follow-on; named proof `feedback/scorecard-rebuild`)

*(§14.6d scheduled it, this section delivers it: the scorecard REBUILD — `SCORECARD_REBUILT`, the §16.1
Class-S "scorecard rollup" event — carrying an explicit `asOf`, and with it the H2 SECOND ARM: an
unreceived line **past its promised date** counts as due. §14.6d named the obligation so it could not
silently descope; this is the contract the obligation belongs to.)*

**The blind spot the arm closes.** The H2 due-line filter (fill AND lateness both known) never sees a
line with **zero receipts**: realized lead needs a receipt to measure against, so `lateByDays` is null
and the line stays "open" — no matter how far past its promised date it sits. A supplier who NEVER
delivers — the worst case the scorecard exists to catch — is therefore invisible in the instrument that
steers preferred-supplier selection: an actively harmful blind spot, the same class the H2 first arm
was written for (averaging nulls as zero made a perfect-delivery supplier look 50%; ignoring
never-delivered suppliers makes an empty one look unjudged). The first arm judges what arrived; the
second arm judges what was PROMISED and never arrived.

**The arm's rule — additive to the H2 canon, never replacing it.** A line is **past-promise due** iff
ALL hold: it is live (`OPEN` or status absent — a cancelled promise is not a late one, §14.6b verbatim);
its net receipts are ZERO (a partial has receipts — its lateness is OBSERVED and the first arm already
judges it; the arm exists for the truck that never came at all); a promised date exists
(`expectedDelivery != null` — an unpromised line can never be late against no promise, §14.6c verbatim,
it stays open and rides the UNPROMISED_WAITING disclosure that data health sweeps, not the scorecard);
and `expectedDelivery < asOf` on the canonical day-string comparison (H4 — no timezone arithmetic).
The arm's evidence: `fillRate` 0 (already the fact — nothing came) and `lateByDays` =
`asOf − expectedDelivery` in canonical day units — **days past due, a DERIVED lateness, never an
observed one**, and the derivation is DISCLOSED: the reconciliation carries the additive flag
`PAST_PROMISE_UNRECEIVED`, so `avgLateDays` can never disguise a days-past-due figure as a measured
delivery lateness. A line not past its promise (promise ≥ asOf) stays open — a promise not yet broken
is not evidence. The arm rides the REBUILD (which owns the asOf), never the bare matching layer —
`matchPoLines`' only change is ADDITIVE: each line result now CARRIES its `expectedDelivery` (a line
fact the layer already consumes; carried, not guessed, null when absent) so the rebuild can judge
without re-deriving the facts view.

**The rebuild is the scheduled work, with the asOf stamped.** `rebuildScorecard(matched, opts)` — the
pure composition that (1) refuses malformed inputs by name (`WIRING_MALFORMED` for a matching result
without its lines array; `ASOF_REQUIRED` when the rebuild is called without its as-of — a scorecard
without an as-of date is not a scorecard; `ASOF_INVALID` for a non-canonical day string — the H4 canon
refuses naive datetimes, the §14.6c posture; `TRIGGER_INVALID` for a trigger outside the §16.1 Class-S
vocabulary `schedule | manual | upload`); (2) derives the second-arm evidence over the live lines
(sorted, deterministic — the derivation names every line it arms, `secondArm.lines`, never a silent
rewrite); (3) composes `supplierScorecards` (the §14.6d wiring, the M2 H2 engine UNCHANGED beneath it —
one canon, no re-implemented denominator: the arm only fixes the INPUT, the engine's denominators stay
the engine's); and (4) yields the rollup receipt the §16.1 Class-S class names as its own: the ONE
`SCORECARD_REBUILT` block payload — entity `supplier_scorecard`, entityId the asOf day, action
`SCORECARD_REBUILT`, `before` null (a rollup writes no business value), `after` = { asOf, suppliers
(sorted names), dueLines, pastPromiseDue }, actor `system` with the trigger and job id in the reason,
ENGINE_VERSION + SCHEMA_VERSION stamped (L-07: "why did this supplier's score change?" resolves to an
exact code state). The block lands through the ledger's append door in the SAME transaction as whatever
business write the rebuild serves (§16.3 rule 2) — the third Class-S production writer posture (the FX
pin led, the DR closure followed). A rebuilt scorecard that is not answerable by the chain is a score
someone made up; the chain is what makes it a record.

**Determinism and refusal.** Identical inputs produce deep-equal output; the result survives a JSON
round-trip; suppliers sorted by name; the armed reconciliations keep the §14.6b flag discipline (sorted
arrays). The engine's null honesty is untouched — a supplier with zero due lines still reads `otif:
null`, never a fabricated zero (the rebuild only ever ADDS due evidence that is genuinely due).

**Named proof:** `feedback/scorecard-rebuild` — the arm's four boundaries (unreceived + past promise →
due with derived lateness and the disclosure flag; unreceived + promise not yet broken → open; partial
→ observed lateness, the arm never touches it; cancelled → never due, §14.6b verbatim; unpromised →
never late, §14.6c verbatim), the never-delivered supplier finally scored (fill 0, days-past-due in
`avgLateDays`), the refusal family, the Class-S event shape (§16.2 fields, actor system, stamps),
determinism, and the composition pin (the H2 engine's output for a due line is byte-identical whether
the evidence arrived observed or armed).

### 14.6g The data-health sweep — the unpromised-waiting disclosure becomes the register (D-033 follow-on; named proof `ops/unpromised-waiting-sweep`)

*(D-033 delivered the disclosure — the plan receipt's per-ref supply facts carry `unpromisedLines` /
`unpromisedWaiting` — and NAMED the follow-on: "the sweep that lifts them into `data_health_task` rows
(the §9 register)". This section is that sweep's contract. The finding it serves is §14.6c's own
sentence: follow-up without a promise date is blind, and data health should say so. Until the sweep, the
receipt said so once, into the void — the buyer who never opens the plan run never hears it; the
register is where DTA actually lives.)*

**The derivation is pure and lives with the data-health vocabulary** (`packages/core/modules/ops` —
the M9 freshness machinery's module, the DTA-owned task conventions home): `unpromisedWaitingTasks(refs)`
walks a plan receipt's refs and yields ONE DATA_HEALTH task per ref with `unpromisedLines > 0` — in the
guards' verbatim task-object shape (`{ type: 'DATA_HEALTH', field, detail, severity }`, the shape
`insertDataHealthTasks` already consumes), field `unpromised-waiting.<refId>`, severity WARN (a missing
promise is a data gap, not an outage — the honest floor; the detail NAMES the counts: lines and waiting
units, C1-converted planning units). Sorted by refId, deterministic, deep-equal on identical inputs;
the refusal family is the §14.6c posture (`REFS_MALFORMED` for a non-array; `REF_MALFORMED` for a ref
without its id or its supply facts — a ref that never computed supply is not silently healthy). A ref
with `unpromisedLines === 0` yields nothing: the register carries GAPS, never confirmations — data
health does not applaud clean refs (the freshness posture: alarms, not numbers).

**The register is a MIRROR, not an append-only flood.** The plan run is nightly; a naive INSERT per run
would fork one task per ref per day — a register that drowns the gaps it exists to surface. The sweep's
writer (`saver.syncUnpromisedWaitingTasks`, the plan-adapter port, riding the run's transaction) RECONCILES
the register to the receipt's disclosure in one direction, idempotently: (1) a desired ref with no OPEN
row INSERTS (severity WARN, task_type `DATA_HEALTH`, payload carrying the field, the counts and the asOf
of the run that raised it); (2) a desired ref whose OPEN row already exists is a NO-OP — the same gap is
not re-raised, not re-dated, not duplicated; (3) an OPEN `unpromised-waiting.*` row whose ref is NO
LONGER disclosed RESOLVES (status `RESOLVED`, `resolved_at` stamped) — the gap was fixed upstream (a
promise date landed, the line closed), the register reflects it, and the history stays: rows are never
deleted, the audit trail is the resolution. The sync receipt `{ inserted, resolved, open }` rides the
plan receipt ADDITIVELY (`unpromisedSweep`) — the run discloses what it lifted, resolved and left open;
the numbers are the register's, never recomputed by the reader.

**The sweep rides the run's own transaction and its own semantics.** The sync lands ONLY on the
fresh-apply path (and on an explicit §14.16 restatement, whose refs are the day's current truth); a
REPLAYED run writes NOTHING — the H6 posture verbatim: re-importing a day changes nothing, the register
included (the day's register state was set by the run that sealed it). A failed sync rolls the run back
with it (§16.3 rule 2's posture in its data-health dress: a register that silently missed a disclosed
gap is a false register). The saver without the sync port refuses loudly (the wiring posture — the
sweep is either wired or the deployment refuses, never silently skipped).

**Determinism and refusal.** Identical receipts produce identical task sets; the sync is idempotent
(two runs, one register); the writer validates shape BEFORE any statement (statement-first) and only
ever owns the `unpromised-waiting.*` field family — a foreign field refuses (the sweep does not
gentrify other guards' tasks).

**Named proof:** `ops/unpromised-waiting-sweep` — the pure derivation (one task per gapped ref in the
guards' shape, clean refs silent, sorted, the refusal family, determinism, JSON round-trip), the
register mirror through the stub executor (insert / no-op / resolve in one transaction; the idempotent
re-run; the foreign-field refusal; the unarmed port refusing loudly), the plan wiring (the receipt
carries `unpromisedSweep`; the replay writes nothing; the sync rides the seal's transaction), and the
live tier (the mirror against real PostgreSQL: raise → re-run no-op → resolve on clear, tenant-fenced).

## 14.7 Inter-tenant / inter-warehouse transfers — plan + reconcile (rev 1.3 boundary)
**Execution boundary (owner directive): Precoro executes; Sentinel plans, approves and verifies.** Inventory
staff never execute a transfer in Sentinel — every physical movement happens in Precoro and reaches Sentinel
through the daily ingestion drop. Sentinel's `TransferPlan` (header + lines) carries the decision lifecycle
`PROPOSED → REQUESTED → APPROVED → RECONCILED | MISMATCH`, with `CANCELLED` reachable from any pre-execution
state. On **APPROVED** the source tenant's availability drops (the stock is committed, not merely suggested)
and the destination sees a planned-in position that feeds the double-order guard (W8) — nobody re-orders what
is already on a truck. Warehouse staff then execute the physical move in Precoro; the next ingestion drop
brings the `Transfers - Goods In/Out` aggregates and the reconciliation stage matches them against approved
plans: quantities arriving at the expected destination within tolerance → **`RECONCILED`** (both sides' day
snapshots keep the entries traceable to the same plan); no matching movement inside the expected window →
**`MISMATCH`** and a follow-up task routes to the requesting category owner with the plan attached. Sentinel
never writes inventory movements itself. Valuation is shown at source unit cost, FX-converted at the pinned
day rate when tenants differ — the plan's planned value, verified against ingested facts, never authored
here. Requires approval from both sides' category owner (permission-gated). Cross-tenant shortage cover is
surfaced on the MRP row: *"QatarMP holds 400 available"* — visible only where the viewer has a grant in both
tenants. Acceptance: `transfer/reconciles-from-ingestion` (delivery spec A14).

## 14.8 Security at ingestion
The importer runs a **column allow-list**. Banking and tax identity fields (account number, IBAN, SWIFT/BIC,
sort code, routing, IFSC, tax ID, business registration, bank name/address) are **discarded at the boundary,
never persisted, never logged**. A test asserts their absence from persisted rows. Sentinel has no use for
them and holding them creates liability with no benefit.

## 14.9 Origin hardening
Network policy: **IP allowlist, default GCC-only** (BH, QA, KW, SA, AE, OM), editable by Origin itself.
Plus: session timeout 30 min idle / 8 h absolute; re-authentication for destructive actions; alert on every
origin sign-in and on any allowlist change; failed-login lockout. Origin remains visible and fully logged.

## 14.10 Bootstrap — how an empty Sentinel comes alive
**There is no seed script.** First run is a guided Origin bootstrap:
1. **One-time setup:** Origin credential from the secret manager → forced password change → second-factor
   enrolment → IP allowlist confirmation.
2. **Origin instantiates:** tenants (BahrainMP, QatarMP) · roles · the permission matrix · user accounts ·
   global settings (currencies, FX source, canonical **unit catalog**, fiscal calendar, targets).
3. **First ingestion:** item master → **categories and recipe refs are derived from it**, not typed.
   Then suppliers, inventory, consumption history, open POs, deliveries.
4. **Ownership grants** `(user × category × tenant)` — after step 3, since categories now exist.
5. **Planning parameters** seeded from the template or defaulted, then owned in-app thereafter.
6. **First engine run + day seal.** The app is live.
Until step 3 completes, screens show **first-run empty states that name the missing dataset and link to
Data Upload** — never a spinner, never fabricated placeholder rows.

## 14.11 Concurrency (pragmatic)
**Optimistic locking** on every editable row (`version` / `updatedAt`). On conflict the save is rejected with
*"Danish changed this 2 minutes ago — review and re-apply"*, showing both values; no silent overwrite, no
pessimistic locks, no live cursors. **Bulk edits** (essential at 1,395 refs — set safety days across a whole
category in one action) are transactional, last-write-wins within the batch, and write one audit entry per
affected row. Optimizer proposals never conflict because they write `calculated`, never `active`.

## 14.12 Cycle counts (measure-only — rev 1.3 boundary)
Warehouses are small and 3PL is self-managed, so keep it light: scheduled count sessions for **company
warehouses only**, ABC cadence (A monthly, B quarterly, C semi-annual, A-class = top 80% of value). The
scheduler issues count sessions to the warehouse owner; the count happens **physically**, and any stock
correction is **posted in Precoro** as an adjustment — never in Sentinel; the next ingestion drop brings the
corrected balances. Sentinel's role is strictly measurement: it records what was counted and by whom,
computes variance vs book from ingested data, tracks accuracy % over time **by counter**, raises a recount
flag beyond tolerance (W11 routing), and surfaces repeated variances on Data Health. 3PL locations are
reconciled on statement receipt, not counted by us. Acceptance: `ira/accuracy-from-ingested-adjustments`
(delivery spec A14).

## 14.13 Unit catalog & buyer accountability
Canonical units are **owned at category level** — the category owner arbitrates spellings and conversion
factors for their SKUs; unresolved aliases from ingestion route to that owner as data-health tasks.
**Buyer performance scorecard** (new screen, SRM/Analytics): per BYR, per category — savings achieved by
baseline, price-change trend, proposal adherence, stockouts and overstock in owned categories, data-health
completeness (lead times, units, preferred SKUs). This is the review instrument for BYRs, procurement
officers and clerks.

### 14.13b Conversion-factor governance — versioned, gated, deriving (audit M7; named proof `governance/cf-change`)

*(The deep technical audit's M7 finding: "Conversion-factor changes are ungoverned and unversioned… CF
multiplies consumption, PO conversion (C1), and order sizing; the risk assessment calls CF errors
order-of-magnitude. Nothing gates a CF edit, versions it, or handles in-flight proposals sized under the
old factor." §14.13 gave the category owner the arbitration right; this section gives the ARBITRATION ITS
MECHANICS — the change is staged, versioned, dual-controlled, and its downstream blast radius is re-derived
by named task, never silently rebased.)*

**One canon, one basis.** The stored `item.conversion_factor` remains the ONLY factor planning may see —
the C1 discipline (§15.1: refuse, don't guess) is unchanged. What is new is the SIZING BASIS: every sealed
plan row carries, per member, the conversion factor its quantities were computed under (`sizingBasis` in
the sealed payload — additive, order-stable, part of the payload hash). A sealed row is judged on its
sizing basis for as long as it lives: adherence, matching and efficacy comparisons (§14.6b/d/e) read the
basis the row was sized under, never the current master. A CF change therefore never silently rebases a
sealed row — the numbers a buyer was shown, the numbers a receipt is matched against, stay comparable until
someone explicitly re-derives them (below).

**A change is staged, not applied.** The ingestion seam classifies every item-master row against the stored
row before anything writes (the §14.6-freeze posture of classify-then-stage, borrowed from the
supplier-identity freeze's `classifySupplierChange`):
- incoming factor **present and equal** to stored → the row rides normally (a no-op write; nothing fires);
- incoming factor **present, different, and usable** (finite > 0) → the row's factor is NOT applied; a
  `PENDING` version row lands in `item_cf_version` (from/to preserved, monotonic version per (tenant, sku),
  `requested_by` NULL = pipeline-staged) and the stored factor **keeps serving** — planning is never
  hostage to an unreviewed master edit;
- incoming factor **blank or absent** → **a blank never wipes.** The stored factor keeps serving and the
  run discloses the count once (`CF_BLANK_KEEPS_SERVING`) — the daily drop's empty column is not a change
  request, and the pre-M7 behavior (an EXCLUDED overwrite to NULL) is named as the defect it was;
- incoming factor **present but invalid** (≤ 0, non-finite) → the stored factor keeps serving and a named
  data-health task raises (`CF_INVALID_KEPT`) — corrupt master is disclosed, never applied, never staged;
- **no stored row** (bootstrap) → the factor applies freely: first load is not a change.
The database is the backstop, not the only gate: a trigger (`item_cf_freeze`) refuses ANY
`conversion_factor` delta on `item` executed without the transaction-local `app.cf_apply_id` — the
ungoverned path fails closed (`CF_CHANGE_UNGOVERNED`), exactly as `supplier_identity_freeze` does for
identity. There is no bypass, only the door.

**The decision gate (C3, the SoD spine).** A `PENDING` version is decided by `decideCfVersion`, which
mirrors the supplier-hold gates verbatim: the principal is resolved; the decider is approval-eligible; the
decider is **never the requester** (pipeline-staged rows — `requested_by` NULL — may be decided by any
eligible principal); `APPLY` moves the version to `EFFECTIVE`, `REJECT` moves it to `REJECTED` with a
required reason and the stored factor simply keeps serving. Approving a version whose target factor is not
a usable positive number refuses (`CF_INVALID`) — the core refuses what the trigger cannot see. Refusing a
version is a decision too and carries the same gate. Every refusal is a Class-D-shaped denial record.

**The door and the derive.** APPLY is executed by the adapter as ONE transaction: `app.cf_apply_id` set
transaction-locally, the item's factor moved to the version's target, the version landed `EFFECTIVE` —
and then the third leg the audit demands: **the change raises re-derivation tasks.** The latest seal's
`sizingBasis` is walked deterministically; every ref with a member whose sizing basis differs from the new
factor raises one `WARN` data-health task naming the ref, the sku, and the from→to delta — the planner's
signal that the row's numbers are now on a stale basis and the next run will move them. Refs whose basis
already matches are counted and disclosed, never tasked. Re-derivation is EXPLICIT (a task a human owns),
never a silent rebase of quantities a buyer already saw.

**Determinism and refusals.** Classification, decision and task derivation are pure and deterministic —
sorted outputs, no clock (timestamps are the executor's), injected inputs only. Malformed shapes refuse
with named errors: a non-object row, a version row that is not an object, a seal payload without its
`refs` (`WIRING_MALFORMED`), a decision on a version not `PENDING` (`VERSION_NOT_PENDING`),
`PRINCIPAL_UNRESOLVED`, `NOT_ELIGIBLE_VERIFIER`, `SOD_DECIDER_IS_REQUESTER`, `MISSING_REASON` (reject),
`CF_INVALID`. Named proof: `governance/cf-change`.

### 14.13c The CF decide/apply API — the decision gate's transport (D-036 follow-on; named proof `governance/cf-api`)

*(D-036 built the gate and the door — the pure decision layer and the SQL executor behind the freeze —
and named the remainder: the decide/apply API, with the approvals tray as UI work riding it. This section
is that API's contract: the transport semantics that make the governance of §14.13b REACHABLE — a gate
nobody can call is a gate nobody uses, and an ungoverned factor edit finds its way in through SQL anyway.
The API is the SPOKE BETWEEN THE GATE AND THE DOOR — it owns no governance arithmetic of its own.)*

**The boundary is HTTP-agnostic and the identity is the session's.** `handleCfDecision(request, deps)`
carries the API semantics (testable without a server, the `handlePlanRun` pattern); the Next.js route is
thin transport only — session resolution (M11: the httpOnly cookie → user_session envelope), the GUC
fence trio (`app.tenant_id` / `app.actor_id` / `app.mfa_ok`), one transaction. The request body carries
`{ versionId, decision, reason? }` and NOTHING about identity: a body-carried tenant or actor is the
plan route's retired interim — the boundary decides whose hand is on the decision, and it is never the
caller's claim. The actor envelope (`{userId, role}`) resolved from the session is what the pure gate
judges — the SoD spine (eligible decider, never the requester) is only as honest as the identity being
judged, so identity NEVER rides the request.

**The flow is gate → record → door, in the caller's transaction.** (1) The pending version is loaded BY
ID (the state re-proved, not assumed — the loaded row is what the gate judges; a missing or non-PENDING
version is the gate's `VERSION_NOT_PENDING`, never a fabricated object). The latest seal payload rides
in for the APPLY leg (the re-derivation walk is the §14.13b third audit leg — explicit tasks, never a
silent rebase). (2) The gate runs — `cf.decideCfVersion` UNCHANGED: eligible decider, never the
requester, PENDING only, reason on reject, `CF_INVALID` refused at the core. A refusal yields the
Class-D denial record, which travels UNCHANGED through the ledger's append door (`appendDenialRecord`,
the D-029 consumption posture) — §16.1 Class D: every refused action is logged, and a probing hand
mapping the approval path is exactly the reader the record exists for. The ledger door is armed only by
the deployment's HMAC key + the SESSION's envelope (an anonymous denial record cannot exist); UNARMED
the API refuses loudly (wiring TypeError → 500) — either armed or refused, never a denial that leaves no
trace. (3) On `ok`, the door executes — `procure-adapter.resolveCfVersion` UNCHANGED: lock FOR UPDATE,
the GUC fence, the freeze trigger re-proving the move, the version landing EFFECTIVE (or REJECTED with
its reason), the re-derivation tasks inserted in the same transaction. The API composes; it never
re-implements a denominator, a gate, or a trigger.

**Statuses and refusals — the plan-handler mapping, adversarially honest.** `200` the decision receipt
(`{verdict: 'APPLIED'|'REJECTED', …door receipt}`); `400` request-shape (`INVALID_REQUEST` — a malformed
versionId, a decision outside APPLY|REJECT before the gate runs); `403` a gate denial
(`{verdict: 'REFUSED', reason: <denial code>, denial}` — the record the ledger now carries, returned so
the tray can render the why); `404` the version id names nothing in this tenant (`CF_VERSION_NOT_FOUND`
— RLS makes another tenant's version indistinguishable from no version, which is the point); `500`
wiring (TypeError — an unarmed ledger, a missing port: a bug, not a refusal, and the transaction rolls
back with it). A REJECT without its reason is the gate's `MISSING_REASON`, a 403 with its Class-D record
— the why is part of the record, not a formality.

**Determinism and named proof.** The handler owns no arithmetic: identical inputs through the same deps
produce deep-equal receipts; every refusal code is the pure gate's own code, unmangled. Named proof
`governance/cf-api` — the boundary surface (the request shape, the retired identity fields, the
gate-before-door order), the denial-record leg through the armed ledger (the record's fields verbatim,
the D-029 shape), the door receipts (APPLY with the re-derivation counts, REJECT with its reason), the
status mapping, the unarmed-loud refusal, and determinism; the live tier re-proves the freeze's posture
the sod-live suite already walks.

## 14.14 On "EOQ" — naming, and why it matters
The workbook's `T = max(MOQ, orderFreq × dailyConsumption)` is an **order-cycle quantity** (how much a
review-period covers), not the textbook Wilson EOQ `√(2DS/H)`, which balances ordering cost against holding
cost and requires neither of those inputs to exist here. The formula is kept **exactly as verified** — it is
correct policy for a fixed review cycle — but the UI labels it **"Order Qty (cycle)"** with the formula shown
on hover, so no supply-chain-literate user mistakes it for classical EOQ. True EOQ may later appear as an
optimizer *suggestion* (never a silent substitution) once ordering and holding costs are captured.

## 14.15 Module management — the plugin control plane (rev 1.2 directive; extended rev 1.3)
The platform is **fully modular and plugin-like**: one module breaking must never affect anything else, and
Origin can add, enable, pause, upgrade, disable and remove modules, functionality and features at runtime.
Mechanics:

- **Registry + manifests.** Each module ships `sentinel.module.json` (id, version, dependencies, permission
  scopes, ingestion kinds consumed, UI surface points, ledger event types). The registry resolves the
  dependency graph, refuses cycles, and exposes typed contracts only — no cross-module internal imports
  (CI gate).
- **Lifecycle.** `REGISTERED → ENABLED ⇄ DISABLED`, plus `PAUSED` (quiesced: in-flight jobs drain, queue
  held, state kept — the staging state for maintenance and upgrades) and `FAULTED` (circuit open) from any
  state. Transitions are Origin actions on screen 33 and are **ledger events** (`MODULE_ENABLED` /
  `MODULE_DISABLED` / `MODULE_PAUSED` / `MODULE_RESUMED` / `MODULE_FAULT` / `MODULE_RECOVERED`) with
  actor, timestamp and reason.
- **Fault containment.** Dedicated queues + watchdogs per worker module; error boundaries per UI module;
  health probes with capped retries; a faulted module fails fast with `MODULE_UNAVAILABLE` while the rest of
  the platform, the shell and the ledger continue unaffected.
- **Visible degradation.** Dependents render explicit states ("unavailable — module disabled by Origin");
  the two rules of §3 (fail closed, fail visible) apply to architecture itself.
- **Adding capability = adding a module.** In-repo `modules/` package + registration + permission grant +
  first enable, one Origin flow, fully audited. No seed, no core surgery, no downtime for the other modules.
- **Upgrading a module = a staged, gated, reversible operation.** Compatibility check (manifest semver +
  dependency versions) → auto-pause → artifact swap → module golden smoke + contract tests → resume on the
  new version; **any red gate rolls back automatically** to the pinned previous version. Upgrades are
  ledger events (`MODULE_UPGRADED` with from/to versions, `MODULE_UPGRADE_FAILED`, `MODULE_ROLLBACK`); one
  module upgrades independently and siblings never redeploy. No hot patching of a running module, ever.
- **LLM-coded upgrades are welcome — as gated contributor diffs.** Each module upgrade is separately
  improved with LLM coding, then promoted only after the same gates as any human change: typecheck, golden
  suite, import-boundary grep, purity; a **named human reviewer**; **Origin promotion approval**; and a
  provenance ledger block (model, artifact hash, reviewer). An unsupervised auto-promoted patch is the one
  failure mode this pipeline exists to prevent.
- **Removing a module = unregister + archive.** The module's artifacts and ledger history are retained;
  removal is a switch, not an erasure — the audit trail outlives the capability.

---

## 14.16 Restatement semantics — the sealed past, restated honestly (audit M8; named proof `ledger/restatement`)

The audit's [S] finding: "Late-arriving consumption restates history; DayStates are immutable. Does the
time machine show the sealed (wrong) state forever, with current data diverging silently?" Fix: restatement
events are ledger blocks; the time machine marks resealed states and diffs "as known then" vs "as known
now."

**The problem, stated exactly.** The daily seal (§11) freezes what the system KNEW at day close: a full
computed state plus payload hash per tenant-day. Data arrives late — a consumption correction, an amended
delivery count, a receipt the supplier confirmed weeks after the fact — and the computation for that
already-sealed day would now come out DIFFERENT. The seal is immutable and must stay so: it is the record
of what a buyer saw when they decided. But an immutable seal plus a silent divergence is exactly the
failure mode this system exists to kill: the time machine would show the sealed state forever while
today's numbers quietly say something else, and nobody would ever be told.

**The resolution — versions, never overwrites.** Restating a sealed tenant-day is an EXPLICIT act, never a
side effect of a plan run:

- A plan run for an already-sealed day that recomputes to a DIFFERENT payload hash is, by itself, only the
  DETECTION: the receipt is `REPLAYED · divergent` (the existing H6-replay disclosure — unchanged), nothing
  is written, the sealed state stands.
- A restatement is REQUESTED (`restatement: true` on the plan run for that same `asOf`) and carries a
  REASON (`restatementReason`) — why history is being restated. A reasonless restatement refuses
  (`RESTATE_REASON_REQUIRED`): "the data changed" is the situation, not the justification. The actor is the
  authenticated session's (the same identity the ledger block carries); an anonymous restatement cannot
  exist.
- The restated snapshot lands as a NEW VERSION of the tenant-day (`plan_seal_restatement`, revision ≥ 2,
  chained to its predecessor by `prev_revision` + `prev_payload_hash`), beside the original seal
  (revision 1) — never over it. Every version is immutable; the chain of versions is the day's history. A
  day is restated AGAIN (v3, v4, …) as often as reality demands, and never erased.
- The CURRENT state of a day = its highest revision (the seal itself if none restated yet). Every reader
  that resolves "the seal for this tenant-day" — the replay-divergence comparison, the time machine, the
  day-vs-day diff — resolves it to the CURRENT version: a post-restatement replay of identical inputs
  REPLAYS against v2 and is non-divergent exactly then.

**The chain cannot fork.** The version chain is guarded at the database the way the ledger is: revision 2
must name the seal row itself as predecessor (`prev_revision` 1, `prev_payload_hash` = the seal's hash —
there is no restatement of a day that was never sealed, the anchor MUST exist and the foreign key holds it
there); revision N > 2 must name revision N−1 and its hash. A racing append collides on the unique
(tenant, day, revision) and refuses loudly — the loser retries against the new head. No UPDATE, no DELETE:
the table is granted SELECT, INSERT only, and a trigger refuses any mutation that ever reaches it — the
§16.3 rule 1 posture applied to the seal's own history. You can restate again, never un-state.

**Restatement events are ledger blocks.** Every applied restatement appends ONE Class-W block — the first
production writer of the H5 chain: entity `plan_seal`, entityId the seal date, action `RESTATE_DAY`;
`before` carries the predecessor's `{revision, payloadHash}`, `after` the new version's `{revision,
payloadHash, delta}`; the reason rides the block. The block participates in the SAME database transaction
as the version insert (§16.3 rule 2: a failed ledger write rolls the restatement back with it — an
unlogged restatement must not be possible, and a logged one must not be un-done). The full payloads live in
the version rows the block points to; the ledger carries pointers and the delta summary, never a third
copy of the payload.

**"As known then" vs "as known now."** Each restatement carries a deterministic delta summary — which refs
changed, whether the driver changed, which KPI keys changed — computed by a pure function over the two
payloads (canonical JSON comparison, sorted axes, no clocks). The delta is part of every disclosure: the
restatement row, the ledger block, the receipt. The time machine (screen 12) renders a restated day with
its versions MARKED: the sealed state as known then, each restatement as known now, and the side-by-side
diff §11 promises. The screen composition is UI work riding the screen-12 unit; the data path — versions,
current resolution, delta, ledger block — is the contract here and the named proof's subject.

**Determinism and the refusal family.** Identical inputs produce an identical delta. The refusals:
`RESTATE_REASON_REQUIRED` (a restatement request without a reason — request-shape, 400-class); a
restatement requested against a NON-divergent day is a disclosed NO-OP — the receipt is `REPLAYED` with
`restatementRequested: true`, nothing is written, NO block is appended (the ledger logs changes, not
non-events); and the wiring posture — a restatement requested through ports that cannot serve one is a
TypeError (fail loudly, never silently ignore an explicit request), the same deployment honesty as an
unconfigured ledger key: the door is either armed or the request is refused loudly at the boundary.

**Named proof:** `ledger/restatement` — plan-service semantics (reason required; the no-op disclosed;
restate → `RESEALED` with revision, predecessor pointers, delta and the ledger receipt; versions
accumulate, the seal row untouched; ports wiring refused loudly), the db door (statement-first chain
derive under a lock on the anchor, named predecessor refusals, the fork guard's structural backstop, the
ledger block fields, append-only), and the live tier (end-to-end restate against real PostgreSQL: v1
untouched, v2 chained, the block in the verified chain, the version read surface, cross-tenant isolation,
the fork guard refusing a wrong predecessor live).

---

## 14.17 FX fail-safe — the pinned rate, honestly aged (audit M10; named proof `ops/fx-stale`)

The audit's [S] finding: "The FX pin is 24h per tenant-day; nothing says what happens when the FX job
fails (block conversions? last-pinned value with a staleness flag?). Fix: fail-safe policy (continue on
last pinned rate, mark all derived money stale-visible, alarm); source of record named." ADR-0003
records the business decision; this section is the normative contract the implementer obeys.

**The problem, stated exactly.** C2 (D-015) made money fail-closed: a USD document converts at the
pinned tenant-day rate, and an unpinned day refused `RATE_NOT_PINNED`. Fail-closed against a MISSING
RATE is correct; fail-closed against a LATE PIN is a self-inflicted outage — one failed nightly job
would quarantine every USD row the next morning and blind the loop, silently in the operator's
experience ("the file just didn't ingest"), which is the exact disease the refusal posture was written
to name. What was missing was the WRITING side (nothing pinned rates), the POLICY (what a conversion
does when the pin is late), and the SOURCE (what feeds the table and how a wrong pin is corrected).

**The source of record (ADR-0003 §1).** The `fx_rate_pin` table is the source of record for every
USD→local conversion, and nothing else is. Rates enter through the tenant's configured FX source
(screen 32 names the origin — the treasury desk's daily publication) as an operator-maintained daily
rate sheet inside the closed ecosystem; **no component fetches rates from the open internet at run
time**. The nightly job ("FX pin (24h)… Idempotent, logged, retry-safe", §8) reads the configured
source and lands one pin per tenant-day through the pin door. Availability of money conversion never
depends on egress availability.

**The pin door — idempotent, logged, retry-safe (ADR-0003 §2).** `pinRate(day, rate)` through the
fx-adapter:
- the SAME rate re-pinned for a pinned day is a **no-op success** — a retried job is not an error;
- a DIFFERENT rate for a pinned day refuses **`RATE_DAY_CONFLICT`** — the daily pin is not silently
  overwritable;
- a correction is an EXPLICIT act: `correctRate(day, rate, { by, reason })` — **reason REQUIRED**
  (`RATE_CORRECTION_REASON_REQUIRED`), the UPDATE carries before/after, ONE Class-S `FX_CORRECT`
  block with the diff;
- **DELETE is refused structurally** (the 0009 append-only trigger + the revoked privilege) — correct
  again, never un-pin; the correction trail is the history.

**The fail-safe resolution order (ADR-0003 §3 — the audit's fix, normative).** A USD conversion for
day D resolves, in order, as the money layer's PURE decision (`resolveRatePin`, canonical day strings,
the H4 discipline — no `Date` parsing, no timezone drift):
1. **Exact pin for D** → fresh: `rateSource 'PINNED_USD'`, no staleness fields.
2. **No pin for D, an earlier pin exists** → **continue on the last pinned rate ≤ D**, and the derived
   money is **STALE-VISIBLE**: the money result carries `stale: true` and
   `rateStale: { pinnedFor, staleDays }` (additive — every field an existing consumer saw is
   unchanged); the ingest run discloses the fallback once per run and counts it (DAT-06's coverage
   denominator); a pin dated AFTER D is never a candidate — tomorrow's rate must not convert today's
   rows.
3. **No pin ≤ D at all** → **`RATE_NOT_PINNED` stands** (D-015 verbatim; the row quarantines). The
   D-015 blanket refusal **narrows to never-pinned** — the amendment is explicit, here and in
   D-038, never a silent edit of the C2 contract.

**Staleness is alarmed, not graded (ADR-0003 §4).** DAT-06's target is 100% daily pin coverage; any
conversion that rode a fallback is a breach of a daily SLO. The ops channel (beside DAT-01's
freshness machinery, the same injected-clock purity) is binary: the latest pin older than the
evaluated day → **`FX_STALE`** alarm + DATA_HEALTH task + banner naming `staleDays`; no pin at all →
**`FX_NEVER_PINNED`**, naming the refusing consequence. Owner DTA, cadence daily. Age is disclosed,
never banded — a stale rate is not a little bit acceptable.

**Pins are ledger events (ADR-0003 §5).** Every pin and correction is a **Class-S** block (§16.1
names FX pin verbatim as a machine-originated write): actor `'system'`, role null; a manual trigger
rides `onBehalfOf` with the trigger and job id named in `reason`; `engineVersion`/`schemaVersion`
stamped by the adapter from the repo's own constants — a caller never labels the chain. The append is
in the SAME transaction as the pin write (§16.3 rule 2): a failed append rolls the pin back.

**Determinism and refusals.** Day math rides the canonical day-string discipline (H4): `staleDays`
is a UTC-anchored day count between `'YYYY-MM-DD'` strings, never a local-time subtraction. The
refusal family: `RATE_NOT_PINNED` (never-pinned, C2 verbatim), `RATE_DAY_CONFLICT`,
`RATE_CORRECTION_REASON_REQUIRED`, `RATE_INVALID` (non-positive/non-finite), `RATE_DAY_INVALID`
(non-canonical day), plus the wiring posture — an unarmed ledger door is a TypeError, the same
either-armed-or-loud deployment honesty as the restatement door (§14.16).

**Named proof:** `ops/fx-stale` (the audit's named test) — the alarm channel (current pin → silent;
stale pin → FX_STALE with staleDays; never pinned → FX_NEVER_PINNED; future pins are not candidates;
malformed input refuses; determinism), and `ingestion/fx-fail-safe` — the resolution order (exact,
fallback with `rateStale` disclosure, never-pinned refusal, future pins ignored, additive result
shape, local-currency rows untouched, determinism), the door (idempotent re-pin, conflict, correction
reason + diff, the Class-S block fields, append-only), and the live tier (pin against real
PostgreSQL, USD row converts, fallback disclosed, never-pinned quarantines, DELETE refused 42501, the
block in the verified chain).

---

## 14.18 CI security gates & SBOM — the supply chain is gated (audit M12; named proof `security/gates`)

The audit's finding: "CI has no security gates… No dependency audit, secret scanning (gitleaks-class),
license scan, SBOM, or container scanning is required — for a system whose handoff explicitly fears
credential leakage." The fix text: add all five as merge-blocking gates; pin dependencies (the
practice of pinning, generalized). This section is the normative gate contract; the acceptance test is
`security/gates` — **CI config review, machine-checked, plus one deliberately vulnerable fixture
dependency caught.** The gates run as a dedicated CI job; every step is merge-blocking — no
`continue-on-error`, no conditional skip, no advisory mode. A gate that can be bypassed without a
recorded decision is not a gate.

**The gate surface.**

1. **Dependency audit** — `pnpm audit --json` against the frozen lockfile, verdict computed by a pure
   wrapper: any advisory at severity `high` or `critical` FAILS the build with the module, severity,
   GHSA id and vulnerable range NAMED; moderate/low findings are reported in the log without failing
   (the §7.1 posture: "deps, fail on high+"). The advisory database is live data — a new advisory can
   turn a green tree red overnight, and that is the gate WORKING. The verdict logic is pure: the CI
   step runs the wrapper against the real lockfile, and the named proof runs the SAME wrapper against
   recorded advisory payloads (the deliberately vulnerable fixture: a real advisory shape for a
   known-vulnerable range must be CAUGHT and named, a moderate-only payload must PASS).
2. **Secret scanning** — gitleaks (pinned version) over FULL git history (`fetch-depth: 0`), default
   ruleset UNMODIFIED. The only extension is `.gitleaks.toml`'s allowlist, under the naming
   discipline: **every allowlist entry states WHY it is safe; a finding with no such name is a bug and
   must be triaged, never allowlisted; no rule is ever weakened to make the gate green.** The landed
   allowlist carries exactly one entry: the RFC 6238 Appendix-B TOTP test secret (base32
   `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` — the RFC's own published vector, stated from the RFC text by
   the M11 auth suites per the H12 discipline). The existing policy guard (forbidden terms + secret
   shapes) remains in place beside it — two scanners, different failure classes.
3. **License scan** — every workspace project's dependency tree is walked (the license-checker tool,
   pinned exact as a root devDependency) and every third-party license expression is evaluated: an
   OR-expression passes if ANY operand is allow-listed; an AND-expression passes only if ALL are; the
   allow-list lives in `scripts/security/license-allowlist.json` (MIT, ISC, Apache-2.0, BSD-2/3-Clause,
   0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0, MPL-2.0, CC-BY-3.0/4.0, Unicode-3.0) and anything else —
   including UNKNOWN and UNLICENSED third-party — FAILS CLOSED. First-party `@sentinel/*` workspace
   packages are exempt (they are the product, not the supply chain); the exemption is by exact name
   prefix, never by version.
4. **SBOM** — Syft (pinned) generates an SPDX-2.3 JSON of the tree on every run; the artifact is
   published with the run and parse-verified (a non-JSON or empty package list fails). The release
   publication of the SBOM (§10 DoD item 5: "SBOM + checksums manifest published with the release")
   rides the release workflow unit — the generation and verification are contract here.
5. **Dependency pinning** — a pure gate walks EVERY `package.json` in the workspace: every entry in
   `dependencies` and `devDependencies` must be an EXACT version (`1.2.3`) or the `workspace:*`
   protocol; caret, tilde, star, `>=`, and `x` ranges refuse. `peerDependencies` are exempt — a
   library declares its compatibility range there, and the CONSUMER's exact pin is what ships. The
   gate closed the workspace's one real violation at landing (db's `prisma ^6.0.0` → `6.19.3`, the
   lockfile-resolved version — behaviorally a no-op, contractually the practice generalized).
6. **Closed-ecosystem grep** — the runtime surface (the `src` trees of apps, packages and modules, the
   db adapters, the workers — never tests, docs, or scripts) carries no egress call: no `http(s)://`
   URL literal outside `localhost`/`127.0.0.1`, no egress HTTP client import (`axios`, `undici`,
   `XMLHttpRequest`, raw `http.request`/`https.request` to external hosts). The closed ecosystem's
   network surface is its own PostgreSQL and its own HTTP API — ADR-0003's posture, now grep-enforced
   per commit. The M13 egress ALLOW-LIST policy work (the Intelligence node's explicit outbound set)
   rides its own section; this gate is the CI backstop that stops an egress call from landing silently.

**The remediation record.** The audit gate's first local run against the real lockfile found FIVE real
advisories in our own dependency tree — postcss (two HIGH: GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849;
two moderate) pulled by next's pinned `postcss@8.4.31`, and deepmerge-ts (HIGH: GHSA-ggr8-5vv4-36mx)
pulled by `@prisma/config`. Remediated in the same unit by pnpm overrides pinned in the root
manifest (`postcss: 8.5.26`, `deepmerge-ts: 8.0.2` — exact, patched, verified against the advisory
ranges) with the lockfile re-resolved and the web build, ui theme compile, prisma CLI and the full
battery re-proven green on the remediated tree. The gate caught real vulnerable dependencies before it
ever ran in CI — the audit's acceptance scenario, played out in production truth.

**The container-scan leg — named, not descoped silently.** The audit's fifth gate (container
scanning, Trivy per §7.1) has no subject yet: no Dockerfile exists in the tree (the image build is
§7.1 step 7 / §7.4 reference-topology work, a named unit of its own). The container scan JOINS the
image-build unit — the moment an image exists, the scan gates it. This is a scheduling disclosure,
never a silent gap: gate 18 closes on the four applicable gates + pinning + the egress backstop, and
its record names the fifth leg and where it lands.

**Governance.** Tool versions are pinned (gitleaks version pinned in the workflow; Syft pinned by the
action's version input; license-checker pinned exact as a root devDependency); third-party actions are
pinned by major tag (the repo's existing practice — checkout@v4, setup-node@v4, gitleaks-action@v2,
sbom-action). The named proof `security/gates` runs IN the security job it audits — the gate surface
reviewing itself, machine-checked, so a removed or weakened gate fails the same push that removed it.

---

## 14.19 Ladder-edge semantics — the workbook's edges documented, detected and named, never silently fixed (audit M14; named proof `core/ladder-edges`)

The audit's finding: "Status-ladder internal inconsistencies (workbook heritage) — document, do not
silently fix. [E-confirmed]" Three properties were verified against the engine: branch 7
(`available > maxStock + maxStock×0.2`) is mathematically identical to branch 1
(`available > maxStock × 1.2`) and unreachable; a display/trigger band exists at
`1.0 ≤ reorderPct < 1.01` where the status reads `Below Reorder` while the order trigger
`orderRecQty` is 0; a negative `available` classifies as `Below Safety` — red, not silent, but an
impossible state should be DETECTED, not merely classified. The fix text: keep the ladder
byte-compatible (the golden rule), add a `warnings` array to `computeRef` output, document the band
in §6. This section is the normative contract for that documentation layer.

**The ladder is byte-compatible — the golden rule holds.** No branch is reordered, edited or
deleted; `statusOf` is untouched and the 86 golden tests keep their intent verbatim. The workbook is
the verified artifact and the audit's directive is documentation, not repair: an inconsistency
inherited from the verified workbook is a documented property of the port, and "fixing" it silently
would break the byte-compatibility the golden tests guard. Every edge below is observed by a
warnings layer that rides BESIDE the ladder — it can never change a label, a quantity, a proposal
or a KPI.

**The three edges, normative.**

1. **The dead branch.** Branch 7's predicate `available > maxStock + maxStock×0.2` is algebraically
   identical to branch 1's `available > maxStock × 1.2` (`U + 0.2·U ≡ 1.2·U`); branch 1 always
   evaluates first, so branch 7 can never fire. It is KEPT — golden compatibility with the workbook
   outweighs the tidiness of deleting dead code, and the ladder must stay a verbatim port.
2. **The display/trigger band.** At `1.0 ≤ reorderPct < 1.01` the ladder's branch 6
   (`reorderPct < 1.01`) reads `Below Reorder` (when branches 1–5 are quiet) while the order trigger
   `orderRecQty = available < reorder ? orderQty : 0` is 0 — the display threshold sits at 101% of
   reorder while the trigger sits at 100%. `orderRecQty` is the trigger of record: no proposal is
   raised from the band. The band is workbook heritage, documented here and in §6, never "fixed".
3. **The impossible state.** A negative `available` cannot occur in physical stock; the workbook
   ladder classifies it `Below Safety` (red, never silent). The engine keeps that classification
   byte-compatible AND detects the impossibility explicitly — a classification the operator can see
   is not a classification they can trust without the detection beside it.

**The `warnings` array.** `computeRef` returns `warnings: string[]` — sorted, deterministic, present
on every row (`[]` when no edge applies), additive only: every pre-existing field keeps its exact
value and shape. The codes:

- `LADDER_DEAD_BRANCH_7` — emitted when `available > maxStock × 1.2`: the ref crossed the region
  where branch 1 fired and branch 7 (the workbook's duplicate) is shadowed. The dead-branch note
  rides the refs that cross the region, not every ref.
- `REORDER_DISPLAY_TRIGGER_BAND` — emitted when `reorderPct !== null && reorderPct ≥ 1.0 &&
  reorderPct < 1.01`: inside the band `orderRecQty` is 0 while the display threshold reads
  below-reorder.
- `NEGATIVE_AVAILABLE` — emitted when `available < 0`: the impossible state, detected and named
  beside its `Below Safety` classification.

**The sealed-payload consequence — disclosed.** The warnings array is part of the computed state of
a ref and enters the plan-seal payload (`refs[]`, §14.16's hash input): a day's anomalies are facts
about that day and belong in the tamper-evident snapshot. A replay of a pre-M14 sealed day therefore
lands `REPLAYED · divergent` with `refsChanged` naming every ref and `kpiKeysChanged` empty — the
shape of an additive change, disclosed by design, never applied. The seals themselves are untouched
(the past is immutable); an operator who wants the as-known-now form restates explicitly under
§14.16's rules.

**Named proof `core/ladder-edges`** — pins: the branch identity (a sweep across the boundary proves
`available > maxStock × 1.2` ⟺ `available > maxStock + maxStock × 0.2`, so branch 7 is unreachable);
the band (status `Below Reorder`, `orderRecQty` 0, the warning named); the impossible state (the
`Below Safety` classification kept, the warning named); warnings determinism (sorted, deep-equal
stable, JSON round-trip); and additive byte-compatibility (a ref's pre-existing fields identical to
their golden values with the warnings layer present).

---

## 14.20 Intelligence egress allow-list & prompt-injection stance — the outbound door, fail-closed (audit M13; named proof `intelligence/egress-allowlist`)

The audit's finding: "The Intelligence node needs a data-egress classification and a prompt-injection
stance. [S] Sending procurement data to a third-party LLM is an egress boundary in a 'closed
ecosystem.' No field allow-list, no cross-tenant prompt policy, no injection stance (supplier/item
names and task comments are attacker-influencable text; generated tasks are approval-gated — good —
state it as the *designed* containment)." The fix text: an egress allow-list (aggregates and
item/ref names only; no prices-per-supplier beyond what the analysis requires, no personnel data),
tenant-scoped prompts unless Origin explicitly consolidates, and a documented injection threat-model
entry. This section is that contract; the acceptance test is `intelligence/egress-allowlist` — **a
prompt containing a disallowed field is rejected before the API call.**

**The posture: default-deny holds; the door is the one named exception.** The closed ecosystem keeps
its §14.18 gate-6 posture — no egress call lands silently, the grep runs per commit. The Intelligence
node (screen 27, origin-only) is the ONE governed exception: an explicit allow-list door through
which every outbound request must pass, fail-closed, with the transport itself UNWIRED in this unit —
no HTTP client exists in the runtime surface, and the moment the Intelligence runtime lands, its
client goes through this door or does not go out at all. The door is a PURE decision layer (the
ledger/auth posture: the decision is unit-testable, the transport is the adapter's problem); it never
reads the network, never reads env, never stores a credential.

**The allow-list is policy data, not code.** The door carries an explicit outbound set — structured
entries, each: `id` (a stable name), `purpose` (what the call is for), `host` (the EXACT hostname the
transport must present — a hostname, never a URL literal, so gate 6's URL-literal rule keeps holding
over the runtime surface), `credentialSource` (the NAME of the env/secret-manager slot that holds the
key — never the value), and `fieldAllowList` (the exact data-field names that may leave). The initial
set is ONE entry — the LLM analysis call — whose field allow-list encodes the audit's data
classification: aggregates and item/ref names only; no prices-per-supplier beyond what the analysis
requires; no personnel data, ever. A field name not on the list does not leave — fail-closed, no
operator override, no "just this once".

**The door — `classifyEgress`, normative verdicts.** Every outbound request presents: the resolved
target host, the requested data-field names, the prompt envelope (operator-authored `instructions`
separated from ingested `dataFields`), the tenant scope, and the caller's role. The door refuses,
loudly and by name, BEFORE any transport can exist:

- `EGRESS_PROMPT_MALFORMED` — the prompt envelope does not separate instructions from data fields
  (the separation is the injection stance's structural core; a merged blob refuses).
- `EGRESS_HOST_NOT_ALLOW_LISTED` — the resolved host is not an exact match of an entry's host.
- `EGRESS_ORIGIN_ONLY` — the caller is not Origin (screen 27 is origin-only; §4's permission matrix
  holds at the egress boundary too).
- `EGRESS_CROSS_TENANT_REFUSED` — the request spans tenants without the explicit Origin
  consolidation flag. Prompts are tenant-scoped by default; consolidation is an explicit,
  logged act — never a silent aggregate.
- `EGRESS_FIELD_NOT_ALLOW_LISTED` — ANY requested data field is not on the entry's field
  allow-list. One disallowed field refuses the whole request — the audit's acceptance scenario,
  rejected before the API call, never redacted-after-the-fact.

An allowed request yields the **log envelope**: `{ host, purpose, fields (sorted), promptHash,
tenantScope, consolidation }` — and NOTHING else. `promptHash` is the SHA-256 hex of the RFC 8785
canonical form of the exact payload that would leave (§16.4: "Log a **prompt hash + field
allow-list** for Intelligence egress, not the content"). The prompt text never enters the envelope,
the log, or the ledger — the exfiltration path is auditable without copying the payload.

**The prompt-injection stance — the threat model entry, stated as design.** Ingested text (supplier
names, item names, task comments) is attacker-influenceable: a supplier can name itself
"ignore previous instructions" and the name is data Sentinel legitimately holds. The containment is
layered, and each layer is a named surface:

1. **Structural separation** — the envelope splits operator-authored `instructions` from ingested
   `dataFields`; the field allow-list bounds what data can ride at all; a malformed envelope refuses
   (`EGRESS_PROMPT_MALFORMED`).
2. **The output is a draft, never an actuator** — the Intelligence node produces versioned `.md`
   documents read in a reader pane (screen 27). Its output is never parsed as an instruction, never
   auto-applied to planning parameters, never converted into a proposal or task without the human
   approval doors (C3's SoD spine) that govern every other act. A prompt-injected sentence in a
   generated document is, at worst, text a human reads — the designed containment, now stated.
3. **The payload is hashed, not stored** — a breach of the Intelligence surface leaks no procurement
   content, because the content never rested anywhere: it left through the door, hashed into the log.
4. **Cross-tenant contamination is structurally refused** — tenant-scoped prompts mean an injected
   name from tenant A cannot ride a prompt about tenant B; consolidation is explicit and logged.

**Purity and wiring.** The module is pure (no IO, no env, no fetch — the host list and credential
slot NAMES are data, the transport arrives with the Intelligence runtime unit and goes through the
door). The door composes the ledger module's RFC 8785 canonicalization for the hash (the same JCS
the H5 chain uses — one canonicalization per system).

**Named proof `intelligence/egress-allowlist`** — pins: the audit's acceptance scenario (a prompt
carrying a disallowed field is refused `EGRESS_FIELD_NOT_ALLOW_LISTED` before any call); every
refusal verdict, including the malformed-envelope and cross-tenant cases; origin-only gating;
exact-host matching (a lookalike host refuses); the envelope's hash-only property (the prompt text is
absent from the envelope and unrecoverable from it); hash determinism (same payload → same hash,
JCS-canonical); and the allow-list's data classification (aggregates and names ride; prices beyond
the allowance, personnel data, and unknown fields refuse).

---

## 14.21 Disaster recovery — WAL archiving, the restore rehearsal, and the runbook (audit H11; named proof `dr/restore-rehearsal-gate`)

The audit's finding: "The contract has no disaster-recovery layer: no RPO/RTO, no backup/restore
requirement, no restore rehearsal. The cutover plan's rollback story ('the Excel DDS stays live for
4 weeks') is *business* continuity, not *technical* recovery. A platform that is the sole holder of
planning parameters, hash-chained history, and the learning corpus is a single storage accident away
from losing all three." The required fix: DR in the Definition of Done — RPO ≤ 15 min via continuous
WAL archiving; RTO ≤ 4 h; nightly logical backup + continuous WAL; quarterly restore rehearsal logged
as a ledger event; backup restore tested in CI-adjacent staging at least once before cutover. The
acceptance test: **a documented, dated restore rehearsal — not a unit test, a gate item signed by
Origin** (delivery-spec gate 14, named proof `dr/restore-rehearsal-gate`).

**The targets are normative and carried as frozen policy data**, not prose: `RPO_TARGET_MINUTES = 15`,
`RTO_TARGET_MINUTES = 240` (four hours), `REHEARSAL_CADENCE_DAYS = 90` (quarterly, plus the one
staging rehearsal before cutover that gate 14 requires). Loosening a target is a spec amendment,
never a code edit.

**Three layers, one gate.**

1. **The posture is the deployment contract** (delivery spec §7.4): the reference cluster runs
   `archive_mode = on` with continuous WAL archiving to durable storage (the RPO leg — worst-case
   loss is the archive lag), plus a nightly logical dump (the belt to the WAL braces). The repository
   owns the RUNBOOK, the gate and the harness; the deployment owns the cluster flags — the split is
   named so that neither side can wait for the other. `pg_dumpall --roles-only` precedes any
   cross-cluster restore: the migrations create the role floor (`sentinel_app`, `sentinel_verifier`)
   at the cluster level, and roles are not database objects — a dump restores grants, never roles.
2. **The gate is pure** (`packages/core/modules/dr`, dependencies: calendar — the H4 owner owns the
   day canon): `evaluateRehearsal(evidence, config)` is the verdict layer over rehearsal evidence.
   The evidence is injected — no IO, no env, no clock, no database — because a gate that measures
   itself cannot be trusted to grade itself. `config.expectedSchemaVersion` is REQUIRED (the
   unarmed-door posture: a caller that cannot say which schema it expects is a programming error,
   a loud TypeError, never a silent pass). The module also carries the two legs separately:
   `evaluateRestore` (the restore-path invariants — what any rehearsal, CI included, can prove) and
   `evaluateArchiving` (the WAL invariants — what the deployment/staging rehearsal proves).
3. **The harness is CI-adjacent staging, run on every push** (`scripts/dr/rehearsal.js`, the CI
   db-rls job): migrations → a baseline ledger block → `pg_dump` → checksum verified → the source
   database DESTROYED → `pg_restore` into a clean database → schema sentinel probe, RLS deny probe,
   chain verify through the ledger door. It collects the restore-leg evidence, runs it through the
   pure gate, and exits non-zero on any refusal — the restore path is proven on every push, so the
   pre-cutover rehearsal rehearses a drill that already works.

**The evidence schema** (all injected; `undefined` anywhere the schema names a field is
`REHEARSAL_EVIDENCE_MALFORMED` — undefined drops silently from JSON, the honest absence is null):

- `rehearsal: { day, environment, runbookVersion, executedBy }` — `day` is a canonical H4 date
  (validated through the calendar module's strict parse; the audit's word is *dated*);
  `environment` ∈ `staging | production` (a developer laptop is not a rehearsal venue —
  `REHEARSAL_ENVIRONMENT_INVALID`); `runbookVersion` names the RUNBOOK version followed
  (`REHEARSAL_RUNBOOK_UNVERSIONED` otherwise); `executedBy` names the operator or the harness job.
- `backup: { kind, checksumVerified }` — `kind` ∈ `base-backup | logical-dump`
  (`REHEARSAL_BACKUP_INVALID` otherwise; a "folder copy" is not a backup); the checksum must have
  been verified before the restore (`REHEARSAL_CHECKSUM_UNVERIFIED`).
- `wal: { archiving, continuous, rpoMinutes }` — `archiving` must be the literal `'on'`
  (`REHEARSAL_WAL_ARCHIVING_OFF` otherwise — the evidence does not show archiving on, whatever the
  reason); `continuous` must be `true` — no gaps in the archive between backup cut and restore point
  (`REHEARSAL_WAL_NOT_CONTINUOUS`); `rpoMinutes` is the measured worst-case data-loss window and
  must be ≤ 15 (`REHEARSAL_RPO_BREACH`).
- `restore: { rtoMinutes, restoredSchemaVersion, rlsVerified, chainVerified }` — `rtoMinutes` is the
  measured restore duration and must be ≤ 240 (`REHEARSAL_RTO_BREACH`); `restoredSchemaVersion` must
  equal `config.expectedSchemaVersion` (`REHEARSAL_SCHEMA_MISMATCH` — the detail names both);
  the RLS posture must have been re-proven on the restored copy (`REHEARSAL_RLS_UNVERIFIED`) and the
  hash chain must have verified green through the read-side verifier
  (`REHEARSAL_CHAIN_UNVERIFIED` — a restore that loses the chain's continuity has restored data, not
  the system).

**The verdict accumulates — a rehearsal report names every defect, in a normative order**
(rehearsal metadata → backup → wal → restore; deterministic and stable across runs). A gate that
stops at the first refusal serves nobody at 3 a.m.; the report is the fix-it list. PASS requires an
empty refusal list; a PASS yields the canonical record — `{ id: 'dr-rehearsal-<day>-<environment>',
day, environment, runbookVersion, executedBy, backupKind, checksumVerified, rtoMinutes,
schemaVersion, rlsVerified, chainVerified, verdict: 'PASS', refusals: [], scope }` plus, for the full
scope, `{ walArchiving: true, walContinuous: true, rpoMinutes }`. The record is deterministic: same
evidence, same record, byte for byte.

**The two legs and the scope rule.** The restore leg (backup + restore sections) is what any
rehearsal can prove — the CI harness proves it on every push. The full gate adds the WAL leg, because
RPO is a property of the *deployment's archiving cadence*, and only the staging/production rehearsal
can measure it honestly. `closeGate` accepts ONLY a full-scope PASS record: a restore-only record
refuses `GATE_SCOPE_INCOMPLETE` (the CI leg proves the drill works; it cannot close gate 14), a
non-PASS record refuses `GATE_REHEARSAL_NOT_PASSED`.

**The gate closure — the signed record is the ledger event.** `closeGate(record, signoff)` requires
the Origin signature: `signoff = { signedBy, signedRole, signedAt }` with `signedBy` a principal
uuid (never the literal `'system'`), `signedRole` exactly the Origin role code (`O` — the audit:
"a gate item signed by Origin"; anything else refuses `GATE_ROLE_INVALID`), and `signedAt` a
canonical UTC instant. A missing signoff refuses `GATE_NOT_SIGNED`. A closed gate yields the §16.2
event payload — `{ class: 'W', entity: 'dr_rehearsal', entityId: record.id,
action: 'RESTORE_REHEARSAL_RECORDED', outcome: 'success', before: null,
after: { record, signedBy, signedRole, signedAt }, reason: null }` — ONE block appended through the
ledger's append door (§16.3 rule 2 posture; the actor/role/session envelope rides the signer's
session at the door, and the ledger's §16.2 gate re-proves what this module checked). The rehearsal
is thus answerable by the same tamper-evident chain it just proved it can restore.

**The RUNBOOK — `docs/RUNBOOK.md`, `RUNBOOK_VERSION`-stamped.** The restore-rehearsal procedure is
the go-live gate's document: the pre-flight (archiving on via `pg_stat_archiver`, backup located and
checksummed), the timed restore into a clean staging cluster, the post-restore verification probes,
the evidence collection, the evaluation, the Origin signature and the single ledger event. The
freshness-alarm triage (M9), the quarantine review flow (C4/H10) and the ingestion incident playbook
live beside it, as the delivery spec's docs table requires. A rehearsal evidence set carries the
RUNBOOK version it followed — an unversioned procedure is not a procedure (`REHEARSAL_RUNBOOK_UNVERSIONED`).

**Named proof `dr/restore-rehearsal-gate`** — pins: the audit's acceptance shape (a full valid
evidence set passes and yields the deterministic record); both targets at their boundaries (15/240
pass; 15.01/240.01 breach, the detail naming the target); every refusal verdict including the
ordering pin (archiving-off is named before the RPO breach when both are wrong) and the accumulation
semantics (multiple defects, stable order, deterministic); the undefined-drops lesson
(`REHEARSAL_EVIDENCE_MALFORMED`); the two-leg scope rule (the CI's restore-only record is honest and
passes `evaluateRestore`, and cannot close the gate); the closure family (unsigned → `GATE_NOT_SIGNED`,
non-Origin → `GATE_ROLE_INVALID`, non-PASS → `GATE_REHEARSAL_NOT_PASSED`) and the exact event payload
that lands as `RESTORE_REHEARSAL_RECORDED`; the frozen targets and the unarmed-config TypeError.

## 14.22 The scale profile — the perf/load gate at 4,000+ refs (DoD #8; named proof `perf/mrp-scale`)

DoD #8 (§12): **"MRP board p95 < 500 ms at 4,000+ refs"**; delivery spec §6.3 names M5's
"perf/load pass at scale targets (§2 profile)". The business the platform exists to replace runs
~4,000 SKUs across 26 warehouses (§1 / CURRENT_STATE_RISK_ASSESSMENT) — so the scale profile is not
a stress fantasy, it is the REAL tenant measured before the first real tenant exists.

**What is measured — the engine-live run, not a microbenchmark.** The MRP board's server cost IS a
plan run: `runPlan` over the full portfolio (sort → assembleRef → the computeRef ladder per ref →
portfolio KPIs → KPI envelope → canonical-JSON payload hash). A harness that times anything narrower
(engine alone, one ref, a warmed cache) proves a number nobody asked for; the board p95 the DoD
names is the run boundary's p95.

**What is measured against — the §2/§12 profile, frozen as data** (loosening a target is a spec
amendment, never a code edit; mirroring H11's frozen-targets posture):

- `SCALE_REFS = 4200` — the portfolio size (≥ 4,000 refs, margin over the profile so the gate
  degrades before the tenant does); 1–3 recipe-member SKUs per ref (≈ 2.4 refs/SKU mix), two
  stock rows per SKU, one open-PO line per three SKUs, the 3-month consumption history per SKU,
  and a 90-day daily deliveries history — the §6.3 M1 window shapes, at scale.
- `SCALE_RUNS = 25` — measured runs after warmup; p50 / p95 / max reported in the proof's own
  output (the number is printed, not buried).
- `P95_BUDGET_MS = 500` — the DoD #8 budget, asserted. A breach fails the run non-zero: the gate
  is a gate, not a report.

**Determinism is part of the proof.** The synthetic dataset is generated by a seeded PRNG
(mulberry32, fixed seed) — the same seed builds the same portfolio on every machine, so a p95
regression is the code, never the data. No `Math.random`, no clock-dependent shape, no production
data (§ data governance): every SKU is `PERF-S00001…`, every tenant synthetic. The seeded dataset
is also a functional fixture — each measured run must return `SEALED` with the exact ref count;
a fast wrong answer is not a pass.

**Scope honesty.** This gate proves the SERVER boundary (the aggregation the engine owns). §8's
Lighthouse budgets (LCP/INP/CLS on the four primary screens) ride the staging build and the UI
compositions unit; the 4,000+-row grid virtualization rides the design handoff's build-phase list.
Both are named where they live — neither is smuggled into this proof, and this proof does not
claim them.

**Named proof `perf/mrp-scale`** — pins: the frozen profile constants; the seeded generator's
determinism (identical ref list across two builds); every run `SEALED` at exactly `SCALE_REFS`
rows; the p95 budget asserted with the measured percentiles printed; the breach path failing loud.

---

## 14.23 The image build & the container scan — the artifact becomes a subject (M12's fifth leg; named proof `build/image-gate`)

§14.18 closed gate 18 on four applicable gates + pinning + the egress backstop and DISCLOSED the
fifth leg: the container scan had no subject, because no Dockerfile existed. This section is the
subject arriving. The moment an image exists, the scan gates it — the scheduling disclosure is
retired, not silently forgotten.

**The subject — one image today, named honestly.** The tree's only long-running process is the
Next.js server (`apps/web`): it is the plan route's transport, the data-health / approvals / audit
surfaces, and the §14.13c API. The release artifact is the image `sentinel-web` (§6.2's naming —
`ghcr.io/<org>/sentinel-web:X.Y.Z` at tag time; CI builds and scans `sentinel-web:ci` on every push
and PR). The §6.2 `sentinel-worker` artifact has NO counterpart yet: `packages/ingest-service`
exposes `runFileToRows` — a library function, not a daemon. An image with nothing to exec is a lie
in a tag, so the worker image JOINS the worker-runtime unit (the queue-grouped poll loop of §7.4's
topology) exactly as the container scan joined this unit — named, not descoped. The e2e-smoke
ephemeral compose stack (§7.1 step 6) rides its own unit too: the compose file lands where it is
exercised.

**The image contract (normative):**

1. **Multi-stage, three stages, each with one job.** `deps` resolves the pnpm workspace from the
   frozen lockfile; `build` compiles the standalone bundle with the FULL toolchain; `runtime`
   carries ONLY the standalone output (`apps/web/.next/standalone` + `.next/static` + `public`).
   The runtime stage never sees the toolchain, the workspace sources, or the full `node_modules` —
   a smaller surface is a smaller attack surface, and a smaller SBOM.
2. **Every base image pinned BY DIGEST.** The builder is `node:22.22-bookworm-slim` pinned to its
   current digest; the runtime is `gcr.io/distroless/nodejs22-debian12:nonroot` pinned to its
   current digest. A floating tag is an unpinned dependency — the same exactness the pinning gate
   demands of npm is demanded of the base images. Bumping a digest is a reviewed diff, never a
   silent drift.
3. **Non-root, no shell, no package manager in the runtime.** The distroless `:nonroot` variant
   runs as UID 65532; every `COPY` into the runtime carries `--chown=nonroot:nonroot`; `USER
   nonroot` is explicit. The runtime stage has NO shell (distroless ships none) — a compromised
   process cannot spawn one. Consequently the container healthcheck is NOT a shell exec: it is the
   orchestrator's HTTP probe against the `/health` route (below). `EXPOSE 3000` documents the
   listener; nothing else listens.
4. **Standalone output is the build contract.** `apps/web` builds with `output: "standalone"` —
   the server.js bundle carries its traced runtime dependencies; `pg` stays external to the bundle
   (serverExternalPackages) and rides the traced node_modules. The standalone trace is the ONLY
   dependency story the runtime stage trusts; nothing is "copied just in case".
5. **No secrets in any layer.** The build args carry nothing secret (there is nothing secret at
   build time); runtime configuration (DATABASE_URL, the ledger key, the session wrap key) rides
   environment at exec. A leaked-layer review is part of the image-gate proof's stance: no ENV in
   the Dockerfile names a credential-shaped variable with a value.

**The `/health` route — the probe target and the §6.2 L-07 stamp.** §6.2 names `/health` as the
version-stamping surface (closes L-07's transport half) and the image needs a probe target; the
same route serves both. It reports the app version (the web package's own), `ENGINE_VERSION` (read
through the planning-engine module's public surface, ADR-0001) and `SCHEMA_VERSION` (read through
the db package's public surface) — the exact stamps a production question resolves to (§6.2). The
route is honest by construction: it renders what the running process imported, not what the build
declared somewhere else.

**The scan — M12's fifth leg lands.** Every built image is scanned by Trivy, pinned to an exact
version (the gitleaks posture — the tool version is part of the gate's identity), fail-closed on
HIGH and CRITICAL (`exit-code: 1`), matching §14.18's high+ threshold for dependencies. Unfixed
vulnerabilities in the base image count: the image is the runtime's whole world. The scan rides
the CI `build` job (§7.1 step 7) — merge-blocking like every gate before it.

**The waiver discipline — named, reasoned, retiring; never a mute button.** The gate's first real
run proved the contract works by firing on it: the distroless base it pinned carries `libssl3`
3.0.18-1~deb12u2 while Debian has published 3.0.19/3.0.20 fixes — six named CVEs (one CRITICAL,
five HIGH), all in ONE base-image library, all pending the distroless rebuild that ships the fix
(upstream's schedule, not ours). A gate that cannot be red is not a gate; a gate that stays red
on upstream's rebuild lag teaches the team to ignore it. The resolution is a WAIVER, with the
discipline that makes a waiver different from a mute: (a) waivers live in `.trivyignore` at the
repo root — the file Trivy reads natively — while `ignore-unfixed` stays FALSE, so an UNNAMED
future vulnerability still fails the build; (b) every entry names its CVE and carries a reason
that states the fix status and the retirement condition (for this class: "pending the distroless
rebuild shipping libssl3 ≥ 3.0.20-1~deb12u2 — the digest bump that retires this waiver is the
same diff that deletes the entry"); (c) the image-gate proof pins the file's EXACT entry set —
a waiver can never grow, shrink or drift silently; any change is a reviewed diff beside the
spec text that justified it. A waiver without a fix status and a retirement condition is
forbidden — it would be a mute button wearing a waiver's clothes.

**The SBOM — two subjects, two artifacts.** §14.18's security job publishes the REPO SBOM (the
dependency tree as the lockfile resolves it). This unit adds the IMAGE SBOM (SPDX-2.3, generated
from the built image by the Syft family tooling) attached to the build run. They are different
subjects: the repo SBOM answers "what do we develop with", the image SBOM answers "what ships".
Both are attached; neither substitutes for the other.

**Named proof `build/image-gate`** — the structural contract proven WITHOUT docker (the runtime
environment carries no daemon; docker proves the reality in CI, the proof pins the shape): the
Dockerfile's three stages; the FROM lines digest-pinned; the final stage distroless nonroot; every
runtime COPY carrying --chown; USER nonroot explicit; EXPOSE 3000 the only listener; no
credential-shaped ENV; the standalone output declared in next.config; the /health route present
and reading its versions from the public surfaces; the CI build job present with Trivy pinned,
HIGH+CRITICAL, exit-code 1, and the image SBOM artifact. A refactor that re-roots the image,
floats a base tag, drops the scan or mutes the exit code fails the proof before CI ever spends a
build minute.

---

## 14.24 The e2e-smoke — the ephemeral compose stack, the fence on screen (§7.1 step 6; named proof `e2e/smoke`)

§14.23 named the compose file as riding its own unit: "the compose file lands where it is
exercised." This section is that unit. The stack comes up on every push and PR, and what it
proves is deliberately NOT a browser tour — it is the deployment's spine walked over HTTP: the
real image (the same digest-pinned Dockerfile §14.23 scans) started by compose, against a real
PostgreSQL 16 migrated with the REAL migration files, and the assertions are the §8 honest
states — the ADR-0002 fence's named outcomes rendered on a real screen. The smoke answers one
question end to end: does this artifact, stood up the way a customer would stand it up, refuse
honestly when the data is not there and stamp itself truthfully when it is?

**The stack contract (normative):**

1. **Three services, named honestly — and no fourth.** `db`, `web` and `worker` — nothing
   else. §7.4's reference topology (redis, minio, keycloak, otel-collector) still has NO
   runtime consumer: no queue producer enqueues, no IdP is wired, no collector receives
   spans. A service with no consumer is set dressing, and the smoke does not ship set
   dressing. The `worker` service joined when its consumer landed — §14.25's watched-folder
   daemon IS a consumer (the operator's file drop produces its work), so the smoke now
   exercises it where a customer would run it: as a container beside the database, reading
   files nobody hands it in-process.
2. **Two images, one definition each.** Compose declares `sentinel-web:ci` and
   `sentinel-worker:ci` and NO build context on either — each image is built once by the job
   from ITS Dockerfile, and compose consumes them. Two build stories are two artifacts that
   can drift; the smoke-tested tags are the image definitions' outputs, full stop. (The
   container scan is §14.23/§14.25's gate on the image-build job; this job
   rebuilds from the same definitions — same Dockerfiles, same pinned digests — and does not
   duplicate the scan.)
3. **Every base image the stack pulls is pinned BY DIGEST.** `postgres:16` is pinned to its
   current multi-arch manifest digest — the same exactness §14.23's clause 2 demands of the
   Dockerfile's bases. Bumping the digest is a reviewed diff, never a silent drift.
4. **Loopback-only publishing.** The db's 5432 and web's 3000 publish to `127.0.0.1` only —
   the smoke's surface is the runner's loopback plus the compose-internal bridge, never
   `0.0.0.0`. A stack that advertises its database to the host network to make a test pass has
   failed a test more important than the one it passed.
5. **The compose credentials are not a secret.** An ephemeral throwaway database that exists
   for one CI job, published to loopback, destroyed by the teardown — no layer is built from
   it and nothing real is reachable with it; §14.23's no-secrets clause governs image layers
   and remains untouched.

**The database contract (normative):**

6. **Migrations are the SAME files.** The prepare script applies `packages/db/migrations/` in
   sorted order — the exact set the live proofs apply. One schema truth; no compose-side
   parallel migration path exists to drift from it.
7. **The service roles are the deployment shape, not the admin shortcut.** The prepare script
   creates `sentinel_web` AND `sentinel_worker` — each LOGIN, NOBYPASSRLS, non-superuser,
   member of the migrations' NOLOGIN `sentinel_app` (which carries the table grants). The
   web's `DATABASE_URL` connects as the former, the worker's as the latter — one role per
   long-running service, the way a deployment names them, so an incident's `pg_stat_activity`
   says which process did what. An admin-connection smoke would skip the very thing §14's
   RLS discipline exists to prove — the smoke connects the way production connects, and the
   GUC fence (ADR-0002) does the rest.
8. **The tenant registry is seeded, synthetically (D-003).** The smoke tenant is the screens'
   default code, so the assertion rides the URL a real user's first click produces; the
   registry insert is idempotent (`ON CONFLICT DO NOTHING`) because prepare must be re-runnable
   without apology.

**The smoke contract (normative):**

9. **HTTP, no browser — scope named.** §7.1 step 6's original text said Playwright; the
   as-built smoke asserts over HTTP what the server can prove at this stage, and the
   browser-level happy paths (ingest → plan → approve → PO → receive) ride the staging build
   (§7.2) — named, not descoped, the §14.22 pattern. This gate proves the STACK and THE FENCE:
   it does not claim §8's Lighthouse budgets and does not render a pixel off-screen.
10. **The assertions, each named.** (a) `/health` answers 200 with `ok`, `service`,
    `dataState`, `no-store`, and the §16 stamps — app, engine, schema — each EXACTLY equal to
    the workspace's real public-surface values, so the running image must BE this tree's code,
    not a neighbor's; (b) `/` renders 200 — the shell stands; (c) `/suppliers` with an unknown
    tenant code renders 200 with the fence's `TENANT` state verbatim — an unknown registry
    code is a named state, never a 500; (d) `/suppliers` with the seeded tenant (which has
    never sealed) renders 200 with the fence's `FRESHNESS` state verbatim — no seal, no
    freshness stamp, an honest refusal through the real path (§16's no-silent-numbers, walked
    in a container). A fence that returned 500s or invented data fails this smoke.
11. **Teardown is part of the contract.** `docker compose down -v` runs under `if: always()` —
    an ephemeral stack must not leak volumes, containers or state into the next run.
12. **The job is merge-blocking and proof-first.** No `continue-on-error`, no conditional skip;
    the named proof runs BEFORE any docker minute is spent (the §14.23 ordering, repeated),
    and the job needs the policy guard and the web shell — a red shell never reaches the stack.
13. **The walk — the worker's file through the real stack (the §14.25 follow-on, discharged).**
    After the HTTP assertions, the smoke drops the checksum-pinned golden suppliers fixture
    (H12 bytes, copied under a smoke name) into the worker service's bind-mounted inbox for
    the seeded tenant's folder, and waits for the file to settle. The assertions: (a) the file
    settles into `done/<TENANT_CODE>/` inside the poll window — the claim, the fence and the
    commit happened in the container, on the real database, with no test double in sight; (b)
    the register row is read back through a FENCED runner-side connection AS `sentinel_worker`
    (BEGIN → set_config → SELECT — the same fence the write rode, never the admin shortcut):
    kind `suppliers`, status `APPLIED`, and the checksum EXACTLY the fixture's pinned sha256 —
    the file that walked is byte-for-byte the file the fixture contract pins; (c) the REPLAY:
    the same bytes are dropped again and settle `done/` with the register STILL one row, the
    applied_at UNCHANGED — §4's "re-importing the same file changes nothing" walked live, the
    H6 idempotency proven against the real database instead of asserted against stubs. The
    inbox bind mount is world-writable on purpose and DISCLOSED: a CI-ephemeral directory,
    destroyed by the teardown, so the nonroot worker (UID 65532) can claim and settle inside
    it — the deployment's own inbox would be owned by its service user. The worker's AV
    posture is a NAMED declaration in the compose environment
    (`SENTINEL_WORKER_AV_REQUIRED=false` — this stack has no scanner and says so; §14.25's
    default stays fail-closed), never a silent bypass: a smoke that smuggled a stub scanner
    into the "real" path would prove a path nobody runs.

**Named proof `e2e/smoke`** — the structural contract proven WITHOUT docker (the runtime
environment carries no daemon; compose proves the reality in CI, the proof pins the shape):
the compose service set exactly (`db`, `web`, `worker` — and no `build` key on either
image service); the postgres
digest pinned; loopback-only publishing; the db healthcheck and the `service_healthy` gate;
`DATABASE_URL` connecting as `sentinel_web`, the worker's as `sentinel_worker`, and the
worker's inbox mount + AV declaration in its environment; the prepare script's migrations read from the
real directory in sorted order, BOTH roles created with the deployment shape, the membership
grants, the idempotent tenant seed, and the script's own role-shape verification; the smoke
script's assertion surface — every named assertion present, the version stamps asserted by
EXACT match against the real modules, the walk's fixture path, settle-poll, fenced register
read and replay-idempotency present, the nonzero exit on any red; and the ci.yml job text —
job name, needs, proof step first, the builds, the up/prepare/up sequence, the file drop and
the teardown under `if: always()`. A weakened or skipped smoke fails the same push that
weakened it.

The closed ecosystem is untouched: compose files and e2e scripts are tooling outside the
egress gate's runtime surface (ADR-0003's grep scope is unchanged), and the stack's only
network story is the compose-internal bridge plus the runner's loopback.

---

## 14.25 The worker runtime — the watched-folder poll loop, the fence per file, and the sentinel-worker image (§7.4's worker gets its consumer; named proof `worker/runtime`)

§14.23 named the worker image as joining "the worker-runtime unit (the queue-grouped poll
loop of §7.4's topology)" — named, not descoped, exactly as the container scan once joined
the image unit. This section IS that unit: the daemon arrives, and the image lands with it.
An image with nothing to exec was a lie in a tag; a daemon with no honest source would be a
lie in a process — so the source is settled first, honestly.

**The transport honesty — the poll loop polls the source that EXISTS.** The reference
topology (§7.4) draws the worker queue-grouped (Redis + BullMQ, §8's stack), but the tree
has NO producer: the web app ships no upload surface — no dropzone, no import route (the
closed-ecosystem inventory is itself the proof) — and §14.24's rule binds in BOTH
directions: a service with no consumer is set dressing, and a consumer with no producer is
theater polling an empty queue. So the runtime's poll loop polls the watched folder: M3's
worker header names `watched-folder` as a production source of `runFileToRows` (recorded
but never consulted — the H10 choke point does not care where bytes come from), and the
ingestion spec's §5 minimum viable daily drop IS a folder of files an operator drops daily.
The queue-grouped BullMQ transport arrives WITH its producer (the dropzone upload API, the
email-in gateway) — a named follow-on riding the producer's unit, the same naming
discipline that brought the scan here. D-046 records the decision.

**The contract (normative):**

1. **The daemon `apps/worker` — one poll loop, nothing listens.** Configuration rides
   environment at exec: `SENTINEL_WORKER_INBOX` (default `/data/inbox`), `DATABASE_URL`,
   `SENTINEL_WORKER_POLL_MS` (default 15000), `SENTINEL_WORKER_BATCH_MAX` (default 25). A
   missing `DATABASE_URL` refuses at BOOT with a named reason — a daemon that cannot reach
   the database is dead on arrival, and dead on arrival must say so, not idle. There is no
   port, no EXPOSE, no HTTP healthcheck: the poll loop's liveness IS the process, and the
   orchestrator's restart policy is the watchdog (the queue-era refinement comes with the
   queue). SIGTERM/SIGINT drain: the in-flight file finishes, the next cycle never starts —
   a stopped daemon never leaves a half-processed file outside `.claiming/`.
2. **The inbox layout is the identity model.** `inbox/<TENANT_CODE>/<file>` — the FOLDER
   NAME is the tenant code, resolved ABOVE the fence via `resolveTenantByCode` (the plan
   route's session posture: identity resolves first, then produces the fence's value). The
   file's own name is metadata (`declaredName` — recorded, never consulted, D-018's posture
   at the runtime layer): a file whose NAME carries another tenant's code is processed
   under the FOLDER's tenant, because the name does not speak for identity. An unknown
   tenant code refuses the file to `failed/` with a named log line — no register row can
   exist for a tenant that does not exist, and a fence needs a tenant; the limit is named,
   not hidden. A file at the inbox ROOT (no tenant folder) is unattributed and lands in
   `failed/_unattributed/` — the layout violation is a named outcome, never a silent skip.
3. **The claim: atomic rename, before any byte is read.** A claimed file is renamed into
   `<inbox>/<TENANT_CODE>/.claiming/` first — POSIX rename is atomic, so two pollers cannot
   both claim one file, and no file is ever processed in place where a second scan could
   double-claim it. Dotfiles and dot-directories are invisible to the scan (editor residue
   and the claim directory itself must never be mistaken for work). Orphaned claims — crash
   residue left in `.claiming/` — are processed DIRECTLY by the boot cycle as its first
   batch: H6's idempotency makes the reprocessing a no-op (REPLAY_NOOP), so recovery is
   safe by construction, not by bookkeeping.
4. **The fence per file (ADR-0002).** One pg client per file: connect → resolve the tenant
   (above the fence) → BEGIN → `set_config('app.tenant_id', …, true)` → the adapters bound
   to (client, tenantId) — `makeIngestWorkerAdapter` (the H10-pipeline ports) and
   `makeIngestAdapter` (the H6 executor), both through the db package's public surface
   (ADR-0001; the worker runtime is the consumer `makeIngestWorkerAdapter` was waiting for,
   and this unit adds it to that surface) → `runFileToRows` with source `watched-folder`
   and `asOfMs = Date.now()` (the daemon is the clock's injection point; the library stays
   clock-free) and the DEPLOYMENT'S DECLARED AV POSTURE (`avRequired` — M3's fail-closed
   default stands; a watched-folder deployment that runs no scanner declares it explicitly,
   and the declaration rides the caller into the gate — never a silent bypass) → COMMIT →
   the client closes. The GUC dies with the transaction; the fence
   is per file by construction.
5. **Outcomes → folders, the COMPLETE mapping.** `APPLIED` → `done/<TENANT_CODE>/`;
   `REPLAY_NOOP` → `done/<TENANT_CODE>/` (it changed nothing — §4's posture at the runtime
   layer); `QUARANTINED` → `quarantine/<TENANT_CODE>/` (the register row, the quarantine
   ledger and the tasks exist INSIDE the committed fence; the file waits for the operator);
   anything THROWN (an executor fault, the port seam breaking) → ROLLBACK → the FAILED
   register write through `markFileFailed` in a FRESH transaction WHEN the fault carries
   the file's BOUND identity (kind included — the worker.js contract's caller knew the
   kind; the queue/dropzone transports will) → `failed/<TENANT_CODE>/`; a fault WITHOUT
   the bound identity — the watched folder's honest case, since the daemon cannot name a
   kind for a file whose pipeline faulted before binding — writes NO register row
   (markFileFailed's own refusal family forbids a kind-less row: "a pre-binding refusal
   is never registered"), and the folder plus the log are the residue, the register
   carrying no guess; an UNRECOGNIZED verdict → `failed/<TENANT_CODE>/` (a receipt
   the runtime cannot name is a bug, and bugs go to failed/, never to done/). The mapping
   is exhaustive: every claimed file settles into exactly one folder — the inbox never
   keeps work, and no file is ever lost silently. The outcome folders preserve the tenant
   segment (`done/<T>/<f>`, `quarantine/<T>/<f>`, `failed/<T>/<f>`): the file register is
   in the database, but the folder an operator walks still says whose file it was.
6. **Poison isolation.** One file's failure never stops the cycle: the per-file catch
   isolates it, the loop continues, and the next file is not punished for its neighbor (the
   rev-1.2 module-isolation posture at file granularity). The daemon's log names the file,
   the stage and the reason — a 3 a.m. operator reads the failed/ folder and the log, not
   the source.
7. **The image `sentinel-worker` (§6.2's naming) — the §14.23 contract verbatim, one
   runtime story different.** Three stages, every base digest-pinned, distroless nonroot
   (UID 65532), no shell, no package manager, no secret in any layer. The difference is the
   dependency story: the web image trusts Next's standalone trace; the worker image trusts
   `pnpm deploy`'s pruned production tree — the daemon plus `@sentinel/ingest-service`
   (exceljs 4.4.0 exact-pinned, §4.1) plus `@sentinel/db` (pg) plus the core modules the
   ingestion boundary owns, and NOTHING else. `CMD` is the daemon; `EXPOSE` is absent
   because nothing listens.
8. **The scan and the SBOM: two images, one gate.** The `image-build` job builds and scans
   BOTH images — Trivy pinned, HIGH+CRITICAL fail-closed, `ignore-unfixed: false` — under
   the SAME pinned waiver set: the `.trivyignore` entries name base-image CVEs pending the
   distroless rebuild, that class covers every image the tree ships, and the digest bump
   that retires the waivers retires them for BOTH images in one diff. One image SBOM per
   image: what ships is what is attached, per subject.
9. **CI placement.** The `ingestion-tests` job (which already installs the workspace and
   already carries exceljs for the §4.1 suites) runs the worker runtime's named proof; the
   `image-build` job runs the image-gate proof extended to BOTH Dockerfiles before any
   docker minute is spent — the §14.23 ordering, repeated.

**Named proof `worker/runtime`** — pins the runtime's semantics WITHOUT a live database
(the fence's live posture is already walked by the db suites; the compose walk is the
e2e unit's named follow-on below): the claim's rename semantics (a claimed file is out of
the scan's reach before a byte is read; dotfiles invisible; root-level files unattributed);
the fence ORDER (resolve above BEGIN; the GUC set before any adapter statement — a stubbed
client records the statement sequence); the outcome→folder mapping EXHAUSTIVE (each verdict
lands in its named folder; a thrown executor fault rolls back and lands failed/ — the
FAILED register write rides a FRESH transaction and happens ONLY when the fault carries
the bound file identity (the watched folder cannot name a kind: markFileFailed's own
refusal family forbids a kind-less row, "a pre-binding refusal is never registered" —
the proof pins BOTH branches, and the queue/dropzone transports inject the identity
hook); an unrecognized verdict lands failed/); poison isolation
(file 2 processes after file 1 threw); the boot cycle re-claiming orphans FIRST; the batch
cap bounding a cycle; the unknown-tenant refusal to failed/ with no register attempt; the
identity rule (the folder speaks, the file's name never does); the drain (a stop signal
finishes the in-flight file and starts no new cycle); and the exceljs exact pin (4.4.0)
asserted in the worker's dependency story.

**Scope honesty.** This unit does NOT claim: the BullMQ transport (arrives with its producer);
§7.4's redis/minio/keycloak/otel services (still without consumers — still absent). The compose walk
was DISCHARGED by §14.24's amendment — the worker joined the smoke stack as its third service, and a
real file walked the real fence. The Mode-B per-kind fan-out was named here and is now ITS OWN unit
(§14.26 below). Each remaining item is named where it lives.

---

### 14.26 The Mode-B per-kind fan-out — the combined template's transport (§4's named follow-on, discharged; named proof `ingest/mode-b-fanout`)

INGESTION_FILE_SPEC §1 has promised Mode B since the day it was written — one combined
`Sentinel_Ingestion_Template.xlsx` workbook, 8 tabs, fixed headers, "Both produce identical results" —
and §4.1's worker refused every multi-tab workbook with `MULTI_KIND_WORKBOOK_NOT_WIRED` ("drop one tab
per file today") while the follow-on stayed named. This unit keeps the promise. The contract:

1. **The shape rule.** The pipeline branches on the FILE'S SHAPE, never on the mode label: one
   data-carrying bound sheet → the single-grid path, receipts byte-identical to the pre-fan-out
   worker; several bound sheets → the fan-out. The mode records as declared (the watched folder still
   runs mode 'A'; §1's modes are drop postures and §4's pipeline is identical for both).
2. **One register row per kind.** Each bound sheet rides the IDENTICAL downstream pipeline inside the
   SAME tenant fence — the H6 decision runs per (kind, checksum) — one H6 register row per kind under
   the file's checksum, structurally held by the register's
   `UNIQUE (tenant_id, kind, checksum_sha256)` (no schema change; SCHEMA_VERSION 0009 stands). Re-drops
   replay per kind: a workbook with one fixed tab replays the seven applied kinds as `REPLAY_NOOP` and
   applies the eighth.
3. **The named edges.** A tab binding no kind refuses the workbook whole (`NO_HEADER_ROW_FOUND`, the
   unbound tabs named beside the bound ones it refuses to half-serve); two data tabs binding one kind
   refuse whole (`MULTI_SHEET_KIND_COLLISION` — a duplicated tab would silently replay its twin
   through the shared (kind, checksum) identity); a bound tab with no data rows is the template's
   unused state — skipped and disclosed, never registered; every bound tab headers-only →
   `WORKBOOK_NO_DATA_ROWS`; a sheet whose rows all fail quarantines ITS kind's register row
   (`NO_SURVIVOR_ROWS`) while the others continue.
4. **The file's verdict aggregates honestly.** Any quarantined sheet → the file settles `quarantine/`
   (the folder grammar must not hide a tab whose data never entered; the detail names the applied and
   the refused kinds — re-drop after fixing the named tab, the applied kinds replay as no-ops); else
   any applied → `APPLIED`; else → `REPLAY_NOOP`. The receipt carries `fanout: true` and the per-sheet
   truth (`sheets: [{ sheetName, kind, verdict, … }]`); the daemon's outcome→folder mapping needs NO
   change — the aggregated verdict is in its enum.
5. **Transactionally whole.** One fence per FILE (ADR-0002 as written): any sheet's executor fault
   rolls back EVERY sheet — nothing half-commits, the file lands `failed/`.
6. **Attribution.** Data-health tasks raised inside a fan-out carry the sheet name (`payload.sheet` —
   the worker adapter's task context grows an optional `sheetName`, additive, `@sentinel/db` minor);
   the receipt's per-sheet entries carry each tab's counters, disclosures and banners (banners
   aggregate to the file level prefixed with the tab's name).
7. **The retired refusal.** `MULTI_KIND_WORKBOOK_NOT_WIRED` told operators to drop one tab per file —
   the instruction expires with this contract; the pin that held the line becomes the fan-out's own
   proof in the same diff.

**Named proof `ingest/mode-b-fanout`** (the `ingestion-tests` job, the file-to-rows worker suite):
the multi-kind workbook fans out with one register row per kind and the map disclosed; the
single-tab workbook's receipt is byte-identical to the pre-fan-out worker; the unbound-tab refusal
names both worlds; the same-kind collision refuses with the twins named and ZERO executor calls; the
headers-only template state is skipped and disclosed; the all-headers-only workbook refuses
`WORKBOOK_NO_DATA_ROWS`; the split outcome (one sheet applied, one quarantined) aggregates to
`QUARANTINED` with the split named in the detail and exactly one register row per kind; the
all-replay workbook aggregates `REPLAY_NOOP`; an executor fault on a later sheet propagates (the
caller's rollback is the contract's, not this unit's); and the `sheetName` attribution lands in the
task payload.

**Scope honesty.** This unit does NOT claim: the `Tenant` column split (§3.3 — "one workbook per
tenant, or add a `Tenant` column and the importer splits"; the watched folder's identity rule is the
folder speaks, the file's name never does — a tenant column needs a producer-side contract the tree
does not have, and the folder-per-tenant layout already serves the transport that exists); the
BullMQ transport (rides its producer); §7.4's redis/minio/keycloak/otel services (still without
consumers — still absent).

---

# 15. Audit remediation — SENT-AUDIT-002 (deep technical audit, $50M bar)

An independent deep technical audit re-verified this package and raised 40 findings. **Every empirical
claim it made was independently reproduced by probe and confirmed.** This section records what was fixed in
code and what remains as contract work. Test count is now **117 (86 engine + 31 feedback)**, including the SENT-AUDIT-003 residuals.

## 15.1 Fixed in code (tested)
| ID | Finding | Fix |
|---|---|---|
| **C1** | Purchase-unit → planning-unit conversion existed only as a warning; `conversionFactor` appeared 0× in shipped code | `toPlanningUnits()` / `convertPoLines()` — converts and **refuses when the factor is absent** rather than guessing. Unconvertible lines are returned for data-health. **Ingestion must call this before `openPO` reaches the engine** |
| **C2** | `portfolioKPIs` summed BHD and AED as one number (probe: 10,000+10,000 = 20,000) | KPIs take `tenantCurrency`; rows in another currency set `currencyMixed` / `valuesTrustworthy:false`. Normalization to tenant currency happens **at ingestion**, storing `documentCurrency` and `tenantValue` at the pinned rate |
| **M1** | KPIs bound to raw `status`: an unplanned ref counted as *Over Stock* while displaying *Not Planned*, with `serviceLevel = 1.0` over a dormant catalogue — **my own A1 fix not propagated** | KPI counts bind to `displayStatus`; `active` counts only `dataState === 'OK'`; new `unplanned` / `unplannedShare` KPIs. This removes a guaranteed day-one Over-Stock flood |
| **H1** | Preferred SKU weighted raw purchase quantities — 30 CTN (3,000 pcs) lost to 500 PCS | Weighting normalizes by conversion factor; `unitNormalized` + warning when a factor is missing |
| **H2** | Scorecard averaged nulls as zero — a perfect supplier with one in-flight PO read 50% fill rate, and that steers sourcing | Denominators include **due lines only**; `dueLines`/`openLines` exposed; `avgLateDays` returns `null` (not 0) when there are no late lines |
| **H3** | Price variance used the last receipt's price — two 500-unit partials at 2.0/3.0 reported variance 1.0 vs a true 0.5 | Quantity-weighted actual price; `MIXED_RECEIPT_PRICES` flag |
| **M2** | A proposal inside its decision window classified as `IGNORED`, unfairly scoring buyers | New `PENDING` outcome (age < per-tenant SLA); `actedRate` excludes in-window proposals |
| **M3** | Optimizer signals fired from 3 observations | `MIN_SAMPLE = 12` plus a `confidence` grade; below that, no signal |
| **M4** | `unitValue` collapsed to 0 when on-hand was 0, zeroing target/max value for in-flight refs | Falls back to item-master price with `unitValueFallback` flag |

## 15.1b Re-audit residuals (SENT-AUDIT-003) — fixed
| ID | Finding | Fix |
|---|---|---|
| **R1** | C2 containment was **fail-open**: mixed currencies set a flag but still returned the poisoned sum, and the tripwire only armed if the caller remembered to pass `tenantCurrency` | `tenantCurrency` is now a **mandatory positional argument (throws if absent)**, and mixed rows **withhold** `actualInvValue / targetInvValue / maxInvValue / actualDIO` as `null` with `kpiWithheld` + reason. A withheld KPI is an operational event; a wrong KPI is a wrong steering decision |
| **R2** | `serviceLevel` still returned 1.0 when nothing was plannable — the day-one lie M1 killed, via another door | `active === 0 → serviceLevel = null`; UI renders "insufficient plannable data" |
| **R3** | Missing conversion factor fell back to ranking **raw denominations**, re-creating the H1 bias (warn-only) | Unit errors now have **one philosophy: refuse, don't guess.** Missing factor degrades to the recency rule and raises `MISSING_CONVERSION_FACTOR` for data health |
| **R4** | Shelf-life cap rounded up past true cover | `Math.floor` on the cap |

## 15.2 Remaining contract work — required before go-live
**P0 (blocking).**
1. **C3 · Financial controls.** Add to §10: an **SoD invariant** (approver ≠ raiser, enforced at API *and*
   RLS), **value-tiered approval limits** by role, and **dual approval above a configurable threshold**.
   Also a **supplier-identity change freeze** with out-of-band verification. This is the most likely fraud
   vector at scale and the contract is currently silent on it.
2. **C4 · Strict numerics + plausibility bounds.** `nz('1,200') === 0` — corrupt data coerces silently to
   zero, reproducing the spreadsheet era's defining failure inside the platform. Ingestion must parse
   strictly and quarantine on failure; `nz()` is for genuinely optional fields only. Extend bounds to every
   quantity-bearing kind, and specify the deliveries-guard confirmation semantics (quarantine the value,
   run on the trailing 7-day mean, fire a data-health task, name the substitution in the UI banner).
3. **H5 · Ledger posture.** HMAC-SHA256 with a secret-manager key; **RFC 8785 (JCS)** named as the
   canonicalization standard with cross-implementation vectors; a hard invariant that **no actor, including
   Origin, may UPDATE or DELETE `LedgerBlock`** (RLS deny + trigger + test); purge restricted to business
   tables; verification job under a distinct read-only role.
4. **H6 · Tenant-scoped idempotency keys.** Four of six keys omit the tenant, so the same SKU imported for
   QatarMP would collide with BahrainMP. Prefix every key with tenant.
5. **H7 · Supplier ID.** Add `Supplier ID` to Precoro report R4 as **priority-1 [ADD]** and make it the
   identity key; free-text names fragment spend, scorecards and lead-time learning silently.
6. **H8 · Rate-window alignment.** Make it a normative ingestion invariant that the deliveries history
   covers the consumption window; refuse to seed otherwise.

**P1.** H4 date canonicalization (UTC date-only at the boundary, tenant timezone explicit) · H9 day-basis
(calendar-day input + per-tenant working calendar; `WD` becomes calendar-derived, with a flat-calendar
tenant byte-identical to today) · H10 ingestion hardening (magic bytes, zip-bomb caps, formula stripping,
XXE, AV; email-in through the same pipeline) · H11 disaster recovery (RPO ≤ 15 min, RTO ≤ 4 h, tested
restore rehearsal as a go-live gate) · H12 reproducible verification (ship the DDS/Precoro fixtures or a
redacted golden set, one canonical test count in CI, checksums manifest).

**P2.** M5 supply-status producers · M6 receipt→PO matching (split/amended/cancelled/returned) ·
M7 conversion-factor governance and versioning · M8 restatement vs sealed DayState · M9 freshness SLO and
missing-deliveries alarm · M10 FX stale-rate fail-safe · M11 MFA/session policy for all approval-capable
roles · M12 CI security gates (dependency audit, secret scanning, SBOM, licence, container) ·
M13 Intelligence egress allow-list and prompt-injection stance · M14 ladder edge documentation (branch 7 is
unreachable — keep for golden compatibility, document it, add a `warnings` array).

## 15.3 Standing rule
The audit's verified-properties list (V1–V12) is **binding**: formula fidelity, two-rate discipline, honest
degradation, the seasonality no-op, the double-order clamp, parameter provenance, the shelf-life guard, and
the closed-ecosystem posture must not regress. Any refactor breaking one is a regression against the audit.

---

## 15.4 Canonical test count (closes H12 drift)
**117 tests — 86 `engine.test.js` + 31 `feedback.test.js`.** This is the single source of truth; CI asserts
`count >= 117` by named suite. Audit reports quote the count as at their own date (46 / 88 / 111) and are
**historical records — do not edit them to match.** Only living documents track the current number.

---

# 16. Log scope — normative

*(Normative clauses, not a checklist. The prior text said "logs for every action and transaction", which an
implementer satisfies with write-only logging and is technically compliant. This section defines the full
scope, because "who exported the cost base" is an audit question the ledger could not previously answer.)*

## 16.1 The five log classes — all mandatory
Every class writes to the **same hash-chained `LedgerBlock` sequence** (§11) so ordering and tamper-evidence
are uniform. Class is a field, not a separate store.

**Class W · Write (business change).** Every create/update/delete of a business entity: SKUs, recipe refs,
planning parameters, targets, proposals, POs/PRs, transfers, tasks, approvals, suppliers, warehouses,
category ownership grants, custom-field definitions. Payload carries **before and after values** for every
changed field — a diff, never just "updated".

**Class A · Access (read & egress).** Mandatory for: **every export or download** (grid, report, PDF, xlsx —
with the row count and the filter/query that produced it), the **Consolidated all-MP view**, the
**Intelligence view**, **cross-tenant reads** performed under a grant, and supplier pricing views.
Routine in-tenant reads are **not** logged (volume without value).
*Rationale: exports are the exfiltration path for the entire cost base and were previously invisible.*

**Class N · Authentication.** All principals, not only Origin: sign-in success and failure, MFA enrolment and
challenge outcome, session creation and termination, lockout, password/credential rotation, IP-allowlist
changes. SCM and SBR approve spend; their sessions must be as accountable as Origin's.

**Class S · System.** Every machine-originated write: engine recompute, day-state seal, FX pin, ingestion
run, optimizer proposal generation, auto-task creation, scorecard rollup, ledger verification.
`actor = 'system'` **plus** the job id, trigger (schedule/manual/upload), `ENGINE_VERSION` and
`SCHEMA_VERSION`. Without this, "why did this ref's status change overnight?" is unanswerable.

**Class D · Denial.** Every refused action: RBAC denial, **SoD rejection** (approver = raiser), value-limit
breach, validation quarantine, failed idempotency check, rejected ingestion file, Intelligence egress
rejection. *For fraud detection, refusals are often more informative than successes — someone probing for an
approval path they should not have.*

## 16.2 Required fields (every block, every class)
`seq · class(W|A|N|S|D) · tenantId · actor(userId|'system') · onBehalfOf(nullable) · role ·
sourceIp · sessionId · entity · entityId · action · outcome(success|denied|error) · before · after ·
reason(required for denials and overrides) · engineVersion · schemaVersion · at(UTC, RFC 3339) ·
prevHash · hash`

## 16.3 Rules
1. **Origin is logged like anyone else**, and per H5 **no actor including Origin may UPDATE or DELETE a
   ledger block** (RLS deny + trigger + test). Supremacy means override, never erasure.
2. **Deny-by-default on failure:** if a ledger write fails, the business transaction **rolls back**. An
   unlogged change must not be possible. (Ledger write participates in the same DB transaction.)
3. **No secrets or PII in payloads** — no credentials, no banking fields (discarded at ingestion anyway),
   no full prompt text. Log a **prompt hash + field allow-list** for Intelligence egress, not the content.
4. **Timestamps are canonical UTC** (per H4); tenant timezone is a display concern only.
5. **Retention:** ledger retained for the life of the system, partitioned by tenant + date (§11).
   Class A and N retained ≥ 7 years. No class is prunable ahead of the others — pruning breaks the chain.
6. **Ingestion lineage:** each imported record carries the `importRunId` that last wrote it, so any field
   resolves to a file, a run, and a prior value. Conversion-factor changes are governed (M7) *and* logged.
7. **Surfacing:** the Audit & Time Machine screen filters by class, actor, entity and date, and the
   date-vs-date diff must show which blocks produced the delta.

## 16.4 Acceptance tests (wire into §13)
`ledger/class-coverage.spec` — one representative action per class W/A/N/S/D appends exactly one block with
all required fields · `ledger/export-logged.spec` — an xlsx export writes a Class A block with row count and
query · `ledger/denial-logged.spec` — an SoD rejection writes a Class D block with a reason · 
`ledger/system-actor.spec` — a scheduled recompute writes `actor='system'` with job id and engineVersion ·
`ledger/write-failure-rolls-back.spec` — a forced ledger-write failure aborts the business transaction ·
`ledger/origin-cannot-mutate.spec` — an Origin DELETE against `LedgerBlock` is denied and the attempt is
itself recorded · `ledger/no-secrets.spec` — payload scanner finds no credential/banking/PII patterns ·
`ledger/lineage.spec` — a field resolves to its importRunId and prior value.


---

# 17. Data-coherence mapping — Precoro source → Sentinel variable

*(Preserved from SENT-AUDIT-001, which is otherwise superseded. This table is the authoritative
field-level trace and must be kept current as ingestion is built.)*

| Sentinel variable | Precoro source | Status |
|---|---|---|
| `sku` | `SKU *` | ✅ direct |
| `recipeRef` | `Recipe Ref Name (…)` | ✅ direct — but coverage must be 100% on active SKUs |
| `conversionFactor` | `Conversion Factor*` | ✅ direct (0 nulls verified) |
| `onHand` | Inventory `Quantity` | ✅ direct |
| `invValue` | `Gross Total, Document Currency` | ✅ direct (ties to 109,138 BHD) |
| `unitPrice` | Items `Price *` | ✅ direct (0 nulls verified) |
| `openPO` | POs `Waiting (Quantity)` | ⚠️ **must be × conversion factor** before use — POs are in purchase units, planning is in converted units. A missed conversion here is an order-of-magnitude error |
| `quarantine` | — | ⚠️ derived from **`Warehouse Kind`**, which Precoro cannot supply (`Type` = `All` everywhere) |
| `histMonthly` | Inventory Report Start/In/Out/End | ⚠️ derivable, **but undated** — needs `Period Start/End` |
| `consPerDelivery` | consumption ÷ historical deliveries (deliveries dashboard) | ⚠️ derivable once the delivery history is supplied at any granularity |
| `deliveriesPerDay` | **deliveries dashboard** (not Precoro) | ⚠️ available daily/weekly/monthly/quarterly/YTD; entered manually and normalized by `normalizeDeliveries()`. Source exists — the gap is transcription, not data |
| `lead` | Suppliers `Delivery Period` | ❌ **84% blank** → `NO_LEAD_TIME` |
| `safetyDays`, `orderFreq`, `moq` | — | ❌ **Precoro planning fields are 100% empty** → `NO_PARAMS`. Sentinel originates these |
| `shelfLifeDays` | — | ❌ new field required |
| `preferredSku` | — | ❌ new field required (734 multi-SKU refs) |
| `realizedLeadDays` | needs **PO creation date** | ❌ **not exported** — blocks lead-time learning |
| `priceVariance` | needs **PO unit price** | ❌ **not exported** — blocks savings validation |
| `fillRate` | `Ordered` / `Received (Quantity)` | ✅ direct |
| `lateByDays` | `Delivery Date` vs `Receipt Dates` | ✅ direct |
| `paymentTermDays` | `Payment Terms` (prose) | ⚠️ parse required; `[ADD]` numeric column recommended |
| savings baselines | previous price only | ⚠️ budget / benchmark / bestQuote have **no source system** |

**Coherence verdict:** the *transactional* half maps cleanly and unambiguously. **Demand comes from a third
system (deliveries dashboard)** and is normalizable at any granularity. The *planning parameters* half has
**no source at all** — which is precisely the gap Sentinel exists to fill, and is why go-live depends on the
data-readiness project rather than on code.

**Degradation behaviour — verified by execution:** with no parameters the engine returns `reorder = 0` and
`NO_PARAMS`; with no deliveries it returns `dailyConsumption = 0` and `NO_USAGE`. It **fails visibly and
safely** — it never fabricates a plan from absent data. This is the correct behaviour for a system whose
inputs will be incomplete on day one.

---

**Degradation behaviour (verified by execution):** with no parameters the engine returns `reorder = 0` and
`dataState = NO_PARAMS`; with no deliveries, `dailyConsumption = 0` and `NO_USAGE`. It **fails visibly and
safely** and never fabricates a plan from absent data.

**The single most dangerous mapping:** `openPO` arrives in *purchase* units and must pass through
`toPlanningUnits()` before the engine sees it (§15.1 C1). A missed conversion is an order-of-magnitude
error in either direction — suppressed proposals or duplicate ordering — and both look plausible.

---

## 16. Per-tenant KPI dashboard (screen 34) — the KPI catalog

Every KPI is **defined once, as data**: definition, formula, source dataset, owner role, refresh
cadence and target band live with the `kpi-catalog` module (§14.15) and are rendered by screen 34.
The catalog below is the contract; changing a formula is a spec amendment **plus** a module
version bump through the §14.15 upgrade gates. Owners are accountable for the number; the data
steward (DTA) owns the plumbing behind it. Every KPI carries a freshness stamp from the last
sealed ingest that feeds it — a KPI computed on stale data renders an explicit *stale* state,
never a silent number. Targets are tenant-scoped and amendable per tenant without code change.
A KPI red for two consecutive reviews auto-creates a task for its owner and escalates to the
weekly KPI review (Atlas W-16; the human-readable glossary mirror lives in the Atlas KPI appendix).

### 16.1 Sourcing (SRC) — owner: SBR unless noted

| ID | KPI | Definition | Formula | Source | Owner | Cadence | Target / alert |
|---|---|---|---|---|---|---|---|
| SRC-01 | Supplier OTIF % | Receipts that are on-time **and** in-full vs PO lines due in the window | on-time-in-full receipt lines ÷ PO lines due × 100 | R1 POs + R2 receipts (receipt dates, received qty) | SBR | daily | ≥ 95%; < 90% red |
| SRC-02 | Fill rate % | Lines received complete vs lines ordered | complete lines ÷ ordered lines × 100 | R1 + R2 | SBR | daily | ≥ 97% |
| SRC-03 | Lead-time drift (days) | Realized P50 lead days minus agreed lead days, per supplier × category | P50(realized) − agreed | R1 promised vs actual + learning loop | SBR | weekly | ≤ +1d amber; +3d red |
| SRC-04 | Price variance % | PO unit price vs agreed baseline price | (PO price − baseline) ÷ baseline × 100 | R1 + price baselines | BYR | daily | within ±3% |
| SRC-05 | Single-source exposure | Share of active categories with exactly one approved supplier | single-source categories ÷ active categories × 100 | Supplier Scorecards single-source tile (A15.2) | SBR | weekly | ≤ 15% |
| SRC-06 | Top-5 spend concentration | Share of spend held by the five largest suppliers | top-5 supplier spend ÷ total spend × 100 | R1 spend | SBR / SCM | monthly | trend-monitored |
| SRC-07 | Realized savings % | Verified savings against the four baselines (screen 12) | realized savings ÷ addressable spend × 100 | execution-feedback module | SCM | monthly | > 2% YTD |

### 16.2 Inventory (INV) — owner: SCM unless noted

| ID | KPI | Definition | Formula | Source | Owner | Cadence | Target / alert |
|---|---|---|---|---|---|---|---|
| INV-01 | IRA % | Inventory record accuracy from ingested count adjustments (§14.12 measure-only) | 1 − (lines with variance beyond tolerance ÷ counted lines) × 100 | count sessions + ingested adjustments | DTA / warehouse owner | weekly per session | ≥ 98% |
| INV-02 | DIO (days) | Days of inventory outstanding | average inventory value ÷ daily COGS | inventory value + consumption | SCM | daily | tenant target band |
| INV-03 | Reorder-breach count | SKUs below reorder point at each recompute | count of status-below-reorder SKUs | engine output (screen 2) | SCM / BYR | every recompute | trend; auto-tasks |
| INV-04 | Service level % | Shortage-free plannable share (Amendment A16) | plannable refs without run-out ÷ plannable refs × 100 — the engine canon `1 − shortages ÷ active` | engine run-outs (per recompute) | SCM | daily | ≥ 97% |
| INV-05 | Dead stock % | Value with no movement in 60 days | dead-stock value ÷ total value × 100 | movement ledger (ingested) | SCM | weekly | ≤ 5% |
| INV-06 | Expiry-risk value | Value expiring within 7 days | Σ value(expiry ≤ 7d) | shelf-life + FEFO data | SCM | daily | ≤ agreed cap |
| INV-07 | Transfer reconcile rate % | Approved transfer plans verified against ingested movement (§14.7) | RECONCILED ÷ (RECONCILED + MISMATCH) × 100 | transfer plans + goods-in/out aggregates | SCM | daily | ≥ 95%; MISMATCH > 7d escalates |
| INV-08 | Quarantine aging (qty-days) | Open quarantine exposure over time | Σ(open quarantine qty × days open) | warehouse-kind reads (ingested, read-only) | warehouse owner | daily | downward trend |

**Amendment A16 (INV-04 grain).** This row originally read "shortage-free
SKU-days share — shortage-free SKU-days ÷ total SKU-days × 100". The verified
canon it must render (the planning engine, golden-pinned) computes the share
over **plannable refs** at a recompute: `1 − shortages ÷ active`, null when
nothing is plannable (R2). The KPI layer carried the difference as a disclosure
on every result (D-020) — a spec amendment, never a silent edit. This amendment
reconciles the text to the canon: the grain is the per-recompute plannable-ref
share, not a time-weighted SKU-day integral. The canon is untouched; the target
(≥ 97%) and cadence (daily) are unchanged; the catalog module adopts the amended
text with the module version bump the §16.8 governance requires.

### 16.3 Data Health (DAT) — owner: DTA

| ID | KPI | Definition | Formula | Source | Owner | Cadence | Target / alert |
|---|---|---|---|---|---|---|---|
| DAT-01 | Ingestion freshness (hours) | Hours since last successful per-tenant seal, worst across file types | now − last sealed ingest | pipeline | DTA | hourly | ≤ 26h; > 36h red + alarm |
| DAT-02 | First-pass acceptance % | Files passing all gates without manual repair | clean files ÷ received files × 100 | pipeline | DTA | daily | ≥ 90% |
| DAT-03 | Rejected-row rate % | Rows quarantined by validation gates | rejected rows ÷ ingested rows × 100 | pipeline | DTA | daily | ≤ 1% |
| DAT-04 | Duplicate-hit rate % | Idempotency keys seen before (re-upload hygiene) | duplicate keys ÷ ingested keys × 100 | pipeline | DTA | daily | informational |
| DAT-05 | Master-data completeness % | SKUs/suppliers carrying required fields (lead time, conversion factors, Supplier ID) | complete records ÷ population × 100 | master data | DTA | weekly | ≥ 95% |
| DAT-06 | FX pin coverage % | Lines normalized with the pinned tenant-day rate | pinned lines ÷ total lines × 100 | currency normalization | DTA | daily | 100% |

### 16.4 Team productivity (TM) — owner: SCM unless noted

| ID | KPI | Definition | Formula | Source | Owner | Cadence | Target / alert |
|---|---|---|---|---|---|---|---|
| TM-01 | Plan-to-execute latency (h) | Median hours from proposal APPROVED to the matching Precoro action | median(approved → matching PO/receipt) | feedback chain | SCM | daily | ≤ 48h |
| TM-02 | Reconciliation auto-rate % | Share of reconciliations completed without manual touch — measures the "Precoro executes, Sentinel plans + verifies" boundary working as designed | auto-RECONCILED ÷ total reconciled × 100 | §14.7 pipeline | SCM | daily | ≥ 90% |
| TM-03 | Exception backlog & age | Open MISMATCH plans, quarantine recommendations, recount flags — with age buckets | count + max age by type | tasks | SCM | daily | none > 7d |
| TM-04 | Approval SLA (h) | Median queue time by approval type | median(time in queue) | approvals (screen 20) | O / SCM | daily | ≤ 24h |
| TM-05 | Weekly active users | Distinct active users by tenant × role | distinct users / week | platform | O | weekly | adoption trend |

### 16.5 Project milestones (PM)

| ID | KPI | Definition | Formula | Source | Owner | Cadence | Target / alert |
|---|---|---|---|---|---|---|---|
| PM-01 | Cutover readiness % | Completed items across the cutover workstreams | done items ÷ total items × 100 | cutover project spec | O | weekly | on-plan curve |
| PM-02 | Data-readiness gates passed | Tenants × file types fully passing ingestion gates | gates passed ÷ gates planned | ingestion | DTA | weekly | all tenants × types by cutover |
| PM-03 | Milestone RAG index | Delivery-spec milestone status rollup | RAG per milestone | delivery spec | O | weekly | green |
| PM-04 | Open defect aging | Open defects by severity with age buckets | count + max age by severity | issue tracker | SCM / O | daily | no sev-1 > 48h |

### 16.6 Food philosophy & production adherence (FP) — owner: O unless noted

| ID | KPI | Definition | Formula | Source | Owner | Cadence | Target / alert |
|---|---|---|---|---|---|---|---|
| FP-01 | Spec adherence % | Production batches produced within the approved recipe spec | compliant batches ÷ batches produced × 100 | production approvals + consumption vs recipe refs | O / SCM | daily | ≥ 98% |
| FP-02 | Nutrition adherence % | Meals within the declared kcal / macro band | compliant meals ÷ meals produced × 100 | nutrition approvals (screen 20) | O | daily | ≥ 97% |
| FP-03 | Unapproved substitution rate % | Ingredient substitutions made without approval | unapproved substitutions ÷ substitutions × 100 | screens 20/21 | O | weekly | ≤ 1% |
| FP-04 | Allergen segregation compliance % | Storage/segregation checks passing | compliant checks ÷ checks × 100 | quarantine + warehouse-kind data | O / DTA | weekly | 100% |
| FP-05 | FIFO / shelf-life compliance % | Stock issues taken in FEFO order vs sampled issues; plus expiry write-off value | FEFO issues ÷ sampled issues × 100 | movement ledger | SCM | weekly | ≥ 98%; write-offs ≤ cap |
| FP-06 | Menu coverage at cutoff % | Menu ingredients holding cover ≥ cutoff horizon | covered ingredients ÷ menu ingredients × 100 | engine cover | SCM | daily (pre-cutoff) | ≥ 99% |

### 16.7 Inventory value charts (CH) — rendered on screen 34, per tenant and per tenant warehouse

| ID | Chart | Definition | Source | Owner | Cadence |
|---|---|---|---|---|---|
| CH-01 | Value trend by tenant | Daily sealed inventory value per tenant — tenant currency first, normalized view for cross-tenant reads | Inventory_All_Dimensions + Gross Total | DTA / VWR | daily |
| CH-02 | Value by warehouse | Value stacked by Warehouse Kind per tenant warehouse; quarantine/staging excluded from the Available overlay (§14.2) | same | VWR | daily |
| CH-03 | Value mix by category | Share of inventory value per category, per tenant | same | SCM | weekly |
| CH-04 | Value at risk | Value expiring within 7 days, by warehouse | shelf-life data | SCM | daily |

### 16.8 Governance

- **Definitions are data, not prose in code.** Screen 34 renders the catalog; the `kpi-catalog`
  module carries the evaluators. Formula changes = spec amendment + module version bump through
  the §14.15 gates (auto-pause, golden smoke, contract tests, resume-or-rollback).
- **No silent numbers.** A KPI missing fresh sealed input renders an explicit stale/unavailable
  state — §3's fail-closed, fail-visible rules apply to metrics too.
- **Ownership is explicit.** Every KPI names an accountable role; TM/PM exceptions route to tasks
  automatically; the weekly review is W-16.
- **Per-tenant targets.** Bands are tenant-scoped configuration, amendable without code change,
  and every change is a ledger event with actor and reason.
