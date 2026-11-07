// Plivo's V3 callback signature: every callback carries `X-Plivo-Signature-V3` (one or
// more base64 signatures, comma-separated) and `X-Plivo-Signature-V3-Nonce`. Each
// signature is base64(HMAC-SHA256(auth_token, base + '.' + nonce)), where `base` is built
// from the URL Plivo called and, for a POST, the form params:
//
//   scheme://host[:port]/path            (no query, no fragment, no user info)
//   + '?' + the URL's query, sorted      (`k=v` pairs, values decoded, joined by '&')
//   + '.'                                (only when there is a query AND post params)
//   + the post params, sorted            (`key` + `value`, concatenated, nothing between)
//
// The '?' is written whenever there is a query or there are post params; a GET folds its
// params into the query instead. Sorting is by key, then by value within a key (plain
// code-unit order). This is the construction of Plivo's own SDK; the unit test checks
// vectors computed with that SDK. One difference, deliberately: the SDK encodes its
// inputs to UTF-8 twice for non-ASCII text, this encodes once (what an HMAC over the
// request's bytes means). Plivo's callback URLs and params here are ASCII.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header names, lower-case (Fastify lower-cases incoming headers). */
export const PLIVO_SIGNATURE_V3_HEADER = 'x-plivo-signature-v3';
export const PLIVO_SIGNATURE_V3_NONCE_HEADER = 'x-plivo-signature-v3-nonce';

type Multi = Map<string, string[]>;

/** `application/x-www-form-urlencoded` decoding of one component: '+' is a space. */
function decodeComponent(s: string): string {
  const spaced = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    // A malformed escape is kept as written rather than failing the whole check.
    return spaced;
  }
}

/** Parse a raw query string (no leading '?') into key → values, in arrival order. */
function parseQuery(query: string): Multi {
  const out: Multi = new Map();
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = decodeComponent(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? '' : decodeComponent(part.slice(eq + 1));
    const list = out.get(key);
    if (list) list.push(value);
    else out.set(key, [value]);
  }
  return out;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedQueryString(params: Multi): string {
  const pairs: string[] = [];
  for (const key of [...params.keys()].sort(byCodeUnit)) {
    for (const value of [...params.get(key)!].sort(byCodeUnit)) pairs.push(`${key}=${value}`);
  }
  return pairs.join('&');
}

function sortedParamsString(params: Record<string, string>): string {
  return Object.keys(params).sort(byCodeUnit).map((k) => `${k}${params[k]}`).join('');
}

/**
 * Split a URL into its signed base (`scheme://host[:port]/path`) and raw query, as
 * written: no normalisation, so the bytes signed are the bytes Plivo was given.
 */
function splitUrl(url: string): { base: string; query: string } {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^/?#@]*@)?([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(url);
  if (!m) throw new Error('Not an absolute URL');
  const path = m[3]!;
  return { base: `${m[1]}://${m[2]}${path === '' ? '' : path.startsWith('/') ? path : `/${path}`}`, query: m[4] ?? '' };
}

/** The string Plivo signs (before `'.' + nonce`) for a callback to `url` with `params`. */
export function plivoV3SignedBase(method: 'GET' | 'POST', url: string, params: Record<string, string>): string {
  const { base, query } = splitUrl(url);
  const queryMap = parseQuery(query);
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) {
      const list = queryMap.get(k);
      if (list) list.push(v);
      else queryMap.set(k, [v]);
    }
    const q = sortedQueryString(queryMap);
    return q.length > 0 ? `${base}?${q}` : base;
  }
  const q = sortedQueryString(queryMap);
  const hasParams = Object.keys(params).length > 0;
  let out = base;
  if (q.length > 0 || hasParams) out += `?${q}`;
  if (q.length > 0 && hasParams) out += '.';
  return out + sortedParamsString(params);
}

/** base64(HMAC-SHA256(authToken, signedBase + '.' + nonce)). */
export function computePlivoV3Signature(
  authToken: string,
  method: 'GET' | 'POST',
  url: string,
  params: Record<string, string>,
  nonce: string,
): string {
  return createHmac('sha256', authToken).update(`${plivoV3SignedBase(method, url, params)}.${nonce}`).digest('base64');
}

/** Constant-time string comparison (length is not secret: every signature is 44 chars). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** A header value by name, ignoring case. */
export function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/**
 * Whether a callback's V3 signature matches any of `authTokens` (the credential's current
 * token, then any still inside the rotation grace). A missing header, nonce or token, or a
 * URL that cannot be parsed, is a mismatch.
 */
export function verifyPlivoV3Signature(
  authTokens: readonly string[],
  req: { method: 'GET' | 'POST'; url: string; params: Record<string, string>; headers: Record<string, string | undefined> },
): boolean {
  const header = headerValue(req.headers, PLIVO_SIGNATURE_V3_HEADER);
  const nonce = headerValue(req.headers, PLIVO_SIGNATURE_V3_NONCE_HEADER);
  if (!header || !nonce) return false;
  const offered = header.split(',').map((s) => s.trim()).filter(Boolean);
  if (offered.length === 0) return false;
  let base: string;
  try {
    base = plivoV3SignedBase(req.method, req.url, req.params);
  } catch {
    return false;
  }
  let matched = false;
  for (const token of authTokens) {
    if (!token) continue;
    const expected = createHmac('sha256', token).update(`${base}.${nonce}`).digest('base64');
    // No early exit: every candidate is compared, whichever matches.
    for (const sig of offered) if (safeEqual(sig, expected)) matched = true;
  }
  return matched;
}
