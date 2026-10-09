# Architecture

How Magick Agency is built, concretely: the packages, how the server process is composed and
started, how the old master→core hop became an in-process call, and how each subsystem
(identity, the dialer runtime, the voice engine, analysis, DNC, audit, the UIs) works, with file
paths. Read it before changing anything structural, and as the map when you open the code for the
first time. Why things are the way they are is in [`decisions.md`](decisions.md) (cited by ID);
the domain rules the code ports are in
[`reference/magickvoice-platform/agency.md`](reference/magickvoice-platform/agency.md). Checked
against the tree on 2026-10-09.

## Reading source comments

Most of `apps/server` and `apps/console` is ported verbatim from MagickVoice, so comments speak
in the source's terms. Three kinds of citation appear:

- **Port provenance**: "core `src/agency/x.ts:120`@4850d1d9", "master `src/index.ts:325`",
  "cusui @ ee5beb44". These name source *code* in the MagickVoice repos (core v1.123.2 `4850d1d9`,
  master v3.24.0 `a1f0756a`, cusui v2.96.0 `ee5beb44`); `PORTING.md` maps every file.
- **Design references**: "`agency.md` §6.2", "`docs/agency-dialer-design.md` §7b", "master
  CLAUDE.md RBAC rule 1". These were documents in the MagickVoice superproject and repos; verbatim
  copies now live under [`reference/`](reference/README.md), and comments point there.
- **`PORT NOTE (magick-agency)`** marks a line changed from the source, with the reason; a
  `Q<n> (Manas, 2026-10-09)` comment marks a ruling.

Words like "master", "core", "S2S", "proxy" and "governance" in a comment describe the source
system. In agency there is one process (below).

## Monorepo layout

pnpm 10 workspace, Node 22 (`package.json`, `.nvmrc`). Workspace packages are consumed as
TypeScript source (B2); `tsc --noEmit` covers `src` and tests in each package (B1).

| Package | Responsibility |
|---|---|
| `apps/server` | The one Fastify process: identity, tenancy, super-admin auth, the HTTP API, the station WebSocket, carrier webhooks and the media WebSocket, the voice engine, concurrency guard, pacing runtime, analysis worker, sweeps and retention. Bundled by esbuild to `dist/index.js` (`scripts/build.mjs`, CommonJS, B5) |
| `apps/console` | Vite + React SPA ported from cusui: agent console, supervisor pages, team, invites, settings |
| `apps/super-admin` | Vite + React SPA: tenants, users, admins, phone numbers, feature flags, usage, audit |
| `packages/contracts` | The wire contract shared by server and both UIs: agency types, the error-code unions (`errors.ts`), feature flags (`flags.ts`), RBAC roles and permission matrix (`rbac.ts`), API shapes under `src/api/` |
| `packages/domain` | Pure agency rules with no imports beyond contracts: abandonment predicate, break manager, keyset cursor, rates, retry bounds and summary, success disposition, timers |
| `packages/db` | pg pool (`connection.ts`), shared repositories and models, the squashed baseline migration, `BASELINE.md` |
| `packages/observability` | pino logger, log context, PII masking, OTel meter and `@Traced`, metric declarations per lane under `src/metrics/` |
| `tooling/` | `test-env.ts` (per-worktree test DB), the Vitest decorator transform |
| `docker/` | Dev Postgres and Redis only (`docker-compose.dev.yml`) |

**Path rule.** A ported file keeps its source-relative path (core/master `src/<path>` →
`apps/server/src/<path>`, shared repositories → `packages/db/src/...`), so later upstream fixes
apply with `git am --directory`. Details: [`seams.md`](seams.md) §1. Core's agency repository
stays in `apps/server/src/db/` to avoid a package cycle (B12).

## Runtime picture

