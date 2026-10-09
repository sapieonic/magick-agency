// The app-wide rate limiter, registered once, globally, in `app.ts`.
//
// There are no API keys, so no bucket is keyed on a client-supplied header: unauthenticated
// traffic keys on the IP. A header that authenticates nothing would be an unauthenticated
// bucket-rotation knob — a fresh value per request would reset every IP budget (including
// `POST /super-admin/login`'s 5/minute, since per-route configs inherit this `keyGenerator`),
// a client-chosen value would grow the Redis key space without bound, and a duplicated header
// could make the `keyGenerator` throw (a 500 on any route).
//
// The bucket predicates, prefix tables and `RATE_LIMIT_ROUTE_CLASSES` also cover surfaces this
// app does not serve (AI media-stream, static/IVR calls, tts-audio, messaging, `/internal/*`):
// the predicate is the contract, so a route added later lands in the right bucket without
// re-deciding it here.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import rateLimit from '@fastify/rate-limit';
import { createChildLogger } from '@magick-agency/observability';
import { trackRateLimitRejected } from '@magick-agency/observability/metrics/voice';

const log = createChildLogger({ component: 'rate-limit' });

const DEFAULT_MAX = 200;
const DEFAULT_WEBHOOK_MAX = 1000;
const DEFAULT_CARRIER_MEDIA_MAX = 600;
const DEFAULT_INTERNAL_MAX = 1000;
const DEFAULT_WINDOW = '1 minute';

/**
 * Unauthenticated carrier/provider webhooks all mount under this prefix
 * (telephony status + answer callbacks, WhatsApp, Telegram, GREEN-API, Resend).
 * They are keyed and budgeted separately from tenant API traffic — see
 * {@link registerRateLimit}.
 */
const WEBHOOK_PATH_PREFIX = '/api/v1/webhooks';

/**
 * Carrier-facing media paths: the AI media-stream WS upgrade, the WS-static one
 * nested beneath it (`/api/v1/media-stream/static`, so the prefix below already
 * covers it — see `ws-static-media-url.ts` for why it nests), the legacy static
 * prefix retained for rolling deploys, and the unauthenticated pre-generated-TTS
 * clip an XML carrier fetches from `<Play>`.
 *
 * These share the *client IPs* of the webhook traffic above but must not share
 * its bucket: a webhook storm that exhausted this budget would 429 a WebSocket
 * upgrade, and a 429 on an upgrade is not a retryable failure — it is a live
 * callee hearing silence for the rest of the call.
 *
 * The two WebRTC human-bridge media legs join this bucket as well — see
 * {@link WEBRTC_MEDIA_LEG_SUFFIXES}, which cannot be expressed as a prefix.
 *
 * They are ONE bucket rather than several because they scale with the same dial
 * rate from the same carrier on the same call, so splitting them further would
 * not remove any cross-purpose exhaustion risk — unlike the split from the
 * self-amplifying webhook stream, which does. Two consequences worth stating:
 * a media upgrade can still be starved by clip fetches on the same batch (~2
 * requests per call against a 600/min default, so ~6.8x headroom at the
 * observed ~44 calls/min), and `/api/v1/tts-audio/:hash` — unauthenticated and
 * NOT token-gated — moves from the 200/min shared ceiling to this higher one.
 * That is a deliberate trade: it is the same handful of carrier IPs, and the
 * endpoint serves an immutable content-addressed clip from disk.
 */
const CARRIER_MEDIA_PATH_PREFIXES = [
  '/api/v1/media-stream',
  '/api/v1/static-media-stream',
  '/api/v1/tts-audio',
] as const;

/**
 * The WebRTC human-bridge media legs — `/api/v1/webrtc-call/:id/{pstn,browser}-stream`.
 *
 * Matched on a SUFFIX under the parent prefix rather than by prefix, because the
 * parent (`/api/v1/webrtc-call`) is authenticated HTTP control API and belongs in
 * the `ip` bucket; only these two leaves are unauthenticated WebSocket upgrades
 * registered at the plugin root (`webrtc-call.routes.ts` — the auth hook is scoped
 * to an encapsulated child). The `pstn-stream` leg is dialled by the carrier from the
 * same carrier egress IPs as the webhooks, and `browser-stream` is the live
 * agent's own socket: a 429 on either drops the upgrade and the bridge is silent
 * for the rest of the call.
 */
const WEBRTC_MEDIA_PARENT_PREFIX = '/api/v1/webrtc-call';
const WEBRTC_MEDIA_LEG_SUFFIXES = ['/pstn-stream', '/browser-stream'] as const;

