# LOCAL-SETUP — run Sentinel on a laptop (macOS Apple Silicon / Linux)

This is the operator walk for a developer laptop: clone → migrate → seed → credential → run the web app and the worker, then the functionality checklist and the Precoro dataset list it rides on.
**Stack:** Next.js web app (`apps/web`) + watched-folder ingestion worker (`apps/worker`) + PostgreSQL 16 (RLS multi-tenant)

On Linux x86-64 every step is identical except the note at the end.

Everything below is arm64-native on Apple Silicon — **no Rosetta needed**.

---

# Part 1 — How to download and run

## 0. What you need (one-time)

| Tool | Version | Install (Terminal) |
|---|---|---|
| **Node.js** | ≥ 22 (repo `engines` floor) | `brew install node@22` or [nvm](https://github.com/nvm-sh/nvm): `nvm install 22` |
| **pnpm** | 9.12.0 (repo `packageManager` pin) | `corepack enable` then `corepack prepare pnpm@9.12.0 --activate` — or use `npm exec -y pnpm@9.12.0 …` |
| **Docker** | any current release | Docker Desktop (or OrbStack / colima) — used for PostgreSQL and (optionally) the container stack |
| **Git** | any | `xcode-select --install` gives you one |

> Alternative to Docker for Postgres: `brew install postgresql@16`. The Docker path is shown below because it matches the repo's compose stack (Postgres 16, published on loopback port **5433**).

## 1. Download and install

```bash
git clone https://github.com/atqatq/sentinel.git
cd sentinel
pnpm install          # installs the whole workspace (apps/web, apps/worker, packages/*)
```

## 2. Start PostgreSQL 16

```bash
docker run -d --name sentinel-db \
  -p 127.0.0.1:5433:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sentinel \
  postgres:16
```

Postgres 16 is a multi-arch image — Docker pulls the **arm64 variant** on your M3 automatically.

### If this step trips — the three states cover everything you'll see

| Symptom | What it means | Fix |
|---|---|---|
| `failed to connect to the docker API … docker.sock: no such file or directory` | Docker Desktop isn't running — the CLI is on PATH but the daemon that executes `run` isn't | Start Docker Desktop, wait until it reports running, then run the command again |
| `The container name "/sentinel-db" is already in use` | An earlier attempt already registered the container (the typical shape when Desktop was mid-start) | **Do not re-run `docker run`** — a second run can only collide. `docker start sentinel-db` |
| The next step answers `connect ECONNREFUSED 127.0.0.1:5433` | The container exists but isn't up (created-never-started, stopped, or started-and-died) | `docker ps -a --filter name=sentinel-db` names the state; `docker start sentinel-db` for a stopped one; if it keeps dying, `docker logs --tail 20 sentinel-db` names the cause — the honest last resort is `docker rm -f sentinel-db` then the `docker run` above, fresh |

The gate before §3 (run it once, read it once):

```bash
docker exec sentinel-db pg_isready -U postgres -d sentinel
# → ... accepting connections
```

After a laptop reboot the whole dance is: start Docker Desktop, then `docker start sentinel-db`
(the container and its data persist across reboots — only the daemon needs waking).

## 3. Apply schema, service roles and the smoke tenant

The repo ships one script that brings a database to the exact deployment shape (same files CI uses):

```bash
DATABASE_URL_ADMIN='postgres://postgres:postgres@127.0.0.1:5433/sentinel' \
  node scripts/e2e/prepare-db.mjs
```

This applies all migrations `0001 → 0009` in sorted order, creates the two service roles
(`sentinel_web`, `sentinel_worker` — LOGIN, **NOBYPASSRLS**, non-superuser, members of the
`sentinel_app` grant role, password `smoke-only`), and seeds the `BahrainMP` smoke tenant.
It is **idempotent** — re-running it is always safe.

## 4. Seed reference data

```bash
docker exec -i sentinel-db psql -U postgres -d sentinel < packages/db/seed.sql
```

This seeds two synthetic tenants, the unit catalog + aliases, FX rate pins, the four
synthetic principals (`origin@` / `manager@` / `senior@` / `buyer@sentinel.synthetic`)
and the approval configuration (dual-control thresholds, per-role limits).

## 5. Bootstrap the Origin (the setup account)

The §14.28 setup doors (D-049): the Origin is the setup account — it creates every other
account, tenant, role and permission, and the first ingestion rides the worker's own pipeline.
The bootstrap script is the migrator path, scripted as ONE transaction:

```bash
export SESSION_WRAP_KEY="$(openssl rand -hex 32)"   # the auth adapter's injected wrap key

node scripts/setup/bootstrap-origin.mjs \
  --email origin@example.com --name 'Operations Origin' \
  --tenant-code BahrainMP --tenant-name 'Bahrain MP' \
  --currency BHD --timezone Asia/Bahrain
```

The **generated password prints ONCE** (never stored in plaintext). The account lands with
`must_change` — sign in and rotate it before anything else. A re-run REFUSES by design
(`SETUP_ORIGIN_EXISTS`) — a second run that "succeeds" would be a silent no-op hiding a
forgotten credential.

Optionally seed the CI fixture data (synthetic tenants, unit catalog, FX pins — useful for
playing with the golden fixtures):

```bash
docker exec -i sentinel-db psql -U postgres -d sentinel < packages/db/seed.sql
```

Then open **http://localhost:3000/setup** — the wizard carries the rest: tenants (the founder
door), users & roles (every account lands `must_change`), approval limits (the §16 amendment),
and the first ingestion (Mode A raw exports or the Mode B template, receipt verbatim).

