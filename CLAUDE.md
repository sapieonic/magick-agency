# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Magick Agency: human-agent outbound power dialing as one self-contained application. Start with
`docs/README.md` (status, doc map, reading order). Status: `docs/status.md`. How it is built:
`docs/architecture.md`. Every module and its tests: `docs/modules.md`. Decisions (cited by ID in
comments): `docs/decisions.md`. Where files go, module-area files and seams: `docs/seams.md`.
Running and deploying: `docs/operations.md`. Product intent and the delivery phases:
`docs/intent-and-plan.md`. Docs and comments describe this repo only; never cite another
system, repo or external design doc.

## Rules that are not negotiable

- **Test counts are evidence.** A run without printed counts is not a run. Never
  `--reporter=basic` (Vitest 4: runs nothing, exits 0). Run tests from inside the package
  directory (dotenv resolves from cwd).
- **Real Postgres for repository and SQL tests.** A mocked pool hides SQL drift.
- **Ports:** Postgres 5436, Redis 6383 (db 0 dev, db 1 test), server 3021, console 5175,
  super-admin 5176. Never 5432/5433/5434/6379/6380/6381 (other local stacks use them).
- **Never two integration runs on one database.** Integration global setup drops and re-migrates
  it. Each worktree gets its own test database (see below).
- **Contracts, schema and composition files change deliberately.** `packages/contracts`,
  `packages/db/migrations`, `apps/server/src/seams/**`, `apps/server/src/{app.ts,app-context.ts,index.ts}`,
  `apps/server/src/config/{index,load,schema,env}.ts`, `config/blocks/base.ts`, root config and CI are
  shared by every module area: change them with their consumers and tests in the same commit.
  Never edit or renumber an applied migration; add a new one.
- **Module-area files:** each area (platform, agency, voice, analysis) adds config only in
  `apps/server/src/config/blocks/<area>.ts`, routes only in `apps/server/src/api/<area>.plugin.ts`,
  background work only in `apps/server/src/bootstrap/<area>.ts`, metrics only in
  `packages/observability/src/metrics/<area>.ts`. Config blocks must declare disjoint top-level keys
  (enforced at load and by a test). See `docs/seams.md`.
- **Mutation-check guard tests.** When a test is claimed to guard something, break the code, watch
  it go red, restore. Commit before mutating, so restoring with `git checkout` cannot lose work.
- **Guard tests to keep green:** route tables enumerated from `onRoute`, agent-reach tests,
  config-blocks-disjoint, the bridge seam contract, the VoiceLink carrier fixture, the branding
  guards in all three apps, the console dev-proxy prefixes test, the error-code unions.
- **Scoped git:** `git add <paths>` only; no `git add -A`, no `git stash`. Nothing is pushed
  without Manas.
- Zod `.refine` runs on a dirty result: guard `BigInt` / `JSON.parse` inside it.
- Enumerate routes from Fastify's `onRoute` hook (`buildApp({ onRoute })`), never by grep.
- A parameter used in two SQL contexts must be typed at each use (`42P08` otherwise). An optional
  create-input field plus an explicit INSERT column list typechecks and silently drops the value. A
  non-UUID string reaching a `uuid` cast is `22P02`: validate ids at the edge.

## Commands

pnpm 10 workspace, Node 22.

```bash
pnpm install
pnpm infra:up                 # Postgres 5436 + Redis 6383 (docker/docker-compose.dev.yml)
cp apps/server/.env.example apps/server/.env
pnpm migrate:up               # DATABASE_URL from your shell
pnpm --filter @magick-agency/server dev        # :3021 (tsx watch)
pnpm --filter @magick-agency/console dev       # :5175, proxies the API to :3021
pnpm --filter @magick-agency/super-admin dev   # :5176

pnpm lint                # tsc --noEmit over src AND test, every package
pnpm test                # unit, all packages
pnpm test:integration    # real Postgres/Redis (needs infra:up); runs packages serially
pnpm build

docker build -f docker/Dockerfile -t magick-agency-server .     # production server image
docker build -f docker/web.Dockerfile -t magick-agency-web .     # nginx + both UIs
```

