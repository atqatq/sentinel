# DECISIONS.md

Every material decision is recorded here (and, where architectural, expanded as a MADR-style ADR
in `docs/adr/`). Silence is unacceptable: if it shaped the system, it is written down.

| # | Date | Decision | Rationale / consequence |
|---|---|---|---|
| D-001 | 2026-08-30 | Repository created as private `atqatq/sentinel`; work proceeds by micro-commits replayed from M0 | Owner requirement: incremental, plain-english history visible on GitHub |
| D-002 | 2026-08-30 | Repo layout follows delivery spec §3.2; module manifests follow build spec §14.15 (`sentinel.module.json`, registry, lifecycle) | The specs are the contract; repo structure must not invent a parallel architecture |
| D-003 | 2026-08-30 | Sanitization guard (`scripts/guards/forbidden-terms.sh`) blocks client brand, person, supplier names and secret-shaped strings in CI | Owner directive: no client-identifying mentions and no production data may ever be committed |
| D-004 | 2026-08-30 | `engine.js` / `feedback.js` ported **verbatim as JavaScript** first (117 golden tests green); TypeScript conversion with types-added/zero-logic-edits follows at M1 when `packages/config` tooling lands | Port and migration are separable failures; golden tests must be green before tooling churn |
| D-005 | 2026-08-30 | Micro-commit convention adopted (CONTRIBUTING.md): one logical change per commit, plain-english subjects, commit after every green state | Owner requirement: commits say what was written, deleted or improved |
| D-006 | 2026-08-30 | Execution boundary confirmed and encoded: Precoro executes; Sentinel plans, approves, verifies (build spec §14.7 transfers, §14.12 cycle counts, screen 15/16 read-only semantics) | Inventory staff work only in the system of record; Sentinel auto-reconciles from ingestion |
| D-007 | 2026-08-30 | Repository goes **public** (owner decision: no plan upgrade). Consequence: the tree *and the entire commit history* must be publishable — history was rewritten to sanitize early verbatim-port fixtures before the flip | Public content must satisfy the same data-governance rule as commits; the guard runs against a public surface |
| D-008 | 2026-08-30 | The guard assembles forbidden terms at runtime from string fragments; the trigger words appear nowhere in the repository, including in the guard itself | In a public repo the guard's own pattern list would leak the names it exists to protect; split fragments are inert |
| D-009 | 2026-08-30 | **No collaborators.** Any contribution requires an explicit, individual invitation from the repository owner; unsolicited PRs are not reviewed | Owner directive: all write access is granted personally, never granted broadly |
