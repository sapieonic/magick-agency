// VoiceLink on a tenant's own account (docs/carriers.md CR2, CR4): the tenant adapter factory
// `TENANT_ADAPTERS` lists (`../factory.ts`), and the logins it shares.
//
// The adapter is built from this deployment's env (`config.telephony.voicelink`: the API base,
// the webhook base, the default country code, the timeouts) plus the credential's username and
// password, nothing else of the tenant's: the host a login goes to is never tenant data (CR2).
//
// One login per credential and secret version. The registry caches adapters per
// `credentialId:purpose` (a `dial` adapter and a `call_control` one for the same credential),
// and VoiceLink may answer a fresh login by retiring the account's earlier token: two adapters
// each logging in on their own would log each other out, a 401 and a re-login on every other
// request. So both are handed the same {@link VoicelinkTokenManager} from a small bounded cache
// here. A rotation is a new secret version, so a new login: the old version's manager is dropped
// from the cache (adapters already built on it keep it until the registry rebuilds them).
import type { AppConfig } from '../../config/index.js';
import type { ResolvedCredential } from '../credentials/credential-service.js';
import { VoicelinkAdapter } from './voicelink.adapter.js';
import { VoicelinkTokenManager } from './voicelink-token-manager.js';
import type { VoicelinkConfig } from './voicelink.types.js';

/** How many tenant logins the process keeps (one per credential in use; the registry keeps 256 adapters). */
export const VOICELINK_TENANT_LOGINS_MAX = 256;

/** `credentialId:secretVersion:baseUrl` → the login shared by that credential's adapters. Insertion order is recency. */
const logins = new Map<string, VoicelinkTokenManager>();

/**
 * The login for this credential's current secret version, shared by every adapter built on it.
 * Keyed with the API base too, so a test that moves the base never reuses a login made against
 * another host.
 */
export function voicelinkTenantLogin(credential: ResolvedCredential, settings: VoicelinkConfig): VoicelinkTokenManager {
  const key = `${credential.id}:${credential.version}:${settings.baseUrl}`;
  const hit = logins.get(key);
  if (hit) {
    logins.delete(key);
    logins.set(key, hit);
    return hit;
  }
  // Another secret version of this credential: superseded (or not yet current), never shared again.
  for (const k of [...logins.keys()]) if (k.startsWith(`${credential.id}:`)) logins.delete(k);
  if (logins.size >= VOICELINK_TENANT_LOGINS_MAX) logins.delete(logins.keys().next().value!);
  const login = new VoicelinkTokenManager(settings, { accountMode: 'tenant' });
  logins.set(key, login);
  return login;
}

/** How many tenant logins are cached. Tests only. */
export function voicelinkTenantLoginCount(): number {
  return logins.size;
}

/** Forget every cached tenant login. Tests only. */
export function resetVoicelinkTenantLoginsForTests(): void {
  logins.clear();
}

/**
 * The tenant factory: a {@link VoicelinkAdapter} in `tenant` mode on the credential's login.
 * VoiceLink signs no callbacks and has no hangup API, so the secret versions a rotation retired
 * (`credential.previous`) are not needed: every purpose uses the current one.
 */
export function createVoicelinkTenantAdapter(credential: ResolvedCredential, config: AppConfig): VoicelinkAdapter {
  // The username exactly as typed (`public_config`), never `accountRef`: that is lower-cased for
  // uniqueness (`voicelinkAccountRef`), and VoiceLink may compare usernames by case.
  const username = typeof credential.publicConfig['username'] === 'string' ? credential.publicConfig['username'] : '';
  const password = credential.secret.reveal()['password'];
  if (!username || !password) throw new Error(`Telephony credential ${credential.id} has no VoiceLink username or password`);
  const env = config.telephony.voicelink;
  const settings: VoicelinkConfig = {
    baseUrl: env.baseUrl,
    webhookBaseUrl: env.webhookBaseUrl,
    defaultCountryCode: env.defaultCountryCode,
    loginTimeoutMs: env.loginTimeoutMs,
    addLeadTimeoutMs: env.addLeadTimeoutMs,
    username,
    password,
  };
  return new VoicelinkAdapter(settings, { accountMode: 'tenant', tokenManager: voicelinkTenantLogin(credential, settings) });
}
