# Magick Agency server image. Build from the repo root:
#
#   docker build -f docker/Dockerfile -t magick-agency-server .
#
# Ported from core `docker/Dockerfile`@4850d1d9. PORT NOTE (magick-agency): the
# build stage is a pnpm workspace build (esbuild bundles `apps/server` and the
# `@magick-agency/*` packages into dist/; `pnpm deploy` then lays out only the
# server's production node_modules) where core ran `npm ci && npm run build`.
# The runtime stage's apt layer is core's, verbatim. Dropped from core's runtime:
# `src/prompts/templates` and `web-client/index.html` (AI calling, not carried),
# port 9090 (no metrics endpoint; see docs/status.md "Not built").
#
# DEPLOYMENT INVARIANTS (docs/operations.md "Deployment invariants"; the code
# cannot enforce them):
#   1. ONE replica. The agency runtime, the bridge's unstored-token memo, the
#      reaper, retention and partition jobs all assume a single process (D2).
#   2. Reachable ONLY through exactly TRUST_PROXY_HOPS proxies. Never publish
#      port 3021; put it behind the proxy (docker/docker-compose.prod.yml does).
#   3. NODE_ENV=production (set below) turns Postgres TLS on, and the server
#      certificate is VERIFIED: against Node's roots, or DB_SSL_CA (the PEM text
#      of a private CA) when set. DB_SSL_REJECT_UNAUTHORIZED=false is the only
#      opt-out. TLS parameters in DATABASE_URL are refused at boot.
#   4. Redis persists (AOF or RDB) and never evicts (`noeviction`): a call token
#      lost early is refused and cuts the live call (Q6).
#   5. Stop grace >= 45s: shutdown drains completion emails for up to 30s and
#      Docker's default grace is 10s.

# ── Stage 1: Build backend ───────────────────────────────────────────
FROM node:22-slim AS api-builder
WORKDIR /repo
RUN corepack enable
# Manifests first, so the dependency layer is cached until a lockfile or
# package.json changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/observability/package.json packages/observability/
RUN pnpm install --frozen-lockfile --filter @magick-agency/server...
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/server/ apps/server/
RUN pnpm --filter @magick-agency/server build
# The server's production dependencies only, as a self-contained directory
# (dist/ comes along: it is in the package directory).
RUN pnpm --filter @magick-agency/server deploy --prod --legacy /out

# ── Stage 2: Production runtime ──────────────────────────────────────
FROM node:22-slim
WORKDIR /app
# mpg123 + sndfile-programs are the CLI packages, and that is load-bearing: the
# library-only packages (libmpg123-0 / libsndfile1) ship no binaries and are
# unusable from Node without FFI. They decode customer audio-file announcements
# (mp3 via mpg123, wav/ogg via sndfile-convert) to PCM16 so WebSocket-only
# carriers can stream them. Measured cost +14 MB — full ffmpeg would be +395 MB
# and is only needed for AAC/M4A, which we reject at upload instead.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsamplerate0 mpg123 sndfile-programs && rm -rf /var/lib/apt/lists/*
COPY --from=api-builder /out/dist ./dist
COPY --from=api-builder /out/node_modules ./node_modules
COPY --from=api-builder /out/package.json ./
COPY packages/db/migrations ./migrations
COPY docker/entrypoint.sh ./entrypoint.sh
ENV NODE_ENV=production
EXPOSE 3021
USER node
ENTRYPOINT ["./entrypoint.sh"]
