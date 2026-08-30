/*
 * The two-axis status vocabulary — as data, bound fail-closed.
 *
 * Contract sources (read, not remembered):
 *   - Build spec §3.1: "Status language (two independent axes — never merge
 *     them)". Inventory axis (7 named): OK green · Below Reorder orange ·
 *     Below Safety red · Zero Stock red · Over Stock blue · Follow-up with
 *     Supplier purple · Inactive neutral. Supply axis (5, additive):
 *     Normal · Follow-up with Supplier · Partial Delivery · Late PO ·
 *     Supplier Issue, rendered as a distinct outline/ghost pill.
 *   - Design handoff README §Status: the semantic tone tokens (--ok, --warn,
 *     --critical, --info, --pending, --muted) and the rule "never rely on
 *     colour alone — always pair with a label, a shape, or a position."
 *   - Delivery spec §8: "Status vocabulary binds ONLY to displayStatus (M1);
 *     raw ladder status is never rendered."
 *   - planning-engine displayStatus(): NO_USAGE → 'Inactive',
 *     NO_PARAMS → 'Not Planned', NO_LEAD_TIME → 'No Lead Time', else the
 *     ladder status. supplyStatus(): Supplier Issue > Late PO > Partial
 *     Delivery > Follow-up with Supplier > Normal.
 *
 * Where the handoff leaves the binding open, the call is made here and
 * recorded in DECISIONS.md (D-023) — never left implicit:
 *   - 'Not Planned' / 'No Lead Time' (M1 additions the §3.1 table predates)
 *     bind to --warn: they are data gaps that block planning while
 *     consumption continues — the same class the README puts under --warn
 *     ("stale data"). They are NOT --muted (that would visually bury the
 *     exact state M1 exists to surface) and NOT --critical (no stock-health
 *     failure has occurred). The label carries the distinction — never
 *     colour alone.
 *   - Supply tones: Normal→ok, Follow-up with Supplier→pending (named in the
 *     README token table), Partial Delivery→warn (the README's "MOQ
 *     shortfall" class: a live supply shortfall), Late PO→critical and
 *     Supplier Issue→critical (a broken supply commitment is a failure; the
 *     engine's own severity order puts Supplier Issue last-refused).
 *
 * FAIL-CLOSED: an unknown status never resolves to a neutral tone. The
 * resolvers throw — a status that cannot be bound is a contract violation
 * (engine added a state the vocabulary does not carry) and must be loud.
 * test/status.test.ts proves the binding against the REAL engine exports.
 */

/** Semantic tone tokens — the only colours a status may wear (SDS §Status). */
export type StatusTone = "ok" | "warn" | "critical" | "info" | "pending" | "muted"

export const SDS_TONES: readonly StatusTone[] = [
  "ok", "warn", "critical", "info", "pending", "muted",
] as const

/** One vocabulary entry: the display label and the tone it binds to. */
export interface StatusBinding {
  readonly label: string
  readonly tone: StatusTone
}

/* ---- Inventory axis — the displayStatus domain ---------------------------
 * The engine's displayStatus() output is the ONLY inventory status the UI
 * may render (delivery spec §8). This list is exactly that domain: the six
 * reachable ladder statuses plus the three display overrides. */
export const INVENTORY_STATUSES: readonly StatusBinding[] = [
  { label: "OK", tone: "ok" },
  { label: "Below Reorder", tone: "warn" },
  { label: "Below Safety", tone: "critical" },
  { label: "Zero Stock", tone: "critical" },
  { label: "Over Stock", tone: "info" },
  { label: "Follow-up with Supplier", tone: "pending" },
  { label: "Inactive", tone: "muted" },
  { label: "Not Planned", tone: "warn" },     // M1 displayStatus (NO_PARAMS)
  { label: "No Lead Time", tone: "warn" },    // M1 displayStatus (NO_LEAD_TIME)
] as const

/* ---- Supply axis — independent and additive ------------------------------
 * An item can be healthy AND have a late PO; the axes never collapse. */
export const SUPPLY_STATUSES: readonly StatusBinding[] = [
  { label: "Normal", tone: "ok" },
  { label: "Follow-up with Supplier", tone: "pending" },
  { label: "Partial Delivery", tone: "warn" },
  { label: "Late PO", tone: "critical" },
  { label: "Supplier Issue", tone: "critical" },
] as const

const INVENTORY_BY_LABEL = new Map(INVENTORY_STATUSES.map((b) => [b.label, b]))
const SUPPLY_BY_LABEL = new Map(SUPPLY_STATUSES.map((b) => [b.label, b]))

export type InventoryStatusLabel = (typeof INVENTORY_STATUSES)[number]["label"]
export type SupplyStatusLabel = (typeof SUPPLY_STATUSES)[number]["label"]

function toneFor(map: Map<string, StatusBinding>, axis: string, label: string): StatusTone {
  if (typeof label !== "string" || label === "") {
    throw new Error(`UNKNOWN_STATUS: ${axis} status must be a non-empty string`)
  }
  const binding = map.get(label)
  if (!binding) {
    throw new Error(
      `UNKNOWN_STATUS: "${label}" is not in the ${axis} status vocabulary — ` +
      `raw ladder status must pass through displayStatus before it reaches the UI ` +
      `(delivery spec §8; the vocabulary is the only label→tone binding).`,
    )
  }
  return binding.tone
}

/** Fail-closed label→tone resolution for the inventory axis. Throws on any
 * status outside the displayStatus domain (never falls back to a neutral). */
export function inventoryTone(label: string): StatusTone {
  return toneFor(INVENTORY_BY_LABEL, "inventory", label)
}

/** Fail-closed label→tone resolution for the supply axis. Throws on any
 * status outside the §3.1 supply vocabulary. */
export function supplyTone(label: string): StatusTone {
  return toneFor(SUPPLY_BY_LABEL, "supply", label)
}

/** True when `label` is part of the inventory (displayStatus) vocabulary. */
export function isInventoryStatus(label: string): boolean {
  return INVENTORY_BY_LABEL.has(label)
}

/** True when `label` is part of the supply vocabulary. */
export function isSupplyStatus(label: string): boolean {
  return SUPPLY_BY_LABEL.has(label)
}
