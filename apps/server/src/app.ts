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
 * Q7/Q9 (Manas, 2026-10-09): trust exactly `hops` proxies — `proxy-addr`'s own hop-count
 * rule (`i < hops`, where index 0 is the socket peer and each next index is the next
 * X-Forwarded-For entry from the right), which is what master's `trustProxy: hops` meant on
 * the Fastify it ran (5.8.4, master's lockfile @a1f0756a).
 *
 * PORT NOTE (magick-agency): passed as a function because agency resolves Fastify 5.12.x,
 * where a NUMERIC `trustProxy` fails closed ("hop-count-only trust cannot validate the
 * immediate peer", `fastify/lib/request.js`): `request.ip` would be the socket peer whatever
 * the count, so master's setting would silently do nothing and every client behind the proxy
 * would share one bucket again. The trade Fastify's change names is real and is the same one
 * master accepted: with hops = N, whoever can reach this port WITHOUT passing through the
 * proxy can choose `request.ip` by sending N X-Forwarded-For entries. So the port must only
 * be reachable through the proxy (bind to loopback / a private interface, or firewall it).
 * The same trust makes `request.host` / `request.protocol` proxy-asserted (`x-forwarded-host`
 * / `x-forwarded-proto` from a trusted hop); nothing in agency reads them today.
 */
export function hopCountTrust(hops: number): (address: string, hop: number) => boolean {
  return (_address, hop) => hop < hops;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 10 * 1024 * 1024,
    // master `src/index.ts:330`@a1f0756a (and core `index.ts:589`): `maxParamLength: 200`.
    // find-my-way's default is 100, so a longer path param would be Fastify's route-not-found
    // 404 instead of the route's own answer. Passed through `routerOptions` (Fastify 5's place
    // for it), as on the private core instance (`core-handlers.ts`). Phase 8 delta review.
    routerOptions: { maxParamLength: 200 },
    // Q7/Q9 (Manas, 2026-10-09): master `src/index.ts:325-329`@a1f0756a. Hop count, never
    // `true` — see `server.trustProxyHops` (`config/blocks/base.ts`). `true` trusts the
    // entire X-Forwarded-For chain, and nginx appends to it, so the client-supplied leftmost
    // entry would become `request.ip` and the IP rate limiter could be bypassed by rotating
    // the header. Passed as {@link hopCountTrust}, not the bare number — see its note. An app
    // built without a context (routing-only tests) trusts no proxy: `request.ip` is the
    // socket peer.
    trustProxy: opts.ctx ? hopCountTrust(opts.ctx.config.server.trustProxyHops) : false,
    // master `src/index.ts:331-340`@a1f0756a: the request id is the client's `x-request-id`,
    // else the active OTel trace id, else a UUID — so the id a masked 5xx body quotes
    // (`errorMaskHook`) is unique across restarts and joins the trace. Fastify's default is a
    // per-process counter (`req-1`, `req-2`, …) that repeats after every restart, which makes
    // "quote this request ID" ambiguous. PORT NOTE (magick-agency, Phase 8 review N4): the
    // trace API is imported statically rather than `require`d inside a try (the module is a
    // dependency here; master guarded an optional one).
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

  // Core's rate limiter, at APP scope as core registered it (core `src/index.ts:616-622`),
  // so every route below — including `POST /auth/session`, the agency API and the
  // super-admin tree — is charged to a bucket, not only lane C's carrier routes. Registered
  // before any route: the plugin attaches its hook from `onRoute`, so a route registered
  // earlier would be unlimited. Lane A's per-route `config.rateLimit` blocks (super-admin
  // login, the public invite routes) are honoured by this one registration, as master's
  // single global limiter honoured them. Agency's probes `/healthz`, `/readyz` are its
  // `EXEMPT_PATHS`.
  //
  // The buckets key on `request.ip`, which honours exactly `TRUST_PROXY_HOPS` proxies
  // (`trustProxy` above; Q7/Q9, Manas 2026-10-09): a spoofed leftmost X-Forwarded-For entry
  // cannot move a client into a fresh bucket, and clients behind the proxy do not share one.
  await registerRateLimit(app, opts.ctx?.redis ?? null, {
    max: opts.ctx?.config.rateLimit.max,
    webhookMax: opts.ctx?.config.rateLimit.webhookMax,
    carrierMediaMax: opts.ctx?.config.rateLimit.carrierMediaMax,
    internalMax: opts.ctx?.config.rateLimit.internalMax,
    timeWindow: opts.ctx?.config.rateLimit.timeWindow,
  });

  // Master's `errorHandler` (with the 22P02 → 400 backstop) and `errorMaskHook`, app-wide as
  // master registered them (master `src/index.ts:481,487`): every route — platform,
  // super-admin, agency, voice, analysis — answers a thrown error in master's shape, and no
  // 5xx body reaches a client (database driver text, the SQL a failed statement carried).
  // Lead ruling (Phase 8): the mask's core-forwarded 4xx branch is dropped (there is no
  // forwarded core body in one process); see `error-mask.middleware.ts`. Registered before
  // any plugin so every encapsulated scope inherits both.
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

  // core initialised the flag service with the shared Redis at boot
  // (`call-manager.ts:677@4850d1d9`, constructed before `app.listen`); without it
  // `getFeatureFlagService()` falls back to a Redis-less instance and every flag
  // read skips the snapshot cache.
  if (opts.ctx) initFeatureFlagService(opts.ctx.redis, opts.ctx.config.redis.keyPrefix);

  // One `@fastify/websocket` for the whole app (core registered it once, globally):
  // a second registration in another plugin scope would compete for the server's
  // upgrade event. Lane C's PSTN leg and the agency station socket both use it.
  await app.register(websocket);

  await app.register(platformPlugin, { ctx: opts.ctx });
  await app.register(agencyPlugin, { ctx: opts.ctx });
  await app.register(voicePlugin, { ctx: opts.ctx });
  await app.register(analysisPlugin, { ctx: opts.ctx });

  return app;
}
