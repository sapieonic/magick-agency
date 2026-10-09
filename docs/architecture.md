# Architecture

How Magick Agency is built, concretely: the packages, how the server process is composed and
started, how the public API layer reaches the internal handlers, and how each subsystem (identity,
the dialer runtime, the voice engine, analysis, DNC, audit, the UIs) works, with file paths. Read
it before changing anything structural, and as the map when you first open the code. Why things
are the way they are is in [`decisions.md`](decisions.md) (cited by ID); what each module contains
and which tests cover it is in [`modules.md`](modules.md). Checked against the tree on 2026-10-09.

Comments in the code cite decisions by ID ("decision B8") and mark Manas's rulings with
`Q<n> (Manas, 2026-10-09)`.

## Monorepo layout

pnpm 10 workspace, Node 22 (`package.json`, `.nvmrc`). Workspace packages are consumed as
TypeScript source (B2); `tsc --noEmit` covers `src` and tests in each package (B1).

| Package | Responsibility |
|---|---|
| `apps/server` | The one Fastify process: identity, tenancy, super-admin auth, the HTTP API, the station WebSocket, carrier webhooks and the media WebSocket, the voice engine, concurrency guard, dialer runtime, analysis worker, sweeps and retention. Bundled by esbuild to `dist/index.js` (`scripts/build.mjs`, CommonJS, B5) |
| `apps/console` | Vite + React SPA: agent station, supervisor pages, team, invites, settings |
| `apps/super-admin` | Vite + React SPA (the super-admin console): tenants, users, admins, phone numbers, feature flags, usage, audit |
| `packages/contracts` | Wire contract shared by the server and both UIs: dialer types (`agency.ts`), console wire types (`api/`), error-code unions (`errors.ts`), feature flags (`flags.ts`), roles and permissions (`rbac.ts`) |
| `packages/domain` | Pure dialer rules with no imports beyond contracts: abandonment predicate, break manager, keyset cursor, rates, retry bounds and summary, success disposition, timers |
| `packages/db` | pg pool (`connection.ts`), shared repositories and models, the baseline migration, `BASELINE.md` |
| `packages/observability` | pino logger, log context, PII masking, OTel meter and `@Traced`, metric declarations per module area under `src/metrics/` |
| `tooling/` | `test-env.ts` (per-worktree test database), the Vitest decorator transform |
| `docker/` | Dev Postgres and Redis (`docker-compose.dev.yml`); production: the server image (`Dockerfile`, `entrypoint.sh`), nginx with both UIs (`web.Dockerfile`, `nginx.conf`) and `docker-compose.prod.yml` (see [`operations.md`](operations.md)) |

Inside `apps/server/src`, the module areas are: `api/` (plugins, routes, middleware), `auth/`,
`rbac/`, `settings/`, `invites/`, `notifications/`, `audit/`, `cache/`, `feature-flags/` (the
platform layer); `agency/` and `db/` (the dialer runtime and campaign management); `core/`,
`telephony/`, `audio/`, `tts/`, `storage/` (the voice engine); `analysis/`, `transcription/`,
`maintenance/` (call analysis and retention); `config/`, `bootstrap/`, `seams/` (composition).
The agency repository lives in `apps/server/src/db/` rather than `packages/db` to avoid a package
cycle (B12). Boundaries are described in [`seams.md`](seams.md).

## Runtime picture

```
 browsers: agent / supervisor (console :5175)      super-admin console (:5176)
          │ Firebase ID token, X-Tenant-Id / X-Account-Id   │ super-admin JWT
          ▼                                                 ▼
 ┌──────────────────────── apps/server (one process, :3021) ───────────────────────┐
 │ app-wide: rate limiter · error handler + 5xx mask · @fastify/websocket · probes │
 │                                                                                │
 │ platformPlugin   /auth /tenants /accounts /users /invites /notifications       │
 │                  /feature-flags /super-admin/*                                 │
 │ agencyPlugin     /proxy/agency/* /dnc /phone-numbers /proxy/call-analysis-...  │
 │      │  callCore() ──inject──► internal handler instance (never listens)       │
 │      │                          /api/v1/agency, /agency-campaigns, /agency-agents│
 │      └ station WS /proxy/agency/station/:sessionId                             │
 │ voicePlugin      /api/v1/webrtc-call/:id/pstn-stream (WS) · /api/v1/webhooks/… │
 │ analysisPlugin   /api/v1/webrtc-recordings/:id (HMAC-signed)                   │
 │                                                                                │
 │ background: audit buffers + partitions │ guard host + WebRTC bridge + sweeps   │
 │             dialer runtime (pacing, dialer, stations, reaper, wrap-up)         │
 │             analysis worker + retention purge                                  │
 └──────┬──────────────┬───────────────┬──────────────────────────────┬───────────┘
        ▼              ▼               ▼                              ▼
   Postgres         Redis        VoiceLink (dial API,          Firebase Auth, Mailjet,
   (5436 dev)    (6383 dev)      media WS, webhooks,           S3, Gemini / OpenAI /
                                 recording host)               Sarvam, PostHog
```