Run a package's tests from inside its directory (dotenv resolves from cwd):

```bash
cd apps/server && pnpm vitest run test/unit/agency/pacing-engine.test.ts
cd apps/server && pnpm vitest run -c vitest.config.integration.ts test/integration/agency/<file>.test.ts
cd apps/server && pnpm vitest run -t "<test name>"
```

- Integration suites (server and `packages/db`) run file-serially against one database; the
  db global setup resets the schema and runs the migrations. Chaos suites live under
  `apps/server/test/integration/agency/chaos/` and run with integration.
- Test DB/Redis default to `magick_agency_test` / Redis db 1. Parallel git worktrees must each
  set an untracked `.test-env.local.json` at the repo root (`{ "dbName": "magick_agency_test_<x>",
  "redisDb": 2 }`), or they truncate each other's rows. Guards refuse any other port, a DB not
  named `magick_agency_test*`, or Redis db 0. See `tooling/test-env.ts`.
- `apps/server/test/unit/audio/decode.test.ts` needs `mpg123` and `sndfile-programs` installed.
- Console tests are split into two Vitest projects: `*.timezone.test.ts(x)` vs the rest, with
  TZ=UTC and an en-US locale pinned in `vite.config.ts`. A file must match exactly one project.
- First super-admin: `SUPER_ADMIN_PASSWORD=… pnpm tsx scripts/create-super-admin.ts --email … --name …`
  from `apps/server` (no seeded credentials).

## Architecture

```
apps/server/         one Fastify process, single replica
apps/console/        Vite + React: agent station, supervisor, team, invites, settings
apps/super-admin/    Vite + React: tenants, users, numbers, limits, settings, flags, usage
packages/contracts/  wire contract shared by server and UIs
packages/domain/     pure dialer rules: leaf modules with no imports beyond contracts
packages/db/         pg pool, shared repositories/models, the baseline migration
packages/observability/  logger, OTel tracing (`@Traced`), metric declarations per module area
```

**Four module areas in one server**, each with its own config block, Fastify plugin and bootstrap:

- **platform**: identity, tenancy, super-admin auth, RBAC, invites, settings, flags, notifications, audit.
- **agency** (`src/agency/`): the dialer runtime (pacing engine, dial dispatcher, agent state
  machine, station WebSocket, wrap-up, reaper) and campaign management (campaigns, roster ingest,
  dispositions, DNC, retries, staffing, stats).
- **voice** (`src/core/`, `src/telephony/`): the voice engine: WebRTC bridge
  (`src/core/webrtc-bridge-manager.ts`), VoiceLink webhooks and media WS, concurrency guard, audio.
- **analysis**: post-call transcription and analysis worker, retention.

`src/index.ts` starts them in a fixed order (platform → voice → agency → analysis, then listen) and,
on shutdown, closes HTTP first and stops them in reverse. Voice starts before agency so the bridge's
startup self-heal finishes before any pacing tick. `src/app.ts` (`buildApp`) registers app-wide pieces
once (rate limiter, error handler + 5xx mask, `@fastify/websocket`, health probes) before the four
plugins. `buildApp({ ctx: null })` builds a routing-only app for tests.

**Public API layer and internal handler instance.** The public route handlers (auth, tenancy, RBAC,
validation, enrichment) call the dialer's handlers in-process through `callCore`
(`src/api/core-dispatch.ts`) on a private Fastify instance that never listens
(`src/api/core-handlers.ts`). Decision B16.

**Seams** (`docs/seams.md`, `apps/server/src/seams/`): module areas talk through fixed interfaces
registered at bootstrap, e.g. bridge → analysis hooks, super-admin → concurrency control, and the
`WebRtcBridgeManager` member set the dialer runtime calls (pinned by a type-level test).

**Data:** calls are rows in `agency_calls`. The whole schema is one migration,
`packages/db/migrations/0001_baseline.sql` (node-pg-migrate), inventoried in `packages/db/BASELINE.md`.
Redis holds leases and call tokens and must not evict (see `.env.example`).
