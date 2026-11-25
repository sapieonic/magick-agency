// The conformance guard (docs/carriers.md §4, CR14): every per-carrier list is held equal to
// the carrier catalogue (`telephony/carrier-catalog.ts`), so a carrier added to the catalogue
// with a piece missing for a mode it declares, or a piece registered for a mode it does not
// declare, goes red here rather than at its first call. The lists: the carrier modules, the
// service and tenant adapter maps (`factory.ts`), the credential specs, and the recording
// access entries per mode (`recording-access.ts`).
//
// The current modes are pinned too: VoiceLink takes both the service's account and tenants'
// (docs/carriers.md step 2, CR2–CR5), Plivo tenant accounts only.
import { describe, it, expect } from 'vitest';
import type { AppConfig } from '../../../src/config/index.js';
import {
  carrierAccountModeAllowed,
  carrierCancelsRinging,
  carrierHasServiceAccount,
  carrierNames,
  carrierSupportsInbound,
  carrierTakesTenantAccounts,
  findCarrier,
  type TelephonyConfig,
} from '../../../src/telephony/carrier-catalog.js';
import { carrierModuleNames } from '../../../src/telephony/carrier-modules.js';
import {
  findServiceAdapterFactory,
  findTenantAdapterFactory,
  serviceProviderNames,
  tenantProviderNames,
} from '../../../src/telephony/factory.js';
import { credentialSpecs, findCredentialSpec } from '../../../src/telephony/credentials/credential-specs.js';
import { recordingAccessModes, recordingAccessProviders } from '../../../src/telephony/recording-access.js';
import type { ResolvedCredential } from '../../../src/telephony/credentials/credential-service.js';
import type { InboundCarrierApi } from '../../../src/telephony/credentials/inbound-service.js';
import { Secret } from '../../../src/telephony/credentials/secret.js';
import { recordsOnDemand, type TelephonyProvider } from '../../../src/telephony/types.js';

const sorted = (names: Iterable<string>) => [...new Set(names)].sort();

/** A distinct webhook base per carrier, so a descriptor reading another carrier's block shows. */
const baseFor = (name: string) => `https://srv.test/api/v1/webhooks/${name}-from-env`;

/** Inert env for every carrier: each adapter constructor only stores what it is given. */
const CONFIG = {
  telephony: {
    requireVoicelink: false,
    voicelink: { baseUrl: 'https://vl.test', username: 'u', password: 'p', webhookBaseUrl: baseFor('voicelink'), defaultCountryCode: '91' },
    plivo: { webhookBaseUrl: baseFor('plivo') },
  },
} as unknown as AppConfig;

/** A credential for `provider` built from its spec's own fields, every value one plain token. */
function credentialFor(provider: string): ResolvedCredential {
  const spec = findCredentialSpec(provider)!;
  const value = 'MAABCDEFGHIJKLMNOPQR';
  const publicConfig = Object.fromEntries(spec.fields.filter((f) => !f.secret).map((f) => [f.key, value]));
  const secret = Object.fromEntries(spec.fields.filter((f) => f.secret).map((f) => [f.key, value]));
  return {
    id: 'cred-1', tenantId: 't1', provider, accountRef: spec.accountRef(publicConfig), publicConfig,
    version: 1, secret: new Secret(secret), previous: [],
  };
}

/** Every member a tenant adapter needs to serve inbound (`InboundCarrierApi`), listed whole. */
const INBOUND_METHODS = [
  'createInboundApplication', 'getInboundApplication', 'updateInboundApplication', 'deleteInboundApplication',
  'findInboundApplications', 'getNumberApp', 'setNumberApp',
] as const satisfies ReadonlyArray<keyof InboundCarrierApi>;
type UnlistedInboundMethod = Exclude<keyof InboundCarrierApi, (typeof INBOUND_METHODS)[number]>;
const _everyInboundMethodListed: [UnlistedInboundMethod] extends [never] ? true : false = true;
void _everyInboundMethodListed;

