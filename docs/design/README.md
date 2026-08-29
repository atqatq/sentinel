# Handoff: Sentinel — foundations, component sheet, and all 35 screens

## Overview

Sentinel is an inventory-planning application for a multi-tenant food operation (BahrainMP, QatarMP). The source system, Precoro, records transactions but holds zero planning parameters — Sentinel owns lead time, safety stock, reorder points, EOQ, order proposals, and the audit trail around them.

This bundle covers two deliverables:

1. **Foundations + component sheet** — the full visual system: colour, type, spacing, elevation, motion, and every primitive and data component rendered in its real states.
2. **The application** — a top-bar menubar spanning all ~35 screens, every one built at full fidelity. The first-run empty state is retained as a reachable pattern for screens whose datasets have not been ingested.

The product's governing idea: **a calm screen means a healthy day.** Colour is reserved for status, data, and brand. Interactive chrome is neutral. An exception is unmissable because it is the only saturated thing on screen.

## About the design files

The files in this bundle are **design references created in HTML** — prototypes showing intended look and behaviour. They are **not production code to copy directly.**

- `Sentinel App.dc.html` and `Sentinel Foundations.dc.html` are single-file streaming components written for a design-preview runtime (`support.js`). They use inline styles exclusively, a small `<sc-for>` / `<sc-if>` template dialect, and a `renderVals()` logic class. **None of that should survive into your codebase.**
- The task is to **recreate these designs in the target codebase's existing environment** — React, Vue, SwiftUI, whatever is already there — using its established component library, routing, state management, and data layer. If no codebase exists yet, choose the framework appropriate to the project and implement there.
- Read the HTML for *visual truth* (exact colours, spacing, type, states, copy) and read this README for *intent and behaviour*.
- `SENTINEL_DESIGN_SPEC.md` is the original design brief the mocks were built against. Where this README and the brief disagree, the brief wins on domain rules; this README wins on rendered visual detail.

Two known substitutions in the prototypes, both deliberate:

- **Charts are hand-built SVG.** The brief pins `@tanstack/charts` (alpha). The prototype could not install packages, so every chart is hand-drawn SVG matching the chart spec (axes, gridlines, target line, four states). In your build, use the real charting library and treat the SVG as a visual target, not an implementation.
- **Row virtualization is simulated.** The MRP Board renders 60 seeded mock rows and labels itself "virtualized to 4,000+". Real virtualization (TanStack Virtual or equivalent) is required in production — see *MRP Board* below.

## Fidelity

**High fidelity.** Final colours, typography, spacing, elevation, and interaction states. Recreate the UI to the pixel using your codebase's existing primitives. Every hex, size, and weight in this README is the intended production value.

Copy is also final where quoted. Domain copy in these screens is deliberate ("Proposals never auto-apply", "no fabricated rows · no spinner · dataset named above") — do not paraphrase it.

## Design tokens

Tokens are declared as CSS custom properties on `:root`, with a `[data-sds-theme="light"]` override and a `[data-sds-density]` override. Port them to whatever token mechanism your codebase uses. Theme and density must both cascade from a single root attribute — the prototype learned this the hard way; do not thread them through props.

### Neutrals — dark (default, cool graphite)

| Token | Hex | Use |
|---|---|---|
| `--canvas` | `#0B0D0F` | app background |
| `--surface` | `#14171A` | cards, panels, table body |
| `--raised` | `#1B1F23` | popovers, modals, inputs |
| `--hover` | `#22272C` | hover / selected chrome fill |
| `--line` | `rgba(255,255,255,.07)` | hairline dividers |
| `--line-strong` | `rgba(255,255,255,.12)` | emphasis dividers, input borders |
| `--text` | `#E8EBED` | primary text |
| `--text-2` | `#A2ABB3` | secondary |
| `--text-3` | `#6B757D` | tertiary, labels, units |
| `--text-disabled` | `#454D54` | disabled |
| `--inv` | `#0B0D0F` | text on a `--text`-filled surface (primary buttons) |

### Neutrals — light theme override

| Token | Hex |
|---|---|
| `--canvas` | `#F4F5F6` |
| `--surface` | `#FFFFFF` |
| `--raised` | `#FFFFFF` |
| `--hover` | `#EDEEF0` |
| `--line` | `rgba(11,13,15,.08)` |
| `--line-strong` | `rgba(11,13,15,.14)` |
| `--text` | `#14171A` |
| `--text-2` | `#545C63` |
| `--text-3` | `#7C858C` |
| `--text-disabled` | `#A9B0B6` |
| `--inv` | `#FFFFFF` |

### Brand

`--brand: #38B675`. Wordmark, active-nav indicator, bootstrap progress, brand moments only. **Never a generic button colour. Never in a data context.** Brand green and `--ok` are close but distinct by design; do not resolve the tension by recolouring status.

### Status — semantic only, two hexes per token

| Token | Dark | Light | Applied to |
|---|---|---|---|
| `--ok` | `#3FBF87` | `#0A7D4B` | OK |
| `--warn` | `#E8A33D` | `#A66300` | Below Reorder; stale data; MOQ shortfall; unsaved edits |
| `--critical` | `#F1656B` | `#B3122B` | Below Safety; Zero Stock; failures |
| `--info` | `#4C9AF0` | `#1266D6` | Over Stock; selection; recompute; focus ring |
| `--pending` | `#A78BF5` | `#5B3BC4` | Follow-up with supplier; unaccepted proposals |
| `--muted` | `#6B757D` | `#7C858C` | Inactive; Covered |

**Status pill recipe:** fill `color-mix(in srgb, <token> 14%, transparent)`, text `<token>`, a 6px dot in `<token>`, height 22px, padding `0 9px`, radius 999px, font JetBrains Mono 11.5px/500.

Never encode a non-status data series with a status colour. Never rely on colour alone — always pair with a label, a shape, or a position.

### Data-visualisation palette

Categorical, ordered for separation and deuteranopia-checked:
`#4C9AF0` `#3FBF87` `#E8A33D` `#A78BF5` `#40C4C4` `#F1656B` `#8FA0AE` `#D98BC8`

Sequential (value heat): `#132B44` → `#1D4B72` → `#2A6FA6` → `#4C9AF0` → `#9CC6F7`
Diverging (variance vs target): `#F1656B` → `#6B757D` → `#4C9AF0`

