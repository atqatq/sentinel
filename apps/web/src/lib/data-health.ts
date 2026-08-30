/* ============================================================================
 * Data-health facts composition — the pure layer between the db adapter's
 * rows and the /data-health screen + /api/data-health transport (M2
 * data-health screens; D-024: "the data-health screens render from these
 * facts in their unit").
 *
 * Home rules:
 *   - packages/db owns the SQL (data-health-adapter.js — one source);
 *     THIS file owns the composition semantics; the route/page own transport.
 *   - The ops freshness module is INJECTED (`deps.freshnessApi`), not
 *     imported: identical inputs must produce identical facts, and the
 *     suite proves the composition against the real ops surface without a
 *     workspace install (the route's composition root wires the real
 *     @sentinel/module-ops import — ADR-0001 consumption stays at the
 *     package surface).
 *   - The clock is injected (`asOfMs`); no `new Date()` anywhere. The
 *     freshness module validates the stamps (FUTURE_SEAL etc.) BEFORE the
 *     banner arithmetic runs, so no staleness rule is duplicated here.
 *   - Everything in the envelope is a plain serializable value — the
 *     response body IS the envelope, verbatim.
 *
 * Honesty rules encoded here (never a silent number, never an invented one):
 *   - refsBlocked renders a number ONLY when at least one open payload
 *     states it; otherwise null + a named disclosure (an under-count would
 *     impersonate a zero).
 *   - The stale banner exists only when a real seal exists and is older
 *     than one day (the README shell rule — days, deliberately independent
 *     of DAT-01's 26h pipeline SLO). No stamp ever → no banner; the
 *     freshness panel already screams, the banner would only repeat it.
 *   - Unknown severity / unknown ingest kind throw — fail-closed, like the
 *     status vocabulary. An unbindable value never renders neutral.
 * ==========================================================================*/

/* ---- structural contracts (mirrors of the modules' own shapes; the types
 *      live here because the composition is what binds them together) ---- */

export interface FreshnessFacts {
  asOf: number
  perDataset: Array<{
    kind: string
    lastSealedAt: number | null
    ageHours: number | null
    state: string
    reason: string | null
  }>
  worst: { kind: string; lastSealedAt: number | null; ageHours: number | null; state: string; reason: string | null }
  dat01: { id: string; value: number | null; state: string; owner: string }
  alarms: Array<{
    code: string
    dataset: string
    ageHours: number | null
    reason: string | null
    owner: string
    task: { type: string; field: string; detail: string }
    banner: { text: string }
  }>
  missingDeliveries: {
    raised: boolean
    code?: string
    dataset?: string
    ageHours?: number | null
    state?: string
    owner?: string
    task?: { type: string; field: string; detail: string }
    banner?: { text: string }
  }
}

/** The slice of the ops freshness surface the composition consumes. */
export interface FreshnessApi {
  evaluateFreshness(input: {
    asOf: number
    seals: Array<{ kind: string; sealedAt: number | null }>
    missingDeliveriesCadenceHours?: number
  }): FreshnessFacts
  STATES: { FRESH: string; DEGRADED: string; ALARM: string }
  DAT01_SLO_HOURS: number
  DAT01_ALARM_HOURS: number
  DAT01_OWNER: string
  DATASET_KINDS: readonly string[]
}

export interface StampRow {
  kind: string
  lastAppliedAtMs: number | null
}

export interface TaskRow {
  id: string
  taskType: string
  severity: string
  status: string
  payload: Record<string, unknown> | null
  createdAtMs: number
  resolvedAtMs: number | null
}

/** A register row shaped for rendering — every cell pre-resolved. */
export interface RegisterRow {
  id: string
  taskType: string
  name: string
  countText: string
  /** 0–100 scope number, or null when the payload does not state one. */
  scopePct: number | null
  blocks: string | null
  /** null = Unassigned — the §9 rule renders it critical and tints the row. */
  owner: string | null
  severity: string
  status: string
  createdAtMs: number
}

