#!/usr/bin/env bash
# H12 gate: golden fixtures are checksum-pinned.
#
# Contract (fixtures/golden/README.md):
#   - every file in fixtures/golden except README.md and SHA256SUMS must be
#     listed in SHA256SUMS
#   - every listed checksum must match the file on disk
# Empty corpus (pre-M1) is valid: nothing to pin yet.
set -euo pipefail

cd "$(dirname "$0")/.."

DIR="fixtures/golden"
SUMS="$DIR/SHA256SUMS"

fail=0
count=0

# 1. Verify listed checksums (skip entirely if manifest is absent/empty).
if [ -s "$SUMS" ]; then
  if ! (cd "$DIR" && sha256sum --check --quiet SHA256SUMS); then
    echo "  ✗ checksum mismatch — a golden fixture changed without its checksum"
    fail=1
  fi
fi

# 2. Every fixture file must be listed (unless the corpus is empty).
while IFS= read -r f; do
  base="$(basename "$f")"
  count=$((count + 1))
  if [ ! -s "$SUMS" ] || ! grep -qF -- "  $base" "$SUMS"; then
    echo "  ✗ unlisted golden fixture: $base — pin it in SHA256SUMS (or justify the swap in the commit message)"
    fail=1
  fi
done < <(find "$DIR" -maxdepth 1 -type f ! -name README.md ! -name SHA256SUMS)

if [ "$fail" -ne 0 ]; then
  echo "fixture-checksums: FAILED"
  exit 1
fi
echo "fixture-checksums: OK ($count pinned)"
