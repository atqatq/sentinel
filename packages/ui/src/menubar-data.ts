/*
 * Menubar groups — README §Layout shell, verbatim (the design handoff wins
 * on rendered detail; the menubar is a TOP-BAR menubar — "There is no
 * sidebar — this was an explicit decision that overrides the collapsible
 * rail described in the original brief").
 *
 * Eight groups, 44 entries. The README marks some entries with `*` — that
 * flag belongs to the DESIGN BUNDLE ("built at full fidelity in this
 * bundle") and is deliberately NOT carried here: `implemented` in this
 * module means "this screen has a route in apps/web", which is app state —
 * currently true for Data Health (/data-health, the M2 data-health unit).
 * Screens without an implementation carry a right-aligned mono 10px
 * EMPTY tag in --text-3 (README §Menubar).
 *
 * Data, not JSX: the group/entry list is testable and renderable by both
 * the menubar and any future command palette without a second copy.
 */

export interface MenubarEntry {
  readonly label: string
  /** Route path in apps/web once the screen's unit lands; null until then. */
  readonly route: string | null
}

export interface MenubarGroup {
  readonly label: string
  readonly entries: readonly MenubarEntry[]
}

const e = (label: string): MenubarEntry => ({ label, route: null })

export const MENUBAR_GROUPS: readonly MenubarGroup[] = [
  {
    label: "Overview",
    entries: [e("Command Center"), e("Analytics"), e("Consolidated"), e("Item 360")],
  },
  {
    label: "Planning",
    entries: [
      e("MRP Board"), e("Calm vs exception"), e("MRP Future"), e("Planning Profiles"),
      e("Parameter Optimization"), e("Demand & Forecast"), e("Demand Profile (TSRC)"), e("Coverage"),
    ],
  },
  {
    label: "Buying",
    entries: [
      e("Order Proposals"), e("Purchase Orders"), e("Purchase Requests"),
      // §14.13c: the approvals tray is the gate's route in apps/web — the
      // second implemented screen after Data Health.
      { label: "Approvals", route: "/approvals" },
      e("Imports & Landed Cost"), e("Pricing"), e("Savings"),
    ],
  },
  {
    label: "Inventory",
    entries: [
      e("Inventory Explorer"), e("Transfers & Staging"), e("Quarantine"), e("Cycle Count Schedule"),
      e("IRA"), e("Warehouse Cost"), e("Lifecycle"), e("Business Continuity"),
    ],
  },
  {
    label: "Suppliers",
    entries: [
      e("Suppliers"), e("Supplier Scorecards"), e("Buyer Scorecard"), e("Lead-time Suggestions"), e("Preferred SKU"),
    ],
  },
  {
    label: "Work",
    entries: [e("Tasks"), e("Projects & Meetings"), e("Proposal Adherence"), e("Missed Shortages")],
  },
  {
    label: "Data",
    entries: [
      e("Data Upload"),
      { label: "Data Health", route: "/data-health" },
      e("Deliveries Entry"),
      e("Audit & Time Machine"),
      e("Intelligence"),
    ],
  },
  {
    label: "Admin",
    entries: [e("Users & Permissions"), e("Origin Bootstrap"), e("Reference & Settings")],
  },
] as const

export const MENUBAR_ENTRY_COUNT = MENUBAR_GROUPS.reduce((n, g) => n + g.entries.length, 0)
