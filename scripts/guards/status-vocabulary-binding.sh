#!/usr/bin/env bash
# A12 gate: ui/status-vocabulary-binding
#
# Delivery spec §8: "Status vocabulary binds ONLY to displayStatus (M1);
# raw ladder status is never rendered." Build spec §3.1 defines the two
# independent axes; docs/design/README.md fixes the tone semantics.
#
# Enforcement:
#   1. The single label→tone binding lives in packages/ui/src/status.ts —
#      app code may not import the RAW pill primitives for the status axes
#      (they would allow a label to reach the screen without the
#      fail-closed vocabulary resolution).
#   2. App code may not hardcode status label literals — labels come from
#      the vocabulary data (@sentinel/ui/status) or engine payloads; a
#      typo'd copy of a label is how an unbindable status sneaks in.
#   3. The vocabulary module and its engine-parity test exist (positive
#      check — deleting the contract fails the guard, not silently).
#
# Scope: the RENDERING layer (apps/**) only. packages/core legitimately
# OWNS the ladder strings (statusOf is their source; displayStatus is the
# mapping the vocabulary mirrors), and the core/plan suites assert on them
# by contract — neither renders anything.
#
# 'OK', 'Inactive', 'Normal' are deliberately not in the literal ban list:
# they are common words (test names, UI copy); the parity test in
# packages/ui/test/status.test.ts proves their binding against the engine.
set -euo pipefail

cd "$(dirname "$0")/../.."

violations=0

if [ ! -f packages/ui/src/status.ts ]; then
  echo "  ✗ packages/ui/src/status.ts missing — the status vocabulary is the contract, it cannot move or vanish"
  violations=$((violations + 1))
fi
if [ ! -f packages/ui/test/status.test.ts ]; then
  echo "  ✗ packages/ui/test/status.test.ts missing — the engine-parity proof is part of the gate"
  violations=$((violations + 1))
fi

while IFS= read -r file; do
  case "$file" in
    apps/*) ;;
    *) continue ;;
  esac
  case "$file" in
    *.ts|*.tsx|*.js|*.jsx)
      if grep -nE "from ['\"]@sentinel/ui/(status-pill|supply-pill)['\"]" "$file" >/dev/null 2>&1; then
        echo "  ✗ $file: imports a raw status pill — render the axes through @sentinel/ui/inventory-status | supply-status"
        violations=$((violations + 1))
      fi
      if grep -nE "['\"](Below Safety|Below Reorder|Zero Stock|Over Stock|Follow-up with Supplier|No Lead Time|Not Planned|Partial Delivery|Late PO|Supplier Issue)['\"]" "$file" >/dev/null 2>&1; then
        echo "  ✗ $file: hardcodes a status label — import the vocabulary from @sentinel/ui/status"
        violations=$((violations + 1))
      fi
      ;;
  esac
done < <(git ls-files)

if [ "$violations" -gt 0 ]; then
  echo "status-vocabulary-binding: ${violations} violation(s) — bind through packages/ui/src/status.ts"
  exit 1
fi
echo "status-vocabulary-binding: clean — one binding, fail-closed, engine-proven"
