# ============================================================================
# sentinel-web — the §14.23 image contract (build spec §7.1 step 7 / §6.2).
#
# Multi-stage, three stages, each with one job:
#   deps    — resolve the pnpm workspace from the frozen lockfile (pnpm fetch
#             reads the lockfile alone; the install links offline from the
#             store once the manifests are present)
#   build   — compile the standalone bundle with the FULL toolchain
#   runtime — distroless nonroot; carries ONLY the traced standalone output
#             (.next/standalone + .next/static), never the toolchain, never
#             the full node_modules — the trace is the ONLY dependency story
#             this stage trusts.
#
# Every base image is pinned BY DIGEST (a floating tag is an unpinned
# dependency — the pinning gate's exactness extends to base images). Bumping
# a digest is a reviewed diff, never a silent drift; the image-gate proof
# (scripts/build/test/image-gate.test.mjs) pins this file's shape.
#
# Non-root, no shell, no package manager in runtime: distroless :nonroot runs
# as UID 65532 and ships NO shell — the container healthcheck is the
# orchestrator's HTTP probe against /health (§6.2 L-07 stamps), never a
# shell exec. Runtime configuration (DATABASE_URL, ledger key, session wrap
# key) rides environment at exec — no secret is baked into any layer.
# ============================================================================

# ---- deps: the pnpm workspace from the frozen lockfile ---------------------
FROM node:22.22-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline

# ---- build: the standalone bundle ------------------------------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm -C apps/web build

# ---- runtime: distroless nonroot, standalone only ---------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=nonroot:nonroot /app/apps/web/.next/standalone ./
COPY --from=build --chown=nonroot:nonroot /app/apps/web/.next/static ./apps/web/.next/static
USER nonroot
EXPOSE 3000
CMD ["apps/web/server.js"]