```
 browsers: agent / supervisor (console :5175)      super-admin (:5176)
          │ Firebase ID token, X-Tenant-Id / X-Account-Id   │ super-admin JWT
          ▼                                                 ▼
 ┌──────────────────────── apps/server (one process, :3021) ───────────────────────┐
 │ app-wide: rate limiter · error handler + 5xx mask · @fastify/websocket · probes │
 │                                                                                │
 │ platformPlugin   /auth /tenants /accounts /users /invites /notifications       │
 │                  /feature-flags /super-admin/*                                 │
 │ agencyPlugin     /proxy/agency/* /dnc /phone-numbers /proxy/call-analysis-...  │
 │      │  callCore() ──inject──► private core Fastify (never listens)            │
 │      │                          /api/v1/agency, /agency-campaigns, /agency-agents│
 │      └ station WS /proxy/agency/station/:sessionId                             │
 │ voicePlugin      /api/v1/webrtc-call/:id/pstn-stream (WS) · /api/v1/webhooks/… │
 │ analysisPlugin   /api/v1/webrtc-recordings/:id (HMAC-signed)                   │
 │                                                                                │
 │ background: audit buffers + partitions │ guard host + WebRTC bridge + sweeps   │
 │             AgencyRuntime (pacing, dialer, stations, reaper, wrap-up)          │
 │             analysis worker + retention purge                                  │
 └──────┬──────────────┬───────────────┬──────────────────────────────┬───────────┘
        ▼              ▼               ▼                              ▼
   Postgres         Redis        VoiceLink (dial API,          Firebase Auth, Mailjet,
   (5436 dev)    (6383 dev)      media WS, webhooks,           S3, Gemini / OpenAI /
                                 recording host)               Sarvam, PostHog
```

## Server composition

**Config blocks are feature flags.** `apps/server/src/config/` parses the environment once
(`config/index.ts`, which exits the process on any issue). Each lane owns one block in
`config/blocks/` (`base`, `platform`, `agency`, `voice`, `analysis`), and the blocks must declare
disjoint top-level keys (`config/schema.ts` checks at module load). Several blocks exist only when
their key env var is set, and the subsystem behind them is then registered or skipped:

| Block present when | Effect when absent |
|---|---|
| `SUPER_ADMIN_JWT_SECRET` | `/super-admin/*` routes are not registered (`api/platform.plugin.ts`) |
| `FIREBASE_PROJECT_ID` | Every Firebase verify fails closed (401); in production the platform plugin refuses to boot |
| `MAILJET_API_KEY` | No mail is sent |
| `S3_AUDIO_BUCKET` | No S3 client (clips, CSV uploads) |
| `DIALER_ANALYSIS_ENABLED` (and a transcriber + LLM key) | No analysis worker; the bridge's analysis hooks stay no-ops (`bootstrap/analysis.ts`) |
| `TELEPHONY_ENABLED_PROVIDERS=voicelink` or `NODE_ENV=production` | VoiceLink fields become required at boot |

**`AppContext`** (`app-context.ts`) is what every plugin and bootstrap receives: `config`, the pg
`pool`, the ioredis client. `buildApp({ ctx: null })` builds a routing-only app for tests.

**`buildApp`** (`app.ts`) registers, in order: the rate limiter (app scope, so every route is in a
bucket), master's error handler with the `22P02 → 400` backstop and the 5xx error mask (no driver
text or SQL reaches a client), `/healthz` and `/readyz` (Postgres `SELECT 1` and Redis `PING`), the
feature-flag service, one `@fastify/websocket`, then the four lane plugins: platform, agency,
voice, analysis. `trustProxy` is a hop-count function from `TRUST_PROXY_HOPS` (Q9). Request ids
come from `x-request-id`, else the OTel trace id, else a UUID, so a masked 5xx body's request id is
unique.

**Start and stop** (`index.ts`):

1. Create the pg pool (TLS only in production, verified, Q1) and the Redis client.
2. `initAnalytics()` (PostHog, no-op unless enabled).
3. `buildApp`.
4. Install SIGTERM/SIGINT handlers, before any background work, so a signal during a slow start
   runs the stops collected so far.