## Server composition

**Config blocks are feature flags.** `apps/server/src/config/` parses the environment once
(`config/index.ts` exits the process on any issue). Each module area owns one block in
`config/blocks/` (`base`, `platform`, `agency`, `voice`, `analysis`), and the blocks must declare
disjoint top-level keys (`config/schema.ts` checks at module load). Several blocks exist only when
their key env var is set, and the subsystem behind them is then registered or skipped:

| Block present when | Effect when absent |
|---|---|
| `SUPER_ADMIN_JWT_SECRET` | `/super-admin/*` routes are not registered (`api/platform.plugin.ts`) |
| `FIREBASE_PROJECT_ID` | Every Firebase verify fails closed (401); in production the platform plugin refuses to boot |
| `MAILJET_API_KEY` | No mail is sent |
| `S3_AUDIO_BUCKET` | No S3 client (clips, CSV uploads) |
| `DIALER_ANALYSIS_ENABLED` (plus a transcriber and an LLM key) | No analysis worker; the bridge's analysis hooks stay no-ops (`bootstrap/analysis.ts`) |
| `TELEPHONY_ENABLED_PROVIDERS=voicelink` or `NODE_ENV=production` | VoiceLink fields become required at boot |

**`AppContext`** (`app-context.ts`) is what every plugin and bootstrap receives: `config`, the pg
`pool`, the ioredis client. `buildApp({ ctx: null })` builds a routing-only app for tests.

**`buildApp`** (`app.ts`) registers, in order: the rate limiter (app scope, so every route is in a
bucket); the error handler with the `22P02 → 400` backstop and the 5xx error mask (no driver text
or SQL reaches a client); `/healthz` and `/readyz` (Postgres `SELECT 1` and Redis `PING`); the
feature-flag service; one `@fastify/websocket`; then the four plugins: platform, agency, voice,
analysis. `trustProxy` is a hop-count function from `TRUST_PROXY_HOPS` (Q9). Request ids come from
`x-request-id`, else the OTel trace id, else a UUID, so the request id in a masked 5xx body is
unique.

**Start and stop** (`index.ts`):

1. Create the pg pool (TLS only in production, verified, Q1) and the Redis client.
2. `initAnalytics()` (PostHog, a no-op unless enabled).
3. `buildApp`.
4. Install SIGTERM / SIGINT handlers before any background work, so a signal during a slow start
   runs the stops collected so far.
5. Bootstraps in order, each returning a stop function: `startPlatform` (audit buffers, audit
   partition maintenance, cache-invalidation subscriber); `startVoice` (S3, clip cache and sweeper,
   decode scratch reap, guard host and bridge, startup self-heal); `startAgency` (ingest reaper, then
   `AgencyRuntime.start()`, which runs the startup reaper before the pacing supervisor);
   `startAnalysis` (worker, retention purge). Voice starts before agency so the bridge's self-heal
   finishes before any pacing tick.
6. `app.listen`, only after the bootstraps, so no request lands before the startup reap.

Shutdown closes HTTP first (`app.close()`), then runs the stops in reverse: analysis; agency
(pacing stops first, then reaper, sweeps, dialer and wrap-up timers; completion notices drained up
to 30 s); voice (the bridge ends live calls, then the guard host, then the PostHog flush); platform
(both audit buffers flushed last). Then Redis and the pool close. Pinned by
`apps/server/test/integration/agency/runtime-boot-order.test.ts`.

