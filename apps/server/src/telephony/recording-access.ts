// How a call's recording may be fetched, per carrier (decision B21): which hosts the
// fetch may touch and which headers go with its FIRST request. Every recording fetch
// (the playback proxies and the analysis worker) asks here, with the call row's own
// provider, pinned credential and tenant, so a BYOC recording is fetched on the
// tenant's credential and on nothing else.
//
// Carriers are entries in `RECORDING_ACCESS`, not branches at the call sites (B18): one
// entry per account mode the carrier supports (docs/carriers.md §2.3). The wrapper decides
// the mode from the call row (a null credential is the service's own account, CR1), refuses a
// mode the carrier has no entry for, and opens the pinned credential before a tenant entry
// runs, so no tenant entry can skip that check.
//
// Kept free of static config and database imports (`credential-service.ts` loads
// neither): the unit tests build a resolver from fakes, and the process-wide resolver
// (`getRecordingAccessResolver`) reaches the config and the credential service lazily.
import {
  CredentialUnavailableError,
  isKeyringFaultKind,
  type CredentialUnavailableKind,
  type ResolvedCredential,
} from './credentials/credential-service.js';

/** The call-row fields that decide a recording's access. */
export interface RecordingCallRef {
  provider: string;
  telephony_credential_id: string | null;
  tenant_id: string;
}

/**
 * What a recording fetch may do.
 *
 *  - `allowedHosts`: the first URL and every redirect hop must be on it
 *    (`fetchWithAllowedRedirects`). Never taken from tenant or call data.
 *  - `headers`: sent with the first request only; a redirect hop never carries them.
 *  - `exactHosts`: hosts match exactly rather than exact-or-subdomain. No carrier sets it
 *    today: Plivo did until its regional media hosts (`aps1.media.plivo.com`) were refused
 *    (B21 and PL6 as amended 2026-11-18). A credential goes only to a list whose every
 *    host, and every subdomain of it, is the provider's recording media (see
 *    `PLIVO_RECORDING_HOSTS`); a list that holds an API host or an apex must set it.
 *  - `redirectHosts`: further hosts a REDIRECT hop (never the first URL) may go to, matched
 *    exactly, from operator config only (RC4; Plivo's `PLIVO_RECORDING_REDIRECT_HOSTS`, empty
 *    by default). A hop never carries `headers`, so the credential stays on the first request.
 */
export interface RecordingAccess {
  allowedHosts: readonly string[];
  headers: Readonly<Record<string, string>>;
  exactHosts: boolean;
  redirectHosts?: readonly string[];
}

export type RecordingAccessResolver = (call: RecordingCallRef) => Promise<RecordingAccess>;

/**
 * Why a recording cannot be fetched:
 *  - `unknown_provider`: no entry in `RECORDING_ACCESS` for the call's provider;
 *  - `credential_required`: a call with no pinned credential on a carrier with no service
 *    account (a BYOC call);
 *  - `credential_not_expected`: a call pinned to a tenant credential on a carrier with no
 *    tenant accounts, i.e. one that can only be on the service's own account (an invariant
 *    breach; refused rather than guessed at);
 *  - `credential_unavailable`: the credential cannot serve recordings (revoked,
 *    shredded, missing, no keyring, unopenable: `credentialKind` says which);
 *  - `credential_mismatch`: the credential belongs to another tenant or provider.
 *
 * There is no fallback to another account (B20): every one of these ends the fetch.
 */
export type RecordingAccessRefusal =
  | 'unknown_provider'
  | 'credential_required'
  | 'credential_not_expected'
  | 'credential_unavailable'
  | 'credential_mismatch';

/** A recording fetch refused before any request. Carries no secret. */
export class RecordingAccessRefusedError extends Error {
  constructor(
    readonly reason: RecordingAccessRefusal,
    readonly provider: string,
    readonly credentialId: string | null,
    /** Set for `credential_unavailable`: the credential service's own cause. */
    readonly credentialKind?: CredentialUnavailableKind,
  ) {
    super(`Recording access refused for provider "${provider}": ${reason}${credentialKind ? ` (${credentialKind})` : ''}`);
    this.name = 'RecordingAccessRefusedError';
  }

