# Sentinel Design System (SDS) — design specification

**For:** Claude Design. **Purpose:** create a new, robust design system and the full UI for **Sentinel**,
a multi-tenant supply-chain control platform. This replaces the previous "Astryx" direction entirely —
start fresh, keep nothing.

**Read alongside:** `SENTINEL_V3_BUILD_SPEC.md` (the logic/field/scope contract) and
`Sentinel_System_Graph.html` (the system map). Field names, statuses and screens bind to the build spec;
you own the visual system and interaction design.

---

## 0. Product in one paragraph
Sentinel is the planning brain for a GCC food group's supply chain. Precoro records transactions but holds
**zero planning parameters** — Sentinel supplies safety stock, reorder points, EOQ, order proposals,
accountability and analytics across tenants (Mountain Peaks: BahrainMP, QatarMP, more later). Users are
planners, BYRs and SCMs who live in it all day, scanning thousands of dense rows for the handful that
need action. **The product's job is to make exceptions impossible to miss and everything else quiet.**

---

## 1. Design principles (these drive every decision)

1. **Colour means something.** Chroma is reserved for *status, data and brand moments*. Interactive
   chrome — buttons, tabs, controls — is neutral. If everything is coloured, nothing signals.
2. **Density with air.** This is a high-information tool; rows are compact, but spacing is rhythmic and
   generous *between* groups. Dense ≠ cramped.
3. **Figures are first-class.** Every number is monospaced, tabular, decimal-aligned. Numbers are the
   product; type them like it.
4. **Flat and tonal.** Depth comes from background steps and spacing, never drop shadows.
5. **Calm by default, loud on exception.** A healthy screen should be almost monochrome. A shortage should
   be unmissable.
6. **Structure over ornament.** Alignment, hierarchy and rhythm carry the design. No gradients, no glass,
   no decorative illustration.

---

## 2. Foundations

### 2.1 Colour — dark-first, light variant required

**Neutrals (dark theme, cool graphite):**
| Token | Hex | Use |
|---|---|---|
| `--canvas` | `#0B0D0F` | app background |
| `--surface` | `#14171A` | cards, panels, table body |
| `--raised` | `#1B1F23` | popovers, modals, table header, inputs |
| `--overlay` | `#0B0D0FCC` | scrim |
| `--line` | `#FFFFFF12` | hairline dividers (~7%) |
| `--line-strong` | `#FFFFFF1F` | emphasis dividers (~12%) |
| `--text` | `#E8EBED` | primary text |
| `--text-2` | `#A2ABB3` | secondary |
| `--text-3` | `#6B757D` | tertiary / labels |
| `--text-disabled` | `#454D54` | disabled |

**Neutrals (light theme):** `--canvas #F4F5F6` · `--surface #FFFFFF` · `--raised #FFFFFF` ·
`--line #0B0D0F14` · `--line-strong #0B0D0F24` · `--text #14171A` · `--text-2 #545C63` · `--text-3 #7C858C`.

**Brand:** Brand green `#38B675`. Used **only** for the wordmark, the active-nav indicator, and focus-adjacent
brand moments. **Never** as a generic button colour.

**Interactive (neutral by design):** primary action = `--text` fill with `--canvas` label (dark) /
`--text` fill with white label (light). Secondary = `--raised` + `--line-strong`. Ghost = transparent.
Focus ring = `--info` at 2px, offset 2px.

**Status palette — semantic, never decorative:**
| Meaning | Dark | Light | Applied to |
|---|---|---|---|
| `--ok` | `#3FBF87` | `#0A7D4B` | OK |
| `--warn` | `#E8A33D` | `#A66300` | Below Reorder |
| `--critical` | `#F1656B` | `#B3122B` | Below Safety, Zero Stock |
| `--info` | `#4C9AF0` | `#1266D6` | Over Stock, focus, selection |
| `--pending` | `#A78BF5` | `#5B3BC4` | Follow-up with Supplier |
| `--muted` | `--text-3` | `--text-3` | Inactive |

