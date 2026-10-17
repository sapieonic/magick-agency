import type { FastifyInstance } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { isUnsafeCorePath } from '../proxy/safe-core-path.js';
import { TENANT_HEADER, ACCOUNT_HEADER, ORIGINATOR_HEADER, PROVEN_CAMPAIGN_HEADER } from './middleware/headers.js';

/*
 * `callCore`: how the public API layer's handlers reach the internal handler instance
 * (decision B16). The agency handler modules (`core-handlers.ts`) are registered on a
 * PRIVATE Fastify instance that is never listened on and is not part of the app's route
 * table; {@link callCore} runs them in-process through `inject` — no socket, no API key,
 * no service token.
 *
 * The public handlers keep their own validation, RBAC, behavioural-capability checks and
 * enrichment, and `callCore` gives them a stable request/response shape:
 *  - the query encoding (`new URLSearchParams(req.query)`, so an array value arrives
 *    comma-joined);
 *  - the body gate: a body (and a JSON content type) is sent only for POST/PUT/PATCH and
 *    only when truthy;
 *  - JSON on both sides, so a handler's `Date` reaches the caller as an ISO string;
 *  - `rawResponse` (a Buffer), and text for a non-JSON body;
 *  - the tenancy header contract: `x-mgkvc-tenant` / `x-mgkvc-account` (the private
 *    instance refuses a request without either — see `core-handlers.ts`);
 *  - the traversal refusal (`isUnsafeCorePath`), answered with a fixed 400.
 *
 * There is no transport, so there are no retries, no client span, no proxy metrics and no
 * transport error to mask.
 */

const log = createChildLogger({ component: 'core-dispatch' });

const UNSAFE_CORE_PATH_BODY = {
  error: 'Bad Request',
  message: 'Invalid path: traversal segments are not allowed',
} as const;

/** One in-process call into the internal handler instance. */
export interface CoreCallRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The handler's path under `/api/v1`, already interpolated (e.g. `/agency-campaigns/<id>/stats`). */
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  tenantId: string;
  accountId?: string;
  /** Sent as `x-mgkvc-originator`, which the handlers read with `getOriginator`. */
  originator?: string;
  /** When true, return the raw response body as a Buffer. */
  rawResponse?: boolean;
  /**
   * Accepted and ignored: in-process there is no transport to time out. Routes that bound
   * a slow read keep their own wall-clock logic where it exists.
   */
  timeoutMs?: number;
  /** Accepted and ignored (metric label of a removed series). */
  metricPath?: string;
  /** Accepted and ignored (error-mask bookkeeping with no in-process meaning). */
  recordCoreErrors?: boolean;
  /** Extra request headers a handler reads (e.g. `range` on the recording stream). */
  headers?: Record<string, string>;
  /**
   * The campaign this request has ALREADY proved the caller owns — through a full
   * `GET /agency-campaigns/:id` (the feature gate and `requireOwned`, tenant AND
   * account) with these same `tenantId`/`accountId`. Sent as
   * `x-mgkvc-proven-campaign`, which the spine's two page reads honour for the
   * campaign in their path and no other, skipping their own gate and ownership read.
   *
   * Only for a caller that has just made that probe on the same request: the CSV
   * export's page loop, which would otherwise repeat the flag read and the campaign
   * read on every one of up to 100 pages. A caller that sets it without the probe
   * reads a campaign's attempts with no ownership check at all, so
   * `test/unit/api/core-dispatch.test.ts` pins its call sites.
   */
  provenCampaignId?: string;
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
 * Run the internal handler for `req` in-process and return its status, body and headers.
 *
 * Throws when the handler table was never built (a wiring defect).
 */
export async function callCore(req: CoreCallRequest): Promise<CoreCallResult> {
  if (isUnsafeCorePath(req.path)) {
    log.warn({ path: req.path, tenantId: req.tenantId }, 'Rejected path-escaping core path');
    return { status: 400, body: { ...UNSAFE_CORE_PATH_BODY }, headers: new Headers() };
  }
  const app = coreApp;
  if (!app) throw new Error('internal handlers are not registered (agencyPlugin did not build them)');

  const queryString = req.query ? '?' + new URLSearchParams(req.query).toString() : '';
  // Tenancy comes from the typed arguments only (the tenant context at every call site),
  // never from the extra headers: the three identity headers (and the ownership-proof
  // header) are dropped from them before the context's values are written, so a
  // forwarded header can neither name another tenant, supply an account the context
  // lacks, nor claim an ownership proof nobody made.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    const lower = name.toLowerCase();
    if (
      lower === TENANT_HEADER || lower === ACCOUNT_HEADER || lower === ORIGINATOR_HEADER
      || lower === PROVEN_CAMPAIGN_HEADER
    ) continue;
    headers[name] = value;
  }
  headers[TENANT_HEADER] = req.tenantId;
  if (req.accountId) headers[ACCOUNT_HEADER] = req.accountId;
  if (req.originator) headers[ORIGINATOR_HEADER] = req.originator;
  if (req.provenCampaignId) headers[PROVEN_CAMPAIGN_HEADER] = req.provenCampaignId;

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
