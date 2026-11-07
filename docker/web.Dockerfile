# The two UIs, served by nginx, which is also the server's reverse proxy.
# Build from the repo root:
#
#   docker build -f docker/web.Dockerfile -t magick-agency-web .
#
# Both Vite builds call the API on their own origin (`API_BASE` is ''), except the
# console when CONSOLE_API_BASE_URL is set (below), and both own the root path, so each gets its
# own nginx server block (docker/nginx.conf): the console on :8080, the
# super-admin on :8081. nginx 1.27.3+ is required for `server ... resolve` in
# the upstream (re-resolving the server container's address at run time).
#
# VITE_* values are inlined into the bundles at BUILD time, so they are build
# args, not runtime environment. None of them is a secret (Firebase web config
# and a PostHog project key are public by design). The MOBILE_* app-link values are
# the opposite: RUNTIME environment, read at every container start.

FROM node:22-slim AS web-builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/console/package.json apps/console/
COPY apps/super-admin/package.json apps/super-admin/
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/web-ui/package.json packages/web-ui/
RUN pnpm install --frozen-lockfile --filter @magick-agency/console... --filter @magick-agency/super-admin...
COPY tsconfig.base.json ./
COPY packages/contracts/ packages/contracts/
# The console's customer-history search box runs the number rule from packages/domain (CH5).
COPY packages/domain/ packages/domain/
COPY packages/web-ui/ packages/web-ui/
COPY apps/console/ apps/console/
COPY apps/super-admin/ apps/super-admin/
ARG VITE_BRAND=magick-agency
ARG VITE_FIREBASE_API_KEY=
ARG VITE_FIREBASE_AUTH_DOMAIN=
ARG VITE_FIREBASE_PROJECT_ID=
ARG VITE_FIREBASE_STORAGE_BUCKET=
ARG VITE_FIREBASE_MESSAGING_SENDER_ID=
ARG VITE_FIREBASE_APP_ID=
ARG VITE_POSTHOG_KEY=
ARG VITE_POSTHOG_HOST=
ARG VITE_POSTHOG_ENVIRONMENT=production
# The console's API origin, when the API is on its own host (https://api.example.com): the
# console calls it cross-origin, and the server must list the console's origin in
# CORS_ALLOWED_ORIGINS. Unset = the console calls its own origin, as before. The CONSOLE ONLY:
# the super-admin keeps calling its own origin, whose nginx block (:8081) is the only path to
# the /super-admin API. Checked before the build: the console joins it as `${API_BASE}/auth/...`,
# so a trailing slash or a path would 404 every REST call while the station socket (which takes
# only the origin) still connects; and it must be https (http only for localhost), or the
# browser blocks every call from the https console as mixed content. The two builds run in
# parallel, as one `pnpm --filter a --filter b build` did; `wait` fails the step if the
# console's build fails.
ARG CONSOLE_API_BASE_URL=
RUN case "$CONSOLE_API_BASE_URL" in \
      ""|https://?*|http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*) ;; \
      *) echo "CONSOLE_API_BASE_URL must be an https origin (http only for localhost), got: $CONSOLE_API_BASE_URL" >&2; exit 1 ;; \
    esac \
 && case "$CONSOLE_API_BASE_URL" in \
      *://*/*|*\?*|*\#*) echo "CONSOLE_API_BASE_URL must be a bare origin (no path, no trailing slash), got: $CONSOLE_API_BASE_URL" >&2; exit 1 ;; \
    esac \
 && { (VITE_API_BASE_URL="$CONSOLE_API_BASE_URL" pnpm --filter @magick-agency/console build) & c=$!; \
      pnpm --filter @magick-agency/super-admin build && wait $c; }

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
# The image's entrypoint runs /docker-entrypoint.d/*.sh before nginx starts: this one writes
# the Universal Links / App Links files from MOBILE_* env (see the script's header).
COPY docker/mobile-app-links.sh /docker-entrypoint.d/40-mobile-app-links.sh
RUN chmod 0755 /docker-entrypoint.d/40-mobile-app-links.sh
COPY --from=web-builder /repo/apps/console/dist /usr/share/nginx/console
COPY --from=web-builder /repo/apps/super-admin/dist /usr/share/nginx/super-admin
EXPOSE 8080 8081