### Typography

**IBM Plex Sans** for all UI text. **JetBrains Mono** for **every figure, code, ID, timestamp, unit, and status label**. Two families only — there is no display or wordmark face.

The wordmark is IBM Plex Sans, 600 weight, all caps, at `letter-spacing: .18em` — 13px in the app top bar, 15px on sheet headers. The wide tracking is what makes it read as a mark rather than a heading; do not tighten it, and do not substitute a decorative or pixel font.

| Role | Spec |
|---|---|
| Page display | IBM Plex Sans 32/38, 600, `-0.011em` |
| Screen title | IBM Plex Sans 22/28, 600, `-0.011em` |
| Card title | IBM Plex Sans 16/22, 600 → 14/20, 600 for dense cards |
| Body | IBM Plex Sans 13/20, 400 |
| Secondary body | IBM Plex Sans 12.5/18, 400 |
| Table cell (text) | IBM Plex Sans 13, 400 |
| Table cell (figure) | JetBrains Mono 12.5, 400, `tabular-nums` |
| KPI figure | JetBrains Mono 25–26/30, 500, `-0.01em`, `tabular-nums` |
| Section label | IBM Plex Sans 11/14, 600, `+0.06em`, uppercase, `--text-3` |
| Micro / meta | JetBrains Mono 10.5–11/14, 400–500 |

`font-variant-numeric: tabular-nums` on every numeric cell and KPI — columns of figures must align.

### Spacing, shape, elevation

8px base with a 4px sub-unit: **4, 8, 12, 16, 24, 32, 48**. Page padding 24. Card padding 16 (bootstrap panel 24). Section gap 20. Inline control gap 8. 12-column grid, 16px gutters.

Radius: `sm 6` (controls, inputs, cells, chips), `md 10` (cards, panels), `lg 14` (modals, palette), `full 999px` (pills, dots, avatars).

**Elevation is tonal, not shadowed:** `--canvas` → `--surface` → `--raised`. Real shadows appear only on floating layers:
- popover / toast: `0 18px 44px rgba(0,0,0,.5)`
- modal / command palette: `0 30px 80px rgba(0,0,0,.6)`
- sticky save bar (upward): `0 -8px 30px rgba(0,0,0,.35)`

### Density

| Token | Compact | Comfortable |
|---|---|---|
| `--row` (table row height) | `36px` | `44px` |
| `--rowf` (cell figure size) | `12.5px` | `13px` |

Density affects table rows only — control heights do not change.

### Motion

`fast 120ms` hover/focus · `base 200ms` popover/drawer/toast · `slow 320ms` route. Easing `cubic-bezier(0.2, 0, 0, 1)` throughout. Charts animate on mount only. Under `prefers-reduced-motion: reduce`, drop transforms and animation, keep opacity.

### Focus

`outline: 2px solid var(--info); outline-offset: 2px` on `:focus-visible` for every interactive element. Selection: `color-mix(in srgb, var(--info) 30%, transparent)`.

## Layout shell

Applies to every screen.

**Top bar** — sticky, `z-index: 60`, `--surface` background, 1px `--line-strong` bottom border, height 52px, horizontal padding 16, gap 16. Contents left to right:

1. Wordmark cluster — 18×18 `--brand` square at radius 5, gap 9, "SENTINEL" in IBM Plex Sans 13px/600 caps at `+0.18em`.
2. **Menubar** (see below).
3. Flexible spacer.
4. Search trigger — 30px tall, `--raised`, 1px `--line-strong`, radius 6, "Search" at 12.5px `--text-3` plus "⌘K" in mono 11px. Opens the command palette.
5. Tenant switcher — 6px `--brand` dot plus tenant code in mono 12px. Cycles BahrainMP ⇄ QatarMP.
6. Currency segmented control — local (BHD / QAR, following tenant) vs USD.
7. Density segmented control — Compact / Comfortable.
8. Theme toggle — 30×30 icon button, `☾` in dark, `☀` in light.
9. Avatar — 26px circle, `#2A6FA6`, initials IBM Plex Sans 10.5/500.

Segmented control pattern: 2px padding, radius 6, `--raised` background, 1px `--line`; the active segment gets `--hover` fill, radius 4, `--text` label; inactive labels `--text-3`.

**Menubar** — 8 groups, each a 30px-tall ghost button that opens a dropdown on click. Once any menu is open, hovering a sibling switches to it (standard menubar behaviour). Escape and any outside click close it. The group button reads `--text` when the current screen belongs to that group, otherwise `--text-2`; the open group takes a `--hover` fill.

Dropdown panel: absolute, 36px below the trigger, `z-index: 80`, min-width 264px, 6px padding, `--raised`, 1px `--line-strong`, radius 10, the popover shadow, entering with a 120ms fade-and-4px-rise. Items are 13px, `7px 9px` padding, radius 6, `--hover` fill when current. Screens without an implementation carry a right-aligned mono 10px `EMPTY` tag in `--text-3`.

Groups and their screens:

- **Overview** — Command Center*, Analytics, Consolidated, Item 360
- **Planning** — MRP Board*, Calm vs exception*, MRP Future, Planning Profiles*, Parameter Optimization*, Demand & Forecast, Demand Profile (TSRC), Coverage
- **Buying** — Order Proposals*, Purchase Orders, Purchase Requests, Approvals, Imports & Landed Cost, Pricing, Savings
- **Inventory** — Inventory Explorer, Transfers & Staging, Quarantine, Cycle Count Schedule, IRA, Warehouse Cost, Lifecycle, Business Continuity
- **Suppliers** — Suppliers*, Supplier Scorecards*, Buyer Scorecard, Lead-time Suggestions, Preferred SKU
- **Work** — Tasks*, Projects & Meetings, Proposal Adherence, Missed Shortages
- **Data** — Data Upload*, Data Health*, Deliveries Entry, Audit & Time Machine*, Intelligence
- **Admin** — Users & Permissions, Origin Bootstrap*, Reference & Settings

`*` = built at full fidelity in this bundle.

There is **no sidebar** — this was an explicit decision that overrides the collapsible rail described in the original brief.

