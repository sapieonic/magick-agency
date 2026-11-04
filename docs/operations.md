# Operations

Running and deploying Magick Agency: which configuration matters and what it defaults to, the
properties a deployment must guarantee, how shutdown, migrations, recordings, Postgres TLS and the
proxy count work, and how each component is versioned and released. Read it before standing up any environment beyond a laptop. For local dev setup
follow the root [`README.md`](../README.md) ("Dev setup"); it is not repeated here. Every default
below was read from `apps/server/src/config/blocks/*.ts` and `apps/server/.env.example` on
2026-10-09. Anything not verified is marked.

## Production packaging

Everything is in `docker/`, built from the repo root:

| File | What it is |
|---|---|
| `docker/Dockerfile` | The server image: Node 22 (`node:22-slim`), the esbuild bundle plus the server's production `node_modules` (`pnpm deploy --prod`), `mpg123` and `sndfile-programs` for clip decoding, the migrations in `/app/migrations`. Runs as `node`, `NODE_ENV=production`, port 3021 |
| `docker/entrypoint.sh` | Runs the migrations (`node dist/migrate.js migrations`), then `exec node … dist/index.js`. A failed migration stops the container |
| `docker/web.Dockerfile`, `docker/nginx.conf` | nginx with both UIs: the console on :8080 and the super-admin on :8081. It is also the server's reverse proxy. The build copies the two apps and the source packages they import (`packages/contracts`, `packages/web-ui`) |
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
(`VITE_API_BASE_URL` empty; the console's can point at a separate API host instead, B25 and
"API on its own host" below). So each one gets its own server block:

