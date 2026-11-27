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
import { accountRefReserved, credentialSpecs, findCredentialSpec } from '../../../src/telephony/credentials/credential-specs.js';
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
    voicelink: {
      baseUrl: 'https://vl.test', username: 'Service-VL-Login', password: 'service-vl-password',
      webhookBaseUrl: baseFor('voicelink'), defaultCountryCode: '91',
    },
    plivo: { webhookBaseUrl: baseFor('plivo') },
  },
} as unknown as AppConfig;

/**
 * The service account's own account ref and secrets under {@link CONFIG}, per carrier that
 * supports the service's account and tenant accounts both. A carrier added with both modes must
 * be added here, or the tests below fail for it.
 */
const SERVICE_ACCOUNT: Record<string, { ref: string; secrets: string[] }> = {
  voicelink: { ref: 'Service-VL-Login', secrets: ['Service-VL-Login', 'service-vl-password'] },
};

/** Every string reachable from `root` through own properties, Maps, Sets and arrays (cycles cut). */
function reachableStrings(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown): void => {
    if (typeof v === 'string') { out.push(v); return; }
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (v instanceof Map) { for (const [k, x] of v) { visit(k); visit(x); } return; }
    if (v instanceof Set || Array.isArray(v)) { for (const x of v) visit(x); return; }
    for (const key of Object.getOwnPropertyNames(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(root);
  return out;
}

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
    expect(both.length).toBeGreaterThan(0);
    for (const name of both) {
      const spec = findCredentialSpec(name)!;
      const own = SERVICE_ACCOUNT[name];
      expect(own, `${name}: list its service account under SERVICE_ACCOUNT`).toBeDefined();
      expect(typeof spec.reservedAccountRefs, name).toBe('function');
      const telephony = CONFIG.telephony as TelephonyConfig;
      expect(spec.reservedAccountRefs!(telephony), name).toContain(own!.ref);
      // And a tenant's form naming it, in any case, is refused as reserved.
      const field = spec.fields.find((f) => !f.secret)!.key;
      for (const typed of [own!.ref, own!.ref.toUpperCase(), ` ${own!.ref.toLowerCase()} `]) {
        const parsed = spec.publicSchema.parse({ [field]: typed });
        expect(accountRefReserved(spec, spec.accountRef(parsed), telephony), `${name}: ${typed}`).toBe(true);
      }
    }
  });

  it('a tenant adapter holds none of the service account`s login: it is built from the credential alone', () => {
    const both = tenantProviderNames().filter((n) => findCarrier(n)!.accounts.service);
    expect(both.length).toBeGreaterThan(0);
    for (const name of both) {
      const own = SERVICE_ACCOUNT[name]!;
      // Positive control: the service adapter does carry them, so the search can see them.
      const service = reachableStrings(findServiceAdapterFactory(name)!(CONFIG));
      for (const secret of own.secrets) expect(service, `${name} service adapter`).toContain(secret);
      const tenant = reachableStrings(findTenantAdapterFactory(name)!(credentialFor(name), CONFIG));
      for (const secret of own.secrets) {
        expect(tenant.some((v) => v.includes(secret)), `${name} tenant adapter holds the service's ${secret}`).toBe(false);
      }
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
  it('VoiceLink is the service’s account and tenants’ own (CR1), not inbound (CR11), its recordings public', () => {
    expect(findCarrier('voicelink')).toMatchObject({
      accounts: { service: true, tenant: true }, inbound: false, recordingsArePublic: true, cancelsRinging: false,
    });
  });

  it('Plivo is tenant accounts only, inbound, never a public recording', () => {
    expect(findCarrier('plivo')).toMatchObject({
      accounts: { service: false, tenant: true }, inbound: true, recordingsArePublic: false, cancelsRinging: true,
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