export interface DataHealthFacts {
  tenant: { code: string; name: string }
  asOfMs: number
  freshness: FreshnessFacts
  /** The DAT-01 target rendered on the screen — carried as data from the
   *  ops constants (bound by the ops suite to the kpi-catalog text) so the
   *  render layer never restates a spec number outside the binding. */
  dat01Target: { sloHours: number; alarmHours: number; owner: string }
  register: {
    kpis: {
      openGaps: number
      unassignedGaps: number
      refsBlocked: number | null
      closedThisMonth: number
    }
    rows: RegisterRow[]
  }
  ingestCounts: { received: number; applied: number }
  /** Present only when the newest seal is older than one day. */
  staleBanner: { daysOld: number; sinceDisplay: string } | null
  disclosures: string[]
}

export interface DataHealthInput {
  tenant: { code: string; name: string }
  asOfMs: number
  stamps: StampRow[]
  tasks: TaskRow[]
  closedThisMonth: number
  ingestCounts: { received: number; applied: number }
  deps: FreshnessApi
  /** Tenant-amendable deliveries cadence (hours); omitted = the module's
   *  daily-preferred default — disclosed, never silent. */
  deliveriesCadenceHours?: number
}

/* ---- helpers ---- */

const DAY_MS = 86_400_000

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

/** "YYYY-MM-DD HH:mm" in UTC — deterministic on every server (the H4
 *  canonical-boundary lesson: a wall-clock render is a server-dependent lie). */
export function formatUtcMinutes(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  )
}

/** UTC month start of the given instant — "closed this month" window. */
export function utcMonthStart(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, WARN: 1, INFO: 2 }

/* ---- seals ---- */

/** Fold the adapter's per-kind stamps over the canonical kind list. A kind
 *  present in ingest_file but absent from the ops/ingestion vocabulary is a
 *  wiring error (D-024: a file type added without an ops-coverage review
 *  must fail loudly, never silently skip evaluation). */
export function buildSealStamps(
  stamps: StampRow[],
  kinds: readonly string[]
): Array<{ kind: string; sealedAt: number | null }> {
  const byKind = new Map(stamps.map((s) => [s.kind, s.lastAppliedAtMs]))
  for (const s of stamps) {
    if (!kinds.includes(s.kind)) {
      throw new Error(
        `UNKNOWN_INGEST_KIND: ingest_file kind '${s.kind}' is not in the freshness vocabulary — ` +
        "a dataset kind was added without an ops-coverage review (D-024)"
      )
    }
  }
  return kinds.map((kind) => ({ kind, sealedAt: byKind.get(kind) ?? null }))
}

/* ---- register ---- */

function severityRank(severity: string): number {
  const rank = SEVERITY_RANK[severity]
  if (rank === undefined) {
    throw new Error(
      `UNKNOWN_SEVERITY: data-health task severity '${severity}' is not in the ` +
      "DataHealthSeverity vocabulary (CRITICAL | WARN | INFO) — fail-closed, an unbindable severity never renders neutral"
    )
  }
  return rank
}

function toRegisterRow(t: TaskRow): RegisterRow {
  const p = (t.payload ?? {}) as Record<string, unknown>
  const name = typeof p.name === "string" && p.name !== "" ? p.name : t.taskType
  const countText = typeof p.count === "string" && p.count !== "" ? p.count : "—"
  const scopePct = isFiniteNumber(p.scopePct) && p.scopePct >= 0 && p.scopePct <= 100 ? p.scopePct : null
  const blocks = typeof p.blocks === "string" && p.blocks !== "" ? p.blocks : null
  const owner = typeof p.owner === "string" && p.owner !== "" ? p.owner : null
  return {
    id: t.id,
    taskType: t.taskType,
    name,
    countText,
    scopePct,
    blocks,
    owner,
    severity: t.severity,
    status: t.status,
    createdAtMs: t.createdAtMs,
  }
}

