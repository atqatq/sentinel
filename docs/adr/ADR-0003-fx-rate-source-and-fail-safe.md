# ADR-0003 — FX rate source of record and the fail-safe posture (M10)

**Status:** Accepted · **Date:** 2026-09-01 · **Decided by:** Origin (recorded in D-038)
**Contract sources:** audit M10 [S] ("FX stale-rate behaviour is unspecified… Fix: fail-safe policy
(continue on last pinned rate, mark all derived money stale-visible, alarm); source of record named.
Acceptance test: `ops/fx-stale.spec`") · build spec Decision 7 ("MP local ↔ USD reserve only. USD rate
pinned for 24h per tenant-day") · build spec §8 jobs ("FX pin (24h)… Idempotent, logged, retry-safe") ·
build spec §16.1 Class S (FX pin named verbatim as a machine-originated write) · DAT-06 (FX pin
coverage %, owner DTA, daily, target 100%) · D-015 (the normalization stage: local ↔ USD only,
direction-named rates, the blanket `RATE_NOT_PINNED` refusal, and the explicit debt — "the pinned-rate
*service* … still owes its required ADR before it lands") · the 0001 migration comment ("the pinning
service and its FX ADR land with the M4 FX fail-safe (M10)").

## Context

Every money figure Sentinel ingests crosses the C2 normalization stage: a document currency that is
not the tenant currency converts at a pinned USD→local rate, one pin per tenant-day (`fx_rate_pin`,
UNIQUE, DECIMAL(18,8), direction named in the column `usd_to_local` — `tenantValue = amount × rate`,
never implied). The table has existed since 0001; the READING side exists (`loadFxPin`,
`normalizeMoney`'s `PINNED_USD` branch). What has never existed is the WRITING side and the policy:

- **Nothing writes pins.** There is no pin service, no door, no job, no correction path. A tenant
  whose rates are not hand-seeded by SQL can never ingest a USD document at all.
- **Stale-rate behaviour is unspecified** (the audit's [S] finding): the pin is daily; when the pin
  job fails, does conversion block, guess, or continue? Silence here is the exact disease D-015's
  "refuse, don't guess" was written to kill — arriving through the back door of availability.
- **No source of record is named.** Screen 32 holds a tenant "FX source" setting, but nothing says
  what feeds the table, what the table's role is, or how a wrong pin is ever corrected.

## Decision

**1. The `fx_rate_pin` table IS the source of record.** Every USD→local conversion in the system
resolves against it and nothing else. Rates ENTER through the tenant's configured FX source (the
screen-32 setting names the origin — the treasury desk's daily publication), delivered as an
operator-maintained daily rate sheet inside the closed ecosystem. **No component fetches rates from
the open internet at run time** (the closed-ecosystem posture, H10/M13): the nightly job reads the
configured source and lands one pin per tenant-day through the pin door. Availability of money
conversion never depends on egress availability.

**2. The pin door is idempotent, logged, retry-safe (the §8 jobs posture).** `pinRate(day, rate, …)`
writes the tenant-day pin and appends ONE Class-S `FX_PIN` ledger block in the same transaction:
- same rate re-pinned for an already-pinned day → **no-op success** (a retried job is not an error);
- a DIFFERENT rate for an already-pinned day → refuses `RATE_DAY_CONFLICT` — the daily pin is not
  silently overwritable;
- a correction is an EXPLICIT act: `correctRate(day, rate, { by, reason })` — reason REQUIRED, the
  UPDATE carries before/after, ONE Class-S `FX_CORRECT` block with the diff. **DELETE is refused
  structurally** (0009: the append-only trigger + the revoked privilege) — correct again, never
  un-pin; the correction trail is the history.

**3. The fail-safe policy (the audit's fix, verbatim).** A conversion for day D resolves, in order:
- **Exact pin for D** → fresh: `rateSource 'PINNED_USD'`, no staleness fields.
- **No pin for D, an earlier pin exists** → **continue on the last pinned rate ≤ D**, and the derived
  money is **STALE-VISIBLE**: the money result carries `stale: true` and
  `rateStale: { pinnedFor, staleDays }`; the ingest run discloses the fallback once per run; the
  data-health alarm fires. The numbers keep flowing; their basis is named everywhere they render.
- **No pin ≤ D at all** → `RATE_NOT_PINNED` stands (D-015 verbatim). There is no rate to continue on;
  the row quarantines. The D-015 blanket refusal **narrows to never-pinned** — this ADR and D-038
  record the amendment explicitly, never silently.

**4. Staleness is alarmed, not graded.** DAT-06's target is 100% daily pin coverage; any conversion
that rode a fallback is a breach of a daily SLO. The ops channel (`ops/fx-stale` named proof, beside
DAT-01's freshness machinery) is therefore binary: the latest pin older than the evaluated day →
`FX_STALE` alarm + DATA_HEALTH task + banner naming `staleDays`; no pin at all → `FX_NEVER_PINNED`
naming the refusing consequence. Owner DTA, cadence daily. Age is disclosed, never graded into
bands — a stale rate is not a little bit acceptable.

**5. Pins are Class-S ledger blocks (§16.1 names FX pin verbatim).** Actor `'system'`, role null;
a manual trigger rides `onBehalfOf` (the operator) with the trigger and job id named in `reason`;
`engineVersion` + `schemaVersion` stamped by the adapter from the repo's own constants — a caller
never labels the chain. The FX pin becomes the chain's first Class-S production writer (the
restatement, D-037, was the first production writer of any class).

**6. The reading side stays pure and shaped.** The worker's rate loader provides the exact-day pin
AND the latest pin ≤ the run day; the resolution order above is the money layer's PURE decision
(`resolveRatePin`, canonical day strings, the H4 discipline — no `Date` parsing, no TZ drift), so the
policy is testable without a database and the database cannot silently reinterpret it.

## Alternatives rejected

- **Block conversions when the day's pin is missing** (the D-015 blanket posture, unamended): a
  failed FX job would quarantine every USD row and blind the loop to USD-supplier deliveries.
  Honesty does not require blindness — continue-with-disclosure keeps the numbers flowing AND names
  their basis everywhere they render.
- **Live internet FX API at run time**: violates the closed ecosystem (H10/M13) and makes money
  conversion depend on egress availability; rejected for the same reason as every external runtime
  dependency.
- **Mutable same-day pins (overwrite)**: erases the trail; a wrong pin corrected silently is the
  restatement disease in miniature. Corrections are explicit, reasoned, diff-carrying updates.
- **Staleness bands (fresh/degraded/alarm by age)**: DAT-06's target is 100% daily coverage; bands
  would render a partially-covered day as acceptable. The alarm is binary; the age is disclosed.

## Consequences

- `packages/db/fx-adapter.js` — the pin door (pinRate / correctRate / the two readers), ledger-armed;
  `0009_fx_fail_safe` — the append-only trigger + the revoked DELETE privilege.
- `normalizeMoney`'s success shape gains ADDITIVE fields (`stale`, `rateStale`) — existing consumers
  see every field they saw before; the USD branch's refusal narrows to never-pinned.
- The worker discloses fallback usage once per run and counts it (DAT-06's numerator).
- `ops` gains the fx staleness channel beside freshness.
- The ledger chain gains its first Class-S writer; `verifyChain` must stay green across a pin.
- Acceptance tests named: `ingestion/fx-fail-safe.spec` (the resolution order, the additive shape,
  the determinism) and `ops/fx-stale.spec` (the alarm channel, the audit's named test).
