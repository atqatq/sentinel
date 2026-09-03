import type { Pool, PoolClient } from "pg"

import { makePlanAdapter, makeLedgerAdapter, resolveTenantByCode } from "@sentinel/db"

import {
  buildTimeline,
  type Timeline,
} from "./timemachine"

/*
 * readAuditSurface — the ONE server-side reader for the /audit screen
 * (screen 12: the audit chain table + the time machine).
 *
 * Two reads, one fence (ADR-0002): the registry lookup resolves the tenant
 * CODE above the fence, then ONE transaction with the transaction-local
 * tenant GUC scopes both the sealed-day window (plan_seal — the time
 * machine re-derives every snapshot from the SEALED payload, never live
 * tables) and the ledger blocks (the audit chain table).
 *
 * The chain's integrity pill is honest about ARMAMENT: verifyChain walks
 * the chain under the deployment's HMAC key. Unarmed (no key in the
 * environment), the reader does NOT fabricate a verdict — it returns
 * verified: null and the screen renders the disclosure. The adapter
 * factory refuses unarmed construction (LEDGER_CONFIG_KEY_REQUIRED), so
 * the blocks table rides the same armed path: a real deployment is armed;
 * a laptop without a key sees the truth, not a broken table.
 */

export interface AuditChainBlock {
  readonly seq: number
  readonly class: string
  readonly actor: string
  readonly entity: string
  readonly entityId: string | null
  readonly action: string
  readonly outcome: string
  readonly before: unknown
  readonly after: unknown
  readonly reason: string | null
  readonly atMs: number
  readonly hash: string
}

export interface AuditChainSurface {
  readonly verified: boolean | null // null = unarmed — the reader refuses to guess
  readonly entryCount: number | null
  readonly blocks: readonly AuditChainBlock[] | null
}

export type AuditSurfaceRead =
  | { ok: true; chain: AuditChainSurface; timeline: Timeline }
  | { ok: false; phase: "POOL" | "TENANT" | "DB"; message: string }

export async function readAuditSurface(
  pool: Pool,
  tenantCode: string,
  opts?: { windowDays?: number }
): Promise<AuditSurfaceRead> {
  const windowDays = opts?.windowDays ?? 90

  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (e) {
    return { ok: false, phase: "POOL", message: `could not acquire a database client: ${(e as Error).message}` }
  }

  try {
    await client.query("BEGIN")

    const tenant = await resolveTenantByCode(client, tenantCode)
    if (!tenant) {
      await client.query("ROLLBACK")
      return { ok: false, phase: "TENANT", message: `tenant '${tenantCode}' is not in the registry` }
    }

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id])

    /* the time machine: the sealed days of the window, payload included */
    const plan = makePlanAdapter(client, tenant.id)
    const days = (await plan.saver.listSealedDays({ limit: windowDays })) as Array<{
      sealDate: string
      payloadHash: string
      engineVersion: string
      payload: unknown
    }>
    const timeline = buildTimeline(days)

    /* the audit chain: armed only with the deployment's HMAC key — the same
     * armament the decide/apply transport requires; UNARMED the surface
     * discloses instead of fabricating a verdict. */
    const ledgerKey = process.env.SENTINEL_LEDGER_HMAC_KEY
    let chain: AuditChainSurface
    if (!ledgerKey) {
      chain = { verified: null, entryCount: null, blocks: null }
    } else {
      const ledger = makeLedgerAdapter(client, tenant.id, {
        hmacKey: ledgerKey,
        actor: "system:audit-read",
        role: null,
      })
      const [blocks, entryCount, verdict] = (await Promise.all([
        ledger.listBlocks({ limit: 50 }),
        ledger.countBlocks(),
        ledger.verifyChain(),
      ])) as [AuditChainBlock[], number, { verified?: boolean }]
      chain = {
        verified: verdict?.verified === true ? true : verdict?.verified === false ? false : null,
        entryCount,
        blocks,
      }
    }

    await client.query("COMMIT")
    return { ok: true, chain, timeline }
  } catch (e) {
    try {
      await client.query("ROLLBACK")
    } catch {
      /* the connection is already broken — release below returns it anyway */
    }
    return { ok: false, phase: "DB", message: (e as Error).message }
  } finally {
    client.release()
  }
}
