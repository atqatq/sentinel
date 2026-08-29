# ADR-0001 — Everything is a module: the plugin control plane

- **Status:** accepted
- **Date:** 2026-08-30
- **Deciders:** repo owner (atqatq)
- **Tags:** architecture, modules, governance

## Context

The owner directive is explicit: *everything will be like a module/plugin so that in the future we
update plugins with new functionality, optimizations, new features and new plugins all together.*
The build spec already legislates this at §14.15 ("Module management — the plugin control plane"):
one module breaking must never affect anything else, and Origin can add, enable, pause, upgrade,
disable and remove modules at runtime. The delivery spec (§3.2) fixes the monorepo layout. This
ADR maps both onto the actual repository so the codebase and the contract cannot drift.

## Decision

1. **Every capability lives in a module directory carrying a `sentinel.module.json` manifest**
   with: `id`, `version`, `dependencies`, `permissionScopes`, `ingestionKinds` consumed,
   `uiSurfacePoints`, `ledgerEventTypes`. Cross-module access happens through typed contracts
   only — no cross-module internal imports (CI import-boundary gate).
2. **Registry semantics** (implemented when the runtime arrives, contracted now): the registry
   resolves the dependency graph, refuses cycles, and owns the lifecycle
   `REGISTERED → ENABLED ⇄ DISABLED` plus `PAUSED` (quiesced, state kept) and `FAULTED`
   (circuit open). Every transition is a ledger event with actor, timestamp and reason.
3. **Fault containment:** per-module queues and watchdogs, UI error boundaries, capped-retry
   health probes; a faulted module fails fast with `MODULE_UNAVAILABLE` while the platform shell
   and ledger continue. Dependents render explicit "unavailable — module disabled" states.
4. **Adding capability = adding a module:** new module directory + manifest + registration +
   permission grant + first enable — one Origin flow, fully audited. No core surgery, no
   downtime for siblings.
5. **Upgrading a module is staged and reversible:** compatibility check → auto-pause → artifact
   swap → module golden smoke + contract tests → resume; any red gate rolls back to the pinned
   previous version. Upgrades are ledger events. No hot patching of a running module.
6. **Concretely in this repo:**
   - `packages/core/modules/<module-id>/` — pure domain modules (planning-engine,
     execution-feedback), each with manifest + golden tests; core stays framework-free.
   - Future runtime modules land as `packages/<name>` or `apps/<name>` with the same manifest
     discipline (`ingestion`, `kpi-catalog`, `ledger`, `web`).
   - Screen 33 (Module Management, Origin-only) is the human control surface.

## Alternatives considered

- **Monolith with internal packages only (no manifests):** rejected — lifecycle, pause/upgrade
  and audit become conventions instead of mechanics; the owner directive is explicit.
- **Microservices:** rejected — premature for V1; the delivery spec's modular monolith with a
  separate worker process keeps the extraction path open without distributed-systems tax.

## Consequences

- Every new feature PR must ask: *which module owns this?* If the answer is "none", a new module
  directory and manifest are part of the PR.
- CI grows an import-boundary gate (no cross-module internals) and a manifest-lint job before M2.
- The ledger gains `MODULE_*` event types from day one of the ledger milestone (M1).