5. Bootstraps in order, each returning a stop function: `startPlatform` (audit buffers, audit
   partition maintenance, cache-invalidation subscriber), `startVoice` (S3, clip cache and sweeper,
   decode scratch reap, guard host + bridge, startup self-heal), `startAgency` (ingest reaper,
   then `AgencyRuntime.start()`, which runs the startup reaper before the pacing supervisor),
   `startAnalysis` (worker, retention purge). Voice starts before agency because the bridge's
   self-heal must finish before any pacing tick (core's order).
6. `app.listen`, only after the bootstraps, so no request lands before the startup reap.

Shutdown closes HTTP first (`app.close()`), then runs the stops in reverse: analysis, agency
(pacing stops first, then reaper, sweeps, dialer and wrap-up timers; completion notices drained up
to 30 s), voice (bridge ends live calls, guard host, PostHog flush), platform (both audit buffers
flushed last). Then Redis and the pool close. Pinned by
`apps/server/test/integration/agency/runtime-boot-order.test.ts`.

**Seams.** Two cross-lane interfaces in `apps/server/src/seams/`, wired at boot:
`bridge-analysis-hooks.ts` (the bridge tells analysis a call finalised or a recording is ready;
no-op by default) and `concurrency-control.ts` (super-admin concurrency writes reach the guards;
throws until wired). The bridge's public members the runtime calls are pinned by a type-level test.
See [`seams.md`](seams.md) §3.

## The hop collapse (B16)

In MagickVoice the browser called master, and every agency route in master ended in
`proxyToCore(...)`: an HTTP call to core's `/api/v1/*` with the tenant's core API key. Here:

- Master's route handlers are ported with their validation, RBAC and enrichment unchanged, at the
  console's existing paths (`/proxy/agency/...`, `/dnc`, `/phone-numbers`,
  `/proxy/call-analysis-profiles`, `/super-admin/...`). The `/proxy` prefix is now cosmetic and can
  be renamed after cutover in one change to server and console.
- Core's route files are registered on a **private Fastify instance** that never listens and is
  not in the app's route table (`api/core-handlers.ts`).
- `callCore()` (`api/core-dispatch.ts`) replaces `proxyToCore`: it runs core's handler through
  `inject`, keeping the query encoding, body rules, JSON on both sides and core's
  `x-mgkvc-tenant` / `x-mgkvc-account` header contract. Tenancy comes only from lane A's tenant
  context, never from forwarded headers. No socket, no API key, no S2S token.

So a request goes: app-wide limiter → session (Firebase) → tenant context → RBAC → master's handler
→ `callCore` → core's handler → repository.

## Identity and tenancy

- **Firebase.** `auth/firebase.ts` initialises `firebase-admin` with agency's service account
  (`FIREBASE_SERVICE_ACCOUNT_KEY` or `_PATH`) in the shared project. `auth/session.middleware.ts`
  verifies the ID token.
- **Session.** `POST /auth/session` (`api/routes/auth.routes.ts`) implements paths 1–3; path 4
  answers 403 `no_membership`. The payload carries the per-account settings map that replaced
  governance (`auth/session-payload.ts`).
- **Tenancy.** `api/middleware/tenant-context.middleware.ts` reads `X-Tenant-Id` / `X-Account-Id`
  and checks memberships (cached in Redis, `cache/redis-cache.ts`; revocations retried, Q5).
- **RBAC.** One module for server and both UIs: `packages/contracts/src/rbac.ts`. Linear hierarchy
  `agent 5 < viewer 10 < operator 20 < account_admin 30 < tenant_admin 40 < tenant_owner 50`, and a
  permission matrix of minimum roles. `agent` sits below `viewer` on purpose: it reaches only the
  agent surfaces, `/auth/session`, `/accounts/mine`, notification preferences and the flag map.
  Enforced by `rbac/rbac.middleware.ts`.
- **Settings.** `settings/agency-account-settings.ts` resolves the per-account row to effective
  values (`allow_recording` and `analyze_calls` default `false`, `max_concurrent_calls` 5,
  `webrtc_max_duration_seconds` 1800).
- **Invites.** `api/routes/invites.routes.ts`, `invites/`, `notifications/invite-mailer.ts`; token
  hashes in `membership_invites`, TTL `INVITE_TOKEN_TTL_DAYS` (default 7).
- **Super-admin** is a separate auth tree: `super_admins` table, JWT signed with
  `SUPER_ADMIN_JWT_SECRET` (`auth/super-admin.middleware.ts`), its own routes under
  `/super-admin`, its own SPA that keeps the token in `sessionStorage`. Firebase changes do not
  touch it. Its writes are audited in `super_admin_audit_log` (failures logged at error, OQ-8).

## The agency runtime

`apps/server/src/agency/runtime.ts` (`AgencyRuntime`) assembles the dialer and owns its lifecycle;
`bootstrap/agency.ts` creates it on first use and starts it.