**Stale-data banner** — below the top bar when the newest ingest is older than one day: `color-mix(--warn 12%)` fill, `color-mix(--warn 26%)` top border, `7px 16px` padding, a 6px `--warn` dot, and copy naming the exact timestamp: "Precoro export is 2 days old — `2026-08-27 06:14`. Figures may be stale." Dismissible.

**Page header** — 24px page padding, then eyebrow (section label style, reading `<Group> · <Tenant>`), screen title (22/28, 600), and a one-or-two-sentence subhead at 13px `--text-2`, `max-width: 88ch`, `text-wrap: pretty`. Screen-specific actions sit right-aligned and baseline-aligned with the block.

**Button variants** — heights 28 / 32 / 38 (sm / md / lg), radius 6, weight 500:
- primary: `--text` fill, 1px `--text` border, `--inv` label
- secondary: `--raised` fill, 1px `--line-strong`, `--text` label, hover to `--hover`
- ghost: transparent, `--text-2` label, hover to `--hover` fill and `--text` label
- destructive: `color-mix(--critical 14%)` fill, `color-mix(--critical 40%)` border, `--critical` label
- icon: 32×32 square, secondary styling
- loading: primary fill with a 12px spinner ring; disabled: `--surface` fill, `--line` border, `--text-disabled` label, `not-allowed`

## Screens

### 1. Command Center

**Purpose.** The daily first stop. Answers "is today healthy?" in one glance, then lists only exceptions and numbers that have targets attached.

**Layout.** Five-column KPI row, then a 1.55fr / 1fr two-column body, 16px gaps, `align-items: start`.

**KPI cards** (×5). `--surface`, 1px `--line`, radius 10, padding 16, 10px gap. Section label; then figure (mono 25/30, 500) with a delta beside it (mono 12/500, coloured by whether the delta is good news, not by its sign); then a footer row with the target in mono 10.5px `--text-3` and an 88×26 sparkline. The five: Inventory value (`109,138` / `289,733` USD, `+2.4%` warn, target 105,000), DIO (`38.2`, `−1.6` ok, target 34.0 days), Shortages (live count, `+6` critical, "3 with no proposal"), Service level (`96.8%`, `+0.4` ok, target 98.0%), Deliveries today (`41`, YTD 8,204, run-rate 38.6/day).

**Stock health card.** A single 10px stacked bar, radius 999px, 1px gaps between segments, one segment per inventory status sized to its share of 1,395 refs. Below it, a wrapping legend row (`gap: 8px 20px`) where each entry is a button — 7px status dot, label at 12.5px `--text-2`, count in mono 500 `--text`. **Clicking a legend entry navigates to the MRP Board pre-filtered to that status.** Header reads "Stock health" with "1,395 recipe refs" right-aligned in mono 11px.

**Top shortages by run-out.** Six rows, sorted ascending by days-to-run-out, drawn from Below Safety and Zero Stock only. Columns: Recipe ref (IBM Plex Sans 13) · Available (mono, right, `--critical` at zero) · Run-out (mono, right, "now" at zero, else `1.4d`) · Status pill · Owner (12.5px `--text-2`). Sticky-styled header row on `--raised`. Header action links to the MRP Board.

**Inventory value vs target.** Area chart, ~620×190 viewBox, full-width. Five horizontal gridlines in `--line` with mono 10px `--text-3` labels ("80k"…"120k") on a 42px left gutter. A dashed `--warn` target line at 105k, labelled "target 105,000 BHD" right-aligned above it. Series: `color-mix(--info 14%)` area fill, 1.8px `--info` stroke, 3.5px `--info` end dot. Twelve monthly points, x-axis labelled Sep 25 / Dec 25 / Mar 26 / Jun 26.

**Right column, three cards.**
- *Open work* — four rows, each a label plus mono 10.5px meta on the left and a mono 15px count on the right, coloured by urgency: proposals awaiting approval (9, info), follow-ups with supplier (5, pending), parameter proposals pending (7, neutral), missed shortages with no proposal raised (3, critical — labelled "engine failure, not buyer behaviour").
- *Data health* — header with a "5 gaps" critical count pill. Five entries, each a label and a mono value, a 4px progress bar over `--hover`, and "assigned <person>" in mono 10.5px. Suppliers missing lead time `193 / 230` (84%, critical) · refs without preferred SKU 112 (38%, warn) · unresolved units 46 (21%, warn) · unmapped SKUs 318 (52%, warn) · perishables without shelf life 27 (12%, info).
- *Overdue POs* — four rows, `auto 1fr auto` grid: PO id in mono, supplier name truncating with ellipsis at 12.5px `--text-2`, lateness in mono 11.5px `--critical`.

**Actions.** "Export" (secondary) and "Run recompute" (primary), both firing toasts.

### 2. MRP Board

**Purpose.** The working surface. 1,395 recipe refs across 26 warehouses, carrying **two independent status axes**: what stock says (inventory) and what supply is doing about it. A ref can be Below Safety *and* already covered by an open proposal — the board must show both without collapsing them.

The two axes are distinguished by shape, not only colour: inventory pills are **round** with a round dot; supply pills are **square-cornered** (radius 6), transparent-filled with a `color-mix(<token> 34%)` border and a **square** 6px marker.

**Status chip row.** "All" plus one chip per inventory status, each with a live count. Inactive chip: 28px tall, transparent, 1px `--line`, `--text-2`. Active chip: `color-mix(<token> 16%)` fill, `color-mix(<token> 40%)` border, `<token>` label. Chips are the primary filter and are mutually exclusive.

**Filter bar.** `--surface` card, radius 10, `10px 12px` padding, 8px gap, wrapping. Free-text input (230px) matching ref name, category, and owner. Three dropdown filters — Category, Warehouse, BU — each showing `<label> <value> ▾`; a non-default value turns the border `color-mix(--info 40%)` and the label `--info`. A 1px `--line` divider, then three checkbox toggles: Inactive, Unapproved nutrition, Unapproved production. Then a spacer, a live "N of 1,395 refs" count in mono 11.5px, and Reset.

**The grid.** `--surface`, 1px `--line`, radius 10, `overflow: hidden`; the scroll container is `max-height: min(64vh, 720px)` with both axes scrollable.

