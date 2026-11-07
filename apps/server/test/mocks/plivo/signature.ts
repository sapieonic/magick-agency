/**
 * Plivo's V3 callback signature, as the mock carrier SIGNS its callbacks: an independent
 * port of the construction in Plivo's own SDK (`validateV3Signature` / `construct_post_url`
 * in `utils/v3Security.js`), deliberately not `src/telephony/plivo/plivo-signature.ts`, so an
 * end-to-end test that passes is not the server agreeing with itself. It parses the URL
 * with WHATWG `URL` and `node:querystring` where the server's checker uses its own
 * splitter, and it builds the string the way the SDK does:
 *
 *   scheme://host[:port]/path
 *   + '?' + sorted `k=v` of the query            (when there is a query or post params)
 *   + '.'                                          (when there are both)
 *   + sorted `key` + `value` of the post params
 *
 * then base64(HMAC-SHA256(auth_token, that + '.' + nonce)).
 */
import { createHmac, randomBytes } from 'node:crypto';
import querystring from 'node:querystring';

const sortCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function plivoSignedString(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  let base = `${u.protocol}//${u.host}${u.pathname}`;
  const query = querystring.parse(u.search.startsWith('?') ? u.search.slice(1) : u.search);
  const pairs: string[] = [];
  for (const key of Object.keys(query).sort(sortCodeUnits)) {
    const raw = query[key];
    const values = (Array.isArray(raw) ? raw : [raw ?? '']).slice().sort(sortCodeUnits);
    for (const v of values) pairs.push(`${key}=${v}`);
  }
  const q = pairs.join('&');
  const hasParams = Object.keys(params).length > 0;
  if (q.length > 0 || hasParams) base += `?${q}`;
  if (q.length > 0 && hasParams) base += '.';
  return base + Object.keys(params).sort(sortCodeUnits).map((k) => `${k}${params[k]}`).join('');
}

export function signPlivoCallback(authToken: string, url: string, params: Record<string, string>, nonce: string): string {
  return createHmac('sha256', authToken).update(`${plivoSignedString(url, params)}.${nonce}`).digest('base64');
}

/** A fresh nonce, as Plivo sends one per callback. */
export function plivoNonce(): string {
  return randomBytes(10).toString('hex');
}