**Seams.** Two cross-module interfaces in `apps/server/src/seams/`, wired at boot:
`bridge-analysis-hooks.ts` (the bridge tells analysis that a call finalised or a recording is ready;
a no-op by default) and `concurrency-control.ts` (super-admin concurrency writes reach the guards;
throws until wired). The bridge members the dialer runtime calls are pinned by a type-level test.
See [`seams.md`](seams.md).

## Public API layer and internal handler instance (B16)

- **Public API layer.** The route handlers in `apps/server/src/api/routes/` (`proxy-agency-*`,
  `dnc`, `phone-number`, `call-analysis-profiles`, the platform and super-admin routes) serve the
  paths the console calls: `/proxy/agency/...`, `/dnc`, `/phone-numbers`,
  `/proxy/call-analysis-profiles`, `/super-admin/...`. They own authentication, tenancy, RBAC,
  validation and enrichment (names, omission counts). The `/proxy` prefix is cosmetic.
- **Internal handler instance.** The dialer's handlers (`agency.routes.ts`,
  `agency-campaigns.routes.ts`, `agency-agents.routes.ts`) are registered on a private Fastify
  instance that never listens and is not in the app's route table (`api/core-handlers.ts`), under
  `/api/v1/agency`, `/api/v1/agency-campaigns` and `/api/v1/agency-agents`.
- **`callCore()`** (`api/core-dispatch.ts`) runs an internal handler through `inject`: it encodes
  the query, sends a JSON body only for POST / PUT / PATCH, decodes JSON (or returns a raw Buffer),
  refuses path traversal, and sets the internal tenancy headers `x-mgkvc-tenant` /
  `x-mgkvc-account` from the public layer's tenant context only, never from forwarded headers.

A request goes: app-wide limiter → session (Firebase) → tenant context → RBAC → public handler →
`callCore` → internal handler → repository.

## Identity and tenancy

- **Firebase.** `auth/firebase.ts` initialises `firebase-admin` with agency's service account
  (`FIREBASE_SERVICE_ACCOUNT_KEY` or `_PATH`). `auth/session.middleware.ts` verifies the ID token.
- **Session.** `POST /auth/session` (`api/routes/auth.routes.ts`) signs a user in by one of three
  paths: an existing Firebase uid; a verified email matching a `pending_` stub (created by a
  super-admin or an invite); or a re-registered uid adopted by a proven email. A user who matches
  none and holds no membership gets 403 `no_membership`: there is no self sign-up. No lookup by email
  address ever binds an unverified address (`users.email_unverified`, `findByProvenEmail`). The
  payload carries the per-account settings map (`auth/session-payload.ts`).
- **Tenancy.** `api/middleware/tenant-context.middleware.ts` reads `X-Tenant-Id` /
  `X-Account-Id` and checks memberships, cached in Redis (`cache/redis-cache.ts`; revocations are
  retried, Q5).
- **RBAC.** One module for the server and both UIs: `packages/contracts/src/rbac.ts`. A linear
  hierarchy `agent 5 < viewer 10 < operator 20 < account_admin 30 < tenant_admin 40 <
  tenant_owner 50`, and a permission matrix of minimum roles. `agent` sits below `viewer` on
  purpose: it reaches only the agent surfaces, `/auth/session`, `/accounts/mine`, notification
  preferences and the flag map. Enforced by `rbac/rbac.middleware.ts`.
- **Settings.** `settings/agency-account-settings.ts` resolves the per-account row to effective
  values (`allow_recording` and `analyze_calls` default `false`, `max_concurrent_calls` 5,
  `webrtc_max_duration_seconds` 1800).
- **Invites.** `api/routes/invites.routes.ts`, `invites/`, `notifications/invite-mailer.ts`; token
  hashes in `membership_invites`, TTL `INVITE_TOKEN_TTL_DAYS` (default 7). Revoking a membership
  closes the agent's campaign staffing.
- **Super-admin** is a separate auth tree: the `super_admins` table, a JWT signed with
  `SUPER_ADMIN_JWT_SECRET` (`auth/super-admin.middleware.ts`), routes under `/super-admin`, and its
  own SPA, which keeps the token in `sessionStorage`. Changes to Firebase sign-in do not touch it.
  Its writes are audited in `super_admin_audit_log` (failures logged at error).

## The dialer runtime

`apps/server/src/agency/runtime.ts` (`AgencyRuntime`) assembles the dialer and owns its lifecycle;
`bootstrap/agency.ts` creates it on first use and starts it.

