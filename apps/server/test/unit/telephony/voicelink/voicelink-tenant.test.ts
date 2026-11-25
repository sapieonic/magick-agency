import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VoiceLink on a tenant's own account (docs/carriers.md CR2, CR4), against the mock carrier over
 * real sockets: the tenant factory builds its adapter from env plus the credential's login only;
 * a tenant adapter's refusals are typed for the dial path (a refused login and a 401 after one
 * re-login are `CarrierAuthRejectedError`, a 4xx `CarrierDialRefusedError` the PL11 breaker
 * counts), while a service adapter's errors are what they always were; the `dial` and
 * `call_control` adapters of one credential share one login, and a rotation brings a new one;
 * the registry resolves a VoiceLink credential and still refuses a mismatch.
 */

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../../../src/config/index.js';
import { VoicelinkAdapter } from '../../../../src/telephony/voicelink/voicelink.adapter.js';
import { VoicelinkTokenManager } from '../../../../src/telephony/voicelink/voicelink-token-manager.js';
import {
  VOICELINK_TENANT_LOGINS_MAX,
  createVoicelinkTenantAdapter,
  resetVoicelinkTenantLoginsForTests,
  voicelinkTenantLogin,
  voicelinkTenantLoginCount,
} from '../../../../src/telephony/voicelink/voicelink-tenant.js';
import {
  ByocCredentialUnavailableError,
  TelephonyProviderRegistry,
  type CredentialResolver,
} from '../../../../src/telephony/factory.js';
import type { ResolvedCredential, ResolvePurpose } from '../../../../src/telephony/credentials/credential-service.js';
import { Secret } from '../../../../src/telephony/credentials/secret.js';
import {
  CarrierAuthRejectedError,
  CarrierDialNotSentError,
  CarrierDialOutcomeUnknownError,
  CarrierDialRefusedError,
  CarrierRateLimitedError,
  CarrierRequestTimeoutError,
  carrierDialNotSentReason,
  isCarrierAuthRejected,
  isDialOutcomeUnknown,
} from '../../../../src/telephony/carrier-errors.js';
import { WebRtcCallError } from '../../../../src/core/bridge/bridge-types.js';
import { carrierUnplacedRefusal, classifyDialRefusal } from '../../../../src/core/bridge/dial-refusals.js';
import { countsTowardBreaker } from '../../../../src/agency/carrier-refusal-breaker.js';
import { MockVoicelinkCarrier } from '../../../mocks/voicelink/index.js';

const TENANT_USER = 'tenant-vl-user';
const TENANT_PASSWORD = ' tenant pass ';
const TENANT_ID = 't1';

let carrier: MockVoicelinkCarrier;

function appConfig(over: Partial<AppConfig['telephony']['voicelink']> = {}): AppConfig {
  return {
    telephony: {
      requireVoicelink: false,
      voicelink: { ...carrier.config({ loginTimeoutMs: 1_000, addLeadTimeoutMs: 1_000 }), ...over },
      plivo: { webhookBaseUrl: '' },
    },
  } as unknown as AppConfig;
}

function credential(over: Partial<ResolvedCredential> = {}, password = TENANT_PASSWORD): ResolvedCredential {
  return {
    id: 'vl-cred-1', tenantId: TENANT_ID, provider: 'voicelink', accountRef: TENANT_USER,
    publicConfig: { username: TENANT_USER }, version: 1, secret: new Secret({ password }), previous: [], ...over,
  };
}

function dialRequest() {
  const callId = randomUUID();
  return {
    callId,
    to: '+919812345678',
    from: '+919800000001',
    webhookUrl: `https://agency.test/api/v1/webhooks/voicelink/webrtc-answer/${callId}`,
    statusCallbackUrl: `https://agency.test/api/v1/webhooks/voicelink/webrtc-status/${callId}?token=${randomUUID()}`,
    mediaStreamUrl: `wss://agency.test/api/v1/webrtc-call/${callId}/pstn-stream?token=${randomUUID()}`,
    maxDuration: 1800,
    enableRecording: false,
    machineDetection: false,
  };
}

