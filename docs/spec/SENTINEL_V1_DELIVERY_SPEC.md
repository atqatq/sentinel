# SENTINEL — V1 Delivery Specification

## From Empty Organization to Deployable, Versioned V1 (`1.0.0`)

| | |
|---|---|
| **Document ID** | SENT-DELIVERY-SPEC-1.1 (rev 1.1: UI stack amended — Astryx replaced by vendored shadcn/ui; §2, §3.2, §8, §9 A12, §11) |
| **Date** | 2026-08-29 |
| **Status** | Build plan of record — governs repo, stack, method, versioning, milestones, CI/CD, deployment |
| **Inputs** | `SENTINEL_V3_BUILD_SPEC.md` v3 (contract) · SENT-AUDIT-002 (deep audit) · **SENT-AUDIT-003** (re-audit, this date — residuals R1–R3 are binding) · `INGESTION_FILE_SPEC.md` · `PRECORO_CUTOVER_PROJECT_SPEC.md` |
| **Target** | A deployable **V1 = `1.0.0`** that passes all 20 gates of the $50M readiness checklist and enters the 4-week parallel run |
| **Language rule** | MUST / SHOULD / MAY per RFC 2119. Every MUST has a named acceptance test or gate |

---

## 1. Guiding principles (non-negotiable, inherited from the audits)

