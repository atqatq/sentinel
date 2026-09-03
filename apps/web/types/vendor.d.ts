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

declare module "@sentinel/procure-service" {
  /* Minimal surface of the CJS procure-service contract (packages/procure-service).
   * Receipts are plain JSON in documented shapes; they are passed through to
   * the HTTP response verbatim, so they stay loosely typed here on purpose —
   * the API contract lives in the module, not in a second TS copy. */
  export function handleCfDecision(
    request: unknown,
    deps: unknown
  ): Promise<{ status: number; json: Record<string, unknown> }>
}

declare module "@sentinel/db" {
  /* Minimal surface of the CJS db package contract (packages/db). */
  export const SCHEMA_VERSION: string
  /* The sourcing-controls decision adapter (C3 workflow executor; the CF
   * door lives here — loosely typed on purpose, the contract is the module's). */
  export function makeProcureAdapter(
    client: import("pg").PoolClient,
    tenantId: string
  ): {
    loadCfVersionById(versionId: string): Promise<Record<string, unknown> | null>
    /* The §14.13c tray read: every PENDING version, oldest request first. */
    listPendingCfVersions(): Promise<
      Array<{
        id: string
        sku: string
        version: number
        fromValue: number | null
        toValue: number
        requestedReason: string | null
        createdAt: string | Date
      }>
    >
    loadLatestSealPayload(): Promise<Record<string, unknown> | null>
    resolveCfVersion(input: Record<string, unknown>): Promise<Record<string, unknown>>
  }
  /* The H5 ledger executor (appendBlock / appendDenialRecord / verifyChain). */
  export function makeLedgerAdapter(
    client: import("pg").PoolClient,
    tenantId: string,
    config: {
      hmacKey: string
      actor: string
      role?: string | null
      sessionId?: string | null
      sourceIp?: string | null
      onBehalfOf?: string | null
    }
  ): {
    appendBlock(input: Record<string, unknown>): Promise<{ seq: number; prevHash: string; hash: string; at: unknown }>
    appendDenialRecord(denial: Record<string, unknown>, over?: Record<string, unknown>): Promise<{ seq: number; hash: string }>
    recordRefusedMutation(input: Record<string, unknown>): Promise<{ seq: number; hash: string }>
    loadChain(): Promise<Array<Record<string, unknown>>>
    /* Screen 12's audit-chain reads: newest first, capped in-statement. */
    listBlocks(input?: { limit?: number }): Promise<
      Array<{
        seq: number
        class: string
        actor: string
        entity: string
        entityId: string | null
        action: string
        outcome: string
        before: unknown
        after: unknown
        reason: string | null
        atMs: number
        hash: string
      }>
    >
    countBlocks(): Promise<number>
    verifyChain(): Promise<{ ok: boolean; verified: number | boolean }>
  }
  export function makePlanAdapter(
    client: import("pg").PoolClient,
    tenantId: string,
    opts?: {
      ledger: {
        hmacKey: string
        actor: string
        role?: string | null
        sessionId?: string | null
        sourceIp?: string | null
        onBehalfOf?: string | null
      }
    }
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
      /* The M8 door (§14.16) — present only when opts.ledger armed it. */
      restateSeal?(
        input: Record<string, unknown>
      ): Promise<Record<string, unknown>>
      loadDayVersions(sealDate: string): Promise<Record<string, unknown> | null>
      /* Screen 12's span read: the sealed days of a window, newest first,
       * payload included — the time machine re-derives from the sealed truth. */
      listSealedDays(input: {
        fromDay?: string
        toDay?: string
        limit?: number
      }): Promise<
        Array<{
          sealDate: string
          payloadHash: string
          engineVersion: string
          payload: unknown
        }>
      >
    }
  }
  export function connectPlanClient(connectionString: string): Promise<import("pg").PoolClient>
  export function pgDriver(): typeof import("pg")
  /* Data-health read side (single SQL source; RLS-fenced by the caller's
   * transaction-local app.tenant_id + the explicit tenant_id predicate). */
  export function makeDataHealthAdapter(
    client: import("pg").PoolClient,
    tenantId: string
  ): {
    lastAppliedStampByKind(): Promise<Array<{ kind: string; lastAppliedAtMs: number | null }>>
    listOpenTasks(): Promise<Array<{
      id: string
      taskType: string
      severity: string
      status: string
      payload: Record<string, unknown> | null
      createdAtMs: number
      resolvedAtMs: number | null
    }>>
    countResolvedSince(sinceMs: number): Promise<number>
    countIngestFiles(): Promise<{ received: number; applied: number }>
  }
  /** Tenant-registry lookup (unfenced by design — returns the fence identity).
   *  The client is duck-typed on .query — a Pool or a PoolClient both work. */
  export function resolveTenantByCode(
    client: import("pg").Pool | import("pg").PoolClient,
    code: string
  ): Promise<{ id: string; code: string; name: string } | null>
  /* M11 auth surface (0005_auth + auth-adapter.js): the sign-in machine,
   * session lifecycle and the tenant switcher. The full decision contract
   * lives in the pure auth module and its suites; loosely typed here on
   * purpose — the API contract lives in the module, not in a second TS copy. */
  export function makeAuthAdapter(
    client: unknown,
    config: { wrapKey: string; now?: () => Date; ledger?: { forTenant(tenantId: string): unknown } }
  ): {
    attemptLogin(args: {
      email: string
      password: string
      code?: string | null
      ip?: string | null
    }): Promise<
      | { outcome: "REFUSED"; reason: string; until?: number }
      | { outcome: "CHALLENGE_MFA"; tenantCode: string }
      | {
          outcome: "ISSUE"
          token: string
          session: Record<string, unknown>
          principal: { userId: string; tenantId: string; tenantCode: string; role: string; mfaOk: boolean }
        }
    >
    resolveSession(
      token: string,
      opts?: { noTouch?: boolean }
    ): Promise<
      | { resolved: false; reason: string; session?: Record<string, unknown> }
      | {
          resolved: true
          session: {
            sessionId: string
            userId: string
            tenantId: string
            role: string
            mfaOk: boolean
            isOrigin: boolean
            tenantCode: string
          }
          principal: { userId: string; role: string; mfaOk: boolean; isOrigin: boolean; tenantCode: string }
        }
    >
    terminateSession(token: string): Promise<{ terminated: boolean }>
    setSessionTenant(token: string, tenantId: string): Promise<{ moved: boolean }>
    hasTenantRole(userId: string, tenantId: string): Promise<boolean>
    listUserTenants(
      userId: string
    ): Promise<Array<{ tenantId: string; tenantCode: string; role: string }>>
  }
  /* The SRC-05 evidence read (the Suppliers tile; the kpi-catalog's
   * evaluateSrc05 owns the formula — this adapter owns the evidence rows). */
  export function makeSourcingAdapter(
    client: import("pg").PoolClient,
    tenantId: string
  ): {
    loadLastSealStamp(): Promise<number | null>
    loadCategorySupplierEvidence(): Promise<{
      categories: Array<{ category: string; itemCount: number; supplierCount: number | null }>
      openLines: number
      unattributedLines: number
    }>
  }
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