  /**
   * True when no later attempt can succeed without someone changing the credential or
   * the data: everything but a keyring fault (`store_unconfigured`, `unopenable`), which
   * an operator fixes in the environment.
   */
  get permanent(): boolean {
    return !(this.reason === 'credential_unavailable' && isKeyringFaultKind(this.credentialKind));
  }
}

/** The credential service's resolve, as this module needs it. */
export interface RecordingCredentialSource {
  resolve(id: string, purpose: 'recording'): Promise<ResolvedCredential>;
}

export interface RecordingAccessDeps {
  /** VoiceLink's recording hosts (`config.voicelinkRecording.allowedHosts`). */
  voicelinkHosts: readonly string[];
  /** Hosts a Plivo recording's redirect may go to (`config.plivoRecording.redirectHosts`; RC4). Absent: none. */
  plivoRedirectHosts?: readonly string[];
  /** The credential service; called only for a BYOC call. */
  credentials: () => RecordingCredentialSource | Promise<RecordingCredentialSource>;
}

/**
 * Plivo's recording media hosts: `media.plivo.com` and every subdomain of it, matched
 * exact-or-subdomain (`exactHosts: false`). The recording callback's `RecordUrl` and the
 * Recording API's `recording_url` are `https://media.plivo.com/v1/Account/{auth_id}/
 * Recording/{id}.mp3` on some accounts and the account's regional media host on others
 * (`https://aps1.media.plivo.com/...`, seen on staging 2026-11-17 as the FIRST URL, not a
 * redirect), so the regional hosts are allowed too (PL6 as amended 2026-11-18).
 *
 * The boundary is the dot before `media.plivo.com`: `aps1.media.plivo.com` matches,
 * `evilmedia.plivo.com`, `media.plivo.com.evil.example` and the apex `plivo.com` do not
 * (`recordingHostMatches`). Everything under `media.plivo.com` is Plivo's media zone.
 *
 * `api.plivo.com` is deliberately NOT matched, and must never be: it is not under
 * `media.plivo.com`, and the list must never be widened to `plivo.com`, which would take
 * it in. The stored `recording_url` arrives in a carrier callback, and the account's REST
 * API answers a Basic-auth GET on that host with account data (calls, numbers, recordings
 * lists). Allowing it would let a forged `recording_url` point a credentialed GET at the
 * API and have the proxy stream the answer back to the viewer. The media hosts serve only
 * recordings.
 */
export const PLIVO_RECORDING_HOSTS: readonly string[] = ['media.plivo.com'];

/** A service-account entry: the call carries no credential. */
type ServiceAccessEntry = (call: RecordingCallRef, deps: RecordingAccessDeps) => Promise<RecordingAccess>;
/** A tenant-account entry: handed the call's pinned credential, already opened for `recording` and checked. */
type TenantAccessEntry = (call: RecordingCallRef, credential: ResolvedCredential, deps: RecordingAccessDeps) => Promise<RecordingAccess>;

/** A carrier's recording access, one entry per account mode it supports. */
interface CarrierRecordingAccess {
  service?: ServiceAccessEntry;
  tenant?: TenantAccessEntry;
}

/** Open the call's pinned credential for `recording` and check it is this call's. */
async function pinnedCredential(call: RecordingCallRef, id: string, deps: RecordingAccessDeps): Promise<ResolvedCredential> {
  let resolved: ResolvedCredential;
  try {
    resolved = await (await deps.credentials()).resolve(id, 'recording');
  } catch (err) {
    if (err instanceof CredentialUnavailableError) {
      throw new RecordingAccessRefusedError('credential_unavailable', call.provider, id, err.kind);
    }
    throw err;
  }
  if (resolved.tenantId !== call.tenant_id || resolved.provider !== call.provider) {
    throw new RecordingAccessRefusedError('credential_mismatch', call.provider, id);
  }
  return resolved;
}