1. **The contract wins.** The build spec (with this document's amendments) is the single source the implementer obeys; every business decision lands in `DECISIONS.md` — silence is never acceptable.
2. **Fail closed, fail visible.** Money- and quantity-bearing code refuses rather than guesses (C1 philosophy everywhere: R1's fail-closed KPIs, C4 strict parsing, H8 window alignment).
3. **The verified properties are binding.** V1–V12 and the closed-ecosystem posture (no network calls, no secrets, no dynamic execution, no write-back) are regression-tested, not conventions.
4. **TDD is mandatory** (build spec §13). No production code lands without a failing test that demanded it.
5. **Small, boring, reversible.** Modular monolith first; trunk-based development; every migration expand-contract; every deploy rollback-able in one command.

---

## 2. Development stack — decision record

Chosen for: **fast** (responsive UI, quick loops), **robust** (typed end-to-end, fail-closed boundaries), **able to scale** (post-V1 extraction path documented), **responsive** (server-rendered + streaming UI), and **closed-ecosystem compatible** (self-hostable, no required third-party data egress).

| Layer | Decision | Rationale against the bar |
|---|---|---|
| Language | **TypeScript 5 (strict)** everywhere | The verified engine/feedback modules are Node JS — golden suites (117 tests + audit probes) are the migration net. One language removes the unit/currency/class of seam errors that come from cross-language serialization |
| Runtime | **Node.js 22 LTS** | Performance, native test runner available, long support window |
| UI | **Next.js 15 (App Router) + React 19 + shadcn/ui (vendored)** — component source owned in `packages/ui`, built on Radix + Base UI primitives | Server components + streaming = responsive on thin clinic connections; clean, minimal aesthetic mapping 1:1 to the SDS; best-in-class a11y via Radix underneath; **zero external UI supply chain — component code lives in this repo and upgrades are opt-in diffs**; BFF included in the same deployable. Governance in amendment A12 |
| Data grid & client state | **TanStack Table v8 + TanStack Virtual + TanStack Query v5** (+ Form where needed) | Headless table/virtualization handles the 100k-row ref grids, approval trays and scorecards while *we* own rendering — so the `displayStatus` binding (M1) and audit traceability stay enforceable; the shadcn DataTable pattern is TanStack Table natively; Query powers interactive islands without displacing the server-first model |
| Styling engine | **Tailwind CSS 4** with SDS tokens as CSS variables (`packages/ui/theme`) | shadcn-native; design tokens (status colors, two-axis status vocabulary, type scale) live in one theme file mapped in M0; utilities compile away — no runtime style cost |
| Backend shape | **Modular monolith**: Next.js route handlers (BFF/API) + one dedicated **worker process** (BullMQ) for ingestion, ledger verification, freshness jobs | V1 speed without distributed-systems tax; the worker is already a separate process, so the first scale extraction (ingestion) costs zero re-architecture. Extraction order documented in §11.4 |
| Database | **PostgreSQL 16** | Native **RLS** is the enforcement point for tenant isolation AND SoD (C3: approver ≠ raiser at API *and* RLS); append-only ledger tables + triggers (H5); WAL archiving gives RPO ≤ 15 min (H11) |
| ORM / migrations | **Prisma** (migrations, typed client) | Typed data access kills a class of silent coercion; SQL escape hatch for RLS-sensitive paths |
| Queue / cache | **Redis 7 + BullMQ** | Ingestion pipeline stages, retries, quarantine flows, scheduled freshness alarms (M9) |
| Object storage | **S3-compatible** (MinIO self-host / S3) | XLSX artifacts with the AV-scan + magic-bytes hook (H10); presigned upload flow keeps files off the app servers |
| Validation & money | **Zod v4** at every boundary; **big.js** (or dinero.js) for money math | C4 strict numerics enforced by schema parse — `nz()` is retired to genuinely-optional fields only; currency normalization to tenant currency happens here (C2), ISO 4217 + pinned FX per §1.1 decision 7 |
| AuthN/Z | **OIDC** (Keycloak self-host for production; Auth.js + lab IdP for dev). **MFA mandatory for approval-capable roles** (M11) | Enterprise SSO, session policy control, and the audit's non-origin authn requirement without building a bespoke identity stack |
| Ledger crypto | **HMAC-SHA256** key from secret manager; **RFC 8785 (JCS)** canonicalization | H5 exactly as specified; cross-implementation verification vectors shipped as fixtures |
| Observability | **OpenTelemetry** SDK → self-hosted **Grafana LGTM** stack; **pino** structured logs | Closed-ecosystem-safe (no external APM egress); freshness SLO alarm (M9) is an alert rule over engine telemetry |
| Testing | **Vitest** (unit/fast) · **Testcontainers** (Postgres+Redis integration, RLS tests) · **Playwright** (E2E) · **fast-check** (property tests for numerics) | Coverage gates: ≥ 85% lines on `core` + `db`, ≥ 75% overall; the audit probe suites are lifted verbatim into `core/__audit__/` |
| Monorepo | **pnpm workspaces + Turborepo** | One lockfile, cached pipelines, atomic cross-package changes |
| CI/CD | **GitHub Actions** | First-class monorepo + OIDC to registries; all security gates (M12) implemented here |

**Explicitly rejected for V1:** microservices (premature), GraphQL (REST + typed client is sufficient and easier to audit), NoSQL (the ledger and reconciliation need relational guarantees), client-heavy SPA (slower first paint, weaker audit story), **TanStack Start/Router as the framework replacement** (would swap the BFF/deploy story mid-contract; TanStack is adopted as the *library* layer — Table/Virtual/Query — not the framework).

---

## 3. Repository creation — step-by-step

### 3.1 Create and protect the repo (Day 1)

```bash
gh repo create <org>/sentinel --private --description "Sentinel — procurement planning platform"
cd sentinel && pnpm init && git config commit.template .gitmessage
```

**Branch protection on `main` (settings → branches):** required PR (1 review minimum, 2 for `core/**` + `db/**` via CODEOWNERS), required status checks (§10 pipeline), required linear history, no force push, no delete; **secret-scanning + push-protection enabled**; Dependabot alerts + updates on.

**Files that must exist in the first commit:**
- `CODEOWNERS` — `core/** @lead-eng @audit-owner`, `db/** @lead-eng @data-owner`, `SECURITY.md @ciso`
- `.github/PULL_REQUEST_TEMPLATE.md` — includes "Finding IDs addressed / acceptance tests added / gates touched" fields
- `.github/ISSUE_TEMPLATE/` — bug, feature, **finding-remediation** (links audit ID)
- `SECURITY.md` (reporting path), `SUPPORT.md`, proprietary `LICENSE`, `.editorconfig`, `.gitignore`, `commitlint.config.js` + husky hooks (`commit-msg`, `pre-push` = affected tests)
- `DECISIONS.md` (from the audits), `docs/adr/` (MADR format, numbered `ADR-0001…`)

### 3.2 Monorepo layout (create in this order)

```
sentinel/
├─ apps/
│  ├─ web/                 # Next.js 15 (UI + BFF/API)
│  └─ worker/              # BullMQ worker (ingestion, ledger-verify, freshness, alarms)
├─ packages/
│  ├─ core/                # engine.ts, feedback.ts (ported verbatim) + __audit__/ probes
│  ├─ db/                  # Prisma schema, migrations, RLS policies, seed
│  ├─ ui/                  # vendored shadcn/ui components (owned code) + SDS Tailwind theme + TanStack-backed grids — the ONLY place UI primitives live
│  ├─ contracts/           # Zod schemas: ingestion, API, ledger payloads (shared FE/BE/worker)
│  └─ config/              # tsconfig, eslint, tailwind/vite presets, vitest presets
├─ docs/                   # ARCHITECTURE.md, RUNBOOK.md, adr/, ingest-contracts/
├─ fixtures/golden/        # H12: redacted DDS/Precoro extracts + checksums manifest
├─ .github/workflows/      # ci.yml, security.yml, release.yml
├─ docker/                 # Dockerfiles, compose.yaml (reference stack)
├─ CHANGELOG.md  DECISIONS.md  README.md
```

**Porting rule (`core`):** `engine.js`/`feedback.js` are renamed `.ts` with types added — **zero logic edits**; the 117 tests + audit probe suites must pass before any other work merges. `ENGINE_VERSION` constant exported and stamped into every proposal and ledger block (closes L-07).

---

## 4. Documentation system (created in M0, kept alive by CI)

| Artifact | Owner | Content / standard |
|---|---|---|
| `README.md` | lead | 5-minute run: prerequisites, `pnpm i`, `docker compose up deps`, `pnpm dev`, test commands, deploy pointer |
| `docs/ARCHITECTURE.md` | lead | Node map (PLAN/SOURCE/INVENTORY/SRM/INTELLIGENCE), module boundaries, data-flow diagrams from `Sentinel_System_Graph.html` |
| `docs/adr/ADR-00XX` | author of decision | MADR format; **required** for: stack choices (§2 of this doc), RLS model, ledger design, FX pinning, calendar basis |
| `DECISIONS.md` | product+audit owner | Every audit resolution (C3 thresholds, Origin carve-out, egress allow-list…); the audit's "silence is unacceptable" rule lives here |
| `docs/RUNBOOK.md` | ops | Restore rehearsal procedure (H11 gate), freshness-alarm triage (M9), quarantine review flow, ingestion incident playbook |
| `CHANGELOG.md` | automated | Keep a Changelog 1.1.0, generated by Changesets (§7) |
| API docs | automated | OpenAPI generated from Zod contracts (`@anatine/zod-openapi`); published per env |
| `docs/ingest-contracts/` | data owner | One page per Precoro report (R1–R6): columns, types, identity keys (H7: Supplier ID priority-1), plausibility bounds (C4) |

**Docs CI gate:** PR touching `core/**` or `db/**` without a linked ADR or DECISIONS.md entry fails `docs-links` check.

---

## 5. Engineering method — TDD as specified, enforced by pipeline

### 5.1 The loop (build spec §13 made operational)

1. Write the failing test **named after its requirement**: `<area>/<finding-or-req>.spec.ts` (e.g. `kpi/mixed-currency-withholds-value.spec.ts`). The name is the traceability link.
2. Red → minimal implementation → green → refactor with tests green.
3. PR includes: tests-first evidence (diff order is visible in commits), finding IDs, gate mapping.

### 5.2 Test taxonomy and gates

| Tier | Tool | Gate |
|---|---|---|
| Unit (packages/*) | Vitest | ≥ 85% `core`+`db` lines, ≥ 75% overall; new code must arrive with tests (diff coverage ≥ 90%) |
| Golden | Vitest + `fixtures/golden/` | Engine outputs byte-compat with redacted workbook extracts; checksums manifest verified in CI (closes H12 gate 2) |
| Property | fast-check | Numerics: strict parse never produces silent zero; conversion never negative; weighting unit-stable under permutation |
| Integration | Testcontainers | RLS: every tenant-scoped table proves cross-tenant deny; SoD invariant (approver ≠ raiser) denied at DB level (C3) |
| E2E | Playwright | Happy paths: ingest → plan → approve → PO → receive → reconcile; approval above threshold demands dual control |
| **Audit regression** | `core/__audit__/` | **All SENT-AUDIT-002/003 probes (v2 + round-3 scripts) must stay green forever** — R1–R3 fixes included |
| Closed-ecosystem | grep gate in CI | `fetch|axios|http|eval\(|child_process|secret literals` scan over `core/**` — exit 1 blocks merge (matches Appendix B method) |

---

## 6. Versioning — industry standard

### 6.1 Scheme

- **Semantic Versioning 2.0.0** per package + app: `MAJOR.MINOR.PATCH`.
- **Pre-1.0:** `0.MINOR.PATCH` where MINOR = milestone increment (breaking changes allowed and documented); `1.0.0` is V1 — the 20-gate release.
- **RC:** `1.0.0-rc.N` for the parallel-run candidate.

### 6.2 Mechanics

- **Conventional Commits 1.0.0** enforced by commitlint (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, plus `audit:` for finding remediations).
- **Changesets** automate: version bumps, cross-package coordination, `CHANGELOG.md` generation; release workflow tags `vX.Y.Z` on merge to `main` when a changeset exists.
- **Every release artifact** = Docker image `ghcr.io/<org>/sentinel-web:X.Y.Z` + `sentinel-worker:X.Y.Z` + SBOM attachment + changelog excerpt.
- **Version stamping (closes L-07):** `ENGINE_VERSION` (logic), `SCHEMA_VERSION` (db), and app `version.json` are stamped into: order proposals, ledger blocks, and `/health` output — so any behavior question in production resolves to an exact code state.
- **DB migrations** are Prisma migrations, expand-contract only; a migration never breaks the previous app version (guaranteed by running the previous image against the migrated DB in a nightly job).

### 6.3 Milestone → version map

| Milestone | Version | Content | Exit = gates closed |
|---|---|---|---|
| **M0 · Foundations** (wk 1–2) | `0.1.0` | Repo + CI skeleton (§3, §10), docs (§4), core ported w/ 117 tests green, **contract amendments transcribed** (§9: C3, C4, H5, H6, H7, H8 + re-audit R1–R3), golden fixtures + checksums (H12), vendored shadcn/ui + SDS → Tailwind theme mapping (A12) | Gates: 2 · contract text for 5, 6, 11, 12 · residuals R1–R3 fixed with probes green |
| **M1 · Data foundation** (wk 3–6) | `0.2.0` | Ingestion pipeline v1: strict parse (C4), conversion stage **before** upserts (C1), currency normalization (C2), tenant idempotency (H6), Supplier-ID identity (H7), window alignment (H8), file hardening + quarantine (H10), schema + RLS | Gates: 3, 4 (fail-closed), 6, 12, 13 |
| **M2 · Planning online** (wk 7–10) | `0.3.0` | Engine live (computeRef + KPIs fail-closed), UI shell + status language + data-health screens, freshness alarm (M9) | Gates: 15, 17 |
| **M3 · SOURCE & controls** (wk 11–15) | `0.4.0` | Proposal → approval → PO workflows; SoD + thresholds + dual control (C3); OIDC + MFA (M11); ledger v2 HMAC/JCS/Origin-carve-out (H5) | Gates: 5, 11 + M11 |
| **M4 · Closed loop** (wk 16–19) | `0.5.0` | Receipts + reconciliation (M6 matching rules), scorecards, signals (M3), CF governance (M7), restatement semantics (M8), FX fail-safe (M10), supply-status producers (M5) | Gates: 16 + P2 set |
| **M5 · Hardening & release** (wk 20–24) | `0.6.0` → `1.0.0-rc.N` | DR: WAL archiving, restore rehearsal **passed and logged** (H11); CI security gates + SBOM (M12); egress allow-list (M13); ladder-edge warnings (M14); perf/load pass at scale targets (§2 profile); pen-test fixes; docs complete | Gates: 14, 18 + all residuals |
| **Parallel run** (external, wk 25–28) | `1.0.0-rc.N` frozen | Cutover project runs W1–W13 + 4-week parallel run with divergences explained | Gates: 19, 20 → **`1.0.0` ships** |

---

## 7. CI/CD pipeline

### 7.1 `ci.yml` — every PR (merge-blocking, in order)

1. `setup` — pnpm install w/ cache; Turborepo remote cache
2. `static` — lint, typecheck, commitlint, `docs-links`
3. `test` — unit + property + golden (checksums verified) + diff-coverage gate
4. `integration` — Testcontainers: RLS deny-matrix, SoD invariant, idempotency replay, quarantine flows
5. `security` — **gitleaks** (secrets), **pnpm audit / OSV** (deps, fail on high+), **license scan**, **Syft SBOM** generated, closed-ecosystem grep gate, dependency pinning check *(= M12; container scan joins in M5 with Trivy)*
6. `e2e-smoke` — Playwright against ephemeral compose stack
7. `build` — Docker images (multi-stage, distroless, non-root), SBOM attached

### 7.2 `release.yml` — merge to `main`

Changesets → version + tag `vX.Y.Z` → build/push images → deploy **staging** automatically → smoke + freshness checks. **Production** deploys are manual promotion (2-person rule) of an exact image tag.

### 7.3 Environments & data

`dev` (compose, synthetic seed) → `staging` (prod-parity, redacted golden data, restore-rehearsal target) → `prod`. Tenant data never flows downhill; staging uses fixtures only.

### 7.4 Deployment topology (reference)

```yaml
# docker/compose.yaml (on-prem / customer cloud)
services: web (2×) · worker (1×, queue-grouped) · postgres:16 (primary + replica, WAL archiving)
          redis:7 (AOF) · minio · keycloak · otel-collector → grafana-lgtm
```

- **Migrations:** job runs `prisma migrate deploy` before rollout (expand), contract cleanup in a later release (contract). Rollback = redeploy previous tag; migrations never roll back destructively.
- **Backups (H11):** continuous WAL archiving (**RPO ≤ 15 min**), nightly logical dump, quarterly **restore rehearsal** executed from the RUNBOOK and logged as a ledger event — rehearsed once in staging **before cutover** (gate 14).
- **Scale path post-V1 (documented, not built):** (1) split ingestion worker horizontally (already queue-based), (2) read replicas for analytics/Intelligence node, (3) extract Intelligence behind an internal API with the egress allow-list enforced at the seam (M13). The monolith's module boundaries (§3.2) are the extraction lines.

---

## 8. Responsive UI & performance budget (the "fast & responsive" clause)

- Server-rendered pages with streaming; interactive islands (TanStack Query) only where needed — approval trays, grid editors, live KPI refresh.
- Budgets enforced in CI (Lighthouse CI on staging build): **LCP < 2.5s**, **INP < 200ms**, **CLS < 0.1** on the 4 primary screens (Dashboard, Ref detail, Approvals, Data health).
- **TanStack Table v8 + TanStack Virtual** for 100k-row ref lists, approval trays and scorecards — headless by design, so cell rendering lives in `packages/ui` and cannot bypass the status-vocabulary rule; KPI strip served from the worker-cached aggregate (60s TTL) via TanStack Query — no unbounded client aggregation.
- Status vocabulary binds **only** to `displayStatus` (M1); raw ladder status is never rendered.

---

## 9. Contract amendments — M0 exit criteria (blocking)

These are transcribed into `SENTINEL_V3_BUILD_SPEC.md` as normative §10/§14.x clauses with acceptance tests named in §13, and each business decision is recorded in `DECISIONS.md`. Source: §15.2 of the build spec (verified complete against SENT-AUDIT-002) + SENT-AUDIT-003 residuals.

| # | Amendment | Lands in | Acceptance tests (named) |
|---|---|---|---|
| A1 | **R1 fail-closed KPIs**: `tenantCurrency` mandatory; mixed rows → null values + `kpiWithheld` | §6 engine | `kpi/tenant-currency-mandatory` · `kpi/mixed-currency-withholds-value` |
| A2 | **R2** serviceLevel null when `active=0` | §6 | `kpi/service-level-null-when-unplannable` |
| A3 | **R3** missing-CF SKU resolution degrades to recency/unresolved + data-health task | §14.13 | `sku/missing-cf-degrades-to-recency` |
| A4 | **C3** SoD invariant (approver ≠ raiser, API+RLS), value-tiered approval limits, dual approval above configurable threshold, supplier-identity change freeze | §10 roles | `sod/raisers-cannot-approve` (API+DB) · `sod/dual-control-above-threshold` · `sod/supplier-change-freeze` |
| A5 | **C4** strict numerics: Zod-parse at boundary, quarantine on failure, plausibility bounds on all 8 kinds, deliveries-confirmation semantics (quarantine value, run trailing-7-day mean, named UI banner) | §14.8 + ingestion spec | `ingest/strict-parse-quarantines` · `ingest/bounds-every-kind` · `ingest/deliveries-confirmation` |
| A6 | **H5** ledger: HMAC-SHA256 + JCS + no-UPDATE/DELETE incl. Origin (RLS deny + trigger) + read-only verifier role | §11 | `ledger/tamper-resistant` · `ledger/origin-cannot-mutate` · `ledger/jcs-vectors` |
| A7 | **H6** tenant-prefixed idempotency keys (all six) | §14.11 | `ingest/idempotent-per-tenant-replay` |
| A8 | **H7** Supplier ID = identity key (Precoro R4 priority-1 [ADD]) | ingestion spec | `ingest/supplier-identity-key` |
| A9 | **H8** deliveries-history window must cover consumption window or refuse to seed | §14.4 | `ingest/window-alignment-refusal` |
| A10 | P1 set: H4 UTC date-only boundary + tenant TZ · H9 calendar-day input + per-tenant working calendar (flat-calendar byte-identical) · H10 hardening (magic bytes, zip-bomb caps, formula stripping, XXE, AV; email-in same pipeline) · H11 DR numbers · H12 fixture ship | §14.8/§14.9/§12 | `dates/canonical-boundary` · `calendar/flat-tenant-identical` · `ingest/zip-bomb` · `ingest/magic-bytes` · `ingest/formula-stripping` · `dr/restore-rehearsal-gate` |
| A11 | P2 set: M5 producers · M6 matching rules (split/amended/cancelled/returned) · M7 CF versioned governance · M8 restatement vs sealed DayState · M9 freshness SLO · M10 FX fail-safe · M11 MFA policy · M12 CI gates · M13 egress allow-list · M14 ladder warnings | respective §14.x | one named spec each (already enumerated in SENT-AUDIT-002 §8) |
| A12 | **UI stack governance**: shadcn/ui components are **vendored into `packages/ui`** (owned code — no UI runtime dependency); all UI primitives used anywhere must live there (no ad-hoc component copies in `apps/*` — CI grep gate); registry pulls/updates are opt-in and arrive as reviewed diffs (golden-UI + axe a11y suites green + DECISIONS.md entry per upgrade); SDS → Tailwind CSS-variable theme mapping shipped in M0 (status colors + two-axis vocabulary first); SDS remains the design source of truth — theme defaults never override the status language | §3.2 UI + this spec §2 | `ui/no-primitives-outside-packages-ui` (grep) · `ui/sds-theme-token-parity` · `ui/a11y-axe-primary-screens` · `ui/status-vocabulary-binding` · `ui/registry-upgrade-review-required` |

**M0 exit = A1–A9 merged into the contract, A10–A11 scheduled into their milestones' first sprint, all audit probes green, fixtures + checksums shipped.**

---

## 10. Definition of Done — V1 = `1.0.0`

Release is cut **only** when:

1. All **20 gates** of the $50M readiness checklist read PASS (SENT-AUDIT-002 §7, updated by SENT-AUDIT-003 §6) — gates 19–20 evidenced by the cutover project.
2. Audit regression canon green: 117 tests + all probe suites + R1–R3 acceptance tests.
3. `1.0.0-rc.N` has run the parallel window with divergences explained and zero unexplained money/quantity divergences.
4. Restore rehearsal (dated, signed by Origin) and pen-test remediation logged.
5. SBOM + checksums manifest published with the release; `version.json` verified in `/health`.

---

## 11. Risks & standing mitigations

| Risk | Mitigation |
|---|---|
| UI component drift (Radix/Base UI primitives evolve; vendored shadcn code ages) | Owned-code model makes drift **opt-in and reviewable**: registry pulls arrive as diffs behind golden-UI + axe gates (A12); primitives pinned in `package.json`; quarterly drift review scheduled in RUNBOOK; no runtime dependency on any UI package |
| Golden fixtures blocked on business data approval | M0 ships **redacted synthetic-but-representative** fixtures first; real extracts swap in behind the same checksums contract |
| RLS complexity slows delivery | RLS policy matrix is a M1 deliverable with its own Testcontainers suite; no table ships without deny-tests |
| Working-calendar change alters verified outputs | H9 design guarantees flat-calendar tenants are byte-identical; golden suite proves it on every PR |
| IdP availability on-prem | Keycloak runs in the reference compose stack; offline-break-glass account documented in RUNBOOK |
| Test-count drift returns | Changesets + CI publish test counts per package in the PR summary; count change without test-change fails |

---

## 12. Traceability appendix (finding → location → test → gate)

| Finding | Where fixed/planned | Test | Gate |
|---|---|---|---|
| C1 | `core/convertPoLines` (verified) + ingestion call (M1) | `engine.test` H1-case · `ingest/conversion-before-upsert` | 3 |
| C2 | detection verified; containment A1 (M1) | `kpi/mixed-currency-withholds-value` | 4 |
| C3 | A4 (M3) | `sod/*` | 5 |
| C4 | A5 (M1) | `ingest/strict-parse-quarantines` | 6 |
| H1 | verified + A3 (M0) | `sku/missing-cf-degrades-to-recency` | 7 |
| H2, H3 | verified (this audit) | existing suites | 8, 9 |
| H4, H9 | A10 (M2) | `dates/canonical-boundary` · `calendar/*` | 10 |
| H5 | A6 (M3) | `ledger/*` | 11 |
| H6, H7 | A7, A8 (M1) | `ingest/idempotent-per-tenant-replay` · `ingest/supplier-identity-key` | 12 |
| H10 | A10 (M1) | `ingest/zip-bomb` etc. | 13 |
| H11 | A10 + M5 execution | `dr/restore-rehearsal-gate` | 14 |
| H12 | M0 | checksums in CI | 2 |
| M1 | verified + A2 (M0) | `kpi/service-level-null-when-unplannable` | 15 |
| M6 | A11 (M4) | `feedback/matching` | 16 |
| M9 | A11 (M2) | `ops/freshness-alarm` | 17 |
| M12 | §10 pipeline (M0 skeleton → M5 full) | security.yml review + vuln fixture | 18 |
| R1–R3 (new) | A1–A3 (M0) | named in table | 4, 7, 15 |

*Method note: this plan was authored by the independent audit function after re-verifying the remediated package (SENT-AUDIT-003); it inherits, and does not relax, any constraint from SENT-AUDIT-002.*