- **Agent state machine** (`agency/agent-state-machine.ts`). States `offline`, `available`,
  `reserved`, `on_call`, `wrapup`, `break` (`packages/contracts/src/agency.ts`). **Redis is the
  authority**; the `agency_agent_sessions.state` row is a best-effort mirror. Each state is a Redis
  key with a lease written by Lua CAS scripts: `reserved_predial` 10 s, `reserved_dialing` 15 s,
  `on_call` 15 s, `wrapup` 15 s, `available` / `break` 45 s; owning-replica renewal every 5 s. Leases
  are liveness detectors, never business timers. A lapsed lease on reconnect lands the agent in
  `break` (`rehydrateAgent`).
- **Stations.** `station-registry.ts`, `station-socket.ts`, `station-token.ts`. The browser opens a
  WebSocket at `/proxy/agency/station/:sessionId` with a single-use token (2 min TTL, consumed in
  Lua) minted over authenticated HTTP. Heartbeat grace 30 s, sweep every 10 s
  (`packages/domain/src/timers.ts`). Only the session's own agent can mint its token (Q8).
- **Pacing** (`pacing-engine.ts`). One leader per campaign via a Redis lease (15 s, renewed every
  5 s; supervise pass every 2 s); the leader ticks each campaign it leads every 250 ms. The lease
  is only for efficiency. Correctness is the `FOR UPDATE SKIP LOCKED` claim in
  `AgencyContactRepository.claimDialable` (`apps/server/src/db/repositories/agency.repository.ts`)
  plus the `uq_agency_attempt_live` unique index, so two leaders cannot dial one contact.
  `pre-dial-gates.ts` checks phone validity, then calling hours, then DNC (fail closed) before a dial.
- **Dialer** (`agency-dialer.ts`, `dial-dispatcher.ts`). Reserves the agent before the dial,
  re-asserts the lease right before `createBridgedCall`, registers the lifecycle listener before
  dialing, writes the agent's panel and binds audio with no `await` between, stamps `answered_at`
  and `bridged_at` independently.
- **Abandonment.** A call the customer answered and no agent reached. `abandon-clip.ts` plays the
  campaign's uploaded clip then hangs up (`playClipToCarrierThenHangUp`); the predicate is a leaf
  module (`packages/domain/src/abandonment-predicate.ts`) shared by SQL and code;
  `abandonment-guardrail.ts` auto-pauses a campaign over its ceiling (default 3%) on the 60 s
  rolling-window refresh.
- **Wrap-up** (`wrapup-manager.ts`). An in-process countdown plus the attempt row
  (`wrapup_seconds`, `ended_at`), never a Redis TTL; not resumed after restart (agents return in
  `break` and a sweep closes the attempt).
- **Reaper** (`reaper.ts`). On startup, and every 60 s, closes attempts nobody owns (liveness by
  ownership, with a 5-minute age floor for the insert-to-dispatch window).
- **Completion notice** (`campaign-completion-notice.ts`). The in-process form of master's
  campaign-completed webhook: mails holders of `agency.supervise`.

## The voice engine

- **Bridge** (`core/webrtc-bridge-manager.ts`, `core/webrtc-bridge-session.ts`). Bridges the
  agent's browser leg (the station) to the carrier's PSTN leg. Its constructor takes the
  `TelephonyGuardHost` instead of core's `CallManager`.
- **Concurrency guard** (`core/telephony-guard-host.ts`, `core/concurrency-guard.ts`,
  `account-concurrency-guard.ts`, `provider-concurrency-guard.ts`). Global, account and provider
  scopes in Redis; startup and demand-driven self-heal reconcile; stale-call sweep. Limits come from
  super-admin settings through the concurrency seam.
- **VoiceLink** (`telephony/voicelink/`). The adapter places dials; the carrier's media arrives on
  the WebSocket `/api/v1/webrtc-call/:id/pstn-stream` and status on
  `POST /api/v1/webhooks/voicelink/webrtc-status/:callId` (`api/voice.plugin.ts`). Both are
  unauthenticated carrier surfaces protected by purpose-bound tokens in Redis. A missing token is
  refused when Redis answered, accepted when Redis is down; the webhook token lives 2 h past call
  end for late recording posts (Q6). `voicelink-carrier.fixture.json` pins the carrier's payload
  shapes.
