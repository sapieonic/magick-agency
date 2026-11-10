/**
 * The URLs a tenant's inbound Plivo Application is given (`docs/inbound.md` §3.1), built in one
 * place: the super-admin Enable and Re-point write them to the carrier and store them, and the
 * inbound webhooks verify Plivo's V3 signature against what was stored.
 *
 *  - answer: `POST {base}/inbound-answer/:credentialId?token=…`
 *  - hangup: `POST {base}/inbound-status/:credentialId?token=…`
 *  - fallback answer: `PLIVO_INBOUND_FALLBACK_ANSWER_URL` as written (a static XML file hosted
 *    off this deployment, fetched with GET), else our own `POST {base}/inbound-fallback`.
 *
 * `base` is `PLIVO_WEBHOOK_BASE_URL`, this server's public base for Plivo's callbacks, the one
 * the outbound dial's URLs are built on (`core/bridge/carrier-urls.ts`): only trailing slashes
 * stripped, so host case, a port and a path prefix are kept as written.
 *
 * What is STORED on the credential (`telephony_credentials.inbound_*_url`) is each URL WITHOUT
 * the token query: the token is held only as its hash. What the carrier is GIVEN is the stored
 * URL plus `?token=<token>` ({@link withInboundToken}; the fallback carries none). A signature is
 * verified over the stored URL plus the request's own query ({@link inboundSignedUrl}), never a
 * URL rebuilt from env, because the URL lives in the tenant's Plivo account: a change to env
 * since does not move it (a Re-point does).
 */
import { normalizeWebhookBase } from '../../utils/webhook-base.js';

/** The inbound routes under Plivo's webhook namespace. */
export const PLIVO_INBOUND_ROUTES = {
  answer: 'inbound-answer',
  status: 'inbound-status',
  fallback: 'inbound-fallback',
} as const;

/** The query parameter the purpose token travels in (`inbound-token.ts`). */
export const PLIVO_INBOUND_TOKEN_PARAM = 'token';

/** The method Plivo calls a URL with (the Application's `answer_method` and the like). */
export type PlivoInboundMethod = 'GET' | 'POST';

/** One Application's URLs as stored (no token) and the method each is fetched with. */
export interface PlivoInboundUrls {
  answerUrl: string;
  hangupUrl: string;
  fallbackAnswerUrl: string;
  /** GET for an operator-hosted static file (`PLIVO_INBOUND_FALLBACK_ANSWER_URL`), POST for ours. */
  fallbackMethod: PlivoInboundMethod;
}

/** `{base}/inbound-answer/:credentialId`, as stored (no token). */
export function plivoInboundAnswerUrl(base: string, credentialId: string): string {
  return `${normalizeWebhookBase(base)}/${PLIVO_INBOUND_ROUTES.answer}/${credentialId}`;
}

/** `{base}/inbound-status/:credentialId`, as stored (no token). */
export function plivoInboundStatusUrl(base: string, credentialId: string): string {
  return `${normalizeWebhookBase(base)}/${PLIVO_INBOUND_ROUTES.status}/${credentialId}`;
}

/** Our own fallback answer route, `{base}/inbound-fallback` (no credential, no token). */
export function plivoInboundFallbackUrl(base: string): string {
  return `${normalizeWebhookBase(base)}/${PLIVO_INBOUND_ROUTES.fallback}`;
}

/**
 * The three URLs for credential `credentialId` from this server's settings now. Null when
 * `PLIVO_WEBHOOK_BASE_URL` is unset: there is no public base to give the carrier.
 */
export function plivoInboundUrls(
  settings: { webhookBaseUrl: string; inboundFallbackAnswerUrl: string },
  credentialId: string,
): PlivoInboundUrls | null {
  const base = settings.webhookBaseUrl;
  if (!base) return null;
  const external = settings.inboundFallbackAnswerUrl;
  return {
    answerUrl: plivoInboundAnswerUrl(base, credentialId),
    hangupUrl: plivoInboundStatusUrl(base, credentialId),
    fallbackAnswerUrl: external || plivoInboundFallbackUrl(base),
    fallbackMethod: external ? 'GET' : 'POST',
  };
}

/** A stored URL as the carrier is given it: with the purpose token appended. */
export function withInboundToken(storedUrl: string, token: string): string {
  return `${storedUrl}${storedUrl.includes('?') ? '&' : '?'}${PLIVO_INBOUND_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * Split a URL the carrier holds into the part we store and its token: the URL without its
 * `token` parameter (the other parameters kept, in order) and the token, or null when it has
 * none. The health check compares the first with the stored URL and checks the second against
 * the stored hash. Null for a string that is not an absolute URL.
 */
export function splitInboundToken(url: string): { stored: string; token: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const q = url.indexOf('?');
  if (q < 0) return { stored: url, token: null };
  const token = parsed.searchParams.get(PLIVO_INBOUND_TOKEN_PARAM);
  const rest = url.slice(q + 1).split('&').filter((pair) => pair !== '' && pair.split('=')[0] !== PLIVO_INBOUND_TOKEN_PARAM);
  return { stored: rest.length > 0 ? `${url.slice(0, q)}?${rest.join('&')}` : url.slice(0, q), token };
}

/**
 * The URL an inbound callback was signed over: the STORED URL plus the request's own query, as
 * it arrived (`requestUrl` is the path and query the route saw; only its `?…` is taken).
 */
export function inboundSignedUrl(storedUrl: string, requestUrl: string): string {
  const q = requestUrl.indexOf('?');
  return q >= 0 ? `${storedUrl}${requestUrl.slice(q)}` : storedUrl;
}
