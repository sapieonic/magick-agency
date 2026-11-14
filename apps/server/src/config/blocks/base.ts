import { z } from 'zod';
import { SERVICE_NAME } from '@magick-agency/observability/service';
import { blankAsUnset, type Env } from '../env.js';
import { resolveMetricsExportIntervalMs } from '../../utils/otel-sdk-config.js';
import { WS_LARGEST_LEGITIMATE_MESSAGE_BYTES, WS_MAX_PAYLOAD_DEFAULT_BYTES } from '../../utils/ws-limits.js';

/**
 * Base block: process (`config.server`), Postgres (`config.db`), Redis (`config.redis`),
 * OpenTelemetry (`config.otel`).
 */
/** Decision Q1: connection-string parameters pg lets override the pool's `ssl` object. */
export const URL_TLS_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation'] as const;

/**
 * The TLS parameters present in a database URL (lower-cased names). Guarded, because a
 * Zod `.refine` also runs after a failed `.url()`: an unparseable value yields `[]` and the
 * `.url()` issue is the one reported.
 */
export function findUrlTlsParams(url: string): string[] {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return [];
  }
  const present = new Set<string>();
  for (const key of params.keys()) {
    const lower = key.toLowerCase();
    if ((URL_TLS_PARAMS as readonly string[]).includes(lower)) present.add(lower);
  }
  return [...present];
}

/**
 * `value` as the browser would send it in `Origin` (lower-case host, no default port), or `null`
 * when it is not exactly `scheme://host[:port]` over http or https: a path, a trailing slash, a
 * query, a fragment, credentials or `*` are refused rather than silently dropped, because the
 * operator meant something by them. Guarded, because a value that is not a URL at all must be
 * refused, not thrown.
 */
