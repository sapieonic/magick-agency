> **Reference copy, verbatim below this box.** Origin: MagickVoice-platform (superproject) @ `e32a5db` (HEAD, 2026-10-05), path `CLAUDE.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** The superproject's guidance for agents working across the three MagickVoice repos (ports, paired secrets, gating layers, cross-repo rules). Ported comments that say "root CLAUDE.md" or "the platform CLAUDE.md" mean this file or a source repo's own CLAUDE.md (named at each comment). None of its commands, ports or secrets apply to Magick Agency; see the repo's own `CLAUDE.md`.
>
> Index of all copies: [`docs/reference/README.md`](../README.md).

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For agent/Cursor entry points (investigation workflow, slash commands, submodule
commit rules), see [`AGENTS.md`](AGENTS.md). Always-on Cursor rules live in
[`.cursor/rules/`](.cursor/rules/); cross-service slash commands in
[`.claude/commands/`](.claude/commands/).

## Reference documents

Two root-level deep references. Both were written by reading the source tree, cite
`path:line`, and go further than this file does — read the relevant one before
doing cross-service work rather than re-deriving it.

- **[`service-map.md`](service-map.md)** — how the services actually communicate. Every transport and credential family (`apiFetch`/`saFetch`, the `/proxy/*` families, `/internal/*` S2S, HMAC webhooks, the three WebSocket paths), exact header transformation at each hop, and hop-by-hop traces of eight flows: a plain authenticated read, an outbound AI call through settlement, both media WebSockets, the agency station socket, analysis completion, the super-admin tree, and governance-vs-feature-flags. Ends with failure semantics, per-hop triage order, trace/PostHog propagation, and what breaks when you change one side.
- **[`agency.md`](agency.md)** — the agency dialer offering end to end. Product shape and out-of-scope decisions, domain model with the actual core/master tables and indexes, the agent state machine (Redis authoritative, DB row a mirror) with lease TTLs and reaping, the pacing engine's leader lease and `SKIP LOCKED` claiming, the full call lifecycle including the abandoned path, the cross-repo contracts, all four gating layers, the supervisor surface, agency settlement, test topology, and time-stamped open gaps.

Design and delivery docs for the agency workstream live in [`docs/`](docs/).

## What this repository is

This is a **superproject** — three git submodules plus parent agent/docs config,
plus root-only assets: [`docs/`](docs/) (cross-service design/delivery docs),
[`weekly-updates/`](weekly-updates/) + [`scripts/`](scripts/) (a GitHub Pages
site), and [`scratch_pad/`](scratch_pad/) for one-off ops scripts. It has **no
product application code of its own**. It exists to check out the whole
MagickVoice platform at a known-good set of commits for investigations and
cross-service work.

| Submodule | Role |
|---|---|
| `magic-voice-core` | Voice AI Orchestrator. Telephony, AI pipelines, IVR, messaging, knowledge bases, agency dialer runtime. |
| `magick-master` | Platform service. Auth, RBAC, billing, scheduling, governance. Proxies to core. |
| `magick-comms-cusui` | Customer React SPA. Talks only to master. |

Versions move weekly (semantic-release in each submodule) — read them from
`git submodule status`, never from a doc. Each submodule has its own detailed
`CLAUDE.md` (246–630 lines) carrying the per-service architecture; **read that
one when working inside it.** This file covers only what spans repos.

The superproject's own history is small and pointer-only: PRs into root `main`
bump submodule SHAs or touch parent docs/config. Feature code never lands here.

## Working across submodules

Commits go in the submodule, not here. From the root, `git status` showing a
dirty submodule means its HEAD moved, not that root files changed.

```bash
git submodule update --init --recursive     # first checkout
git submodule foreach 'git fetch origin && git checkout main && git pull --ff-only origin main'
git -C magic-voice-core checkout -b feat/x  # branch inside a submodule
```

A change spanning services needs one PR per affected submodule. Because master
fails closed on core calls and the SPA is compiled against master's routes,
**merge order is core → master → cusui** for additive changes, and the reverse
for removals.

**Tests run from inside this superproject are stricter than in a standalone
clone.** Core's and master's `test/unit/agency/s2s-contract.test.ts` resolve
their sibling four levels up (`<root>/magick-master/...`, `<root>/magic-voice-core/...`)
and `skipIf` the sibling is absent. So a cross-repo contract violation reds here
and stays green in a lone checkout — do agency contract work from the root.

## Service topology

```
browser ──► magick-comms-cusui (Vite 5174)
                │  Firebase ID token + X-Tenant-Id / X-Account-Id
                ▼
            magick-master (3010, metrics 9091)     Postgres 5433 · Redis 6380
                │  /proxy/* ──► per-tenant core API key (AES-256-GCM at rest)
                │  /internal/* ──► CORE_S2S_TOKEN
                ▼
            magic-voice-core (3000, metrics 9090)  Postgres 5432 · Redis 6379
                │  HMAC-signed webhooks ──► master /webhooks/core/*
                ▼
            carriers · OpenAI/Gemini realtime · WhatsApp · S3 · SQS
```

**The two services do not share a database.** Separate Postgres instances,
separate Redis. All coupling is HTTP, a byte-identical contract fixture (below),
a shared PostHog project, and W3C trace context. Do not write a migration in one
repo that assumes a table in the other.

The dev infra ports are deliberately offset so both stacks run at once: core uses
5432/6379, master 5433/6380, master's test stack 5434/6381, core's test stack
5433/6380 (**core's test Postgres collides with master's dev Postgres** — don't
run core integration tests and master's dev stack simultaneously).

### Known-stale port references

Several docs say core's dev server is on **3005**. It is **3000** (`PORT` in
`magic-voice-core/.env.example`). The stale claim appears in
`magic-voice-core/README.md:204`, `magic-voice-core/CLAUDE.md:605`,
`magick-comms-cusui/CLAUDE.md:60`, `magick-comms-cusui/README.md:154`.
Relatedly, `magic-voice-core/web-client/` is described as a React admin console
but is now a **single `index.html` redirecting to app.magickvoice.com** — no Vite
app, no package.json, nothing to run.

### Paired secrets

These must match across repos or calls fail closed at runtime, not at boot:

| Direction | Core side | Master side |
|---|---|---|
| master → core `/internal/*` | `INTERNAL_S2S_TOKEN` | `CORE_S2S_TOKEN` |
| core → master `/internal/*` | `MASTER_S2S_TOKEN` | must be listed in `PLATFORM_S2S_TOKENS` (comma-separated) |
| core → master webhooks | `PLATFORM_SETTLEMENT_WEBHOOK_SECRET`, `ANALYSIS_COMPLETION_WEBHOOK_SECRET` | `CORE_WEBHOOK_SECRET` (one value; both core secrets must equal it) |

Master's `ENCRYPTION_KEY` must be exactly 64 hex chars — it decrypts stored
per-tenant core API keys, so a wrong value breaks every `/proxy/*` route with an
opaque failure.

## Commands

All three repos share the same script shape. **There is no ESLint or Prettier
anywhere in the platform** — `npm run lint` is `tsc --noEmit` in both backends,
and in cusui it is `tsc --noEmit && tsc --noEmit -p tsconfig.e2e.json` (the
second pass typechecks the Playwright suite). `npm test` runs unit tests only;
integration and smoke suites are excluded and need Docker up first. Node: core
requires ≥20, master ≥22.

| | core | master | cusui |
|---|---|---|---|
| dev | `npm run dev` | `npm run dev` | `npm run dev` |
| test | `npm test` | `npm test` | `npm test` |
| integration | `npm run test:integration` | `npm run test:integration` | `npm run test:e2e` (Playwright) |
| infra up | `npm run test:integration:up` | `npm run test:integration:up` | — |
| migrate | `npm run migrate:up` | `npm run migrate:up` | — |

Single test, all three (Vitest 4):

```bash
npx vitest run test/unit/core/call-manager.test.ts
npx vitest run -t "CallManager"
npx vitest run -c vitest.config.integration.ts test/integration/<file>.test.ts
npx playwright test e2e/calls.spec.ts          # cusui only
```

Root has no package.json. It has three tests, all plain `node --test`:

```bash
node --test scripts/generate-weekly-updates-site.test.mjs   # the Pages site generator
node --test scripts/validate-grafana-dashboard.test.mjs     # the cross-service dashboard
node --test scripts/validate-grafana-alerts.test.mjs        # every platform alert rule
```

The second and third read both backends' metric declarations
(`src/utils/metrics.ts`, runtime allow-lists, core's OTLP instrument fixture, via
`scripts/metric-declarations.mjs`) and assert every metric and label in
`grafana/dashboards/` and `grafana/terraform/alert-rules-*.tf` still exists — so
they **need the submodules checked out** and skip themselves in
a bare clone, like the agency contract tests.

Both backends **`process.exit(1)` on invalid config at startup**, and their Zod
schemas are imported transitively by many tests — so a missing `.env` fails unit
tests, not just `npm run dev`. Copy `.env.example` first in each repo.

Bringing the full stack up locally means three terminals plus two Docker stacks,
in order: core's infra → core → master's infra → master → cusui. In a Cursor
Cloud VM, [`.cursor/cloud/install.sh`](.cursor/cloud/install.sh) and
`start-infra.sh` do this with host Postgres/Redis instead of Docker.

## Cross-cutting patterns

**Config blocks are feature flags.** In both backends, an entire subsystem
registers only if its env block parses — master's `/super-admin/*`, scheduler,
and SQS bulk dispatch; core's SIP, S3, SQS, and messaging providers. A missing
route in a running service usually means an unset env var, not a bug.

**Four independent gating layers**, and a feature needs all four aligned to be
reachable:
1. **RBAC** — linear role hierarchy `agent(5) → viewer(10) → operator(20) → account_admin(30) → tenant_admin(40) → tenant_owner(50)`, defined in master's `src/rbac/roles.ts` (`PERMISSION_MATRIX` maps each permission to a *minimum* role) and mirrored in cusui's `src/utils/permissions.ts`. `agent` sits **below** `viewer` deliberately: raising its level would grant every viewer-floored read on the platform.
2. **Governance capabilities** — a frozen catalog in master's code (`src/governance/catalog.ts`) with sparse DB overrides. Served master-native at `GET /governance/effective`. cusui's `RequireCapability` **fails open** because master's 403 is the real enforcement.
3. **Core feature flags** — via `GET /proxy/feature-flags`, gating things like `dialer_call_analysis`, `whatsapp_media`, `custom_sip`.
4. **Route guards** — `RequireAuth` / `RequireSuperAdmin` in cusui.

Adding a gated feature means touching all three repos: core's flag, master's
capability catalog entry, and cusui's `RequireCapability` union (hand-maintained
in `src/components/auth/RequireCapability.tsx`).

**The agency S2S contract lives in a file, committed byte-identically in two
repos**: `magic-voice-core/src/agency/agency-s2s-contract.fixture.json` and
`magick-master/src/agency/agency-s2s-contract.fixture.json`. Each repo's suite
asserts its own implementation against its copy *and* that its copy matches the
sibling's. Editing one copy alone reds a test in the repo that edited it — so
**edit both, in the same cross-repo change**. It exists because every defect it
catches was invisible to two independently-green suites (master sending `version`
as a string against core's `z.number()`, a proxied hangup with no body, an
omitted `agent_user_id`). Editing protocol and the full defect list:
[`agency.md`](agency.md) §6.1.

**Error codes are two hand-mirrored unions.** Core's `AgencyActionErrorCode`
(`src/agency/contracts.ts`) is mirrored by master's `AGENCY_ACTION_ERROR_CODES`
(`src/agency/agency-action-errors.ts`) and again by cusui's
`src/types/agency.ts`. Master's `error-mask.middleware.ts` allow-lists exactly
those strings: a code core emits that master has not mirrored is rewritten to
"contact support and quote this request id" — status intact, explanation
destroyed, nothing red anywhere. The union has 16 members, pinned in four
places; adding one is a three-repo change plus the fixture — see
[`agency.md`](agency.md) §6.2.

**Tenancy headers** flow browser → master → core, changing form at each hop.
cusui sends `X-Tenant-Id`/`X-Account-Id` with a Firebase bearer token; master
resolves those to `x-mgkvc-tenant`, `x-mgkvc-account`, plus URL-encoded
`x-mgkvc-tenant-name`/`x-mgkvc-account-name`, and swaps the Firebase token for
the tenant's core API key. Core requires `X-API-Key` + tenant + account. **A
route added to core is not reachable from the browser until master proxies it** —
core's auth middleware is registered per-route-plugin, not globally, so
forgetting it silently ships an unauthenticated endpoint.

**Two WebSocket paths** both tunnel through master's `/proxy`, with different
token conventions: browser AI call (`/proxy/media-stream/:callId`, token-less)
and the WebRTC dialer (`browser_ws_url` + `?token=` appended, preserving any
existing query string). Vite proxies both with `ws: true`. The agency dialer adds
a third, core-side station socket. All three are traced upgrade-by-upgrade in
[`service-map.md`](service-map.md) §5.3-5.5.

**Super-admin is a second, parallel auth tree** — its own JWT in
`sessionStorage`, its own `saFetch` that bypasses `apiFetch` entirely, its own
middleware in master. Changes to Firebase auth do not affect it, and vice versa.

**Migrations run in the container entrypoint, before the app boots.**
`docker/entrypoint.sh` in both backends runs `node-pg-migrate up` then
`exec node dist/...`, so a migration failure kills the container before
OpenTelemetry and pino initialise — zero logs, zero metrics, and Grafana shows an
absence rather than a cause. Never renumber or rename an existing migration
without repairing the `pgmigrations` ledger in the same step; see the
`service-down-after-deploy` skill.

## Doc accuracy

The per-submodule CLAUDE.md files are high quality and worth trusting on
architecture and rationale, but each has drifted in specifics — migration counts
(currently 90 in core, 72 in master), route lists, and recently shipped
subsystems are the usual gaps. Verify counts and file lists against the tree
rather than quoting the docs. Each submodule also has its own `AGENTS.md`
(Cursor Cloud / agent tips); the root `AGENTS.md` covers only superproject
concerns.

## Root-only assets

- [`service-map.md`](service-map.md), [`agency.md`](agency.md) — the two deep references described at the top of this file.
- [`docs/`](docs/) — cross-service design and delivery docs for the **agency dialer**, the active multi-repo workstream (`agency-dialer-design.md` is authoritative on architecture; the delivery plan, UX spec, test plan, and fix queue hang off it). Ticket IDs are Linear `MAG-*` and appear in every submodule's commit subjects.
  Also here: [`bulk-campaign-lifecycle-design.md`](docs/bulk-campaign-lifecycle-design.md) — the cross-service contract for the bulk-campaign `dispatched`-vs-`completed` lifecycle (ClickUp `86d2hme6q`), authoritative for that change across core, master and cusui.
- [`weekly-updates/`](weekly-updates/) — self-contained HTML customer reports, grouped by tenant, named `YYYY-MM-DD-*.html`. `scripts/generate-weekly-updates-site.mjs` builds an index; `.github/workflows/deploy-weekly-updates-pages.yml` deploys to GitHub Pages on merge to `main`. Reports must live here — the generator scans nowhere else.
- [`grafana/`](grafana/) — the **cross-service** Grafana dashboard (`magickvoice-platform-overview`), the one observability asset that spans both backends: live call concurrency by type, call and message volume, AI turn latency, per-service API latency and errors, credits, and tenant activity, all filtered primarily on `deployment_environment`. The per-service dashboards stay in their submodules (`magic-voice-core/grafana/`, `magick-master/grafana/`). **All alerting for both backends lives here too** — `grafana/terraform/` is the only writer of alert rules, Slack contact points and the notification policy on the stack (core's old `grafana/terraform/` module must not be applied again). Every rule aggregates `by (service_name, ...)` because routing keys on a `deployment` label templated from it. Covered by `scripts/validate-grafana-dashboard.test.mjs` and `scripts/validate-grafana-alerts.test.mjs` — a rename in either `metrics.ts` empties a panel or silences a rule without any error, so those tests are the only thing that reds. See [`grafana/README.md`](grafana/README.md).
- [`deploy/gcp/`](deploy/gcp/) — the **nightly production deploy**: Cloud Scheduler (22:20 IST) → Cloud Build manual trigger → `gcloud compute ssh` into the VM, which fast-forwards each service to `main` and redeploys only those with undeployed commits (core → master via `docker compose … up -d --build`, then the cusui build + web-root copy), stopping at the first failure. See [`deploy/gcp/README.md`](deploy/gcp/README.md).
- [`scratch_pad/`](scratch_pad/) — ad-hoc Node.js utility scripts for investigations and one-off platform ops (for example cancelling stranded `queued` calls on a completed bulk-dispatch job when the UI Stop affordance is unavailable). Not part of any service runtime; keep secrets in env or a gitignored `scratch_pad/.env`. See [`scratch_pad/README.md`](scratch_pad/README.md).

## Agent tooling (this superproject)

Slash commands under `.claude/commands/` use **submodule-relative paths**
(`magic-voice-core/`, …) — prefer these when working from the platform root.
Equivalent older copies under `magic-voice-core/.claude/commands/` still point at
sibling-checkout absolute paths outside this superproject.

- `/git-status-all` — branch/dirty summary for root + all three submodules
- `/typecheck-all` — `tsc --noEmit` in all three in parallel
- `/cross-service-feature` — plan a multi-repo change (ask before implementing)
- `/cross-service-implementer` — implement core → master → cusui
- `/webhook-flow-tracer` — hop-by-hop async/webhook trace

Skills:

- `.claude/skills/service-down-after-deploy` — sequential playbook for a backend that is down, crash-looping, or 500ing after a deploy, and required reading *before* renaming any migration.
- `.cursor/skills/dedicated-investigation` — how to investigate dedicated/staging/live via Grafana Cloud Loki + Prometheus (fixed datasource UIDs `grafanacloud-logs` / `grafanacloud-prom`).
- `magic-voice-core/.claude/skills/` — `create-clickup-ticket` and `generate-voice-prompt`, active when working under that directory.

[`.mcp.json`](.mcp.json) (gitignored, holds a Grafana token) wires ClickUp,
Slack, Linear, Playwright, and Grafana (`sapieonic.grafana.net`, via Docker —
needs Docker running, and reload MCP servers after checkout).