/** Control-plane prefix (bearer-authenticated callers). No route is served there today. */
const INTERNAL_PATH_PREFIX = '/internal';

/**
 * Liveness/readiness probes, exempted outright. A 429 here fails the readiness
 * gate and takes the replica out of service — the limiter would be causing the
 * outage it exists to prevent — and a probe endpoint that returns a static body
 * is not a resource worth protecting. (`/metrics` needs no entry: this app
 * registers no such route.)
 */
// The probe paths `app.ts` serves. A probe missing from this list would land in the `ip`
// bucket, where a 429 fails the readiness gate.
const EXEMPT_PATHS = ['/healthz', '/readyz'] as const;

/**
 * The bucket a request is charged to. Also the `bucket_kind` metric label, so
 * this union is a closed, code-owned set — do not derive a value from a request.
 */
export type RateLimitBucketKind =
  | 'exempt'
  | 'webhook'
  | 'carrier_media'
  | 'internal'
  | 'ip';

/** `exempt` requests are never counted, never limited, and so never rejected. */
export type RateLimitRejectedBucketKind = Exclude<RateLimitBucketKind, 'exempt'>;

/**
 * Route classes for the 429 counter's `route_class` label.
 *
 * Deliberately COARSE and bounded by this table rather than by traffic. The two
 * obvious alternatives are both wrong here: `request.url` carries `:callId`,
 * `:staticCallId` and a `?token=` (a series per call, and a live credential in
 * the metric store), and `request.routeOptions.url` — the matched pattern, which
 * `api_requests_total` records through `routeMetricLabel` — would
 * multiply ~250 route patterns by the bucket kinds. This label only has to
 * answer "which surface is being throttled", which the risk classes below
 * already do.
 */
export const RATE_LIMIT_ROUTE_CLASSES = [
  'webhooks',
  'media_stream',
  'tts_audio',
  'internal',
  'health',
  'calls',
  'static_calls',
  'ivr_calls',
  'agency',
  'messaging',
  'api',
  'other',
] as const;

export type RateLimitRouteClass = (typeof RATE_LIMIT_ROUTE_CLASSES)[number];

/**
 * Ordered prefix → class table, first match wins, so the more specific prefixes
 * must stay above `/api/v1`. Mirrors the registration prefixes in `src/index.ts`.
 */
const ROUTE_CLASS_PREFIXES: ReadonlyArray<readonly [string, RateLimitRouteClass]> = [
  [WEBHOOK_PATH_PREFIX, 'webhooks'],
  ['/api/v1/media-stream', 'media_stream'],
  ['/api/v1/static-media-stream', 'media_stream'],
  ['/api/v1/tts-audio', 'tts_audio'],
  [INTERNAL_PATH_PREFIX, 'internal'],
  // Currently unreachable from `routeClassFor`, which is only called for a
  // REJECTED request, and a probe is exempt so it can never be rejected. Kept
  // deliberately: the table doubles as the map of surfaces, and if the exemption
  // is ever narrowed the class already exists rather than collapsing to `other`.
  ['/healthz', 'health'],
  ['/readyz', 'health'],
  ['/api/v1/calls', 'calls'],
  // The bulk-dispatch surfaces get their own classes rather than falling into
  // `api`: they are the ones a tenant client is most likely to be throttled on,
  // and "a batch dispatch is being refused" and "a CRUD read is being refused"
  // are different operator actions.
  ['/api/v1/static-calls', 'static_calls'],
  ['/api/v1/ivr-calls', 'ivr_calls'],
  // The agency API is served at the console's paths (decision B16); without the
  // `/proxy/agency` and `/dnc` rows every throttled console request would be labelled
  // `other`. The `/api/v1/agency*` rows match no public route (those paths exist only on
  // the internal handler instance).
  ['/proxy/agency', 'agency'],
  ['/dnc', 'agency'],
  ['/api/v1/agency', 'agency'],
  ['/api/v1/agency-campaigns', 'agency'],
  ['/api/v1/agency-agents', 'agency'],
  ['/api/v1/messaging', 'messaging'],
  ['/api/v1', 'api'],
];

/**
 * The path portion of a request URL.
 *
 * Tolerates a missing url rather than throwing: this runs inside
 * `keyGenerator`, and a throwing key generator fails the request itself — a
 * 500 on every call would be a far worse outcome than mis-bucketing one.
 */
function pathOf(url: string | undefined): string {
  if (!url) return '';
  // `request.url` carries the query string (VoiceLink's status callback is
  // `…/static-status/:callId?token=…`), so compare on the path only.
  return url.split('?', 1)[0] ?? '';
}