- **Audio** (`audio/decode.ts`, `core/paced-audio-streamer.ts`, `tts/tts-file-cache.ts`). Uploaded
  abandon clips are decoded to PCM and cached on disk; there is no TTS (plan §7 default 4).
- **Calls** are rows in `agency_calls` (`packages/db/src/repositories/agency-call.repository.ts`),
  core's `webrtc_calls` re-keyed with settlement removed.

## Call analysis and transcripts

- **Worker** (`core/dialer-analysis-worker.ts`): promote → expire → claim → recover, every 60 s,
  concurrency 2 by default; jobs in `dialer_analysis_jobs`, claimed with `FOR UPDATE SKIP LOCKED`.
- **Runner** (`core/dialer-analysis-runner.ts`): load the call, take config from the job's profile
  snapshot, resume an existing transcript or fetch and transcribe the recording, persist, run the
  LLM analysis, complete in one transaction.
- **Transcribers** (`transcription/`): Gemini (default `gemini-3.5-flash`, 600 s windows) or Sarvam.
  `recording-fetcher.ts` fetches only from `VOICELINK_RECORDING_HOSTS` (default
  `recording.app.voicelink.co.in`), checked per redirect hop.
- **LLM analysis** (`analysis/`): OpenAI, Azure OpenAI or Gemini; profiles in
  `call_analysis_profiles` served at `/proxy/call-analysis-profiles`.
- **Playback**: `/api/v1/webrtc-recordings/:id` with an HMAC-signed query
  (`utils/recording-url.ts`, `RECORDING_URL_SIGNING_SECRET`).
- **Retention** (`maintenance/retention-purge.ts`, scheduled in `bootstrap/analysis.ts`): transcripts
  nulled after `AGENCY_TRANSCRIPT_RETENTION_DAYS` (default 30); call rows deleted only if
  `AGENCY_RETENTION_DAYS` is set. Runs 60 s after boot, then daily.

## DNC (B8)

One table, `dnc_entries`. Ingest drops suppressed numbers before they enter a roster. At dial time
`agency/dnc-registry.ts` does one indexed read (`idx_dnc_entries_tenant_phone`), widened by scope
(tenant, account, campaign), and **fails closed**: a database error halts the dial and aborts the
claimed batch. An agent's mark (`agency/dnc-mark.ts`) is campaign-scoped by default and written in
the same transaction as the attempt bookkeeping. Operators manage the list at `/dnc`
(`dnc/dnc.service.ts`, E.164 required). Core's Redis set, sync, outbox forwarder and resync are not
ported; `agency_dnc_outbox` exists only for the future rollback-window mirror.

## Audit (B7) and notifications

