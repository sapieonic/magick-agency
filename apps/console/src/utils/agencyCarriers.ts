import { telephonyProviderAlias } from '@magick-agency/web-ui/telephonyProviders';
import { errorCode } from './agencyErrors';
import type { AgencyCampaign, AgencyCarrier } from '../types/agency-campaign';
import type { TenantPhoneAssignment } from '../types/phone-number';

/**
 * The carrier account a campaign dials on (decisions B18–B22): a carrier, and either the
 * service's own account on it (`telephony_credential_id: null`) or one of the tenant's own
 * carrier accounts. A campaign sends both fields exactly as `GET /proxy/agency/carriers`
 * lists them; its caller IDs must be numbers on that same account.
 *
 * UI copy names a carrier only by its alias (`telephonyProviderAlias`), never by the
 * identifier the API uses.
 */
export interface CarrierChoice {
  telephony_provider: string;
  telephony_credential_id: string | null;
}

/**
 * The service's own carrier account: every campaign's default (the column default on the
 * server), and what the console falls back to when the carriers list cannot be read.
 */
export const SERVICE_CARRIER: CarrierChoice = Object.freeze({
  telephony_provider: 'voicelink',
  telephony_credential_id: null,
});

/** A stable key for one carrier account (a select value, a React key, an equality test). */
export function carrierKey(carrier: CarrierChoice): string {
  return `${carrier.telephony_provider.toLowerCase()}:${carrier.telephony_credential_id ?? ''}`;
}

export function sameCarrier(a: CarrierChoice, b: CarrierChoice): boolean {
  return carrierKey(a) === carrierKey(b);
}

/** The carrier account a stored campaign dials on; an older record without one is on the service's. */
export function carrierOfCampaign(
  campaign: Pick<AgencyCampaign, 'telephony_provider' | 'telephony_credential_id'>,
): CarrierChoice {
  const provider = campaign.telephony_provider?.trim();
  return {
    telephony_provider: provider ? provider : SERVICE_CARRIER.telephony_provider,
    telephony_credential_id: campaign.telephony_credential_id ?? null,
  };
}

/**
 * What the operator reads for a carrier account: the carrier's alias, and for one of the
 * tenant's own accounts the label a platform administrator gave it ("Pravah (Acme main)").
 */
export function carrierName(carrier: CarrierChoice & { label?: string | null }): string {
  const alias = telephonyProviderAlias(carrier.telephony_provider);
  if (carrier.telephony_credential_id === null) return alias;
  const label = carrier.label?.trim();
  return `${alias} (${label ? label : 'your own account'})`;
}

/** Whether a number of the account dials on this carrier account: same carrier AND same credential. */
export function numberOnCarrier(
  number: Pick<TenantPhoneAssignment, 'provider_name' | 'telephony_credential_id'>,
  carrier: CarrierChoice,
): boolean {
  return (
    (number.provider_name ?? '').toLowerCase() === carrier.telephony_provider.toLowerCase()
    && (number.telephony_credential_id ?? null) === carrier.telephony_credential_id
  );
}

export interface CarrierOption extends CarrierChoice {
  key: string;
  name: string;
  /** The campaign's own carrier account, which the list no longer offers (disabled, revoked). */
  unavailable: boolean;
}

/**
 * The choices a carrier picker offers: every listed carrier account, plus the campaign's
 * current one when the list no longer has it (so it is shown as it is, never silently
 * swapped for another on save).
 */
export function carrierOptions(
  listed: readonly AgencyCarrier[],
  current: CarrierChoice | null,
): CarrierOption[] {
  const options: CarrierOption[] = listed.map((c) => ({
    telephony_provider: c.telephony_provider,
    telephony_credential_id: c.telephony_credential_id,
    key: carrierKey(c),
    name: carrierName(c),
    unavailable: false,
  }));
  if (current && !options.some((o) => sameCarrier(o, current))) {
    options.push({
      ...current,
      key: carrierKey(current),
      name: `${carrierName(current)}, not active`,
      unavailable: true,
    });
  }
  return options;
}

// ── Refusals and pauses ──────────────────────────────────────────────────────

export type CarrierRefusalCode = 'telephony_credential_not_found' | 'telephony_credential_not_active';

/**
 * The campaign routes' carrier refusals (create, save, start, resume), said in words an
 * operator can act on. The server's own message names the account's state; these say
 * who can fix it: support, never "your administrator" (PL15: a tenant's admins cannot see
 * or change a carrier account; only the service's operators can).
 */
export const CARRIER_REFUSAL_COPY: Record<CarrierRefusalCode, string> = {
  telephony_credential_not_active:
    'This campaign’s carrier account is not active: it has been disabled, or the carrier no '
    + 'longer accepts its credentials. Calls cannot be placed on it. Contact support to have it '
    + 're-enabled, or choose another carrier for this campaign.',
  telephony_credential_not_found:
    'This campaign’s carrier account no longer exists. Choose another carrier for this campaign.',
};

/** The sentence for a carrier refusal, or null when `err` is not one. */
export function carrierRefusal(err: unknown): string | null {
  const code = errorCode(err);
  return code === 'telephony_credential_not_active' || code === 'telephony_credential_not_found'
    ? CARRIER_REFUSAL_COPY[code]
    : null;
}

/**
 * A campaign write refused for its carrier account, carrying the operator's sentence as
 * its message: whoever shows `err.message` (the roster import, a banner) shows the copy.
 */
export class CarrierRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CarrierRefusalError';
  }
}

/** `err` as a {@link CarrierRefusalError} when it is a carrier refusal, else unchanged. */
export function withCarrierRefusalCopy(err: unknown): unknown {
  const copy = carrierRefusal(err);
  return copy === null ? err : new CarrierRefusalError(copy);
}

/** The pause reason the dialler writes when the carrier refused the campaign's account credentials. */
export const CARRIER_AUTH_PAUSE_REASON = 'carrier_auth';

/** What a `carrier_auth` pause says, wherever a pause reason is shown. */
export const CARRIER_AUTH_PAUSE_COPY =
  'Paused: the carrier refused this account’s credentials. Contact support to have them checked.';

/**
 * The pause reason the dialler writes when the campaign's carrier account is no longer
 * active (disabled, invalid or revoked since the campaign started).
 */
export const CARRIER_ACCOUNT_UNAVAILABLE_PAUSE_REASON = 'carrier_account_unavailable';

/** What a `carrier_account_unavailable` pause says, wherever a pause reason is shown. */
export const CARRIER_ACCOUNT_UNAVAILABLE_PAUSE_COPY =
  'Paused: this campaign’s carrier account is no longer active. Contact support to have it re-enabled, or choose another carrier.';

/**
 * The copy for a pause the dialler made because the campaign's carrier account cannot
 * dial, or `null` for any other pause reason.
 */
export function carrierAccountPauseCopy(reason: string | null | undefined): string | null {
  if (reason === CARRIER_AUTH_PAUSE_REASON) return CARRIER_AUTH_PAUSE_COPY;
  if (reason === CARRIER_ACCOUNT_UNAVAILABLE_PAUSE_REASON) return CARRIER_ACCOUNT_UNAVAILABLE_PAUSE_COPY;
  return null;
}
