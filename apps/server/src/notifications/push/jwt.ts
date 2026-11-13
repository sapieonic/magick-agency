/**
 * The two JSON Web Tokens the push carriers take, signed with `node:crypto` (no dependency):
 *
 *  - RS256: the Google OAuth assertion an FCM service account trades for an access token;
 *  - ES256: the APNs provider token. JOSE wants the raw `r || s` signature (64 bytes for P-256),
 *    not the DER `crypto.sign` gives by default, hence `dsaEncoding: 'ieee-p1363'`.
 */
import { sign, type KeyObject } from 'node:crypto';

export type JwtAlgorithm = 'RS256' | 'ES256';

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** `header.claims.signature`, each part base64url; `alg` is set in the header from `alg`. */
export function signJwt(
  alg: JwtAlgorithm,
  header: Record<string, string>,
  claims: Record<string, string | number>,
  key: KeyObject,
): string {
  const input = `${base64url(JSON.stringify({ ...header, alg }))}.${base64url(JSON.stringify(claims))}`;
  const signature = alg === 'RS256'
    ? sign('sha256', Buffer.from(input), key)
    : sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${base64url(signature)}`;
}
