# Magick Agency

Human-agent outbound power dialing, as one self-sufficient application.
Extracted from the MagickVoice platform (core, master, cusui); the spec is
`MagickVoice-platform/docs/agency-extraction-plan.md` (v4.2).

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

## Run it

```bash
pnpm install
pnpm infra:up                # Postgres 5436, Redis 6383 (agency's own ports)
cp apps/server/.env.example apps/server/.env
pnpm migrate:up              # DATABASE_URL from your shell
pnpm --filter @magick-agency/server dev      # :3021
pnpm --filter @magick-agency/console dev     # :5175
pnpm --filter @magick-agency/super-admin dev # :5176
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