/** Register order: severity first (the register is triage, critical on top),
 *  then newest, then id — deterministic for a given state. */
export function sortRegisterRows(rows: RegisterRow[]): RegisterRow[] {
  return [...rows].sort((a, b) => {
    const r = severityRank(a.severity) - severityRank(b.severity)
    if (r !== 0) return r
    if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/* ---- composition ---- */

export function composeDataHealthFacts(input: DataHealthInput): DataHealthFacts {
  const { tenant, asOfMs, stamps, tasks, closedThisMonth, ingestCounts, deps } = input

  /* The ops module validates asOf/seals/cadence fail-closed (INVALID_ASOF,
   * FUTURE_SEAL, UNKNOWN_DATASET_KIND, INVALID_DELIVERIES_CADENCE) — its
   * throw is the contract; nothing here pre-empts it. */
  const freshness = deps.evaluateFreshness({
    asOf: asOfMs,
    seals: buildSealStamps(stamps, deps.DATASET_KINDS),
    ...(input.deliveriesCadenceHours === undefined ? {} : { missingDeliveriesCadenceHours: input.deliveriesCadenceHours }),
  })

  const rows = sortRegisterRows(tasks.map(toRegisterRow))

  /* refsBlocked: a number only when the payloads actually state it —
   * summing absent fields to a silent zero would impersonate health. */
  let refsBlocked: number | null = null
  const disclosures: string[] = []
  if (tasks.length > 0) {
    let stated = 0
    let sum = 0
    for (const t of tasks) {
      const v = (t.payload ?? {})["refsBlocked"]
      if (isFiniteNumber(v) && v >= 0) {
        stated += 1
        sum += v
      }
    }
    if (stated > 0) {
      refsBlocked = sum
      if (stated < tasks.length) {
        disclosures.push(
          `refsBlocked is stated on ${stated} of ${tasks.length} open task payloads — the KPI sums what is stated (an under-count, disclosed rather than invented)`
        )
      }
    } else {
      disclosures.push(
        "no open task payload states refsBlocked — the KPI is withheld (null) rather than shown as a lying zero"
      )
    }
  }

  if (input.deliveriesCadenceHours === undefined) {
    disclosures.push(
      `the deliveries channel uses the daily-preferred default (${deps.DAT01_SLO_HOURS}h) — the tenant cadence parameter is not set yet`
    )
  }
  if (freshness.dat01.value === null) {
    disclosures.push(
      "DAT-01 has no honest value while any file type has never sealed — the pipeline shows alarms, not a number"
    )
  }

  /* Stale banner — the README shell rule, on real facts: the NEWEST seal
   * older than one day means every dataset is at least that stale. The
   * freshness evaluation above has already rejected future stamps, so the
   * age here is non-negative by construction. */
  const newest = stamps.reduce<number | null>(
    (acc, s) => (s.lastAppliedAtMs !== null && (acc === null || s.lastAppliedAtMs > acc) ? s.lastAppliedAtMs : acc),
    null
  )
  const staleBanner =
    newest !== null && asOfMs - newest > DAY_MS
      ? { daysOld: Math.floor((asOfMs - newest) / DAY_MS), sinceDisplay: formatUtcMinutes(newest) }
      : null

  return {
    tenant,
    asOfMs,
    freshness,
    dat01Target: {
      sloHours: deps.DAT01_SLO_HOURS,
      alarmHours: deps.DAT01_ALARM_HOURS,
      owner: deps.DAT01_OWNER,
    },
    register: {
      kpis: {
        openGaps: tasks.length,
        unassignedGaps: rows.filter((r) => r.owner === null).length,
        refsBlocked,
        closedThisMonth,
      },
      rows,
    },
    ingestCounts,
    staleBanner,
    disclosures,
  }
}