- **Agent state machine** (`agency/agent-state-machine.ts`). States `offline`, `available`,
  `reserved`, `on_call`, `wrapup`, `break` (`packages/contracts/src/agency.ts`). **Redis is the
  authority**; the `agency_agent_sessions.state` row is a best-effort mirror. Each state is a Redis
  key with a lease written by Lua compare-and-set scripts: `reserved_predial` 10 s,
  `reserved_dialing` 15 s, `on_call` 15 s, `wrapup` 15 s, `available` / `break` 45 s; the owning
  replica renews every 5 s. Leases detect liveness; they are never business timers. A lapsed lease
  on reconnect puts the agent in `break` (`rehydrateAgent`).
- **Stations** (`station-registry.ts`, `station-socket.ts`, `station-token.ts`). The browser opens a
  WebSocket at `/proxy/agency/station/:sessionId` with a single-use token (2 min TTL, consumed in
  Lua) minted over authenticated HTTP. Heartbeat grace 30 s, sweep every 10 s
  (`packages/domain/src/timers.ts`). Only the session's own agent can mint its token (Q8).
- **Pacing** (`pacing-engine.ts`). One leader per campaign via a Redis lease (15 s, renewed every
  5 s; a supervise pass every 2 s takes leadership); the leader ticks each campaign it leads every
  250 ms. The lease is only for efficiency. Correctness is the `FOR UPDATE SKIP LOCKED` claim in
  `AgencyContactRepository.claimDialable` (`apps/server/src/db/repositories/agency.repository.ts`)
  plus the `uq_agency_attempt_live` unique index, so two leaders cannot dial one contact.
  `pre-dial-gates.ts` checks phone validity, then calling hours, then DNC (fail closed).
- **Dialer** (`agency-dialer.ts`, `dial-dispatcher.ts`). Reserves the agent before the dial,
  re-asserts the lease right before `createBridgedCall`, registers the lifecycle listener before
  dialing, writes the agent's panel and binds the audio with no `await` between, and stamps
  `answered_at` and `bridged_at` independently.
- **Abandonment.** A call the customer answered and no agent reached. `abandon-clip.ts` plays the
  campaign's uploaded clip and hangs up (`playClipToCarrierThenHangUp`); the predicate is a leaf
  module shared by SQL and code (`packages/domain/src/abandonment-predicate.ts`);
  `abandonment-guardrail.ts` auto-pauses a campaign over its ceiling (default 3%) on the 60 s
  refresh of the rolling 24 h rate.
- **Wrap-up** (`wrapup-manager.ts`). An in-process countdown plus the attempt row
  (`wrapup_seconds`, `ended_at`), never a Redis TTL; not resumed after a restart (agents return in
  `break` and a sweep closes the attempt).
- **Reaper** (`reaper.ts`). On startup and every 60 s, closes attempts nobody owns: liveness is
  decided by ownership, with a 5-minute age floor for the window between inserting an attempt and
  dispatching it.
- **Completion notice** (`campaign-completion-notice.ts`). When a campaign finishes, mails holders
  of `agency.supervise`.

## The voice engine

- **Bridge** (`core/webrtc-bridge-manager.ts`, `core/webrtc-bridge-session.ts`). Bridges the agent's
  browser leg (the station) to the carrier's PSTN leg. Its constructor takes the
  `TelephonyGuardHost`.
- **Concurrency guard** (`core/telephony-guard-host.ts`, `core/concurrency-guard.ts`,
  `account-concurrency-guard.ts`, `provider-concurrency-guard.ts`). Global, account and provider
  scopes in Redis; startup and demand-driven self-heal reconcile; a stale-call sweep. Limits come
  from super-admin settings through the concurrency seam.
- **VoiceLink** (`telephony/voicelink/`). The adapter places dials; the carrier's media arrives on
  the WebSocket `/api/v1/webrtc-call/:id/pstn-stream`, and status on
  `POST /api/v1/webhooks/voicelink/webrtc-status/:callId` (`api/voice.plugin.ts`). Both are
  unauthenticated carrier surfaces protected by purpose-bound tokens in Redis. A missing token is
  refused when Redis answered and accepted when Redis is down; the webhook token lives 2 h past the
  call end for late recording posts (Q6). `voicelink-carrier.fixture.json` pins the carrier's
  payload shapes.