- Header row is `position: sticky; top: 0` on `--raised` with a `--line-strong` bottom border; cells are section-label type. **Every column header except the trend column is a sort toggle** — the active key renders `--text` with a ` ↑` / ` ↓` suffix and click cycles asc → desc.
- The checkbox column (36px) and the Recipe ref column are both `position: sticky` on the inline-start edge, with an opaque background that must match the row's own fill — including when the row is selected. Z-order: header corner 4, header 3, body sticky cells 2.
- Columns: checkbox · **Recipe ref** (sticky, min 210px; flags `NUT` / `PRD` / `INACT` follow the name in mono 10px `--text-3`; inactive refs render the name in `--text-3`) · Category · Warehouse · Available (mono, right; `--critical` and weight 500 when Below Safety or Zero Stock) · UoM (mono 11.5px `--text-3`) · Inventory status pill · Supply status pill · Safety · Reorder · Run-out · 8-day trend (72×20 sparkline, `--critical` when the ref is in shortage, else `--muted`).
- Row height is `var(--row)`; figure size `var(--rowf)`. Selected rows take a `color-mix(--info 7%)` fill.
- Clicking the checkbox cell toggles selection and must **stop propagation**; clicking anywhere else in the row opens the member-SKU modal.

**Bulk action bar.** Appears above the header when any row is selected: `color-mix(--info 10%)` fill, `color-mix(--info 26%)` bottom border, "N rows selected" in mono 12.5px `--info`, then Assign owner / Create proposal / Clear (primary).

**Empty state.** When filters exclude everything: 56px vertical padding, "No refs match these filters", a guiding line ("Clear a status chip or widen the category filter."), and a primary Reset filters button. **No spinner, no fabricated rows.**

**Footer.** "showing 1–60 · virtualized to 4,000+" in mono, plus Prev / Next.

**Production note.** The prototype renders 60 seeded rows. Real implementation needs windowed virtualization over 4,000+ rows with sticky columns intact, server-side sort and filter, and a stable row identity so selection survives re-sorting.

### 3. Calm vs exception

**Purpose.** A side-by-side proof of the product's core contrast. Same layout, same density, same components — only the data differs. Use it as the visual regression target for "does colour still mean something".

Two equal columns. The calm card takes a normal `--line` border; the exception card takes a `color-mix(--critical 34%)` border. Each has a header (title, subtitle, and a state badge — "no action" in ok, "14 need action" in critical), an 8px stacked status bar, eight rows (ref · available · status pill · 60×18 sparkline), and a closing note at 12.5px `--text-2`.

Calm: 94% ok / 4% info / 2% warn, "1,381 of 1,395 refs healthy". Exception: 66/14/13/7, "14 shortages, 3 with no proposal raised". Zero Stock rows carry a `color-mix(--critical 7%)` row tint.

### 4. Planning Profiles

**Purpose.** The four parameters that drive every derived figure. The screen's job is to make the consequence of an edit visible *before* it is saved.

**Formulas — implement exactly:**

```
safetyStock  = dailyUsage × safetyDays
reorderPoint = dailyUsage × leadTimeDays + safetyStock
EOQ          = max(MOQ, round(sqrt(2 × dailyUsage × 365 × orderCost / holdingCost)))
maxStock     = reorderPoint + EOQ
cycleDays    = EOQ / dailyUsage
status       = available === 0            → Zero Stock
               available < safetyStock    → Below Safety
               available < reorderPoint   → Below Reorder
               available > maxStock × 1.4 → Over Stock
               otherwise                  → OK
```

(The prototype uses `orderCost = 45`, `holdingCost = 1.8`; both should come from settings.)

**Layout.** An `aria-live="polite"` status line above the table announcing each recalculation ("Beef Topside recalculated — safetyDays = 7") in mono 12px `--info`. Then one table with a **two-tier header**: an upper tier spanning "Editable parameters" (4 columns, `--text`) and "Derived — read only" (6 columns, `--text-3`), and a lower tier naming each column in mono 10.5px. A 1px `--line-strong` vertical rule separates the ref column, the editable block, and the derived block.

Rows are 44px. The Recipe ref cell is sticky on the inline-start edge with an opaque fill, followed by a 6px dot that turns `--warn` when the row has unsaved edits.

**Editable cells** are 30px right-aligned mono number inputs, `--raised` fill, 1px `--line-strong`. When a value differs from the saved baseline the border becomes `color-mix(--warn 60%)` and the fill `color-mix(--warn 8%)`; the whole row picks up a `color-mix(--warn 5%)` tint and its sticky cell blends `--warn 8%` against `--surface`.

**Derived cells** are read-only mono, right-aligned, `--text-2`, except the status cell which uses its status colour. On recompute they flash `color-mix(--info 10%)` and fade back over 200ms — the "recomputed" signal. Legend in the card header: warn dot = unsaved, info dot = recomputed.

**Sticky save bar.** Appears at the bottom of the scroll container whenever anything is dirty: `--raised`, 1px `--line-strong`, radius 10, upward shadow, the line "Unsaved parameter changes. Derived columns above already reflect them; the MRP Board does not until you save.", then Revert (secondary) and Save & recompute (primary). Saving fires "Profiles saved — 1,395 refs recomputed".

### 5. Parameter Optimization

**Purpose.** Suggest parameter changes from observed evidence. **Nothing here is ever applied automatically.**

A `--pending`-tinted notice leads the screen: "Proposals never auto-apply / Nothing below is live until accepted. The ACTIVE column is what the MRP Board reads today."

**Layout.** 280px sidebar plus the table.

*Sidebar — optimizer weights.* Three sliders (Cost, Service level, DIO), each with a section label, a mono two-decimal readout, and a range input with `accent-color: var(--text)`. Below the divider, a **live interpretive note** that changes with the weighting: service leading cost by >15 → "Weighted toward service — expect higher safety stock and higher DIO."; cost leading by >15 → "Weighted toward cost — expect leaner safety stock and more shortage risk."; otherwise "Balanced weighting. Proposals will move parameters only where evidence is strong." Then a Re-run optimizer button.

