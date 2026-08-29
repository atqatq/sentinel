# Security Policy

## Reporting

Report vulnerabilities privately to the repository owner via GitHub Security Advisories
(**Security → Report a vulnerability**) rather than public issues. Expect an acknowledgement
within 48 hours and a triaged severity within one week.

## Hard rules enforced in this repository

1. **No credential literals, ever.** All secrets come from environment variables or a secret
   manager. The CI guard fails any commit containing secret-shaped strings (provider token
   prefixes, AWS key ids, private key blocks).
2. **No Precoro write-back.** The codebase contains no POST/PUT/PATCH against the system of
   record; ingestion is file-based and pull-only. A CI grep gate enforces this.
3. **No production data in the tree.** Fixtures are synthetic or explicitly redacted; the
   forbidden-term guard blocks client-identifying names.
4. **Tenant isolation** is enforced at the database layer with PostgreSQL Row-Level Security;
   every table carries cross-tenant deny tests.
5. **MFA is mandatory for approval-capable roles.**

## Scope

In scope: the monorepo (`apps/`, `packages/`, `modules/`), CI pipelines, docker reference stack
and ingestion tooling. Out of scope: the upstream procurement system (report to its vendor).
