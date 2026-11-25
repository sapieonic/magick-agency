import { describe, it, expect, vi } from 'vitest';
import {
  createRecordingAccessResolver,
  PLIVO_RECORDING_HOSTS,
  RecordingAccessRefusedError,
  recordingAccessProviders,
  refuseAllRecordingAccess,
  type RecordingCallRef,
} from '../../../src/telephony/recording-access.js';
import {
  CredentialUnavailableError,
  type CredentialUnavailableKind,
  type ResolvedCredential,
} from '../../../src/telephony/credentials/credential-service.js';
import { Secret } from '../../../src/telephony/credentials/secret.js';
import { recordingHostMatches } from '../../../src/utils/recording-proxy.js';

/*
 * The per-carrier recording access table (B21): VoiceLink keeps today's configured
 * hosts with nothing attached; Plivo gets its media hosts (`media.plivo.com` and its
 * regional subdomains, never `api.plivo.com`: PL6 as amended 2026-11-18) and Basic auth
 * from the call's pinned credential, resolved for `recording`; anything the credential service
 * refuses (revoked above all), a missing credential, a credential of another tenant or
 * provider, and an unknown provider are typed refusals with no fallback (B20).
 */

const TENANT = 'ten-1';
const AUTH_ID = 'MAXXXXXXXXXXXXXXXXXX';
const AUTH_TOKEN = 'tok_abcdefghijklmnop';
const VL_HOSTS = ['voicelink.test'];

function cred(over: Partial<ResolvedCredential> = {}): ResolvedCredential {
  return {
    id: 'cred-1', tenantId: TENANT, provider: 'plivo', accountRef: AUTH_ID, publicConfig: { auth_id: AUTH_ID },
    version: 3, secret: new Secret({ auth_token: AUTH_TOKEN }), previous: [], ...over,
  };
}

function source(result: ResolvedCredential | Error) {
  return {
    resolve: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

const plivoCall = (over: Partial<RecordingCallRef> = {}): RecordingCallRef =>
  ({ provider: 'plivo', telephony_credential_id: 'cred-1', tenant_id: TENANT, ...over });
const voicelinkCall = (over: Partial<RecordingCallRef> = {}): RecordingCallRef =>
  ({ provider: 'voicelink', telephony_credential_id: null, tenant_id: TENANT, ...over });

async function refusal(p: Promise<unknown>): Promise<RecordingAccessRefusedError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(RecordingAccessRefusedError);
  return err as RecordingAccessRefusedError;
}

describe('recording access: VoiceLink (the service account)', () => {
  it('is the configured hosts, exact-or-subdomain, with no headers and no credential lookup', async () => {
    const creds = source(cred());
    const resolve = createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: () => creds });
    await expect(resolve(voicelinkCall())).resolves.toEqual({ allowedHosts: VL_HOSTS, headers: {}, exactHosts: false });
    expect(creds.resolve).not.toHaveBeenCalled();
  });

});

describe('recording access: VoiceLink (a tenant\'s own account, CR12)', () => {
  const VL_PASSWORD = 'tenant vl password ';
  const vlCred = (over: Partial<ResolvedCredential> = {}) => cred({
    provider: 'voicelink', accountRef: 'tenant-vl', publicConfig: { username: 'tenant-vl' },
    secret: new Secret({ password: VL_PASSWORD }), ...over,
  });
  const pinned = (over: Partial<RecordingCallRef> = {}) => voicelinkCall({ telephony_credential_id: 'cred-1', ...over });

  it('resolves the pinned credential for recording first, then the configured hosts with nothing attached', async () => {
    const creds = source(vlCred());
    const resolve = createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: () => creds });
    const access = await resolve(pinned());
    expect(access).toEqual({ allowedHosts: VL_HOSTS, headers: {}, exactHosts: false });
    expect(creds.resolve).toHaveBeenCalledWith('cred-1', 'recording');
    // The credential is never sent with the fetch: VoiceLink serves recordings unauthenticated.
    expect(JSON.stringify(access)).not.toContain(VL_PASSWORD.trim());
    expect(JSON.stringify(access)).not.toContain('tenant-vl');
  });

  it('honours the configured hosts, whatever they are', async () => {
    const resolve = createRecordingAccessResolver({ voicelinkHosts: ['rec.example', 'cdn.example'], credentials: () => source(vlCred()) });
    expect((await resolve(pinned())).allowedHosts).toEqual(['rec.example', 'cdn.example']);
  });

  it('a revoked credential ends access (permanent credential_unavailable), with no fallback to the service hosts', async () => {
    const resolve = createRecordingAccessResolver({
      voicelinkHosts: VL_HOSTS, credentials: () => source(new CredentialUnavailableError('cred-1', 'status', 'revoked')),
    });
    const err = await refusal(resolve(pinned()));
    expect(err).toMatchObject({ reason: 'credential_unavailable', credentialKind: 'status', provider: 'voicelink', credentialId: 'cred-1' });
    expect(err.permanent).toBe(true);
  });

  it.each([
    ['another tenant', { tenantId: 'ten-2' }],
    ['another provider (a Plivo credential on a VoiceLink call)', { provider: 'plivo' }],
  ])('refuses a credential of %s', async (_l, over) => {
    const resolve = createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: () => source(vlCred(over)) });
    expect((await refusal(resolve(pinned()))).reason).toBe('credential_mismatch');
  });
});