*Table — proposed vs active.* Nine columns making the provenance chain explicit: Recipe ref · Parameter · **Calculated** · **Manual** · **Override** · **Active** (the only `--text` header — this is what the board reads, and it carries the winning value plus its source in mono 9.5px `CALCULATED` / `MANUAL` / `OVERRIDE`) · **Proposed** (value plus a signed percentage delta, `--warn` when it raises stock, `--ok` when it lowers) · Rationale (12/16px, max-width 240px, `text-wrap: pretty`) · Decision.

Rationales must cite evidence and sample size, e.g. "p80 lead time observed at 19d vs 14d stated; n=42, high confidence." and "Imported; n=9, low confidence. Review before accepting."

Rows are 52px. Undecided rows carry a `color-mix(--pending 4%)` tint and show Reject / Accept buttons; decided rows go transparent and show an `ACCEPTED` (ok) or `REJECTED` (muted) pill. Header shows "N pending of 7" plus Reject all / Accept all.

### 6. Order Proposals

**Purpose.** Turn shortages into supplier orders. **There is no write-back to Precoro** — proposals leave Sentinel as PDF, and the UI says so plainly.

**Lifecycle filter row.** OPEN (9) / APPROVED (4) / CONVERTED (22) / DISMISSED (3), each a mono chip that fills with its state colour when active: OPEN info, APPROVED ok, CONVERTED and DISMISSED muted. Right side: the sentence "No write-back to Precoro — proposals leave Sentinel as PDF." and a primary Download PDF.

**One card per supplier.** Header: group checkbox · supplier name (14px, 600) with mono meta beneath ("PR-2291 · 3 lines · lead p80 19d") · spacer · a **check badge** (square pill, square marker) reporting the order-level constraint — "MOQ met" ok, "Below MOQ — 1 line" warn, "Order total below free-freight 5,000" warn · order total in mono 15px with the currency code, labelled "order total" · a state pill.

Line table: Recipe ref · Suggested qty · MOQ (turns `--warn` when the suggested quantity falls below it) · Unit price · Line total · **Trigger** — the reason the line exists, in plain words ("Below Safety · run-out 1.4d", "Zero Stock · no cover"). Three decimal places for BHD.

### 7. Origin Bootstrap

**Purpose.** The very first thing anyone sees. Sentinel ships with no users, no tenants, and no data; this wizard establishes identity and the canonical unit catalog before any ingest.

**Layout.** 300px step rail plus a 24px-padded panel, 20px gap.

*Rail.* Seven steps. Each is a 20px numbered circle plus a label and a sub-label. Completed steps show `✓` on `--brand`; the current step shows its number on `--text` with a `--hover` row fill; future steps are outlined in `--line-strong` with `--text-3`. Below, a progress readout ("3 / 7") and a 4px `--brand` bar.

*Panel.* Eyebrow "Step N of 7" in `--brand`, the step title at 22/28, and a 70ch explanatory paragraph. Then the step body, then a footer divider with a contextual hint on the left and Back / Continue on the right (Continue becomes "Finish setup" on step 7, which routes to Data Upload).

The seven steps, with their intent copy:

1. **Credentials & 2FA** — "Sentinel has no users yet. This account becomes the origin owner — the only role that can create tenants and edit the permission matrix." Two-column read-only field grid; 2FA is mandatory for the origin role.
2. **IP allowlist** — "Restrict sign-in to known networks before any data lands." Four CIDR rows; `0.0.0.0/0` renders in `--critical` with a "not recommended" flag.
3. **Tenants** — "Each tenant is a separate planning universe with its own stock, parameters and proposals." BahrainMP (BHD, 3dp) and QatarMP (QAR, 2dp), consolidation currency USD, fiscal calendar Jan–Dec.
4. **Roles** — "Roles are regional, so a role is not a tenant." Director / Planner / Buyer / Viewer with scope descriptions.
5. **Permission matrix** — "Tri-state cells: allow, inherit, deny. **Deny always wins.**" A `150px repeat(4, 1fr)` grid over view / edit / approve / export. Allow = `--text` fill with `✓`; inherit = `--text-disabled` fill; deny = transparent with a `--line-strong` border. Legend required.
6. **Users** — invite rows with role and tenant scope.
7. **Unit catalog** — "Every ingested figure is converted to a canonical unit. Unresolved units block a ref from planning." KG / G / LTR / ML / PCS / CS / BOX / CBM with conversion notes. Hint: "After this, Sentinel is ready — but still empty."

### 8. Data Upload

**Purpose.** Where an empty Sentinel fills up. Every other screen's empty state links here.

340px left column plus the pipeline column. Left: dropzone (idle / drag-over / uploading), a **Run ingest** button that toggles the whole screen between two real outcomes, four ingest counters (rows read, upserted, failed, unresolved units), and a recent-ingest list with per-file result dots.

Right: the eight-stage **pipeline stepper** — detect, strip tips, normalize units, validate, upsert, recompute, snapshot, tasks — rendered horizontally with a connector bar that only turns `--ok` behind completed stages. Two states must both be designed: halted at *validate* (`--warn` glyph, everything downstream idle, banner "Validation stopped the run — 12 rows failed. Nothing was upserted.") and completed with skips (`--ok`, banner naming both the upserted and skipped counts). Below: the **column mapping** table (source header, sample value, target field, state — unmapped rows tinted `--warn` with a warn-bordered select) and the **validation failure** list keyed by original line number with a plain-language reason per row.

A partial ingest is always reported, never silently accepted.

### 9. Data Health

**Purpose.** The gap register. Sentinel's accuracy is capped by its worst dataset, so the gaps are a first-class screen rather than a warning banner.

Four KPIs — open gaps, refs blocked from planning, **unassigned gaps**, closed this month. Then the register: gap name · count (e.g. `193 / 230`) · coverage as a 4px bar plus "84% of scope" · **Blocks** (which screens degrade without it) · Owner · Severity pill.

The rule the screen enforces: every gap has a named owner. An unassigned gap renders its owner cell as "Unassigned" in `--critical` and tints the whole row `color-mix(--critical 5%)`.

### 10. Suppliers / Supplier Scorecards

**Purpose.** Sentinel's lead times come from observed deliveries, not supplier claims. This screen is where the two are compared, and it is the evidence source for Parameter Optimization.