export function normaliseOrigin(value: string): string | null {
  if (/[/?#]$/.test(value) || /[?#]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || url.pathname !== '/') return null;
  return url.origin;
}

/** `CORS_ALLOWED_ORIGINS` as a list: comma separated, each entry trimmed, blanks dropped. */
export function splitOriginList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  return entries.length > 0 ? entries : undefined;
}

/**
 * A Postgres session timeout in milliseconds (`config.db`): `0` (the default) is off, otherwise
 * at least one second and at most one hour. Blank is unset, like the other optional numbers.
 */
function dbTimeoutMs(envName: string) {
  return z.preprocess(
    blankAsUnset,
    z.coerce.number().int().min(0).max(3_600_000).default(0).refine((ms) => ms === 0 || ms >= 1_000, {
      message: `${envName} is in milliseconds: 0 (off) or at least 1000`,
    }),
  );
}

export const baseConfigSchema = z.object({
  server: z.object({
    port: z.coerce.number().int().positive().default(3021),
    host: z.string().default('0.0.0.0'),
    env: z.enum(['development', 'test', 'production']).default('development'),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /**
     * Decisions Q7/Q9: passed to Fastify's `trustProxy` in `app.ts`.
     *
     * Number of reverse-proxy hops in front of this service.
     *
     * This is the count of trusted proxies, NOT a boolean. `trustProxy: true`
     * trusts the whole `X-Forwarded-For` chain and therefore takes its
     * **leftmost** entry as `request.ip` — and nginx *appends* to that header
     * (`$proxy_add_x_forwarded_for`), so the leftmost entry is whatever the
     * client sent. Under `true`, any caller can mint a fresh `request.ip` per
     * request by rotating the header, which silently defeats the IP rate
     * limiter (measured: 50 requests against a max of 5, zero blocked).
     *
     * With a hop count, proxy-addr walks the chain from the socket inward and
     * trusts exactly this many addresses, so `request.ip` is the address nginx
     * itself observed and the client cannot influence it.
     *
     * Default 1: one reverse proxy straight in front of the server, with no CDN or
     * load balancer. Raise it by exactly one per additional trusted proxy (2 behind
     * Cloudflare).
     *
     * **Both directions of being wrong are harmful, and neither is loud.** Too
     * high and proxy-addr trusts hops the client controls, re-opening the
     * X-Forwarded-For spoof this setting exists to close. Too low and
     * `request.ip` resolves to infrastructure rather than the caller — at 0 it is
     * the nginx socket itself, so every client on the platform collapses into a
     * single rate-limit bucket and legitimate traffic 429s en masse.
     *
     * Hence `.min(1)` rather than `.nonnegative()`: 0 is never a correct
     * deployment, and a blank `TRUST_PROXY_HOPS=` in an env file coerces to 0 —
     * allowing it would turn an empty line into a platform-wide outage.
     *
     * The rate limiter is app-wide, so `request.ip` keys every console user's
     * 200/min bucket.
     */
    trustProxyHops: z.coerce.number().int().min(1, 'TRUST_PROXY_HOPS must be at least 1 (0 buckets every client under the proxy IP)').default(1),
    /**
     * `WS_MAX_PAYLOAD_BYTES`: the largest inbound WebSocket message, on every WebSocket route
     * (`ws`'s `maxPayload`, set where `app.ts` registers `@fastify/websocket`). A bigger one
     * closes the socket with 1009. Default 64 KiB; the derivation per route is in
     * `src/utils/ws-limits.ts`. Never below the largest legitimate message (a 1 s `pcm16`
     * station frame), or a legitimate client would be disconnected; `ws`'s own default is
     * 100 MiB, buffered and parsed on the event loop.
     */
    wsMaxPayloadBytes: z.coerce.number().int()
      .min(WS_LARGEST_LEGITIMATE_MESSAGE_BYTES, `WS_MAX_PAYLOAD_BYTES must be at least ${WS_LARGEST_LEGITIMATE_MESSAGE_BYTES} (the largest legitimate WebSocket message)`)
      .max(16 * 1024 * 1024)
      .default(WS_MAX_PAYLOAD_DEFAULT_BYTES),
    /**
     * `READYZ_DETAIL_TOKEN`: the bearer `GET /readyz?detail=1` needs (`Authorization: Bearer
     * <token>`, compared in constant time, `cluster/readiness.ts`). The detail names each
     * process's pid, loop numbers and the host's Postgres budget, and plain `/readyz` is
     * unauthenticated and exempt from the rate limiter, so the detail is off unless this is
     * set: unset (or blank), `?detail=1` answers 401 and plain `/readyz` is unchanged. Not the
     * super-admin login: the detail must answer when Postgres is the problem, and a scoped,
     * read-only token is what a script or an operator's `curl` should hold.
     */
    readyzDetailToken: z.string().min(32, 'READYZ_DETAIL_TOKEN must be at least 32 characters').optional(),
    /**
     * `CORS_ALLOWED_ORIGINS`: the browser origins allowed to call this API cross-origin, comma
     * separated (`https://app.example.com,https://staging.app.example.com`). For a deployment
     * where the console is served from one host and calls the API on another (its image built
     * with `CONSOLE_API_BASE_URL`); `app.ts` registers CORS with exactly these
     * (`api/middleware/cors.ts`).
     *
     * Unset or blank = no CORS at all, which is right for the single-origin deployment (the
     * console calls its own origin and nginx proxies the API paths): the browser then refuses
     * every cross-origin call, as before. Each entry must be a bare origin, `scheme://host[:port]`
     * with no path or trailing slash; each is normalised to the form a browser sends as
     * `Origin` (`https://App.example.com:443` → `https://app.example.com`), which is then
     * compared exactly. `*` is refused, so the allow-list can never silently become "any site".
     */
    corsAllowedOrigins: z.array(
      z.string().refine((v) => normaliseOrigin(v) !== null, (v) => ({
        message: `CORS_ALLOWED_ORIGINS entry "${v}" must be a bare http(s) origin like https://app.example.com (no path, query, trailing slash or *)`,
      })).transform((v) => normaliseOrigin(v) ?? v),
    ).default([]),
  }),
  db: z.object({
    /**
     * Q1 (Manas, 2026-10-09), made enforceable: TLS parameters in the URL are refused. pg
     * assigns the connection string's `ssl` / `sslmode` / `sslrootcert` / `sslcert` /
     * `sslkey` / `sslnegotiation` OVER the pool's `ssl` object (`connection-parameters.js`;
     * pg-connection-string 2.14 turns `sslnegotiation` alone into `ssl: true`), so one of them in
     * `DATABASE_URL` would silently replace the verified settings below. TLS is configured
     * only through `DB_SSL_CA` / `DB_SSL_REJECT_UNAUTHORIZED`.
     */
    url: z.string().url().refine((v) => findUrlTlsParams(v).length === 0, (v) => ({
      message:
        `DATABASE_URL must not carry TLS parameters (${findUrlTlsParams(v).join(', ')}): they would override `
        + 'the verified TLS settings. Remove them and use DB_SSL_CA / DB_SSL_REJECT_UNAUTHORIZED.',
    })),
    poolMin: z.coerce.number().int().min(0).default(2),
    /**
     * `DB_POOL_MAX`: the one pg pool every area queries through (`packages/db`
     * `initDbPool`). Default 30, sized for a 500-agent floor: the hot paths hold a
     * connection for a few ms each (a disposition, a settle, a contact claim, a campaign
     * page poll every 10 s per open console), and at ~550 consoles plus ~510 dials and
     * ~170 settles a minute that is a few hundred short statements a second, which 10
     * connections queue behind as soon as one transaction or a slow report holds several.
     * **Per process.** One process at 30 stays well inside Postgres's default
     * `max_connections` (100), leaving room for migrations, the super-admin CLI and an
     * operator's session. With worker processes each opens its own pool
     * (`MEDIA_WORKER_DB_POOL_MAX` per media worker, `min(DB_POOL_MAX,
     * DIALER_ANALYSIS_CONCURRENCY + 2)` per analysis worker), and the primary checks the sum
     * against the server at boot (`cluster/db-connection-budget.ts`). A managed database with
     * a lower limit needs this lowered to fit. Saturation shows in `db_pool_clients_waiting`
     * and `db_pool_acquire_seconds` (`metrics/shared.ts`).
     */
    poolMax: z.coerce.number().int().positive().default(30),
    /**
     * Decision Q1: when TLS is on (`NODE_ENV=production`, `src/index.ts`), the server
     * certificate is VERIFIED unless this is exactly `false`. Strict on purpose: only `true` / `false` parse, so a blank
     * `DB_SSL_REJECT_UNAUTHORIZED=` is a boot error rather than a silent opt-out.
     */
    sslRejectUnauthorized: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    /**
     * PEM TEXT of the CA that signed the Postgres server certificate (a private CA, e.g. a
     * managed database's). Contents, not a file path: it travels through the same env /
     * secret channel as `DATABASE_URL`, and a path would make boot depend on a file the
     * container may not have. Literal `\n` sequences are turned into newlines so a one-line
     * env value works. A value that is not a PEM certificate (e.g. a path) is refused at
     * boot. Unset (or blank) = Node's default roots, still verified.
     */
    sslCa: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() !== '' ? v.replace(/\\n/g, '\n') : undefined),
      z.string().refine((v) => v.includes('-----BEGIN CERTIFICATE-----'), {
        message: 'DB_SSL_CA must be the PEM text of a CA certificate (-----BEGIN CERTIFICATE-----), not a file path',
      }).optional(),
    ),
    /**
     * Postgres session timeouts on every connection of the server's own pools (the primary and
     * each worker process; not the migrations or the super-admin CLI), set by `initDbPool`'s
     * connect hook (`DbSessionTimeouts` in `packages/db`). Milliseconds; `0`, the default, leaves
     * the database's own setting, so nothing changes until one is set. A non-zero value under a
     * second is refused: it would be a unit mistake that cancels ordinary statements.
     * `db-hygiene.md` ("5. Timeouts") has the order to turn them on in and what each one stops.
     *  - `DB_STATEMENT_TIMEOUT_MS`: a statement running longer is cancelled (57014);
     *  - `DB_LOCK_TIMEOUT_MS`: a statement waiting longer for a lock fails (55P03);
     *  - `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`: a connection idle inside an open transaction for
     *    longer is ended by Postgres, releasing its locks.
     */
    statementTimeoutMs: dbTimeoutMs('DB_STATEMENT_TIMEOUT_MS'),
    lockTimeoutMs: dbTimeoutMs('DB_LOCK_TIMEOUT_MS'),
    idleInTransactionTimeoutMs: dbTimeoutMs('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS'),
  }),
  redis: z.object({
    url: z.string().url(),
    keyPrefix: z.string().default(''),
    /**
     * `REDIS_COMMAND_TIMEOUT_MS`: every command rejects after this long (`Command timed
     * out`), so a Redis that is gone or stalled surfaces in seconds and each caller takes
     * its Redis-error branch (decision Q6: a call token is then accepted, never refused).
     * Default 2 s. `src/utils/redis-options.ts` has the reasoning.
     */
    commandTimeoutMs: z.coerce.number().int().min(100).max(60_000).default(2_000),
    /** `REDIS_MAX_RETRIES_PER_REQUEST`: retries of a command caught by a dropped connection. Default 1 (ioredis: 20). */
    maxRetriesPerRequest: z.coerce.number().int().min(0).max(20).default(1),
    /** `REDIS_CONNECT_TIMEOUT_MS`: default 2 s (ioredis: 10 s). */
    connectTimeoutMs: z.coerce.number().int().min(500).max(60_000).default(2_000),
  }),
  /**
   * How many processes the server runs on its host (`docs/scaling.md` §8, D8). With
   * `mediaWorkers` 0 (the default) it is one process, exactly as before. With N > 0 the
   * process the operator starts is the primary: it accepts every request and upgrade and
   * hands each station and carrier socket to one of N forked media workers, which hold
   * the agents' runtime state and relay the audio.
   */
  processes: z.object({
    /** `MEDIA_WORKERS`: 0-64. On 2 vCPUs more than 1 buys little (`docs/scaling.md` §8.1). */
    mediaWorkers: z.coerce.number().int().min(0).max(64).default(0),
    /** `MEDIA_WORKER_HEAP_MB`: each media worker's `--max-old-space-size`. */
    mediaWorkerHeapMb: z.coerce.number().int().min(128).max(65_536).default(768),
    /** `WORKER_CRASH_LOOP_MAX`: more exits of one media slot in 5 minutes makes the primary exit (D4). */
    crashLoopMax: z.coerce.number().int().min(1).max(100).default(5),
    /**
     * `MEDIA_WORKER_DB_POOL_MAX`: each media worker's own pg pool (`DB_POOL_MAX` sizes the
     * primary's). Every process opens its own pool, so the host's connections are the SUM
     * (`cluster/db-connection-budget.ts` adds them up at boot and compares them with the
     * server's `max_connections`). Default 10: a worker's statements are its own calls'
     * (the attempt's `dialing` stamp and call id, the call row's lifecycle writes, the
     * settle, a forwarded disposition or break, a station attach), a few a second for a
     * worker carrying ~170 calls at ~3 minutes each, every one a short single-row write.
     * The primary keeps the 30 for what is bursty and many-row: contact claims for every
     * campaign, the reaper and the sweeps, the API and every console's polling.
     */
    mediaWorkerDbPoolMax: z.coerce.number().int().positive().max(1_000).default(10),
    /**
     * `MEDIA_SNAPSHOT_REFRESH_MS`: how often the primary refreshes every media worker's
     * `reaper.snapshot` between reaper passes (the live call ids the guard's stale sweep
     * spares, and the slot leases reconciled). Default 5 s. 0 turns the periodic refresh off,
     * leaving only the reaper's own pass and the workers' `call.lease` deltas: a diagnostic
     * setting, which the chaos suite uses to prove the slot reap works from the deltas alone.
     */
    mediaSnapshotRefreshMs: z.coerce.number().int().min(0).max(600_000).default(5_000),
  }).default({}),
  /**
   * The OpenTelemetry SDK's settings, as `src/instrumentation.ts` resolves them. That file
   * cannot read this block: it runs before any other module, and this config's module body can
   * `process.exit(1)` (see the `src/utils/otel-sdk-config.ts` header). It reads the same
   * variables itself, with the same lenient parsing (an unusable interval falls back to the
   * default rather than failing boot), and `test/unit/config/otel-config.test.ts` pins that the
   * two agree. Not modelled here, though the SDK side reads them: `OTEL_EXPORTER_OTLP_HEADERS`
   * (it carries the Grafana Cloud token), `OTEL_ENVIRONMENT`, `OTEL_SERVICE_INSTANCE_ID`,
   * `OTEL_LOG_LEVEL`, and the SDK's own standard variables (`OTEL_RESOURCE_ATTRIBUTES`,
   * `OTEL_LOGS_EXPORTER`, …). `serviceName` / `serviceInstanceIdEnabled` are what the code sets;
   * NodeSDK still merges `OTEL_RESOURCE_ATTRIBUTES` over them.
   */
  otel: z.object({
    /** Only the exact string `true`. */
    enabled: z.string().optional().transform((v) => v === 'true'),
    /** Base URL; the SDK appends `/v1/traces`, `/v1/metrics` and `/v1/logs`. Blank = unset. */
    endpoint: z.string().optional().transform((v) => v || undefined),
    metricsExportIntervalMs: z.string().optional().transform(resolveMetricsExportIntervalMs),
    /** Blank = unset. */
    serviceName: z.string().optional().transform((v) => v || undefined),
    serviceInstanceIdEnabled: z.string().optional().transform((v) => v === 'true'),
  }).transform(({ serviceName, ...o }) => ({
    ...o,
    serviceName: serviceName ?? SERVICE_NAME,
    /**
     * Traces, metrics and logs leave the process only when OTel is enabled, the endpoint is set
     * AND `OTEL_SERVICE_NAME` is set (`instrumentation.ts`): the fallback name is the production
     * name Grafana alerts on (Manas, 2026-10-09).
     */
    exporting: o.enabled && o.endpoint !== undefined && serviceName !== undefined,
  })),
});