const tenantAdapter = (over: Partial<AppConfig['telephony']['voicelink']> = {}, cred = credential()) =>
  createVoicelinkTenantAdapter(cred, appConfig(over));
const serviceAdapter = () => new VoicelinkAdapter(appConfig().telephony.voicelink, { accountMode: 'service' });

async function dialError(adapter: VoicelinkAdapter): Promise<unknown> {
  return adapter.initiateCall(dialRequest()).then(() => null, (e: unknown) => e);
}

/** The bridge's wrapping of a carrier refusal (`telephony_init_failed`, the adapter's error as `cause`). */
function asBridgeRefusal(err: unknown): WebRtcCallError {
  const out = new WebRtcCallError('refused', 'telephony_init_failed', 502);
  out.cause = err;
  return out;
}

beforeAll(async () => {
  carrier = new MockVoicelinkCarrier();
  await carrier.start();
});
beforeEach(() => {
  carrier.addAccount(TENANT_USER, TENANT_PASSWORD);
  resetVoicelinkTenantLoginsForTests();
});
afterEach(() => {
  carrier.reset();
  carrier.revokeTokens();
  carrier.refuseLogins(TENANT_USER, null);
});
afterAll(async () => {
  await carrier.stop();
});

describe('the tenant factory: env for everything but the login (CR2)', () => {
  it('dials on the credential`s username and password, never the service login, to this deployment`s host', async () => {
    const adapter = tenantAdapter();
    expect(adapter).toBeInstanceOf(VoicelinkAdapter);
    expect(adapter.accountMode).toBe('tenant');
    await adapter.initiateCall(dialRequest());
    const [login] = carrier.requestsTo('login');
    expect(login!.body).toEqual({ username: TENANT_USER, password: TENANT_PASSWORD });
    const [lead] = carrier.requestsTo('add_lead');
    expect(lead).toMatchObject({ account: TENANT_USER, status: 200 });
    expect(carrier.requestsAs(carrier.username)).toEqual([]);
  });

  it('refuses a credential with no password or username, naming neither value', () => {
    expect(() => createVoicelinkTenantAdapter(credential({}, ''), appConfig())).toThrow(/no VoiceLink username or password/);
    expect(() => createVoicelinkTenantAdapter(credential({ accountRef: '', publicConfig: {} }), appConfig())).toThrow(/vl-cred-1/);
  });

  it('with no VOICELINK_BASE_URL, refuses the dial before the carrier as a configuration fault', async () => {
    const err = await dialError(tenantAdapter({ baseUrl: '' }));
    expect(err).toBeInstanceOf(CarrierDialNotSentError);
    expect(carrierDialNotSentReason(err)).toBe('configuration');
    expect(carrier.requests).toEqual([]);
  });
});