One segmented control switches the two views; both share the layout. Left: the supplier table — Supplier · Refs · **Stated** · **Observed p80** (weight 500, `--warn` when it exceeds stated, `--ok` when it beats it) · On-time (`--critical` under 70%, `--warn` under 90%) · **Confidence** as a square pill carrying sample size (`n=42 high`, `n=9 low`, `no data`) · Spend YTD. Rows are selectable and drive the panel.

Right: the scorecard for the selected supplier — four stat tiles, then a **box plot** of observed lead time (box = IQR, heavy rule = p80, dashed `--warn` rule = the stated figure), then a suggestion block whose text is derived from the evidence, not templated: a gap upward proposes raising the stated lead time and names how many refs move; a zero gap says no change is proposed; a no-data supplier says no suggestion can be made and points at manual entry. Low-n suggestions are labelled as such.

### 11. Tasks

Three columns — **Blocked**, Open, Done — with four working filters (All, Mine, Blocked, Overdue). Cards carry a title, a one-line consequence, assignee avatar, due date, a mono kind tag (`BLOCKER`, `DATA GAP`, `REVIEW`, `APPROVAL`), and a state badge. Overdue cards take a `color-mix(--critical 30%)` frame and a "2d late" badge.

Tasks are generated by the board, so each one names the consequence of not doing it rather than restating its title.

### 12. Audit & Time Machine

**Purpose.** Every change is attributable and every past day is reconstructable.

Left: the audit chain table — When (mono) · Actor (a person or `system`) · Change with a status dot · **Before → after** with the old value struck through and the new value coloured by whether it is good or bad news · Hash. Header carries a "chain intact · 4,412 entries" `--ok` pill.

Right: the **time machine** — a 90-day range slider whose position re-derives four snapshot stats (inventory value, shortages, DIO, refs planned) live, plus a diff panel against today. Copy states the guarantee: "Snapshots are immutable — the board you see is the board that was."

### 8. Unbuilt screens — first-run empty state

The other 22 screens each render the same honest empty state rather than a fake dashboard. `--surface` card, 96px vertical padding, centred: a 34px dashed square, "No <screen name> data yet" at 16px/600, then a 52ch explanation that **names the missing dataset specifically** — "This screen reads observed delivery lead times. Nothing has been ingested for BahrainMP, so there is nothing to show — no placeholder rows, no spinner." Then Go to Data Upload (primary) and Back to Command Center (secondary), and a mono footnote: "no fabricated rows · no spinner · dataset named above".

Each screen has its own dataset sentence — lead-time suggestions read "observed delivery lead times", Cycle Count reads "ABC classes and count sessions", Data Upload reads "nothing — this is where data arrives", and so on. Keep this mapping; it is the honest version of an empty product.

## Component inventory

`Sentinel Components.dc.html` is the second reference sheet and covers the machinery the screens are assembled from. Seven groups:

**01 Overlays & menus** — dropdown menu (sections labelled, mono shortcut hints, destructive item separated and last), popover holding a form, three tooltip kinds (formula, chart series readout, blocked), decision dialog, destructive confirm (arms only when the count is typed), detail drawer, context menu, notification centre. Popovers hold forms, menus hold actions; never mixed.

**02 Table machinery** — editable cell in seven states (read, hover, focus, dirty, invalid, saved-flash, locked), the provenance stack (calculated → manual → override → ACTIVE), header cell states (rest, hover, sorted asc/desc, pinned), column manager with drag handles and pinning, saved views, pagination, a cell type catalog (text, figure+unit, currency, delta, both pill shapes, trend, owner), row expansion, and skeleton rows sized to the real row height.

**03 Data entry** — field anatomy in three states (normal with hint, invalid with rule, read-only), stepper with unit suffix, currency prefix field, unit conversion rows including the unresolved case, combobox, scope token input, role/permission tokens, date range with presets, keycap hints, note field.

**04 Ingestion** — dropzone (idle, drag-over, uploading), ingest summary counters, the eight-stage pipeline stepper stopped at a validation failure, column mapping table with unmapped rows flagged, and the validation-failure list keyed by original line number.

**05 Workflow & audit** — lifecycle track (past / current / future / terminal), approval chain rows with per-role actions, task card with blocker badge, comment thread with reply, audit entries carrying hashes, chain-intact confirmation, time-machine control, diff viewer, and the tri-state permission matrix.

**06 Charts** — six hand-built SVG targets: stock projection with a run-out crossing, inventory waterfall, lead-time box plot, KPI bullet bars (bullets, not gauges), shortage heat calendar, and a category donut. Rebuild these on the real charting library; the rule they encode is that only status-bearing marks get status colour.

**07 Loading, empty, error** — the six states every data surface must ship: loading skeleton, first run (names the missing dataset), filtered-empty (data exists, query too narrow), error (states what failed and offers one retry), blocked (names who can clear it), and no-permission (explains the rule rather than hiding the control).

## Overlays

### Member-SKU modal

Opened by clicking any MRP Board row. A recipe ref is a planning unit that groups several purchasable SKUs, and this modal is where that mapping is inspected and resolved.

`rgba(11,13,15,.8)` scrim, `z-index: 90`, 32px padding. Panel: `min(880px, 100%)`, `max-height: 82vh`, scrollable, `--surface`, 1px `--line-strong`, radius 14, the modal shadow.

Header: eyebrow "Recipe ref · member SKUs", the ref name at 18px/600, and a mono meta line (category · warehouse · available · run-out), plus a close icon button.

Body:
- **Preferred-SKU banner.** Two states. Resolved: `--ok` tint, "Preferred SKU · pinned", with who pinned it, when, and why ("best landed cost across last 12 receipts"). Unresolved: `--critical` tint, "Preferred SKU unresolved — approval blocked", "Two SKUs have equal purchase history and no pin. A buyer must choose before a proposal can be approved."
- **Member SKU table.** SKU (mono) · Supplier · Available · Lead p80 (coloured by whether it beats the stated lead time) · Last price · Role pill — `PREFERRED` (ok) / `ALTERNATE` (muted) / `SPOT` (muted), all becoming `CANDIDATE` (warn) while unresolved.
- **Consumption run-rate** sparkline (320×74) beside a **cross-tenant availability** panel: an info-tinted row ("QatarMP holds 400 available"), a Request transfer button, and the rule in 11.5px — "Inter-tenant transfer needs dual approval — DRAFT → REQUESTED → APPROVED."

