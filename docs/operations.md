# Operations

Running and deploying Magick Agency: which configuration matters and what it defaults to, the
properties a deployment must guarantee, how shutdown, migrations, recordings, Postgres TLS and the
proxy count work. Read it before standing up any environment beyond a laptop. For local dev setup
follow the root [`README.md`](../README.md) ("Dev setup"); it is not repeated here. Every default
below was read from `apps/server/src/config/blocks/*.ts` and `apps/server/.env.example` on
2026-10-09. Anything not verified is marked.

## Production packaging

Everything is in `docker/`, built from the repo root:

| File | What it is |
|---|---|
| `docker/Dockerfile` | The server image: Node 22 (`node:22-slim`), the esbuild bundle plus the server's production `node_modules` (`pnpm deploy --prod`), `mpg123` and `sndfile-programs` for clip decoding, the migrations in `/app/migrations`. Runs as `node`, `NODE_ENV=production`, port 3021 |
| `docker/entrypoint.sh` | Runs the migrations (`node dist/migrate.js migrations`), then `exec node … dist/index.js`. A failed migration stops the container |
| `docker/web.Dockerfile`, `docker/nginx.conf` | nginx with both UIs: the console on :8080 and the super-admin on :8081. It is also the server's reverse proxy |
| `docker/docker-compose.prod.yml` | `server`, `web` and `redis`, as compose project `magick-agency-prod`. No Postgres (see "Postgres TLS") |
| `docker/.env.example` | The settings to fill in, copied to `docker/.env` (git-ignored) |

```bash
cp docker/.env.example docker/.env      # fill it in
docker compose -f docker/docker-compose.prod.yml up -d --build
```

Compose reads `docker/.env` twice, both automatically. It loads it from the compose file's
directory to fill the `${...}` values (the console build args and the published ports), and
`env_file` passes it to the server as its environment. The compose file sets
`NODE_ENV=production`, `PORT` and `REDIS_URL` itself. Compose parses the file, so put any value
that may contain `$` or ` #` (passwords, secrets, `DATABASE_URL`) in single quotes. Unquoted,
`pa$word` silently becomes `pa`.

The project name differs from the dev stack's (`magick-agency`) on purpose. If they matched,
`pnpm infra:up` or `infra:reset` on the same host would recreate or remove the production Redis
with the dev settings.

**No ffmpeg.** The decoder spawns only `mpg123` (mp3) and `sndfile-convert` (wav/ogg)
(`apps/server/src/audio/decode.ts`), and upload rejects AAC/M4A, the one format that would need
ffmpeg. ffmpeg would add about 395 MB to the image for a format the server does not accept, so the
image leaves it out. `apps/server/test/unit/audio/decoder-toolchain-packaging.test.ts` asserts the
decoder packages and the absence of ffmpeg.

### What nginx serves

The two UIs can't share an origin, because both own `/` and call the API on their own origin
(`VITE_API_BASE_URL` empty). So each one gets its own server block:

- **:8080, console and carrier.** The SPA, plus a proxy for the console's API prefixes (the dev
  proxy's `API_PREFIXES`) and `/api/*`. `/api/*` is VoiceLink's surface: status webhooks, the PSTN
  media WebSocket and recording playback. That makes `VOICELINK_WEBHOOK_BASE_URL` and
  `CONSOLE_BASE_URL` this block's public https origin. `/healthz` and `/readyz` are proxied for
  the TLS terminator's health check.
  WebSocket upgrades pass through with a 1 h read timeout (station socket, media socket).
  Request bodies up to 513 MB are streamed, not buffered, for the 512 MiB roster CSV.
- **:8081, super-admin.** The SPA plus `/super-admin/`. The compose file publishes it on
  `127.0.0.1` only, so reach it over SSH or a VPN (`SUPER_ADMIN_BIND` to change).

**Proxy hops.** nginx serves plain HTTP, so a TLS terminator in front of :8080 is mandatory: a
load balancer, or a host nginx or Caddy. Browsers need a secure origin for the station, and
VoiceLink needs an https/wss base. That gives a fixed chain of client, TLS terminator, nginx,
server, so `TRUST_PROXY_HOPS=2` (the value in `docker/.env.example`). Both directions of getting
this wrong are silent:

- **Set to 1 behind a terminator:** every client resolves to the terminator's address and shares
  one 200/min bucket.
- **:8080 reachable without going through the terminator:** a client chooses its own
  `request.ip` by sending `X-Forwarded-For`.

So the compose file publishes :8080 on `127.0.0.1` (`CONSOLE_BIND`) for a terminator on the same
host. If the terminator runs on another machine, bind a private interface and firewall the port
to that machine.

The :8081 block **overwrites** `X-Forwarded-For` with the address it saw instead of appending to
it, because it is reached directly over SSH or a VPN. A client-sent header therefore never
reaches the server, and `POST /super-admin/login`'s 5/min limit holds for any hop count.

`apps/server/test/unit/deploy/production-packaging.test.ts` checks four things:

- every server route prefix is proxied from the right block (a missing prefix would get the
  console's `index.html` from nginx);
- the two header policies above;
- the loopback binds;
- the hop count in the example.

nginx re-resolves `server` through Docker's DNS while it runs (`resolver 127.0.0.11`,
`server … resolve`, nginx 1.27.3 or later), so a recreated server container is followed without
restarting `web`.

### Smoke-testing the image locally

Production mode needs a Postgres with TLS and a certificate the server can verify. A throwaway CA
covers that:

```bash
mkdir -p /tmp/pgtls && cd /tmp/pgtls
openssl req -x509 -new -nodes -newkey rsa:2048 -keyout ca.key -out ca.crt -days 2 -subj /CN=smoke-ca
openssl req -new -nodes -newkey rsa:2048 -keyout server.key -out server.csr -subj /CN=pg
printf 'subjectAltName=DNS:pg\n' > ext.cnf
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile ext.cnf
chmod 600 server.key && sudo chown 70:70 server.key server.crt    # postgres:16-alpine's uid
```

Next, add a `pg` service to a compose override: `postgres:16-alpine` with
`-c ssl=on -c ssl_cert_file=… -c ssl_key_file=…` and the two files mounted. Make `server` depend
on it. Then set `DATABASE_URL=postgresql://…@pg:5432/…`, `DB_SSL_CA` to `ca.crt`'s text with `\n`
escapes, and placeholder Firebase and VoiceLink values, all in `docker/.env`. Run `up` with both
files. The first boot
logs `MIGRATION 0001_baseline (UP)`, then `migrations complete`, then `magick-agency listening`.
Later boots log `No migrations to run!`. The server's Postgres sessions show `ssl = t` in
`pg_stat_ssl`. Without `DB_SSL_CA`, the migration step fails with
`unable to verify the first certificate` and the container exits.

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
| `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_SERVICE_NAME` | Traces, metrics and logs over OTLP (http/protobuf) | All three or nothing starts (the server warns when only the name is missing). `OTEL_SERVICE_NAME`: `magick-agency` = production, `magick-agency-Staging`, `magick-agency-Dedicated`; anything else (e.g. `agency-dev-<you>`) is not alerted on. Grafana Cloud also needs `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64 id:token>`. `OTEL_METRICS_EXPORT_INTERVAL_MS` default 60000. Alert rules and dashboard: `grafana/README.md` |
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
   or firewall port 3021. The production compose file publishes no server port. Its chain is the
   TLS terminator plus nginx, so `TRUST_PROXY_HOPS=2` (see "What nginx serves"). (Fastify 5.12
   fails a numeric `trustProxy` closed, so the count is passed as a hop-count function.)
4. **TLS on only in production.** See "Postgres TLS" below.
5. **Migrations before start.** The image does this on every start; see below.
6. **Stop grace at least 45 s.** See "Shutdown and grace period".

## Shutdown and grace period

On SIGTERM or SIGINT the server closes HTTP first, then stops analysis, agency (pacing first;
in-flight campaign-completion mails get up to 30 s), voice (the bridge hangs up live calls and
releases their slots) and platform (audit buffers flushed), then closes Redis and Postgres
(`apps/server/src/index.ts`). Docker's default stop grace is 10 s, which would cut the 30 s drain,
so the production compose file sets `stop_grace_period: 45s` on the server. On any other runtime,
give the container at least 45 s. `http closed` is logged once the HTTP close has succeeded, so
the order can be read from the logs. Read it from each line's `time` field rather than the line
order, because stdout flushed at exit can interleave a few lines:

```
shutting down
http closed
Agency dialer runtime stopped
Shutting down audit logger, flushing buffer... / Audit logger shut down
Database pool closed
```

Measured on the image with no calls in flight: `docker compose stop` took 0.7 s, the server exited
0, and the sequence above took 7 ms. A drain that has mail to send can take up to 30 s. Open
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

It does not read the server's `.env`. In the image, `docker/entrypoint.sh` runs the migrations on
every start, before the server, through `dist/migrate.js` (`apps/server/src/migrate.ts`). That is
node-pg-migrate's runner with the server's own config and Postgres TLS settings (the CLI cannot
verify TLS, because Q1 keeps TLS parameters out of `DATABASE_URL`). An invalid environment or a
failed migration stops the container before the server starts. Same table (`pgmigrations`) as
`pnpm migrate:up`. Future
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

No admin is seeded. Create the first with `apps/server/scripts/create-super-admin.ts`, which the
image also carries as `dist/create-super-admin.js`. Later admins are created in the super-admin UI.

```bash
docker compose -f docker/docker-compose.prod.yml exec -e SUPER_ADMIN_PASSWORD='…' server \
  node dist/create-super-admin.js --email ops@example.com --name "Ops"
```

It reads only the base settings (`DATABASE_URL`, `NODE_ENV`, `DB_SSL_CA`,
`DB_SSL_REJECT_UNAUTHORIZED`) and connects with the server's TLS decision. From a checkout, run
`pnpm tsx scripts/create-super-admin.ts` with those set (see the README).

## Health

`GET /healthz` answers 200 while the process is up. `GET /readyz` answers 200 only when Postgres
(`SELECT 1`) and Redis (`PING`) respond, else 503. Both are exempt from rate limiting.
