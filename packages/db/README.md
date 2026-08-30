# @sentinel/db — data foundation

Prisma schema (typed contract) + hand-written SQL migrations carrying what
Prisma cannot express: row-level security, roles, grants. RLS model is
decided in [ADR-0001](../../docs/adr/ADR-0001-rls-model.md); the decision
record is D-016.

## Layout

```
prisma/schema.prisma          source of truth for tables + columns (typed contract)
migrations/0001_init/         DDL + enums + FKs + RLS (ENABLE/FORCE/policy per table)
seed.sql                      synthetic tenants + unit catalogs + FX pins (idempotent)
test/schema.test.js           structural checks — run anywhere, no server needed
test/rls-deny-matrix.js       LIVE proof of the isolation contract — needs PostgreSQL
```

## Rules

- `schema.prisma` and `migration.sql` must stay consistent — `test/schema.test.js`
  fails CI on drift (table + column sets compared both directions).
- Money and quantities are `NUMERIC` (never float); FX rates `NUMERIC(18,8)`.
- Every tenant-scoped table: `tenant_id UUID NOT NULL` first, ENABLE + FORCE RLS,
  one fail-closed `tenant_isolation` policy.
- Every idempotency UNIQUE index leads with `tenant_id` (H6). Supplier identity:
  `(tenant_id, name)` interim, `(tenant_id, external_id)` partial-unique when the
  Precoro Supplier ID arrives (H7).

## Running

```bash
node test/schema.test.js                    # structural — always

# live deny matrix (any PostgreSQL 14+; CI uses postgres:16):
DATABASE_URL_ADMIN=postgres://postgres@127.0.0.1:5432/postgres \
  node test/rls-deny-matrix.js              # needs the pg package resolvable
```

The matrix creates and destroys its own scratch database (`sentinel_rls_matrix`);
it never touches shared databases. Seeding:

```bash
psql "$DATABASE_URL" -f migrations/0001_init/migration.sql
psql "$DATABASE_URL" -f seed.sql
```

The Prisma client is generated and consumed from M2 (apps/web) onward; the
schema file is already the contract (D-016).
