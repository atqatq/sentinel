# Contributing to Sentinel

## The micro-commit convention (mandatory)

Every commit is **one logical change**, described in **plain english** so that anyone — engineer,
data owner or auditor — can read the log and understand what was written, deleted or improved
without opening the diff.

```
<type>(<scope>): <what changed — plain english, imperative, ≤ 72 chars>
```

| Type | Use for |
|---|---|
| `feat` | new capability (module, screen, formula, endpoint) |
| `fix` | correction of existing behaviour |
| `docs` | spec, ADR, README, Atlas changes |
| `test` | tests only |
| `refactor` | restructuring with zero behaviour change |
| `chore` | tooling, hygiene, CI plumbing |
| `guard` | changes to automated policy gates |

Examples:

```
feat(core): add MOQ guard to order proposal sizing
docs(spec): define OTIF formula, owner and cadence in KPI catalog
fix(engine): floor shelf-life cap instead of rounding up
chore: add editorconfig and gitignore
```

Rules:

1. **Never mix** a behaviour change with a formatting sweep, a rename and a doc edit. Split them.
2. Commit after **every green state** — if tests pass, commit. History is the audit trail.
3. Subject says **what changed**, body (optional) says **why**.
4. Set the template once: `git config commit.template .gitmessage`

## TDD — the engineering method

1. Write a failing test that expresses the next smallest behaviour.
2. Implement the minimum to pass.
3. Refactor green.
4. Commit.

The 117 golden tests (86 engine + 31 feedback) are the migration net and the regression fence.
They are changed **deliberately, never incidentally**.

## Gates every commit must pass

```bash
npm run test    # 117 golden tests green
npm run guard   # forbidden terms / secrets scan clean
```

The guard enforces the data-governance rules: **no client-identifying names, no person or supplier
names, no credential literals, no production data.** If the guard rejects a commit, the fix is to
sanitize the content — never to weaken the guard.

## Decision records

Any decision that shapes architecture, data or the contract is written as a MADR-style ADR in
`docs/adr/` before (or with) the commit that implements it. Spec changes are amendment commits:
the spec is the contract, and the contract evolves in history, not in silence.

## Specs live in-repo

`docs/spec/` is the source of truth. Where code and spec disagree, the spec wins until a written
amendment changes it — then both change in the same push, in separate reviewable commits.
