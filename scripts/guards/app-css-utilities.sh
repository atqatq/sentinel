#!/usr/bin/env bash
# ui/no-app-without-utilities (the unstyled-app gate)
#
# The lesson this gate encodes: EVERY automated gate is blind to rendering —
# typecheck, the 1,354-assertion battery, and the other guards all passed
# while the app served browser-default HTML, because globals.css composed
# only "@sentinel/ui/theme" and never imported "tailwindcss" itself. The
# theme package had a compile proof for its own mapping (build-check.css)
# while the APP's composition contract ("Apps compose their own globals.css
# as two imports" — the contract written in that same file's header) had no
# proof at all. A one-line import was the whole difference between the SDS
# and Times New Roman, and nothing would have said a word — the raw token
# custom properties (plain CSS) kept the status colours alive, dressing the
# absence up as "the app is just plain" instead of "the SDS is missing".
#
# Enforcement: compile the APP'S OWN globals.css with the pinned Tailwind CLI
# and require the output to carry:
#   1. preflight            (the base layer — resets exist)
#   2. generated utilities  (a known utility class survives scanning)
#   3. the @theme inline binding (a utility tracks the LIVE SDS variable)
# A theme that compiles but binds nothing, or an app that forgets the
# framework import, refuses here.
set -euo pipefail

cd "$(dirname "$0")/../.."

APP_CSS="apps/web/src/app/globals.css"
OUT="$(mktemp /tmp/sentinel-app-css-XXXXXX.css)"
trap 'rm -f "$OUT"' EXIT

[ -f "$APP_CSS" ] || { echo "  ✗ $APP_CSS missing — the app stylesheet is this guard's subject"; exit 1; }

if ! grep -q '@import "tailwindcss"' "$APP_CSS"; then
  echo "  ✗ $APP_CSS never imports \"tailwindcss\" — no preflight, no utilities layer; the app would render browser-default HTML (the composition contract is written in packages/ui/theme/build-check.css)"
  exit 1
fi

# The CLI bin directly (no package-manager indirection): the gate must not
# depend on how the runner's PATH was prepared, only on pnpm install having
# placed @tailwindcss/cli's bin where the workspace declares it.
UI_BIN="packages/ui/node_modules/.bin/tailwindcss"
[ -x "$UI_BIN" ] || { echo "  ✗ $UI_BIN not found — run pnpm install first (@tailwindcss/cli ships the bin)"; exit 1; }

if ! "$UI_BIN" -i "$APP_CSS" -o "$OUT" >/dev/null 2>&1; then
  echo "  ✗ $APP_CSS does not compile under the pinned Tailwind — the pipeline refuses, the browser would too"
  exit 1
fi

fail=0
grep -q '::before' "$OUT" || { echo "  ✗ preflight missing from the compiled app CSS — the base layer is gone"; fail=1; }
grep -q '\.font-sans' "$OUT" || { echo "  ✗ utilities layer missing — .font-sans not generated (source scanning lost the app's own sources?)"; fail=1; }
grep -q 'var(--surface)' "$OUT" || { echo "  ✗ the @theme inline binding is lost — a utility no longer tracks the live SDS token (A12 broken)"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "app-css-utilities: clean — preflight, utilities and the live SDS token binding all survive the app's own composition"
fi
exit $fail
