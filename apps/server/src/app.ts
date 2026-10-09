import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import websocket from '@fastify/websocket';
import type { AppContext } from './app-context.js';
import { initFeatureFlagService } from './feature-flags/index.js';
import { platformPlugin } from './api/platform.plugin.js';
import { agencyPlugin } from './api/agency.plugin.js';
import { voicePlugin } from './api/voice.plugin.js';
import { analysisPlugin } from './api/analysis.plugin.js';
import { registerRateLimit } from './api/middleware/rate-limit.middleware.js';
import { agencyErrorHandler } from './api/middleware/agency-error-handler.js';
import { errorMaskHook } from './api/middleware/error-mask.middleware.js';

export interface BuildAppOptions {
  /** Null in tests that only exercise routing; lanes must cope or require it. */
  ctx: AppContext | null;
  logger?: boolean;
  /** Collects every registered route (handoff rule 10: enumerate from the router). */
  onRoute?: (route: RouteOptions) => void;
}

/**
 * Decisions Q7/Q9: trust exactly `hops` proxies — `proxy-addr`'s own hop-count rule
 * (`i < hops`, where index 0 is the socket peer and each next index is the next
 * X-Forwarded-For entry from the right).
 *
 * Passed as a function because this app resolves Fastify 5.12.x, where a NUMERIC
 * `trustProxy` fails closed ("hop-count-only trust cannot validate the immediate peer",
 * `fastify/lib/request.js`): `request.ip` would be the socket peer whatever the count, so a
 * numeric setting would silently do nothing and every client behind the proxy would share
 * one rate-limit bucket. The trade Fastify's change names is real and is accepted
 * deliberately: with hops = N, whoever can reach this port WITHOUT passing through the
 * proxy can choose `request.ip` by sending N X-Forwarded-For entries. So the port must only
 * be reachable through the proxy (bind to loopback / a private interface, or firewall it).
 * The same trust makes `request.host` / `request.protocol` proxy-asserted (`x-forwarded-host`
 * / `x-forwarded-proto` from a trusted hop); nothing in this app reads them today.
 */
export function hopCountTrust(hops: number): (address: string, hop: number) => boolean {
  return (_address, hop) => hop < hops;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 10 * 1024 * 1024,
    // `maxParamLength: 200`: find-my-way's default is 100, so a longer path param would be
    // Fastify's route-not-found 404 instead of the route's own answer. Passed through
    // `routerOptions` (Fastify 5's place for it), as on the internal handler instance
    // (`core-handlers.ts`).
    routerOptions: { maxParamLength: 200 },
    // Decisions Q7/Q9: hop count, never
    // `true` — see `server.trustProxyHops` (`config/blocks/base.ts`). `true` trusts the
    // entire X-Forwarded-For chain, and nginx appends to it, so the client-supplied leftmost
    // entry would become `request.ip` and the IP rate limiter could be bypassed by rotating
    // the header. Passed as {@link hopCountTrust}, not the bare number — see its note. An app
    // built without a context (routing-only tests) trusts no proxy: `request.ip` is the
    // socket peer.
    trustProxy: opts.ctx ? hopCountTrust(opts.ctx.config.server.trustProxyHops) : false,
    // The request id is the client's `x-request-id`,
    // else the active OTel trace id, else a UUID — so the id a masked 5xx body quotes
    // (`errorMaskHook`) is unique across restarts and joins the trace. Fastify's default is a
    // per-process counter (`req-1`, `req-2`, …) that repeats after every restart, which makes
    // "quote this request ID" ambiguous. The trace API is imported statically: it is a
    // declared dependency, so there is nothing optional to guard.
    genReqId: (req) => {
      // Use client-provided request ID, OTel trace ID, or generate a UUID
      const clientId = req.headers['x-request-id'] as string | undefined;
      if (clientId) return clientId;
      const span = trace.getActiveSpan();
      if (span) return span.spanContext().traceId;
      return randomUUID();
    },
  });

  if (opts.onRoute) app.addHook('onRoute', opts.onRoute);

  // The rate limiter, at APP scope, so every route below — including `POST /auth/session`,
  // the agency API and the super-admin tree — is charged to a bucket, not only the carrier
  // routes. Registered before any route: the plugin attaches its hook from `onRoute`, so a
  // route registered earlier would be unlimited. Per-route `config.rateLimit` blocks
  // (super-admin login, the public invite routes) are honoured by this one registration. The
  // probes `/healthz`, `/readyz` are its `EXEMPT_PATHS`.
  //
  // The buckets key on `request.ip`, which honours exactly `TRUST_PROXY_HOPS` proxies
  // (`trustProxy` above; decisions Q7/Q9): a spoofed leftmost X-Forwarded-For entry
  // cannot move a client into a fresh bucket, and clients behind the proxy do not share one.
  await registerRateLimit(app, opts.ctx?.redis ?? null, {
    max: opts.ctx?.config.rateLimit.max,
    webhookMax: opts.ctx?.config.rateLimit.webhookMax,
    carrierMediaMax: opts.ctx?.config.rateLimit.carrierMediaMax,
    internalMax: opts.ctx?.config.rateLimit.internalMax,
    timeWindow: opts.ctx?.config.rateLimit.timeWindow,
  });

  // `errorHandler` (with the 22P02 → 400 backstop) and `errorMaskHook`, app-wide: every
  // route — platform, super-admin, agency, voice, analysis — answers a thrown error in one
  // shape, and no 5xx body reaches a client (database driver text, the SQL a failed
  // statement carried). See `error-mask.middleware.ts`. Registered before any plugin so
  // every encapsulated scope inherits both.
  app.setErrorHandler(agencyErrorHandler);
  app.addHook('onSend', errorMaskHook);

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    if (!opts.ctx) return reply.code(503).send({ status: 'unavailable' });
    try {
      await opts.ctx.pool.query('SELECT 1');
      await opts.ctx.redis.ping();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  // The flag service is initialised with the shared Redis at boot, before `listen`; without it
  // `getFeatureFlagService()` falls back to a Redis-less instance and every flag
  // read skips the snapshot cache.
  if (opts.ctx) initFeatureFlagService(opts.ctx.redis, opts.ctx.config.redis.keyPrefix);

  // One `@fastify/websocket` for the whole app, registered once, globally: a second
  // registration in another plugin scope would compete for the server's upgrade event.
  // The PSTN leg and the agency station socket both use it.
  await app.register(websocket);

  await app.register(platformPlugin, { ctx: opts.ctx });
  await app.register(agencyPlugin, { ctx: opts.ctx });
  await app.register(voicePlugin, { ctx: opts.ctx });
  await app.register(analysisPlugin, { ctx: opts.ctx });

  return app;
}