describe('a tenant adapter`s refusals are typed for the dial path (CR4); a service adapter`s are as before', () => {
  it.each([401, 403, 422])('a login refused %i: tenant → CarrierAuthRejectedError (carrier_auth, unplaced); service → a plain Error', async (status) => {
    carrier.refuseLogins(TENANT_USER, status);
    const tenantErr = await dialError(tenantAdapter());
    expect(tenantErr).toBeInstanceOf(CarrierAuthRejectedError);
    expect(tenantErr).toMatchObject({ provider: 'voicelink', httpStatus: status });
    expect(carrierUnplacedRefusal(tenantErr)?.code).toBe('carrier_auth_rejected');
    expect(carrier.requestsTo('add_lead')).toEqual([]);
    expect(JSON.stringify(tenantErr)).not.toContain(TENANT_PASSWORD.trim());

    carrier.refuseLogins(carrier.username, status);
    const serviceErr = await dialError(serviceAdapter());
    expect(serviceErr).toBeInstanceOf(Error);
    expect((serviceErr as Error).message).toBe(`VoiceLink login failed: HTTP ${status}`);
    expect(isCarrierAuthRejected(serviceErr)).toBe(false);
    carrier.refuseLogins(carrier.username, null);
  });

  it('a login refused 500 is a plain failure on either account (it says nothing about the credential)', async () => {
    carrier.refuseLogins(TENANT_USER, 500);
    const err = await dialError(tenantAdapter());
    expect(isCarrierAuthRejected(err)).toBe(false);
    expect((err as Error).message).toBe('VoiceLink login failed: HTTP 500');
  });

  it('an add_lead still 401 after one re-login: tenant → CarrierAuthRejectedError; service → a plain Error', async () => {
    carrier.injectFault('add_lead', { kind: 'status', status: 401 }, 2);
    const tenantErr = await dialError(tenantAdapter());
    expect(tenantErr).toMatchObject({ carrierAuthRejected: true, provider: 'voicelink', httpStatus: 401 });
    expect(carrier.requestsTo('login')).toHaveLength(2);
    expect(carrier.requestsTo('add_lead')).toHaveLength(2);

    carrier.reset();
    carrier.injectFault('add_lead', { kind: 'status', status: 401 }, 2);
    const serviceErr = await dialError(serviceAdapter());
    expect(isCarrierAuthRejected(serviceErr)).toBe(false);
    expect((serviceErr as Error).message).toMatch(/^VoiceLink \/v1\/add_lead error 401/);
  });

  it('one 401 then a re-login that works places the dial on either account', async () => {
    carrier.injectFault('add_lead', { kind: 'status', status: 401 }, 1);
    await expect(tenantAdapter().initiateCall(dialRequest())).resolves.toMatchObject({ providerCallId: expect.any(String) });
    expect(carrier.requestsTo('add_lead').map((r) => r.status)).toEqual([401, 200]);
  });

  it.each([400, 403, 404, 422])('add_lead %i: tenant → CarrierDialRefusedError the breaker counts; service → a plain Error it does not', async (status) => {
    carrier.injectFault('add_lead', { kind: 'status', status });
    const tenantErr = await dialError(tenantAdapter());
    expect(tenantErr).toBeInstanceOf(CarrierDialRefusedError);
    expect(tenantErr).toMatchObject({ provider: 'voicelink', httpStatus: status });
    expect(classifyDialRefusal(asBridgeRefusal(tenantErr))).toEqual({ kind: 'carrier_refused', outcomeUnknown: false, httpStatus: status });
    expect(countsTowardBreaker(asBridgeRefusal(tenantErr))).toBe(true);

    carrier.injectFault('add_lead', { kind: 'status', status });
    const serviceErr = await dialError(serviceAdapter());
    expect(serviceErr).not.toBeInstanceOf(CarrierDialRefusedError);
    expect((serviceErr as Error).message).toMatch(new RegExp(`^VoiceLink /v1/add_lead error ${status}`));
    expect(countsTowardBreaker(asBridgeRefusal(serviceErr))).toBe(false);
  });

  it('add_lead 503: tenant → CarrierDialRefusedError(503), which the breaker never counts (an outage, PL11)', async () => {
    carrier.injectFault('add_lead', { kind: 'status', status: 503 });
    const err = await dialError(tenantAdapter());
    expect(err).toMatchObject({ carrierDialRefused: true, httpStatus: 503 });
    expect(countsTowardBreaker(asBridgeRefusal(err))).toBe(false);
  });

  it('add_lead 429: tenant → CarrierRateLimitedError (back-pressure, unplaced, uncharged); service → a plain Error', async () => {
    carrier.injectFault('add_lead', { kind: 'status', status: 429 });
    const err = await dialError(tenantAdapter());
    expect(err).toBeInstanceOf(CarrierRateLimitedError);
    expect(carrierUnplacedRefusal(err)?.code).toBe('carrier_rate_limited');
    carrier.injectFault('add_lead', { kind: 'status', status: 429 });
    expect(await dialError(serviceAdapter())).not.toBeInstanceOf(CarrierRateLimitedError);
  });

  it.each(['tenant', 'service'] as const)('%s: a timed-out or unreadable 2xx add_lead keeps its unknown outcome (never typed as a refusal)', async (mode) => {
    const adapter = mode === 'tenant' ? tenantAdapter() : serviceAdapter();
    carrier.injectFault('add_lead', { kind: 'hang' });
    const timedOut = await dialError(adapter);
    expect(timedOut).toBeInstanceOf(CarrierRequestTimeoutError);
    expect(isDialOutcomeUnknown(timedOut)).toBe(true);
    expect(countsTowardBreaker(asBridgeRefusal(timedOut))).toBe(false);
    carrier.injectFault('add_lead', { kind: 'malformed' });
    const unreadable = await dialError(adapter);
    expect(unreadable).toBeInstanceOf(CarrierDialOutcomeUnknownError);
    expect(isDialOutcomeUnknown(unreadable)).toBe(true);
    expect(carrierUnplacedRefusal(unreadable)).toBeNull();
  });
});

