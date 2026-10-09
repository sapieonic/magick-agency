# The two UIs, served by nginx, which is also the server's reverse proxy.
# Build from the repo root:
#
#   docker build -f docker/web.Dockerfile -t magick-agency-web .
#
# Both Vite builds call the API on their own origin (`API_BASE` is ''
# unless VITE_API_BASE_URL is set), and both own the root path, so each gets its
# own nginx server block (docker/nginx.conf): the console on :8080, the
# super-admin on :8081. nginx 1.27.3+ is required for `server ... resolve` in
# the upstream (re-resolving the server container's address at run time).
#
# VITE_* values are inlined into the bundles at BUILD time, so they are build
# args, not runtime environment. None of them is a secret (Firebase web config
# and a PostHog project key are public by design).

FROM node:22-slim AS web-builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/console/package.json apps/console/
COPY apps/super-admin/package.json apps/super-admin/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --filter @magick-agency/console... --filter @magick-agency/super-admin...
COPY tsconfig.base.json ./
COPY packages/contracts/ packages/contracts/
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
RUN pnpm --filter @magick-agency/console --filter @magick-agency/super-admin build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-builder /repo/apps/console/dist /usr/share/nginx/console
COPY --from=web-builder /repo/apps/super-admin/dist /usr/share/nginx/super-admin
EXPOSE 8080 8081
