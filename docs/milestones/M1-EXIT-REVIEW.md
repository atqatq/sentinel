# M1 Exit Review — Data foundation (`0.2.0`)

**Date:** 2026-08-30 · **HEAD at review:** the CI run for the commits below · **Verdict: M1 EXIT — gates 3, 4 (fail-closed), 6, 12, 13 CLOSED, with residuals named and scheduled.**

M1 delivered the data foundation as pure, tested modules plus a proven database layer: the ingestion boundary's parse → bind → normalize → window stages (C4, C1, C2, H8), the inbound-hardening gate (H10), the schema + fail-closed RLS model with a live deny-matrix, and the H6/H7 structural keys. Every unit landed with its own suite, a DECISIONS entry where it shaped the system, and CI gating. This review closes the milestone against the release gates the delivery spec assigns to M1 (§6.3) and records what deliberately remains open.

## Gate-by-gate evidence

### Gate 3 — Unit conversion implemented and tested (C1) — **CLOSED**

SENT-AUDIT-003 §6 already scored the engine side PASS with the contract note "ingestion must call it". M1 closes that note: conversion now happens **at ingestion**, before rows can reach upserts or the engine.

- Engine side (pre-existing, regression-green): `engine.test.js` — "C1: a missing conversion factor REFUSES rather than guessing"; "H1: preferred SKU weighs PLANNING units, so cartons beat loose pieces" (planning-unit weighting is the whole point of conversion).
- Ingestion side (M1): `normalize.js` `convertOpenPoRows` converts `waiting × factor` at the boundary; `MISSING_CONVERSION_FACTOR` matches engine R3's code, `INVALID_CONVERSION_FACTOR` refuses present-but-unusable factors. Tests: "converts waiting × factor and carries the factor onto the row", "a missing factor map sends every row to data-health, none converted" (`normalize.test.js`). Decision D-015.

### Gate 4 — Currency normalization before engine/KPIs (C2) — **CLOSED for M1 (fail-closed)**

The milestone map closes gate 4 at M1 **in its fail-closed aspect**; A1's KPI-side named tests land with the KPI module in M2 (they cannot exist before that module does).

- Containment is now at the boundary, before any aggregation can mix currencies: `normalizeMoney` stores `documentCurrency` + `tenantValue`; a third currency refuses `CURRENCY_NOT_SUPPORTED` (the 10,000 BHD + 10,000 AED = 20,000 poison dies at ingestion — test: "a third currency is refused — the 10,000 BHD + 10,000 AED poison dies here"); unpinned days refuse `RATE_NOT_PINNED` ("a USD row on a day with no pin is refused — RATE_NOT_PINNED, fail-closed"); `tenantCurrency` is mandatory and throws when absent ("tenantCurrency is mandatory and throws when absent (R1 mirror)"). Rate direction is named in the data (`usdToLocalByDay`) — the inverted-FX defect class is killed by construction. Decision D-015.
- Scheduled M2 residuals (A1/A2): `kpi/tenant-currency-mandatory`, `kpi/mixed-currency-withholds-value`, `kpi/service-level-null-when-unplannable` — land with the KPI layer and gate 15's dataState-aware KPIs.

### Gate 6 — Strict numerics + plausibility bounds (C4) — **CLOSED**

All three A5 named proofs are covered by the parse suite (32 tests):

- `ingest/strict-parse-quarantines` — thousands separators, decimal commas, currency forms, scientific notation, booleans, non-finite values are **named** quarantine reasons, never coerced ("REJECTS '1,200' — the flagship nz() defect, now a named quarantine reason" and the full reason-code family). The nz() fallback is legal at exactly one site (declared-optional AND genuinely missing; "present-but-corrupt optional value STILL quarantines — optional never hides corruption").
- `ingest/bounds-every-kind` — inclusive plausibility bounds with named breach reasons ("bounds are inclusive at both edges", "breach above max → quarantine ABOVE_MAX with the parsed value in detail", "breach below min (negative qty) → quarantine BELOW_MIN").
- `ingest/deliveries-confirmation` — the ±50% deliveries variance guard returns the full substitution plan (quarantined value, trailing-7-day-mean baseline from valid entries only, DATA_HEALTH task, banner), with honest `NO_VALID_BASELINE` instead of an invented number. Decision D-012.

### Gate 12 — Tenant-scoped idempotency + supplier identity (H6, H7) — **CLOSED (contract + schema + live); two residuals scheduled**

**H6 — tenant-prefixed idempotency keys (A7):**

