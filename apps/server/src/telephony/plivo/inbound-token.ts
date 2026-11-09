/**
 * The inbound webhooks' purpose token (`docs/inbound.md` §3.1): one per credential with inbound
 * enabled, carried as `?token=` on the answer and hangup URLs handed to the tenant's Plivo
 * Application. It binds a request to the credential's inbound purpose before the V3 signature is
 * checked (PL9's two checks: the token in the URL AND the signature).
 *
 * Unlike the per-call tokens (`core/bridge/ws-tokens.ts`, Redis, the call's life), this one lives
 * as long as the Application's URLs do, so it is stored durably, and only as its hash
 * (`telephony_credentials.inbound_token_hash`): the membership invite rule, a database dump holds
 * nothing replayable. The raw token exists only in the URLs given to the carrier; it is never
 * logged, audited or returned by an API. Verification hashes the presented token and compares
 * hashes in SQL (`TelephonyCredentialRepository.inboundTokenMatches`).
 */
import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url (43 characters): URL-safe with no escaping, 256 bits. */
const TOKEN_BYTES = 32;

/** sha256(token) as lower-case hex: the only form stored (`ck_telephony_credentials_inbound` holds it to 64 hex). */
export function hashInboundToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A fresh token and its hash: the token goes into the Application's URLs, the hash into the credential row. */
export function mintInboundToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashInboundToken(token) };
}
