# ADR-0001: Row-level security model for tenant isolation

* Status: accepted
* Deciders: repository owner (mandated by SENTINEL_V1_DELIVERY_SPEC §2 — "Native RLS is the enforcement point for tenant isolation AND SoD")
* Date: 2026-08-30
* Related: D-016; M1 milestone (gates 3, 4, 6, 12, 13); build spec §8 (PostgreSQL rationale); C3 (SoD, lands M3)

## Context

Sentinel is multi-tenant from day one. Tenant isolation must be enforced at the
**database layer**, not only in application code — a missing `WHERE` clause in
one query must never leak one tenant's procurement data to another. The
delivery spec requires an ADR for the RLS model before `db/**` lands, and the
integration-test gate demands: *"RLS: every tenant-scoped table proves
cross-tenant deny"* against a live PostgreSQL (§5.2).

## Decision drivers

* Fail-closed: a session with **no tenant context must see nothing** — silently
  zero rows on read, rejection on write. A wildcard default is the failure mode
  the audit era teaches us to fear.
* One enforcement point, testable: the deny-matrix must be executable in CI
  (postgres:16) and reproducible locally.
* The application role must never be able to bypass isolation, and neither
  should a non-superuser table owner.
* Prisma is the typed access layer but cannot express policies; the policy
  layer therefore lives in hand-written SQL migrations under `packages/db`.
* Future SoD invariant (C3, M3): `approver ≠ raiser` denied at DB level — the
  model must extend to role-pair policies without rework.

## Considered options

1. **Application-layer scoping only** (every query filtered by ORM middleware).
   Rejected: one forgotten clause is a breach; the spec mandates DB-level
   enforcement.
2. **One database role/schema per tenant.** Rejected: connection-pool and
   migration explosion at multi-tenant scale; grants drift becomes its own
   attack surface.
3. **Composite-key isolation** — every table keyed `(tenant_id, id)` with
   composite FKs everywhere. Strong, but heavyweight for V1; accepted as a
   possible future hardening (see Residuals).
4. **Session GUC + fail-closed RLS policies (CHOSEN).** The standard
   PostgreSQL pattern, fully testable, no pool changes, extends to SoD
   policies naturally.

## Decision

1. **Tenant context** travels in a single session GUC: `app.tenant_id` (UUID),
   set per transaction by the app (`SET LOCAL`).
2. **Policy shape** — every tenant-scoped table gets exactly one policy:

   ```sql
   ALTER TABLE t ENABLE ROW LEVEL SECURITY;
   ALTER TABLE t FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON t
     AS PERMISSIVE FOR ALL TO PUBLIC
     USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
     WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
   ```

   Fail-closed by construction, proven live in the deny-matrix:
   * GUC never set → `current_setting(..., true)` → **NULL** → comparison is
     NULL → reads return zero rows, writes are rejected (42501).
   * GUC set then RESET → placeholder **empty string** → the `::uuid` cast
     errors (22P02) → loud deny. Both paths are asserted in the matrix.
3. **FORCE binds the owner**: tables are `FORCE`d, so a non-superuser owner
   (the migrator role) is also subject to the policy — proven live (matrix K).
4. **The app never connects as superuser or owner.** `sentinel_app` is created
   `NOLOGIN NOBYPASSRLS` with DML grants only (no DDL, no TRUNCATE). Superusers
   bypass RLS by PostgreSQL design; the operational control is that no
   application, worker or probe ever authenticates as one.
5. **Scope of tenancy**: `tenant` itself and `app_user` are *not*
   tenant-scoped (a tenant row is the tenancy root; a user is cross-tenant by
   design via `ownership_grant`, which IS tenant-scoped and RLS-covered).
6. **Not tenant-scoped ≠ unprotected**: those two tables carry no business
   data; business tables are all tenant-scoped.
7. **Idempotency keys are tenant-scoped structurally** (H6): every UNIQUE
   index leads with `tenant_id`, so equal keys across tenants cannot collide —
   proven live (matrix J).
8. **Supplier identity** (H7): interim key `(tenant_id, name)`;
   `(tenant_id, external_id)` is partial-unique the moment the Precoro
   Supplier ID column arrives.

## Consequences

* Positive: cross-tenant read/update/delete/write are denied by the database
  itself; the deny-matrix (37 checks) is the permanent CI proof.
* Positive: M3's SoD invariant lands as additional policies on approval
  tables (`approver_user_id <> raiser_user_id` shape) with no model change.
* Residual — superuser bypass: unavoidable in PostgreSQL; controlled
  operationally (no app credentials are superuser; CI matrix runs the probe as
  a dedicated NOBYPASSRLS role).
* Residual — cross-tenant FK integrity: RLS scopes row access; it does not
  stop a tenant-context session from inserting a child row referencing another
  tenant's parent (e.g. a stock_line pointing at another tenant's item). The
  pipeline composes parent lookups from tenant-scoped reads only, and the
  deny-matrix grows with each new relationship. Composite FKs remain the
  future hardening path if the risk profile changes.
* The pinned-FX **service** (24h per-tenant-day pinning, Decision 7) lands with
  the M4 FX fail-safe (M10) and owes its own ADR; the `fx_rate_pin` table
  exists now so C2 normalization can be built and tested.
