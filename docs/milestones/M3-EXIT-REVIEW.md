# M3 Exit Review — SOURCE & controls (`0.4.0`)

**Date:** 2026-08-31 · **HEAD at review:** `696b863` (CI all 6 jobs green on the pre-review HEAD `6eefd19` — Actions-API verified while the push token lived; the review tranche re-verified at its own HEAD post-push) · **Verdict: M3 EXIT — gates 5 and 11 plus the audit's M11 fix (the milestone's assigned items, delivery spec §6.3: "Gates: 5, 11 + M11") CLOSED; every residual row the M2 review scheduled to M3 is delivered or superseded by a named record; two follow-ons born inside M3 are disclosed and scheduled to M4. Nothing M3 owed remains open.**

M3 turned proven libraries into the running, controlled system: the file-to-rows worker (the production ingestion caller — the H6 wrapper no longer waits injectable), the C3 financial-controls layer (the SoD invariant, value tiers, dual control, the supplier-identity freeze), the H5 tamper-evident ledger (RFC 8785, keyed HMAC chain, Origin carve-out, verifier role), and the M11 authentication layer (sessions, the §14.9 floor, mandatory TOTP for approval-capable roles, lockout, the retirement of the request-carried identity interim). Amendment A16 reconciled the INV-04 grain — D-020's named obligation — by spec amendment with the §16.8 module bump, never a silent edit. Five decision records (D-028…D-031 shape the units; this review records D-032). Twenty-three commits landed between `4c8df41` and this review's release commit.

## Gate-by-gate evidence

### Gate 5 — SoD + thresholds + dual control (C3) — **CLOSED**

