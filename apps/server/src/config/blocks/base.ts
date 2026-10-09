import { z } from 'zod';
import type { Env } from '../env.js';

/**
 * Base block: process (`config.server`), Postgres (`config.db`), Redis (`config.redis`).
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
    poolMax: z.coerce.number().int().positive().default(10),
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
  }),
  redis: z.object({
    url: z.string().url(),
    keyPrefix: z.string().default(''),
  }),
});

export function readBaseEnv(env: Env) {
  return {
    server: {
      port: env['PORT'],
      host: env['HOST'],
      env: env['NODE_ENV'],
      logLevel: env['LOG_LEVEL'],
      trustProxyHops: env['TRUST_PROXY_HOPS'],
    },
    db: {
      url: env['DATABASE_URL'],
      poolMin: env['DB_POOL_MIN'],
      poolMax: env['DB_POOL_MAX'],
      sslRejectUnauthorized: env['DB_SSL_REJECT_UNAUTHORIZED'],
      sslCa: env['DB_SSL_CA'],
    },
    redis: {
      url: env['REDIS_URL'],
      keyPrefix: env['REDIS_KEY_PREFIX'],
    },
  };
}
