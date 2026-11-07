import { describe, expect, it } from 'vitest';
import {
  CARRIER_REFUSAL_COPY,
  CarrierRefusalError,
  SERVICE_CARRIER,
  carrierAccountPauseCopy,
  carrierActive,
  carrierName,
  carrierOfCampaign,
  carrierOptions,
  carrierRefusal,
  numberOnCarrier,
  withCarrierRefusalCopy,
} from '../../utils/agencyCarriers';
import type { AgencyCarrier } from '../../types/agency-campaign';
import { CARRIER_ACCOUNT_PAUSE_REASONS } from '@magick-agency/contracts/agency';

const CRED_A = '11111111-1111-4111-8111-111111111111';
const SERVICE: AgencyCarrier = { telephony_provider: 'voicelink', telephony_credential_id: null, label: null, status: 'active' };
const OWN_A: AgencyCarrier = { telephony_provider: 'plivo', telephony_credential_id: CRED_A, label: 'Acme main', status: 'active' };

describe('carrierName', () => {
  it('names the service’s account by alias and a tenant’s by alias and label, never the identifier', () => {
    expect(carrierName(SERVICE)).toBe('Swar');
    expect(carrierName(OWN_A)).toBe('Pravah (Acme main)');
    expect(carrierName({ ...OWN_A, label: null })).toBe('Pravah (your own account)');
  });
});

describe('numberOnCarrier', () => {
  it('needs the same carrier AND the same credential', () => {
    const own = { provider_name: 'Plivo', telephony_credential_id: CRED_A };
    expect(numberOnCarrier(own, OWN_A)).toBe(true);
    expect(numberOnCarrier({ ...own, telephony_credential_id: 'other' }, OWN_A)).toBe(false);
    expect(numberOnCarrier(own, SERVICE_CARRIER)).toBe(false);
    // An older server omits the field: the number is on the service's own account.
    expect(numberOnCarrier({ provider_name: 'voicelink' }, SERVICE_CARRIER)).toBe(true);
    expect(numberOnCarrier({ provider_name: 'voicelink' }, OWN_A)).toBe(false);
  });
});

describe('carrierOfCampaign', () => {
  it('reads the stored carrier account, and an older record as the service’s', () => {
    expect(carrierOfCampaign({})).toEqual(SERVICE_CARRIER);
    expect(carrierOfCampaign({ telephony_provider: 'plivo', telephony_credential_id: CRED_A }))
      .toEqual({ telephony_provider: 'plivo', telephony_credential_id: CRED_A });
  });
});

describe('carrierActive', () => {
  it('is whether the list still offers the account, and true while the list is unknown', () => {
    expect(carrierActive([SERVICE, OWN_A], { telephony_provider: 'plivo', telephony_credential_id: CRED_A })).toBe(true);
    expect(carrierActive([SERVICE], { telephony_provider: 'plivo', telephony_credential_id: CRED_A })).toBe(false);
    expect(carrierActive(null, { telephony_provider: 'plivo', telephony_credential_id: CRED_A })).toBe(true);
  });
});

describe('carrierOptions', () => {
  it('lists the carriers in order and adds the campaign’s own when the list lacks it', () => {
    expect(carrierOptions([SERVICE, OWN_A], SERVICE_CARRIER).map((o) => o.name)).toEqual(['Swar', 'Pravah (Acme main)']);
    const gone = { telephony_provider: 'plivo', telephony_credential_id: 'gone' };
    const options = carrierOptions([SERVICE], gone);
    expect(options.map((o) => [o.name, o.unavailable])).toEqual([
      ['Swar', false],
      ['Pravah (account no longer active)', true],
    ]);
  });
});

describe('carrier refusals', () => {
  const apiError = (code: string) => Object.assign(new Error('server words'), { statusCode: 409, details: { code } });

  it('turns the two codes into the console’s sentences, and leaves anything else alone', () => {
    expect(carrierRefusal(apiError('telephony_credential_not_active'))).toBe(CARRIER_REFUSAL_COPY.telephony_credential_not_active);
    expect(carrierRefusal(apiError('telephony_credential_not_found'))).toBe(CARRIER_REFUSAL_COPY.telephony_credential_not_found);
    expect(carrierRefusal(apiError('campaign_roster_empty'))).toBeNull();

    const wrapped = withCarrierRefusalCopy(apiError('telephony_credential_not_active'));
    expect(wrapped).toBeInstanceOf(CarrierRefusalError);
    expect((wrapped as Error).message).toBe(CARRIER_REFUSAL_COPY.telephony_credential_not_active);
    const other = apiError('campaign_roster_empty');
    expect(withCarrierRefusalCopy(other)).toBe(other);
  });

  /**
   * PL15: a tenant's admins cannot see or fix a carrier account, so the copy never sends a
   * supervisor to "your administrator"; it says to contact support (B17's phrase).
   */
  it('sends the operator to support, never to an administrator', () => {
    const pauses = CARRIER_ACCOUNT_PAUSE_REASONS.map((reason) => carrierAccountPauseCopy(reason));
    for (const copy of [...Object.values(CARRIER_REFUSAL_COPY), ...pauses]) expect(copy).not.toMatch(/administrator/i);
    expect(CARRIER_REFUSAL_COPY.telephony_credential_not_active).toMatch(/Contact support/);
    for (const copy of pauses) expect(copy).toMatch(/^Paused: .*Contact support/);
  });

  it('is British English and names no carrier', () => {
    for (const copy of Object.values(CARRIER_REFUSAL_COPY)) {
      expect(copy).not.toMatch(/plivo|voicelink|vobiz|twilio/i);
    }
  });
});