- **Audio** (`audio/decode.ts`, `core/paced-audio-streamer.ts`, `tts/tts-file-cache.ts`). Uploaded
  abandon clips are decoded to PCM and cached on disk; there is no TTS (launch decision 4).
- **Calls** are rows in `agency_calls` (`packages/db/src/repositories/agency-call.repository.ts`).

## Call analysis and transcripts

- **Worker** (`core/dialer-analysis-worker.ts`): promote → expire → claim → recover, every 60 s,
  concurrency 2 by default; jobs in `dialer_analysis_jobs`, claimed with `FOR UPDATE SKIP LOCKED`.
- **Runner** (`core/dialer-analysis-runner.ts`): load the call, take config from the job's profile
  snapshot, resume an existing transcript or fetch and transcribe the recording, persist, run the
  LLM analysis, complete in one transaction.
- **Transcribers** (`transcription/`): Gemini (default `gemini-3.5-flash`, 600 s windows) or Sarvam.
  `recording-fetcher.ts` fetches only from `VOICELINK_RECORDING_HOSTS` (default
  `recording.app.voicelink.co.in`), checked on every redirect hop.
- **LLM analysis** (`analysis/`): OpenAI, Azure OpenAI or Gemini; profiles in
  `call_analysis_profiles`, served at `/proxy/call-analysis-profiles`.
- **Playback**: `/api/v1/webrtc-recordings/:id` with an HMAC-signed query (`utils/recording-url.ts`,
  `RECORDING_URL_SIGNING_SECRET`).
- **Retention** (`maintenance/retention-purge.ts`, scheduled in `bootstrap/analysis.ts`):
  transcripts nulled after `AGENCY_TRANSCRIPT_RETENTION_DAYS` (default 30); call rows deleted only if
  `AGENCY_RETENTION_DAYS` is set. Runs 60 s after boot, then daily.

## DNC (B8)

One table, `dnc_entries`. Ingest drops suppressed numbers before they enter a roster. At dial time
`agency/dnc-registry.ts` does one indexed read (`idx_dnc_entries_tenant_phone`), widened by scope
(tenant, account, campaign), and **fails closed**: a database error halts the dial and aborts the
claimed batch. An agent's mark (`agency/dnc-mark.ts`) is campaign-scoped by default and written in
the same transaction as the attempt bookkeeping. Operators manage the list at `/dnc`
(`dnc/dnc.service.ts`, E.164 required).

## Audit (B7) and notifications

- **Audit.** Two monthly-partitioned tables: `audit_logs` (`audit/audit-logger.ts`, dialer events,
  the "Dialer" half of a campaign's activity trail) and `platform_audit_log` (`audit/platform/`,
  console and admin actions, the "Console" half). Both writers buffer and flush every 500 ms, at 100
  rows or on an error row; `bootstrap/platform.ts` starts and flushes them. Partition maintenance
  (`audit/audit-partition-maintenance.ts`) creates months ahead and drops partitions older than
  `AUDIT_RETENTION_DAYS` (default 85), once at boot and daily. Super-admin actions go to
  `super_admin_audit_log`.
- **Notifications** (`notifications/`): Mailjet client, an engine (audience, catalog, delivery), the
  agent invite template and campaign completion; `user_notification_preferences` and
  `notification_deliveries` (claim-before-send dedupe).

## Rate limiting and client IP

`api/middleware/rate-limit.middleware.ts`, registered once at app scope: buckets for ordinary traffic
(default 200/min), webhooks (1000), carrier media (600) and internal (1000); `/healthz` and `/readyz`
exempt; per-route limits (super-admin login 5/min, public invite routes) honoured. There is no
bucket keyed on a client-supplied header. Buckets key on `request.ip`, which trusts exactly
`TRUST_PROXY_HOPS` proxies (Q9).

## Data layer

- One Postgres. The whole schema is one migration, `packages/db/migrations/0001_baseline.sql`
  (node-pg-migrate, one transaction): 33 tables plus default partitions for the two audit tables,
  inventoried in `packages/db/BASELINE.md`. Tenant, account and user ids are UUIDs.
- Repositories use raw `pg` (`packages/db/src/repositories/`, plus the agency repository in
  `apps/server/src/db/repositories/`). Repository tests run on real Postgres.
- Redis holds agent leases, leader leases, station and call tokens, the membership cache and the
  guard counters. It must not evict (see [`operations.md`](operations.md)).

