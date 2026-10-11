// Two kinds of adapter. The service's own carrier accounts (VoiceLink) are built from
// env by `buildProviderConfig` + `instantiate`; any other name there throws `Unknown
// telephony provider: <name>`. A tenant's own carrier account (BYOC, decision B18) is
// built by `BYOC_ADAPTERS` from a credential the credential service resolves; no BYOC
// adapter is registered yet (Plivo's lands with its adapter), so such a credential
// resolves and then throws `ByocCredentialUnavailableError`.
import type { TelephonyProvider } from './types.js';
import type { AppConfig } from '../config/index.js';
import { VoicelinkAdapter } from './voicelink/voicelink.adapter.js';
import type { ResolvedCredential, ResolvePurpose } from './credentials/credential-service.js';

/**
 * Thrown when a call carries a carrier credential id that cannot be resolved: no
 * credential store, an unknown / disabled / revoked / unopenable credential, one of
 * another provider, or a provider with no BYOC adapter.
 *
 * Fatal by design. The alternative is a hangup or a recording fetch issued
 * against the service's own carrier account for a call it has never heard of,
 * which fails anyway but reports the wrong cause.
 */
export class ByocCredentialUnavailableError extends Error {
  constructor(readonly credentialId: string, readonly reason?: string) {
    super(`Telephony credential ${credentialId} could not be resolved${reason ? `: ${reason}` : ''}`);
    this.name = 'ByocCredentialUnavailableError';
  }
}

/** What the registry needs from the credential service. */
export interface CredentialResolver {
  resolve(credentialId: string, purpose: ResolvePurpose): Promise<ResolvedCredential>;
}

/** Builds an adapter on a tenant's own carrier account. */
export type ByocAdapterFactory = (credential: ResolvedCredential, config: AppConfig) => TelephonyProvider;

/**
 * BYOC adapters by provider name. **Adding a BYOC carrier means adding its factory
 * here**, its credential spec (`credentials/credential-specs.ts`) and its carrier
 * module (`carrier-modules.ts`).
 */
const BYOC_ADAPTERS: ReadonlyMap<string, ByocAdapterFactory> = new Map();

/** How many BYOC adapters the process keeps (one per credential version in use). */
const BYOC_CACHE_MAX = 256;

/**
 * Map a provider name onto the config shape the adapter constructor takes.
 * **Adding a provider means adding a case here and in `instantiate`.**
 *
 * Two rules are load-bearing:
 *
 *  * It returns `config.telephony[provider]` unchanged.
 *  * `webhookBaseUrl` **always comes from env**, never from tenant data. A
 *    per-tenant callback host is an SSRF sink and a call-hijack vector: the
 *    carrier would POST our answer/status webhooks — which carry the call's
 *    identity and drive its state machine — at an address the tenant chose.
 */
export function buildProviderConfig(
  provider: string,
  config: AppConfig,
): unknown {
  const telephony = config.telephony;

  switch (provider) {
    case 'voicelink': return telephony.voicelink;
    default: throw new Error(`Unknown telephony provider: ${provider}`);
  }
}

/** Construct an adapter from an already-resolved provider config. */
function instantiate(providerName: string, providerConfig: unknown): TelephonyProvider {
  switch (providerName) {
    case 'voicelink':
      return new VoicelinkAdapter(providerConfig as ConstructorParameters<typeof VoicelinkAdapter>[0]);
    default:
      throw new Error(`Unknown telephony provider: ${providerName}`);
  }
}

function createProviderInstance(providerName: string, config: AppConfig): TelephonyProvider {
  return instantiate(providerName, buildProviderConfig(providerName, config));
}

/**
 * Registry that lazily creates and caches TelephonyProvider instances.
 * Supports per-call provider selection by maintaining one adapter per provider
 * name.
 */
export class TelephonyProviderRegistry {
  /** Adapters on the service's own accounts, keyed by provider name. At most one per provider. */
  private providers = new Map<string, TelephonyProvider>();
  /** BYOC adapters, keyed `credentialId:secretVersion`, so a rotation is never served stale. */
  private byoc = new Map<string, TelephonyProvider>();
  private readonly config: AppConfig;
  private readonly credentials: (() => CredentialResolver) | null;
  private readonly byocAdapters: ReadonlyMap<string, ByocAdapterFactory>;

  constructor(config: AppConfig, opts: {
    /** Lazy, so building a registry never builds the credential service. */
    credentials?: () => CredentialResolver;
    /** Tests only: replaces `BYOC_ADAPTERS`. */
    byocAdapters?: ReadonlyMap<string, ByocAdapterFactory>;
  } = {}) {
    this.config = config;
    this.credentials = opts.credentials ?? null;
    this.byocAdapters = opts.byocAdapters ?? BYOC_ADAPTERS;
  }

  /**
   * Get a provider by name on the service's own carrier credentials. Creates and
   * caches on first access.
   *
   * Deliberately synchronous: callers that have no tenant in hand (webhook
   * parsing, startup validation) use it directly.
   */
  get(providerName: string): TelephonyProvider {
    let provider = this.providers.get(providerName);
    if (!provider) {
      provider = createProviderInstance(providerName, this.config);
      this.providers.set(providerName, provider);
    }
    return provider;
  }

  /** Get the default provider: always VoiceLink, the only carrier. */
  getDefault(): TelephonyProvider {
    return this.get('voicelink');
  }

  /**
   * The adapter for the credential a call is pinned to. A null id means the call
   * runs on the service's own carrier account, so it resolves to that adapter.
   *
   * `purpose` decides which credential statuses may serve (see `ResolvePurpose`):
   * `call_control` (the default: hangup, cancel, webhook checks for a placed call)
   * is served by a disabled credential too, `dial` only by an active one. The
   * credential row is read on every call; only the adapter is cached.
   *
   * @throws ByocCredentialUnavailableError for a non-null id that cannot serve.
   *   Never substitutes the service's own account for a missing credential.
   */
  async getForCredentialId(
    providerName: string,
    credentialId: string | null,
    purpose: ResolvePurpose = 'call_control',
  ): Promise<TelephonyProvider> {
    if (!credentialId) return this.get(providerName);
    // A pinned id that cannot be resolved is NOT the service's own account —
    // substituting it would issue the hangup against the wrong carrier and report
    // the wrong cause.
    if (!this.credentials) throw new ByocCredentialUnavailableError(credentialId, 'no credential store');
    let resolved: ResolvedCredential;
    try {
      resolved = await this.credentials().resolve(credentialId, purpose);
    } catch (err) {
      throw new ByocCredentialUnavailableError(credentialId, err instanceof Error ? err.message : 'unresolvable');
    }
    if (resolved.provider !== providerName) {
      throw new ByocCredentialUnavailableError(credentialId, `credential is for ${resolved.provider}, not ${providerName}`);
    }
    const key = `${resolved.id}:${resolved.version}`;
    const cached = this.byoc.get(key);
    if (cached) return cached;
    const factory = this.byocAdapters.get(providerName);
    if (!factory) throw new ByocCredentialUnavailableError(credentialId, `no BYOC adapter for ${providerName}`);
    const adapter = factory(resolved, this.config);
    // Drop superseded versions of this credential, then bound the cache.
    for (const k of [...this.byoc.keys()]) if (k.startsWith(`${resolved.id}:`)) this.byoc.delete(k);
    if (this.byoc.size >= BYOC_CACHE_MAX) this.byoc.delete(this.byoc.keys().next().value!);
    this.byoc.set(key, adapter);
    return adapter;
  }
}
