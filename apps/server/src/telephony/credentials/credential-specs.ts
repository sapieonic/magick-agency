// What a tenant credential looks like for each carrier that accepts one (decision B18):
// the form fields, how to validate them, which value is the public account id, and
// how to ask the carrier whether the credential works. VoiceLink is the service's own
// account (env) and has no spec here.
import { z } from 'zod';
import type { TelephonyCredentialField } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';

/** The carrier's verdict on a credential. */
export type CredentialCheck =
  | { result: 'ok' }
  /** The carrier refused the credential (401/403). */
  | { result: 'rejected'; reason: string }
  /** The carrier could not be asked (network, timeout, 5xx). Says nothing about the credential. */
  | { result: 'unreachable'; reason: string };

export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'status'>>;

export interface CredentialSpec {
  provider: string;
  displayName: string;
  fields: TelephonyCredentialField[];
  /** The non-secret fields, as stored in `public_config`. Unknown keys are refused. */
  publicSchema: z.ZodType<Record<string, string>>;
  /** The secret fields, as sealed. Unknown keys are refused. */
  secretSchema: z.ZodType<Record<string, string>>;
  /** The carrier's public account id, from the validated public fields. */
  accountRef(publicConfig: Record<string, string>): string;
  /** The secret value the console's hint is cut from. */
  hintSource(secret: Record<string, string>): string;
  /**
   * Ask the carrier whether the credential works. The host is fixed here, never taken
   * from tenant data (SSRF), and redirects are refused so the credential cannot be
   * forwarded to another host.
   */
  check(publicConfig: Record<string, string>, secret: Record<string, string>, fetchImpl?: FetchLike): Promise<CredentialCheck>;
}

/** Plivo's REST API host. A constant: a tenant can never point a credential elsewhere. */
export const PLIVO_API_BASE = 'https://api.plivo.com';
const CHECK_TIMEOUT_MS = 10_000;

const plivoSpec: CredentialSpec = {
  provider: 'plivo',
  displayName: 'Plivo',
  fields: [
    { key: 'auth_id', label: 'Auth ID', secret: false, help: 'Plivo console → Overview. Starts with MA (account) or SA (subaccount).' },
    { key: 'auth_token', label: 'Auth Token', secret: true, help: 'Plivo console → Overview. Write-only: it is never shown again.' },
  ],
  // Auth IDs are 20 upper-case alphanumerics with an MA/SA prefix (verify against
  // Plivo's docs if a real id is refused).
  publicSchema: z.object({
    auth_id: z.string().trim().regex(/^(MA|SA)[A-Z0-9]{18}$/, 'Expected a Plivo Auth ID (MA… or SA…, 20 characters)'),
  }).strict(),
  secretSchema: z.object({
    auth_token: z.string().trim().regex(/^[A-Za-z0-9_-]{16,128}$/, 'Expected a Plivo Auth Token'),
  }).strict(),
  accountRef: (p) => p['auth_id']!,
  hintSource: (s) => s['auth_token']!,

  async check(publicConfig, secret, fetchImpl = fetch as FetchLike) {
    const authId = publicConfig['auth_id']!;
    // The regex above already confines the id to [A-Z0-9]; encode anyway.
    const url = `${PLIVO_API_BASE}/v1/Account/${encodeURIComponent(authId)}/`;
    const basic = Buffer.from(`${authId}:${secret['auth_token']!}`).toString('base64');
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (res.status >= 200 && res.status < 300) return { result: 'ok' };
      if (res.status === 401 || res.status === 403) {
        return { result: 'rejected', reason: `Plivo refused the credential (HTTP ${res.status})` };
      }
      // 404 here means the Auth ID names no account Plivo knows.
      if (res.status === 404) return { result: 'rejected', reason: 'Plivo has no account with this Auth ID (HTTP 404)' };
      return { result: 'unreachable', reason: `Plivo answered HTTP ${res.status}` };
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      return { result: 'unreachable', reason: name === 'TimeoutError' ? 'Plivo did not answer in time' : 'Plivo could not be reached' };
    }
  },
};

const SPECS: ReadonlyMap<string, CredentialSpec> = new Map([[plivoSpec.provider, plivoSpec]]);

export function findCredentialSpec(provider: string): CredentialSpec | undefined {
  return SPECS.get(provider);
}

export function credentialSpecs(): CredentialSpec[] {
  return [...SPECS.values()];
}