## 6. Run the web app

```bash
# generate ONCE, never rotate: this key wraps sessions AND TOTP secrets at
# enrollment — a later rotation strands both. .env.local is gitignored:
printf 'SESSION_WRAP_KEY=%s\n' "$(openssl rand -hex 32)" >> apps/web/.env.local
printf 'DATABASE_URL=%s\n' "postgres://sentinel_web:smoke-only@127.0.0.1:5433/sentinel" >> apps/web/.env.local

pnpm --filter @sentinel/web dev
```

- Open **http://localhost:3000/signin** and sign in with the bootstrapped Origin email + the
  printed password. (No MFA is enrolled for local users, so the login answers `OK` directly;
  a wrong password renders `REFUSED` verbatim, five fast failures engage `AUTH_LOCKED`.)
- The origin lands on **/setup**: the first visit forces the password rotation (the
  interstitial), then the wizard takes over. Arriving at the wizard without a session shows
  `SESSION_REQUIRED` — with the door linked (`/signin`) — instead of a dead end.
- `SESSION_WRAP_KEY` must be **≥ 32 chars** or the auth boundary refuses to boot (by design).

## 7. Run the ingestion worker

```bash
mkdir -p ~/sentinel-inbox

DATABASE_URL='postgres://sentinel_worker:smoke-only@127.0.0.1:5433/sentinel' \
SENTINEL_WORKER_INBOX="$HOME/sentinel-inbox" \
SENTINEL_WORKER_POLL_MS=2000 \
SENTINEL_WORKER_AV_REQUIRED=false \
node apps/worker/index.js
```

Worker facts worth knowing:

| Env var | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required, boot-refuses without it) | connect as `sentinel_worker` (NOBYPASSRLS — the RLS discipline is exercised, not skipped) |
| `SENTINEL_WORKER_INBOX` | `/data/inbox` | watched folder root |
| `SENTINEL_WORKER_POLL_MS` | `15000` | poll interval |
| `SENTINEL_WORKER_BATCH_MAX` | `25` | files per cycle |
| `SENTINEL_WORKER_AV_REQUIRED` | `true` (fail-closed) | malware-scan posture. Locally there is no scanner, so you **declare** `false` explicitly — a silent bypass is a defect, a declared posture is not |

**Inbox layout — "the folder speaks":** drop files into `~/sentinel-inbox/<TenantCode>/…`
(e.g. `~/sentinel-inbox/BahrainMP/suppliers.csv`). A file at the inbox root has no tenant,
therefore no fence — it settles into `failed/_unattributed` as a named outcome.
Files settle into `done/`, `quarantine/` or `failed/` beside the tenant folder's file.
`Ctrl-C` / `SIGTERM` drains gracefully (in-flight file finishes, next cycle never starts).

## 8. (Alternative) Full containerized stack

The repo ships two distroless nonroot images:

```bash
docker build -f Dockerfile        -t sentinel-web:local    .
docker build -f Dockerfile.worker -t sentinel-worker:local .
```

`compose.yaml` is the §14.24 e2e-smoke stack (db on `127.0.0.1:5433`, web on
`127.0.0.1:3000`, worker with a bind-mounted `./e2e-inbox`). To run it locally, retag your
builds (`docker tag sentinel-web:local sentinel-web:ci`, same for worker), prepare the
inbox dir (`chmod -R 777 e2e-inbox` — the nonroot worker runs as UID 65532), then
`docker compose up`. On M3 these build and run as arm64 natively.

## 9. Run the test battery locally

```bash
npm test            # 1,348 assertions across 30+ suites (pure core: no DB needed)
npm run guard       # forbidden-terms / token-parity / UI-scope / status-vocabulary guards
pnpm --filter @sentinel/web typecheck
```

Notes: the pure suites run anywhere; the `db-rls`/live suites run in CI against real
PostgreSQL (your local DB serves the same purpose if you want to run them).

