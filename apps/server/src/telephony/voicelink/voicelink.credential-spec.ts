// VoiceLink's tenant credential (docs/carriers.md CR2, CR3): a tenant's own VoiceLink login.
// The username is public (the account ref super-admins see, unique per carrier); the password is
// sealed and write-only (B19, B20). The API host is this deployment's (`VOICELINK_BASE_URL`, read
// from `ctx.telephony`), never the tenant's. Listed in `../credentials/credential-specs.ts`.
//
// No `listNumbers`: VoiceLink has no API that lists an account's numbers, so a tenant's VoiceLink
// numbers are added by hand and pinned to the credential (CR6).
import { z } from 'zod';
import type { CredentialCheck, CredentialSpec, FetchLike } from '../credentials/credential-specs.js';
import { TELEPHONY_ACCOUNT_REF_MAX_LENGTH } from '../credentials/account-ref.js';

/** The login check's bound (CR3), on the request and the body read together. */
export const VOICELINK_CHECK_TIMEOUT_MS = 10_000;

/** Any C0 or C1 control character, or DEL: never part of a username a person types. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The account ref of a VoiceLink login: the username lower-cased. The unique index on
 * `(provider, account_ref)` compares exactly, while the reserved-username check (CR3) ignores
 * case, so without this `Acme` and `acme` could both be registered for what is likely one
 * VoiceLink login. Only the ref is lower-cased: `public_config.username` keeps the case typed,
 * and it is what every login sends (the check below, the tenant adapter).
 */
export function voicelinkAccountRef(username: string): string {
  return username.toLowerCase();
}

/** Login answers that refuse the credential itself (CR3): wrong login, locked account, invalid fields. */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403, 422]);

/**
 * The verdict on a VoiceLink login answer: a 2xx carrying a non-empty `data.access_token` is
 * `ok`; 401, 403 and 422 are `rejected`; anything else (another status, a body with no token
 * or not JSON) says nothing about the credential and is `unreachable`.
 */
async function loginVerdict(res: Awaited<ReturnType<FetchLike>>): Promise<CredentialCheck> {
  if (REFUSED_STATUSES.has(res.status)) {
    return { result: 'rejected', reason: `VoiceLink refused the login (HTTP ${res.status})` };
  }
  if (res.status < 200 || res.status >= 300) return { result: 'unreachable', reason: `VoiceLink answered HTTP ${res.status}` };
  if (!res.json) return { result: 'unreachable', reason: 'VoiceLink sent an unreadable answer' };
  const body = (await res.json()) as { data?: { access_token?: unknown } } | null;
  const token = body?.data?.access_token;
  if (typeof token !== 'string' || token.length === 0) {
    return { result: 'unreachable', reason: 'VoiceLink accepted the login but sent no token' };
  }
  return { result: 'ok' };
}

export const voicelinkSpec: CredentialSpec = {
  provider: 'voicelink',
  displayName: 'VoiceLink',
  fields: [
    {
      key: 'username', label: 'Username', secret: false,
      help: 'The username the tenant signs in to the VoiceLink portal with. Their VoiceLink account manager can confirm it.',
    },
    { key: 'password', label: 'Password', secret: true, help: 'The password for that VoiceLink login. Write-only: it is never shown again.' },
  ],
  // At most 100 characters, the width of `telephony_credentials.account_ref`, lower-cased too
  // (a few letters grow when lower-cased), so a long one is a field error and never a 22001.
  publicSchema: z.object({
    username: z.string().trim()
      .min(1, 'Enter the VoiceLink username')
      .max(TELEPHONY_ACCOUNT_REF_MAX_LENGTH, `The username is longer than ${TELEPHONY_ACCOUNT_REF_MAX_LENGTH} characters`)
      .refine((v) => !CONTROL_CHARS.test(v), 'The username has a character that cannot be typed')
      .refine((v) => voicelinkAccountRef(v).length <= TELEPHONY_ACCOUNT_REF_MAX_LENGTH, `The username is longer than ${TELEPHONY_ACCOUNT_REF_MAX_LENGTH} characters`),
  }).strict(),
  // Not trimmed: a password may begin or end with a space. Blank is refused.
  secretSchema: z.object({
    password: z.string()
      .min(1, 'Enter the VoiceLink password')
      .max(255, 'The password is longer than 255 characters')
      .refine((v) => v.trim().length > 0, 'Enter the VoiceLink password'),
  }).strict(),
  accountRef: (p) => voicelinkAccountRef(p['username']!),
  hintSource: (s) => s['password']!,

  /**
   * `POST <VOICELINK_BASE_URL>/v1/auth/login` with the credential's username and password
   * (CR3). Redirects are refused, so the password cannot be forwarded to another host, and the
   * request and its body are bounded by {@link VOICELINK_CHECK_TIMEOUT_MS}. While the base URL is
   * unset, nothing is sent and the answer is `unreachable`.
   */
  async check(publicConfig, secret, ctx = {}) {
    const baseUrl = ctx.telephony?.voicelink.baseUrl?.trim() ?? '';
    if (baseUrl === '') return { result: 'unreachable', reason: 'VoiceLink is not set up on this server (no API address)' };
    const fetchImpl = ctx.fetch ?? (fetch as FetchLike);
    try {
      const res = await fetchImpl(`${baseUrl}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: publicConfig['username'], password: secret['password'] }),
        redirect: 'error',
        signal: AbortSignal.timeout(VOICELINK_CHECK_TIMEOUT_MS),
      });
      return await loginVerdict(res);
    } catch (err) {
      // The error's text is never echoed: a network error can carry the request.
      const name = err instanceof Error ? err.name : 'Error';
      if (name === 'SyntaxError') return { result: 'unreachable', reason: 'VoiceLink sent an unreadable answer' };
      return { result: 'unreachable', reason: name === 'TimeoutError' ? 'VoiceLink did not answer in time' : 'VoiceLink could not be reached' };
    }
  },

  /** The service's own VoiceLink login (`VOICELINK_USERNAME`), when one is configured (CR3). */
  reservedAccountRefs: (telephony) => {
    const own = telephony.voicelink.username?.trim() ?? '';
    return own === '' ? [] : [own];
  },
};
