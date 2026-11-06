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
| `apps/console` | Vite + React SPA: agent station, supervisor pages, team, invites, accounts, settings |
| `apps/super-admin` | Vite + React SPA (the super-admin console): tenants and their accounts, users, admins, phone numbers, feature flags, usage, audit |
| `packages/contracts` | Wire contract shared by the server and both UIs: dialer types (`agency.ts`, a barrel over `agency/`, including the campaign config defaults and rate floors), console wire types (`api/`, re-exported or derived from the dialer types), error-code unions (`errors.ts`), feature flags (`flags.ts`), roles and permissions (`rbac.ts`) |
| `packages/domain` | Pure dialer rules with no imports beyond contracts: abandonment predicate, break manager, keyset cursor, rates, retry bounds and summary, success disposition, timers |
| `packages/db` | pg pool (`connection.ts`), shared repositories and models, the baseline migration, `BASELINE.md` |
| `packages/observability` | pino logger, log context, PII masking, OTel meter and `@Traced`, metric declarations per module area under `src/metrics/` |
| `packages/web-ui` | UI pieces shared by both SPAs, consumed as TypeScript source: the 15 common components and `AppVersion` (the sidebar version footer) with their CSS modules, `ToastContext`, `global.css`, error and format helpers, `parseApiErrorBody` (both API clients), the telephony-provider aliases, `mapWithConcurrency`, `useAsyncResource`, `useDialogFocus` (the one focus trap). React, the router and `lucide-react` are peer dependencies; its own no-parent-brand scan (B17). Decision B23 |
| `tooling/` | `test-env.ts` (per-worktree test database), the Vitest decorator transform, the release-please config guard (`release-please.test.mjs`, B24) |
| `docker/` | Dev Postgres and Redis (`docker-compose.dev.yml`); production: the server image (`Dockerfile`, `entrypoint.sh`), nginx with both UIs (`web.Dockerfile`, `nginx.conf`, and `mobile-app-links.sh`, which writes the mobile app-link files at start) and `docker-compose.prod.yml` (see [`operations.md`](operations.md)) |

Inside `apps/server/src`, the module areas are: `api/` (plugins, routes, middleware), `auth/`,
`rbac/`, `settings/`, `invites/`, `notifications/`, `audit/`, `cache/`, `feature-flags/` (the
platform layer); `agency/` and `db/` (the dialer runtime and campaign management); `core/`,
`telephony/`, `audio/`, `tts/`, `storage/` (the voice engine); `ai/`, `analysis/`, `transcription/`,
`maintenance/` (call analysis and retention); `config/`, `bootstrap/`, `seams/` (composition).
The agency repository lives in `apps/server/src/db/` rather than `packages/db` to avoid a package
cycle (B12). Boundaries are described in [`seams.md`](seams.md).

## Runtime picture