- Structural: "all six spec idempotency keys are tenant-leading UNIQUE indexes" + "control-plane uniques are tenant-leading too (H6 structural)" (`packages/db/test/schema.test.js`); every UNIQUE index leads with `tenant_id` in `migrations/0001_init/migration.sql`.
- **Live**: the RLS deny-matrix proves the actual failure mode H6 was raised for — J1 "T1 registers key (items, SKU-1)", J2 "same-tenant replay violates the tenant-scoped unique" (23505), J3 "SAME key for the other tenant does NOT collide (the H6 defect is dead)" — running against a real PostgreSQL 16 in CI (job `db-rls`).
- Scheduled M2 residual: the application-level idempotent upsert wrapper (replay → no-op) is pipeline wiring and lands with the ingestion worker.

**H7 — Supplier ID identity (A8):**

- Schema: `supplier` carries the partial-unique `(tenant_id, external_id) WHERE external_id IS NOT NULL` with `(tenant_id, name)` as the documented interim ("H7: supplier external_id unique per tenant when present (partial index)", `schema.test.js`).
- Binding: `'Supplier ID'` now binds to `supplierExternalId` (trim/case tolerant, proven), while current-template files without the column keep binding — the interim path is tested, not assumed (`filebinding.test.js`, H7 section).
- Spec: Precoro R4 amended — `Supplier ID` is **[ADD] · priority-1**, the identity key; the ingestion spec's idempotency key list now names `Supplier ID` with `Name` as interim. D-016.
- Scheduled residual (external): the column arrives when Precoro ships the amended R4 — a cutover-project dependency, tracked there.

### Gate 13 — Ingestion hardening + email-in controls (H10) — **CLOSED**

- `hardening.js` `gateInboundFile` is the single choke point: payload cap → magic bytes (content, never name) → declared-vs-content agreement → container (ZIP must be an XLSX workbook) → zip-bomb caps (central-directory only, nothing inflated before capping) → fail-closed AV hook. XML family refused outright — XXE structurally impossible. Email-in rides the same gate **by construction**: the `source` is recorded, never consulted, and a test proves identical bytes get identical verdicts from dropzone and email. Formula injection neutralized at cell level (OWASP apostrophe escape; `-` kept only for canonical numbers).
- 46-test suite; named proofs delivered: `ingest/magic-bytes`, `ingest/zip-bomb`, `ingest/formula-stripping`. Decision D-018.

## Verification summary

| Suite | Count | Where |
|---|---|---|
| planning engine | 86 | `packages/core/modules/planning-engine` |
| execution feedback | 31 | `packages/core/modules/execution-feedback` |
| strict parse + bounds + deliveries guard | 32 | ingestion |
| file-kind binding + allow-list (+ H7 identity) | 19 | ingestion |
| unit resolution + C1 + C2 normalization | 36 | ingestion |
| H8 window alignment | 26 | ingestion |
| H10 inbound hardening | 46 | ingestion |
| DB schema structural | 13 | `packages/db` |
| **Total (structural)** | **289** | `npm test` green |
| RLS deny-matrix | 37 live checks | CI `db-rls` on postgres:16; proven locally on portable PG binaries |

Guards clean (SDS token parity, UI primitives scope, forbidden terms); golden fixtures 4/4 SHA256SUMS verified; CI green on the milestone HEAD. Contract hygiene: ADR-0002 (RLS model) renumbered at this review — it had collided with ADR-0001 (plugin architecture); all references updated.

## Residuals and scheduled obligations

| Obligation | Lands in | Source |
|---|---|---|
| KPI-side named proofs (`kpi/tenant-currency-mandatory`, `kpi/mixed-currency-withholds-value`, `kpi/service-level-null-when-unplannable`) | M2 (KPI module) | A1/A2, gates 4/15 |
| H6 idempotent upsert wrapper (application-level replay no-op) | M2 (ingestion pipeline wiring) | A7 |
| Precoro R4 `Supplier ID` column in the real export | Cutover project (external dependency) | A8 |
| FX pinned-rate **service** ADR — owed before any app-layer FX lands | M4/M10 | D-015, delivery spec |
| C3 SoD (approver ≠ raiser, thresholds, dual control) | M3 | A4, gate 5 |
| H4/H9 canonical dates + working calendar | M2 | A10, gates 10 |
| H5 ledger (HMAC/JCS/Origin carve-out) | M3 | A6, gate 11 |
| H11 restore rehearsal as a go-live gate | M5 | gate 14 |
| SRC-05 single-source tile | M4 | A15.2 / D-013 |

M2 begins the planning-online milestone (`0.3.0`): engine live behind fail-closed KPIs, UI shell with the status language, data-health screens, freshness alarm.
