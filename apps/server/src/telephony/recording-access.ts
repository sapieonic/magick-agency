// How a call's recording may be fetched, per carrier (decision B21): which hosts the
// fetch may touch and which headers go with its FIRST request. Every recording fetch
// (the playback proxies and the analysis worker) asks here, with the call row's own
// provider, pinned credential and tenant, so a BYOC recording is fetched on the
// tenant's credential and on nothing else.
//
// Carriers are entries in `RECORDING_ACCESS`, not branches at the call sites (B18).
//
// Kept free of static config and database imports (`credential-service.ts` loads
// neither): the unit tests build a resolver from fakes, and the process-wide resolver
// (`getRecordingAccessResolver`) reaches the config and the credential service lazily.
import {
  CredentialUnavailableError,
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
 *  - `exactHosts`: hosts match exactly rather than exact-or-subdomain. True whenever
 *    `headers` carries a credential: B21 sends it only to the provider's exact hosts.
 */
export interface RecordingAccess {
  allowedHosts: readonly string[];
  headers: Readonly<Record<string, string>>;
  exactHosts: boolean;
}

export type RecordingAccessResolver = (call: RecordingCallRef) => Promise<RecordingAccess>;

/**
 * Why a recording cannot be fetched:
 *  - `unknown_provider`: no entry in `RECORDING_ACCESS` for the call's provider;
 *  - `credential_required`: a BYOC call with no pinned credential;
 *  - `credential_not_expected`: a call on the service's own account pinned to a tenant
 *    credential (an invariant breach; refused rather than guessed at);
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
    return !(this.reason === 'credential_unavailable'
      && (this.credentialKind === 'store_unconfigured' || this.credentialKind === 'unopenable'));
  }
}

/** The credential service's resolve, as this module needs it. */
export interface RecordingCredentialSource {
  resolve(id: string, purpose: 'recording'): Promise<ResolvedCredential>;
}

export interface RecordingAccessDeps {
  /** VoiceLink's recording hosts (`config.voicelinkRecording.allowedHosts`). */
  voicelinkHosts: readonly string[];
  /** The credential service; called only for a BYOC call. */
  credentials: () => RecordingCredentialSource | Promise<RecordingCredentialSource>;
}

/**
 * Plivo's recording media host. Exactly this one: the recording callback's `RecordUrl`
 * and the Recording API's `recording_url` are both `https://media.plivo.com/v1/Account/
 * {auth_id}/Recording/{id}.mp3`, so the fetch needs no other host.
 *
 * `api.plivo.com` is deliberately NOT here. The stored `recording_url` arrives in a
 * carrier callback, and the account's REST API answers a Basic-auth GET on that host
 * with account data (calls, numbers, recordings lists). Allowing it would let a forged
 * `recording_url` point a credentialed GET at the API and have the proxy stream the
 * answer back to the viewer. The media host serves only recordings.
 */
export const PLIVO_RECORDING_HOSTS: readonly string[] = ['media.plivo.com'];

type AccessEntry = (call: RecordingCallRef, deps: RecordingAccessDeps) => Promise<RecordingAccess>;

/** Open the call's pinned credential for `recording` and check it is this call's. */
async function pinnedCredential(call: RecordingCallRef, deps: RecordingAccessDeps): Promise<ResolvedCredential> {
  const id = call.telephony_credential_id;
  if (!id) throw new RecordingAccessRefusedError('credential_required', call.provider, null);
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

const RECORDING_ACCESS: ReadonlyMap<string, AccessEntry> = new Map<string, AccessEntry>([
  // The service's own account: public carrier-hosted MP3s, nothing attached, the
  // configured allow-list (exact-or-subdomain, as before).
  ['voicelink', async (call, deps) => {
    if (call.telephony_credential_id) {
      throw new RecordingAccessRefusedError('credential_not_expected', call.provider, call.telephony_credential_id);
    }
    return { allowedHosts: deps.voicelinkHosts, headers: {}, exactHosts: false };
  }],
  // A tenant's own Plivo account: HTTP Basic auth_id:auth_token, to the exact media
  // host only.
  ['plivo', async (call, deps) => {
    const cred = await pinnedCredential(call, deps);
    const token = cred.secret.reveal()['auth_token'];
    if (!cred.accountRef || !token) {
      throw new RecordingAccessRefusedError('credential_unavailable', call.provider, cred.id, 'no_current_secret');
    }
    const basic = Buffer.from(`${cred.accountRef}:${token}`).toString('base64');
    return { allowedHosts: PLIVO_RECORDING_HOSTS, headers: { Authorization: `Basic ${basic}` }, exactHosts: true };
  }],
]);

/** The providers this module can fetch recordings for. */
export function recordingAccessProviders(): string[] {
  return [...RECORDING_ACCESS.keys()];
}

export function createRecordingAccessResolver(deps: RecordingAccessDeps): RecordingAccessResolver {
  return async (call) => {
    const entry = RECORDING_ACCESS.get(call.provider);
    if (!entry) throw new RecordingAccessRefusedError('unknown_provider', call.provider, call.telephony_credential_id);
    return entry(call, deps);
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
      credentials: processCredentialSource,
    });
  }
  return processResolver;
}
