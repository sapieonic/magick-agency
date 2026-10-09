# Magick Agency

Human-agent outbound power dialing, as one self-sufficient application.
Extracted from the MagickVoice platform (core, master, cusui). Documentation starts at
[`docs/README.md`](docs/README.md): status, the plan it was built from (v4.2), architecture and
decisions.

## Layout

```
apps/server/         one Fastify process: identity, tenancy, super-admin auth, API,
                     station WS, carrier webhooks + media WS, voice engine, guard,
                     pacing, analysis worker, sweeps, retention
apps/console/        Vite + React: agent, supervisor, team, invites, settings
apps/super-admin/    Vite + React: tenants, users, numbers, limits, settings, flags, usage
packages/contracts/  wire contract shared by server and UIs (lead-owned)
packages/domain/     pure agency rules
packages/db/         pg pool, repositories, the squashed baseline migration
packages/observability/  logger, OTel, metric declarations
```

## Dev setup

### 1. Prerequisites

- **Node 22 or newer** (`.nvmrc` pins 22). `.npmrc` sets `engine-strict`, so an older Node fails at install.
- **pnpm 10.30** (`corepack enable` picks it up from `packageManager`).
- **Docker**, for Postgres and Redis.
- Optional: `mpg123` and `sndfile-programs` (`brew install mpg123 libsndfile` on macOS). The audio decode unit test needs them.

### 2. Install and start the infra

```bash
pnpm install
pnpm infra:up      # Postgres on 5436, Redis on 6383; waits until both are healthy
```

The first start creates two databases, `magick_agency` (dev) and `magick_agency_test`.
Redis db 0 is for dev and db 1 is for tests. These ports belong only to agency. Never point
anything at 5432/5433/5434/6379/6380/6381; those are the MagickVoice core and master stacks.

### 3. Configure the server

```bash
cp apps/server/.env.example apps/server/.env
```

The defaults are enough for the server to boot. The server reads `apps/server/.env` from its
own directory. Add these as you need them:

| Variable | Needed for |
|---|---|
| `SUPER_ADMIN_JWT_SECRET` (16+ chars) | The `/super-admin` API. Without it those routes are not registered and the super-admin UI cannot log in. |
| `FIREBASE_PROJECT_ID`, plus `FIREBASE_SERVICE_ACCOUNT_PATH` or `FIREBASE_SERVICE_ACCOUNT_KEY` | Console login. Without Firebase, outside production, every token check fails with 401. `FIREBASE_AUTH_EMULATOR_HOST` is also read. |
| `TELEPHONY_ENABLED_PROVIDERS=voicelink`, `VOICELINK_*` | Placing real calls. Once VoiceLink is enabled, its fields are required at boot. |
| `MAILJET_API_KEY`, `MAILJET_API_SECRET` | Sending invite and notification mail. |
| `CONSOLE_BASE_URL` | Invite links, e.g. `http://localhost:5175`. |

`.env.example` explains the rest (proxy hops, Postgres TLS, retention, Redis persistence).

### 4. Run the migration

`node-pg-migrate` runs from `packages/db` and does not read the server's `.env`, so export the URL first:

```bash
export DATABASE_URL=postgresql://magick_agency:magick_agency_password@localhost:5436/magick_agency
pnpm migrate:up
```

### 5. Create the first super-admin

No admin is seeded. Create the first one once (this needs `DATABASE_URL` from step 4):

```bash
cd apps/server
SUPER_ADMIN_PASSWORD='choose-one' pnpm tsx scripts/create-super-admin.ts --email you@example.com --name "Your Name"
```

Add `--system` if this admin should never be removable. Every later admin is created from the super-admin UI.

### 6. Configure the console (for login)

The console signs in with Firebase. Put the web app config in `apps/console/.env.local`:

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

Use the same Firebase project as the server's `FIREBASE_PROJECT_ID`. `VITE_API_BASE_URL` can
stay unset in dev: both UIs proxy API calls to `localhost:3021`.

### 7. Start everything

In three terminals:

```bash
pnpm --filter @magick-agency/server dev        # http://localhost:3021 (tsx watch)
pnpm --filter @magick-agency/console dev       # http://localhost:5175
pnpm --filter @magick-agency/super-admin dev   # http://localhost:5176
```

Check the server with `curl localhost:3021/healthz` (process up) and `curl localhost:3021/readyz`
(Postgres and Redis reachable).

### Resetting and stopping

```bash
pnpm infra:down     # stop the containers, keep the data
pnpm infra:reset    # stop and drop the volume; run infra:up and migrate:up again after this
```

### Working in more than one git worktree

All worktrees share the same Postgres and Redis. If two of them run the integration suites
together, they wipe each other's rows. Give each worktree its own test database and Redis db
in an untracked `.test-env.local.json` at the repo root:

```json
{ "dbName": "magick_agency_test_lane_a", "redisDb": 2 }
```

The database name must start with `magick_agency_test`, and the Redis db must not be 0. The
test setup does not create the database, so create it once:

```bash
docker exec magick-agency-postgres createdb -U magick_agency magick_agency_test_lane_a
```

## Checks

```bash
pnpm lint               # tsc --noEmit over src and tests, every package
pnpm test               # unit
pnpm test:integration   # real Postgres/Redis; needs pnpm infra:up
```

Run a single package's tests from inside its directory (dotenv resolves from
cwd). Never point anything at 5432/5433/5434/6379/6380/6381: those belong to the
MagickVoice core and master stacks.
