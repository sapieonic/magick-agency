import { telephonyProviderAlias } from '@magick-agency/web-ui/telephonyProviders';
import { errorCode } from './agencyErrors';
import type { AgencyCampaign, AgencyCarrier } from '../types/agency-campaign';
import type { CarrierAccountPauseReason } from '@magick-agency/contracts/agency';
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

/**
 * Whether the carriers list still offers `carrier` (only active carrier accounts are
 * listed). `true` while the list is unknown (not read yet, or unreadable), so nothing is
 * called inactive on a guess.
 */
export function carrierActive(listed: readonly AgencyCarrier[] | null | undefined, carrier: CarrierChoice): boolean {
  return !listed || listed.some((c) => sameCarrier(c, carrier));
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
      // The list no longer has it, so neither its label nor its state is known here:
      // say only that it is no longer active, never "your own account" as if a label.
      name: current.telephony_credential_id === null
        ? `${carrierName(current)}, not active`
        : `${telephonyProviderAlias(current.telephony_provider)} (account no longer active)`,
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

/**
 * What an automatic carrier pause says, in pieces each surface composes: the Insights
 * headline ("Paused by", then "Automatic, <when>: <cause>. <action>"), its transitions, the
 * Activity trail ("Paused: <cause>. <action>") and the health strip ("Paused automatically —
 * <cause>." with the action as its advice).
 */
export interface CarrierPauseCopy {
  /** Who or what paused the campaign, for "Paused by". Never "the dialler": it only acted on it. */
  by: string;
  /** What happened, as the end of a sentence (lower case, no full stop). */
  cause: string;
  /** What to do about it, a full sentence (PL15: support, never an administrator). */
  action: string;
}

/**
 * The one table of carrier pause copy, keyed by the contract's `CarrierAccountPauseReason`, so
 * a new automatic carrier pause fails the typecheck until it has its entry here, and every
 * surface then says it. Who can fix a carrier account is the service's support, not the
 * workspace's own administrators (PL15).
 */
export const CARRIER_PAUSE_COPY: Record<CarrierAccountPauseReason, CarrierPauseCopy> = {
  // The carrier answered a dial with 401 (PL2).
  carrier_auth: {
    by: 'The carrier',
    cause: 'the carrier refused this account’s credentials',
    action: 'Contact support to have them checked.',
  },
  // The credential was disabled, marked invalid or revoked since the campaign started (PL3).
  carrier_account_unavailable: {
    by: 'Carrier account not active',
    cause: 'this campaign’s carrier account is no longer active',
    action: 'Contact support to have it re-enabled, or choose another carrier.',
  },
  // The carrier refused the campaign's dials several times in a row, none placed between (PL11).
  carrier_refusing_calls: {
    by: 'The carrier',
    cause: 'the carrier refused several of this campaign’s calls in a row',
    action: 'Contact support to have the carrier account’s destinations, balance and caller IDs checked, then resume.',
  },
};

/** The copy for an automatic carrier pause, or `null` for any other reason. */
export function carrierPauseCopy(reason: string | null | undefined): CarrierPauseCopy | null {
  return reason && Object.hasOwn(CARRIER_PAUSE_COPY, reason)
    ? CARRIER_PAUSE_COPY[reason as CarrierAccountPauseReason]
    : null;
}

/** "Paused: <cause>. <action>", the sentence a pause row says on its own (the Activity trail). */
function pausedSentence(copy: CarrierPauseCopy): string {
  return `Paused: ${copy.cause}. ${copy.action}`;
}

/**
 * The sentence for a pause the dialler made because the campaign's carrier account cannot
 * dial, or `null` for any other pause reason.
 */
export function carrierAccountPauseCopy(reason: string | null | undefined): string | null {
  const copy = carrierPauseCopy(reason);
  return copy ? pausedSentence(copy) : null;
}
