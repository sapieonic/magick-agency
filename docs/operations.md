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
(`VITE_API_BASE_URL` empty; the console's can point at a separate API host instead, B27 and
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

**API on its own host (B27).** The terminator may send a second name (`api.example.com`) to
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
| `TELEPHONY_CREDENTIAL_KEYS` + `TELEPHONY_CREDENTIAL_ACTIVE_KEY` | Tenant carrier credentials (BYOC, B19) | Master keyring that seals the credentials super-admins add (`v1:<base64 32 bytes>,…`). Unset, or no entries after trim (blank, spaces or commas only) = adding one is refused and BYOC calls fail closed. Rotate by adding a new id and making it active; keep old ids listed while secrets are sealed under them (boot logs an ERROR naming a missing one, and `telephony_credential_missing_key_ids` pages through `agy-credential-keyring-missing-keys`). Back it up separately from the database: losing it makes every stored credential unopenable |
| `PLIVO_WEBHOOK_BASE_URL` (+ the keyring above) | Calls on tenants' own Plivo accounts (B18) | This server's public https origin plus `/api/v1/webhooks/plivo`: Plivo fetches the answer XML and posts status and recording callbacks under it, and opens the media socket on its host. Env only, never tenant data. Unset: every Plivo dial is refused before anything is sent. No Plivo account is configured in env; super-admins add each tenant's as a credential ("Enabling Plivo for a tenant") |
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
| `AGENCY_INSIGHTS_ROLLUP_INTERVAL_MS`, `AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE` | `15000` (1000–600000), `200` (1–5000) | The insights rollup job (`docs/insights.md`): how often a pass recomputes the dirty 15-minute buckets, and how many a batch claims. The page's range sections lag the attempts by about one interval; `agency_insights_rollup_dirty_buckets` and `_oldest_dirty_seconds` say how far |
| `AGENCY_CUSTOMER_SEARCH_PER_MINUTE`, `AGENCY_CUSTOMER_SEARCH_TTL_MINUTES`, `AGENCY_CUSTOMER_EXPORT_MAX_ROWS` | `30` (1–10000), `30` (1–1440), `10000` (1–100000) | Customer history (`docs/customer-history.md`): searches and exports a minute per user (CH11, its own bucket besides `RATE_LIMIT_USER_MAX`), how long a search id serves its timeline and export, and the export's row cap (`X-Export-Truncated: true` past it). Timeline pages and `GET /proxy/agency/customers/options` are not charged to the per-minute cap |
| `AGENCY_REPORTS_RENDERER`, `AGENCY_REPORTS_SQS_QUEUE_URL`, `AGENCY_REPORTS_CALLBACK_BASE_URL`, `AGENCY_REPORTS_CALLBACK_SECRET`, `AGENCY_REPORTS_CHROME_PATH` | `inline`, unset | Reports (`docs/reports.md`): `inline` renders in process; `sqs` sends runs to the renderer Lambda and needs the queue URL, the server's public base URL (callback `<base>/webhooks/reports/rendered`) and a secret of at least 32 characters (used exactly as written: leading or trailing whitespace fails boot), and the S3 bucket (`S3_AUDIO_BUCKET`), or boot fails; the base URL is scheme and host only. Per tenant it also needs the `agency_reports_enabled` flag (default off; `FF_AGENCY_REPORTS` sets the default) |
| `AGENCY_REPORTS_MAX_DETAIL_ROWS`, `AGENCY_REPORTS_ASSEMBLER_INTERVAL_MS`, `AGENCY_REPORTS_TICK_INTERVAL_MS`, `AGENCY_REPORTS_RENDER_TIMEOUT_MS`, `AGENCY_REPORTS_MAX_ATTEMPTS`, `AGENCY_REPORTS_RETENTION_DAYS`, `AGENCY_REPORTS_TENANT_PENDING_LIMIT`, `AGENCY_REPORTS_USER_PER_MINUTE` | `100000`, `2000`, `60000`, `900000`, `3`, `90`, `5`, `3` | Reports: detail-sheet row cap (RP12), assembler poll, tick, render timeout and sends before `render_timed_out` (RP13), file retention in days (RP8), runs pending per tenant, ad hoc requests per user per minute |
| `CORS_ALLOWED_ORIGINS` | unset (no CORS) | Origins allowed to call the API cross-origin, comma separated, bare origins only (`*` refused). Only for the API on its own host (`DEPLOYMENT.md` 7.3, decision B27); the web image is then built with `CONSOLE_API_BASE_URL` |
| `READYZ_DETAIL_TOKEN` | unset (detail off) | Bearer for `GET /readyz?detail=1` ("Health"); at least 32 characters. Plain `/readyz` needs nothing (D13) |
| `DB_POOL_MIN`, `DB_POOL_MAX` | `2`, `30` | pg pool of the server process (the primary, with workers), one for every area. 30 for a 500-agent floor. **Per process**: worker processes open their own pools (`MEDIA_WORKER_DB_POOL_MAX` below; an analysis worker `min(DB_POOL_MAX, DIALER_ANALYSIS_CONCURRENCY + 2)`), and the sum must fit Postgres's `max_connections` with room for migrations and an operator ("Sizing the media workers", *Postgres connections*). Saturation: `db_pool_clients_waiting`, `db_pool_acquire_seconds` |
| `DB_SSL_CA` | unset (Node's roots) | PEM text of a private CA, not a path; `\n` escapes allowed |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | Only `true` / `false` parse; `false` is the one opt-out |
| `REDIS_KEY_PREFIX` | empty | Prefix on every Redis key, and on the cache-invalidation pub/sub channel (`<prefix>cache:invalidate:db<N>`, N the URL's Redis db). Pub/sub is server-wide, not per db, so two deployments on one Redis are separated by a different prefix or a different db |
| `REDIS_COMMAND_TIMEOUT_MS`, `REDIS_MAX_RETRIES_PER_REQUEST`, `REDIS_CONNECT_TIMEOUT_MS` | `2000`, `1`, `2000` | Redis client bounds: a Redis that is gone or stalled fails each command within the timeout (a rejection, so call tokens fail open per Q6, and the agent lease renewer keeps renewing through it). ioredis's defaults took ~10 s to show on `/readyz` and held some requests ~30 s |
| `MAX_CONCURRENT_CALLS` | `1000` | Global guard ceiling: call legs holding a slot, ringing and `ending` included (a 500-call floor holds ~860 at peak; sizing in `config/blocks/voice.ts`). Per-account limits come from super-admin settings, default 5 |
| `VOICELINK_LOGIN_TIMEOUT_MS`, `VOICELINK_ADD_LEAD_TIMEOUT_MS` | `10000`, `15000` | VoiceLink REST timeouts, per request (a 401's retry gets a fresh one; the `add_lead` value also bounds a CDR lookup). A timed-out `add_lead` fails the dial (agent and slots released at once) but may have queued the lead: never retried, the contact's redial deferred 15 min, a late carrier media connect refused and hung up (`voicelink.adapter.ts`, `post`) |
| `PLIVO_CALLS_PER_SECOND` | `2` (1–100) | New calls a second per Plivo account (Plivo's account default), counted across every process in Redis (a sliding 1000 ms window per account: no 1000 ms span admits more). One value for every tenant's account: raise it only when every Plivo account in use allows more |
| `PLIVO_DIAL_RATE_MAX_WAIT_MS` | `5000` (0–60000) | The longest a dial waits for a calls-per-second slot; then it is refused unsent (`carrier_rate_limited`), a retryable refusal the dialler treats as back-pressure |
| `PLIVO_REQUEST_TIMEOUT_MS` | `15000` (1000–120000) | Each Plivo REST request (create-call, cancel, hangup, number sync). A timed-out create-call may have placed the call: never retried, the contact's redial deferred 15 min as for VoiceLink |
| `PLIVO_RING_TIMEOUT_SECONDS` | `45` (5–120) | How long Plivo lets a dial ring (`ring_timeout`). A call with no answer or terminal callback 30 s past it is ended by the bridge (`ring_deadline_passed`), so a lost callback does not hold its slots and agent to the max duration |
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
5 = 85, which fits a stock Postgres (100, 3 reserved). On Supabase (`DEPLOYMENT.md` 3.3) the
compute size sets `max_connections` (`show max_connections;` in the SQL editor), and the small
sizes allow fewer than 85. Through the shared pooler in session mode the tighter limit is usually
the pooler's *pool size* (*Database settings → Connection pooling*), which the boot check below
cannot see: it reads `max_connections`. Set the pool size to at least the sum plus the headroom,
and check both before raising any of the three. The pools start empty
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

### Customer history at scale

`apps/server/scripts/bench-customer-history.ts` measures the customer-history search and a later
timeline page through the real service on a seeded 1,000,000-contact tenant, and prints
`EXPLAIN (ANALYZE, BUFFERS)` of every statement with nothing disabled. It is opt-in and never part
of CI: it runs only against `localhost:5436/magick_agency_test_bench` (it drops that database's
schema when it seeds) and refuses any other name or port. How to run it, its settings
(`BENCH_DB_URL`, `BENCH_SEED_URL`, `BENCH_RESEED`, `BENCH_CONTACTS`, `BENCH_RUNS`,
`BENCH_PLANS_FILE`) and the figures of 2026-11-06 are in
[`customer-history.md`](customer-history.md) §4. Rerun it after a change to
`customer-history.repository.ts` or to the indexes it reads.

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
30 s, and beside them the report pipeline stops: 20 s at most for its assembler, tick and inline
renders together, `REPORT_PIPELINE_STOP_WAIT_MS`), voice (the bridge hangs up live calls and releases their slots) and platform (audit
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

## Enabling Plivo for a tenant

Plivo is dialled only on a tenant's own Plivo account (decisions B18–B22, PL1–PL16); the
service's own carrier stays VoiceLink. How a Plivo call flows: [`architecture.md`](architecture.md),
"The voice engine". Once per deployment:

1. `TELEPHONY_CREDENTIAL_KEYS` and `TELEPHONY_CREDENTIAL_ACTIVE_KEY` set ("Optional blocks"), the
   keyring backed up apart from the database.
2. `PLIVO_WEBHOOK_BASE_URL=https://<public host>/api/v1/webhooks/plivo`, the same public host the
   carrier reaches for VoiceLink (nginx already sends `/api/*` to the server). Restart the server.
   Nothing needs setting on Plivo's side: each dial names its own answer and callback URLs. It
   must be an absolute `https:` URL with no query or fragment, or the server does not start.
   While it is unset, Plivo accounts are not offered for campaigns, start and resume of a campaign
   pinned to one answer 409 `carrier_not_ready`, and any Plivo dial is refused before it is sent
   (`carrier_dial_not_sent`, PL12).

Then per tenant:

1. **Add the credential.** Super-admin console → Telephony Credentials → add, for the tenant, the
   Plivo Auth ID and Auth Token. It is checked with Plivo before it is stored and becomes `active`.
   The tenant's Plivo account must allow the destinations it will call (Plivo's geo permissions): a
   dial to a country it does not allow is refused (a 403, which ends that call `failed` and pauses
   nothing, PL1).
2. **Sync numbers.** "Sync numbers" on the credential copies the account's numbers into the number
   inventory, pinned to the credential and assigned to the tenant for every account. The summary
   says what was added, reactivated, taken over, retired, unchanged or skipped, and any conflict (a
   number already registered elsewhere is never taken over, except from a revoked credential of
   the same tenant and the same Plivo account: re-adding an account after revoking its credential
   moves its numbers to the new one, PL5). Run it again after numbers change on the Plivo account.
   Calls placed on the revoked credential keep it, so their recordings are fetched with it until it
   is shredded (no call within the post-call hold), after which they cannot be played. Plivo numbers cannot be added by hand: "Add number" on the phone numbers page
   does not offer a carrier that takes tenant credentials (`takes_tenant_credentials` on
   `GET /super-admin/telephony-providers`) and points here instead. The super-admin console names
   carriers "Alias (Vendor)", e.g. "Pravah (Plivo)" (PL16).
3. **Concurrency.** An account on a single total needs nothing: Plivo calls count against it. An
   account on a per-carrier breakdown (tenant → Service → the account's provider concurrency) needs
   a `plivo` allocation (shown by its alias), or every Plivo dial is refused for capacity
   (`provider_concurrency_limit`, logged "No concurrency is allocated to telephony provider
   'plivo'"): the campaign does not pause, it places no calls. A Plivo call is admitted like any other: global, account and provider
   scopes (B22).
4. **The campaign.** In the console's campaign builder or settings, "Carrier" appears once the
   tenant has more than one carrier account; pick the Plivo account (its alias plus the
   credential's label). The caller IDs offered are then that account's synced numbers. The soft
   phone's untagged calls dial on the carrier account of the caller ID chosen.

**Automatic pauses.** Three reasons on a campaign's pause say its carrier account cannot dial. The
first two are set on the first refused dial, the third after five in a row; each is written to the activity trail as "Auto-paused" with the reason,
shown on the Insights headline, and logged at ERROR; the contact goes back uncharged. Nothing
resumes the campaign by itself:

- `carrier_auth`: Plivo refused the credential (HTTP 401): its Auth Token was changed or the
  account suspended at Plivo. The refusal also marks the credential `invalid` with its
  `last_error` (only if the secret version that was refused is still the current one), audited
  `telephony_credential.carrier_refused`, so resume answers 409 `telephony_credential_not_active`
  until a super-admin rotates the credential's secret to the current token, or verifies it once
  Plivo accepts it again; both bring it back to `active`. Then a supervisor resumes the campaign.
- `carrier_account_unavailable`: the pinned credential is no longer `active`: disabled, marked
  invalid or revoked. Resume answers 409 `telephony_credential_not_active` until a super-admin
  re-enables or fixes the credential, or the campaign is moved to another carrier account in its
  settings. A keyring fault (no keyring configured, or a secret whose master key is missing,
  `agy-credential-keyring-missing-keys`) pauses nothing: the credential is fine, so each dial on it
  fails as the platform's own failure (the contact is retried a minute later, the soft phone says
  to try again) until the key is restored. Restore the key; nothing needs resuming.
- `carrier_refusing_calls`: the carrier refused five of the campaign's dials in a row with none
  placed in between (PL11): a 4xx other than 401 and 429 (a 403 for a destination the account's
  geo permissions do not enable, an account out of credit, a caller ID it rejects), or a dial not
  sent for the carrier's configuration (`PLIVO_WEBHOOK_BASE_URL` unset). A 5xx from Plivo (an
  outage on its platform) never counts: those dials fail and their contacts are retried, and no
  campaign is paused for it. The refusals are on the
  call rows (`error_code`) and in the `Plivo create call error` / `Plivo dial not sent` log lines.
  Fix the account at Plivo (or the server's configuration), then a supervisor resumes; the
  credential stays `active`, so nothing refuses the resume.

The console tells supervisors to contact support for either (PL15): a tenant's own admins cannot
see or fix a carrier account. A soft-phone call on such an account is refused `409
carrier_account_unavailable` and pauses nothing. A revoke is refused while a campaign that is not
finished (draft, running, paused or stopping) is pinned to the credential; the refusal names up to
five of them (tenant / account, status).

`carrier_dial_refusals_total{provider="plivo",kind}` counts create-calls that placed no known call
(`auth_rejected`, `rate_limited`, `outcome_unknown`, `refused`, and `not_sent` for a dial refused
before anything was sent: no webhook base, a malformed number or caller ID, the API unreachable).
A steady `rate_limited` means the dial rate is above `PLIVO_CALLS_PER_SECOND`; dials then wait and
retry on the next pacing tick. A steady `not_sent` is configuration or network: read the
`Plivo dial not sent` log lines.

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

Plivo recordings stay on the tenant's Plivo account and are fetched on demand with its credential
(B21): only from `media.plivo.com` (an exact match, not configurable), with HTTP Basic on the first
request only; a redirect hop carries no credential, for any carrier. A call whose credential is
revoked, shredded, another tenant's or unopenable cannot be fetched: playback answers 404
`recording_unavailable`, and its analysis job fails at once, not retried (a missing keyring key is
retried, and recovers once the key is restored). Revoking a credential therefore ends playback and
analysis of that tenant's earlier recordings on it.

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

## Reports

Reports ([`reports.md`](reports.md)) are assembled in the main process and rendered either in
process (`AGENCY_REPORTS_RENDERER=inline`, the default: development and tests, Chromium on the
server) or by the `report-renderer` Lambda behind the `report-jobs` SQS queue
(`AGENCY_REPORTS_RENDERER=sqs`, production; created by `aws/terraform` with `enable_reports`,
[`aws/README.md`](../aws/README.md) "Reports"). Every reports setting and its default is in
[`reports.md`](reports.md), "Config". The renderer path needs four:

| Variable | Value |
|---|---|
| `AGENCY_REPORTS_RENDERER` | `sqs` |
| `AGENCY_REPORTS_SQS_QUEUE_URL` | `terraform output report_jobs_queue_url` |
| `AGENCY_REPORTS_CALLBACK_SECRET` | The value in SSM that the Lambda signs with, generated by `aws/terraform`: `sh -c "$(terraform output -raw reports_callback_secret_env_command)"` prints the line. During a rotation `AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS` holds the old one too ([`aws/README.md`](../aws/README.md), "Rotating the callback secret") |
| `AGENCY_REPORTS_CALLBACK_BASE_URL` | The server's public base URL, which the Lambda calls back |

`terraform output -raw reports_server_env` prints the renderer and queue lines, and
`AGENCY_REPORTS_RENDER_TIMEOUT_MS` from `reports_render_timeout_seconds` (default 900 s; it must
stay at least the queue's visibility timeout plus the function's timeout, "Reports: sizing the
render timeout"). Deploy the renderer before the
server on every release (aws/README.md, "Deploy order"); roll it back by pointing its `live` alias
at the previous version ("Rollback" there).

### Reports: when runs are stuck

A run moves `queued` → `assembling` → `rendering` → `ready` (or `failed`), and turns `expired`
after `AGENCY_REPORTS_RETENTION_DAYS`. Where to look, in order:

1. **The dashboard's *Reports* row.** *Pending Runs and Oldest Pending* shows which status runs
   pile up in (`agency_reports_pending_runs`, set by the reports tick every minute) and how old
   the oldest is (`agency_reports_oldest_pending_seconds`, which `agy-reports-pending-too-long`
   watches). *Callbacks* shows whether renders come back, and how they are refused.
2. **The run row.** `report_runs` holds each run's `status`, `error` (`code` and `message`: the
   stage that failed, `docs/reports.md` "Contracts"), `render_attempt` and `sent_at`. Runs stuck
   in `queued` or `assembling` are the server's assembler (its logs for the run id; usually
   Postgres). Runs stuck in `rendering` were sent and have not called back.
3. **SQS and the Lambda, in CloudWatch** (the renderer path only). The `report-jobs` queue's
   `ApproximateNumberOfMessagesVisible` and `ApproximateAgeOfOldestMessage`: growing means the
   Lambda is not consuming (its event source mapping disabled, or every invocation failing). The
   dead-letter queue's `ApproximateNumberOfMessagesVisible` above 0 means messages failed three
   receives (the function threw, timed out at 300 s, ran out of memory or could not deliver its
   callback; each redelivery waits out the 600 s visibility timeout); read a message there
   for its `run_id` and the function's logs (`/aws/lambda/<function>`) for the error. An empty
   queue with runs `rendering`: the send never reached SQS (the server's logs, its
   `AGENCY_REPORTS_SQS_QUEUE_URL`, its `sqs:SendMessage`), or the callback never reached the server
   (`AGENCY_REPORTS_CALLBACK_BASE_URL` wrong or unreachable from the internet, or refused:
   `agency_reports_callbacks_total{result="bad_signature"}`).

The tick re-sends a run with no callback after `AGENCY_REPORTS_RENDER_TIMEOUT_MS` (15 min; size it
against the renderer's backlog, "Reports: sizing the render timeout" below) as a
new attempt, after first checking S3 for its files, and fails it `render_timed_out` after
`AGENCY_REPORTS_MAX_ATTEMPTS` (3). So a fixed cause clears on its own; runs already failed are
re-run from the console ("Run again"). Nothing replays the dead-letter queue, and nothing needs to:
an older attempt's callback is ignored once a newer one was sent (`stale` on the callbacks panel).
Purge the DLQ once you have read what it holds.

### Reports: sizing the render timeout

**The invariant to keep** (with the queue `aws/terraform` creates):

    function timeout (300 s) < queue visibility timeout (600 s)
    visibility timeout + function timeout (900 s) <= AGENCY_REPORTS_RENDER_TIMEOUT_MS

The first is AWS's. The second makes SQS's redelivery of a message the function failed (its
callback undeliverable, a crash, a timeout) happen, and finish, while the server still waits for
that attempt, so the redelivered render's callback is applied rather than acknowledged `stale`.
Terraform holds both sides: `reports_render_timeout_seconds` (default 900) is printed into
`reports_server_env` and the apply refuses a value below 900. Change the timeout there, never only
in the server's env: the server cannot see the queue, so nothing at boot checks it. Breaking the
second inequality costs latency, not renders: each message carries `superseded_after` (the send
plus the server's timeout), and the function drops a message it receives after it in
milliseconds, without rendering, so a redelivery or a backed-up message that outlasted the server's
wait never takes one of the 3 render slots.

`AGENCY_REPORTS_RENDER_TIMEOUT_MS` (default 15 minutes) counts from the send, so a run's time in
the `report-jobs` queue counts against it, not only its render. The renderer takes at most 3
messages at once (`maximum_concurrency` in `aws/terraform/reports.tf`, one message per invocation)
and each render may run up to the function's 300 s timeout. Runs sent together queue behind each
other: the `n`-th run of a burst starts after about `ceil(n / 3)` renders. Size the timeout so the
last run of the largest burst still calls back in time:

    AGENCY_REPORTS_RENDER_TIMEOUT_MS > ceil(burst / 3) × p95 render time + p95 render time + a margin

`burst` is the runs sent within a few minutes of each other: every subscription sharing a send
time (they all fall due on the same tick; the assembler sends them one after another, a few
seconds apart, which spreads them only a little) plus the ad hoc runs in flight (at most
`AGENCY_REPORTS_TENANT_PENDING_LIMIT` per tenant). Read the p95 render time from the dashboard's *Reports — Assembly and Render Duration (p95)*
panel (`agency_reports_render_seconds`, send to applied callback, so it includes the queue wait:
read it outside a burst) or the
function's logs (`record.done … ms`). With renders of about a minute, 15 minutes covers a burst of
about 40 runs; at the function's 300 s ceiling it covers 6.

**When it is too short**, a queued message is not lost, only late, but the tick cannot tell the
two apart: it re-sends the run as a new attempt (another message at the back of the same
backlog), the first attempt's message is dropped unrendered when the function reaches it (past its
`superseded_after`), and after `AGENCY_REPORTS_MAX_ATTEMPTS` sends the run fails
`render_timed_out` although nothing was broken. A render that started before the timeout and
finished after it is not wasted: every attempt writes the run's same output keys, and before
re-sending or failing a run the tick looks for them in S3 and applies the run as rendered when
they are all there. The signs: `record.superseded` lines in the function's logs, the queue's
`ApproximateAgeOfOldestMessage` near or above the timeout, the DLQ empty, and runs failing
`render_timed_out` right after a burst (a scheduled send time). The remedies, cheapest first:
raise `AGENCY_REPORTS_RENDER_TIMEOUT_MS` (through `reports_render_timeout_seconds`; a lost message
is then retried that much later), spread
subscriptions' send times, or raise the mapping's `maximum_concurrency` (each render holds a
Chromium of 2 GB). The default stays at 15 minutes: it is ample for the bursts reports see today,
and a longer one only delays the retry of a genuinely lost message.

## Alert runbooks

Each rule in `grafana/terraform/alert-rules.tf` carries its own runbook in its `description`, which
the alert shows. The entries below are for the insights rules and the pacing share rule, which all
warn (Slack) and never page, for the carrier credential rules, and for the reports rules (warn
only). The insights rules first: a stale or holed Insights page costs no
call. Their panels are near the bottom of the dashboard's *Agency dialer* row (*Insights Rollup*,
*Pacing History*), and their thresholds assume the default `AGENCY_INSIGHTS_ROLLUP_INTERVAL_MS`
(15 s) and `AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE` (200).

### `agy-insights-rollup-failing`

**Means:** 10+ rollup batches rolled back in 15 minutes (`agency_insights_rollup_failures_total`).
A failed batch keeps its dirty marks and ends the pass, so the Insights page's range sections stop
moving and the page says "updating". Nothing is lost: the marks stay until a batch commits.

**Check:** the logs, `component=agency-insights-rollup`, "Insights rollup batch failed". A
connection, pool or lock error is Postgres; the same SQL error on every pass, usually after a
deploy, is a recompute bug or one bad bucket (batches claim oldest first, so one bucket that always
fails blocks the whole backlog).

**Do:** fix Postgres (its load, `DB_POOL_MAX`, `db_pool_clients_waiting`). For a bad bucket, find the
oldest row of `agency_insights_rollup_dirty` (`ORDER BY id LIMIT 1`), and file the error with its
`campaign_id` and `bucket_start`; do not delete marks to unblock it, that bucket would then be
wrong for good. The job catches up on its own once batches commit.

### `agy-insights-rollup-behind`

**Means:** the oldest dirty mark has been older than 120 s for 10 minutes
(`agency_insights_rollup_oldest_dirty_seconds`). A healthy job stays under ~50 s (one interval,
plus a long pass, plus the skipped tick); a 1M-attempt backfill drained in 62 s. 120 s is eight
intervals.

**Check:** the *Insights Rollup* panels. Failures rising: follow `agy-insights-rollup-failing`.
Backlog shrinking: a backfill or a large rewrite (the migration that marks every bucket, a reaper
or disposition sweep) is being worked off. Backlog growing with fast batches: marks arrive faster
than half an interval of batching drains. Batch p95 near 10 s: Postgres is slow.

**Do:** a draining backlog clears on its own; leave it. A growing one with fast batches: raise
`AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE` (up to 5000) and restart. Slow batches: look at Postgres load
and the slow statements on `agency_insights_rollup_buckets`.

### `agy-insights-rollup-stalled`

**Means:** no rollup batch has committed for ~15 minutes
(`agency_insights_rollup_recompute_seconds_count` flat), although the job committed batches
before. A pass has started and not finished, so the job skips every later tick and the backlog
gauges are frozen at their last value (which is why `agy-insights-rollup-behind` cannot see this).
The server sets no `statement_timeout`, so a batch waiting on a lock waits indefinitely.

**Check:** if `agy-insights-rollup-failing` fires too, follow that one. Otherwise, in agency's
Postgres, `pg_stat_activity` for a long-running statement on `agency_insights_rollup_dirty` or
`agency_insights_rollup_buckets`, and what it waits on (`wait_event`, `pg_blocking_pids()`).

**Do:** end whatever holds the lock, or cancel the blocked statement (`pg_cancel_backend`): its
batch rolls back and the next pass retries it. A restart does the same. Then watch the batches
line come back.

### `agy-pacing-history-write-failures`

**Means:** 5+ failed writes to `agency_campaign_pacing_minutes` in 15 minutes, by `path`
(`agency_pacing_history_write_failures_total`). `batch`: the pacing leader's 15 s flush; the
minutes are kept and resent, so nothing is lost yet. `direct`: the single-row writes outside the
tick (a wrap-up redial refused at the limit, an our-fault retirement); each failure is an event
the pacing history never shows. Dialling is unaffected.

**Check:** the logs, "Pacing history flush failed" (`batch`) or "Pacing history write failed"
(`direct`), for the error; it is almost always Postgres or its pool.

**Do:** fix Postgres. `batch` failures resend on their own once a flush succeeds; past 10,000
unwritten campaign-minutes they start being dropped (next entry).

### `agy-pacing-history-dropped`

**Means:** the pacing leader held more than 10,000 unwritten campaign-minutes and dropped the
oldest (`agency_pacing_history_dropped_total`). Those minutes are gone from
`agency_campaign_pacing_minutes` for good; nothing re-derives them.

**Check:** `agy-pacing-history-write-failures` (`path=batch`) will have fired first; the WARN
"Pacing history over its pending cap" gives how many were dropped.

**Do:** fix the write (Postgres) and the drops stop with it. Tell the affected supervisors that
the Insights pacing history of that window is incomplete.

### `agy-pacing-share-starved`

**Means:** for 10 minutes the pacing round kept withholding slots from one running campaign
(`agency_pacing_share_withheld_total`, by `campaign_id`) while its live calls stayed at 0
(`agency_campaign_slots_in_use`). An account's running campaigns split its `max_concurrent_calls`
in the pacing round, fewest live calls first (MC1–MC7 in [`decisions.md`](decisions.md)). The
withheld counter on its own measures contention, not starvation: it counts every campaign whose
demand exceeded what it got while the account had headroom, so a busy campaign above an equal
share is withheld routinely. Withheld at 0 in use is the starvation signal, because fewest live
first serves a campaign with no live call before any other unless something else is wrong. Its
ready agents wait while the account's other campaigns dial; the account as a whole still dials up
to its limit. The slot gauges are set only after a campaign's contended report to the split and
cleared on every other tick outcome, so the rule cannot fire for a campaign alone on its account
or one that is not reporting demand.

**Check:** the dashboard's *Pacing Share* panels, at the end of the *Agency dialer* row: this
campaign's `allocated` never above its `in use` while another campaign's `allocated` rises. Then:

- **More campaigns running than lines.** Compare the account's running campaigns with its
  `max_concurrent_calls` (the campaign's stats `concurrency` block, or the console's campaign card,
  which then reads "… · 3 campaigns share 2 lines"). When more campaigns tie at 0 live calls than
  the account has lines, the tie goes round-robin and some campaign is always waiting at 0, so the
  rule can fire with the share working as designed.
- **A late tick.** The pacing logs for the campaign. A tick that misses the 1 s wait (counted from
  the account's first report) but reports while its account's split is still open gets what the
  split left over, so a slow sibling is not starved by that alone; only a report after the split
  CLOSES (the 5 s deadline, MC2) gets 0, counted as withheld. A
  warning "Pacing split open past its deadline — closing it" for the account means some member
  never reported within 5 s: a tick stuck in its reads, which starves its campaign and also holds
  back the account's other campaigns, since no tick starts for an account while its split is open.
- **A stuck dial.** A warning "A pacing tick has held granted dials with no progress past the bound
  — no longer counting them against the account" means a tick sat 60 s
  (`PACING_DIAL_HOLD_MAX_MS`) between granted dials, hung in the carrier: its campaign keeps no
  new dials while it hangs, and should it recover the account can briefly exceed its limit by what
  it still inserts (the concurrency guard refuses the excess). Check the carrier (VoiceLink login
  and `add_lead` latency) for the same window.

**Do:** for more campaigns than lines, raise the account's limit (super-admin) or ask the
supervisors to run no more campaigns at once than the account has lines, pausing the ones that
can wait; nothing is broken. Otherwise file it with the campaign and account ids and what the logs
show. A burst of withheld slots with live calls on the campaign is the share rule working, not
this alert.

### `agy-credential-keyring-missing-keys`

This one pages. **Means:** `telephony_credential_missing_key_ids` is above 0: stored tenant
carrier credential secrets (B19) are sealed under master key ids that `TELEPHONY_CREDENTIAL_KEYS`
does not hold, so they cannot be opened. Every call on an affected credential fails closed, and so
do the hangups and webhook checks of its calls already in flight; a running campaign pinned to
one pauses `carrier_account_unavailable` at its next dial ("Enabling Plivo for a tenant"). Nothing
falls back to the service's VoiceLink account (B20), whose own calls are unaffected. The main process sets the gauge
at boot and after each hourly sweep (`startCredentialHousekeeping`, `apps/server/src/bootstrap/voice.ts`).

**Check:** the boot ERROR "Telephony credential secrets are sealed under keys missing from
TELEPHONY_CREDENTIAL_KEYS", whose `kekIds` names the missing ids, against the deploy's
`TELEPHONY_CREDENTIAL_KEYS`. A keyring unset altogether reads every stored key id as missing.

**Do:** restore the missing `id:key` entries from the keyring backup (kept apart from the
database) and restart; the gauge reads 0 from the next boot. A key that is truly lost never opens
its secrets again: a super-admin rotates each affected credential's secret, which reseals it under
`TELEPHONY_CREDENTIAL_ACTIVE_KEY`. Either way, supervisors then resume the campaigns it paused.

### `agy-credential-sweep-failing`

**Means:** 2+ failed credential sweeps in 3 hours (`telephony_credential_sweeps_total{result="failed"}`;
the sweep runs at boot and hourly). The sweep shreds revoked credentials once every call pinned to
them is terminal and ended more than 2 h ago, and drops secret versions past the 24 h rotation
grace. Nothing dials on a revoked credential either way; the cost is sealed secrets kept past the
retention B20 promises.

**Check:** the WARN "Telephony credential sweep failed" for the error. It is almost always
Postgres or its pool; a lock wait on a credential row being revoked or rotated clears on its own.

**Do:** fix Postgres. The sweep is idempotent: the next hourly pass, or a restart, catches up.

### `agy-reports-pending-too-long`

**Means:** the oldest report run still queued, assembling or rendering has been older than
900 s for 10 minutes (`agency_reports_oldest_pending_seconds`), so it is 25+ minutes old: past
one render re-send. Its requester sees it spinning. Dialling is unaffected.

**Check:** "Reports: when runs are stuck" above: the pending panel's status split, the run rows,
then the queue, its DLQ and the Lambda's logs.

**Do:** fix the stage that holds the runs (Postgres for assembly; the renderer, its deploy or the
callback settings for rendering). The tick re-sends and finally fails silent runs, so the gauge
comes down by itself; users re-run the failed ones.

### `agy-reports-failing`

**Means:** 4+ report runs ended `failed` in an hour (`agency_reports_runs_total{status="failed"}`).

**Check:** the failed runs' `error.code`. `assembly_failed`, `subject_unavailable`: the server's
assembly. `subject_changed`: a campaign's zone was edited while its run waited; nothing to fix.
`dataset_unreadable`, `render_failed`, `upload_failed`: the renderer (its logs; an S3 error is
its role or the bucket; a missing `dataset.json`, for a message replayed after the 7-day dataset
lifecycle, reads as `AccessDenied` because the renderer's role has no `ListBucket`).
`render_failed` with renderer version `inline-unavailable`: the server is on
`AGENCY_REPORTS_RENDERER=inline` without the renderer (the production image); its boot log says
so; set `sqs`. `dataset_version_unsupported`: the server was deployed
before the renderer; apply the renderer (aws/README.md, "Deploy order"). `render_timed_out`: no
callback, as in `agy-reports-pending-too-long`. A renderer that started failing after an apply:
roll `live` back (aws/README.md, "Rollback").

**Do:** fix the cause; users then use "Run again", and subscriptions send the next period as
usual.

### `agy-reports-callback-bad-signature`

**Means:** the server refused at least one render callback in 15 minutes because its HMAC did not
verify or its timestamp was more than 300 s off (`agency_reports_callbacks_total{result="bad_signature"}`).

**Check:** whether reports are failing or pending too. If so, the server's
`AGENCY_REPORTS_CALLBACK_SECRET` (and `…_PREVIOUS`) is not the secret the Lambda signs with (a
rotation done out of order, or an old line left in `docker/.env`) or a clock is minutes off. If
reports are otherwise fine, something else is posting to `/webhooks/reports/rendered`: look at the
callers in the access logs.

**Do:** replace the server's secret lines with what `reports_callback_secret_env_command` prints
(SSM is the source; mid-rotation it prints both) and recreate the server, then let users re-run
what failed meanwhile.

## What CI runs

A pull request runs what its diff reaches, not everything: the full server unit suite alone is
about 100 s, and the integration lanes are the longest jobs. `tooling/ci-scope.mjs` reads the
diff against the merge base and picks:

| Change | Runs |
|---|---|
| Files of a workspace package (prose `*.md` aside) | `lint`, `test` and `build` of that package and of every workspace package that depends on it |
| A file outside a package that its suites read (`READ_BY`: `tooling/test-env.ts`, `tooling/vitest-decorator-transform.ts`, `tooling/contracts-literals.*`, `apps/server/test/fixtures/`) | as a change to that package |
| `packages/db` in scope (itself or a dependency changed) | the `db` integration lane |
| `apps/server` in scope (itself or any dependency, contracts and domain included) | the `server` and `server wall-clock` lanes |
| Anything, while the server's suite is not in scope | the server's repository guards on their own (`SERVER_REPO_GUARDS`: branding over the whole tree, the route tables and CORS over the web UIs, the docker/ packaging; about 7 s) |
| `grafana/`, `packages/observability/`, `apps/server/src/` | `pnpm test:grafana` |
| The release-please config, the manifest, a `package.json` or `pubspec.yaml` | `pnpm test:release` |
| `apps/mobile/`, `packages/contracts/`, the literal extractor, `customer-search-number.ts` | the Mobile workflow |
| A shared root file (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`, `.nvmrc`) | everything in CI (not the Mobile workflow) |

So a console change runs the console's suites and the server's guards, and no integration; a
contracts change runs nearly everything. A docs-only change runs the guards only.

**Everything** runs on every push to `main`, on a manual run (Actions, CI, "Run workflow") and on
a pull request labelled **`full-ci`**; adding the label starts the run. The run's summary page
shows the scope it picked and why.

`pnpm test:tooling` (`tooling/ci-scope.test.mjs`, also the scope job's first check) holds the
rules, and resolves every `../` path in every package's code, tests and config: one that reaches
outside the package must land in a dependency, a shared root file, a `READ_BY` rule for that
package or a server repository guard, or it fails. A new test that reads another package's files
therefore adds its rule in the same change. Paths built without a `../` literal (the branding
guards walk up with `dirname`) are not seen; such a server test belongs in `SERVER_REPO_GUARDS`.

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
  nothing. CI's job names do not change with its scope ("What CI runs"), and a job or lane out of
  scope reports skipped or passes, so the same required checks hold on every pull request.
- **A `full-ci` label** in the repository's labels, so a pull request can ask for every check.
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
