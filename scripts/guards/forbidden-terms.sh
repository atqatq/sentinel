#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Forbidden-term & secret guard.
#
# Fails if any tracked file contains:
#   - client-identifying brand or domain fragments
#   - real person or supplier names
#   - secret-shaped strings (provider tokens, AWS keys, private key blocks)
#
# The data-governance rule this enforces: no client-identifying information and
# no production data is ever committed. If this guard rejects a commit, the fix
# is to sanitize the content — never to weaken the guard.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/../.."

PATTERN='client([^a-zA-Z]|$)|clientfood|owner1|owner2|owner3|owner3|owner4|owner5|owner6|owner7|owner8|SupplierA|SupplierB|SupplierC|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY'

# The guard file itself necessarily contains the patterns — exclude it from the scan.
MATCHES="$(git grep -iE "$PATTERN" -- . ':(exclude)scripts/guards/forbidden-terms.sh' || true)"

if [ -n "$MATCHES" ]; then
  echo "FORBIDDEN TERM OR SECRET FOUND — sanitize before committing:"
  echo "$MATCHES"
  exit 1
fi

echo "guard: clean — no forbidden terms, no secrets"