const RECORDING_ACCESS: ReadonlyMap<string, CarrierRecordingAccess> = new Map<string, CarrierRecordingAccess>([
  ['voicelink', {
    // The service's own account: public carrier-hosted MP3s, nothing attached, the
    // configured allow-list (exact-or-subdomain, as before).
    service: async (_call, deps) => ({ allowedHosts: deps.voicelinkHosts, headers: {}, exactHosts: false }),
    // A tenant's own account (CR12): the same configured hosts and nothing attached, since
    // VoiceLink serves recordings unauthenticated. The wrapper has already opened the pinned
    // credential for `recording`, so revoking it ends access here as on every carrier (B21);
    // the credential itself is never sent. Playback does not fetch with this: the proxy checks
    // the URL against these hosts and redirects the viewer (`recordingRedirectsToCarrier`); the
    // analysis worker does fetch, as for the service's account.
    tenant: async (_call, _credential, deps) => ({ allowedHosts: deps.voicelinkHosts, headers: {}, exactHosts: false }),
  }],
  ['plivo', {
    // A tenant's own Plivo account: HTTP Basic auth_id:auth_token, to Plivo's media hosts
    // only (`media.plivo.com` and its regional subdomains; never api.plivo.com).
    tenant: async (call, cred, deps) => {
      const token = cred.secret.reveal()['auth_token'];
      if (!cred.accountRef || !token) {
        throw new RecordingAccessRefusedError('credential_unavailable', call.provider, cred.id, 'no_current_secret');
      }
      const basic = Buffer.from(`${cred.accountRef}:${token}`).toString('base64');
      return {
        allowedHosts: PLIVO_RECORDING_HOSTS,
        headers: { Authorization: `Basic ${basic}` },
        exactHosts: false,
        ...(deps.plivoRedirectHosts?.length ? { redirectHosts: deps.plivoRedirectHosts } : {}),
      };
    },
  }],
]);

/** The providers this module can fetch recordings for. */
export function recordingAccessProviders(): string[] {
  return [...RECORDING_ACCESS.keys()];
}

/** The account modes a provider has a recording entry for (the conformance test reads it). */
export function recordingAccessModes(provider: string): { service: boolean; tenant: boolean } {
  const access = RECORDING_ACCESS.get(provider);
  return { service: access?.service !== undefined, tenant: access?.tenant !== undefined };
}

export function createRecordingAccessResolver(deps: RecordingAccessDeps): RecordingAccessResolver {
  return async (call) => {
    const access = RECORDING_ACCESS.get(call.provider);
    if (!access) throw new RecordingAccessRefusedError('unknown_provider', call.provider, call.telephony_credential_id);
    const credentialId = call.telephony_credential_id;
    if (!credentialId) {
      // The service's own account: refused on a carrier that has none (no fallback, B20).
      if (!access.service) throw new RecordingAccessRefusedError('credential_required', call.provider, null);
      return access.service(call, deps);
    }
    // Pinned to a credential on a carrier with no tenant accounts: an invariant breach,
    // refused rather than guessed at.
    if (!access.tenant) throw new RecordingAccessRefusedError('credential_not_expected', call.provider, credentialId);
    return access.tenant(call, await pinnedCredential(call, credentialId, deps), deps);
  };
}

/** A credential source that serves nothing: a route mounted without a resolver. */
export const NO_RECORDING_CREDENTIALS: RecordingCredentialSource = {
  async resolve(id) {
    throw new CredentialUnavailableError(id, 'store_unconfigured', 'no credential store on this mount');
  },
};

/**
 * Refuses every BYOC recording and every VoiceLink host: the fail-closed default for a
 * playback route mounted without a resolver (a routing-only app).
 */
export const refuseAllRecordingAccess: RecordingAccessResolver = createRecordingAccessResolver({
  voicelinkHosts: [],
  credentials: () => NO_RECORDING_CREDENTIALS,
});

/** Lazily reach the process's credential service (config + keyring + pg pool). */
export async function processCredentialSource(): Promise<RecordingCredentialSource> {
  const { getTelephonyCredentialService } = await import('./credentials/index.js');
  return getTelephonyCredentialService();
}

let processResolver: RecordingAccessResolver | null = null;

/**
 * The resolver built from this process's config: VoiceLink's configured hosts and the
 * process's credential service. Loads the config on first use.
 */
export async function getRecordingAccessResolver(): Promise<RecordingAccessResolver> {
  if (!processResolver) {
    const { config } = await import('../config/index.js');
    processResolver = createRecordingAccessResolver({
      voicelinkHosts: config.voicelinkRecording.allowedHosts,
      plivoRedirectHosts: config.plivoRecording.redirectHosts,
      credentials: processCredentialSource,
    });
  }
  return processResolver;
}