- **Audit.** Two monthly-partitioned tables, both kept from the sources: `audit_logs` (core's
  `audit/audit-logger.ts`, the "Dialer" half of the campaign activity trail) and `platform_audit_log`
  (master's `audit/platform/`, the "Console" half). Both writers buffer and flush every 500 ms, at
  100 rows or on an error row; started and flushed by `bootstrap/platform.ts`. Partition maintenance
  (`audit/audit-partition-maintenance.ts`) creates months ahead and drops partitions older than
  `AUDIT_RETENTION_DAYS` (default 85), once at boot and daily. Super-admin actions go to
  `super_admin_audit_log`.
- **Notifications** (`notifications/`): Mailjet client, an engine (audience, catalog, delivery),
  the agent invite template and campaign completion; `user_notification_preferences` and
  `notification_deliveries` (dedupe).

## Rate limiting and client IP

`api/middleware/rate-limit.middleware.ts`, registered once at app scope: buckets for ordinary
traffic (default 200/min), webhooks (1000), carrier media (600) and internal (1000); `/healthz` and
`/readyz` exempt; per-route limits (super-admin login 5/min, public invite routes) honoured. The
`tenant` bucket keyed on `x-api-key` was deleted (no API keys; the Phase 8 blocking finding).
Buckets key on `request.ip`, which trusts exactly `TRUST_PROXY_HOPS` proxies (Q9).

## Data layer

- One Postgres. The whole schema is one squashed migration,
  `packages/db/migrations/0001_baseline.sql` (node-pg-migrate, single transaction): 33 tables plus
  default partitions for the two audit tables. The inventory and every source migration it folds in
  are in `packages/db/BASELINE.md`. Tenant, account and user ids are UUID.
- Repositories use raw `pg` (`packages/db/src/repositories/`, plus core's agency repository in
  `apps/server/src/db/repositories/`). Repository tests run on real Postgres.
- Redis holds agent leases, leader leases, station and call tokens, the membership cache and the
  guard counters. It must not evict (see [`operations.md`](operations.md)).

## UIs

- **Console** (`apps/console`). Ported from cusui with only the API base changed (B16). Firebase web
  sign-in (`VITE_FIREBASE_*`), `AgencyLoginPage` and `AgencyJoinPage` (no self sign-up), agent console,
  campaigns, roster, activity, DNC, analysis profiles, team and notification settings. Permissions
  come from `packages/contracts/src/rbac.ts`. Brand pack `brands/magick-agency/` (B17); a guard test
  (`src/__tests__/branding/noParentBrand.test.ts`) fails on any MagickVoice mention. In dev, Vite
  proxies every API prefix to `:3021` (`vite.config.ts`); `devProxyPrefixes.test.ts` fails for any
  API segment the proxy misses.
- **Super-admin** (`apps/super-admin`). Pages for tenants, users, admins, phone numbers, feature
  flags, usage and audit; `saFetch` with the JWT in `sessionStorage`; dev proxy for `/super-admin`.
  Same branding guard.
- **Server branding guard**: `apps/server/test/unit/branding/no-parent-brand.test.ts` scans
  `apps/server/src` and `packages/*/src` (comments stripped). Docs are not scanned.

## Observability

- **Logs**: pino (`packages/observability/src/logger.ts`), service name `magick-agency`, PII masking,
  headers carrying secrets redacted. JSON to stdout in production; also OTLP via
  `pino-opentelemetry-transport` when `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` are set.
- **Metrics and traces**: declared per lane in `packages/observability/src/metrics/` with core's
  and master's names, units and labels verbatim; spans via `@Traced`. **No OTel SDK is started in
  the server** (no meter provider, exporter or `/metrics`), so these are no-ops at runtime today
  (see [`status.md`](status.md), "Not built").
- **Product analytics**: PostHog (`analytics/posthog.ts`), off unless `POSTHOG_ENABLED`.

## Testing topology

- **Real infrastructure.** Postgres on 5436 and Redis on 6383 only. Guards in
  `packages/db/test/helpers/test-db.ts` and `apps/server/test/helpers/test-redis.ts` refuse any
  other port, a database not named `magick_agency_test*`, or Redis db 0.
- **Per-worktree databases.** `tooling/test-env.ts` reads an untracked `.test-env.local.json`
  (`{ "dbName": "magick_agency_test_<x>", "redisDb": 2 }`); integration global setup drops and
  re-migrates that database on every run, so never run two integration runs on one database.
- **Unit vs integration.** `pnpm test` is unit (mocks allowed); `pnpm test:integration` runs server
  and `packages/db` file-serially against the real stack. Run from inside the package directory.
- **Chaos suites** (`apps/server/test/integration/agency/chaos/`): abandonment counter vs table,
  predicate agreement, attempt-number collision, DNC self-heal loop, lease renewer killed, network
  drop during ring, Redis expired wholesale, restart mid-bridge, roster exactly-once.
- **End to end**: `runtime-e2e.test.ts` (real app, station socket, real bridge, fake carrier, through
  disposition, analysis and completion); `runtime-boot-order.test.ts`.
- **Contract and guard tests**: route tables enumerated from `onRoute`
  (`apps/server/test/unit/api/*route-table*.test.ts`, agent-reach tests); config blocks disjoint;
  the bridge seam contract; the VoiceLink carrier fixture; branding guards in all three apps; the
  console dev-proxy test; error-code unions pinned in `packages/contracts/test/`.
- **Console** tests run in two Vitest projects (`*.timezone.test.ts(x)` and the rest) with TZ and
  locale pinned in `vite.config.ts`.

## CI

`.github/workflows/ci.yml`, on pull requests and pushes to `main`: job 1 installs `mpg123` and
`sndfile-programs`, then `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm build`;
job 2 runs `pnpm test:integration` against Postgres 16 and Redis 7 service containers mapped to 5436
and 6383.