Status fills use `color-mix(in srgb, <token> 14%, transparent)` with the token as text colour and a 6px dot.

> **Deliberate rule:** brand green (`#38B675`) and status green (`--ok #3FBF87`) are close but distinct, and
> brand green never appears in a data context. If this proves ambiguous in review, shift the brand to the
> wordmark only. Do not "fix" it by recolouring status.

**Data-visualisation palette (separate from status — this is a new requirement):**
Categorical series, ordered for maximum separation on dark, checked for deuteranopia distinctness:
`#4C9AF0` · `#3FBF87` · `#E8A33D` · `#A78BF5` · `#40C4C4` · `#F1656B` · `#8FA0AE` · `#D98BC8`.
Sequential ramp (value heat): `#132B44 → #1D4B72 → #2A6FA6 → #4C9AF0 → #9CC6F7`.
Diverging (variance vs target): `--critical → --text-3 → --info`.
**Never** use a status colour to encode a non-status series, and never rely on colour alone — pair with
label, shape or position.

### 2.2 Typography
- **UI:** `Inter` — 400 / 500 / 600. Headings 600, letter-spacing `-0.011em`.
- **Data:** `JetBrains Mono` — 400 / 500 for **all** numerals, IDs, SKUs, money, dates, percentages, deltas.
  Always `font-variant-numeric: tabular-nums`.
- **Optional display:** a pixel face (e.g. `Silkscreen`) for the wordmark **only** — never body or table text.

| Role | Size / line-height / weight |
|---|---|
| Display | 32 / 38 / 600 |
| Page title | 22 / 28 / 600 |
| Section title | 16 / 22 / 600 |
| Card title | 14 / 20 / 600 |
| Body | 13 / 20 / 400 |
| Table cell | 13 / 18 / 400 (mono 12.5 for figures) |
| Label / eyebrow | 11 / 14 / 600, uppercase, `+0.06em`, `--text-3` |
| Micro | 10.5 / 14 / 500 |

### 2.3 Grid, spacing, shape
- **8px base**, 4px sub-unit. Scale: `4 · 8 · 12 · 16 · 24 · 32 · 48`.
- Page padding 24 · card padding 16 · section gap 20 · inline control gap 8.
- 12-column content grid, 16px gutters.
- Radius: `sm 6` (inputs, chips) · `md 10` (cards, popovers) · `lg 14` (modals) · `full` (pills, avatars).
- **Density modes:** `comfortable` (row 44) and `compact` (row 36) — user-togglable, persisted. Default
  `compact` on MRP/Inventory, `comfortable` elsewhere.

### 2.4 Elevation & motion
- **Elevation is tonal:** `canvas → surface → raised`. Modals get `--overlay` scrim + `--line-strong` border.
  A single soft shadow is permitted *only* on floating layers (popover, modal, toast).
- **Motion:** `fast 120ms` (hover, focus), `base 200ms` (popover, drawer), `slow 320ms` (page/route).
  Easing `cubic-bezier(0.2, 0, 0, 1)`. Charts animate on mount only, never on every data tick.
  Honour `prefers-reduced-motion` — disable transforms, keep opacity.

### 2.5 Accessibility
Body text ≥ 4.5:1, large text and non-text indicators ≥ 3:1. Full keyboard operation including the MRP grid
(arrow navigation, `Enter` to edit, `Esc` to cancel). Visible focus everywhere. `aria-live` announcements when
a parameter edit recalculates a row. EN default, **RTL-ready structure** for Arabic (logical properties, no
hard-coded left/right).

---

## 3. Component library (design a component sheet first, then compose screens)

**Primitives:** Button (primary / secondary / ghost / danger / icon; sm-md-lg; loading, disabled) · Input,
Number input with stepper, Select, Combobox, Multi-select, Date picker, Date-range picker, Textarea, Checkbox,
Radio, Switch, Slider (for optimizer weights) · Tag · Status pill (both axes) · Avatar + stack · Tooltip ·
Badge/count · Breadcrumb · Tabs · Segmented control · Progress · Skeleton · Empty state · Toast · Banner.

