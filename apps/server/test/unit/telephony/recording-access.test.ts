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

/*
 * The per-carrier recording access table (B21): VoiceLink keeps today's configured
 * hosts with nothing attached; Plivo gets exactly its media host and Basic auth from the
 * call's pinned credential, resolved for `recording`; anything the credential service
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

  it('refuses a VoiceLink call pinned to a tenant credential (an invariant breach, not guessed at)', async () => {
    const resolve = createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: () => source(cred()) });
    const err = await refusal(resolve(voicelinkCall({ telephony_credential_id: 'cred-1' })));
    expect(err.reason).toBe('credential_not_expected');
  });
});

describe('recording access: Plivo (the tenant\'s own account)', () => {
  it('is exactly media.plivo.com, exact match, Basic auth_id:auth_token from the credential resolved for recording', async () => {
    const creds = source(cred());
    const resolve = createRecordingAccessResolver({ voicelinkHosts: VL_HOSTS, credentials: () => creds });
    const access = await resolve(plivoCall());
    expect(creds.resolve).toHaveBeenCalledWith('cred-1', 'recording');
    expect(access.allowedHosts).toEqual(['media.plivo.com']);
    // The REST API host is not a recording host: a forged recording_url must not be
    // able to point a credentialed GET at the account API.
    expect(access.allowedHosts).not.toContain('api.plivo.com');
    expect(access.exactHosts).toBe(true);
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
