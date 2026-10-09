import type { FastifyInstance } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { isUnsafeCorePath } from '../proxy/safe-core-path.js';
import { TENANT_HEADER, ACCOUNT_HEADER, ORIGINATOR_HEADER } from './middleware/headers.js';

/*
 * PORT NOTE (magick-agency): the master → core hop, collapsed (plan §1 "browser → agency",
 * decision B16). In MagickVoice every agency route in master ended in
 * `proxyToCore({ method, path, query, body, coreApiKey, tenantId, accountId })`
 * (master `src/proxy/core-client.ts`@a1f0756a), an HTTP request to core's `/api/v1/*`
 * authenticated by the tenant's core API key. Here core's handler modules (core's
 * route files, bodies verbatim, minus `authMiddleware`) are registered on a PRIVATE
 * Fastify instance that is never listened on and is not part of the app's route table,
 * and {@link callCore} runs them in-process through `inject` — no socket, no API key,
 * no S2S token.
 *
 * What is kept, so master's handlers (which keep their validation, RBAC, MAG-138 and
 * enrichment byte-for-byte) see exactly what they saw over HTTP:
 *  - the query encoding (`new URLSearchParams(req.query)`, so an array value arrives
 *    comma-joined, as it did);
 *  - the body gate: a body is sent only for POST/PUT/PATCH and only when truthy
 *    (core-client's own rule, kept for the reason it gives);
 *  - JSON on both sides, so a core `Date` reaches master as the ISO string it read;
 *  - `rawResponse` (a Buffer), and text for a non-JSON body;
 *  - core's header contract: `x-mgkvc-tenant` / `x-mgkvc-account` (core's
 *    `authMiddleware` refused a request without either, and that half is kept on the
 *    private instance — see `core-handlers.ts`);
 *  - the traversal refusal (`isUnsafeCorePath`), answered with master's exact 400.
 *
 * Gone: the API key and its resolution, retries, the OTel client span and the
 * `proxy_requests_*` series (there is no proxy), the error-mask recording
 * (`recordCoreErrorStatus`: the mask's core-4xx branch has no meaning in one process).
 */

const log = createChildLogger({ component: 'core-dispatch' });

const UNSAFE_CORE_PATH_BODY = {
  error: 'Bad Request',
  message: 'Invalid path: traversal segments are not allowed',
} as const;

/** Master's `CoreProxyRequest` minus `coreApiKey` and the two metric/mask knobs it no longer needs. */
export interface CoreCallRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Core's path under `/api/v1`, already interpolated (e.g. `/agency-campaigns/<id>/stats`). */
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  tenantId: string;
  accountId?: string;
  /** Master's `x-mgkvc-originator`, which core reads with `getOriginator`. */
  originator?: string;
  /** When true, return the raw response body as a Buffer. */
  rawResponse?: boolean;
  /**
   * Accepted for call-site fidelity with master's `proxyToCore`; in-process there is no
   * transport to time out. Master's routes that bounded a slow core read keep their own
   * wall-clock logic where it exists.
   */
  timeoutMs?: number;
  /** Accepted and ignored (metric label of a removed series). */
  metricPath?: string;
  /** Accepted and ignored (the error mask's core-status bookkeeping). */
  recordCoreErrors?: boolean;
  /** Extra request headers core reads (e.g. `range` on the recording stream). */
  headers?: Record<string, string>;
}

export interface CoreCallResult {
  status: number;
  body: unknown;
  headers: Headers;
}

let coreApp: FastifyInstance | null = null;

/** Called once by `agencyPlugin` with the private instance built by `buildCoreHandlers`. */
export function setCoreHandlers(app: FastifyInstance | null): void {
  coreApp = app;
}

export function getCoreHandlers(): FastifyInstance | null {
  return coreApp;
}

/**
 * Run core's handler for `req` in-process and return what master's `proxyToCore` would
 * have returned for the same request.
 *
 * Throws when the handler table was never built (a wiring defect, the analogue of
 * master's "core unreachable", which `proxyToCore` also surfaced as a throw).
 */
export async function callCore(req: CoreCallRequest): Promise<CoreCallResult> {
  if (isUnsafeCorePath(req.path)) {
    log.warn({ path: req.path, tenantId: req.tenantId }, 'Rejected path-escaping core path');
    return { status: 400, body: { ...UNSAFE_CORE_PATH_BODY }, headers: new Headers() };
  }
  const app = coreApp;
  if (!app) throw new Error('core handlers are not registered (agencyPlugin did not build them)');

  const queryString = req.query ? '?' + new URLSearchParams(req.query).toString() : '';
  // Tenancy comes from the typed arguments only (lane A's tenant context at every call
  // site), never from the extra headers: core's three identity headers are dropped from
  // them before the context's values are written, so a forwarded header can neither name
  // another tenant nor supply an account the context lacks.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === TENANT_HEADER || lower === ACCOUNT_HEADER || lower === ORIGINATOR_HEADER) continue;
    headers[name] = value;
  }
  headers[TENANT_HEADER] = req.tenantId;
  if (req.accountId) headers[ACCOUNT_HEADER] = req.accountId;
  if (req.originator) headers[ORIGINATOR_HEADER] = req.originator;

  const sendsBody = Boolean(req.body) && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH');
  if (sendsBody) headers['content-type'] = 'application/json';

  const res = await app.inject({
    method: req.method,
    url: `/api/v1${req.path}${queryString}`,
    headers,
    ...(sendsBody ? { payload: JSON.stringify(req.body) } : {}),
  });

  const outHeaders = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) outHeaders.append(name, String(v));
    else outHeaders.set(name, String(value));
  }

  let body: unknown;
  if (req.rawResponse) {
    body = res.rawPayload;
  } else if (outHeaders.get('content-type')?.includes('application/json')) {
    body = res.json();
  } else {
    body = res.payload;
  }
  return { status: res.statusCode, body, headers: outHeaders };
}