/** Prefix match on a path BOUNDARY, so `/api/v1/calls` can't match `/api/v1/call-ids`. */
function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** True for any request routed to a provider webhook endpoint. */
function isWebhookPath(path: string): boolean {
  return hasPrefix(path, WEBHOOK_PATH_PREFIX);
}

/**
 * True for the two unauthenticated WebRTC media legs, and NOT for the
 * authenticated control API above them — see {@link WEBRTC_MEDIA_LEG_SUFFIXES}.
 * Shared by `budgetFor` and `routeClassFor` so the bucket and the label can't
 * disagree about what counts as a media leg.
 */
function isWebrtcMediaLeg(path: string): boolean {
  if (!hasPrefix(path, WEBRTC_MEDIA_PARENT_PREFIX)) return false;
  return WEBRTC_MEDIA_LEG_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/** True for any carrier-facing media/clip path — the `carrier_media` bucket. */
function isCarrierMediaPath(path: string): boolean {
  return CARRIER_MEDIA_PATH_PREFIXES.some((p) => hasPrefix(path, p)) || isWebrtcMediaLeg(path);
}

/**
 * Which bucket this request belongs to — the SINGLE decision that `keyGenerator`,
 * `max` and `allowList` must all agree on.
 *
 * They have to share it rather than each testing the path: if `max` and
 * `keyGenerator` decided separately, a request could be measured against one
 * bucket's ceiling while counted in another's key — putting two budgets in one
 * counter, which is precisely what namespacing exists to prevent. The regression test asserts
 * that invariant (webhook ceiling iff `wh:` key) across every auth/path
 * combination; extend it here rather than adding a parallel decision path.
 *
 * The plugin calls this two to four times per request — `keyGenerator` and
 * `allowList` always, `max` only for a non-exempt one, and `onExceeded` again on
 * a rejection — so it must stay allocation-light, synchronous and
 * side-effect-free. Memoising it on the request would be a fifth place the
 * decision could go stale, for a couple of `startsWith` calls saved.
 *
 * Order is load-bearing:
 *  - `exempt` first, so a probe is never limited whatever headers it carries;
 *  - `/internal/*` is checked on the path and NOT on `Authorization: Bearer`,
 *    which is what it actually authenticates with: a request that forgot the
 *    header would otherwise silently land in a different bucket than the one
 *    the route serves.
 *
 * ⚠️ **Classification is pre-authentication, so the raised ceilings are
 * claimable by anyone who can reach the path.** The limiter runs in `onRequest`,
 * ahead of `internalAuthMiddleware`, so 1000 unauthenticated (401) requests to
 * `/internal/x` still consume the `int:` budget rather than the `ip` one — one
 * IP's total allowance across all buckets is the SUM of the ceilings, not
 * `RATE_LIMIT_MAX`. That is the accepted cost of namespacing on the path (see
 * `rateLimitSchema` in `config/blocks/voice.ts`); making `int:` genuinely
 * caller-restricted would mean assigning the bucket in a post-auth hook, which is
 * a different design.
 *
 * Every IP-keyed bucket assumes `request.ip` identifies a client. Decisions Q7/Q9:
 * `app.ts` sets `trustProxy` to `TRUST_PROXY_HOPS` (`server.trustProxyHops`,
 * default 1) — a hop count, never `true` — so `request.ip` is the address the last
 * trusted proxy observed. A client cannot rotate `X-Forwarded-For` to evade these
 * buckets (an extra leftmost entry is beyond the trusted hops and ignored), and
 * clients behind the proxy do not share one bucket.
 */
export function budgetFor(
  request: { url?: string; headers: Record<string, unknown> },
): RateLimitBucketKind {
  const path = pathOf(request.url);
  // EXACT match, deliberately not `hasPrefix`: exemption means *unlimited*, and
  // neither probe has sub-routes, so a prefix match would leave `/health/<junk>`
  // — an arbitrary-volume 404 path — as the one uncapped surface at the edge.
  if (EXEMPT_PATHS.some((p) => path === p)) return 'exempt';
  if (isWebhookPath(path)) return 'webhook';
  if (isCarrierMediaPath(path)) return 'carrier_media';
  if (hasPrefix(path, INTERNAL_PATH_PREFIX)) return 'internal';
  return 'ip';
}

/** Bounded slug for the 429 counter. Never a URL — see {@link RATE_LIMIT_ROUTE_CLASSES}. */
export function routeClassFor(url: string | undefined): RateLimitRouteClass {
  const path = pathOf(url);
  // Checked ahead of the prefix table: these two leaves live under the
  // authenticated `/api/v1/webrtc-call` control API, which the table would
  // otherwise classify as plain `api`.
  if (isWebrtcMediaLeg(path)) return 'media_stream';
  for (const [prefix, cls] of ROUTE_CLASS_PREFIXES) {
    if (hasPrefix(path, prefix)) return cls;
  }
  return 'other';
}

export interface RateLimitOptions {
  /** Max requests per window per key. Default 200. */
  max?: number;
  /** Max requests per window for `/api/v1/webhooks/*`. Default 1000 (`DEFAULT_WEBHOOK_MAX`). */
  webhookMax?: number;
  /** Max requests per window for carrier-facing media/clip paths. Default 600. */
  carrierMediaMax?: number;
  /** Max requests per window for `/internal/*` traffic. Default 1000. */
  internalMax?: number;
  /** Window size (fastify-rate-limit duration string or ms). Default '1 minute'. */
  timeWindow?: string | number;
}

/**
 * Register the global rate limiter.
 *
 * When a Redis client is provided the limiter uses it as its store, so the
 * budget is enforced **cluster-wide** rather than per-replica (N replicas
 * previously meant an effective `max × N` limit that also reset on every
 * deploy). Without Redis it falls back to the plugin's in-memory store.
 *
 * Because moving to a shared store lowers the *effective* cluster-wide ceiling
 * (from `max × N` to `max`), `max`/`timeWindow` are configurable (env
 * `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW`) so operators can right-size the budget
 * without a code change.
 *
 * The rate-limit key is the bucket's namespace plus the client IP (see
 * `keyGenerator`); no client-supplied header picks it.
 *
 * **Traffic is split into per-purpose buckets, each with its own ceiling.** A
 * request can only key on the client IP — and one client IP can be an entire
 * carrier. A single bucket put an entire call batch's lifecycle traffic under ONE
 * API-sized ceiling:
 * on 2026-09-03 a ~3k-call VoiceLink static batch sustained ~220 webhooks/min
 * against a 200/min ceiling and had 17.5k status callbacks rejected with 429 —
 * and because the carrier retries a rejected delivery, the breach fed itself.
 * The namespaces are what make a per-request `max` meaningful at all: the plugin
 * keeps one counter per key, so without them whichever request happened to trip
 * the limit would decide which ceiling applied.
 *
 * | bucket          | key            | why it is separate |
 * |-----------------|----------------|--------------------|
 * | `webhook`       | `wh:<ip>`      | Volume scales with DIAL RATE, not tenant API usage — several lifecycle callbacks per call, all from a handful of carrier IPs. |
 * | `carrier_media` | `cm:<ip>`      | Same IPs, but a 429 on a WS upgrade is dead air on a live call, not a retryable failure. Must not be exhaustible by a webhook storm. Covers the AI + WS-static media streams, the pre-generated TTS clip, and both WebRTC bridge legs. |
 * | `internal`      | `int:<ip>`     | Control-plane callers authenticate with `Authorization: Bearer` from a few egress IPs and retry, so at the `ip` ceiling a breach would amplify exactly as the incident did. |
 * | `ip`            | `<ip>`         | Everything else, including the authenticated API. |
 * | `exempt`        | (not limited)  | `/healthz`, `/readyz` (exact paths only) — a 429 here fails the readiness gate. |
 *
 * One consequence of exempting the probes: the plugin's store errors are not
 * swallowed (`skipOnError` is left at its default `false`), so during a Redis
 * outage limited traffic 500s, but the exempt probes never reach the limiter.
 * Readiness still fails in that outage because `/readyz` pings Redis itself
 * (`app.ts`). Degrading a limiter store failure to unlimited (`skipOnError: true`)
 * would be a deliberate change of its own and is NOT made here.
 *
 * Note every ceiling is still a ceiling: webhook and carrier-media volume grow
 * with dial rate, so raising per-account concurrency requires raising
 * `RATE_LIMIT_WEBHOOK_MAX` (and `RATE_LIMIT_CARRIER_MEDIA_MAX`) with it. That
 * dependency is exactly why the `rate_limit_rejected_total` counter below exists
 * — the previous breach was invisible until someone went looking in the logs.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  redis?: Redis | null,
  opts?: RateLimitOptions,
): Promise<void> {
  const max = opts?.max ?? DEFAULT_MAX;
  const webhookMax = opts?.webhookMax ?? DEFAULT_WEBHOOK_MAX;
  const carrierMediaMax = opts?.carrierMediaMax ?? DEFAULT_CARRIER_MEDIA_MAX;
  const internalMax = opts?.internalMax ?? DEFAULT_INTERNAL_MAX;
  const timeWindow = opts?.timeWindow ?? DEFAULT_WINDOW;

  const ceilings = { max, webhookMax, carrierMediaMax, internalMax, timeWindow };
  if (redis) {
    log.info(ceilings, 'Rate limiter using Redis store (cluster-wide limits)');
  } else {
    log.warn(ceilings, 'Rate limiter using in-memory store (per-replica limits) — no Redis client provided');
  }

  /** Ceiling per bucket. `exempt` is unreachable (allowList short-circuits first). */
  const maxFor = (kind: RateLimitBucketKind): number => {
    switch (kind) {
      case 'webhook': return webhookMax;
      case 'carrier_media': return carrierMediaMax;
      case 'internal': return internalMax;
      case 'ip': return max;
      // `exempt` is never limited, so its ceiling is unreachable — but it is
      // enumerated rather than swallowed by a `default`, because a `default`
      // here would silently hand a NEWLY ADDED bucket kind the shared `ip`
      // ceiling instead of its own — exactly the kind of drift no test would
      // catch. Adding a kind must fail
      // the compiler here and in `keyGenerator` below.
      case 'exempt': return max;
      default: {
        const unreachable: never = kind;
        return unreachable;
      }
    }
  };

  await app.register(rateLimit, {
    // Per-request ceiling. Keyed off the SAME predicate as `keyGenerator` and
    // `allowList` (`budgetFor`), so the bucket a request lands in and the budget
    // it is measured against can never disagree — one counter never holds two
    // ceilings.
    max: (request) => maxFor(budgetFor(request)),
    timeWindow,
    ...(redis ? { redis } : {}),
    // Probes are exempted through the shared predicate rather than per-route
    // `config: { rateLimit: false }`, so the exemption stays visible in the one
    // place every other bucket decision is made (and stays testable alongside
    // the `max`/`keyGenerator` invariant). The plugin runs `keyGenerator` before
    // consulting this, so an exempt request still computes a key — it is simply
    // never counted against it.
    allowList: (request) => budgetFor(request) === 'exempt',
    keyGenerator: (request) => {
      // Namespaced so one purpose's storm can't exhaust another's budget for the
      // same client IP. Resolved from `budgetFor` first so it stays in lockstep
      // with `max` above.
      const kind = budgetFor(request);
      switch (kind) {
        case 'webhook': return `wh:${request.ip}`;
        case 'carrier_media': return `cm:${request.ip}`;
        case 'internal': return `int:${request.ip}`;
        // `exempt` is not limited, but the plugin still computes a key for it
        // before consulting `allowList`, so it needs a value. The plain IP is
        // the honest one — nothing is ever counted against it.
        case 'exempt': case 'ip': return request.ip;
        // Exhaustive on purpose — see the note in `maxFor` above.
        default: {
          const unreachable: never = kind;
          return unreachable;
        }
      }
    },
    // The ONLY 429 emission point. The plugin calls it exactly once per rejected
    // request, immediately before throwing the 429, and its re-entry latch
    // (`rateLimitRan`) means a request cannot be counted twice. It is `onExceeded`
    // and NOT `onExceeding`, which fires on every request that is *not* exceeded
    // and is therefore an allowed-request hook, not a rejection signal. Counting
    // here rather than inferring from the error handler also keeps 429s we raise
    // elsewhere out of the series. `bucket_kind` comes from the same predicate
    // that charged the bucket, so the metric cannot drift from the ceiling in
    // effect.
    //
    // Wrapped: the plugin awaits this hook inside the request path, so a throw
    // here would turn the intended 429 into a 500 — the same failure mode this
    // file's header calls out for `keyGenerator`. `trackRateLimitRejected`
    // already guards both metric writes with `safeEmit`, so this is depth rather
    // than the only defence, and it must never swallow anything but its own
    // observability work.
    onExceeded: (request: FastifyRequest) => {
      try {
        const kind = budgetFor(request);
        // Narrowing, not a guess: `allowList` returns true for `exempt`, so the
        // plugin cannot reach this hook with one.
        if (kind === 'exempt') return;
        trackRateLimitRejected(kind, routeClassFor(request.url));
      } catch {
        // Losing one 429 sample is strictly better than converting a rate-limit
        // rejection into a server error.
      }
    },
    errorResponseBuilder: (_request, context) => {
      return {
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${Math.round(context.ttl / 1000)} seconds.`,
        statusCode: 429,
        retryAfter: Math.round(context.ttl / 1000),
      };
    },
  });
}
