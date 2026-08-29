
---

## 13. Amendment A14 — execution boundary & KPI dashboard (2026-08-30)

Accepted by the owner: *"Agreed. Sentinel will infer from ingestion files and inventory staff will
only work in Precoro."* This amendment adds the acceptance tests referenced by build spec §14.7
and §14.12, and the acceptance test for the per-tenant KPI dashboard (build spec §16, screen 34).
The boundary principle: **Precoro executes; Sentinel plans, approves and verifies.**

### A14.1 — `transfer/reconciles-from-ingestion` (build spec §14.7)

Given an approved transfer plan between two tenants, when the next ingestion drop contains the
matching `Transfers - Goods Out` at source and `Transfers - Goods In` at destination within
quantity tolerance, the plan transitions to **`RECONCILED`** and both tenants' day snapshots
reference the plan. When no matching movement appears inside the expected window, the plan
transitions to **`MISMATCH`** and a follow-up task routes to the requesting category owner with
the plan attached. Sentinel never authors inventory movements; the only states Sentinel may set
are `PROPOSED → REQUESTED → APPROVED → RECONCILED | MISMATCH`, with `CANCELLED` reachable from
any pre-execution state.

### A14.2 — `ira/accuracy-from-ingested-adjustments` (build spec §14.12)

Given scheduled count sessions, accuracy % is computed **solely from adjustments ingested from
Precoro** (posted there by warehouse staff). Sentinel records who counted, computes variance
against the ingested book, raises recount flags beyond tolerance (W11 routing) and surfaces
repeated variances on Data Health. No stock correction is ever authored in Sentinel.

### A14.3 — `kpi/screen-34-catalog-renders` (build spec §16, lands at M4)

Given the sealed data of the day, screen 34 renders the seven KPI groups (Sourcing, Inventory,
Data Health, Team Productivity, Project Milestones, Food Philosophy & Production Adherence,
Inventory Value charts) for every tenant the viewer holds a grant in. Each KPI shows value,
target band, owner role and freshness stamp from the last sealed ingest feeding it. A KPI whose
feeding ingest is not sealed renders an explicit **stale** state — no KPI silently renders a
number from unsealed data. Review cadence is the Atlas W-16 weekly KPI review.

### A14.4 — `guard/no-client-terms-no-secrets` (repo governance, D-003)

The CI guard blocks client-identifying names, real person/supplier names and secret-shaped
strings; the tree stays free of production data. Fixtures are synthetic or explicitly redacted.
Weakening the guard requires an owner-approved amendment — never a content change to pass CI.

### Traceability rows added

| Finding / decision | Location | Acceptance test | Gate |
|---|---|---|---|
| Owner boundary directive | build spec §14.7, §14.12; screens 15/16/17 | A14.1, A14.2 | CI write-back grep + tests |
| Owner KPI directive | build spec §16, screen 34; Atlas W-16 + KPI appendix | A14.3 | M4 DoD |
| Repo data governance | DECISIONS.md D-003; guard script | A14.4 | CI guard job |