describe('recording access: Plivo (the tenant\'s own account)', () => {
  it('is media.plivo.com and its subdomains, Basic auth_id:auth_token from the credential resolved for recording', async () => {
    const creds = source(cred());
    const resolve = createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: () => creds });
    const access = await resolve(plivoCall());
    expect(creds.resolve).toHaveBeenCalledWith('cred-1', 'recording');
    expect(access.allowedHosts).toEqual(['media.plivo.com']);
    // The REST API host is not a recording host: a forged recording_url must not be
    // able to point a credentialed GET at the account API.
    expect(access.allowedHosts).not.toContain('api.plivo.com');
    // Exact-or-subdomain of media.plivo.com: the regional media hosts (aps1.media.plivo.com)
    // too. Which hosts that admits and refuses is pinned below.
    expect(access.exactHosts).toBe(false);
    expect(access.headers).toEqual({ Authorization: `Basic ${Buffer.from(`${AUTH_ID}:${AUTH_TOKEN}`).toString('base64')}` });
    expect(PLIVO_RECORDING_HOSTS).toEqual(['media.plivo.com']);
  });

  it('never takes a host from the VoiceLink list or the call', async () => {
    const resolve = createRecordingAccessResolver({ voicelinkHosts: ['evil.example'], credentials: () => source(cred()) });
    expect((await resolve(plivoCall())).allowedHosts).toEqual(['media.plivo.com']);
  });

  it('refuses a Plivo call with no pinned credential without asking the store (no fallback, B20)', async () => {
    const creds = source(cred());
    const resolve = createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: () => creds });
    const err = await refusal(resolve(plivoCall({ telephony_credential_id: null })));
    expect(err.reason).toBe('credential_required');
    expect(err.permanent).toBe(true);
    expect(creds.resolve).not.toHaveBeenCalled();
  });

  it('a revoked credential is a permanent credential_unavailable refusal', async () => {
    const resolve = createRecordingAccessResolver({
      voicelinkHosts: VL_HOSTS,
      credentials: () => source(new CredentialUnavailableError('cred-1', 'status', 'revoked')),
    });
    const err = await refusal(resolve(plivoCall()));
    expect(err).toMatchObject({ reason: 'credential_unavailable', credentialKind: 'status', credentialId: 'cred-1', provider: 'plivo' });
    expect(err.permanent).toBe(true);
  });

  it.each<[CredentialUnavailableKind, boolean]>([
    ['not_found', true], ['shredded', true], ['no_current_secret', true],
    ['store_unconfigured', false], ['unopenable', false],
  ])('credential kind %s refuses (permanent: %s)', async (kind, permanent) => {
    const resolve = createRecordingAccessResolver({
      voicelinkHosts: VL_HOSTS, credentials: () => source(new CredentialUnavailableError('cred-1', kind, kind)),
    });
    const err = await refusal(resolve(plivoCall()));
    expect(err.credentialKind).toBe(kind);
    expect(err.permanent).toBe(permanent);
  });

  it.each([
    ['another tenant', cred({ tenantId: 'ten-2' })],
    ['another provider', cred({ provider: 'acme' })],
  ])('refuses a credential of %s', async (_l, c) => {
    const resolve = createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: () => source(c) });
    expect((await refusal(resolve(plivoCall()))).reason).toBe('credential_mismatch');
  });

  it('refuses a credential with no auth token', async () => {
    const resolve = createRecordingAccessResolver({
      voicelinkHosts: VL_HOSTS, credentials: () => source(cred({ secret: new Secret({}) })),
    });
    expect((await refusal(resolve(plivoCall()))).reason).toBe('credential_unavailable');
  });

  it('lets any other error (a database fault) propagate unchanged', async () => {
    const boom = new Error('connection refused');
    const resolve = createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: () => source(boom) });
    await expect(resolve(plivoCall())).rejects.toBe(boom);
  });

  it('accepts an async credential source (the lazy process service)', async () => {
    const resolve = createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: async () => source(cred()) });
    expect((await resolve(plivoCall())).headers['Authorization']).toMatch(/^Basic /);
  });

  it('a refusal carries no secret material', async () => {
    const resolve = createRecordingAccessResolver({
      voicelinkHosts: VL_HOSTS, credentials: () => source(cred({ tenantId: 'ten-2' })),
    });
    const err = await refusal(resolve(plivoCall()));
    expect(`${err.message} ${JSON.stringify(err)}`).not.toContain(AUTH_TOKEN);
  });
});