```
 browsers: agent / supervisor (console :5175)      super-admin console (:5176)
          │ Firebase ID token, X-Tenant-Id / X-Account-Id   │ super-admin JWT
          ▼                                                 ▼
 ┌──────────────────────── apps/server (one process, :3021) ───────────────────────┐
 │ app-wide: CORS* · rate limiter · error handler + 5xx mask · websocket · probes │
 │                                                                                │
 │ platformPlugin   /auth /tenants /accounts /users /invites /notifications       │
 │                  /feature-flags /client-config /super-admin/*                  │
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

\* CORS only with the API on its own host (`CORS_ALLOWED_ORIGINS`, decision B27).

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

**`buildApp`** (`app.ts`) registers, in order: CORS, only when `CORS_ALLOWED_ORIGINS` is set (B27;
`api/middleware/cors.ts`), and it must stay before the rate limiter, because its `OPTIONS *` route
registered after the limiter would be charged to a bucket; the rate limiter (app scope, so every route is in a
bucket) and the per-user bucket the session middleware charges; the error handler with the `22P02 → 400` backstop and the 5xx error mask (no driver text
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
   partition maintenance, cache-invalidation subscriber on `<REDIS_KEY_PREFIX>cache:invalidate:db<N>`,
   scoped to the Redis db because pub/sub is server-wide); `startVoice` (S3, clip cache and sweeper,
   decode scratch reap, guard host and bridge, startup self-heal); `startAgency` (ingest reaper, then
   `AgencyRuntime.start()`, which runs the startup reaper before the pacing supervisor, then the
   insights rollup job);
   `startAnalysis` (worker, retention purge). Voice starts before agency so the bridge's self-heal
   finishes before any pacing tick.
6. `app.listen`, only after the bootstraps, so no request lands before the startup reap.

Shutdown closes HTTP first (`app.close()`), then runs the stops in reverse: analysis; agency
(the insights rollup job's batch in flight first; then pacing, waiting up to 5 s for ticks and owner sweeps in flight; then reaper, sweeps, dialer and wrap-up
timers; completion notices drained up to 30 s); voice (the bridge ends live calls, then the guard host, then the PostHog flush); platform
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
- **Internal handler instance.** The dialer's handlers (`agency.routes.ts` with `agency/`,
  `agency-campaigns.routes.ts` with `agency-campaigns/`, `agency-agents.routes.ts`) are registered on a private Fastify
  instance that never listens and is not in the app's route table (`api/core-handlers.ts`), under
  `/api/v1/agency`, `/api/v1/agency-campaigns` and `/api/v1/agency-agents`.
- **`callCore()`** (`api/core-dispatch.ts`) runs an internal handler through `inject`: it encodes
  the query, sends a JSON body only for POST / PUT / PATCH, decodes JSON (or returns a raw Buffer),
  refuses path traversal, and sets the internal tenancy headers `x-mgkvc-tenant` /
  `x-mgkvc-account` from the public layer's tenant context only, never from forwarded headers.
  Its typed `provenCampaignId` sets `x-mgkvc-proven-campaign` (`<tenant>:<account>:<campaign>`),
  which the internal spine handler honours only on an exact match; the header is stripped from
  forwarded headers. `forwardCore` / `forwardCoreVia` (the pass-through forwarders) live beside it.
- **Route families.** A large route file is `<family>.routes.ts` (the plugin function, its hooks)
  plus a `<family>/` folder of `register…(app)` functions on the same instance, e.g.
  `proxy-agency-campaigns/`, `proxy-agency-performance/`, `proxy-agency-staffing/`,
  `super-admin/`; helpers shared by route files are in `api/routes/helpers/` (`parseOr400` keeps
  the three 400 shapes apart).

A request goes: app-wide limiter → session (Firebase) → tenant context → RBAC → public handler →
`callCore` → internal handler → repository.

## Identity and tenancy

- **Firebase.** `auth/firebase.ts` initialises `firebase-admin` with only the project id
  (`FIREBASE_PROJECT_ID`), no service account: `verifyIdToken` checks the signature against
  Google's public keys. `auth/session.middleware.ts` verifies the ID token.
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
  preferences, the flag map and the uplink probe (`POST /client-config/uplink-probe`, any verified
  user). Enforced by `rbac/rbac.middleware.ts`.
- **Accounts.** A tenant starts with one account, `Default`, written with the tenant. More are added
  by a tenant admin or owner on a tenant-wide seat (`POST /accounts`, `account.create`, the console's
  Accounts page) or by a super admin (`POST /super-admin/tenants/:id/accounts`), both through
  `api/routes/helpers/create-account.ts`: one transaction under a `FOR NO KEY UPDATE` lock on the
  tenant row, a name unique in the tenant ignoring case, a slug derived from it. A tenant admin's
  account gets `max_concurrent_calls = 0` until a super admin sets its limit; a super admin's takes
  the default. Accounts list oldest first, so the console's default selection stays on `Default`
  (decisions AA1–AA6). There is no rename or delete.
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
  on reconnect puts the agent in `break` (`rehydrateAgent`). Two break codes are **reserved**
  (`RESERVED_BREAK_REASONS`, `packages/contracts/src/agency/breaks.ts`): no campaign catalog may
  list them (the campaign-config write refuses them, `resolveBreakReasons` drops them).
  `soft_phone` is entered only through the soft-phone switch. `device_away` is what the mobile app
  sends on `POST /sessions/:id/break` the moment it is backgrounded (`api/routes/agency/device-away.ts`):
  from `available` it applies at once by CAS (a reservation that lands first wins, and the request
  is queued instead); from `reserved` / `on_call` / `wrapup` it is queued like any break, unless
  another break is already queued, which it never replaces; on any other break, `offline`, no
  lease, or a soft-phone session it changes nothing and answers the current state (200, and no
  audit row). The return is the ordinary `/available`; `break/cancel` withdraws a queued one.
- **Joining** (`POST /proxy/agency/sessions`, internal `api/routes/agency/sessions.ts`). One live
  session per agent per tenant (`uq_agency_agent_live_tenant`, `409 session_on_other_campaign`). A
  NEW session needs an active staffing row on the campaign (`agency_campaign_agents`, the rows
  `GET /proxy/agency/my-assignments` lists), else `403 not_staffed`, unless the caller's role holds
  `agency.supervise` (the public layer reads it from the membership and sends `supervise`).
  Re-bootstrapping the agent's own live session on that campaign is not refused: unassigning closes
  the staffing row and touches no live session, so an agent unassigned mid-shift keeps that session
  (a reload, an app resume) until they leave it. Staffing narrows where a session may start; it
  grants nothing.
- **Stations** (`station-registry.ts`, `station-socket.ts`, `station-token.ts`,
  `station-upgrade.ts`). The browser console or the agent mobile app opens a WebSocket at
  `/proxy/agency/station/:sessionId` (`station_ws_url`, a path relative to the API origin) with a
  single-use token (2 min TTL, consumed in Lua) minted over
  authenticated HTTP. Only the session's own agent can mint its token (Q8). The upgrade query names
  the app and its media encoding, `client=web|mobile` and `media=pcm16|alaw8` (defaults `web`,
  `pcm16`); an unknown value is refused 1008 before the token is consumed
  (`parseStationUpgradeQuery`). Every attach writes the app to `agency_agent_sessions.client_kind`
  (0006), folded into the attach's own session read and only when it changes
  (`readForStationAttach`), so a session continued on another device follows it; the supervisor's
  floor marks mobile agents with it. Liveness is the registry entry's `lastSeen`, renewed by the
  client's app-level `ping` (which alone renews the Redis ownership key and the lease), and held to
  a **per-station grace** (`packages/domain/src/timers.ts`): 30 s for the web, 10 s
  (`MOBILE_STATION_HEARTBEAT_GRACE_MS`) for the mobile app. A mobile station is also sent an RFC 6455
  ping every 3 s (`MOBILE_STATION_PROBE_MS`), and every protocol pong, or ping from the app, renews
  `lastSeen` in memory only, never Postgres or Redis; the probe's timer and listeners go with the
  socket (detach, supersede or close). The silent-station sweep runs every 5 s, so a silent console
  is closed 4408 30–35 s after its last sign of life, and a silent phone is dropped 10–15 s after
  with `terminate`, never `close` (on a dead transport `close` waits out `ws`'s 30 s closing
  timeout, leaving the agent attached and dialable; the app treats any close as a reconnect). A
  console with a live attempt is never closed by the sweep (the bridge's deferred hangup owns the
  call). A phone silent on a call the agent can see is dropped the same way and the 8 s deferred
  hangup decides the call (M1); on either app an unbound dial is not closed but gets its pre-bind
  grace armed. A live soft-phone call follows the same rule (M1 as amended): a console is never
  closed, a silent phone is dropped, and the bridge's rule for a manual leg decides (an immediate
  hangup before the answer, the 8 s deferred hangup after it). The join (`X-Client`, parsed by
  `utils/client-header.ts`) serves the mobile app `heartbeat_grace_ms` 10 000. The `media=` format
  is the agent leg's audio for the socket's life: the handler routes frames on `ws`'s `isBinary`
  (binary is `alaw8` audio, text is JSON control) and tags the socket for the bridge
  (`core/bridge/browser-leg-media.ts`).
- **Send back-pressure** (`utils/ws-backpressure.ts`). Every write to a station socket (the
  registry's `send` / `broadcast`, the bridge's relay and status frames on the borrowed leg) and
  the bridge's media relay to the carrier read `ws.bufferedAmount` first. Media past a soft limit
  of about 3 s of the leg's own audio (128 KiB `pcm16`, 24 KiB `alaw8`, 40 KiB carrier) is dropped
  and counted (`websocket_send_backpressure_total`, `droppedBrowserMediaFrames` /
  `droppedPstnMediaFrames` on the call's end line); control frames are never dropped. A station
  past the 1 MiB hard cap is not reading at all and is closed 4408 `station_send_backlog` (then
  terminated if it has not closed 5 s later); the carrier's stream has no hard cap, because closing
  it hangs the call up.
- **Pacing** (`pacing-engine.ts`, with `pacing/`: leader lease, caller-ID pool, campaign announcer,
  in-flight tracking). One leader per campaign via a Redis lease (15 s, renewed every
  5 s; a supervise pass every 2 s takes leadership); the leader runs one ROUND every 250 ms over
  the campaigns it leads. The lease is only for efficiency. Correctness is the `FOR UPDATE SKIP LOCKED` claim in
  `AgencyContactRepository.claimDialable` (`apps/server/src/db/repositories/agency/contact.repository.ts`)
  plus the `uq_agency_attempt_live` unique index, so two leaders cannot dial one contact.
  The claim also keeps one live call per number across the ACCOUNT (MC4): it skips a contact whose
  number is already `in_flight` or `connected` on another contact of any campaign of the account
  (a retry child and its parent, or two rosters sharing a number), and takes at most one contact
  per number in a tick (a roster deduped on a loan number can hold one borrower twice). Claims for
  one account's campaigns run one at a time in the engine, so the read probe is enough against
  other pacing ticks. The agent's own dial (`claimForAgentDial`) and the soft phone's pre-dial
  check the account the same way but run outside that lock, a millisecond race `decisions.md` §5
  keeps open.
  `pre-dial-gates.ts` checks phone validity, then calling hours, then DNC (fail closed).
  `stop()` waits up to 5 s (`TICK_DRAIN_TIMEOUT_MS`) for ticks in flight, and every dial site
  re-checks `mayDial`, so no tick dials after shutdown begins.
- **Pacing rounds, skips and invalidation** (`pacing-engine.ts` `runRound`, `pacing/round.ts`,
  `pacing/invalidation-bus.ts`, `pacing/read-cache.ts`). A round starts a tick for every led
  campaign together, so campaigns of one account read the account limit and its live calls once
  per round (the live-call count is never carried into the next round). An account may run several
  campaigns at once (MC1–MC7 in `decisions.md`; migration 0015 dropped `uq_agency_campaign_running`,
  and Start and Resume no longer answer 409 `another_campaign_running`), and the round splits the
  account's headroom between them rather than first come, first served: each tick states its demand
  and its own live calls, and each free slot goes to the campaign with the fewest live calls that
  can still use one, a campaign that cannot use its share leaving it to the others (MC1). Every
  campaign a scheduled round starts joins its account's split before any tick runs, a drain-only
  (`stopping`) one or one whose last full tick found it not running joining without contending.
  Once every member has reported or withdrawn the headroom is split among those that reported; if
  some have not reported 1 s after the account's first report, the split runs without them and
  stays open (MC2). An account has at most one open split: while it is open, rounds start no tick
  for that account's campaigns, and it closes when every member has reported or withdrawn, or,
  once open past `max(5 s, the wait)`, at the next round's start with a warning. A member reporting
  while the split is open after it ran gets `min(demand, leftover)`, first come first served; one
  reporting after the close gets 0, is held back (not quiescent) and takes part in the next split.
  Dials a split granted that are not yet attempt rows are held per tick in a per-account ledger
  (released per inserted attempt and at the latest when the tick ends; a hold with no progress for
  60 s stops counting, with a warning) and added to every later round's live read, so with one
  open split at a time no headroom is granted twice (MC2). A contended tick that claimed fewer
  contacts than its grant has its demand capped at what it claimed (at least 1) in later contended
  rounds, until it fills a grant (MC5); one held back while the account had headroom is not
  quiescent (MC5). With one running campaign the rule is the old `MAX(0, MIN(limit − live, idle))`.
  A forced `tickOnce` is exempt from the split (no production caller; the concurrency guard refuses
  any excess). While two processes lead campaigns of one account (a leader failover or a deploy
  overlap; an old leader learns it lost a lease only at its next renewal) each splits the account's
  headroom, and the concurrency guard refuses the excess (MC3). `agency_campaign_slots_in_use` and
  `agency_campaign_slots_allocated` (set only after a contended report) and
  `agency_pacing_share_withheld_total` (contention) show the split (dashboard *Pacing Share*
  panels, `agy-pacing-share-starved`). A campaign whose last full tick
  was QUIESCENT (no agent available, no account slot, no usable caller ID, or not running) is
  skipped with no database or Redis work until an event wakes it or the safety tick
  (`PACING_SAFETY_TICK_MS`, 1 s) comes due; a campaign that planned a dial ticks every round.
  The events go over `PacingInvalidationBus`, plain JSON so a child-process IPC implementation can
  replace the in-process one: `campaign_changed` (every
  campaign repository write), `account_limit_changed` (the `ConcurrencyControl` seam's limit
  invalidations, wrapped by `startAgency`), `account_capacity_freed` (attempt and manual-call
  ends), `agent_available` (a state write into `available`, a station attach), `contacts_changed`
  (ingest chunks, owner sweeps), `station_ready` (a `ready` sent on a `strict` / `preferred`
  campaign: the engine forgets the session's last `queue` frame and sends it again). The campaign row and the account limit are cached between full ticks in a
  generation-guarded TTL cache (2 s backstop), dropped by their events and re-primed by the
  supervise pass. `tickOnce` is a forced full tick that reads everything fresh. Measured by
  `test/integration/load/pacing-statements.test.ts`; `agency_pacing_ticks_total` and
  `agency_pacing_missed_wakeups_total` show the skip ratio and any wake-up the bus missed.
- **Pacing history** (`pacing/pacing-history.ts`, `agency_campaign_pacing_minutes`, 0013; IN2,
  `docs/insights.md`). Why a campaign did or did not dial, kept per campaign per UTC minute for the
  insights page. The engine counts into an in-memory accumulator next to every
  `agency_tick_idle_total` and `agency_predial_gate_total` increment (pinned together by
  `pacing-history-pin.test.ts`), every tick on a running campaign (full or skipped; also whether
  the campaign's own window was closed) and every paced dial, and flushes one additive upsert
  (`x = t.x + EXCLUDED.x`) every 15 s, when it gives a campaign up and on `halt()` (bounded, 3 s).
  Best effort: a failed flush is kept for the next one, and beyond 10,000 unwritten minutes the
  oldest are dropped (`agency_pacing_history_dropped_total`); a write never fails a tick. Events
  outside the tick are one single-row upsert each, from whichever process has them: a wrap-up
  redial refused at the limit (the media worker holding the station) and every our-fault
  retirement (`countOurFaultRetirement`, beside `agency_our_fault_retirement_total`). The read
  and its stall rule are `AgencyInsightsPacingRepository.pacingHistory`.
- **The insights rollup** (`insights-rollup-job.ts`, `agency_insights_rollup_*`, 0012;
  `docs/insights.md` "The rollup"). The range numbers of the Insights tab, per campaign per
  15-minute UTC bucket, rebuilt from the attempts and never incremented. Statement-level triggers
  on `agency_call_attempts` (and row triggers on a recording arriving and on a zone change) append
  a dirty mark per bucket a write touches; every `agency.insightsRollup.intervalMs` (15 s) the job
  claims up to `batchSize` marks oldest first (`MATERIALIZED` + `SKIP LOCKED`), locks the buckets'
  header rows in key order and recomputes them from a later snapshot, deleting exactly the marks
  it claimed. Started by `bootstrap/agency.ts` in the main process only (once per deployment);
  passes never overlap; `stop()` waits for the batch in flight. A failed batch keeps its marks.
  Backlog, oldest mark, recompute time and failures are metrics (`agency_insights_rollup_*`).
- **The reopen flag.** An agent's reopen ("Retry not reached") sets
  `agency_contacts.agent_reopen_pending`; the pacing tick's attempt insert consumes it in the same
  statement and stamps that attempt `agent_reopened`, so exactly the first paced dial after a
  reopen carries it. The agent's own dial of the contact clears it (its undo gives it back), and a
  paced attempt abandoned before its dial (dispatch refused, lease lost after the insert) restores
  it with the contact.
- **Dialer** (`agency-dialer.ts`, `dial-dispatcher.ts`, with `dialer/`: live-attempt record, contact
  settlement). Reserves the agent before the dial, re-asserts the lease and asks the pacing engine
  (`stillAuthorised`) right before `createBridgedCall`, registers the lifecycle listener before
  dialing, writes the agent's panel and binds the audio with no `await` between, and stamps
  `answered_at` and `bridged_at` independently. A dial the carrier refused is settled once: the
  bridge emits `ended` before `createBridgedCall` rejects, and the `ended` arm settles it,
  except an outcome-unknown one (`TELEPHONY_INIT_OUTCOME_UNKNOWN`), which it leaves to the dial's
  failure path (`abandonBeforeDial`: `failed`, redial held 15 min); that path abandons nothing
  the `ended` arm already settled. Any other end while the dial is in flight and unanswered (a
  hang-up or a station teardown racing `add_lead`) settles the row and the agent at once and
  leaves the contact claimed until the dial returns (`LiveAttempt.dialSettled`): outcome
  unknown, it is held too. The hold is one statement with an our-fault charge
  (`holdOutcomeUnknownContact` in `dialer/contact-settlement.ts`, over the reaper's
  `requeueOrphaned`), so the our-fault bound ends a run of such dials. A dial that fails in the bridge
  before the carrier is asked (the row INSERT, or the steps after the
  session is registered: the max-duration timer, the socket attach, the carrier tokens, the
  carrier request's inputs) gets no `ended`, so the same failure path settles it: `failed`,
  uncharged, dialable again after 1 min (`PRE_CARRIER_FAILURE_REDIAL_DELAY_MS`, so a failure
  that repeats cannot redial one contact on every tick; a delay, not an our-fault charge, so a
  systemic failure retires nobody). A dial called off before the bridge (the agent's socket or
  lease went, pacing stopped), or refused admission for capacity (back-pressure, not a fault:
  pacing already bounds it by the account limit), returns its contact at once.
- **Abandonment.** A call the customer answered and no agent reached. `abandon-clip.ts` plays the
  campaign's uploaded clip and hangs up (`playClipToCarrierThenHangUp`); the predicate is a leaf
  module shared by SQL and code (`packages/domain/src/abandonment-predicate.ts`);
  `abandonment-guardrail.ts` auto-pauses a campaign over its ceiling (default 3%) on the 60 s
  refresh of the rolling 24 h rate.
- **Wrap-up** (`wrapup-manager.ts`). An in-process countdown plus the attempt row
  (`wrapup_seconds`, `ended_at`), never a Redis TTL; not resumed after a restart (agents return in
  `break` and a sweep closes the attempt).
- **Wrap-up redial** (`wrapup-redial.ts`, `POST /sessions/:id/redial`, decisions WR1–WR13). On a
  campaign with `allow_wrapup_redial`, an agent in a wrap-up that owes an outcome may redial the
  same customer, at most `AGENCY_WRAPUP_REDIAL_LIMIT` (2) times per call; the `wrapup` frame's
  `redial_remaining` says how many are left. Everything that can refuse runs first, so a refusal
  leaves the wrap-up and its countdown as they were: the rows, the station, a caller ID and the
  pre-dial gates (which mint the clearance the dispatcher checks, as for a paced dial). Then the
  wrap-up is taken synchronously (`takeForRedial`: the countdown stops, so auto-return cannot fire
  during the redial), the agent moves `wrapup → reserved` by CAS (`reserveFromWrapup`), and one
  transaction (`beginWrapupRedial`) locks the redialled attempt, takes the customer back
  `connected → in_flight` while still parked for it, stamps it `redialed` and inserts the redial
  (`redial_of_attempt_id`, `redial_number`). The dial goes through the dispatcher to
  `executeDial`, always early-bound. Whatever the redial's outcome, the customer stays held for the
  outcome (`parkRedialContact` through the guarded `parkForWriteUp`, no retry charge) and the
  agent lands in wrap-up on the redial; a failure after the take reopens the wrap-up (a fresh
  window). Where wrap-up cannot reopen, `releaseOwingOutcome` holds the agent on `break` (or
  `offline` with no station), never the pool. From the take until wrap-up reopens,
  `/available`, force-available and `/leave` refuse (`hasRedialInFlight`, WR11); a station
  reconnect mid-wrap-up comes back `wrapup` so the first Redial works. A redial whose dial
  outcome is unknown reopens wrap-up with no further redial offered (WR9). Stats count each
  conversation once (`CONVERSATION_ATTEMPT_SQL`) and report redials as `attempts_redialed`
  (WR12). In media-worker mode the redial dispatches in the worker that owns the station (WR13).
- **Contact assignment** (decisions CA1–CA15; flag `agency_contact_assignment_enabled` gates the
  surface, never the runtime). Each contact may have an owner (`agency_contacts.assigned_user_id`),
  and every move is a row in `agency_contact_assignment_events` under its operation's `batch_id`.
  *Supervisor*: `proxy-agency-assignment.routes.ts` previews an operation and commits it with the
  preview's token (`db/repositories/agency/assignment.repository.ts`: one SQL planner for every
  kind; the commit locks the rows, re-plans and writes only when the plan still matches the token,
  else `409 preview_stale`), and reads progress per agent and a contact's owner history. *Pacing*:
  on a `strict` or `preferred` campaign, the tick pairs by agent (`claimForAgents`, one statement,
  a `LATERAL ... LIMIT 1` per agent), never reserves an agent with nothing due (in `preferred`
  mode the pool's due contacts count for as many agents without own work, longest idle first,
  as there are such contacts), and tells the
  station why with a `queue` frame on a change (`pacing/agent-queue.ts`, the one reading shared
  with the join bootstrap, `ready` and the My contacts summary; after a `ready` the next tick
  sends the frame again, so a reconnect cannot keep a stale or missing queue); the leader sweeps due callbacks
  whose owner is away past the grace back to the pool, and the open contacts of owners no longer
  staffed on the campaign (`pacing/callback-fallback.ts`), every 30 s per campaign, in the
  background: the tick starts the sweep and plans without waiting for it, one sweep per campaign
  runs at a time, a move wakes the campaign (`contacts_changed`), and `stop()` waits for one in
  flight within the tick drain bound. *Agent*:
  the My contacts reads, the set-based reopen of not-reached contacts
  (`agent-retry.repository.ts`) and the per-contact call, which runs in the process holding the
  station (`agency/my-contact-call.ts`, `session_param`) on the campaign's normal dial path with
  `agent_manual` on the attempt. *Outcomes*: the disposition write grants a catalog entry's
  `override` and assigns a pooled callback to the agent who took it (CA4); a settlement or
  disposition that would exhaust a contact spends an extra attempt instead
  (`markExhaustedOrSpendExtraAttempt`); the agent's call spends a retry-delay or calling-hours
  override (`agency/contact-overrides.ts`, the pre-dial gate's `callingHoursOverride`). *Unstaff*:
  every path that closes a staffing row runs `assignment/unstaff.ts` (CA6). One SQL definition of
  a contact's bucket and its retry eligibility (`db/repositories/agency/assignment-sql.ts`) serves
  every read.
- **Reaper** (`reaper.ts`). On startup and every 60 s, closes attempts nobody owns: liveness is
  decided by ownership, with a 5-minute age floor for the window between inserting an attempt and
  dispatching it. A reaped attempt's contact is requeued on the our-fault ledger in one guarded
  statement, and only while it is still that attempt's (no newer attempt, no soft-phone claim).
  The stranded-contact sweep (a contact `in_flight` with no live attempt for 5 min) requeues the
  same way and, in that statement, keeps it until `dialed_at` + 15 min when one of its dials was
  sent and never answered or ended by a carrier answer, so an outcome-unknown hold whose own
  write failed is not cut short. The lapsed-wrap-up sweep (`findLapsedWrapups`, then `closeLapsedWrapup` per row) stamps
  `no_disposition` when one was owed and releases the contact through the outcome policy, in one
  statement that locks both rows and writes only while the attempt has no disposition and the
  contact is still parked `connected` for it (no newer attempt, no soft-phone claim); it counts
  only the closes that landed. An un-dispositioned wrap-up redial is swept like a connected call.
- **Disposition** (`api/routes/agency/attempts.ts`). `recordDisposition` is one guarded UPDATE:
  the same code again is a successful replay, a different code a 409. The contact write after it
  (`AgencyContactRepository.releaseFromDisposition`) is one statement that lands only while the
  contact is still the attempt's: no newer attempt, no soft-phone claim held or taken since the
  attempt, and the contact parked `connected` for it (or `pending` on the same code, the replay
  that corrects a callback time, or DNC-suppressed, where only `last_disposition` lands). A late
  replay of an old attempt's disposition therefore answers the same 200 and leaves a contact a
  later call settled, or pacing or the soft phone re-claimed, as it is.
- **Soft phone** (`softphone/`, [`softphone.md`](softphone.md)). Manual calls outside pacing:
  `ManualDialer` dials agent-first through the bridge with a `manual` correlation and owns the
  call until it ends; `SoftphoneService` (`runtime.softphone`) is the API layer's surface. The
  soft phone is a `break/soft_phone`, a Lua-guarded `manual` claim on the agent hash keeps the
  session out of `available` while a call is live or awaiting its outcome, pacing headroom counts
  the whole account's live calls (`countLiveForAccount`), and the reaper's orphan and lapse
  sweeps close what nobody owns. Both clients have it on the same routes and station frame: the
  console's `/dialer/phone` and the agent app's Phone tab ([`mobile.md`](mobile.md)).
- **Completion notice** (`campaign-completion-notice.ts`). When a campaign finishes, mails holders
  of `agency.supervise`, linking to the campaign under its own tenant and account (B26).

## The voice engine

- **Bridge** (`core/webrtc-bridge-manager.ts`, `core/webrtc-bridge-session.ts`, with `core/bridge/`:
  admission, the exported types, the per-call WS tokens). Bridges the agent's browser leg (the
  station) to the carrier's PSTN leg. Its constructor takes the `TelephonyGuardHost`. A dial
  (`placeOutboundLeg`) that throws after its session is registered and before the carrier request
  (the max-duration timer, the socket attach, the carrier tokens, and what the request is built
  from: the webhook base, the provider's adapter, the carrier URLs) is torn down there (terminal row `failed`/`BRIDGE_SETUP_FAILED`, timer, socket listeners, slots,
  lease entry, tokens) with no `ended`, and the original error rejects the dial; a teardown that
  lands in that window stops the dial before the carrier is asked. Once the carrier has accepted
  the dial, a failed `provider_call_id` write is logged and the call carries on.
- **Browser leg media** (`core/bridge/browser-leg-media.ts`, contracts `AgencyStationMediaFormat`).
  The station socket says how the agent leg speaks: `pcm16` (JSON `media` frames, base64 PCM16
  16 kHz) or `alaw8` (binary messages of raw G.711 A-law 8 kHz: any whole number of 20 ms /
  160-byte frames up to 1 s in, exactly one 160-byte frame per message out). The mobile app always
  asks for `alaw8`; the console asks for it unless the tenant's `agency_console_alaw8` flag is off
  (default on), and turns to `pcm16` for the rest of that station if the server refuses `alaw8`
  (1008 `invalid_media`) or answers it with JSON `media`. The console makes its A-law in the
  capture AudioWorklet (half-band low-pass, 16 → 8 kHz) and decodes and interpolates the downlink
  to its 16 kHz playback context, with filter state kept across frames (`utils/alaw8/g711.js`). The station handler tags its socket with the format at upgrade; the session reads the tag
  at every attach (`adoptBorrowedBrowserLeg`: dial-time, late bind, re-attach), so it is a
  synchronous field read on the bind path and a reconnect that chose another format switches the
  relay with it. The bridge's borrowed-socket listener routes on `isBinary`; media in the other
  format is dropped and counted (`ignoredBrowserMediaFrames` on the call's end line). When the
  carrier module's `wireFormat` matches (`alaw8` on VoiceLink) the relay is **passthrough**: the
  agent's bytes go out base64 in the carrier's frame and the carrier's decoded bytes go to the
  agent as `Buffer` views, with no codec either way. A carrier with another wire format transcodes
  through A-law ⇄ PCM16 16 kHz and its own codec. Nothing else reads the browser leg's audio:
  recordings are the carrier's, analysis reads the recording, and the abandon clip
  (`playClipToCarrierThenHangUp`) and any other playback go to the carrier leg only.
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
- **Carrier modules** (`telephony/carrier-modules.ts`). Each carrier declares its media-stream
  protocol (start negotiation, codec, wire format, framing, clip encoding) and hangup style; the bridge asks
  the session's module rather than branching on a provider name (B18).
- **Tenant carrier credentials** (`telephony/credentials/`, B18–B22). A tenant may dial on its own
  carrier account (Plivo). Super-admins add the credential; it is checked with the carrier, then
  sealed (AES-256-GCM envelope under the `TELEPHONY_CREDENTIAL_KEYS` keyring) into
  `telephony_credential_secrets`. Calls and campaigns pin `telephony_credential_id` (composite FKs
  keep it to their own tenant and provider). `getForCredentialId` peeks the pinned credential on
  every use (row checks only, nothing opened), refuses one of another tenant or provider before
  any secret is opened, and calls `resolve` only on a cache miss (the cache is keyed by the
  versions the peek listed). Only a `CredentialUnavailableError` drops cached adapters; a
  transient error is rethrown unchanged. It never falls back to the service's own account: the
  bridge's teardown (`hangupProviderLeg`) hangs a pinned call up through it (`call_control`, the
  call's tenant), and an unresolvable credential is logged at ERROR and the hangup skipped; a call
  with no credential stays on `get(provider)`. A disabled credential still hangs up its live
  calls, and a rotation keeps the old secret for 24 h for webhooks signed with it (opened best
  effort: a grace version that will not open is skipped with a warning). A revoked credential is
  shredded only once every pinned call is terminal and ended more than 2 h ago (Q6). The routes'
  error codes are `TELEPHONY_CREDENTIAL_ERROR_CODES` in the contracts: `credential_store_unavailable`
  (503) means no keyring is configured; `secret_unavailable` (409, not retryable) means this
  credential's secret is shredded, missing, or sealed under a key the keyring lacks.
  Only ciphertext reaches SQL, and pg spans carry query text, never parameter values
  (`decisions.md`, rulings of 2026-10-16).
- **Audio** (`audio/decode.ts`, `core/paced-audio-streamer.ts`, `tts/tts-file-cache.ts`). Uploaded
  abandon clips are decoded to PCM and cached on disk; there is no TTS (launch decision 4).
- **Calls** are rows in `agency_calls` (`packages/db/src/repositories/agency-call.repository.ts`).

## Call analysis and transcripts

- **Worker** (`core/dialer-analysis-worker.ts`): a slot pool. Up to `DIALER_ANALYSIS_CONCURRENCY`
  (default 8) jobs run at once; when one finishes its slot claims the next at once, a short
  claim arms a timer for the next due job (settle delay, backoff), and `wake()` fills free slots.
  A sweep every 60 s (self-dormant when idle) promotes → expires → fills slots → recovers stale
  claims, and is the safety net. Jobs in `dialer_analysis_jobs`, claimed with
  `FOR UPDATE SKIP LOCKED`, so several processes can share the queue. Before claiming, a slot
  reserves a worst-case recording on the recording byte budget
  (`core/recording-byte-budget.ts`, `DIALER_ANALYSIS_MEMORY_BUDGET_BYTES`); the runner shrinks
  it to the real size. A wait nobody wants leaves the line at once (a released lease's grow, a
  slot's budget wait at shutdown), so it never holds up the waiters behind it. A vendor rate limit opens a process-wide pause with one probe after it
  (`core/vendor-rate-limit-breaker.ts`). Shutdown stops new claims, then requeues the jobs in
  flight, generation-matched.
- **Runner** (`core/dialer-analysis-runner.ts`): load the call, take config from the job's profile
  snapshot, resume an existing transcript or fetch and transcribe the recording, persist, run the
  LLM analysis, complete in one transaction.
- **AI client layer** (`ai/`): the one place AI requests go out. `createAiClient` builds an
  `AiClient` for `openai_compatible` (OpenAI or any Chat Completions endpoint), `azure_openai` or
  `gemini` (native SDK, Files API); each does one request (the OpenAI SDK's own retries are off)
  and returns a neutral response. Retries, windowing and prompts stay with the callers. An
  `AiError` carries a `kind`: the runner requeues `rate_limited` without using an attempt and
  fails `unsupported_input`, `unsupported_operation` and `invalid_config` at once. Sarvam (speech-to-text only) calls its API directly.
- **Transcribers** (`transcription/`): Gemini (default `gemini-3.5-flash`, 600 s windows, through
  the `ai/` gemini client) or Sarvam.
  `recording-fetcher.ts` fetches only from `VOICELINK_RECORDING_HOSTS` (default
  `recording.app.voicelink.co.in`), checked on every redirect hop.
- **LLM analysis** (`analysis/`): any `ai/` provider (`POST_CALL_ANALYSIS_PROVIDER`), on the transcript,
  or with `POST_CALL_ANALYSIS_INPUT=audio` (gemini) on the recording plus the transcript: the runner
  hands over the bytes it fetched (a resumed run fetches them again, from the transcript's
  `source_url`), the service uploads them once and deletes the upload after, and heartbeats the
  job's claim before every request so a slow run is not recovered from under it; profiles in
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
  invite templates (one shared layout; the agent invitation linking `/agency/join/:token`, the
  workspace invitation for every other role linking `/join/:token`) and campaign completion;
  `user_notification_preferences` and `notification_deliveries` (claim-before-send dedupe).

## Rate limiting and client IP

`api/middleware/rate-limit.middleware.ts`, registered once at app scope, in `onRequest` (before any
auth). Each request is charged to one bucket, and each bucket has its own key namespace so one
counter never holds two ceilings:

| Bucket | Key | Default / min | Who |
|---|---|---|---|
| `webhook` | `wh:<ip>` | 5000 (`RATE_LIMIT_WEBHOOK_MAX`) | `/api/v1/webhooks/*` |
| `carrier_media` | `cm:<ip>` | 2000 (`RATE_LIMIT_CARRIER_MEDIA_MAX`) | media sockets, TTS clips, both WebRTC legs |
| `station` | `st:<ip>` | 3600 (`RATE_LIMIT_STATION_MAX`) | the station socket upgrade, `/proxy/agency/station/*` (a single-use query token, not a bearer): a floor behind one NAT walking the reconnect ladder at once must not spend the plain bucket or 429 a mid-call reconnect |
| `internal` | `int:<ip>` | 1000 (`RATE_LIMIT_INTERNAL_MAX`) | `/internal/*` (none served) |
| `ip_auth` | `ipa:<ip>` | 20 000 (`RATE_LIMIT_IP_AUTH_MAX`) | any other request carrying `Authorization: Bearer` |
| `ip` | `<ip>` | 2000 (`RATE_LIMIT_MAX`) | everything else, unauthenticated: sign-in refusals, invites (own 20/min cap), `GET /client-config` |
| `exempt` | none | unlimited | `/healthz`, `/readyz` (exact paths) |

Then, inside every authenticated route, `sessionMiddleware` charges the **per-user** bucket once it
has verified the caller: key `u:<user id>`, default 600/min (`RATE_LIMIT_USER_MAX`, platform config
block), same window and store. That one binds authenticated traffic: agents behind one carrier-grade
NAT (Jio, Airtel) share an IP but never a user bucket, and the IP bucket for bearer traffic is
deliberately coarse. Only the PRESENCE of a bearer picks `ip_auth`; it is not verified there and its
value is never a key, so a forged bearer buys the larger coarse bucket and is then refused 401 (Q9,
amended 2026-11-01). A route may add its own tighter per-user cap in its own namespace
(`createUserRateLimit`): `POST /client-config/uplink-probe` allows 6 per user per window (`up:<id>`),
charged with its authentication in `preParsing`, so no body is read for a caller who fails either.
Super-admin routes (their own JWT, no `request.user`) stay on the IP buckets.

The defaults are sized for ~500 agents and ~50 supervisors behind one office NAT, at 500
concurrent calls (~510 dials and ~170 answers a minute); the arithmetic per bucket is in
`api/middleware/rate-limit-defaults.ts`, which the middleware and both config blocks read.
Per-route limits (super-admin login 5/min, public invite routes 20/min) are honoured, each keyed on
the IP alone (the route pins its `keyGenerator`; an inherited one would split a bearer and a
non-bearer request into two counters). A 429 from any
bucket has the same body and `retry-after`, and counts `rate_limit_rejected_total{bucket_kind}`
(`user` for the per-user bucket). No bucket is keyed on a client-supplied header. The IP buckets
key on `request.ip`, which trusts exactly `TRUST_PROXY_HOPS` proxies (Q9).

The mobile app names itself in `X-Client` (`magick-agency-mobile/<semver>+<build> (<ios|android>
<osver>; <model>)`; anything else is `web`, `utils/client-header.ts`). An app-wide `onRequest` hook
(`api/middleware/client-log-context.ts`) puts it on every log line the request produces as `client`
(with `clientVersion` / `clientPlatform` for the app), through the ambient log context. It is never
a rate-limit key and never an auth input.

## Data layer

- One Postgres. The schema is the baseline migration, `packages/db/migrations/0001_baseline.sql`
  (node-pg-migrate, one transaction; 33 tables plus default partitions for the two audit tables),
  and the numbered migrations after it (0002: the two telephony-credential tables; 0003: the
  dialer's attempt and contact indexes; 0004: the in-flight contacts index the reaper's
  stranded-contact sweep reads; 0005: the soft phone; 0006: `agency_agent_sessions.client_kind`;
  0007: `agency_ingest_jobs.dedupe_column`; 0008: wrap-up redial, `agency_campaigns.allow_wrapup_redial`
  and the attempt's `redial_of_attempt_id` / `redial_number`; 0009: contact assignment, the
  campaign's assignment and agent-retry settings, the contact's owner and override columns,
  `agency_contact_assignment_events`, and the attempt's `agent_manual` / `override_applied` /
  `override_note`; 0010: validates 0009's contact and attempt CHECKs and builds the assignee
  index, outside 0009's ACCESS EXCLUSIVE),
  all inventoried in `packages/db/BASELINE.md`. Tenant, account and user ids are UUIDs.
- Repositories use raw `pg` (`packages/db/src/repositories/`, plus the agency repository in
  `apps/server/src/db/repositories/`: `agency.repository.ts`, a barrel over `agency/`). Repository
  tests run on real Postgres. Transactions go through `withTransaction`
  (`packages/db/src/utils/transaction.ts`) where adopted: one BEGIN / COMMIT / ROLLBACK / release
  shape, a client whose ROLLBACK failed is destroyed, and `client` joins a caller's transaction.
- Redis holds agent leases, leader leases, station and call tokens, the membership cache and the
  guard counters. It must not evict (see [`operations.md`](operations.md)).

## UIs

- **Console** (`apps/console`). Firebase web sign-in (`VITE_FIREBASE_*`), `AgencyLoginPage` and
  `AgencyJoinPage` (no self sign-up), the agent station, campaigns, roster, activity, DNC, analysis
  profiles, team, accounts and notification settings. Permissions come from `packages/contracts/src/rbac.ts`.
  Brand pack `brands/magick-agency/` (B17); a branding guard test
  (`src/__tests__/branding/noParentBrand.test.ts`). In dev, Vite proxies every API prefix to `:3021`
  (`vite.config.ts`), and `devProxyPrefixes.test.ts` fails for any API segment the proxy misses.
- **Console URLs carry the tenant and account** (decision B26). Signed-in pages live under
  `/t/:tenantId/a/:accountId/…`, so a copied link opens the same tenant and account for whoever
  receives it. `UrlScopeProvider` (`contexts/UrlScopeContext.tsx`) owns the browser history;
  `ScopedRouter` (`components/routing/`) is a `<Router>` over it whose basename is that prefix, so
  routes, links and `navigate()` are written without it and `useLocation()` reads the app path.
  `TenantContext` takes the active tenant and account from the URL; a switch reloads the console
  at the new account's home, so nothing built for the old account carries over. The choice saved in `localStorage` is only the fallback for an unscoped
  URL (an old bookmark, `/` after sign-in). `ScopeGate`, the layout route around every signed-in
  route, scopes an unscoped URL to the active account and refuses a link to a tenant or account the
  viewer cannot open rather than showing another one. Sign-in, invite and email-verification pages
  stay unscoped (`isUnscopedPagePath` in `utils/returnPath.ts`). `/t` and `/a` because `/tenants` and
  `/accounts` are API prefixes in nginx and the Vite proxy. PostHog sees the prefix as
  `/t/:tenant/a/:account` (`analytics/redact.ts`); the ids travel as its `tenant` and `account`
  groups.
- **Super-admin console** (`apps/super-admin`). Tenants (and their accounts), users, admins, phone
  numbers, feature flags, usage and audit; `saFetch` with the JWT in `sessionStorage`; a dev proxy for `/super-admin`. Same
  branding guard.
- **Shared UI** (`packages/web-ui`). The components, toast context, stylesheet and helpers both SPAs
  import by path; it has its own branding guard (`packages/web-ui/test/noParentBrand.test.ts`), as
  the apps' guards scan only their own `src/`.
- **Server branding guard**: `apps/server/test/unit/branding/no-parent-brand.test.ts` scans
  `apps/server/src` and `packages/*/src` with comments stripped.

## Several processes on one host (`MEDIA_WORKERS`, `ANALYSIS_WORKERS`)

Off by default: with neither set, everything above is one process, exactly as described. Design
and every rule: [`scaling.md`](scaling.md). In short (`apps/server/src/cluster/`):

- **The primary** is the process `index.ts` starts. It keeps the HTTP listener, the public API
  layer, the rate limiter, pacing, the reaper and every leader-only sweep, and the guard's
  self-heal. With `MEDIA_WORKERS=N` it forks N media workers after the startup reap, so no
  worker exists while the reap's "every non-terminal row is dead" premise must hold.
- **A media worker** is a dialer-runtime shard. It owns the sessions with
  `slotFor(sessionId) mod N == slot`: their station sockets, live attempts, wrap-up, breaks and
  soft-phone call, and both legs and the audio relay of their calls. No audio frame crosses a
  process boundary.
- **Upgrades** are routed through the primary's Fastify hooks (the rate limiter charges them
  there) and handed to the owner with the socket handle (`ws-handoff.plugin.ts`). The worker
  completes the handshake (`ws-adopt.ts`, `worker-app.ts`). The station socket goes to its
  session's slot; the carrier's stream and status posts go to the slot written into the URLs
  the worker gave the carrier (`&w=<slot>`).
- **Dials** go from pacing to the owner over IPC (`IpcDialDispatcher`, `dial.execute`), with a
  leadership grant the worker checks synchronously.
- **Session-owned internal handlers** (`api/core-owners.ts`) are forwarded by `callCore`'s
  injector to the owning worker; every other handler runs in the primary.
- **IPC** is Node's `child_process` channel, with one decoder per message type
  (`ipc-protocol.ts`) and deadline-bound requests (`ipc-channel.ts`). Redis keeps only its old
  roles.
- **A worker that dies** is reaped by slot before it is re-forked (`cluster/primary.ts`
  `reapSlot`): its call slots are released, its attempts are ended `orphaned` with their
  contacts requeued, and its agents are written offline. More than 5 exits of one slot in
  5 minutes makes the primary exit and the container restart.
- **Analysis children** (`ANALYSIS_WORKERS=K`) run only the slot pool, on the shared
  `SKIP LOCKED` queue, each with its own budget. A vendor rate limit in one is relayed by the
  primary to all of them.

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
- **Load, soak and scenario suites** (`apps/server/test/{unit,integration}/load/`): a full floor
  over real sockets, Postgres and Redis, sized by `LOAD_SCALE` and seeded by `LOAD_SEED`
  (`apps/server/test/helpers/load-scale.ts`). Mocks in `apps/server/test/mocks/`: a scriptable
  VoiceLink carrier (REST with faults, plus a media-WS *client* that dials the server) and a
  simulated agent-console fleet, both Node-native on `ws`. Open defects are pinned as `it.fails`.
- **End to end**: `runtime-e2e.test.ts` (real app, station socket, real bridge, fake carrier,
  through disposition, analysis and completion) and `runtime-boot-order.test.ts`.
- **Contract and guard tests**: route tables enumerated from `onRoute`
  (`apps/server/test/unit/api/*route-table*.test.ts`, the agent-reach tests); config blocks disjoint;
  the bridge seam contract; the VoiceLink carrier fixture; branding guards in all three apps and
  `packages/web-ui`; the
  console dev-proxy test; the error-code unions in `packages/contracts/test/` (including
  `TELEPHONY_CREDENTIAL_ERROR_CODES`, held equal to its union by an exhaustiveness guard).
- **Console** tests run in two Vitest projects (`*.timezone.test.ts(x)` and the rest), with TZ and
  locale pinned in `vite.config.ts`.

## CI

`.github/workflows/ci.yml`, on pull requests and pushes to `main`: job 1 installs `mpg123` and
`sndfile-programs`, then runs `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and
`pnpm build`; the integration job runs as three parallel jobs, each against its own Postgres 16
and Redis 7 service containers mapped to 5436 and 6383: `packages/db`, the server suite, and the
server's wall-clock lane (the files that wait on real timers, listed in
`apps/server/vitest.config.integration.ts` and selected by `INTEGRATION_LANE`). Job 1 also runs
`pnpm test:grafana` and `pnpm test:release`.

`.github/workflows/pr-title.yml` fails a PR whose title is not a Conventional Commit, and
`.github/workflows/release-please.yml` runs release-please on every push to `main`: one release PR
with each component's next version and changelog, and tags plus GitHub Releases once it is merged
(B24; [`operations.md`](operations.md), "Releases and versioning").