describe('one login per credential and secret version, shared by its dial and call-control adapters (CR4)', () => {
  function resolver(state: { current: ResolvedCredential }): CredentialResolver {
    return {
      peek: vi.fn(async (_id: string, _p: ResolvePurpose) => {
        const r = state.current;
        return { id: r.id, tenantId: r.tenantId, provider: r.provider, version: r.version, versions: [r.version] };
      }),
      resolve: vi.fn(async () => state.current),
    };
  }

  it('the dial and call-control adapters are distinct but log in once between them', async () => {
    const state = { current: credential() };
    const registry = new TelephonyProviderRegistry(appConfig(), { credentials: () => resolver(state) });
    const dial = await registry.getForCredentialId('voicelink', 'vl-cred-1', 'dial', TENANT_ID);
    const control = await registry.getForCredentialId('voicelink', 'vl-cred-1', 'call_control', TENANT_ID);
    expect(dial).not.toBe(control);
    expect(dial).toBeInstanceOf(VoicelinkAdapter);
    expect((dial as VoicelinkAdapter).accountMode).toBe('tenant');
    await dial.initiateCall(dialRequest());
    // The call-control adapter's own authenticated request rides the same token.
    await control.getCallStatus('carrier-call-1');
    expect(carrier.requestsTo('login')).toHaveLength(1);
    const tokens = new Set(carrier.requests.filter((r) => r.route !== 'login').map((r) => r.authorization));
    expect(tokens.size).toBe(1);
    expect(voicelinkTenantLoginCount()).toBe(1);
  });

  it('a rotation (a new secret version) brings a new login with the new password, and drops the old one', async () => {
    const state = { current: credential() };
    const registry = new TelephonyProviderRegistry(appConfig(), { credentials: () => resolver(state) });
    await (await registry.getForCredentialId('voicelink', 'vl-cred-1', 'dial', TENANT_ID)).initiateCall(dialRequest());

    carrier.addAccount(TENANT_USER, 'rotated password');
    carrier.revokeTokens(TENANT_USER);
    state.current = credential({ version: 2 }, 'rotated password');
    const dial = await registry.getForCredentialId('voicelink', 'vl-cred-1', 'dial', TENANT_ID);
    await dial.initiateCall(dialRequest());
    const logins = carrier.requestsTo('login');
    expect(logins.map((l) => (l.body as { password: string }).password)).toEqual([TENANT_PASSWORD, 'rotated password']);
    expect(logins.map((l) => l.status)).toEqual([200, 200]);
    // Built on version 2's login, not handed version 1's.
    expect(carrier.requestsTo('add_lead').map((r) => r.status)).toEqual([200, 200]);
    expect(voicelinkTenantLoginCount()).toBe(1);
  });

  it('two credentials never share a login', () => {
    const a = voicelinkTenantLogin(credential(), appConfig().telephony.voicelink);
    const b = voicelinkTenantLogin(credential({ id: 'vl-cred-2' }), appConfig().telephony.voicelink);
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(VoicelinkTokenManager);
    expect(a.accountMode).toBe('tenant');
    expect(voicelinkTenantLogin(credential(), appConfig().telephony.voicelink)).toBe(a);
  });

  it('the cache is bounded, dropping the least recently used', () => {
    const settings = appConfig().telephony.voicelink;
    const first = voicelinkTenantLogin(credential({ id: 'c-0' }), settings);
    for (let i = 1; i < VOICELINK_TENANT_LOGINS_MAX; i++) voicelinkTenantLogin(credential({ id: `c-${i}` }), settings);
    expect(voicelinkTenantLogin(credential({ id: 'c-0' }), settings)).toBe(first); // refreshed: now the newest
    voicelinkTenantLogin(credential({ id: 'c-new' }), settings);
    expect(voicelinkTenantLoginCount()).toBe(VOICELINK_TENANT_LOGINS_MAX);
    expect(voicelinkTenantLogin(credential({ id: 'c-0' }), settings)).toBe(first);
  });

  it('an adapter refuses a login of the other account mode', () => {
    const settings = appConfig().telephony.voicelink;
    expect(() => new VoicelinkAdapter(settings, { accountMode: 'service', tokenManager: voicelinkTenantLogin(credential(), settings) }))
      .toThrow(/service account given a tenant login/);
  });
});

