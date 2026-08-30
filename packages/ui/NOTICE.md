# NOTICE — vendored UI primitives

`packages/ui` is the **only** sanctioned home for UI primitives in this
repository (delivery spec amendment A12). Component source is owned code:
there is no UI runtime dependency, and registry upgrades arrive as opt-in,
reviewed diffs (golden-UI + axe a11y suites green + a DECISIONS.md entry).

## Provenance

- `src/button.tsx` and `src/lib/utils.ts` are vendored from
  [shadcn/ui](https://ui.shadcn.com) (new-york style), licensed **MIT**.
  Upstream copyright stays with the shadcn/ui authors.
- `src/status-pill.tsx` is original code written against the design handoff
  README §Status pill recipe (docs/design/README.md) — the recipe is copied
  in the file header so the two can be compared directly.

## Documented adaptations to the vendored button (A12 order: SDS wins)

The upstream component binds to shadcn theme roles (`--primary`, `--ring`,
`--destructive`). This package binds the same variant API to SDS tokens
instead, per the design handoff README:

| Upstream binding | Vendored binding | Authority |
|---|---|---|
| `bg-primary` / `text-primary-foreground` | `bg-text` / `text-inv` | README neutrals table: `--inv` is "text on a `--text`-filled surface (primary buttons)" |
| `bg-destructive` | `bg-critical` | Interpretation: `--critical` is the SDS semantic for failure tones. Destructive *buttons* are not a status display; recorded here so the choice is reviewable |
| `border` (untracked) | `border-line-strong` | README: "emphasis dividers, input borders" |
| `hover:bg-accent` | `hover:bg-hover` | README: `--hover` is "hover / selected chrome fill" |
| `focus-visible:ring-ring/50` | `focus-visible:ring-info/50`, `border-info` | README status table: `--info` applies to "focus ring" |
| `rounded-md` (controls) | `rounded-sm` | README: radius `sm 6` for "controls, inputs, cells, chips" |

If a screen design contradicts any row above, the design handoff wins and the
row is updated in the same commit as the fix.
