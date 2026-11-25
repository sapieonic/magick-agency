// `campaignCarrierRefusal` by account mode (docs/carriers.md CR1, CR8, CR9), against a catalogue
// double so each mode is named here whatever the real catalogue declares: `svc` has the service's
// account only, `both` both modes, `own` tenant accounts only. The repositories are scripted; the
// same rules against real Postgres are `test/integration/agency/campaign-carrier-modes.test.ts`.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const carriers = vi.hoisted(() => ({
  svc: { accounts: { service: true, tenant: false } },
  both: { accounts: { service: true, tenant: true } },
  own: { accounts: { service: false, tenant: true } },
}));
const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  credential: vi.fn(),
  credentialNumbers: vi.fn(),
  pinned: vi.fn(),
}));

vi.mock('../../../src/telephony/carrier-catalog.js', async (importOriginal) =>
  (await import('../../helpers/carrier-catalog-double.js')).catalogDouble(await importOriginal(), carriers));
vi.mock('../../../src/db/repositories/telephony-provider.repository.js', () => ({
  telephonyProviderRepository: { findByName: mocks.provider },
}));
vi.mock('@magick-agency/db/repositories/telephony-credential.repository', () => ({
  telephonyCredentialRepository: { findById: mocks.credential },
}));
vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({
  tenantPhoneAssignmentRepository: { findCredentialNumbersForAccount: mocks.credentialNumbers },
}));
vi.mock('@magick-agency/db/repositories/phone-number.repository', () => ({
  phoneNumberRepository: { findPinnedAmong: mocks.pinned },
}));

import { campaignCarrierRefusal } from '../../../src/agency/campaign-carrier.js';

const SCOPE = { tenantId: 't1', accountId: 'a1' };
const CRED = '0f9c2a4e-6b1d-4c3e-9a8f-1b2c3d4e5f60';
const OWN_NUMBER = '+14155550001';
const SERVICE_NUMBER = '+919000000001';
const ALL = { provider: true, credential: true, callerIds: true };
const CALLER_IDS_ONLY = { provider: false, credential: false, callerIds: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.provider.mockResolvedValue({ status: 'active' });
  mocks.credential.mockImplementation(async (id: string) => ({ id, tenant_id: 't1', provider: 'both', status: 'active' }));
  // The credential's numbers: OWN_NUMBER only. The pinned numbers: OWN_NUMBER only.
  mocks.credentialNumbers.mockImplementation(async (_t: string, _a: string, _c: string, numbers: string[]) => numbers.filter((n) => n === OWN_NUMBER));
  mocks.pinned.mockImplementation(async (numbers: string[]) => numbers.filter((n) => n === OWN_NUMBER));
});

const effective = (provider: string, credentialId: string | null, callerIds: string[]) => ({
  telephony_provider: provider, telephony_credential_id: credentialId, caller_ids: callerIds,
});

