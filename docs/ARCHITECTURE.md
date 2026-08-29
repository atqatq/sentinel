# Architecture

Sentinel is a **modular monolith**: one deployable web application + one dedicated worker
process, built from independently manifested modules on top of PostgreSQL. The system sits on
top of Precoro (the system of record) and communicates with it **only through daily file
ingestion — read-only, pull-based, no write-back, enforced by a CI grep gate**.

## The five nodes

```
 INGESTION ──► PLANNING ──► EXECUTION FEEDBACK
     │             │               │
     │             ▼               │
     │          LEDGER ◄───────────┘      ORIGIN (bootstrap & module control plane)
     │             │
     └────────► USER SURFACE (34 screens, SDS design system)
```

1. **Ingestion** — one workbook per tenant (or a `Tenant` column the importer splits). Header
   signatures auto-detect file type; an allow-list strips tips and unknown columns; validation
   gates quarantine bad rows; tenant-prefixed idempotency keys make re-uploads safe. Every load
   ends with a per-tenant `DayState` seal — data is either sealed and trusted or visibly failed.
2. **Planning** — the pure engine (`packages/core/modules/planning-engine`): deliveries are the
   only raw demand primitive; a per-SKU consumption-per-delivery rate derives consumption, cover,
   run-out, reorder, EOQ and max. Output is order **proposals** — never executed directly.
3. **Execution feedback** (`packages/core/modules/execution-feedback`) — the loop of record:
   `PROPOSAL → DECISION → COMMITMENT (PO) → RECEIPT`; reconciliation of transfer plans against
   ingested goods-in/out (`RECONCILED | MISMATCH`); lead-time learning; supplier scorecards;
   realized savings; double-order guard.
4. **Ledger** — hash-chained, append-only (HMAC-SHA256 over RFC 8785 canonicalization), the
   audit spine for every state change including module lifecycle events.
5. **User surface** — 34 screens in five planes (PLAN · SOURCE · INVENTORY · SRM · PLANES) under
   the SDS design system, plus the Origin-only control planes (Intelligence, Module Management).

## The execution boundary (owner directive)

> **Precoro executes; Sentinel plans, approves and verifies.**

- Transfers (§14.7): Sentinel proposes and both-sides approvals commit availability; staff
  execute the physical move in Precoro; the next ingestion drop reconciles the plan —
  matching movement → `RECONCILED`, absent movement → `MISMATCH` with a routed task.
- Quarantine (screen 16): quantities and reasons flow in read-only; Sentinel recommends
  dispositions with reason codes; dispositions post in Precoro.
- Cycle counts (§14.12): corrections post in Precoro; Sentinel measures accuracy %, variance
  and recount flags from ingested adjustments.

## Tenancy

Every row is tenant-owned; PostgreSQL **Row-Level Security** is the enforcement point for
tenant isolation and separation of duties. Cross-tenant visibility exists only via explicit
grants (category-owner model, tenant×tenant analytics). Currency normalization pins the
tenant-day FX rate; the ledger is partitioned by tenant + date.

## Module system

See [ADR-0001](./adr/ADR-0001-plugin-module-architecture.md) and build spec §14.15. Manifest
fields, lifecycle, fault containment and upgrade gates are contractual. The repo layout mirrors
the contract: `packages/core/modules/*` today; `packages/ingestion`, `packages/kpi`,
`packages/db`, `apps/web`, `apps/worker` at their milestones — each shipping a
`sentinel.module.json`.

## KPI surface

Screen 34 (per-tenant KPI dashboard) renders the KPI catalog — seven groups (Sourcing,
Inventory, Data Health, Team Productivity, Project Milestones, Food Philosophy & Production
Adherence, Inventory Value charts) — every KPI carrying definition, formula, source dataset,
owner role, refresh cadence and target band. Definitions live with the `kpi-catalog` module as
data, reviewable in the build spec §16 and the Atlas W-16 / KPI appendix.

## Stack summary (delivery spec §2)

TypeScript 5 strict · Node ≥ 22 · Next.js 15 + React 19 + vendored shadcn/ui · Tailwind 4 with
SDS tokens · TanStack Table/Virtual/Query · Prisma + PostgreSQL 16 (RLS) · Redis 7 + BullMQ ·
S3-compatible artifacts · Zod v4 + big.js · OIDC auth (MFA for approvers) · OpenTelemetry →
self-hosted Grafana LGTM · Vitest / Testcontainers / Playwright / fast-check · pnpm workspaces +
Turborepo · GitHub Actions.
