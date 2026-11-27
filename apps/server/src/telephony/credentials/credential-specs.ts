// What a tenant credential looks like for each carrier that takes tenant accounts (decision
// B18, docs/carriers.md §2.3): the form fields, how to validate them, which value is the public
// account id, and how to ask the carrier whether the credential works. Each spec lives in its
// carrier's folder (`<carrier>/<carrier>.credential-spec.ts`) and is listed once here; a carrier
// whose catalogue entry declares `accounts.tenant` has one, and no other carrier does
// (`test/unit/telephony/carrier-conformance.test.ts`).
import type { z } from 'zod';
import type {
  TelephonyCredentialField,
  TelephonyNumberSyncSkipReason,
} from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';
import type { TelephonyConfig } from '../carrier-catalog.js';
import { plivoSpec } from '../plivo/plivo.credential-spec.js';
import { voicelinkSpec } from '../voicelink/voicelink.credential-spec.js';

/** The carrier's verdict on a credential. */
export type CredentialCheck =
  | { result: 'ok' }
  /** The carrier refused the credential (401/403). */
  | { result: 'rejected'; reason: string }
  /** The carrier could not be asked (network, timeout, 5xx). Says nothing about the credential. */
  | { result: 'unreachable'; reason: string };

/** `json` is read only by `listNumbers`; `check` needs the status alone. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'status'> & Partial<Pick<Response, 'json'>>>;

/**
 * What a spec's carrier calls (`check`, `listNumbers`) are handed besides the credential: the
 * transport, and this deployment's carrier env. A carrier whose API host is operator config
 * (VoiceLink, `VOICELINK_BASE_URL`) reads it from `telephony`, never from tenant data (CR2);
 * one whose host is a constant in code (Plivo) ignores it.
 */
export interface CredentialCallContext {
  /** The transport. Absent: the global `fetch`. */
  fetch?: FetchLike;
  /** `config.telephony`. Absent: a spec that needs it answers `unreachable`. */
  telephony?: TelephonyConfig;
}

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
   * Ask the carrier whether the credential works. The host is fixed in code or comes from
   * operator config (`ctx.telephony`), never from tenant data (SSRF), and redirects are
   * refused so the credential cannot be forwarded to another host.
   */
  check(publicConfig: Record<string, string>, secret: Record<string, string>, ctx?: CredentialCallContext): Promise<CredentialCheck>;
  /**
   * The numbers on the carrier account, all pages, for the number sync. Same rules as
   * `check`: fixed host, no redirects, a timeout per page, and a bound on the pages read.
   * Absent: the carrier's numbers are not synced.
   */
  listNumbers?(publicConfig: Record<string, string>, secret: Record<string, string>, ctx?: CredentialCallContext): Promise<CredentialNumberList>;
  /**
   * Account refs a tenant credential may not name, compared case-insensitively: the service's
   * own account on this carrier, read from env (CR3), so a tenant can never dial on it under a
   * credential of its own. Checked at create and rotate, before the carrier is asked anything.
   * Absent: no ref is reserved.
   */
  reservedAccountRefs?(telephony: TelephonyConfig): readonly string[];
}

/**
 * Plivo's spec and its constants, re-exported for the callers that read them from here. The
 * number rule `plivoNumberToE164` lives in the domain because inbound webhooks normalise
 * `From` / `To` with it too, and a number must read the same at sync and at the answer.
 */
export {
  plivoSpec, plivoNumberIsOnAccount, PLIVO_API_BASE, PLIVO_NUMBERS_MAX_PAGES, PLIVO_NUMBERS_PAGE_SIZE,
} from '../plivo/plivo.credential-spec.js';
export { plivoNumberToE164 } from '@magick-agency/domain/plivo-number';

const SPECS: ReadonlyMap<string, CredentialSpec> = new Map([plivoSpec, voicelinkSpec].map((s) => [s.provider, s]));

export function findCredentialSpec(provider: string): CredentialSpec | undefined {
  return SPECS.get(provider);
}

export function credentialSpecs(): CredentialSpec[] {
  return [...SPECS.values()];
}

/**
 * Whether `accountRef` is one the spec reserves under this deployment's env
 * ({@link CredentialSpec.reservedAccountRefs}), compared case-insensitively after trimming.
 */
export function accountRefReserved(spec: CredentialSpec, accountRef: string, telephony: TelephonyConfig | undefined): boolean {
  if (!spec.reservedAccountRefs || !telephony) return false;
  const ref = accountRef.trim().toLowerCase();
  if (ref === '') return false;
  return spec.reservedAccountRefs(telephony).some((r) => r.trim().toLowerCase() === ref);
}