- **:8080, console and carrier.** The SPA, plus a proxy for the console's API prefixes (the dev
  proxy's `API_PREFIXES`) and `/api/*`. `/api/*` is VoiceLink's surface: status webhooks, the PSTN
  media WebSocket and recording playback. That makes `CONSOLE_BASE_URL` this block's public https
  origin, and `VOICELINK_WEBHOOK_BASE_URL` that origin plus `/api/v1/webhooks/voicelink` (a bare
  origin makes every status webhook 404). `/healthz` and `/readyz` are proxied for
  the TLS terminator's health check, and `/client-config` is proxied with the API prefixes: `GET
  /client-config` (public, the mobile app's version gate) and `POST /client-config/uplink-probe`
  (the app's pre-flight upload-speed check: a Firebase bearer required, checked before the body is
  read; `application/octet-stream` up to 65536 bytes, else 413 / 415; 6 per user per rate-limit
  window, else 429; answers `{ "received_bytes": n }` and touches neither Postgres nor Redis beyond
  its rate-limit counters. The app times a 32 KB upload and blocks "Go on duty" below 64 kbps).
  WebSocket upgrades pass through with a 1 h read timeout (station socket, media socket).
  Request bodies up to 513 MB are streamed, not buffered, for the 512 MiB roster CSV.
  `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` are served by nginx
  itself (see "Mobile app links").
- **:8081, super-admin.** The SPA plus `/super-admin/`. The compose file publishes it on
  `127.0.0.1` only, so reach it over an SSH or Session Manager tunnel or a VPN
  (`SUPER_ADMIN_BIND` to change), or publish it through the host's TLS terminator on its own
  domain (`DEPLOYMENT.md` section 8.4; the bind stays loopback).

### Mobile app links

The agent invite link (`/agency/join/<token>`) opens the mobile app when it is installed:
Universal Links on iOS, App Links on Android. Both platforms fetch a file from this origin:

| File | Written when | From |
|---|---|---|
| `/.well-known/apple-app-site-association` | `MOBILE_IOS_APP_IDS` is set | `TEAMID.bundle.id`, comma-separated; `applinks` covers ONLY `/agency/join/*` |
| `/.well-known/assetlinks.json` | `MOBILE_ANDROID_CERT_SHA256` is set | `MOBILE_ANDROID_PACKAGE` (default `com.magickagency.agent`) and the SHA-256 fingerprints, comma-separated |

`docker/mobile-app-links.sh` writes them at every start of the web container (the nginx image runs
`/docker-entrypoint.d/*.sh` before nginx), from the web container's environment (the compose file
passes the three variables from `docker/.env`). nginx serves each as `application/json` from an exact
`location`, with no redirect (both platforms refuse one) and no SPA fallback. A file whose variable
is unset or empty, or holds a value that does not validate (a team ID that is not 10 characters, a
fingerprint that is not 32 bytes of hex), is not written, and a stale one is removed, so the path
answers 404 instead of a bad file; the script logs why to the container log and never stops nginx
from starting. Android cannot narrow a domain to a path in `assetlinks.json`: the app's manifest
intent filter names `/agency/join/` itself.

The Android fingerprint is the **Play App Signing** certificate's (Play Console, App integrity), not
the upload key's: Play re-signs the app. Add the upload or a debug key's fingerprint beside it only
for builds installed outside Play. Check after deploying:

```bash
curl -si https://agency.example.com/.well-known/apple-app-site-association   # 200, application/json
curl -si https://agency.example.com/.well-known/assetlinks.json
```

Changing a value needs a restart of `web`, not a rebuild. iOS caches the association through Apple's
CDN, so a change reaches installed apps within a day or so.

**Proxy hops.** nginx serves plain HTTP, so a TLS terminator in front of :8080 is mandatory: a
load balancer, or a host nginx or Caddy. Browsers need a secure origin for the station, and
VoiceLink needs an https/wss base. That gives a fixed chain of client, TLS terminator, nginx,
server, so `TRUST_PROXY_HOPS=2` (the value in `docker/.env.example`). Both directions of getting
this wrong are silent:

- **Set to 1 behind a terminator:** every client resolves to the terminator's address and shares
  one `ip_auth` bucket and one unauthenticated `ip` bucket (the per-user bucket still holds).
- **:8080 reachable without going through the terminator:** a client chooses its own
  `request.ip` by sending `X-Forwarded-For`.

**API on its own host (B25).** The terminator may send a second name (`api.example.com`) to
the same :8080 block. The console, built with `CONSOLE_API_BASE_URL`, then calls that name
cross-origin and the server answers CORS for the origins in `CORS_ALLOWED_ORIGINS`. The chain and
the hop count are unchanged. The super-admin keeps calling its own origin: :8081 is the only block
that proxies `/super-admin`.

So the compose file publishes :8080 on `127.0.0.1` (`CONSOLE_BIND`) for a terminator on the same
host. If the terminator runs on another machine, bind a private interface and firewall the port
to that machine.

The :8081 block **overwrites** `X-Forwarded-For` with the address it saw instead of appending to
it, because it is reached directly over SSH or a VPN. A client-sent header therefore never
reaches the server, and `POST /super-admin/login`'s 5/min limit holds for any hop count. Published
through a terminator, the address it sees is the terminator's: the limit is then one bucket shared
by every admin (and by anyone hammering the login page), and recorded super-admin IPs are the
terminator's. That is the accepted cost of a super-admin domain; an IP allow-list at the
terminator keeps strangers out of the bucket.

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
logs `MIGRATION 0001_baseline (UP)`, then `migrations complete`, then `magick-agency v<version> listening`.
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
| `FIREBASE_PROJECT_ID` | Console sign-in. No service account: ID tokens are verified against Google's public keys | **Required in production** (boot refuses). `FIREBASE_AUTH_EMULATOR_HOST` also read |
| `SUPER_ADMIN_JWT_SECRET` (16+ chars) | `/super-admin/*` API | Absent: routes not registered |
| `MAILJET_API_KEY`, `MAILJET_API_SECRET` | Invite and completion mail | `MAILJET_FROM_EMAIL` default `noreply@sapionic.ai`, `MAILJET_FROM_NAME` default `Sapionic` |
| `CONSOLE_BASE_URL` | Invite links | e.g. `https://<console host>` |
| `TELEPHONY_ENABLED_PROVIDERS=voicelink` + `VOICELINK_BASE_URL`, `_USERNAME`, `_PASSWORD`, `_WEBHOOK_BASE_URL` | Real calls | Required whenever VoiceLink is enabled **or** `NODE_ENV=production`. Caller IDs are per campaign (`caller_ids`), not env. `VOICELINK_DEFAULT_COUNTRY_CODE` default `91` |
| `TELEPHONY_CREDENTIAL_KEYS` + `TELEPHONY_CREDENTIAL_ACTIVE_KEY` | Tenant carrier credentials (BYOC, B19) | Master keyring that seals the credentials super-admins add (`v1:<base64 32 bytes>,…`). Unset, or no entries after trim (blank, spaces or commas only) = adding one is refused and BYOC calls fail closed. Rotate by adding a new id and making it active; keep old ids listed while secrets are sealed under them (boot logs an ERROR naming a missing one). Back it up separately from the database: losing it makes every stored credential unopenable |
| `S3_AUDIO_BUCKET` + `AWS_REGION` (default `ap-south-1`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Abandon clips, CSV uploads | Unset: every upload fails ("S3 client not initialized"). Bucket and IAM user per environment: `aws/README.md` |
| `DIALER_ANALYSIS_ENABLED=true` + a transcriber key (`DIALER_TRANSCRIBE_API_KEY` / `GEMINI_API_KEY`, or Sarvam) + an LLM key (`POST_CALL_ANALYSIS_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`, or Azure's) | Post-call analysis worker | `DIALER_TRANSCRIBER` default `gemini`, model `gemini-3.5-flash`; 8 analysis slots (`DIALER_ANALYSIS_CONCURRENCY`; sizing below), a 512 MiB recording memory budget, a sweep every 60 s. `POST_CALL_ANALYSIS_PROVIDER`: `openai_compatible` (default; `openai` also accepted; any Chat Completions endpoint via `POST_CALL_ANALYSIS_BASE_URL`, `_HEADERS`, `_STRUCTURED_OUTPUT`), `azure_openai` or `gemini`; model default `gpt-4o-mini`; `POST_CALL_ANALYSIS_TEMPERATURE` default 0.3, `none` sends none. `POST_CALL_ANALYSIS_INPUT`: `transcript` (default) or `audio` (the recording is sent with the transcript; `gemini` only, refused at boot otherwise; timeout default 180 s instead of 30 s). Per tenant it also needs the `agency_call_analysis` flag (default off; `FF_AGENCY_CALL_ANALYSIS` sets the default). Every key: `apps/server/.env.example` |
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
| `WS_MAX_PAYLOAD_BYTES` | `65536` (min 42708) | Largest inbound WebSocket message on every route; past it the socket closes 1009. Sized in `apps/server/src/utils/ws-limits.ts` |
| `CORS_ALLOWED_ORIGINS` | unset (no CORS) | Origins allowed to call the API cross-origin, comma separated, bare origins only (`*` refused). Only for the API on its own host (`DEPLOYMENT.md` 7.3, decision B25); the web image is then built with `CONSOLE_API_BASE_URL` |
| `READYZ_DETAIL_TOKEN` | unset (detail off) | Bearer for `GET /readyz?detail=1` ("Health"); at least 32 characters. Plain `/readyz` needs nothing (D13) |
| `DB_POOL_MIN`, `DB_POOL_MAX` | `2`, `30` | pg pool of the server process (the primary, with workers), one for every area. 30 for a 500-agent floor. **Per process**: worker processes open their own pools (`MEDIA_WORKER_DB_POOL_MAX` below; an analysis worker `min(DB_POOL_MAX, DIALER_ANALYSIS_CONCURRENCY + 2)`), and the sum must fit Postgres's `max_connections` with room for migrations and an operator ("Sizing the media workers", *Postgres connections*). Saturation: `db_pool_clients_waiting`, `db_pool_acquire_seconds` |
| `DB_SSL_CA` | unset (Node's roots) | PEM text of a private CA, not a path; `\n` escapes allowed |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | Only `true` / `false` parse; `false` is the one opt-out |
| `REDIS_KEY_PREFIX` | empty | Prefix on every Redis key, and on the cache-invalidation pub/sub channel (`<prefix>cache:invalidate:db<N>`, N the URL's Redis db). Pub/sub is server-wide, not per db, so two deployments on one Redis are separated by a different prefix or a different db |
| `REDIS_COMMAND_TIMEOUT_MS`, `REDIS_MAX_RETRIES_PER_REQUEST`, `REDIS_CONNECT_TIMEOUT_MS` | `2000`, `1`, `2000` | Redis client bounds: a Redis that is gone or stalled fails each command within the timeout (a rejection, so call tokens fail open per Q6, and the agent lease renewer keeps renewing through it). ioredis's defaults took ~10 s to show on `/readyz` and held some requests ~30 s |
| `MAX_CONCURRENT_CALLS` | `1000` | Global guard ceiling: call legs holding a slot, ringing and `ending` included (a 500-call floor holds ~860 at peak; sizing in `config/blocks/voice.ts`). Per-account limits come from super-admin settings, default 5 |
| `VOICELINK_LOGIN_TIMEOUT_MS`, `VOICELINK_ADD_LEAD_TIMEOUT_MS` | `10000`, `15000` | VoiceLink REST timeouts, per request (a 401's retry gets a fresh one; the `add_lead` value also bounds a CDR lookup). A timed-out `add_lead` fails the dial (agent and slots released at once) but may have queued the lead: never retried, the contact's redial deferred 15 min, a late carrier media connect refused and hung up (`voicelink.adapter.ts`, `post`) |
| `CALL_TIMEOUT_SECONDS` | `300` | Guard lease timeout |
| `CONCURRENCY_RECONCILE_INTERVAL_MS` | `300000` | Self-heal reconcile cadence |
| `STALE_CALL_SWEEP_MINUTES` | `30` | Stale bridged-call sweep |
| `RATE_LIMIT_MAX`, `_WEBHOOK_MAX`, `_CARRIER_MEDIA_MAX`, `_STATION_MAX`, `_INTERNAL_MAX`, `RATE_LIMIT_WINDOW` | 2000, 5000, 2000, 3600, 1000, `1 minute` | Rate-limit buckets (`architecture.md`, "Rate limiting and client IP"), sized for ~550 users behind one NAT and ~510 dials a minute (`apps/server/src/api/middleware/rate-limit-defaults.ts`) |
| `RATE_LIMIT_IP_AUTH_MAX` | 20000 | Per-IP bucket for requests carrying a bearer: a call floor behind one NAT (Q9, amended 2026-11-01), the whole signed-in floor's traffic |
| `RATE_LIMIT_USER_MAX` | 600 | Per verified user, charged by the session middleware; the bucket that binds signed-in traffic |
| `MOBILE_MIN_SUPPORTED_VERSION`, `MOBILE_LATEST_VERSION` | `0.1.0`, `0.1.0` | `GET /client-config`; `MAJOR.MINOR.PATCH`, and the minimum may not be newer than the latest (boot refuses) |
| `MOBILE_IOS_STORE_URL`, `MOBILE_ANDROID_STORE_URL` | unset | Store links on `GET /client-config`; https only |
| `VOICELINK_RECORDING_HOSTS` | `recording.app.voicelink.co.in` | Recording fetch allow-list |
| `DIALER_ANALYSIS_CONCURRENCY` | `8` (1-256) | Analysis jobs in flight in this process; see "Sizing the analysis worker" |
| `DIALER_ANALYSIS_MEMORY_BUDGET_BYTES` | `536870912` (512 MiB) | Recording bytes the analysis slots may hold; at least 2 × `DIALER_MAX_RECORDING_BYTES` |
| `MEDIA_WORKERS` | `0` (0-64) | Media worker processes ([`scaling.md`](scaling.md)). 0 = one process, as before. N = a primary plus N workers that hold the agents' sockets and relay the audio. On 2 vCPUs more than 1 buys little; 500 calls needs more cores whatever the layout (§8.1) |
| `MEDIA_WORKER_HEAP_MB` | `768` | Each media worker's `--max-old-space-size` (the primary keeps the entrypoint's) |
| `WORKER_CRASH_LOOP_MAX` | `5` | More exits of one media worker in 5 minutes makes the primary exit and the container restart (D4) |
| `MEDIA_WORKER_DB_POOL_MAX` | `10` | Each media worker's own pg pool (a worker writes only its own calls' rows; pacing, the sweeps and the API stay on the primary's `DB_POOL_MAX`) |
| `ANALYSIS_WORKERS` | `0` (0-32) | Separate analysis processes, each with its own slots and budget; 0 keeps the slots in the server process. See "Sizing the analysis worker" |
| `AGENCY_TRANSCRIPT_RETENTION_DAYS` | `30` (falls back to `DIALER_TRANSCRIPT_RETENTION_DAYS`) | Transcripts nulled after this |
| `AGENCY_RETENTION_DAYS` | unset | Call and analysis rows deleted after this; unset = kept. Must be ≥ `RETENTION_MIN_DAYS` (30) |
| `RETENTION_PURGE_INTERVAL_MS` | 1 day | Purge cadence (also runs 60 s after boot) |
| `AUDIT_RETENTION_DAYS` | `85` (min 30) | Audit partitions older than this are dropped |
| `AUDIT_PARTITION_MAINTENANCE_ENABLED` | `true` | Creates partitions 3 months ahead and drops old ones, daily |
| `INVITE_TOKEN_TTL_DAYS` | `7` (1–90) | Invite expiry |
| `PLATFORM_BRAND_NAME`, `_ACCENT`, `_LOGO_URL` | `Magick Agency`, `#7c5cfc`, unset | Brand in mail (B17) |
| `LOCAL_CACHE_ENABLED` | `false` | In-process cache layer over Redis (5 s TTL), kept honest by invalidations on `<REDIS_KEY_PREFIX>cache:invalidate:db<N>`. A release that changed the channel's name (the `:db<N>` suffix arrived in one) does not carry invalidations between an old and a new process while both run; each process's own copies still drop, and the others' within the local TTL |
| `LOG_LEVEL` | `info` | |

`apps/server/.env.example` carries the reasoning for the proxy, TLS, recording-host, retention and
Redis settings.

### Sizing the analysis worker

The analysis worker keeps up to `DIALER_ANALYSIS_CONCURRENCY` jobs in flight in this process
and starts the next one the moment a slot frees, so its throughput is slots ÷ minutes per job.
Size it as:

**slots ≈ calls ending per minute × minutes per job**, then cap it by the vendors' rate limits.

- *Calls ending per minute*: only analysed calls count (the `agency_call_analysis` flag on, talk
  time ≥ `DIALER_ANALYSIS_MIN_TALK_TIME_SECONDS`). A floor of N agents on ~3-minute calls ends
  about N ÷ 3 calls a minute; 500 simultaneous calls end ~167 a minute.
- *Minutes per job*: the `dialer_analysis_duration_seconds` stages added up (fetch + transcribe +
  analyze; the *Dialer Analysis Latency* panel). Measure it; the default below assumes 2 minutes.
  Audio input adds a second upload.
- *Vendor limits*: each slot makes about one transcription request per 10 minutes of audio
  (`DIALER_TRANSCRIBE_WINDOW_SECONDS`) and one analysis request (two uploads with audio input).
  Keep slots × requests per job ÷ minutes per job under the key's requests-per-minute quota, with
  headroom for retries. Use a dedicated `DIALER_TRANSCRIBE_API_KEY`.
- *Postgres*: a slot holds a pool connection only for a claim, a heartbeat or the final
  transaction. In the server process the slots share `DB_POOL_MAX` (default 30) with HTTP;
  raise it with large slot counts. An analysis worker process has its own pool of
  `min(DB_POOL_MAX, DIALER_ANALYSIS_CONCURRENCY + 2)`, which counts towards the host's total
  ("Sizing the media workers", *Postgres connections*).

The default of 8 covers about 4 analysed calls a minute at 2 minutes a job (a floor of ~12 agents
on 3-minute calls). At the 500-call target (~167 calls a minute) and 2 minutes a job the queue
needs ~330 slots, more than one process allows (`DIALER_ANALYSIS_CONCURRENCY` accepts 1-256) and
past most single-key quotas: raise the quotas and run more than one analysis process (claims are
`FOR UPDATE SKIP LOCKED`, so processes share the queue safely), or accept a backlog that drains
off-peak.

**Analysis worker processes (`ANALYSIS_WORKERS`).** With `ANALYSIS_WORKERS=K` (0-32, default 0)
the server forks K analysis processes and runs no analysis slot of its own. Each child runs
`DIALER_ANALYSIS_CONCURRENCY` slots under its own `DIALER_ANALYSIS_MEMORY_BUDGET_BYTES` and a heap of
that budget plus 512 MB, so recording buffers and vendor waits stay off the process that serves
calls. Total slots are K × `DIALER_ANALYSIS_CONCURRENCY`. The server keeps the retention purge,
enqueues jobs when calls end and wakes the children over IPC. A vendor rate limit in one child
pauses all of them (the primary relays the pause; each then sends one probe when it ends). A
child that exits is restarted (1 s, 2 s, 4 s, … up to 30 s); its claimed jobs return to the
queue through the stale recovery, without using an attempt. On shutdown each child requeues
its own in-flight jobs (generation-matched) and exits; one that has not exited within 15 s is
killed. 0 is the behaviour before the key existed. Design: [`scaling.md`](scaling.md).

**Memory.** Each slot may buffer a whole recording (up to `DIALER_MAX_RECORDING_BYTES`, 50 MiB)
and upload it, which copies it once more. A slot reserves 2 × that cap on the recording memory
budget (`DIALER_ANALYSIS_MEMORY_BUDGET_BYTES`, default 512 MiB) before it claims a job, and drops
to 2 × the real size once the recording is fetched (to zero once a transcript-only job has its
transcript). A slot that finds the budget spent waits without a claim. The default fits five
worst-case recordings at once, or hundreds of ordinary ones (a 3-minute mono MP3 is 1-3 MB),
next to everything else in a 4 GB heap. The server refuses to start with a budget below
2 × `DIALER_MAX_RECORDING_BYTES`.

**Rate limits.** A vendor rate limit (HTTP 429 / `RESOURCE_EXHAUSTED`) requeues the job without
using an attempt and pauses all new claims in this process for 30 s, doubling with each
consecutive pause up to 15 min. After a pause one probe job runs; slots fill again only when it
completes. A rate-limited job is requeued no earlier than the pause.

**What to watch** (dashboard row *Analysis*): `dialer_analysis_slot_utilization` pinned at 1
while `dialer_analysis_queue_depth{status="queued"}` grows means too few slots;
`dialer_analysis_budget_waits_total` rising means the memory budget, not the slots, is the limit;
`dialer_analysis_rate_limit_pauses_total` rising means the vendor quota is. `dialer_analysis_in_flight`
and `dialer_analysis_memory_reserved_bytes` show the pool itself.

### Sizing the media workers

`MEDIA_WORKERS=N` moves the agents' station sockets and their calls' audio relay into N
processes, so the relay no longer shares a loop with pacing, webhooks and the API
([`scaling.md`](scaling.md)).

**What it buys.** Each process is one CPU core at most. The relay costs about 35–40 µs of CPU
per relayed frame, and a call is 100 frames a second (50 each way). So:
- 200 calls is about 0.75 of a core;
- 500 calls is about 1.9 cores for the relay alone;
- nginx and the TLS terminator also handle every frame on the same host (not measured here).

**Measured.** From `apps/server/scripts/load/cluster-media-load.ts`: the real server, the mock
carrier, real station sockets, 50 frames a second each way per call, 20 s windows. The machine
is a shared 4-core dev box, and the load generators themselves used 1.1–1.8 of its cores, so
read the ratios, not the absolutes:

| Calls | `MEDIA_WORKERS` | Calls bridged | Primary (or single) loop: ELU, p99 delay | Each media worker: ELU, p99 delay |
|---|---|---|---|---|
| 200 | 0 | 200 | 0.98, 24 ms | – |
| 200 | 2 | 200 | 0.05, 4 ms | 0.59 / 0.64, 6 ms |
| 200, half on the mobile app (`--client 0.5`) | 2 | 200 | 0.05, 5 ms | 0.71 / 0.73, 13 ms (web only, same day: 0.62 / 0.68, 7–8 ms) |
| 500 | 0 | 250, then no more | 1.00, 69 ms | – |
| 500 | 2 | 500 | 0.06, 5 ms | 0.97 / 0.95, 44–62 ms |
| 500 | 3 | 500 | 0.05, 6 ms | 0.88 / 0.81 / 0.90, 23–34 ms |

In every run with workers the primary's loop stays near idle while the workers carry the audio.
One process saturates at 200 calls, and at 500 it cannot bridge more than about 250.

**How many.**
- Leave one core for the primary, nginx, the TLS terminator and Redis:
  `MEDIA_WORKERS = min(vCPUs − 1, ceil(calls ÷ 170))`. 170 calls keeps a worker around 0.6 ELU.
- On 2 vCPUs, `MEDIA_WORKERS=1` keeps the relay off the loop that paces and serves the API. It
  does not raise the call ceiling: the relay still has one core.
- 500 calls needs more than 2 vCPUs whatever the process layout.
- More processes than cores is allowed and logged once at boot (cores, media, analysis,
  primary); they then share cores, and a worker waiting for a core delays its calls' audio.
- Size the RAM for the primary's heap (the entrypoint's 4 GB), plus
  `MEDIA_WORKERS × MEDIA_WORKER_HEAP_MB`, plus the analysis children, plus Redis, nginx and the
  OS.

**Postgres connections.** Every process opens its own pool, so the host can open the sum:

`DB_POOL_MAX` + `MEDIA_WORKERS × MEDIA_WORKER_DB_POOL_MAX` + `ANALYSIS_WORKERS × min(DB_POOL_MAX, DIALER_ANALYSIS_CONCURRENCY + 2)`

The database must allow that plus about 5 (a migration run, the super-admin CLI, an operator)
for the server's role: `max_connections − superuser_reserved_connections`. With the defaults
the 500-call layout (`MEDIA_WORKERS=3`, `ANALYSIS_WORKERS=2`) is 30 + 3 × 10 + 2 × 10 = 80, plus
5 = 85, which fits a stock Postgres (100, 3 reserved). The RDS instance `DEPLOYMENT.md` suggests
(`db.t4g.medium`) derives `max_connections` from its memory (about 400). A smaller managed
plan can allow fewer than 100: check it before raising any of the three. The pools start empty
and grow under load, so a host over the limit boots and runs normally and is refused
connections (`53300 too_many_connections`) only at a peak. So the primary checks the sum at
boot when workers are configured, before it forks any: past the limit it **refuses to start**
(exit 1; decision D12), and the log line names both numbers and the settings to lower. When it
fits it exports `db_connections_planned` (the sum plus the headroom) and
`db_connections_allowed`; `/readyz?detail=1` (with `READYZ_DETAIL_TOKEN`, "Health") shows the numbers on the primary's entry (`db`).
Raise `max_connections` before raising `MEDIA_WORKERS`, `ANALYSIS_WORKERS` or a pool.

**What to watch.** The *Processes* dashboard row shows event-loop utilisation by instance
(`:primary`, `:media0`, …): a worker pinned near 1 needs another core. It also shows child
exits (`agy-cluster-child-crash` warns on any), IPC requests and handoffs. `/readyz?detail=1`
gives the same per-process view on the host.

## Deployment invariants

1. **Redis keeps keys for their TTL.** Turn persistence on (AOF or RDB) and set
   `maxmemory-policy noeviction` (or a `volatile-*` policy with nothing else competing). Station
   tokens, agent and leader leases, and the bridge's call tokens live there. Since Q6, a call token
   that is missing while Redis answers is **refused**, so an evicted key or a non-persistent restart
   cuts a live call's carrier leg and status webhooks; each refusal logs
   `WebRTC WS token missing while Redis answered`. If Redis is down altogether, tokens are accepted
   (a live call is never hard-failed for a Redis outage).
2. **One host, one server container.** Never scale `server`. With `MEDIA_WORKERS` or
   `ANALYSIS_WORKERS` set, the one container runs a primary and the workers it forks
   ([`scaling.md`](scaling.md)). The primary is the only process that runs the reaper, the
   sweeps, retention and partition jobs. A token's Q6 memo is always minted and verified in
   the same worker. A second server container would break all of that.
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
7. **The web image ships with or before the server.** Invite emails link to console pages:
   `/agency/join/:token` for an agent, `/join/:token` for every other role. A console build without
   `/join` sends that link through its `*` route to `/app` and then `/login`, and the single-use
   token is lost. So a server that mails `/join` links needs a web image that has the page.

## Shutdown and grace period

On SIGTERM or SIGINT the server closes HTTP first, then halts pacing (waiting up to 5 s for
ticks in flight), stops analysis, then agency (in-flight campaign-completion mails get up to
30 s), voice (the bridge hangs up live calls and releases their slots) and platform (audit
buffers flushed), then closes Redis and Postgres (`apps/server/src/index.ts`,
`cluster/shutdown-order.ts`). Docker's default stop grace is 10 s, which would cut the 30 s drain,
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
0, and the sequence above took 7 ms. A drain that has mail to send can take up to 30 s. Pacing's
`stop()` waits for ticks in flight (`TICK_DRAIN_TIMEOUT_MS`, 5 s) before that drain; a tick that
outlives it is logged, and cannot dial, because every dial site re-checks the engine and the
dialer asks once more immediately before the carrier (a default pending Manas, `decisions.md`
rulings of 2026-10-16/17). 5 s plus 30 s stays inside the 45 s grace.

Agents are not returned to the pool on shutdown; after a restart they come back in `break` and must
choose to go available.

**With media workers** (`MEDIA_WORKERS > 0`), the primary orders the shutdown; the workers
ignore SIGTERM and SIGINT. HTTP closes first, then:

1. Pacing halts, before anything drains: ticks are drained (up to 5 s), leases are given up,
   and every worker is told no dial may go out.
2. Together: the media workers drain alongside the completion-notice drain (each worker
   closes its sockets, stops the shard, ends its live calls and exits; one still running
   after 30 s is killed and its slot reaped, so its calls' slots are released at once; one
   that crashes during its drain, any exit but code 0, is reaped the same way), and
   the analysis children requeue their jobs and exit (15 s, then killed).
3. Agency stops, then voice, then platform (the audit buffers flush last).

Typical worst case about 5 s + 30 s plus a few seconds, inside the compose file's 45 s grace.
Before step 1, closing HTTP waits for requests in flight; one forwarded to a media worker is
bounded at 15 s (`core.inject`) and a forwarded carrier webhook at 10 s. Only when such a request
is in flight at SIGTERM AND a worker needs its full 30 s drain can the total pass 45 s; the
container is then killed, which costs what a crash costs (the next boot's startup reap settles
what was left).

The multi-process end-to-end suite (`test/integration/cluster/media-workers.test.ts`) pins that
the whole tree exits 0 inside 45 s, including with live calls on a worker. A worker whose primary dies hangs its calls up within 5 s and exits.
Details: [`scaling.md`](scaling.md) §6.

## Migrations

The baseline, `packages/db/migrations/0001_baseline.sql`, and the numbered migrations after it
(`0002_telephony_credentials.sql`, `0003_agency_attempt_indexes.sql`,
`0004_agency_contacts_in_flight_index.sql`, `0005_softphone.sql`), run in order with node-pg-migrate
from `packages/db`:

```bash
DATABASE_URL=postgresql://... pnpm migrate:up
```

It does not read the server's `.env`. In the image, `docker/entrypoint.sh` runs the migrations on
every start, before the server, through `dist/migrate.js` (`apps/server/src/migrate.ts`). That is
node-pg-migrate's runner with the server's own config and Postgres TLS settings (the CLI cannot
verify TLS, because Q1 keeps TLS parameters out of `DATABASE_URL`). An invalid environment or a
failed migration stops the container before the server starts. Same table (`pgmigrations`) as
`pnpm migrate:up`. `0003_agency_attempt_indexes.sql` and `0004_agency_contacts_in_flight_index.sql` build their indexes with plain `CREATE INDEX`
(a migration file runs in one transaction, where `CONCURRENTLY` is not allowed), so writes to
`agency_call_attempts` and `agency_contacts` wait while it builds; that is safe only because the
migrations run before the server starts. `0005_softphone.sql`'s Down section refuses (raises) while
any soft-phone session exists, rather than deleting soft-phone calls' audit trail to restore
`campaign_id NOT NULL`. Run it the same way outside the image. Future
schema changes go in new numbered files; never edit or renumber an applied migration.

## Recordings

VoiceLink recordings are public MP3s on the carrier's host. The fetcher accepts only `https` URLs
whose parsed hostname is on `VOICELINK_RECORDING_HOSTS` (exact or subdomain), checked on every
redirect hop. Unset means `recording.app.voicelink.co.in`; a list replaces it; an explicitly empty
value refuses every fetch and playback. Playback goes through `/api/v1/webrtc-recordings/:id` with
an HMAC-signed query (`RECORDING_URL_SIGNING_SECRET`), and the console's attempt drawer through
`/proxy/agency/campaigns/:id/attempts/:attemptId/recording`.

A VoiceLink account can deliver recordings from another host (one dev account's are on
`voiceflowai.elisiontec.com`). When the host of a stored `recording_url` is not on the list:

- the server logs `Recording URL is not on the VoiceLink recording-host allow-list; refusing to
  proxy` (playback) or `... refusing to fetch` (analysis), with the refused `host`;
- playback answers 502 "The recording is not hosted on an allowed carrier host";
- the analysis job fails at once, not retried, as `TRANSCRIPTION_FAILED`.

Check the host with `SELECT DISTINCT split_part(recording_url, '/', 3) FROM agency_calls WHERE
recording_url IS NOT NULL;`, confirm with VoiceLink that it is theirs, and set the list. Setting it
replaces the default, so keep `recording.app.voicelink.co.in` in it:
`VOICELINK_RECORDING_HOSTS=recording.app.voicelink.co.in,<other host>`. Restart; it is read at boot.

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

With media workers, `/readyz` also needs at least one media worker to have answered a health
ping within 1 s and not to be draining, and the primary not to be shutting down (D5). Its body
names each worker's state, `{"status":"ready","mediaWorkers":{"answering":1,"total":2,"workers":[{"slot":0,"state":"not_answering"},{"slot":1,"state":"ok"}]}}`:
one slow or restarting worker does not take the host out of the load balancer or fail the
uptime check (it would take all traffic away, not the 1/N that worker serves); watch
`agy-cluster-child-crash` and the *Processes* row for it instead. One answer (Postgres, Redis and
one health ping to each worker) serves every probe for a second, so a flood of `/readyz` costs the
workers one ping round a second; a not-ready verdict is at most that second old.

`GET /readyz?detail=1` needs `Authorization: Bearer <READYZ_DETAIL_TOKEN>` (unset: the detail is
off; without the token or with another it answers 401 before anything is probed):
`curl -H "Authorization: Bearer $READYZ_DETAIL_TOKEN" 'http://127.0.0.1:3021/readyz?detail=1'`.
It adds the per-process view: role, slot, pid, event-loop
utilisation, p99 loop delay, live calls (media) or jobs (analysis), and whether it is draining.
The primary's own loop is listed too. The loop numbers are each process's last completed 5 s
window, closed by the process's own timer (`cluster/loop-sampler.ts`): reading them resets
nothing, so two probers see the same numbers and a stall stays visible for the whole window.
For history, the *Processes* row reads the OTel runtime gauges (`nodejs_eventloop_*`, one series
per process, per export interval), which keep their own histogram and are not touched by probes.

## Releases and versioning

Every workspace package has its own semantic version, tag, GitHub Release and `CHANGELOG.md`,
managed by [release-please](https://github.com/googleapis/release-please) from the Conventional
Commits on `main` (decision B24). The deployables are `server` (`apps/server`, the server image),
`console` and `super-admin` (`apps/console`, `apps/super-admin`, both in the web image). The shared
packages (`contracts`, `db`, `domain`, `observability`, `web-ui`) are versioned too, because that
is how a change in one of them moves the version of every app that bundles it.

| File | What it is |
|---|---|
| `release-please-config.json` | One component per workspace package, named after its directory; the `node-workspace` plugin; changelog sections; `exclude-paths` (each package's test directory); `bootstrap-sha`, the commit history is read back to on a component's first release |
| `.release-please-manifest.json` | The current released version of each component. release-please writes it; never edit it by hand |
| `.github/workflows/release-please.yml` | On every push to `main`: opens or updates the release PR; when that PR is merged, tags each released component and publishes its GitHub Release |
| `.github/workflows/pr-title.yml` | Fails a PR whose title is not a Conventional Commit |
| `tooling/release-please.test.mjs` | `pnpm test:release`, in CI: every workspace package is a component named after its directory, every config key is one release-please reads (it ignores a misspelt key silently), the pre-1.0 bump rules, the manifest matches every `package.json` version, the plugin is on |

### How a version is chosen

PRs are squash-merged, so the PR title becomes the one commit on `main` that release-please reads:
`<type>(<optional scope>)<optional !>: <summary>`.

| Commit | Release |
|---|---|
| `fix:` | patch (0.1.0 → 0.1.1) |
| `feat:` | minor (0.1.0 → 0.2.0) |
| `perf:`, `revert:`, `deps:` | patch, listed under their own changelog heading |
| `!` after the type, or a `BREAKING CHANGE:` footer | major from 1.0.0 on; **minor while the version is 0.x** (`bump-minor-pre-major`) |
| `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:`, `style:` | none, and not in the changelog |

A commit counts for a component only through the files it touches, not its scope: a `feat` that
changes `apps/server/` and `apps/console/` appears in both changelogs, and one that touches only a
package's test directory (`exclude-paths`: `test/` in the packages and the server, `src/__tests__/`
in the two apps) releases nothing. `exclude-paths` takes directories only, so the console's few test
files beside their source (`src/brand/*.test.ts`, `src/components/common/*.test.tsx`) still count:
give a commit that changes only those a non-releasing type (`test:`). When a shared package is released, the
`node-workspace` plugin gives every workspace package that depends on it a patch release (unless it
already has a larger bump) with a "Dependencies" entry naming the new version; the change itself is
described in that package's own `CHANGELOG.md`. So a `fix(contracts)` releases `contracts`, then
`domain`, `db`, `server`, `console` and `super-admin`.

Files outside every package (`docker/`, `grafana/`, `aws/`, `docs/`, root config) belong to no
component, so a commit that touches only them releases nothing, and a `Release-As:` footer on it
is never read either. A change there that alters a deployable (for example `docker/Dockerfile` for
the server image) ships with that component's next release; to release it now, include a change
inside the component in the same PR, or set `"release-as"` (below).

To force a version (promote a component to 1.0.0 at launch, say), set `"release-as": "1.0.0"` on
that package in `release-please-config.json`, merge the release PR it produces, then remove the
key in the next PR: while it is set, every release PR proposes that version again. A
`Release-As: 1.0.0` footer works too, on a commit that touches a file inside the component.

### Baseline and the first merge

Every component starts at **0.1.0**: the manifest and each `package.json` say so, and
`bootstrap-sha` (`54f7637`, `main` before release-please was added) is how far back the first
release reads. The PR that adds release-please edits every package's `package.json`, so its
squash commit belongs to all eight components. Squash it with a non-releasing title (`ci: …`):
then 0.1.0 is the baseline, everything merged with it (including the version display) is part of
0.1.0, and the first release PR opens on the first releasable change after it. A `feat:` title
would instead release all eight at 0.2.0, each with the same changelog line.

### Cutting a release

1. Merge PRs with Conventional Commit titles. release-please keeps one PR open, `chore: release
   main`, with the next version and changelog of every component that has releasable changes.
2. Review it like any PR: its body is the combined release notes. It is regenerated on every push
   to `main`, so an edit on its branch does not last. To fix a wrong or missing entry, put a
   commit override (below) in the body of the merged PR it came from; the next run (the next push to
   `main`, or Actions → Release Please → Run workflow) picks it up.
3. Merge it. The workflow tags each released component `<component>-v<version>` (for example
   `server-v0.2.0`, `console-v0.1.1`) and publishes a GitHub Release with that component's notes.
   The run's summary lists the tags.

A PR that holds several changes, or whose title was wrong, can rewrite what release-please reads by
putting this in its PR body, before or after merging (one Conventional Commit per line):

```
BEGIN_COMMIT_OVERRIDE
feat(console): show the pacing ratio on the campaign card
fix(server): release the bridge slot when a dial is refused
END_COMMIT_OVERRIDE
```

### Where the running version shows

- **Server logs, in Grafana (Loki).** Every record carries `version` (the logger's `base`, beside
  `service`) and the OTel resource attribute `service.version`, which Loki keeps as the structured
  metadata `service_version`. Each boot logs one line naming it, `magick-agency v<version>
  listening`. The server's version is `apps/server/package.json`'s, baked into the bundle at build
  time (`apps/server/scripts/build.mjs`; `packages/observability/src/version.ts`); a `tsx` dev run
  reports `0.0.0`.

  ```logql
  {service_name=~"magick-agency(-.+)?"} |= "listening"            # one line per boot, with its version
  {service_name=~"magick-agency(-.+)?"} | service_version="0.2.0"  # everything one release logged
  ```

- **Traces and metrics.** The same `service.version` resource attribute is on every span and on
  `target_info`.
- **The UIs.** The console and the super-admin console each show their own version (`v0.2.0`) at
  the foot of the sidebar, in the platform shell (expanded or collapsed to its rail), the agency
  shell and the super-admin shell (`AppVersion`, `packages/web-ui`). The agent surfaces have no
  sidebar, so it ends `AgentNav` on `/dialer`, `/dialer/performance` and `/dialer/attempts`, and the
  station header on `/station`, as a plain label (nothing focusable is added). It comes from the app's
  `package.json` through Vite `define` (`__APP_VERSION__`), so it is fixed when the web image is
  built.

### Repository settings it needs

Set once in the repository settings, not in code:

- **Pull requests**: allow squash merging, with the default commit message set to **Pull request
  title** only; turn merge commits off. A merge commit's message is `Merge pull request #…`, which
  is not a Conventional Commit. Not "title and description": release-please reads every paragraph
  of the commit message that starts with a Conventional Commit type (`fix: …` after a blank line)
  as one more commit, so a PR description can add changelog entries nobody meant to write.
- **Branch protection on `main`**: require the "Conventional Commit title" check (and CI). Without
  it the title check is advice, and a PR with a non-conventional title still merges and releases
  nothing.
- **Actions → General → Workflow permissions**: allow GitHub Actions to create and approve pull
  requests, or the workflow cannot open the release PR.
- **Optional `RELEASE_PLEASE_TOKEN` secret** (a fine-grained token or GitHub App token with
  contents and pull-requests write). PRs and tags created with the default `GITHUB_TOKEN` do not
  trigger other workflows, so the release PR gets no CI or title check (a branch protection rule
  requiring them would block it), and a future workflow on release tags would not fire.
- **Optional baseline tags**, so the first changelog's compare links resolve: after the first
  merge, tag that squash commit (where every `package.json` says 0.1.0) `<component>-v0.1.0` for
  each of the eight components and push the tags. release-please then reads history back to the
  tag instead of to `bootstrap-sha`.
