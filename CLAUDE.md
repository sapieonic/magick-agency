# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Magick Agency: the agency dialer (human-agent outbound power dialing) as one self-sufficient app,
extracted from the MagickVoice platform. Start with `docs/README.md` (status, doc map, reading
order). Status: `docs/status.md`. How it is built: `docs/architecture.md`. Decisions (cited by ID
in comments): `docs/decisions.md`. Port ledger: `PORTING.md`. Path rule, lane-owned files and
seams: `docs/seams.md`. Running and deploying: `docs/operations.md`. The plan the build followed:
`docs/history/extraction-plan-v4.2.md` (v4.2, frozen). Domain invariants:
`docs/reference/magickvoice-platform/agency.md`. MagickVoice design docs that comments cite are
copied under `docs/reference/`; nothing here points outside the repo.

## Rules that are not negotiable

- **Port verbatim** from core v1.123.2 / master v3.24.0 / cusui v2.96.0. The only
  allowed changes are the plan's (hop collapses, re-keying onto `agency_calls`,
  billing removal, VoBiz/SIP/softphone deletion). Each change gets a `PORTING.md`
  row and an equivalence or deletion test. Changed lines carry a `PORT NOTE (magick-agency)`
  comment citing the source `file:line@sha`.
- **Test counts are evidence.** A ported suite reports its source's count minus the
  deletions listed in `PORTING.md`. Never `--reporter=basic` (Vitest 4: runs nothing, exits 0).
- **Ports:** Postgres 5436, Redis 6383 (db 0 dev, db 1 test), server 3021, console
  5175, super-admin 5176. Never 5432/5433/5434/6379/6380/6381 (MagickVoice core/master stacks).
- **Contracts and schema are lead-owned.** `packages/contracts` and
  `packages/db/migrations` change only through the lead. Also lead-owned: `apps/server/src/seams/**`,
  `apps/server/src/{app.ts,app-context.ts,index.ts}`, `apps/server/src/config/{index,load,schema,env}.ts`,
  `config/blocks/base.ts`, root config, CI.
- **Lane-owned files:** each lane adds config only in `apps/server/src/config/blocks/<lane>.ts`,
  routes only in `apps/server/src/api/<lane>.plugin.ts`, background work only in
  `apps/server/src/bootstrap/<lane>.ts`, metrics only in `packages/observability/src/metrics/<lane>.ts`.
  Config blocks must declare disjoint top-level keys (enforced at load and by a test).
- **Scoped git:** no `git add -A`, no `git stash`. Nothing is pushed without Manas.
- Zod `.refine` runs on a dirty result: guard `BigInt` / `JSON.parse` inside it.
- Enumerate routes from Fastify's `onRoute` hook (`buildApp({ onRoute })`), never by grep.

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
apps/console/        Vite + React (ported from cusui): agent, supervisor, team, invites, settings
apps/super-admin/    Vite + React: tenants, users, numbers, limits, settings, flags, usage
packages/contracts/  wire contract shared by server and UIs (lead-owned)
packages/domain/     pure agency rules: leaf modules with no imports beyond contracts
packages/db/         pg pool, shared repositories/models, the squashed baseline migration
packages/observability/  logger, OTel tracing (`@Traced`), metric declarations per lane
```

**Four lanes in one server.** The source was three services (core, master, cusui's backend);
here they are lanes inside `apps/server`, each with its own config block, Fastify plugin and
bootstrap:

- **platform** (lane A, from master): identity, tenancy, super-admin auth, RBAC, invites, settings, flags.
- **agency** (lane B, from core `src/agency/`): campaigns, pacing engine, dial dispatcher, agent
  state machine, station WebSocket, dispositions, DNC, retries, reaper, CSV ingest.
- **voice** (lane C, from core): the WebRTC bridge (`src/core/webrtc-bridge-manager.ts`), carrier
  webhooks + media WS, concurrency guard, TTS/audio.
- **analysis** (lane D): post-call/dialer analysis worker, transcription, retention.

`src/index.ts` starts them in a fixed order (platform → voice → agency → analysis, then listen)
and stops them in reverse after closing HTTP; the ordering mirrors core's boot and is deliberate.
`src/app.ts` (`buildApp`) registers app-wide pieces once (rate limiter, error handler + 5xx mask,
`@fastify/websocket`, health probes) before the four plugins. `buildApp({ ctx: null })` builds a
routing-only app for tests.

**Seams** (`docs/seams.md`, `apps/server/src/seams/`): lanes talk through fixed interfaces
registered at bootstrap, e.g. bridge → analysis hooks, super-admin → concurrency control, and the
`WebRtcBridgeManager` member set the agency runtime calls (pinned by a type-level test). A lane that
can't meet a seam as written stops and reports; it does not adapt the seam.

**Path rule:** a ported file keeps its source-relative path (core/master `src/<path>` →
`apps/server/src/<path>`; shared repositories/models → `packages/db/src/...`; tests → the
destination package's `test/unit|integration/<path>`), so later upstream fixes apply with
`git am --directory`.

**Data:** calls are keyed on `agency_calls`. The whole schema is one squashed migration,
`packages/db/migrations/0001_baseline.sql` (node-pg-migrate). Redis holds call tokens and must
not evict (see `.env.example`).
