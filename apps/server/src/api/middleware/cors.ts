// CORS for a deployment where the console is served from one host and calls the API on
// another (`CORS_ALLOWED_ORIGINS`, `config/blocks/base.ts`). Registered once, app-wide, by
// `app.ts`, and only when the allow-list is non-empty: the single-origin deployment (the
// console on its own origin, nginx proxying the API paths) registers nothing and answers no
// preflight, exactly as before.
//
// What a cross-origin console needs, and why each option is what it is:
//  - **origin**: the exact allow-list, decided per request by {@link corsOptionsFor}. A listed
//    `Origin` gets `Access-Control-Allow-Origin: <that origin>`, the expose list and, on a
//    preflight, the preflight headers. An unlisted or missing `Origin` gets CORS turned off for
//    that request (`origin: false`): no CORS headers at all, and an `OPTIONS` falls through to
//    the plugin's `OPTIONS *` route, which answers 404 as it did before CORS existed. So a
//    webhook, a media route, a mobile call or `/healthz` carries no CORS headers.
//  - **Vary: Origin on every response**: per-request options make the plugin add it always,
//    and that is the fetch spec's advice: a shared cache must not hand a response stored for one
//    origin (or for none) to another origin.
//  - **credentials: false**: the console authenticates with `Authorization: Bearer`, never a
//    cookie, so there is nothing for the browser to attach and no reason to allow it.
//  - **allowedHeaders unset**: `@fastify/cors` reflects the preflight's
//    `Access-Control-Request-Headers`. The origin is the gate; a fixed header list would only
//    break the console the day it sends a new header (`X-Tenant-Id`, `X-Account-Id`, the
//    originator header, ... today).
//  - **exposedHeaders**: a cross-origin `fetch` can read only the CORS-safelisted response
//    headers unless the rest are listed here. {@link CORS_EXPOSED_HEADERS} is every other
//    header the console and `@magick-agency/web-ui` read; a guard test scans their sources so
//    a new `headers.get('x-…')` cannot ship unexposed.
//  - **maxAge 7200**: the browser caches a preflight per URL and method for this long
//    (Chromium caps it at 2 hours), so a route is not preflighted on every call.
//
// Preflights are answered in this plugin's app-level `onRequest` hook (pinned below as
// `hook: 'onRequest'`), which runs before every route-level hook, and the plugin's own
// `OPTIONS *` route is registered before `registerRateLimit` (`app.ts`), so the limiter's
// `onRoute` never attaches to it either. Either one alone keeps a preflight off the rate-limit
// buckets; keep both. The auth middleware never sees a preflight, which carries no
// `Authorization` header. The trade: preflights are charged to no bucket at all, which is
// acceptable because each one is a header-only 204 from the hook (no Redis, no database).
//
// WebSockets are not affected: a browser applies no CORS to an upgrade, and the station socket
// authenticates with its single-use token.

import type { FastifyInstance } from 'fastify';
import cors, { type FastifyCorsOptions } from '@fastify/cors';

/** The response headers a cross-origin console must be able to read (lower case). */
export const CORS_EXPOSED_HEADERS = [
  // Correlation id on masked 5xx answers (`error-mask.middleware.ts`), which the console's
  // error text quotes (`@magick-agency/web-ui` errors).
  'x-request-id',
  // 429 and 503 answers; the console shows when to try again.
  'retry-after',
  // Activity and export truncation notices.
  'x-activity-row-limit',
  'x-activity-truncated',
  'x-export-row-limit',
  'x-export-rows',
  'x-export-truncated',
  'x-export-truncated-reason',
  // The customer-history export's file name (`proxy-agency-customers/export.ts`): the console
  // names the download from it (it carries the date, never the number).
  'content-disposition',
] as const;

/** Every method a console route uses. */
export const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** How long (seconds) a browser may cache one preflight answer. */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 7200;

/**
 * The CORS options for one request: the full set for a listed `Origin`, else CORS off
 * (`origin: false`). The allow-list holds normalised origins (`config/blocks/base.ts`), which is
 * the form a browser sends.
 */
export function corsOptionsFor(allowed: ReadonlySet<string>, origin: string | undefined): FastifyCorsOptions {
  if (origin === undefined || !allowed.has(origin)) return { origin: false };
  return {
    origin,
    methods: [...CORS_METHODS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    credentials: false,
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  };
}

export async function registerCors(app: FastifyInstance, allowedOrigins: readonly string[]): Promise<void> {
  if (allowedOrigins.length === 0) return;
  const allowed = new Set(allowedOrigins);
  await app.register(cors, {
    hook: 'onRequest',
    delegator: (req, cb) => cb(null, corsOptionsFor(allowed, req.headers.origin)),
  });
}