export function readBaseEnv(env: Env) {
  return {
    server: {
      port: env['PORT'],
      host: env['HOST'],
      env: env['NODE_ENV'],
      logLevel: env['LOG_LEVEL'],
      trustProxyHops: env['TRUST_PROXY_HOPS'],
      wsMaxPayloadBytes: env['WS_MAX_PAYLOAD_BYTES'],
      // Blank is unset (detail off), not a boot error: an empty line in an env file.
      readyzDetailToken: env['READYZ_DETAIL_TOKEN']?.trim() || undefined,
      // Blank (or only commas) is unset (no CORS), like READYZ_DETAIL_TOKEN above.
      corsAllowedOrigins: splitOriginList(env['CORS_ALLOWED_ORIGINS']),
    },
    db: {
      url: env['DATABASE_URL'],
      poolMin: env['DB_POOL_MIN'],
      poolMax: env['DB_POOL_MAX'],
      sslRejectUnauthorized: env['DB_SSL_REJECT_UNAUTHORIZED'],
      sslCa: env['DB_SSL_CA'],
      statementTimeoutMs: env['DB_STATEMENT_TIMEOUT_MS'],
      lockTimeoutMs: env['DB_LOCK_TIMEOUT_MS'],
      idleInTransactionTimeoutMs: env['DB_IDLE_IN_TRANSACTION_TIMEOUT_MS'],
    },
    redis: {
      url: env['REDIS_URL'],
      keyPrefix: env['REDIS_KEY_PREFIX'],
      commandTimeoutMs: env['REDIS_COMMAND_TIMEOUT_MS'],
      maxRetriesPerRequest: env['REDIS_MAX_RETRIES_PER_REQUEST'],
      connectTimeoutMs: env['REDIS_CONNECT_TIMEOUT_MS'],
    },
    processes: {
      mediaWorkers: env['MEDIA_WORKERS'],
      mediaWorkerHeapMb: env['MEDIA_WORKER_HEAP_MB'],
      crashLoopMax: env['WORKER_CRASH_LOOP_MAX'],
      mediaWorkerDbPoolMax: env['MEDIA_WORKER_DB_POOL_MAX'],
      mediaSnapshotRefreshMs: env['MEDIA_SNAPSHOT_REFRESH_MS'],
    },
    otel: {
      enabled: env['OTEL_ENABLED'],
      endpoint: env['OTEL_EXPORTER_OTLP_ENDPOINT'],
      metricsExportIntervalMs: env['OTEL_METRICS_EXPORT_INTERVAL_MS'],
      serviceName: env['OTEL_SERVICE_NAME'],
      serviceInstanceIdEnabled: env['OTEL_SERVICE_INSTANCE_ID_ENABLED'],
    },
  };
}
