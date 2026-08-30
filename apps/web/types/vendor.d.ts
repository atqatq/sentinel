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