## 10. Apple Silicon notes

- Node 22, pnpm, postgres:16, and both Dockerfiles are all arm64-native — nothing needs Rosetta.
- CI builds the images for its own architecture; locally you get arm64 images, which is what your M3 wants anyway.
- First `pnpm --filter @sentinel/web dev` build can take a couple of minutes (Next.js cold compile).
- The scrypt KDF allocates ~64 MiB per hash — irrelevant on 8/16 GB machines, just so you know if you watch memory during logins.

---

# Part 2 — Functionality checklist (walk the system end-to-end)

Work top to bottom; every box is a real, observable behavior.

## Phase A — Toolchain sanity
- [ ] `node -v` ≥ 22; `pnpm install` completes clean
- [ ] `npm test` → **1,348 assertions, all suites green** (includes the perf gate: plan p95 ≈ 252 ms at 4,200 refs, limit 500 ms)
- [ ] `npm run guard` → clean · `pnpm --filter @sentinel/web typecheck` → clean

## Phase B — Database
- [ ] Migrations applied: `SELECT max(version) FROM schema_version`-style check → **0009** (or confirm tables `plan_seal`, `ledger_block`, `fx_rate_pin` exist — the three sentinels)
- [ ] Roles shaped right: `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'sentinel%'` → both service roles LOGIN, NOSUPERUSER, **NOBYPASSRLS**
- [ ] Tenant registry seeded: `BahrainMP` resolves

## Phase C — Auth
- [ ] `POST /api/auth/login` with the registered credential → `ISSUE` + session cookie
- [ ] Wrong password → `REFUSED` (and an append-only `login_attempt` row lands)
- [ ] Logout clears the session; protected routes redirect/refuse without one

## Phase D — Web screens (honest empty states first)
- [ ] Home screen loads with the tenant default
- [ ] **Data Health** screen renders (empty state honest — no tasks yet)
- [ ] **/audit** (screen 12): audit chain table reads the H5 ledger; the time machine re-derives from sealed payloads only
- [ ] **Approvals tray** renders the gate's queue (empty state)
- [ ] **Supplier Scorecards** tile renders the single-source envelope verbatim

## Phase E — Ingestion, Mode A (raw Precoro-style drop)
- [ ] Drop `fixtures/golden/suppliers_modeA_with_bank_columns.csv` into `~/sentinel-inbox/BahrainMP/`
- [ ] Worker log shows the claim → fence → settle walk; file settles `done/`
- [ ] **Security pin:** query the supplier table — the banking columns (IBAN, account holder, etc.) are **absent** from the persisted row (allow-list discarded them at the boundary)
- [ ] Re-drop the identical file → `REPLAY_NOOP` (idempotency per H6: tenant + kind + checksum)
- [ ] Register shows exactly one row for that (tenant, kind, checksum)

## Phase F — Ingestion, Mode B (combined workbook fan-out)
- [ ] Take `docs/templates/Sentinel_Ingestion_Template.xlsx`, paste a small supplier table into `5_SUPPLIERS` and an item table into `1_ITEMS`, drop it → **two** register rows (one per kind) under the file's single checksum; receipt carries `fanout: true` + per-sheet verdicts
- [ ] Fix one tab, re-drop → applied kinds replay as `REPLAY_NOOP`, only the fixed kind applies
- [ ] Negative edges (optional): a tab with unrecognizable headers refuses the workbook whole (`NO_HEADER_ROW_FOUND`); two data tabs claiming one kind refuse (`MULTI_SHEET_KIND_COLLISION`)

## Phase G — Quarantine & discipline
- [ ] Drop a malformed/unknown file → settles `quarantine/` with a named refusal (never silent coercion, never half-applied)
- [ ] A file at the inbox root (no tenant folder) → `failed/_unattributed`, named in the log

## Phase H — Engine & planning
- [ ] Load the bridge datasets (items + inventory + consumption + open POs + deliveries — use `fixtures/golden/items_modeA.csv`, `fixtures/golden/deliveries_template_tab.csv`, and your own data)
- [ ] `POST /api/plan` returns a plan; KPI tiles render; statuses bind to the §-vocabulary
- [ ] Fence honesty visible: the TENANT / FRESHNESS gates answer over HTTP when a request crosses tenants or stale data

## Phase I — Approvals & supplier holds
- [ ] A change above the tenant's dual threshold (BHD 1,000 for the seeded tenant) raises an approval — the tray shows it; decide actions ride the CF decide/apply API
- [ ] Re-export a supplier with a **changed frozen field** (name / payment terms / currency) and drop it → the file **applies** but the delta **auto-stages a COOLING_OFF hold** (§14.27); the identical re-drop **dedupes**; a divergent second delta stages nothing and names both deltas on Data Health

