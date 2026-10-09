# Operations

Running and deploying Magick Agency: which configuration matters and what it defaults to, the
properties a deployment must guarantee, how shutdown, migrations, recordings, Postgres TLS and the
proxy count work. Read it before standing up any environment beyond a laptop. For local dev setup
follow the root [`README.md`](../README.md) ("Dev setup"); it is not repeated here. Every default
below was read from `apps/server/src/config/blocks/*.ts` and `apps/server/.env.example` on
2026-10-09. Anything not verified is marked.

## There is no production packaging yet

This repo has no production Dockerfile, compose file or deploy script; `docker/` holds only the
dev Postgres and Redis. The server builds to `apps/server/dist/index.js` (`pnpm build`) and starts
with `pnpm --filter @magick-agency/server start` (`node dist/index.js`); third-party dependencies
are resolved from `apps/server/node_modules` at runtime. The UIs build to static files with Vite.
A production image needs Node 22, ffmpeg, `mpg123` and `sndfile` for clip decoding (the decoder
set is the one CI installs for the decode tests; the exact image is unverified because none exists).

## Configuration

The server reads `apps/server/.env` (dotenv, from the working directory) and exits at boot with
every invalid key listed. Only `DATABASE_URL` and `REDIS_URL` are required to boot outside
production.

### Optional blocks (feature flags)

