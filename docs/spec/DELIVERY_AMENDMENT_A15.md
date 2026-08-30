---

## 14. Amendment A15 — screen 25 Supplier Coverage: fold-in confirmed, SRC-05 re-homed (2026-08-30)

Accepted by the owner: *"Let's go with your recommendation."* The designer's screen inventory
(suppliers group: Suppliers · Supplier Scorecards · Buyer Scorecard · Lead-time Suggestions ·
Preferred SKU) never carried a standalone Supplier Coverage screen; its content is covered by
existing surfaces. The owner confirms the fold-in and re-homes the governance KPI that cited it.

### A15.1 — Screen 25 retired; duties attributed (build spec §4)

Screen **25 Supplier Coverage** is retired as a standalone screen. Screen IDs are stable
identifiers: **25 is retired, never renumbered**; the buildable screen set becomes 33 screens
carrying IDs 1–34. Duty attribution:

| Screen 25 duty | Lands on |
|---|---|
| Suppliers by recipe reference | Per-ref **member SKU table** (`PREFERRED` / `ALTERNATE` / `SPOT` / `CANDIDATE` role pills) |
| Quotes → best-available baseline | **Preferred SKU** selection with pin rationale ("best landed cost across last 12 receipts") and tie evidence |
| Suppliers by category | **Suppliers** master (refs, spend) + **Supplier Scorecards** (per-supplier view) |

The Atlas workflow node **SRM-10 "Supplier Coverage & Quotes"** describes the *activity*, which
survives unchanged; its WHERE references map to the surfaces above. The Atlas itself is not
renamed.

### A15.2 — SRC-05 re-homed to a Supplier Scorecards tile (build spec §16)

`SRC-05 · Single-source exposure` (share of active categories with exactly one approved
supplier; ≤ 15%; weekly; owner SBR) previously sourced from "supplier coverage (screen 25)".
Its source is now the **Supplier Scorecards header KPI tile** with drill-down:

- The tile renders `single-source categories ÷ active categories × 100` from the last sealed
  ingest, with target band ≤ 15% and the SRC-05 freshness stamp — same stale semantics as
  A14.3 (no number renders from unsealed data).
- Drill-down opens the **single-source register**: every active category holding exactly one
  approved supplier, each row naming the category, its sole approved supplier, 12-week spend,
  and a link into the supplier's scorecard. The register is a filtered view of scorecards
  data — no new entity, no new ingest kind.
- Lands with **Supplier Scorecards (M4)**; the data it needs (approved suppliers × categories)
  exists from M1 ingestion onward, so the register can be validated against fixtures earlier.

### Acceptance test

`kpi/src05-single-source-tile` — given sealed ingest with known approved-supplier × category
coverage, the tile value equals `single-source ÷ active` to the displayed precision, the
drill-down register lists exactly the single-sourced categories with their sole approved
supplier, and an unsealed feeding ingest renders the explicit stale state (A14.3 semantics).

### Traceability rows added

| Finding / decision | Location | Acceptance test | Gate |
|---|---|---|---|
| Owner fold-in decision (screen 25 retired) | build spec §4 screen 25; design README suppliers group | screen inventory conformance at M2/M3 shell build | DoD gate 15 |
| SRC-05 re-homing | build spec §16 SRC-05; A15.2 | `kpi/src05-single-source-tile` | M4 DoD |
| Stable screen IDs (no renumbering) | build spec §4 | docs-links check in CI | CI static job |