## Phase J — Worker resilience
- [ ] `Ctrl-C` mid-batch → graceful drain (in-flight file completes)
- [ ] A poison file (corrupt bytes) settles `failed/` — the daemon keeps processing the next files (poison isolation)

## Phase K — Containers (optional on a laptop)
- [ ] Both images build; compose stack comes up; `node scripts/e2e/smoke.mjs` walks the golden fixture through the real container fence on the real database

---

# Part 3 — Datasets to download from Precoro (and what to do with them)

**Mode A (day-to-day):** drop the raw Precoro exports as-is — the importer auto-detects each
kind by header signature, strips Precoro's 2 instruction rows, whitelists columns, and upserts
idempotently.
**Mode B (initial load):** one combined workbook, `docs/templates/Sentinel_Ingestion_Template.xlsx`
(8 fixed tabs). Both modes produce identical results.

## The eight datasets

| # | Dataset | Precoro source | Cadence | Blocking? |
|---|---|---|---|---|
| 1 | **Item master** | `ITEMS.xlsx` | On change (weekly); **daily if prices move** | **Yes** — the SKU→Recipe-Ref bridge |
| 2 | **Inventory on hand** | `Inventory_All_Dimensions….xlsx` | **Daily** | **Yes** |
| 3 | **Open POs** | `Open_POs….xlsx` | **Daily** | **Yes** |
| 4 | **Consumption / balances** | `Inventory_Report….xlsx` (start, in, out, end) | **Daily** + a 3-month history at load | **Yes** — seeds the rate |
| 5 | **Deliveries** | **Deliveries dashboard — NOT Precoro** | Daily preferred (weekly/monthly/quarterly/YTD accepted) | **Yes** — the demand primitive; the one whose absence flattens the whole engine |
| 6 | **Suppliers** | `suppliers….xlsx` | On change | No (but lead times matter) |
| 7 | **Planning parameters** | Template tab 7 (Excel DDS) | Initial seed only — owned in Sentinel after go-live | No |
| 8 | **Category owners** | `Category_Buyers.xlsx` / template tab 8 | On change | No |

**Minimum viable daily drop:** Inventory + Open POs + Consumption + **Deliveries**, with a
current Item master as the bridge.

**Not ingested:** GRN/PO PDFs (attach to tasks as evidence); `ingredient-stats.xlsx` (corrupt
export — invalid stylesheet XML — must be re-exported from Precoro for v1.5).

## Precoro export-config changes to request (before cutover W1)

The standard Precoro exports have named gaps — request these additions in the export config:

1. **Open POs:** add `Purchase Order Creation Date` (true lead-time learning), `Purchase Order Status` (`OPEN | CANCELLED | CLOSED` — unknown values quarantine as `PO_STATUS_UNKNOWN`), and **unit price + currency** (price variance / realized savings)
2. **Inventory Report:** supply `Period Start` / `Period End` (or keep them derivable from the filename) — without them consumption cannot be dated
3. **Inventory:** `Warehouse Kind` is Sentinel-supplied (the `Type` column reads `All` everywhere) — cutover W5

## Rules the importer enforces (know before you export)

- **Banking & tax identity is discarded at the boundary** from supplier files (IBAN, account holder, bank name/address, sort code, SWIFT/BIC, ABA, IFSC, Tax ID, PAN, business registration, legal address, phone) — security by allow-list, test-enforced. Don't be surprised when it's gone.
- Header matching is trimmed/case-folded/alias-mapped — `Business Unit Name ` (note the trailing space) matches fine.
- `Payment Terms` free text is parsed to days (`"SOA +45 Days"` → 45); unparsable → flagged, never guessed.
- Idempotency keys: Item `SKU` · Inventory `SKU+Warehouse` · PO `PO#+SKU` · Supplier `Supplier ID` (name interim) · Deliveries `Tenant+Date` · Params `Recipe Ref+Tenant`.
- Upload is **per tenant** — one drop per tenant folder (Mode A), or one workbook per tenant (Mode B).
- Frozen supplier identity changes (ID, name, payment terms, currency) **stage a hold** instead of failing or silently applying — a verifier opens the door out of band.
- A deliveries value ±50% off the trailing 7-day mean requires confirmation — protects against a 1,200-typed-for-12,000 keystroke.

## Repo fixtures you can use before real exports exist

`fixtures/golden/` — `suppliers_modeA_with_bank_columns.csv` (the H12 golden file, deliberately
carrying the banking columns to prove the discard), `items_modeA.csv`,
`deliveries_template_tab.csv`, plus `SHA256SUMS`. Perfect for Phases E–H before touching Precoro.