**Data:** **Data grid** — sticky header, sortable, resizable, pinned first column, row hover, row selection +
bulk action bar, **inline-edit cell** with dirty state, expandable row → member-SKU modal, grouped rows,
column visibility menu, saved views, server pagination, virtualized to 4,000+ rows, loading skeleton, empty
state. · KPI stat card (label, mono value, delta, sparkline, target marker) · Definition list · Diff viewer
(date-vs-date, added/changed/removed) · Timeline / activity feed · Kanban column + card · Calendar/agenda ·
Tree (org, category) · Permission matrix grid (role × resource × action, tri-state cells) · File dropzone +
pipeline stepper · Import-history table · Command palette (⌘K) · Filter bar (chips + dropdowns + saved filters).

**Layout:** App shell (collapsible rail 240→64) · Top bar (title, search, ⌘K, MP switcher, Local↔USD toggle,
date/day-state control, density, theme, user) · Page header (title, subtitle, actions) · Card · Section ·
Split pane · Side drawer · Modal · Sticky action footer.

---

## 4. Charts (TanStack Charts)

**Library:** `@tanstack/charts` with the React adapter (`@tanstack/charts/react`). It is a D3-primitive
visualization grammar. **It is on the alpha line — pin an exact version** and wrap every chart in a local
`<Chart*>` component so the dependency is swappable. (Note: the older `TanStack/react-charts` package is
archived — do not use it.)

**Design requirements for every chart:**
- Axes/gridlines in `--line`; axis labels in `--text-3` at 11px; **all tick values in JetBrains Mono**.
- Series colours from the **data-viz palette** (§2.1), never the status palette.
- Tooltip = `--raised` surface, `--line-strong` border, radius `md`, mono figures, aligned label/value columns.
- Every chart needs **four states**: loaded, loading (skeleton), empty ("no data for this period"), and error.
- Always pair colour with a legend and direct labels where space allows. Include a target/threshold reference
  line where a target exists (DIO, inventory value).
- Responsive: charts reflow, never scroll horizontally on desktop.

**Chart inventory:** inventory-value trend (area, with target line) · DIO trend vs target (line) · business-unit
value split (donut) · warehouse value ranking (horizontal bar) · deliveries per day/week (bar, peak vs normal) ·
consumption run-rate (line + moving average) · status distribution (stacked bar rollup) · spend by
supplier/category (bar) · savings waterfall by baseline · price history multi-year (step line, per supplier) ·
supplier OTIF scatter (lead time × reliability) · document pipeline funnel · sparklines inside KPI cards and
grid rows.

---

## 5. Signature screens (design in this order; the first four set the language)

1. **Command Center** — KPI strip (inventory value vs target, DIO vs target, shortages, service level,
   deliveries today/YTD); stock-health rollup bar; top shortages by run-out; open work; overdue POs;
   data-health panel. A healthy day here should look calm and near-monochrome.
2. **MRP Board** — the heart. Virtualized grid at 4,000+ rows. Status chips with live counts; filters for
   status, category, warehouse, BU, **inactive**, **unapproved-nutrition**, **unapproved-production**.
   Two status columns (inventory axis + supply axis) that must read as clearly different things.
   Stock column shows **Available**. Row expands to a member-SKU modal.
3. **Planning Profiles** — four inline-editable params (lead, safety days, order frequency, MOQ) with derived
   read-only columns (Safety · Reorder · EOQ · Max · Cycle · Status) that visibly recompute on edit.
   Show the dirty/unsaved affordance and the recalculation moment.
4. **Parameter Optimization** — a dedicated comparison view: per recipe ref, `calculated | manual | override |
   ACTIVE` with the source tagged, proposed-vs-current delta, rationale, and accept / reject / accept-all.
   Optimizer weight sliders (cost ↔ service ↔ DIO). **Proposals never auto-apply** — design must make that obvious.