The audit called C3 "the single most likely fraud vector" — a self-approved PO on a $50M portfolio. The delivery enforces the invariant **twice, by design** (the amendment's "API *and* RLS" pair, neither trusted alone):

- **The pure decision layer** (`packages/core/modules/approval`, 35 tests): principals, tiers, prior votes and hold rows are always injected — no clock, no I/O. The suite pins the FULL per-role-pair SoD matrix (the audit's own "test per role pair") and the three A4 named proofs: `sod/raisers-cannot-approve`, `sod/dual-control-above-threshold`, `sod/supplier-change-freeze`.
- **The SQL surface** (`0003_controls` + `procure-adapter.js`): the SoD invariant is a RESTRICTIVE RLS policy on `approval` (`sod_binding`) that ANDs with tenant isolation, binds every decision to the authenticated actor GUC `app.actor_id` (identity forging is structurally dead — you can only ever cast YOUR OWN approval), refuses the raiser via a proposal subquery (a forged cross-tenant proposal is invisible → NULL → denied, fail-closed), and requires an eligible role (O/SCM/SBR). Approval rows are append-only at RLS with reason NOT NULL. The state-guard trigger is the dual-control backstop: OPEN → APPROVED requires the tier's votes (1 at-or-below the tenant threshold, 2 strictly above), refusing self-approval, ineligible votes, over-limit votes, totals that disagree with the lines, foreign currencies, and every unnamed transition.
- **The supplier-identity change freeze**: identity/remittance changes on `supplier` refuse outright by trigger; the ONLY door is a COOLING_OFF `supplier_change_hold` whose stored delta carries all five frozen fields (null-preserving — the apply path cannot smuggle an extra change), applied only under the transaction-local `app.hold_apply_id` with an exact row match, an out-of-band verification reference, an eligible verifier, and never the requester.
- **Roles are regional data** with Origin-only grant/config/limit writes (`controls_origin_only`); the DEFAULTS are seed placeholders, never hardcoded control values; the first Origin is bootstrapped through the migrator path because a policy that could self-grant would protect nothing. Refusal records are Class-D-shaped — the durable ledger write is H5, the very next unit, consuming the shape verbatim.
- **Proven in CI**: the live proof (`sod-live.js`, real PostgreSQL, **53 checks**) walks policies by 42501, triggers by named refusal code, makes double votes and double conversions structurally impossible via UNIQUE, fences every new table cross-tenant, and exercises the actor-GUC lifecycle loud on reset. **The live proof earned its keep five times on its first runs** — the H7 merge colliding with the freeze door (`4a96d33`), Origin-only policies binding reads and blinding the decision layer (`48079c7`), NUMERIC arriving as strings (`6e56d7b`), limits bound what an approver GRANTS rather than what they refuse (`4c02426`), and the hold's requester not traveling with it (`8862eb5`) — every one a defect the stub suites could not see. Decision D-029. SCHEMA_VERSION 0003.

### Gate 11 — Tamper-evident ledger (H5) — **CLOSED**

- **The canonicalization is RFC 8785 (JCS)**, implemented normatively (`jcs.js`: code-unit key order, ES6 number serialization, §3.2.2.2 escapes, non-ASCII literal) and pinned by checksum-pinned cross-implementation vectors stated FROM the spec — the implementation was right and two of MY OWN fixture expectations were wrong (the G.2 key order; a backslash lost to double-escaping); the vectors were fixed at the generator, the code stood. **The D-022 survival obligation is PROVEN, not assumed**: for the seal-shaped and denial-shaped fixtures, `jcs(value)` is byte-identical to the plan-service `canonicalJson` the seal hashes already ride — the H5 vectors prove the survival by checksum.
- **The chain is keyed HMAC-SHA256** over seq ‖ prevHash ‖ canonicalJson(payload); the key is INJECTED — never read from env, never stored in code or database; GENESIS is 64 zeros; a wrong key is itself detected by the pure walk. The exact §16.2 gate (17 fields, undefined refuses, reason required on denials, canonical UTC instants with sub-ms REFUSING so hashes round-trip TIMESTAMPTZ(6), no-secrets field-name scan).
- **Three independent immutability layers**: SELECT+INSERT grants only (42501), RESTRICTIVE `USING(false)` on UPDATE/DELETE (silent 0 rows even for grant-holders), and `ledger_immutable` triggers (loud even for a superuser bypassing RLS); the `ledger_chain_guard` refuses four named tamper shapes; `sentinel_verifier` is NOLOGIN, NOBYPASSRLS, SELECT-only, cross-tenant.
- **Class-D consumption**: the C3 denial records travel into the chain verbatim (`denialToBlock` — no forked format), and the live proof records a refused mutation ITSELF as a block (§16.4).
- **Proven in CI**: 50 pure tests + 11 stub-adapter tests + the live proof (`ledger-live.js`, **33 checks**): genesis/linkage with the JSONB/timestamptz round-trip, all four chain-guard refusals, all three immutability layers, per-tenant genesis behind the fence, five log classes in ONE chain (export row-count + system-actor stamps), `SOD_SELF_APPROVAL` durably verbatim, no-secrets, write-failure-rolls-back (§16.3 r2), tamper detection at the exact block + restoration re-verifies (the honest boundary named: tampering needs direct superuser access), wrong-key detection, verifier refusing writes.
- **The live proof earned its keep twice on run one**: the tail lock was `SELECT … FOR UPDATE`, which demands the UPDATE privilege immutability layer 1 must never grant — the FIRST real append 42501'd and the construction became a transaction-scoped advisory xact lock taken as its own statement BEFORE the tail read (`de032f7`, D-030 amended in place); and the proof's own JS-in-SQL string-building would have 42601'd — parameters now. Decision D-030. SCHEMA_VERSION 0004.

### Gate M11 — Authentication: sessions, §14.9 floor, mandatory MFA for approval-capable roles, lockout (audit M11 fix) — **CLOSED**

The audit's fix text: "MFA mandatory for all approval-capable roles; session policy at least as strict as Origin's; lockout for all accounts." Named proofs `auth/mfa-approvals.spec` + `auth/session-policy.spec` delivered.

- **The pure layer** (`packages/core/modules/auth`, 27 tests): the §14.9 session floor VERBATIM for everyone — 30-minute idle (DERIVED from `last_seen_at`; no column to drift) and 8-hour absolute pinned at issuance; RFC 6238 TOTP with the Appendix-B SHA-1 vectors STATED FROM THE RFC TEXT (a hand-copied memory value for the sixth vector disagreed with a correct implementation and was settled against rfc-editor.org — the H12 discipline applied to the paper); failed-login lockout for all accounts; password policy; the sign-in machine composable in one atomic unit. The approval-capable set is pinned by parity to C3's APPROVAL_ELIGIBLE authority — the two layers cannot drift apart silently.
- **The SQL surface** (`0005_auth` + `auth-adapter.js`, 28 stub tests + 6 schema pins): `user_credential` (node-native scrypt — the named Argon2id deviation: zero native deps; production passwords live in the OIDC IdP), `mfa_enrolment` (AES-256-GCM wrap-at-rest with an injected key; last_used_step replay guard with a row-level WHERE backstop), `user_session` (token stored ONLY as SHA-256; termination a tombstone), `login_attempt` (append-only, the ledger pattern). The `mfa_gate` RESTRICTIVE policy on approval — `app.mfa_ok='true'` or 42501; never-set NULL and EMPTY both refuse, fail-closed every shape.
- **The request-carried identity interim is retired BY NAME** (D-022/D-023/D-025's schedule completed): `/api/plan` refuses a body-carried tenantId, `/api/data-health` refuses `?tenant=`; the boundary resolves the session once and sets the GUC trio (tenant/actor/mfa) transaction-local; the auth routes are thin transports.
- **Proven in CI**: `auth-live.js`, **28 checks** — and the live proof caught the subtlest defect of the milestone: a fire-and-forget `emit()` in the adapter interleaved protocol frames with the caller's next statement and read GUC state from whatever transaction happened to be current when the round-trip landed (`22P02` → connection terminated). The emission is AWAITED now, the lesson recorded. The GUC-EMPTY semantics discovered at `e048de1` were pinned empirically along the way (never-set = NULL; touched = EMPTY forever; policy casts of EMPTY are loud, never leaky). Decision D-031. SCHEMA_VERSION 0005.

### The file-to-rows worker — the pipeline deliverable — **DELIVERED**

The M2 review scheduled "the production caller wiring dropzone/email-in → boundary → H6 executor" with `data_health_task` persistence. Delivered as D-028 (`f5108f3` + `e45e14f`, CI wired `86944d7`):

- **All eight kinds wired** — the M2 `KIND_NOT_WIRED` residual row (inventory_all_dimensions, category_owners) is delivered with the worker, and the non-daily deliveries day-expansion lands as the D-026-named unit: weekly/monthly/quarterly rows spread as EXACT-SUM integer-micro daily distributions (the last day absorbs the remainder — the H8 window total survives exactly), while **YTD refuses by name** (`YTD_CUMULATIVE_NOT_EXPANDABLE` — spreading a running total would double-count every earlier drop).
- **The single choke point holds**: dropzone / watched-folder / email-in all ride `runFileToRows`; the source is recorded, never consulted — proven by a deep-equal receipt across sources. Strict decode → RFC-4180 grid (explicit delimiter) → formula stripping → kind binding → typed canonical rows with per-row quarantine carrying the ORIGINAL file line.
- **Persistence honesty**: what the pure layers could only RETURN, the worker PERSISTS — QUARANTINED/FAILED register rows on the same H6 unique apply() upserts (a retry reprocesses in place, never forks history); pre-binding refusals write NO register row (the kind column never carries a guess) and live as CRITICAL data-health tasks; guards' tasks land in the register the /data-health screen reads.
- **The suite earned its keep on first run**: the golden `items_modeA.csv` carries a row shifted one column from Brand onward — invisible to every prior suite (file-binding reads HEADERS only); the worker's strict boundary quarantines that row per-row and the honest counters (2 applied, 3 quarantined) are pinned. Also fixed here: the db stub runners were silently swallowing async-test failures — both runners now await every pending assertion before the verdict. 32 worker tests. Decision D-028.

### Amendment A16 — the INV-04 grain reconciled — **DELIVERED**

D-020 disclosed on every KPI result that the catalog text said "shortage-free SKU-days" while the verified canon computes the share over plannable refs (`1 − shortages ÷ active`) — and recorded that reconciliation "owes a spec amendment, not a silent edit." The amendment landed as **A16** (`696b863`): the §16.2 row and an inline amendment note state the plannable-refs grain; the catalog entry, its formula text and the source column adopt it; the result note now RECORDS the reconciliation (history auditable, not erased); the module version bumps per §16.8 governance (kpi-catalog 0.3.0 → 0.4.0). The canon is untouched — golden-pinned — and the target (≥ 97%) and cadence (daily) are unchanged. 24 catalog tests green, one re-pinned to the amended state.

## Verification summary

| Suite | Count | Where |
|---|---|---|
| planning engine | 86 | `packages/core/modules/planning-engine` |
| execution feedback | 31 | `packages/core/modules/execution-feedback` |
| kpi-catalog (envelope + 28 entries, A16 text) | 24 | `packages/core/modules/kpi-catalog` |
| calendar dates — H4 boundary | 25 | `packages/core/modules/calendar` |
| calendar — H9 working calendar | 29 | `packages/core/modules/calendar` |
| plan-service (ports, seal, refusals) | 41 | `packages/plan-service` |
| status vocabulary (TS, engine-bound) | 53 | `packages/ui` |
| ops freshness (DAT-01 + missing-deliveries) | 20 | `packages/core/modules/ops` |
| approval — C3 decision layer | 35 | `packages/core/modules/approval` |
| ledger — H5 pure layer (JCS, chain, gate) | 50 | `packages/core/modules/ledger` |
| auth — M11 pure layer (TOTP, sessions, lockout) | 27 | `packages/core/modules/auth` |
| strict parse + bounds | 32 | ingestion |
| file-kind binding (+ H7) | 19 | ingestion |
| unit conversion + C1 + C2 normalization | 36 | ingestion |
| H8 window alignment | 26 | ingestion |
| H10 inbound hardening | 46 | ingestion |
| H6 idempotency decision layer | 29 | ingestion |
| DB schema structural | 37 | `packages/db` |
| H6 executor (stub client) | 22 | `packages/db` |
| ingest-worker-adapter (stub) | 26 | `packages/db` |
| procure-adapter (stub) | 14 | `packages/db` |
| ledger-adapter (stub) | 11 | `packages/db` |
| auth-adapter (stub) | 28 | `packages/db` |
| file-to-rows worker | 32 | `packages/ingest-service` |
| data-health facts composition | 15 | `apps/web` |
| **Total (structural)** | **794** | `npm test` exit 0 |

Live in CI (job `db-rls`, postgres:16): RLS deny-matrix **47** + plan-seal **14** + ingest-replay **25** + SoD **53** + ledger **33** + auth **28** = **200 live checks** (the same job also runs the schema and stub suites). The live tier earned its keep eight times across the milestone — five C3 catches, the ledger tail-lock privilege defect, the ledger proof's own SQL slips, and the auth fire-and-forget emission — every one invisible to the stub tier.

Guards clean at this HEAD: forbidden terms, SDS token parity (51 tokens), UI primitives scope, status-vocabulary-binding (one binding, fail-closed, engine-proven). Golden fixtures 4/4 and the ledger JCS vectors verified by SHA256SUMS at review time. CI on `6eefd19`: all 6 jobs green (UI package, Golden tests, apps/web build+typecheck — now also run verbatim locally before any push, the Task-51 blind-spot closure — DB schema + RLS with the live proofs, Policy guards, Ingestion boundary suites).

## Residuals and scheduled obligations

| Obligation | Lands in | Source |
|---|---|---|
| `XLSX_EXTRACTION_NOT_WIRED` — a real workbook reader behind the H10 gate (the gate accepts workbooks structurally; byte extraction needs a reader, and no hand-rolled XML parser grows inside a pure module; tenants drop CSV until it lands) | M4 | D-028 disclosure |
| Freeze-ingestion auto-staging — the worker routes supplier-identity deltas into `supplier_change_hold` (COOLING_OFF) instead of today's fail-closed outright refusal | M4 | D-029 disclosure |
| Stale-banner dismissal (client state) | with the client-shell unit | D-025, carried from M2 |
| Freshness-tone promotion into `packages/ui` | on second consumer (named path) | D-025, carried from M2 |
| Precoro R4 `Supplier ID` column in the real export | Cutover project (external dependency) | A8, carried from M1 |
| FX pinned-rate **service** ADR — owed before any app-layer FX lands | M4/M10 | D-015, carried |
| SRC-05 single-source tile | M4 | A15.2 / D-013, carried |
| H11 restore rehearsal as a go-live gate | M5 | gate 14, carried |

M4 begins the Closed loop milestone (`0.5.0`): receipts + reconciliation (M6 matching rules), scorecards, signals (M3), CF governance (M7), restatement semantics (M8), FX fail-safe (M10), supply-status producers (M5) — with the two M3-born follow-ons named above riding the same tranche.
