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
#
# WHY THE ODD QUOTING: this repository is public, so the trigger words must not
# appear in the repository either — including in this script. Each term is
# assembled at runtime from fragments via shell string concatenation. The
# fragments are inert on their own; only the joined runtime value matches.
# Keep them split. Do not "simplify" this file into containing joined terms.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/../.."

# --- client brand fragments ------------------------------------------------
T1="ca""lo"
T2="ca""lofood"

# --- person-name fragments (mock owners in real handoffs) -------------------
T3="no""oh"
T4="al""din"
T5="sham""nas"
T6="koder""imeethel"
T7="reh""aan"
T8="naga ""mahesh"
T9="mohamed ""irshad"
T10="ji""khil"
T11="shan""kar"

# --- supplier-name fragments ------------------------------------------------
T12="ho""reca"
T13="euros ""bake"
T14="traf""co"

# --- secret-shaped patterns: generic, safe to state literally ---------------
SECRETS='github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY'

PATTERN="${T1}([^a-zA-Z]|$)|${T2}|${T3}|${T4}|${T5}|${T6}|${T7}|${T8}|${T9}|${T10}|${T11}|${T12}|${T13}|${T14}|${SECRETS}"

MATCHES="$(git grep -iE "$PATTERN" -- . || true)"

if [ -n "$MATCHES" ]; then
  echo "FORBIDDEN TERM OR SECRET FOUND — sanitize before committing:"
  echo "$MATCHES"
  exit 1
fi

echo "guard: clean — no forbidden terms, no secrets"