describe('the registry and a VoiceLink credential', () => {
  const resolverFor = (r: ResolvedCredential): CredentialResolver => ({
    peek: vi.fn(async () => ({ id: r.id, tenantId: r.tenantId, provider: r.provider, version: r.version, versions: [r.version] })),
    resolve: vi.fn(async () => r),
  });

  it('a null credential is the service account`s adapter, a set one a tenant adapter', async () => {
    const registry = new TelephonyProviderRegistry(appConfig(), { credentials: () => resolverFor(credential()) });
    const service = await registry.getForCredentialId('voicelink', null, 'dial', TENANT_ID);
    const tenant = await registry.getForCredentialId('voicelink', 'vl-cred-1', 'dial', TENANT_ID);
    expect((service as VoicelinkAdapter).accountMode).toBe('service');
    expect((tenant as VoicelinkAdapter).accountMode).toBe('tenant');
    expect(service).toBe(registry.get('voicelink'));
  });

  it.each([
    ['another tenant', credential({ tenantId: 't2' }), 'voicelink', /another tenant/],
    ['a Plivo credential asked for as VoiceLink', credential({ provider: 'plivo' }), 'voicelink', /credential is for plivo, not voicelink/],
    ['a VoiceLink credential asked for as Plivo', credential(), 'plivo', /credential is for voicelink, not plivo/],
  ] as const)('refuses %s without opening the secret', async (_l, cred, provider, message) => {
    const r = resolverFor(cred);
    const registry = new TelephonyProviderRegistry(appConfig(), { credentials: () => r });
    const err = await registry.getForCredentialId(provider, 'vl-cred-1', 'dial', TENANT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ByocCredentialUnavailableError);
    expect((err as Error).message).toMatch(message);
    expect(r.resolve).not.toHaveBeenCalled();
  });

  it('a refusal on a tenant adapter is recorded against its credential and secret version', async () => {
    const recordCarrierRefusal = vi.fn(async () => ({ id: 'vl-cred-1' }));
    const r = { ...resolverFor(credential({ version: 4 })), recordCarrierRefusal };
    const registry = new TelephonyProviderRegistry(appConfig(), { credentials: () => r });
    const adapter = await registry.getForCredentialId('voicelink', 'vl-cred-1', 'dial', TENANT_ID);
    const at = { tenantId: TENANT_ID, accountId: 'a1' };
    expect(await registry.recordCredentialRefused(adapter, 'refused', at)).toBe(true);
    expect(recordCarrierRefusal).toHaveBeenCalledWith('vl-cred-1', 4, 'refused', at);
    expect(await registry.recordCredentialRefused(registry.get('voicelink'), 'refused', at)).toBe(false);
  });
});
