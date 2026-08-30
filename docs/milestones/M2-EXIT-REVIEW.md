# M2 Exit Review — Planning online (`0.3.0`)

**Date:** 2026-08-31 · **HEAD at review:** `e769d9b` (CI all 6 jobs green — Actions-API verified while the push token lived, badge re-confirmed anonymously at review time) · **Verdict: M2 EXIT — gates 15 and 17 (the milestone's assigned gates) CLOSED; gates 7, 8, 9, 10 formally closed with carried evidence; gate 4's and gate 12's scheduled M2 residuals delivered in full. No gate M2 owed remains open.**

M2 turned the verified engine into a live, observable system: the kpi-catalog module (all 28 §16 KPIs defined once as data behind the fail-closed `dataState` envelope), the calendar module (H4 canonical temporal boundary + H9 per-tenant working calendar), plan-service (engine-live wiring behind ports with immutable sealed snapshots), the UI shell with the two-axis status language, the ops/freshness module (DAT-01 SLO + the missing-deliveries alarm), the first §4 screen (`/data-health`) rendering real facts, and the H6 idempotent upsert wrapper (the last scheduled M1 residual). Seven decision records (D-020…D-026) shape the work; this review records D-027. Twenty-seven commits landed between `5c1714c` and `e769d9b`.

## Gate-by-gate evidence

### Gate 15 — KPI layer dataState-aware (M1) — **CLOSED**

The re-audit scored gate 15 PARTIAL: counts fixed, serviceLevel residual R2 open. M2 closes it with a module that owns the whole layer.

- **Defined once, as data**: `kpi-catalog.test.js` pins "the catalog ships all 28 §16 entries with unique ids" and the group arithmetic ("SRC 7, INV 8, DAT 6, TM 5, PM 2"); every entry carries name, definition, formula, source, owner, cadence and target. The layer never re-implements a formula — the portfolio strip maps the engine's verified canon into the envelope, and the INV-04 grain difference is disclosed on every result, never silently reconciled.
- **R1 is dead as a class**: the re-audit's probe (mixed BHD/AED summed into `actualInvValue`, defended only by an optional flag) cannot survive this boundary — `kpi/tenant-currency-mandatory: a portfolio without its currency context throws` (and "an empty-string currency throws the same way"), `kpi/mixed-currency-withholds-value: every money metric is WITHHELD, null, with the currencies named`. Withholding is surgical — INV-04 and INV-03 still render from a mixed run — and "an inconsistent portfolio — kpiWithheld but a money value present — throws". A withheld KPI with a reason is an operational event; a poisoned sum is now structurally impossible at the layer.
- **R2 is dead**: `kpi/service-level-null-when-unplannable: null serviceLevel renders INSUFFICIENT_DATA — never 100, never 0` — the vacuous-fallback 100% for a 100%-unplanned portfolio cannot render. "serviceLevel outside [0,1] throws — the engine canon is a fraction."
- **STALE is explicit, never silent**: the freshness stamp is mandatory ("throws without lastSealedAt — the §16 freshness stamp is mandatory"); time-based cadences carry explicit thresholds (daily 26h, weekly 182h, monthly 744h, hourly 2h; event-based entries are never time-judged); "a stale seal marks STALE but keeps the values"; precedence is pinned (WITHHELD beats stale; INSUFFICIENT_DATA beats stale).
- **The envelope is live, not just tested**: plan-service's `plan_seal` payload carries the dataState envelope (D-022), and the CI `plan-seal-live` proof (14 checks, real PostgreSQL) exercises the seal round-trip — including the hash stability the JSONB storage must guarantee.
- The M1-scheduled residual row — the three A1/A2 named proofs — closes here, named verbatim in the suite header. Decision D-020. 24 tests.

### Gate 17 — Freshness SLO + no-deliveries alarm (M9) — **CLOSED**

- **DAT-01 with the bands bound to the spec text**: the 26/36 bands are extracted from the kpi-catalog DAT-01 target string at test time — "binding: the 26/36 bands are extracted from the kpi-catalog DAT-01 target text — spec drift fails here". Edges are inclusive (exactly 26h FRESH, exactly 36h DEGRADED, past 36h ALARM), mirroring the C4 bounds convention.
- **Worst-across-file-types, structurally bound**: the kind list is read through the ingestion module's public surface (`DATASET_KINDS`, sourced from the manifest itself) and pinned 1:1 — "binding: DATASET_KINDS matches the ingestion manifest 1:1 and the ops module evaluates all eight". A ninth file type without an ops-coverage review fails CI, not production.
- **Silence is never freshness**: "a dataset never sealed is ALARM with NO_SEAL_EVER and a null age"; "DAT-01 value is null and state ALARM when ANY file type has never sealed — no silent number" — the pipeline-side twin of §16's never-a-silent-number rule.
- **The missing-deliveries channel is separate**, per M9's own title: deliveries past the tenant's accepted cadence raise MISSING_DELIVERIES with the H8 task + banner — "a tenant on a weekly deliveries cadence passes 182 and stays quiet at 30h" (the target is tenant-amendable without code change, per §16); never-sealed deliveries raise with a null age and the never-sealed texts. DTA hears the silent feed **before** the morning run refuses, not from the refusal after the fact.
- **Deterministic and fail-closed**: alarms are one per breaching dataset in dataset-asc order, each carrying the DATA_HEALTH task + banner conventions verbatim; the validation family refuses UNKNOWN_DATASET_KIND, FUTURE_SEAL, invalid seals/asOf/cadence; identical inputs produce deep-equal output. Decision D-024. 20 tests.

### Gate 10 — Canonical dates; day-basis calendar (H4, H9) — **CLOSED**

The M1 review's residual table scheduled H4/H9 to M2; the calendar module delivers both.

- **H4 — one canonical temporal form**: date-only UTC as integer day numbers; datetimes convert **at the boundary** with the tenant timezone as an explicit tenant setting (all GCC zones fixed UTC+3 — no DST traps). The audit's E-confirmed defect — `new Date(string)` reading date-only as UTC but datetimes in the server's local zone, flipping `lateByDays` by a day across servers — is structurally dead: "format junk refuses with INVALID_DATE (never new Date())", naive datetimes are refused as instants and accepted only as tenant-local wall time via the explicit setting (recorded as `via: 'naive-local'`). L-14's half-day rounding cannot occur: "dayToDate refuses fractional days with a TypeError". `feedback.js`'s `days()` moved to canonical day-unit math with the 31 canon tests byte-identical — determinism proven, not asserted.
- **H9 — the day basis is calendar-derived and per-tenant**: `WD` becomes per-tenant, per-period, from a week pattern plus merged closure intervals ("overlapping and touching closures merge — no double-count"); unknown spec fields refuse ("a typo in a field name refuses — a silently ignored field is a silently wrong calendar"); flat calendars refuse date-range semantics. §14.4b's identical-basis cancellation stays exact because the SAME per-period wd feeds the driver divisor and the magnification. Named proofs delivered: `calendar/flat-tenant-identical: computeRef with workingDays 22 is byte-identical to the default` (and the `normalizeDeliveries` twin) — a flat-calendar tenant pins the workbook's 22 exactly; hand-verified calendar arithmetic ("count: June 2026 has 22 Sun–Thu working days"; "a 10-day closure removes only its WORKING days").
- Decision D-021. 54 tests across the two files (dates 25, calendar 29).

### Gates 7, 8, 9 — **CLOSED (formally; evidence carried forward)**

The re-audit already scored these PASS in code; M2 closes them formally — the suites are green at this HEAD and their consumers are now live:

- **Gate 7 — preferred-SKU weighting unit-safe (H1)**: the re-audit's "PASS with residual (R3 missing-CF fallback)" was resolved at M1's gate 3 (ingestion refuses missing factors rather than guessing); M2 adds the planning-time mirror — a member declaring a converted unit without a usable factor refuses the whole run (`UNCONVERTIBLE_MEMBER`, D-022). Engine canon 86 green.
- **Gate 8 — scorecards due-line-correct (H2)**: execution-feedback 31 green; the module now also feeds the sealed snapshot path, so the scorecard source of truth is the same live state DTA sees.
- **Gate 9 — weighted-price variance and savings (H3)**: engine canon green; the KPI layer renders the INV metrics from it with the INV-04 grain difference disclosed on every result (D-020) — the reconciliation owes a spec amendment, never a silent edit.

### Gate 4 — **CLOSED (fully; the M2-scheduled KPI-side residuals landed)**

M1 closed gate 4 in its fail-closed aspect and explicitly scheduled the KPI-side named proofs with the KPI module. They landed with D-020 (evidence under gate 15). Nothing of C2 remains open anywhere in the system.

### Gate 12 — **CLOSED (fully; the scheduled application-level wrapper landed)**

M1 closed gate 12 as "contract + schema + live" and scheduled one residual: the application-level idempotent upsert wrapper. D-026 delivers it as three proven layers:

- **Decision layer** (ingestion module): keys derive per kind from INGESTION_FILE_SPEC §4's six-key list — the row's **business identity** (supplier carries the H7 identity base `ext|Supplier ID` vs `name|Name`, so an external-ID identity can never alias a name identity) — with tenant scoping structural via the register's `tenant_id` column ("tenant-scoped by construction", the migration's own note). Verdicts: prior APPLIED → `REPLAY_NOOP` carrying the prior outcome's identity — re-importing the same file changes nothing; RECEIVED/QUARANTINED/FAILED → `APPLY` reprocessing the same register row in place — a retry never forks the file history. Intra-file duplicates collapse last-occurrence-wins at first-occurrence order, disclosed in the plan. Fail-closed family: MISSING/INVALID_IDEMPOTENCY_KEY (a row without its key refuses the WHOLE file), UNKNOWN_DATASET_KIND, INVALID_CHECKSUM/MODE/PRIOR/SEEN, TENANT_MISMATCH.
- **Executor** (packages/db): all rows pre-validated and all statements built **before any write** — a malformed row refuses with zero statements issued, nothing half-applies even outside a transaction; the six wired kinds upsert `ON CONFLICT` on exactly the tenant-leading uniques M1 created; the register write is `ON CONFLICT DO NOTHING` (a retry re-registers nothing); `REPLAY_NOOP` is refused at the executor — it must never reach the database.
- **DAT-04 honesty**: duplicateHits/newKeys are computed from register contents loaded through a port, never assumed from the verdict — a pre-wrapper file replays with honest zeros.
- **Proven three ways in CI**: 29 pure decision tests (ingestion job) + 18 stub-client executor tests (db-rls job, no server needed) + **22 live checks against real PostgreSQL** — per-tenant replay no-op with `applied_at` unchanged, cross-tenant independence ("tenant B's register is EMPTY for the same keys — the H6 defect (cross-tenant collision) is structurally dead"), upsert-in-place with honest DAT-04, FAILED reprocess in place, H7 merge, RLS-fenced register. The named proof `ingest/idempotent-per-tenant-replay` (A7) is delivered. Nothing of H6 remains open.