/*
 * Which URLs the Plivo access admits, through the matcher every fetch uses (the playback
 * proxy and the analysis worker both call `fetchWithAllowedRedirects` with these
 * `allowedHosts` and `exactHosts`). The credential goes with the first request to any
 * URL admitted here, so the refusals are what keeps it off the account API and off
 * hosts that are not Plivo's.
 */
describe("recording access: Plivo's media hosts (PL6 as amended 2026-11-18)", () => {
  async function plivoAccess() {
    return createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: () => source(cred()) })(plivoCall());
  }
  const PATH = `/v1/Account/${AUTH_ID}/Recording/r-1.mp3`;

  it.each([
    ['the global media host', `https://media.plivo.com${PATH}`],
    ['the aps1 regional media host (staging, 2026-11-17)', `https://aps1.media.plivo.com${PATH}`],
    ['another regional media host', `https://usw1.media.plivo.com${PATH}`],
    ['a regional host in capitals (DNS is case-blind)', `https://APS1.Media.Plivo.COM${PATH}`],
    ['a regional host with a trailing dot', `https://aps1.media.plivo.com.${PATH}`],
  ])('accepts %s', async (_l, url) => {
    const access = await plivoAccess();
    expect(recordingHostMatches(url, access.allowedHosts, access.exactHosts)).toBe(true);
  });

  it.each([
    ['the REST API host', `https://api.plivo.com/v1/Account/${AUTH_ID}/Call/`],
    ['the apex', `https://plivo.com${PATH}`],
    ['another Plivo host', `https://www.plivo.com${PATH}`],
    ['a host that ends in media.plivo.com without the dot', `https://evilmedia.plivo.com${PATH}`],
    ['the media host as a prefix of another domain', `https://media.plivo.com.evil.com${PATH}`],
    ['a regional host as a prefix of another domain', `https://aps1.media.plivo.com.evil.com${PATH}`],
    ['a lookalike domain', `https://media-plivo.com${PATH}`],
    ['the media host as userinfo', `https://media.plivo.com@evil.com${PATH}`],
    ['a regional host and port as userinfo', `https://aps1.media.plivo.com:443@evil.com${PATH}`],
    ['the media host after a backslash', `https://evil.com\\@aps1.media.plivo.com${PATH}`],
    ['the media host in the path', `https://evil.com/aps1.media.plivo.com${PATH}`],
    ['the media host in the query', `https://evil.com${PATH}?h=aps1.media.plivo.com`],
    ['the media host in the fragment', `https://evil.com${PATH}#.media.plivo.com`],
    ['an empty label before the media host', `https://.media.plivo.com${PATH}`],
    ['an empty label inside a regional host', `https://aps1..media.plivo.com${PATH}`],
    ['a regional host over http', `http://aps1.media.plivo.com${PATH}`],
    ['the media host over http', `http://media.plivo.com${PATH}`],
  ])('refuses %s', async (_l, url) => {
    const access = await plivoAccess();
    expect(recordingHostMatches(url, access.allowedHosts, access.exactHosts)).toBe(false);
  });
});

describe('recording access: the table', () => {
  it('refuses an unknown provider', async () => {
    const resolve = createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: () => source(cred()) });
    expect((await refusal(resolve({ provider: 'acme', telephony_credential_id: null, tenant_id: TENANT }))).reason)
      .toBe('unknown_provider');
  });

  it('lists exactly the carriers it can fetch for', () => {
    expect(recordingAccessProviders().sort()).toEqual(['plivo', 'voicelink']);
  });

  it('the refuse-all default gives VoiceLink an empty list and refuses every BYOC credential', async () => {
    expect((await refuseAllRecordingAccess(voicelinkCall())).allowedHosts).toEqual([]);
    const err = await refusal(refuseAllRecordingAccess(plivoCall()));
    expect(err).toMatchObject({ reason: 'credential_unavailable', credentialKind: 'store_unconfigured' });
  });
});
