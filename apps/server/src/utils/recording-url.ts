/*
 * PORT NOTE (magick-agency): ported from core `src/utils/recording-url.ts` (v1.123.2).
 * The signing secret is `config.recordingUrlSigningSecret` (env
 * RECORDING_URL_SIGNING_SECRET) — core also fell back to `config.webhooks.secret`
 * (`WEBHOOK_SECRET`), which has no counterpart here. HMAC construction, canonical
 * string, TTL and verification are core's, verbatim.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'recording-url' });

// Process-lifetime random fallback. Used only when no signing secret is
// configured — URLs signed with it become invalid on restart, which is fine
// for local dev but breaks multi-instance prod (warned at first use).
let ephemeralSecret: string | null = null;
let ephemeralWarned = false;

function getSigningSecret(): string {
  const dedicated = config.recordingUrlSigningSecret;
  if (dedicated && dedicated.length >= 16) return dedicated;
  if (!ephemeralSecret) ephemeralSecret = randomBytes(32).toString('hex');
  if (!ephemeralWarned) {
    log.warn(
      'No RECORDING_URL_SIGNING_SECRET configured — using ephemeral signing key. Signed URLs will not survive restarts or work across instances.',
    );
    ephemeralWarned = true;
  }
  return ephemeralSecret;
}

function canonicalString(callId: string, tenantId: string, accountId: string, exp: number): string {
  return `${callId}|${tenantId}|${accountId}|${exp}`;
}

function sign(value: string): string {
  return createHmac('sha256', getSigningSecret()).update(value).digest('base64url');
}

export interface SignedRecordingUrl {
  /** Path-relative URL: `/api/v1/webrtc-recordings/:id?...`. Prepend host on the client. */
  path: string;
  expiresAt: Date;
}

export function signRecordingUrl(input: {
  callId: string;
  tenantId: string;
  accountId: string;
  ttlSeconds?: number;
  /**
   * Playback route prefix the signed path points at (no trailing slash). Defaults
   * to AI calls' `/api/v1/recordings`; agency calls pass `/api/v1/webrtc-recordings`
   * so the token resolves against the right table. The signature itself is
   * basePath-independent (callId+tenant+account+exp), so `verifyRecordingToken`
   * is shared across both.
   *
   * PORT NOTE (magick-agency, Phase 8; lane D review carry-forward): the default is
   * `/api/v1/webrtc-recordings`, the only playback route agency serves. Core's default,
   * AI calls' `/api/v1/recordings`, is not ported (AI calling is out of scope), so a minter
   * that omitted `basePath` minted a link to a route that does not exist.
   */
  basePath?: string;
}): SignedRecordingUrl {
  const ttl = input.ttlSeconds ?? 3600;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = sign(canonicalString(input.callId, input.tenantId, input.accountId, exp));
  const qs = new URLSearchParams({
    tenant: input.tenantId,
    account: input.accountId,
    exp: String(exp),
    sig,
  });
  const basePath = input.basePath ?? '/api/v1/webrtc-recordings';
  return {
    path: `${basePath}/${encodeURIComponent(input.callId)}?${qs.toString()}`,
    expiresAt: new Date(exp * 1000),
  };
}

export interface VerifiedRecordingToken {
  tenantId: string;
  accountId: string;
}

/** Returns the decoded principal if the token is valid + unexpired, else null. */
export function verifyRecordingToken(
  callId: string,
  query: { tenant?: string; account?: string; exp?: string; sig?: string },
): VerifiedRecordingToken | null {
  const { tenant, account, exp, sig } = query;
  if (!tenant || !account || !exp || !sig) return null;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum)) return null;
  if (expNum < Math.floor(Date.now() / 1000)) return null;

  const expected = sign(canonicalString(callId, tenant, account, expNum));
  // Length-equal buffers required for timingSafeEqual.
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  return { tenantId: tenant, accountId: account };
}
