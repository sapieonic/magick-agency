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
| `docs/insights.md` | you work on the campaign Insights tab, its rollup or the pacing history |
| `docs/customer-history.md` | you work on the customer-history search (one number across campaigns) |
| `docs/inbound.md` | you work on inbound calls (Plivo callbacks to agency numbers, sticky agent, queue, follow-ups); §12 is the build plan and status |
| `docs/reports.md` | you work on report exports (agent, campaign, account PDFs and workbooks, subscriptions, the renderer) |
| `REPORTS_SETUP.md` | you set reports up for the first time, on a dev machine or in a deployment (the renderer, the Lambda, the flag) |
| `db-hygiene.md` | you touch the pg pool's session settings, write a migration on a large table, or run database maintenance (backups, statistics, timeouts) |
| `docs/operations.md`, `DEPLOYMENT.md` | you run, release or deploy it |

## Layout

```
apps/server/         one Fastify process, single replica: platform, agency, voice, analysis
apps/console/        Vite + React: agent station, soft phone, supervisor, team, invites, settings
apps/super-admin/    Vite + React: tenants, users, numbers, limits, credentials, flags, usage
apps/report-renderer/ report PDFs and workbooks from a dataset; runs as a Lambda or in the server (RP15)
apps/mobile/         Flutter agent app (Android + iOS); not a pnpm package
packages/contracts/  wire contract shared by server, UIs and (through fixtures) the mobile app
packages/domain/     pure dialer rules: leaf modules, no imports beyond contracts and other leaves
packages/db/         pg pool, shared repositories and models, the migrations
packages/observability/  logger, OTel tracing, metric declarations per module area
packages/web-ui/     components, hooks and helpers shared by both web UIs (B23)
grafana/             alert rules + dashboard (Terraform, own state key in the S3 state bucket; grafana/README.md)
aws/                 S3 bucket, IAM user, optional VM per environment; aws/state the Terraform state bucket (aws/README.md)
tooling/             test-env resolver, release-please guard, contract-literal extractor
```

## Rules that are not negotiable

- **Test counts are evidence.** A run without printed counts is not a run. Never
  `--reporter=basic` (Vitest 4: runs nothing, exits 0). Run a package's tests from inside its
  directory (dotenv resolves from cwd). Record counts only from a green run; a run with failures
  is reported as its failures, not as a count.
- **Real Postgres for repository and SQL tests.** A mocked pool hides SQL drift.
- **Ports:** Postgres 5436, Redis 6383 (db 0 dev, dbs 1-4 test), server 3021, console 5175,
  super-admin 5176. Never 5432/5433/5434/6379/6380/6381 (other local stacks use them).
- **Never two integration runs on one database.** Integration global setup drops and re-migrates
  it; files run in parallel, worker N on Redis db `redisDb + N - 1` and on its own copy of the
  database (`<db>_w<N>`), made afresh from it before each file, so no file sees what another
  left. Up to 4 workers (`TEST_WORKERS`; 1 runs files one at a time). Each other git worktree
  sets an untracked `.test-env.local.json` at the repo root with a database and a Redis range of
  its own, `workers` included (`{ "dbName": "magick_agency_test_<x>", "redisDb": 5, "workers": 4 }`
  owns dbs 5-8; a name may not end in `_w<N>`), or worktrees truncate each other's rows. The
  server's integration run holds its Redis dbs and refuses to start while another client is on
  one of them.
  Guards refuse any other port, a DB not named `magick_agency_test*`, or Redis db 0
  (`tooling/test-env.ts`). Parallel agents that run integration tests each work in their own git
  worktree with its own `.test-env.local.json`; agents sharing one worktree run integration one at
  a time.
- **Verify the server's integration the way CI does:** `INTEGRATION_LANE=rest` and
  `INTEGRATION_LANE=wall-clock` as separate runs. The unsplit run is not what CI checks
  (`cluster/mobile-stations.test.ts` fails in it and passes in its lane).
- **Shared files change deliberately**, with their consumers and tests in the same commit:
  `packages/contracts`, `packages/db/migrations`, `apps/server/src/seams/**`,
  `apps/server/src/{app.ts,app-context.ts,index.ts}`,
  `apps/server/src/config/{index,load,schema,env}.ts`, `apps/server/src/config/blocks/base.ts`,
  root config, CI (`.github/workflows/`) and the release-please config. For `packages/contracts`
  the consumers include the hand-written Dart wire types in `apps/mobile/packages/agency_wire`:
  run its `dart test` before committing a contract change. Never edit or renumber an applied
  migration; add a new one.
- **Mutation-check guard tests.** When a test is claimed to guard something, break the code, watch
  it go red, restore. Commit before mutating, so restoring with `git checkout` cannot lose work.
- **Releases are release-please's** (B24, `docs/operations.md` "Releases and versioning"). PR
  titles are Conventional Commits (`feat(console): …`, `fix(server)!: …`); they become the squash
  commit that picks each component's next version. Never hand-edit a `package.json` `version`, the
  mobile `pubspec.yaml` `version:`, a `CHANGELOG.md` or `.release-please-manifest.json`. A new
  workspace package gets a component in `release-please-config.json` and a manifest entry in the
  same commit (`pnpm test:release`).
- **Scoped git:** `git add <paths>` only; no `git add -A`, no `git stash`. Nothing is pushed
  without Manas; a request from Manas to push or to open a PR is that go-ahead.
- **User-facing copy is British English** (cancelled, dialled, redialled), in every app and in
  server messages. Wire codes and identifiers are never respelled (`canceled`, `redialed`).

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
pnpm test:integration    # real Postgres/Redis (needs infra:up); packages one after another, files in parallel
pnpm build
pnpm test:grafana        # alert rules + dashboard vs metric declarations
pnpm test:release        # release-please config vs workspace packages, the mobile app and versions
pnpm test:tooling        # CI scope rules vs what each package's suites read

docker build -f docker/Dockerfile -t magick-agency-server .     # production server image
docker build -f docker/web.Dockerfile -t magick-agency-web .     # nginx + both web UIs
```

The mobile app builds with Flutter, not pnpm: see `apps/mobile/CLAUDE.md`.

CI: `.github/workflows/ci.yml` (lint, unit, grafana, release guard, build; integration as three
parallel jobs: db, server, server wall-clock), `mobile.yml` (on `apps/mobile`,
`packages/contracts`, the literal extractor and the number rule the Dart port mirrors), `pr-title.yml`, `release-please.yml`.
On a mobile release, `release-please.yml` calls `mobile-release.yml`: a signed staging APK on the
GitHub Release (`docs/mobile.md` "The release APK").
On a pull request and on a push to `main`, `ci.yml` and `mobile.yml` run only what the diff reaches (`tooling/ci-scope.mjs`, `pnpm test:tooling`;
`docs/operations.md` "What CI runs"); the `full-ci` label, a manual run and the weekly scheduled run run everything. A test that reads files
outside its package needs a `READ_BY` rule or a server repository guard in `ci-scope.mjs`;
`test:tooling` fails on the reads it can see (`../` paths, `join`/`resolve` with `'..'`), not on
paths built with `dirname`.

The repo's `.mcp.json` adds the Grafana Cloud MCP server (stack `sapieonic`) for live metrics,
logs and alerts.