describe('carrier conformance: every list equals the catalogue', () => {
  const names = carrierNames();
  const declaring = (mode: 'service' | 'tenant') => sorted(names.filter((n) => findCarrier(n)!.accounts[mode]));

  it('the catalogue is keyed by each carrier’s own name, and every carrier supports at least one mode', () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const c = findCarrier(name)!;
      expect(c.name).toBe(name);
      expect(c.accounts.service || c.accounts.tenant, name).toBe(true);
    }
  });

  it('a carrier module for every catalogue entry, and a catalogue entry for every module', () => {
    expect(sorted(carrierModuleNames())).toEqual(sorted(names));
  });

  it('a service adapter exactly for the carriers declaring a service account', () => {
    expect(sorted(serviceProviderNames())).toEqual(declaring('service'));
  });

  it('a tenant adapter exactly for the carriers declaring tenant accounts', () => {
    expect(sorted(tenantProviderNames())).toEqual(declaring('tenant'));
  });

  it('a credential spec exactly for the carriers declaring tenant accounts', () => {
    expect(sorted(credentialSpecs().map((s) => s.provider))).toEqual(declaring('tenant'));
    for (const name of declaring('tenant')) expect(findCredentialSpec(name)?.provider, name).toBe(name);
  });

  it('a recording entry for each mode a carrier declares, and none for a mode it does not', () => {
    expect(sorted(recordingAccessProviders())).toEqual(sorted(names));
    for (const name of names) {
      expect(recordingAccessModes(name), name).toEqual(findCarrier(name)!.accounts);
    }
    expect(recordingAccessModes('nope')).toEqual({ service: false, tenant: false });
  });

  it('every adapter states the ringing behaviour its catalogue entry declares', () => {
    const built: Array<[string, TelephonyProvider]> = [
      ...serviceProviderNames().map((n): [string, TelephonyProvider] => [n, findServiceAdapterFactory(n)!(CONFIG)]),
      ...tenantProviderNames().map((n): [string, TelephonyProvider] => [n, findTenantAdapterFactory(n)!(credentialFor(n), CONFIG)]),
    ];
    expect(built.length).toBe(serviceProviderNames().length + tenantProviderNames().length);
    for (const [name, adapter] of built) {
      expect(adapter.name, name).toBe(name);
      expect(adapter.capabilities?.cancelRinging, name).toBe(findCarrier(name)!.cancelsRinging);
    }
  });

  it('a carrier with both modes reserves its service account`s ref, so no tenant credential can name it (CR3)', () => {
    const both = names.filter((n) => findCarrier(n)!.accounts.service && findCarrier(n)!.accounts.tenant);
    for (const name of both) {
      const spec = findCredentialSpec(name)!;
      expect(typeof spec.reservedAccountRefs, name).toBe('function');
      // Whatever the service's account ref is under this env, it is among those reserved.
      const reserved = spec.reservedAccountRefs!(CONFIG.telephony as TelephonyConfig);
      expect(reserved.length, name).toBeGreaterThan(0);
    }
  });

  it('a tenant adapter is built afresh from the credential, never the service account`s adapter', () => {
    for (const name of tenantProviderNames().filter((n) => findCarrier(n)!.accounts.service)) {
      const service = findServiceAdapterFactory(name)!(CONFIG);
      const tenant = findTenantAdapterFactory(name)!(credentialFor(name), CONFIG);
      expect(tenant, name).not.toBe(service);
      expect(tenant.name, name).toBe(name);
    }
  });

  it('inbound is declared only on tenant accounts, by a carrier whose tenant adapter serves it', () => {
    for (const name of names.filter((n) => findCarrier(n)!.inbound)) {
      expect(carrierTakesTenantAccounts(name), name).toBe(true);
      const adapter = findTenantAdapterFactory(name)!(credentialFor(name), CONFIG) as unknown as Record<string, unknown>;
      for (const method of INBOUND_METHODS) expect(typeof adapter[method], `${name}.${method}`).toBe('function');
      // A connected inbound call is recorded from its bind (docs/inbound.md §5).
      expect(recordsOnDemand(adapter as unknown as TelephonyProvider), name).toBe(true);
    }
  });

  it('each carrier’s webhook base is its own env block’s', () => {
    for (const name of names) {
      expect(findCarrier(name)!.webhookBaseUrl(CONFIG.telephony as TelephonyConfig), name).toBe(baseFor(name));
    }
  });
});

describe('carrier conformance: the modes today', () => {
  it('VoiceLink is the service’s account and tenants’ own (CR1), not inbound (CR11), its service recordings public', () => {
    expect(findCarrier('voicelink')).toMatchObject({
      accounts: { service: true, tenant: true }, inbound: false, serviceRecordingsArePublic: true, cancelsRinging: false,
    });
  });

  it('Plivo is tenant accounts only, inbound, never a public recording', () => {
    expect(findCarrier('plivo')).toMatchObject({
      accounts: { service: false, tenant: true }, inbound: true, serviceRecordingsArePublic: false, cancelsRinging: true,
    });
  });
});

describe('carrier catalogue: the mode helpers', () => {
  it.each([
    ['voicelink', { service: true, tenant: true, inbound: false }],
    ['plivo', { service: false, tenant: true, inbound: true }],
  ] as const)('%s reads its own entry', (name, want) => {
    expect(carrierHasServiceAccount(name)).toBe(want.service);
    expect(carrierTakesTenantAccounts(name)).toBe(want.tenant);
    expect(carrierSupportsInbound(name)).toBe(want.inbound);
  });

  it('a row’s account mode: a null credential needs a service account, a set one tenant accounts', () => {
    expect(carrierAccountModeAllowed('voicelink', null)).toBe(true);
    expect(carrierAccountModeAllowed('voicelink', 'cred-1')).toBe(true);
    expect(carrierAccountModeAllowed('plivo', null)).toBe(false);
    expect(carrierAccountModeAllowed('plivo', 'cred-1')).toBe(true);
  });

  it.each(['nope', '', 'Plivo', 'VOICELINK', '__proto__', 'constructor', null, undefined])(
    'a name no carrier answers to (%j) is false everywhere', (name) => {
      expect(findCarrier(name)).toBeUndefined();
      expect(carrierHasServiceAccount(name)).toBe(false);
      expect(carrierTakesTenantAccounts(name)).toBe(false);
      expect(carrierSupportsInbound(name)).toBe(false);
      expect(carrierCancelsRinging(name)).toBe(false);
      expect(carrierAccountModeAllowed(name, null)).toBe(false);
      expect(carrierAccountModeAllowed(name, 'cred-1')).toBe(false);
    });
});