## UIs

- **Console** (`apps/console`). Firebase web sign-in (`VITE_FIREBASE_*`), `AgencyLoginPage` and
  `AgencyJoinPage` (no self sign-up), the agent station, campaigns, roster, activity, DNC, analysis
  profiles, team and notification settings. Permissions come from `packages/contracts/src/rbac.ts`.
  Brand pack `brands/magick-agency/` (B17); a branding guard test
  (`src/__tests__/branding/noParentBrand.test.ts`). In dev, Vite proxies every API prefix to `:3021`
  (`vite.config.ts`), and `devProxyPrefixes.test.ts` fails for any API segment the proxy misses.
- **Super-admin console** (`apps/super-admin`). Tenants, users, admins, phone numbers, feature flags,
  usage and audit; `saFetch` with the JWT in `sessionStorage`; a dev proxy for `/super-admin`. Same
  branding guard.
- **Server branding guard**: `apps/server/test/unit/branding/no-parent-brand.test.ts` scans
  `apps/server/src` and `packages/*/src` with comments stripped.

## Observability

- **OpenTelemetry SDK** (`apps/server/src/instrumentation.ts`, the first import of `src/index.ts`):
  a NodeSDK that exports traces, metrics and logs over OTLP (http/protobuf, push only) when
  `OTEL_ENABLED=true`, `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` are all set. Otherwise
  nothing starts and every metric and span is a no-op. Metric views, resource and reader settings
  are in `apps/server/src/utils/otel-sdk-config.ts`. Shutdown flushes it last, capped at 5 s.
- **Logs**: pino (`packages/observability/src/logger.ts`), service name `magick-agency`, PII masking,
  secret-bearing headers redacted. JSON to stdout; with the SDK running, also OTLP through its
  `instrumentation-pino` bridge.
- **Metrics and traces**: declared per module area in `packages/observability/src/metrics/`; spans
  via `@Traced` plus the SDK's auto-instrumentations (http, undici, pg, ioredis, …). Credentials in
  URLs (`?token=`, `sig=`, `*verify_token=`, signed-URL keys, media-stream path tokens) are
  redacted on spans as in logs (`apps/server/src/utils/redact-url.ts`).
- **Product analytics**: PostHog (`analytics/posthog.ts`), off unless `POSTHOG_ENABLED`.

## Testing

- **Real infrastructure.** Postgres on 5436 and Redis on 6383 only. Guards in
  `packages/db/test/helpers/test-db.ts` and `apps/server/test/helpers/test-redis.ts` refuse any other
  port, a database not named `magick_agency_test*`, or Redis db 0.
- **Per-worktree databases.** `tooling/test-env.ts` reads an untracked `.test-env.local.json`
  (`{ "dbName": "magick_agency_test_<x>", "redisDb": 2 }`); integration global setup drops and
  re-migrates that database on every run, so never run two integration runs on one database.
- **Unit vs integration.** `pnpm test` is unit; `pnpm test:integration` runs the server and
  `packages/db` suites file-serially against the real stack. Run from inside the package directory.
- **Chaos suites** (`apps/server/test/integration/agency/chaos/`): abandonment counter vs table,
  predicate agreement, attempt-number collision, DNC self-heal loop, lease renewer killed, network
  drop during ring, Redis expired wholesale, restart mid-bridge, roster exactly-once.
- **End to end**: `runtime-e2e.test.ts` (real app, station socket, real bridge, fake carrier,
  through disposition, analysis and completion) and `runtime-boot-order.test.ts`.
- **Contract and guard tests**: route tables enumerated from `onRoute`
  (`apps/server/test/unit/api/*route-table*.test.ts`, the agent-reach tests); config blocks disjoint;
  the bridge seam contract; the VoiceLink carrier fixture; branding guards in all three apps; the
  console dev-proxy test; the error-code unions in `packages/contracts/test/`.
- **Console** tests run in two Vitest projects (`*.timezone.test.ts(x)` and the rest), with TZ and
  locale pinned in `vite.config.ts`.

## CI

`.github/workflows/ci.yml`, on pull requests and pushes to `main`: job 1 installs `mpg123` and
`sndfile-programs`, then runs `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and
`pnpm build`; job 2 runs `pnpm test:integration` against Postgres 16 and Redis 7 service containers
mapped to 5436 and 6383.