The live proof earned its keep on its first run: the stub suites cannot see database constraints, and the first CI execution caught the explicit-NULL vs column-DEFAULT defect (`preferred_for_recipe_ref` NOT NULL violation) — fixed at the SQL boundary with COALESCE (`e769d9b`), including the honest-default judgment call (`is_active` coalesces TRUE, the schema's own semantics). This is exactly why the live tier exists.

## Verification summary

| Suite | Count | Where |
|---|---|---|
| planning engine | 86 | `packages/core/modules/planning-engine` |
| execution feedback | 31 | `packages/core/modules/execution-feedback` |
| kpi-catalog (envelope + 28 entries) | 24 | `packages/core/modules/kpi-catalog` |
| calendar dates — H4 boundary | 25 | `packages/core/modules/calendar` |
| calendar — H9 working calendar | 29 | `packages/core/modules/calendar` |
| plan-service (ports, seal, refusals) | 41 | `packages/plan-service` |
| status vocabulary (TS, engine-bound) | 53 | `packages/ui` |
| ops freshness (DAT-01 + missing-deliveries) | 20 | `packages/core/modules/ops` |
| strict parse + bounds | 32 | ingestion |
| file-kind binding (+ H7) | 19 | ingestion |
| unit conversion + C1 + C2 normalization | 36 | ingestion |
| H8 window alignment | 26 | ingestion |
| H10 inbound hardening | 46 | ingestion |
| H6 idempotency decision layer | 29 | ingestion |
| DB schema structural | 13 | `packages/db` |
| H6 executor (stub client) | 18 | `packages/db` |
| data-health facts composition | 15 | `apps/web` |
| **Total (structural)** | **543** | `npm test` exit 0 |

Live in CI (job `db-rls`, postgres:16): RLS deny-matrix **38** + plan-seal **14** + ingest-replay **22** = **74 live checks** (the same job also runs schema 13 + stub 18). The structural total is 543 at this HEAD — the last pre-review battery recorded 542; the difference is the int8-conversion pinning test added in `50b93ee`.

Guards clean: forbidden terms, SDS token parity (51 tokens), UI primitives scope, status-vocabulary-binding (one binding, fail-closed, engine-proven). Golden fixtures 4/4 SHA256SUMS verified at review time. CI on `e769d9b`: all 6 jobs green — UI package, Golden tests, apps/web (first CI build of the data-health screen + facts suite), DB schema + RLS (live proofs included), Policy guards, Ingestion boundary suites.

## Residuals and scheduled obligations

| Obligation | Lands in | Source |
|---|---|---|
| C3 SoD (approver ≠ raiser, thresholds, dual control) | M3 (gate 5) | A4, §6.3 |
| H5 ledger (HMAC/JCS/Origin carve-out) | M3 (gate 11) | A6, §6.3; D-022's canonicalJson hashes are expected to survive the JCS transition — proven by the H5 vectors, never assumed |
| M11 OIDC + MFA | M3 | §6.3 |
| File-to-rows worker — the production caller wiring dropzone/email-in → boundary → H6 executor; `data_health_task` persistence behind it | M3 | D-025/D-026 disclosures (the screen's honest states name it; the H6 layers wait injectable) |
| `KIND_NOT_WIRED` (inventory_all_dimensions, category_owners) + non-daily deliveries day-expansion | M3, with the worker | D-026 disclosed debt |
| Tenant identity request-carried interim → authenticated identity at the boundary | M3 (with C3) | D-022/D-023/D-025 |
| INV-04 grain reconciliation — a spec amendment, not a silent edit | M3+ (spec amendment) | D-020 |
| Stale-banner dismissal (client state) | with the client-shell unit | D-025 |
| Freshness-tone promotion into `packages/ui` | on second consumer (named path) | D-025 |
| Precoro R4 `Supplier ID` column in the real export | Cutover project (external dependency) | A8, carried from M1 |
| FX pinned-rate **service** ADR — owed before any app-layer FX lands | M4/M10 | D-015, carried |
| SRC-05 single-source tile | M4 | A15.2 / D-013, carried |
| H11 restore rehearsal as a go-live gate | M5 | gate 14, carried |

M3 begins the SOURCE & controls milestone (`0.4.0`): proposal → approval → PO workflows with C3 SoD + thresholds + dual control (gate 5), OIDC + MFA (M11), and the H5 ledger (gate 11) — with the file-to-rows worker turning the H6 wrapper from a proven library into the running pipeline.