Footer on `--raised`: Close, then Create proposal (primary).

### Command palette

`⌘K` / `Ctrl+K` toggles; Escape closes. `rgba(11,13,15,.72)` scrim, `z-index: 100`, 12vh top padding. Panel `min(560px, 100%)`, `--raised`, radius 14, modal shadow. Header: "⌘K" in mono, a borderless 14px input ("Jump to a screen, ref or action"), and "esc" in mono 10.5px.

Results are grouped by a 52px mono 9.5px kind column — `SCREEN` / `REF` / `ACTION`:
- **Screens** — up to 6 name matches; unbuilt ones show "empty" as meta.
- **Refs** — up to 5 name matches; with an empty query it lists current shortages instead. Meta is the inventory status in its own colour. Selecting one opens the MRP Board with that ref's modal already open.
- **Actions** — Create order proposal (meta "⏎"), Toggle theme (meta = current theme), Upload Precoro export.

Rows hover to `--hover`. Empty query with no matches: "Nothing matches that."

### Toast

Fixed bottom-inline-end, 24px inset, `z-index: 110`, `--raised`, 1px `color-mix(<tone> 34%)`, radius 10, popover shadow, entering with the 200ms rise. An 18px circular glyph (`✓` ok / `!` warn / `i` info) on a `color-mix(<tone> 20%)` fill, then the message at 12.5px. Auto-dismiss at 3.2s. Messages name their scope: "Profiles saved — 1,395 refs recomputed", "Optimizer re-run — 7 proposals, none applied".

## Interactions & behaviour summary

| Trigger | Behaviour |
|---|---|
| Menubar group click | Opens dropdown; sibling hover switches while open; Escape or outside click closes |
| `⌘K` / `Ctrl+K` | Toggles command palette, clearing the query |
| Escape | Closes palette, modal, and any open menu |
| Theme / density toggle | Writes `data-sds-theme` / `data-sds-density` on the document root — must be applied from the handler, not derived downstream |
| Tenant switch | Cycles tenant; local currency code follows (BHD ⇄ QAR) |
| Status chip / stock-health legend | Sets the MRP Board inventory filter; legend also navigates |
| Column header click | Sorts asc, then desc; text columns sort lexically, numeric columns numerically |
| Row checkbox | Toggles selection (stops propagation); bulk bar appears at ≥1 |
| Row body click | Opens the member-SKU modal |
| Parameter cell edit | Sanitises to a non-negative number, recomputes derived columns immediately, flashes them `--info`, marks the row dirty, announces via `aria-live`, and reveals the save bar |
| Save & recompute | Commits, clears dirty state, toasts |
| Revert | Drops all pending edits |
| Accept / Reject / Accept all / Reject all | Records a decision per proposal row; `ACTIVE` never changes until accepted |
| Weight slider | Updates the readout and the interpretive note live |
| Filter change | Re-filters and re-counts; zero results shows the empty state, never a spinner |

## State

Screen-level state in the prototype, as a guide to what the real implementation needs:

**Navigation & chrome** — `screen`, `navOpen`, `theme`, `density`, `tenant`, `currency`, `palette`, `paletteQ`, `stale`, `toast`, `modal`.

**MRP Board** — `query`, `statusFilter`, `catIdx`, `whIdx`, `buIdx`, `showInactive`, `unapprovedNutrition`, `unapprovedProduction`, `sortKey`, `sortDir`, `selected[]`.

**Planning Profiles** — `params` (pending edits by row id), `savedParams` (committed baseline), `flash` (row id → timestamp, driving the recompute flash), `recalcMsg` / `recalcColor`.

**Optimization** — `weights { cost, service, dio }`, `decisions` (row index → accepted | rejected).

**Proposals** — `propFilter`, `propGroups[]`.

**Bootstrap** — `bootStep`.

In production, filters, sort, and pagination belong in the URL so a filtered board is shareable; selection and pending parameter edits stay local. Parameter saves need optimistic UI with rollback, since a save triggers a 1,395-ref recompute server-side.

**Data the screens require:** recipe refs with daily usage, available quantity, UoM, category, warehouse, owner, and flags (inactive, unapproved nutrition, unapproved production); member SKUs per ref with supplier, availability, observed lead-time distribution, last price, and preferred/alternate/spot role; planning parameters with full provenance (calculated / manual / override, and which one is active); order proposals grouped by supplier with MOQ and freight thresholds; the data-health gap register with assignees; and the snapshot/audit chain.

## Assets

None. No images, no icon fonts, no third-party SVG. Every glyph in the prototypes is either a Unicode character (`✓ × ⋯ ▾ − + → ⏎ ☾ ☀ ↑ ↓`) or a CSS shape (dots, squares, bars). Substitute your codebase's icon set where a real icon is warranted — but keep status markers as plain shapes, since the round/square distinction carries meaning.

Fonts: **IBM Plex Sans** (400/500/600) and **JetBrains Mono** (400/500) — both Google Fonts. No third family.

## Files in this bundle

| File | What it is |
|---|---|
| `Sentinel App.dc.html` | The application prototype — shell, all 35 screens, empty states, modal, palette, toasts |
| `Sentinel Foundations.dc.html` | Foundations sheet — every token and primitive in its real states |
| `Sentinel Components.dc.html` | Application components — overlays, table machinery, data entry, ingestion, workflow/audit, charts, and the loading/empty/error triad |
| `support.js` | Runtime for the two prototypes. **Design-tool infrastructure — do not port** |
| `SENTINEL_DESIGN_SPEC.md` | The original design brief the mocks were built against |
| `README.md` | This document |

To view a prototype, open either `.dc.html` in a browser with `support.js` alongside it.

## Not in this bundle

## Screens added after the first tranche

The thirteen screens documented in detail above (Command Center through Audit & Time Machine) establish every pattern. The remaining screens are compositions of those parts; what follows is the reasoning specific to each, since that is what a spec cannot infer from a screenshot.

### Planning

**Item 360** — one ref, everything known about it. Projection chart draws that ref's real safety and reorder lines and marks the bucket where cover breaches safety. Movement history computes running balances backwards from current stock, so the arithmetic is checkable. Parameters carry provenance tags (MANUAL / CALCULATED / DERIVED).