| Set this | To enable | Notes |
|---|---|---|
| `FIREBASE_PROJECT_ID` + `FIREBASE_SERVICE_ACCOUNT_KEY` or `FIREBASE_SERVICE_ACCOUNT_PATH` | Console sign-in | **Required in production** (boot refuses). `FIREBASE_AUTH_EMULATOR_HOST` also read |
| `SUPER_ADMIN_JWT_SECRET` (16+ chars) | `/super-admin/*` API | Absent: routes not registered |
| `MAILJET_API_KEY`, `MAILJET_API_SECRET` | Invite and completion mail | `MAILJET_FROM_EMAIL` default `noreply@sapionic.ai`, `MAILJET_FROM_NAME` default `Sapionic` |
| `CONSOLE_BASE_URL` | Invite links | e.g. `https://<console host>` |
| `TELEPHONY_ENABLED_PROVIDERS=voicelink` + `VOICELINK_BASE_URL`, `_USERNAME`, `_PASSWORD`, `_WEBHOOK_BASE_URL`, `_DEFAULT_CALLER_ID` | Real calls | Required whenever VoiceLink is enabled **or** `NODE_ENV=production`. `VOICELINK_DEFAULT_COUNTRY_CODE` default `91` |
| `S3_AUDIO_BUCKET` + `AWS_REGION` (default `ap-south-1`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Abandon clips, CSV uploads | |
| `DIALER_ANALYSIS_ENABLED=true` + a transcriber key (`DIALER_TRANSCRIBE_API_KEY` / `GEMINI_API_KEY`, or Sarvam) + an LLM key (`POST_CALL_ANALYSIS_API_KEY` / `OPENAI_API_KEY`, or Azure) | Post-call analysis worker | `DIALER_TRANSCRIBER` default `gemini`, model `gemini-3.5-flash`; worker every 60 s, concurrency 2; `POST_CALL_ANALYSIS_PROVIDER` default `openai`, model `gpt-4o-mini` |
| `RECORDING_URL_SIGNING_SECRET` (16+ chars) | Stable signed playback URLs | Unset: a random per-process key, so signed URLs break on restart |
| `POSTHOG_ENABLED=true` + `POSTHOG_API_KEY` | Product analytics | Host default `https://us.i.posthog.com` |
| `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` | Logs over OTLP | Metrics and traces are not exported at all (see [`status.md`](status.md)) |
| `AGENCY_ROSTER_REPLACE_ENABLED=true` | Roster replace / clear | Leave off: every replace fails until a supersede exists (B15) |

### Key settings and defaults

| Variable | Default | What it does |
|---|---|---|
| `PORT`, `HOST` | `3021`, `0.0.0.0` | Listen address. See the proxy invariant before leaving `0.0.0.0` |
| `NODE_ENV` | `development` | `production` turns on Postgres TLS and makes Firebase and VoiceLink mandatory |
| `TRUST_PROXY_HOPS` | `1` (min 1) | Number of reverse proxies in front (Q9) |
| `DB_POOL_MIN`, `DB_POOL_MAX` | `2`, `10` | pg pool |
| `DB_SSL_CA` | unset (Node's roots) | PEM text of a private CA, not a path; `\n` escapes allowed |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | Only `true` / `false` parse; `false` is the one opt-out |
| `REDIS_KEY_PREFIX` | empty | Prefix on every Redis key |
| `MAX_CONCURRENT_CALLS` | `200` | Global guard ceiling (per-account limits come from super-admin settings, default 5) |
| `CALL_TIMEOUT_SECONDS` | `300` | Guard lease timeout |
| `CONCURRENCY_RECONCILE_INTERVAL_MS` | `300000` | Self-heal reconcile cadence |
| `STALE_CALL_SWEEP_MINUTES` | `30` | Stale bridged-call sweep |
| `RATE_LIMIT_MAX`, `_WEBHOOK_MAX`, `_CARRIER_MEDIA_MAX`, `_INTERNAL_MAX`, `RATE_LIMIT_WINDOW` | 200, 1000, 600, 1000, `1 minute` | Rate-limit buckets |
| `VOICELINK_RECORDING_HOSTS` | `recording.app.voicelink.co.in` | Recording fetch allow-list |
| `AGENCY_TRANSCRIPT_RETENTION_DAYS` | `30` (falls back to `DIALER_TRANSCRIPT_RETENTION_DAYS`) | Transcripts nulled after this |
| `AGENCY_RETENTION_DAYS` | unset | Call and analysis rows deleted after this; unset = kept. Must be ≥ `RETENTION_MIN_DAYS` (30) |
| `RETENTION_PURGE_INTERVAL_MS` | 1 day | Purge cadence (also runs 60 s after boot) |
| `AUDIT_RETENTION_DAYS` | `85` (min 30) | Audit partitions older than this are dropped |
| `AUDIT_PARTITION_MAINTENANCE_ENABLED` | `true` | Creates partitions 3 months ahead and drops old ones, daily |
| `INVITE_TOKEN_TTL_DAYS` | `7` (1–90) | Invite expiry |
| `PLATFORM_BRAND_NAME`, `_ACCENT`, `_LOGO_URL` | `Magick Agency`, `#7c5cfc`, unset | Brand in mail (B17) |
| `LOCAL_CACHE_ENABLED` | `false` | In-process cache layer over Redis (5 s TTL) |
| `LOG_LEVEL` | `info` | |

`apps/server/.env.example` carries the reasoning for the proxy, TLS, recording-host, retention and
Redis settings.

## Deployment invariants

1. **Redis keeps keys for their TTL.** Turn persistence on (AOF or RDB) and set
   `maxmemory-policy noeviction` (or a `volatile-*` policy with nothing else competing). Station
   tokens, agent and leader leases, and the bridge's call tokens live there. Since Q6, a call token
   that is missing while Redis answers is **refused**, so an evicted key or a non-persistent restart
   cuts a live call's carrier leg and status webhooks; each refusal logs
   `WebRTC WS token missing while Redis answered`. If Redis is down altogether, tokens are accepted
   (a live call is never hard-failed for a Redis outage).
2. **One replica.** The bridge remembers tokens whose Redis `SET` failed in-process; the
   runtime, reaper, retention and partition jobs assume one process. Scaling out needs that memo
   shared or dropped, and a review of every sweep.
3. **Reachable only through exactly `TRUST_PROXY_HOPS` proxies.** `request.ip` trusts that many
   `X-Forwarded-For` entries from the right and keys every IP rate-limit bucket. If the port is
   reachable directly, a client can set its own IP and evade the limits; if the real chain has a
   different number of proxies, set the count to match. Bind to loopback or a private interface,
   or firewall port 3021. (Fastify 5.12 fails a numeric `trustProxy` closed, so the count is passed as a hop-count
   function.)
4. **TLS on only in production.** See "Postgres TLS" below.
5. **Migrations before start.** See below.

## Shutdown and grace period

On SIGTERM or SIGINT the server closes HTTP first, then stops analysis, agency (pacing first;
in-flight campaign-completion mails get up to 30 s), voice (the bridge hangs up live calls and
releases their slots) and platform (audit buffers flushed), then closes Redis and Postgres
(`apps/server/src/index.ts`). Docker's default stop grace is 10 s, which would cut the 30 s drain.
Recommendation pending Manas: `stop_grace_period: 45s` in the production compose file. Open
question: a pacing tick already parked past its `stopped` check can still finish after the drain;
awaiting in-flight ticks in `stop()` would close it.

Agents are not returned to the pool on shutdown; after a restart they come back in `break` and must
choose to go available.

## Migrations

One migration, `packages/db/migrations/0001_baseline.sql`, run with node-pg-migrate from
`packages/db`:

```bash
DATABASE_URL=postgresql://... pnpm migrate:up
```

It does not read the server's `.env`. Nothing in this repo runs it automatically on deploy. Future
schema changes go in new numbered files; never edit or renumber an applied migration.

## Recordings

VoiceLink recordings are public MP3s on the carrier's host. The fetcher accepts only `https` URLs
whose parsed hostname is on `VOICELINK_RECORDING_HOSTS` (exact or subdomain), checked on every
redirect hop. Unset means `recording.app.voicelink.co.in`; a list replaces it; an explicitly empty
value refuses every fetch and playback. Playback goes through `/api/v1/webrtc-recordings/:id` with
an HMAC-signed query (`RECORDING_URL_SIGNING_SECRET`).

## Postgres TLS

TLS is on only when `NODE_ENV=production`. Then the server certificate is verified
(`rejectUnauthorized: true`) against Node's roots, or against `DB_SSL_CA` (the CA's PEM text) for a
private CA. `DB_SSL_REJECT_UNAUTHORIZED=false` is the only way to turn verification off. TLS
parameters inside `DATABASE_URL` (`ssl`, `sslmode`, `sslrootcert`, `sslcert`, `sslkey`,
`sslnegotiation`, any case) are refused at boot, because pg would let them override these settings.

## First super-admin

No admin is seeded. Create the first with `apps/server/scripts/create-super-admin.ts` (see the
README); later admins are created in the super-admin UI.

## Health

`GET /healthz` answers 200 while the process is up. `GET /readyz` answers 200 only when Postgres
(`SELECT 1`) and Redis (`PING`) respond, else 503. Both are exempt from rate limiting.
