#!/usr/bin/env bash
# A12 gate: ui/no-primitives-outside-packages-ui
#
# Delivery spec A12: "shadcn/ui components are vendored into packages/ui
# (owned code — no UI runtime dependency); all UI primitives used anywhere
# must live there (no ad-hoc component copies in apps/* — CI grep gate)."
#
# Enforcement: no file outside packages/ui may
#   1. import a Radix primitive          (@radix-ui/...)
#   2. import class-variance-authority   (shadcn primitive signature)
#   3. import the vendored cn() helper from anywhere but packages/ui
#   4. live in a shadcn-style components/ui directory
# Scans git-tracked files only, skipping packages/ui, docs, and fixtures.
set -euo pipefail

cd "$(dirname "$0")/../.."

violations=0

while IFS= read -r file; do
  case "$file" in
    packages/ui/*|docs/*|fixtures/*) continue ;;
  esac
  case "$file" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.css)
      if grep -nE "from ['\"]@radix-ui/" "$file" >/dev/null 2>&1; then
        echo "  ✗ $file: imports @radix-ui directly — primitives live in packages/ui only"
        violations=$((violations + 1))
      fi
      if grep -nE "from ['\"]class-variance-authority" "$file" >/dev/null 2>&1; then
        echo "  ✗ $file: imports class-variance-authority — primitive code lives in packages/ui only"
        violations=$((violations + 1))
      fi
      if grep -nE "from ['\"](@/lib/utils|\.\./lib/utils|\./utils)['\"]" "$file" >/dev/null 2>&1; then
        echo "  ✗ $file: shadcn-style utils import outside packages/ui (ad-hoc primitive copy?)"
        violations=$((violations + 1))
      fi
      ;;
  esac
  case "$file" in
    */components/ui/*|components/ui/*)
      echo "  ✗ $file: file inside a components/ui directory — the only sanctioned home is packages/ui"
      violations=$((violations + 1))
      ;;
  esac
done < <(git ls-files)

if [ "$violations" -gt 0 ]; then
  echo "ui-primitives-scope: ${violations} violation(s) — vendor primitives into packages/ui"
  exit 1
fi
echo "ui-primitives-scope: clean — no primitives outside packages/ui"