**MRP Future** — bucketed projection. Balances roll forward from real daily usage; replenishment lands only after the lead time has elapsed and orders in **whole EOQ multiples sufficient to clear the reorder point**, not one lot per bucket (a single lot can be smaller than one bucket's consumption, which makes a deficit compound forever). Negative balances print signed rather than clamping to zero — shortfall depth is the point. A row that goes negative at any bucket reads **Uncoverable**, not "Order now".

**Coverage** — days of cover measured against **each ref's own lead time**, which is a different question from stock status. Bands are exclusive and exhaustive (first match wins, one pass), so counts sum to the ref total and percentages to 100%. The header states explicitly that these counts will not match Command Center's shortage count.

**Demand & Forecast / Demand Profile (TSRC)** — actual against forecast with a confidence band that widens over the horizon. MAPE per category, because one bad category drags the blended figure; over 25% means safety stock is doing the work the forecast should.

### Buying

**Purchase Orders** — read-only Precoro mirror. Receipt progress bars distinguish "overdue with nothing received" from "overdue but 60% in" — materially different situations that a single state badge hides.

**Approvals / Purchase Requests** — the queue as approval chains, each step showing done / now / waiting. Blocked items render a critical blocker badge with a disabled Approve button; a fully-approved item reads **Approved** with an ok-tinted frame rather than offering an action already taken.

**Imports & Landed Cost** — shipments in flight; click a row for its cost build-up (goods, freight, duty, clearance, haulage) with a landed unit cost. Landed cost feeds the price baseline, so a freight spike surfaces as a price increase rather than a hidden margin loss. Uplift over 20% is flagged as a local-sourcing candidate.

**Pricing / Savings** — movement against a 12-month volume-weighted baseline with per-ref sparklines and annualised impact. Confidence is receipt count. The Savings view filters to genuine reductions **but still shows the offsetting increases and the signed net**, so the number cannot be gamed by selective filtering; the low-confidence card counts only rows actually shown.

### Inventory

**Inventory Explorer** — warehouse rail; KPIs and stock lines re-derive per selection. Batch-level lines in FEFO order. Shelf life is a property of the batch, seeded per warehouse-and-ref, and **skipped entirely for non-perishable categories** (packaging, cleaning supplies) which read "non-perishable" with an em-dash date rather than a fabricated countdown.

**Transfers & Staging** — five lifecycle counters, but only REQUESTED highlights, since it is the only state awaiting a human. Per-row dual-approval boxes show 0/2, 1/2, 2/2 explicitly.

**Quarantine / Lifecycle / Business Continuity** — three registers on one shared table shape. Quarantine shows holds against the shortages they cause (held stock is excluded from available, so it cannot satisfy a shortage). Lifecycle flags refs reordered while in run-out. Continuity scores severity by **how hard a ref is to replace**, not what it costs.

**Warehouse Cost** — CBM used against capacity, cost per CBM. Utilisation over 90% is styled as a constraint, under 25% as idle capital. The consignment site reads "consignment" rather than a fabricated rate.

**Cycle Count / IRA** — ABC cadence with adherence, then sessions where variance drives outcome: exact match reads neutral, under 5% adjusts, over 5% forces a recount. IRA is counted at line level, so a compensating pair of errors is still two errors.

### Suppliers

**Buyer Scorecard** — measures response to what Sentinel raised (proposals actioned, median response, gaps open, stockouts on own refs). Deliberately **excludes supplier lateness**, which belongs on the supplier scorecard; a late supplier is not a buyer failure, an unactioned proposal is.

**Lead-time Suggestions** — observed p80 against stated, with a box plot whose spread narrows as sample size grows and a dashed marker for the stated value. Sample size is on every row; "Accept high-confidence" acts only on n≥30 and says how many it left behind.

**Preferred SKU** — candidate groups with radio selection. Ties display the evidence that failed to break them, and the Cling Film tie is linked to the missed shortage it caused.

### Work & Data

**Missed Shortages / Proposal Adherence** — framed as engine failures, not buyer behaviour. Each row names why no proposal was raised (unresolved unit, no preferred SKU, null lead time). Adherence swaps to proposal outcomes, with approved-then-unordered as the headline.

**Deliveries Entry** — receipt entry against open PO lines. Variance computes as you type and re-tones the input; the side panel previews the effect of posting. Over-received lines block posting until a note is added. Nothing changes stock until confirmed.

**Projects & Meetings / Intelligence** — work in flight and generated analyses on a shared card shape. Every action item has an owner; every analysis states its evidence and leaves the decision to a human.

**Reference & Settings** — six reference tables. Unresolved units are surfaced first and counted in critical, because an unresolved unit silently excludes a ref from planning — the root cause of one of the missed shortages on the register.

## Shared conventions introduced by these screens

- **A zero exception count reads neutral, never critical.** Shortages, expiring lines, blocked items: at zero the value drops to `--text`, the meta line changes ("none below safety", "nothing near expiry"), and any sparkline goes muted. Applies everywhere a count is styled by severity.
- **One source per rollup.** Where a KPI card and a table show the same total, both derive from a single array — group DIO and service level are value-weighted, not naive means, and labelled as such.
- **Signed figures use U+2212** (−) consistently in numeric columns, not a hyphen.
- **Sample size travels with every claim.** Any suggestion, price movement, or lead-time observation states its n and tones its confidence badge by it.

## Still to do

Nothing in the screen inventory. Genuine gaps for the build phase:

1. **Real datasets.** Every screen is driven by seeded mock data. Row counts, distributions, and edge-case frequency will differ against production, and the exception-vs-calm balance should be re-checked once real data lands.
2. **Virtualization.** The MRP Board renders 60 rows; production needs 4,000+ virtualized with the sticky first column and header intact.
3. **Charts.** All charts are hand-built SVG matching the spec's chart section. The spec pins `@tanstack/charts` (alpha) — porting to it should preserve the four documented states (loaded, loading, empty, error) and the target/threshold reference lines.
4. **Accessibility pass.** Focus order, ARIA on the grid and tri-state matrix, and screen-reader labels for status pills need a dedicated pass; colour is never the sole carrier of meaning in the mocks, but that needs verifying with real assistive tech.
5. **Print and export.** Order proposals leave Sentinel as PDF; that layout is not designed.
