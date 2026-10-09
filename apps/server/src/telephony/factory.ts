// PORT NOTE (magick-agency): ported from core src/telephony/factory.ts@4850d1d9. Modified:
// VoiceLink is the only carrier (plan §5), so `buildProviderConfig` and `instantiate`
// keep only the `voicelink` case (any other name still throws
// `Unknown telephony provider: <name>`, as core does). BYOC is not carried, so
// `buildProviderConfig` lost its `source` parameter (it was always the platform
// source here) and `getForCredentialId` with a non-null id throws
// `ByocCredentialUnavailableError` — exactly core's no-resolver branch. Deleted:
// the other seven adapter imports and cases, the credential-seam/credential-source
// imports, the `setTelephonyCredentialResolver` re-export, `MAX_BYOC_INSTANCES`,
// `ByocProviderUnsupportedError`, the BYOC switch in `buildProviderConfig`,
// `createProviderInstance`'s platform-source argument, `getForTenant`,
// `getForAuthId`, `resolvedCredentialId`, `instanceCounts`, the BYOC LRU map,
// `forSource`, `ensureInvalidationSubscription`, `evictForInvalidation`, the
// module logger (only the eviction path logged) and the deprecated
// `createTelephonyProvider`. `getDefault()` returns voicelink, since core's
// `config.telephony.defaultProvider` does not exist here.
import type { TelephonyProvider } from './types.js';
import type { AppConfig } from '../config/index.js';
import { VoicelinkAdapter } from './voicelink/voicelink.adapter.js';

/**
 * Thrown when a call is pinned to a credential id that no longer resolves —
 * the row was hard deleted, or BYOC telephony is not configured on this replica
 * while a call pinned to a credential is being finished.
 *
 * Also fatal by design. The alternative is a hangup or a recording fetch issued
 * against the platform carrier for a call it has never heard of, which fails
 * anyway but reports the wrong cause.
 */
export class ByocCredentialUnavailableError extends Error {
  constructor(readonly credentialId: string) {
    super(`Telephony credential ${credentialId} could not be resolved`);
    this.name = 'ByocCredentialUnavailableError';
  }
}

/**
 * Map a credential source onto the config shape the adapter constructor already
 * takes. **Adding a provider means adding a case here and nothing else.**
 *
 * Two rules are load-bearing:
 *
 *  * `platform` returns `config.telephony[provider]` unchanged, so every
 *    non-tenant-scoped caller keeps byte-for-byte today's behaviour.
 *  * `webhookBaseUrl` **always comes from env**, never from the credential row.
 *    A per-tenant callback host is an SSRF sink and a call-hijack vector: the
 *    carrier would POST our answer/status webhooks — which carry the call's
 *    identity and drive its state machine — at an address the tenant chose.
 *    `defaultCallerId` comes from env for the same reason it always did; a BYOC
 *    tenant's own default lives on their number inventory (migration 101), not
 *    on the credential.
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
 * name, and — for a tenant running on their own carrier account — one adapter
 * per credential.
 *
 * **A per-credential instance is mandatory, not an optimisation.** The VoBiz
 * adapter bakes `authId` into its base URL at construction
 * (`https://api.vobiz.ai/api/v1/Account/${authId}`), so instances genuinely
 * cannot be shared across carrier accounts. Memoising them is what makes
 * "lazy-load then reuse" true of the client and not just of the credential.
 */
export class TelephonyProviderRegistry {
  /** Platform adapters, keyed by provider name. At most one per provider. */
  private providers = new Map<string, TelephonyProvider>();
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Get a provider by name on the **platform** credentials. Creates and caches
   * on first access.
   *
   * Unchanged and deliberately still synchronous: every existing caller that has
   * no tenant in hand (webhook parsing, answer-XML rendering for the platform
   * account, startup validation) keeps working exactly as before.
   */
  get(providerName: string): TelephonyProvider {
    let provider = this.providers.get(providerName);
    if (!provider) {
      provider = createProviderInstance(providerName, this.config);
      this.providers.set(providerName, provider);
    }
    return provider;
  }

  /** Get the default provider: always VoiceLink, agency's only carrier (core read TELEPHONY_PROVIDER). */
  getDefault(): TelephonyProvider {
    return this.get('voicelink');
  }

  /**
   * The post-dial entry point: the adapter for the credential a call was pinned
   * to. A null id means the call ran on the platform account (every call that
   * predates this feature), so it resolves to the platform adapter.
   *
   * @throws ByocCredentialUnavailableError when a non-null id no longer
   *   resolves. Never substitutes the platform account for a missing credential.
   */
  async getForCredentialId(providerName: string, credentialId: string | null): Promise<TelephonyProvider> {
    if (!credentialId) return this.get(providerName);
    // A pinned id with no store to resolve it against is NOT the platform
    // account — substituting it would issue the hangup against the wrong
    // carrier and report the wrong cause.
    throw new ByocCredentialUnavailableError(credentialId);
  }
}
