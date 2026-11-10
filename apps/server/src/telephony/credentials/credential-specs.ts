// What a tenant credential looks like for each carrier that accepts one (decision B18):
// the form fields, how to validate them, which value is the public account id, and
// how to ask the carrier whether the credential works. VoiceLink is the service's own
// account (env) and has no spec here.
import { z } from 'zod';
import { plivoNumberToE164 } from '@magick-agency/domain/plivo-number';
import type {
  TelephonyCredentialField,
  TelephonyNumberSyncSkipReason,
} from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';

/** The carrier's verdict on a credential. */
export type CredentialCheck =
  | { result: 'ok' }
  /** The carrier refused the credential (401/403). */
  | { result: 'rejected'; reason: string }
  /** The carrier could not be asked (network, timeout, 5xx). Says nothing about the credential. */
  | { result: 'unreachable'; reason: string };

/** `json` is read only by `listNumbers`; `check` needs the status alone. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'status'> & Partial<Pick<Response, 'json'>>>;

/** A voice number on the carrier account, normalised to E.164. */
export interface CarrierNumber {
  phone_number: string;
  /** The carrier's alias for the number, if any (bounded). */
  label: string | null;
}

/** The carrier's list of the numbers on a credential's account. */
export type CredentialNumberList =
  | {
    result: 'ok';
    /** Every number listed, voice or not. */
    listed: number;
    numbers: CarrierNumber[];
    skipped: Array<{ number: string; reason: TelephonyNumberSyncSkipReason }>;
  }
  | { result: 'rejected'; reason: string }
  | { result: 'unreachable'; reason: string }
  /** More pages than one sync reads: the list is incomplete and must not be acted on. */
  | { result: 'too_many'; reason: string };

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
  /**
   * The numbers on the carrier account, all pages, for the number sync. Same rules as
   * `check`: fixed host, no redirects, a timeout per page, and a bound on the pages read.
   * Absent: the carrier's numbers are not synced.
   */
  listNumbers?(publicConfig: Record<string, string>, secret: Record<string, string>, fetchImpl?: FetchLike): Promise<CredentialNumberList>;
}

/** Plivo's REST API host. A constant: a tenant can never point a credential elsewhere. */
export const PLIVO_API_BASE = 'https://api.plivo.com';
const CHECK_TIMEOUT_MS = 10_000;
/** Plivo's page size for the number list (its maximum). */
export const PLIVO_NUMBERS_PAGE_SIZE = 20;
/** Pages one sync reads at most (1,000 numbers): an account with more is refused, not half-synced. */
export const PLIVO_NUMBERS_MAX_PAGES = 50;
/**
 * A Plivo account number as E.164 (`18135401302` → `+18135401302`; anything else null). The
 * rule lives in the domain because inbound webhooks normalise `From` / `To` with it too, and a
 * number must read the same at sync and at the answer. Re-exported for this file's callers.
 */
export { plivoNumberToE164 };