5. **Order Proposals** — grouped by supplier, MOQ and order-total checks, lifecycle OPEN → APPROVED →
   CONVERTED → DISMISSED, bulk select, "Download PDF" (there is no write-back to Precoro anywhere).
6. **Audit & Time Machine** — pick a date to view system state; pick a second to **diff** them side by side
   (stock, status flips, parameter changes, prices, tasks), with a chain-integrity indicator.
7. **Users & Permissions** — the permission matrix grid (role × resource × action × tenant scope) plus
   cross-tenant ownership grants `(user × category × tenant)`, since roles are regional.
8. **Data Upload** — dropzone with watched-folder/email-in states, then the automatic pipeline stepper
   (detect → strip tips → normalize units → validate → upsert → recompute → snapshot → tasks), import history,
   and a validation-failure/quarantine state.
9. **Intelligence** *(origin-only)* — list of Claude-generated versioned `.md` analyses per tenant and
   consolidated, a markdown reader pane, and "generate follow-up tasks (needs approval)".

Then the remaining screens per build spec §4: MRP Future, Demand & Forecast, POs, PRs, Imports & Landed Cost,
Pricing, Savings, Inventory Explorer, Warehouse Cost (cost/CBM), Transfers & Staging, Quarantine, IRA, Tasks,
Projects & Meetings, Approvals, Business Continuity, Lifecycle, Suppliers, Scorecards, Coverage, Analytics,
Consolidated, Item 360, Reference & Settings.

---

## 5b. New screens from the gap resolutions (design these too)
- **Origin Bootstrap** — a first-run guided flow: credential setup + 2FA, IP allowlist (GCC default),
  create tenants, roles, permission matrix, users, global settings and the canonical unit catalog. This is
  the **very first thing anyone sees**; design it as a confident setup wizard, not a settings dump.
- **First-run empty states** — Sentinel ships with **no data**. Every screen needs a state that names the
  missing dataset and links to Data Upload ("No inventory yet — upload today's Precoro export"). These are
  primary screens, not afterthoughts. **Never fabricate placeholder rows or show an endless spinner.**
- **Preferred SKU** — on the Recipe Ref detail/member-SKU modal: which SKU we actually buy, its supplier,
  why it was chosen (pinned / history / recent), alternates, and an *unresolved* state that visibly blocks
  approval.
- **Deliveries entry** — a compact control accepting daily / weekly / monthly / quarterly / YTD, showing the
  derived per-day rate live, a confidence indicator (coarser input = lower), and the variance guard when a
  figure deviates sharply from trailing history. Source is deliveries dashboard, entered by a named owner.
- **Demand Profile (TSRC)** — calendar windows (Ramadan, Eid, summer) with trend/seasonal/cyclical factors
  per tenant; the MRP board shows the active factor and what the flat baseline would have been.
- **Transfers** — inter-warehouse and **inter-tenant** transfer orders through
  DRAFT → REQUESTED → APPROVED → IN_TRANSIT → RECEIVED, with dual approval and a cross-tenant availability
  hint on shortage rows ("QatarMP holds 400 available").
- **Close-the-loop task drawer** — closing a proposal task captures **PO number, supplier, SKU, qty, price,
  expected date** as structured fields (PDFs attach as evidence), and **requires a reason code** whenever the
  buyer deviates. Design the reason-code picker as fast and blame-free — it is the learning payload.
- **Proposal adherence** — FOLLOWED / MODIFIED / SUBSTITUTED / IGNORED / UNSOLICITED per proposal, with
  realized lead time, fill rate and price variance; flags for SHORT_DELIVERED, LATE, PRICE_ABOVE_EXPECTED.
- **Missed shortages** — a distinct, prominent view: stockouts where **no proposal was ever raised**. This is
  the engine failing, and it must not be buried inside an adherence percentage.
- **Lead-time suggestions** — on the supplier record: observed p80 with sample size and confidence, the
  spread, and accept/reject. Must clearly read as *suggested from evidence*, never as a fact already applied.
