# Golden fixtures

This directory holds the golden fixture corpus — synthetic-but-representative
data files whose exact bytes are pinned by checksum, per delivery spec H12:

> Golden fixtures blocked on business data approval → ship redacted synthetic
> fixtures first; real extracts swap in later **behind the same checksums
> contract**.

## Contract

1. Every file in this directory (except this README and `SHA256SUMS`) MUST be
   listed in `SHA256SUMS`. `scripts/check-fixtures.sh` fails otherwise — no
   fixture can be added, edited, or swapped silently.
2. Changing a fixture is a spec-visible event: the changing commit must say
   why (new gate, corrected synthetic generator, approved real-extract swap).
3. Real tenant extracts NEVER land here under their original names or with
   identifying content — the sanitization guard (`scripts/guards/`) runs on
   every commit and CI re-verifies the whole tree.
4. Consumers (ingestion strict-parse tests, M1+) read fixtures through the
   checksum-verified path, so a drifted fixture fails the suite, not the data.

## Status

Empty by design until M1 (Data foundation) ships the first parser, which
lands together with its fixtures and checksums. The contract above is already
enforced by CI.