function plivoAuth(publicConfig: Record<string, string>, secret: Record<string, string>) {
  const authId = publicConfig['auth_id']!;
  return {
    authId,
    headers: {
      Authorization: `Basic ${Buffer.from(`${authId}:${secret['auth_token']!}`).toString('base64')}`,
      Accept: 'application/json',
    },
  };
}

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
    const { authId, headers } = plivoAuth(publicConfig, secret);
    // The regex above already confines the id to [A-Z0-9]; encode anyway.
    const url = `${PLIVO_API_BASE}/v1/Account/${encodeURIComponent(authId)}/`;
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers,
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

  /**
   * `GET /v1/Account/{auth_id}/Number/?limit=20&offset=N`, page by page. The next page's
   * URL is built here from the offset, never taken from the response's `meta.next`, so a
   * response cannot steer the credential to another URL. Stops on a page shorter than
   * the limit, or when `meta.next` is null; refuses (`too_many`) when a full
   * `PLIVO_NUMBERS_MAX_PAGES` pages still leave more.
   *
   * A main account's (`MA…`) list includes the numbers it has transferred to its
   * subaccounts (`sub_account` names the subaccount). Those are another account's numbers:
   * a call from them is that subaccount's, so they are skipped (`other_account`), never
   * claimed by the main account's credential. A subaccount's (`SA…`) own numbers carry its
   * own id there and are kept.
   */
  async listNumbers(publicConfig, secret, fetchImpl = fetch as FetchLike) {
    const { authId, headers } = plivoAuth(publicConfig, secret);
    const base = `${PLIVO_API_BASE}/v1/Account/${encodeURIComponent(authId)}/Number/`;
    const numbers: CarrierNumber[] = [];
    const skipped: Array<{ number: string; reason: TelephonyNumberSyncSkipReason }> = [];
    let listed = 0;
    for (let page = 0; page < PLIVO_NUMBERS_MAX_PAGES; page++) {
      const url = `${base}?limit=${PLIVO_NUMBERS_PAGE_SIZE}&offset=${page * PLIVO_NUMBERS_PAGE_SIZE}`;
      let body: unknown;
      try {
        const res = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        if (res.status === 401 || res.status === 403) {
          return { result: 'rejected', reason: `Plivo refused the credential (HTTP ${res.status})` };
        }
        if (res.status < 200 || res.status >= 300) return { result: 'unreachable', reason: `Plivo answered HTTP ${res.status}` };
        if (!res.json) return { result: 'unreachable', reason: 'Plivo sent no number list' };
        body = await res.json();
      } catch (err) {
        const name = err instanceof Error ? err.name : 'Error';
        if (name === 'SyntaxError') return { result: 'unreachable', reason: 'Plivo sent an unreadable number list' };
        return { result: 'unreachable', reason: name === 'TimeoutError' ? 'Plivo did not answer in time' : 'Plivo could not be reached' };
      }
      const objects = (body as { objects?: unknown } | null)?.objects;
      if (!Array.isArray(objects)) return { result: 'unreachable', reason: 'Plivo sent an unreadable number list' };
      for (const item of objects as Array<Record<string, unknown> | null>) {
        listed++;
        const rawNumber = typeof item?.['number'] === 'string' ? item['number'].slice(0, 32) : '';
        if (!plivoNumberIsOnAccount(item?.['sub_account'], authId)) {
          skipped.push({ number: rawNumber, reason: 'other_account' });
          continue;
        }
        if (item?.['voice_enabled'] !== true) {
          skipped.push({ number: rawNumber, reason: 'not_voice' });
          continue;
        }
        const e164 = plivoNumberToE164(rawNumber);
        if (!e164) {
          skipped.push({ number: rawNumber, reason: 'invalid_number' });
          continue;
        }
        const alias = typeof item?.['alias'] === 'string' ? item['alias'].trim().slice(0, 255) : '';
        numbers.push({ phone_number: e164, label: alias || null });
      }
      const next = (body as { meta?: { next?: unknown } }).meta?.next;
      if (objects.length < PLIVO_NUMBERS_PAGE_SIZE || next === null) {
        return { result: 'ok', listed, numbers, skipped };
      }
    }
    return {
      result: 'too_many',
      reason: `The account lists more than ${PLIVO_NUMBERS_MAX_PAGES * PLIVO_NUMBERS_PAGE_SIZE} numbers, more than one sync reads`,
    };
  },
};

/**
 * Whether a listed Plivo number belongs to the account `authId` itself, read off its
 * `sub_account`: absent, null or empty is the listing account's own number; otherwise it
 * names the subaccount the number was transferred to (its auth id, or a resource URI
 * ending in it), which is this account only when that id is `authId`. Anything else is
 * not this account's: a number is never claimed on a field that cannot be read.
 */
export function plivoNumberIsOnAccount(subAccount: unknown, authId: string): boolean {
  if (subAccount === undefined || subAccount === null || subAccount === '') return true;
  if (typeof subAccount !== 'string') return false;
  const id = subAccount.split('/').filter(Boolean).at(-1) ?? '';
  return id === authId;
}

const SPECS: ReadonlyMap<string, CredentialSpec> = new Map([[plivoSpec.provider, plivoSpec]]);

export function findCredentialSpec(provider: string): CredentialSpec | undefined {
  return SPECS.get(provider);
}

export function credentialSpecs(): CredentialSpec[] {
  return [...SPECS.values()];
}