- **Buyer Scorecard** — per buyer per category: savings by baseline, price trend, proposal adherence,
  stockouts/overstock, data-health completeness. This is a performance-review instrument — design it to be
  fair and legible, not a leaderboard.
- **Cycle Count Schedule** — ABC cadence calendar for company warehouses, count sessions, variance recounts.
- **Data Health** — the standing gap register: missing lead times, unresolved units, unmapped SKUs,
  refs without a preferred SKU, perishables without shelf life. Each row is actionable and assigned.
- **Module Management** *(Origin-only, screen 33 — rev 1.2 modular directive; lifecycle extended rev 1.3)* —
  the plugin registry surface: every module as a card with state `REGISTERED · ENABLED · PAUSED ·
  DISABLED · FAULTED`, health probe status, last fault, pinned version, dependency map, and the add /
  enable / pause / upgrade / disable / remove flows. Every transition is a ledger event. Upgrades show a
  staged progress track (compat check → paused → swap → golden → resumed) with the pinned previous
  version always visible. Design it calm and deliberate — this is a control room switchboard, not a
  settings page.
- **Module-unavailable states** — every module-owned surface needs an explicit "unavailable" state:
  module **disabled** by Origin (neutral, states who and why), module **paused** by Origin (warn, jobs
  held — maintenance or upgrade in progress), or module **faulted** (red, with retry hint and Data Health
  link). Dependents degrade visibly, never silently — fail-visible applied to architecture.

## 6. States to design (not just the happy path)
Row hover · selected rows + bulk bar · inline-edit active + dirty · expanded row modal · active filters ·
empty table · **skeleton loading** · error/retry · toast success + failure · permission-denied ·
**module disabled / module paused / module faulted** (explicit per-module unavailable states — rev 1.2,
paused added rev 1.3) ·
offline/stale-data banner · **exception-heavy screen vs calm screen** (show both — this is the product's
core contrast) · dark **and** light theme for Command Center and MRP Board · compact vs comfortable density ·
RTL sample of one screen.

---

## 7. Realistic content (use these; never lorem ipsum)
**Recipe refs:** Beef Topside · Tomato Peeled · Tender Chicken Breast · Basmati Rice · Feta Cheese ·
Rolled Oats · Olive Oil · Paper Meal Box · Napkins · Frozen Berries.
**Categories:** Protein Items · Dairy & Poultry · Fresh Fruits & Vegetables · Dry Goods · Spices ·
Packaging – Local · Packaging – Imported · Cafe Packaging · Baked Items · Kitchen & Cleaning Supplies.
**Warehouses:** Dry food and consumables WH · Fresh fruits & veg / Dairy Chiller · Pastry, Bakery Freezer ·
Protien items Freezer · Packaging and paper tissue · Kitchen shop floor area (staging) · Dispatch shop floor
area (staging) · Rejected/under inspection Space (quarantine) · External 3PL · Marketplace – Consignment.
**People:** Owner A · Owner E · Owner D · Owner B · Owner C · Owner F ·
Owner G · Owner H.
**Suppliers:** Supplier A · Supplier B · Supplier C · Cash Purchases.
**Scale to imply:** 3,993 SKUs · 1,395 recipe refs · 230 suppliers (84% missing lead time) · 26 warehouses ·
11,317 stock lines · 109,138 BHD valuation. *(These are realistic mock values for design comps only — the
real product ships empty and fills by ingestion, which is why the empty states matter so much.)* **Currency:** BHD/KWD 3dp, QAR/SAR/USD 2dp, mono, code suffix.

---

## 8. Deliverable
A downloadable **.zip** containing: (1) the foundations/token sheet, (2) the full component sheet, (3) every
screen in §5 in dark theme with the §6 states, (4) light-theme variants for Command Center and MRP Board,
(5) the chart set from §4, and (6) a `README` listing screens, components, tokens, and any deviations.

Bind all field names and statuses to `SENTINEL_V3_BUILD_SPEC.md`. Prioritise: tight alignment, consistent
8px rhythm, monospaced figures, calm-by-default with unmissable exceptions.