describe('the account mode (CR1, CR8)', () => {
  it('a null credential needs a service account: accepted on `svc` and `both`, refused on `own` naming the credential', async () => {
    expect(await campaignCarrierRefusal(SCOPE, effective('svc', null, [SERVICE_NUMBER]), ALL)).toBeNull();
    expect(await campaignCarrierRefusal(SCOPE, effective('both', null, [SERVICE_NUMBER]), ALL)).toBeNull();
    expect(await campaignCarrierRefusal(SCOPE, effective('own', null, [SERVICE_NUMBER]), ALL)).toEqual({
      kind: 'validation', details: { telephony_credential_id: expect.stringMatching(/^is required/) },
    });
  });

  it('a set credential needs tenant accounts: accepted on `both` and `own`, refused on `svc` naming the credential', async () => {
    mocks.credential.mockImplementation(async (id: string) => ({ id, tenant_id: 't1', provider: 'own', status: 'active' }));
    expect(await campaignCarrierRefusal(SCOPE, effective('own', CRED, [OWN_NUMBER]), ALL)).toBeNull();
    mocks.credential.mockImplementation(async (id: string) => ({ id, tenant_id: 't1', provider: 'both', status: 'active' }));
    expect(await campaignCarrierRefusal(SCOPE, effective('both', CRED, [OWN_NUMBER]), ALL)).toBeNull();
    expect(await campaignCarrierRefusal(SCOPE, effective('svc', CRED, [OWN_NUMBER]), ALL)).toEqual({
      kind: 'validation', details: { telephony_credential_id: expect.stringMatching(/^must be null/) },
    });
    expect(mocks.credential).toHaveBeenCalledTimes(2);
  });

  it('a carrier the catalogue does not know takes neither mode: the carrier is named', async () => {
    for (const credentialId of [null, CRED]) {
      expect(await campaignCarrierRefusal(SCOPE, effective('nobody', credentialId, [SERVICE_NUMBER]), ALL)).toEqual({
        kind: 'validation', details: { telephony_provider: 'must name a carrier this service can dial on' },
      });
    }
  });

  it('on `both`, the credential is still judged: of this tenant, of this carrier, active', async () => {
    mocks.credential.mockResolvedValueOnce({ id: CRED, tenant_id: 't2', provider: 'both', status: 'active' });
    expect(await campaignCarrierRefusal(SCOPE, effective('both', CRED, [OWN_NUMBER]), ALL)).toMatchObject({ code: 'telephony_credential_not_found' });
    mocks.credential.mockResolvedValueOnce({ id: CRED, tenant_id: 't1', provider: 'own', status: 'active' });
    expect(await campaignCarrierRefusal(SCOPE, effective('both', CRED, [OWN_NUMBER]), ALL)).toMatchObject({ code: 'telephony_credential_not_found' });
    mocks.credential.mockResolvedValueOnce({ id: CRED, tenant_id: 't1', provider: 'both', status: 'disabled' });
    expect(await campaignCarrierRefusal(SCOPE, effective('both', CRED, [OWN_NUMBER]), ALL)).toMatchObject({ code: 'telephony_credential_not_active' });
  });

  it('moving between the two modes on one carrier is a change of carrier account: every caller ID is judged, stored ones included', async () => {
    // From the service's account onto a credential: the stored service number is judged against the credential's numbers.
    const toCredential = await campaignCarrierRefusal(
      SCOPE, effective('both', CRED, [SERVICE_NUMBER, OWN_NUMBER]), { provider: false, credential: true, callerIds: false },
      effective('both', null, [SERVICE_NUMBER, OWN_NUMBER]),
    );
    expect(toCredential).toMatchObject({ kind: 'validation', details: { caller_ids: expect.stringContaining(SERVICE_NUMBER) } });
    expect(mocks.credentialNumbers).toHaveBeenCalledWith('t1', 'a1', CRED, [SERVICE_NUMBER, OWN_NUMBER]);

    // From a credential back onto the service's account: the stored pinned number is judged (CR9).
    const toService = await campaignCarrierRefusal(
      SCOPE, effective('both', null, [OWN_NUMBER]), { provider: false, credential: true, callerIds: false },
      effective('both', CRED, [OWN_NUMBER]),
    );
    expect(toService).toMatchObject({ kind: 'validation', details: { caller_ids: expect.stringContaining(OWN_NUMBER) } });
    expect(mocks.pinned).toHaveBeenCalledWith([OWN_NUMBER]);
  });
});

describe('the service`s own account takes no number pinned to a credential (CR9)', () => {
  it('a create naming a pinned number is refused, naming it and only it', async () => {
    const refusal = await campaignCarrierRefusal(SCOPE, effective('svc', null, [SERVICE_NUMBER, OWN_NUMBER]), ALL);
    expect(refusal).toEqual({
      kind: 'validation',
      details: { caller_ids: `a campaign on the service’s own carrier account cannot use a number of an organisation’s own carrier account; not: ${OWN_NUMBER}` },
    });
    expect(mocks.pinned).toHaveBeenCalledWith([SERVICE_NUMBER, OWN_NUMBER]);
  });

  it('a caller-ID edit is judged now (it used to return unjudged): only the numbers it ADDS', async () => {
    const stored = effective('svc', null, [SERVICE_NUMBER]);
    const adds = await campaignCarrierRefusal(SCOPE, effective('svc', null, [SERVICE_NUMBER, OWN_NUMBER]), CALLER_IDS_ONLY, stored);
    expect(adds).toMatchObject({ kind: 'validation', details: { caller_ids: expect.stringContaining(OWN_NUMBER) } });
    expect(mocks.pinned).toHaveBeenLastCalledWith([OWN_NUMBER]);
  });

  it('a pinned number already in the pool may stay: a save resending the pool reads nothing', async () => {
    const stored = effective('svc', null, [SERVICE_NUMBER, OWN_NUMBER]);
    expect(await campaignCarrierRefusal(SCOPE, effective('svc', null, [SERVICE_NUMBER, OWN_NUMBER]), CALLER_IDS_ONLY, stored)).toBeNull();
    expect(mocks.pinned).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it('numbers on no credential are accepted, on `svc` and on `both` alike', async () => {
    expect(await campaignCarrierRefusal(SCOPE, effective('svc', null, [SERVICE_NUMBER]), ALL)).toBeNull();
    expect(await campaignCarrierRefusal(SCOPE, effective('both', null, [SERVICE_NUMBER]), ALL)).toBeNull();
    expect(mocks.credential).not.toHaveBeenCalled();
    expect(mocks.credentialNumbers).not.toHaveBeenCalled();
  });

  it('names five numbers, then how many more', async () => {
    mocks.pinned.mockImplementation(async (numbers: string[]) => numbers);
    const many = Array.from({ length: 7 }, (_, i) => `+1415555010${i}`);
    const refusal = await campaignCarrierRefusal(SCOPE, effective('svc', null, many), ALL);
    expect(refusal).toMatchObject({ details: { caller_ids: expect.stringMatching(/\+14155550104 and 2 more$/) } });
  });
});
