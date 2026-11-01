# CLAUDE.md

Guidance for Claude Code in this repo. This file holds only what applies everywhere. Each app and
package has its own `CLAUDE.md` with its rules, commands and gotchas; Claude Code loads it when
you work in that directory, so do not copy area detail up here.

Magick Agency: an outbound power dialer for human agents, as one self-contained application.
Start with `docs/README.md` (status, doc map, reading order). Docs and comments describe this repo
only; never cite another system, repo or external design doc.

| Doc | Read it when |
|---|---|
| `docs/status.md` | you need where things stand, test counts, open decisions |
| `docs/architecture.md` | you need how the pieces fit |
| `docs/modules.md` | you are looking for a module and the tests that cover it |
| `docs/decisions.md` | a comment cites an ID (B16, Q6, SP3, ...) |
| `docs/seams.md` | you move a file, add config, a route plugin, a bootstrap or touch a seam |
| `docs/softphone.md`, `docs/mobile.md` | you work on the soft phone or the agent app |
| `docs/operations.md`, `DEPLOYMENT.md` | you run, release or deploy it |

## Layout

```
apps/server/         one Fastify process, single replica: platform, agency, voice, analysis
apps/console/        Vite + React: agent station, soft phone, supervisor, team, invites, settings
apps/super-admin/    Vite + React: tenants, users, numbers, limits, credentials, flags, usage
apps/mobile/         Flutter agent app (Android + iOS); not a pnpm package
packages/contracts/  wire contract shared by server, UIs and (through fixtures) the mobile app
packages/domain/     pure dialer rules: leaf modules, no imports beyond contracts and other leaves
packages/db/         pg pool, shared repositories and models, the migrations
packages/observability/  logger, OTel tracing, metric declarations per module area
packages/web-ui/     components, hooks and helpers shared by both web UIs (B23)
grafana/             alert rules + dashboard (Terraform, own state; grafana/README.md)
aws/                 S3 bucket, IAM user, optional VM per environment (Terraform; aws/README.md)
tooling/             test-env resolver, release-please guard, contract-literal extractor
```

## Rules that are not negotiable

- **Test counts are evidence.** A run without printed counts is not a run. Never
  `--reporter=basic` (Vitest 4: runs nothing, exits 0). Run a package's tests from inside its
  directory (dotenv resolves from cwd).
- **Real Postgres for repository and SQL tests.** A mocked pool hides SQL drift.
- **Ports:** Postgres 5436, Redis 6383 (db 0 dev, db 1 test), server 3021, console 5175,
  super-admin 5176. Never 5432/5433/5434/6379/6380/6381 (other local stacks use them).
- **Never two integration runs on one database.** Integration global setup drops and re-migrates
  it. Each git worktree sets an untracked `.test-env.local.json` at the repo root
  (`{ "dbName": "magick_agency_test_<x>", "redisDb": 2 }`), or worktrees truncate each other's
  rows. Guards refuse any other port, a DB not named `magick_agency_test*`, or Redis db 0
  (`tooling/test-env.ts`).
- **Shared files change deliberately**, with their consumers and tests in the same commit:
  `packages/contracts`, `packages/db/migrations`, `apps/server/src/seams/**`,
  `apps/server/src/{app.ts,app-context.ts,index.ts}`,
  `apps/server/src/config/{index,load,schema,env}.ts`, `apps/server/src/config/blocks/base.ts`,
  root config, CI (`.github/workflows/`) and the release-please config. Never edit or renumber an
  applied migration; add a new one.
- **Mutation-check guard tests.** When a test is claimed to guard something, break the code, watch
  it go red, restore. Commit before mutating, so restoring with `git checkout` cannot lose work.
- **Releases are release-please's** (B24, `docs/operations.md` "Releases and versioning"). PR
  titles are Conventional Commits (`feat(console): …`, `fix(server)!: …`); they become the squash
  commit that picks each component's next version. Never hand-edit a `package.json` `version`, the
  mobile `pubspec.yaml` `version:`, a `CHANGELOG.md` or `.release-please-manifest.json`. A new
  workspace package gets a component in `release-please-config.json` and a manifest entry in the
  same commit (`pnpm test:release`).
- **Scoped git:** `git add <paths>` only; no `git add -A`, no `git stash`. Nothing is pushed
  without Manas.

## Commands

pnpm 10 workspace, Node 22 (`.nvmrc`). Full first-run setup is in `README.md`.

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
pnpm test:integration    # real Postgres/Redis (needs infra:up); packages run serially
pnpm build
pnpm test:grafana        # alert rules + dashboard vs metric declarations
pnpm test:release        # release-please config vs workspace packages, the mobile app and versions

docker build -f docker/Dockerfile -t magick-agency-server .     # production server image
docker build -f docker/web.Dockerfile -t magick-agency-web .     # nginx + both web UIs
```

The mobile app builds with Flutter, not pnpm: see `apps/mobile/CLAUDE.md`.

CI: `.github/workflows/ci.yml` (lint, unit, grafana, release guard, build; integration as three
parallel jobs: db, server, server wall-clock), `mobile.yml` (path-filtered on `apps/mobile`,
`packages/contracts` and the literal extractor), `pr-title.yml`, `release-please.yml`.

The repo's `.mcp.json` adds the Grafana Cloud MCP server (stack `sapieonic`) for live metrics,
logs and alerts.
