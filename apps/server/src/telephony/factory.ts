// VoiceLink is the only carrier, so `buildProviderConfig` and `instantiate` have only
// a `voicelink` case; any other name throws `Unknown telephony provider: <name>`.
// There is no per-tenant carrier credential (BYOC) store, so `getForCredentialId`
// with a non-null id throws `ByocCredentialUnavailableError`.
import type { TelephonyProvider } from './types.js';
import type { AppConfig } from '../config/index.js';
import { VoicelinkAdapter } from './voicelink/voicelink.adapter.js';

/**
 * Thrown when a call carries a carrier credential id that cannot be resolved.
 * No credential store exists here, so every non-null id throws.
 *
 * Fatal by design. The alternative is a hangup or a recording fetch issued
 * against the service's own carrier account for a call it has never heard of,
 * which fails anyway but reports the wrong cause.
 */
export class ByocCredentialUnavailableError extends Error {
  constructor(readonly credentialId: string) {
    super(`Telephony credential ${credentialId} could not be resolved`);
    this.name = 'ByocCredentialUnavailableError';
  }
}

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
 *    `defaultCallerId` comes from env for the same reason.
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
  /** Adapters, keyed by provider name. At most one per provider. */
  private providers = new Map<string, TelephonyProvider>();
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
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
   * The post-dial entry point: the adapter for the credential a call was pinned
   * to. A null id means the call ran on the service's own carrier account (every
   * call here), so it resolves to that adapter.
   *
   * @throws ByocCredentialUnavailableError for a non-null id. Never substitutes
   *   the service's own account for a missing credential.
   */
  async getForCredentialId(providerName: string, credentialId: string | null): Promise<TelephonyProvider> {
    if (!credentialId) return this.get(providerName);
    // A pinned id with no store to resolve it against is NOT the service's own
    // account — substituting it would issue the hangup against the wrong
    // carrier and report the wrong cause.
    throw new ByocCredentialUnavailableError(credentialId);
  }
}
