declare module "@sentinel/plan-service" {
  /* Minimal surface of the CJS plan-service contract (packages/plan-service).
   * Receipts are plain JSON in documented shapes; they are passed through to
   * the HTTP response verbatim, so they stay loosely typed here on purpose —
   * the API contract lives in the module, not in a second TS copy. */
  export function runPlan(
    request: unknown,
    ports: unknown
  ): Promise<Record<string, unknown>>
  export function handlePlanRun(
    request: unknown,
    deps: unknown
  ): Promise<{ status: number; json: Record<string, unknown> }>
  export function canonicalJson(value: unknown): string
}

declare module "@sentinel/db" {
  /* Minimal surface of the CJS db package contract (packages/db). */
  export const SCHEMA_VERSION: string
  export function makePlanAdapter(
    client: import("pg").PoolClient,
    tenantId: string
  ): {
    loader: {
      loadTenant(tenantId: string): Promise<Record<string, unknown> | null>
      loadPlanInputs(tenantId: string): Promise<Record<string, unknown>>
    }
    saver: {
      saveSeal(seal: Record<string, unknown>): Promise<{
        replayed: boolean
        seal: Record<string, unknown>
      }>
    }
  }
  export function connectPlanClient(connectionString: string): Promise<import("pg").PoolClient>
  export function pgDriver(): typeof import("pg")
}

declare module "@sentinel/module-ops" {
  /* Minimal surface of the CJS ops contract (packages/core/modules/ops) —
   * the M9 freshness facts producer. The freshness envelope is passed
   * through to the data-health facts verbatim, so it stays loosely typed
   * here on purpose: the contract lives in the module (and its 20-test
   * suite), not in a second TS copy. */
  export const freshness: {
    HOUR: number
    DAT01_ID: string
    DAT01_SLO_HOURS: number
    DAT01_ALARM_HOURS: number
    DAT01_OWNER: string
    STATES: Readonly<Record<"FRESH" | "DEGRADED" | "ALARM", string>>
    ALARM_CODES: Readonly<Record<"FRESHNESS" | "MISSING_DELIVERIES", string>>
    BREACH_REASONS: Readonly<Record<"NO_SEAL_EVER" | "SLO_BREACH_ALARM_36H", string>>
    /** Re-export of ingestion's manifest-derived kind list (frozen, 8 kinds). */
    DATASET_KINDS: readonly string[]
    evaluateFreshness(input: {
      asOf: number
      seals: ReadonlyArray<{ kind: string; sealedAt: number | null }>
      missingDeliveriesCadenceHours?: number
    }): {
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
  }
}
