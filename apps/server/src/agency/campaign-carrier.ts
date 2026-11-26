/*
 * Which carrier account a campaign dials on, checked at the write (decisions B18–B22).
 *
 * A campaign names a carrier (`telephony_provider`) and, for a carrier dialled on the
 * TENANT's own account, the credential it dials with (`telephony_credential_id`). The
 * rules, decided per carrier by the account modes its catalogue entry declares
 * (`telephony/carrier-catalog.ts`, CR1), never by its name:
 *
 *  - the carrier must be an active `telephony_providers` row;
 *  - the account mode (CR1, CR8): a null credential is the service's own account, refused
 *    on a carrier without one; a set credential needs a carrier that takes tenant
 *    accounts, and must be of THIS tenant on THAT carrier and `active` to be pinned. A
 *    carrier may offer both; moving between the two on one carrier is a change of carrier
 *    account like any other (every caller ID judged);
 *  - on a tenant account every caller ID must be an active number pinned to that
 *    credential (synced, or added by hand, CR6) and available to the campaign's account;
 *  - on the service's own account no caller ID may be a number pinned to ANY credential
 *    (CR9): it would dial a tenant's own number on the service's account. The write checks
 *    the IDs it adds (every ID on a create, a change of carrier account or a retry), and
 *    again inside its own transaction with those numbers' rows held `FOR SHARE`, so a move
 *    onto a tenant's account (CR6) cannot commit beside it; the dial drops any pinned number
 *    a campaign still holds (`dialableCallerIds`). Beyond that its caller IDs are
 *    shape-checked only (`callerIdsIssue`).
 *
 * The composite foreign key on `agency_campaigns` already makes Postgres refuse a
 * credential of another tenant or carrier; this module turns those cases into answers
 * an operator can act on, and adds the status and caller-ID rules Postgres cannot see.
 *
 * Messages are British English and name no carrier brand (they can reach the console).
 */
import type { PoolClient } from 'pg';
import { phoneNumberRepository } from '@magick-agency/db/repositories/phone-number.repository';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';
import { telephonyProviderRepository } from '../db/repositories/telephony-provider.repository.js';
import { carrierAccountModeAllowed, carrierHasServiceAccount, carrierTakesTenantAccounts } from '../telephony/carrier-catalog.js';
import { UUID_RE } from '../utils/uuid.js';
import { AGENCY_CAMPAIGN_COLUMN_DEFAULTS } from '@magick-agency/contracts/agency';

/** The carrier on the service's own account, and every campaign's default (the column DEFAULT). */
export const DEFAULT_CAMPAIGN_PROVIDER = AGENCY_CAMPAIGN_COLUMN_DEFAULTS.telephony_provider;

/** A refusal: a 400 naming fields, or a coded 404/409. */
export type CampaignCarrierRefusal =
  | { kind: 'validation'; details: Record<string, string> }
  | { kind: 'coded'; status: 404 | 409; code: 'telephony_credential_not_found' | 'telephony_credential_not_active'; message: string };

type CodedRefusal = Extract<CampaignCarrierRefusal, { kind: 'coded' }>;

const notActive = (status: string): CodedRefusal => ({
  kind: 'coded', status: 409, code: 'telephony_credential_not_active',
  message: `The carrier account this campaign would dial on is ${status}, so it cannot be used. Contact support to have it re-enabled, or choose another carrier account.`,
});

const notFound: CodedRefusal = {
  kind: 'coded', status: 404, code: 'telephony_credential_not_found',
  message: 'telephony_credential_id does not name a carrier account of this organisation on the chosen carrier.',
};

/** Up to five numbers, then how many more: what a caller-ID refusal names. */
function listed(numbers: readonly string[]): string {
  return `${numbers.slice(0, 5).join(', ')}${numbers.length > 5 ? ` and ${numbers.length - 5} more` : ''}`;
}

/**
 * The account-mode refusal for a carrier and credential (CR1, CR8), or null when the carrier
 * supports the mode. The detail names the field to change: the credential when the carrier
 * supports the other mode, the carrier when it supports neither (one the catalogue does not
 * know).
 */
function accountModeRefusal(provider: string, credentialId: string | null): CampaignCarrierRefusal | null {
  if (carrierAccountModeAllowed(provider, credentialId)) return null;
  if (credentialId === null && carrierTakesTenantAccounts(provider)) {
    return { kind: 'validation', details: { telephony_credential_id: 'is required: this carrier dials on the organisation’s own carrier account' } };
  }
  if (credentialId !== null && carrierHasServiceAccount(provider)) {
    return { kind: 'validation', details: { telephony_credential_id: 'must be null: this carrier dials on the service’s own account' } };
  }
  return { kind: 'validation', details: { telephony_provider: 'must name a carrier this service can dial on' } };
}

/** What a write leaves the campaign on, as `campaignCarrierRefusal` reads it. */
export interface CampaignCarrierEffective {
  telephony_provider: unknown;
  telephony_credential_id: unknown;
  caller_ids: readonly string[];
}

/** The campaign before the write (null on a create). */
export interface CampaignCarrierStored {
  telephony_provider: string | null;
  telephony_credential_id: string | null;
  caller_ids: readonly string[];
}

/** Which of the three carrier fields the write's body itself carries. */
export interface CampaignCarrierChanged {
  provider: boolean;
  credential: boolean;
  callerIds: boolean;
}

export interface CampaignCarrierOptions {
  /**
   * Judge EVERY caller ID against CR9 when the campaign is on the service's own account, as a
   * change of carrier account does: what a campaign made from another's settings needs (a retry
   * inherits its parent's pool, which a move onto a tenant's account may have pinned since the
   * parent was written). No effect on a tenant account: there a retired stored number may stay
   * (PL13).
   */
  judgeAllServiceCallerIds?: boolean;
}

/**
 * The caller IDs CR9 judges at this write: on the service's own account, the ones it adds to the
 * pool it is `stored` with on that same account (or all of them on a create, on a change of
 * carrier account, or with `judgeAllServiceCallerIds`); none on a tenant account, nor when the
 * write touches none of the three fields. What the write's transaction locks and re-checks
 * ({@link servicePinnedRefusalLocked}).
 */
export function serviceCallerIdsJudged(
  effective: CampaignCarrierEffective,
  changed: CampaignCarrierChanged,
  stored: CampaignCarrierStored | null = null,
  opts: CampaignCarrierOptions = {},
): string[] {
  if ((effective.telephony_credential_id ?? null) !== null) return [];
  if (opts.judgeAllServiceCallerIds) return [...effective.caller_ids];
  if (!changed.provider && !changed.credential && !changed.callerIds) return [];
  return judgedCallerIds(effective, stored);
}

/** On the account it is `stored` on, only the caller IDs the write adds; else all of them. */
function judgedCallerIds(effective: CampaignCarrierEffective, stored: CampaignCarrierStored | null): string[] {
  const credentialId = effective.telephony_credential_id ?? null;
  const sameAccount = stored !== null
    && stored.telephony_provider === effective.telephony_provider
    && (stored.telephony_credential_id ?? null) === credentialId;
  return sameAccount
    ? effective.caller_ids.filter((id) => !stored.caller_ids.includes(id))
    : [...effective.caller_ids];
}

/** CR9's refusal, naming the pinned numbers. */
function servicePinnedRefusal(pinned: readonly string[]): CampaignCarrierRefusal {
  return {
    kind: 'validation',
    details: {
      caller_ids: `a campaign on the service’s own carrier account cannot use a number of an organisation’s own carrier account; not: ${listed(pinned)}`,
    },
  };
}

/**
 * CR9 again, inside the campaign write's own transaction, with the numbers' rows held `FOR SHARE`
 * (`phoneNumberRepository.lockPinnedAmong`) until it commits: a move of one of them onto a
 * tenant's account (CR6) either committed first and is refused here, or waits for the write and
 * then sees the campaign holding the number (`in_use`). `numbers` is {@link serviceCallerIdsJudged}.
 * Null when the write may go ahead.
 */
export async function servicePinnedRefusalLocked(
  client: PoolClient,
  numbers: readonly string[],
): Promise<CampaignCarrierRefusal | null> {
  const pinned = await phoneNumberRepository.lockPinnedAmong(client, numbers);
  return pinned.length === 0 ? null : servicePinnedRefusal(pinned);
}

/**
 * Check the carrier a campaign write leaves it on.
 *
 * `effective` is the campaign AFTER the write (the stored row with the body on top, or
 * the create body with the defaults); `changed` says which of the three fields the body
 * itself carries. Only what the write touches is judged:
 *  - the provider row's status, only when the body names `telephony_provider` (an
 *    untouched carrier was judged when it was set, and the service's own row is seeded);
 *  - the credential's existence, tenant and status, when the body names the provider or
 *    the credential (pinning is the moment that must see an active credential; a caller-ID
 *    edit on a campaign whose credential was later disabled is not refused for it);
 *  - the account mode, on a create and whenever the body names the provider or the
 *    credential: a caller-ID edit on a campaign stored on a carrier the catalogue does not
 *    know (an old or test provider row) is not refused for it;
 *  - the caller IDs, whenever any of the three changes: on a credential against its
 *    numbers, on the service's own account against the pinned numbers (CR9). When the
 *    write leaves the campaign on the carrier account it is `stored` on (same carrier,
 *    same credential or both null), only the caller IDs it ADDS are judged: a number
 *    already in the pool that a sync or a super-admin has since retired may stay (the
 *    dial skips it, `usableCallerIds` and PL13), so a rename or a calling-hours fix is
 *    never refused over a number the supervisor can no longer see. `stored` is null on a
 *    create. With `judgeAllServiceCallerIds` (a retry), every caller ID of a service-account
 *    campaign is judged against CR9, whatever the body touches.
 *
 * Returns null when the write may go ahead. The write's transaction then re-checks CR9 under
 * lock ({@link servicePinnedRefusalLocked}), and CR9 holds at the dial too: a service-account
 * campaign never dials a pinned number (`dialableCallerIds`, `campaign-dialability.ts`).
 */
export async function campaignCarrierRefusal(
  scope: { tenantId: string; accountId: string },
  effective: CampaignCarrierEffective,
  changed: CampaignCarrierChanged,
  stored: CampaignCarrierStored | null = null,
  opts: CampaignCarrierOptions = {},
): Promise<CampaignCarrierRefusal | null> {
  const provider = effective.telephony_provider;
  const credentialId = effective.telephony_credential_id ?? null;
  const touched = changed.provider || changed.credential || changed.callerIds;
  if (!touched && !(opts.judgeAllServiceCallerIds && credentialId === null)) return null;

  if (typeof provider !== 'string' || provider.trim() === '') {
    return { kind: 'validation', details: { telephony_provider: 'must name a carrier' } };
  }
  if (credentialId !== null && (typeof credentialId !== 'string' || !UUID_RE.test(credentialId))) {
    return { kind: 'validation', details: { telephony_credential_id: 'must be a carrier account id, or null' } };
  }
  if (changed.provider) {
    const row = await telephonyProviderRepository.findByName(provider);
    if (!row || row.status !== 'active') {
      return { kind: 'validation', details: { telephony_provider: 'must name an active carrier' } };
    }
  }

  // The account mode (CR1, CR8): a null credential needs the carrier's service account, a set
  // one its tenant accounts. A carrier the catalogue does not know allows neither. Judged when
  // the write sets the carrier account (a create, or a body naming the provider or the
  // credential), never on a caller-ID edit of the account a campaign is already on.
  if (stored === null || changed.provider || changed.credential) {
    const modeRefusal = accountModeRefusal(provider, credentialId);
    if (modeRefusal) return modeRefusal;
  }
  if (credentialId !== null && (changed.provider || changed.credential)) {
    const credential = await telephonyCredentialRepository.findById(credentialId);
    if (!credential || credential.tenant_id !== scope.tenantId || credential.provider !== provider) return notFound;
    if (credential.status !== 'active') return notActive(credential.status);
  }

  // The service's own account (CR9): a number pinned to any credential is a tenant's own
  // number, billed to and dialled on that tenant's carrier account, never the service's.
  if (credentialId === null) {
    const judged = serviceCallerIdsJudged(effective, changed, stored, opts);
    if (judged.length === 0) return null;
    const pinned = await phoneNumberRepository.findPinnedAmong(judged);
    return pinned.length === 0 ? null : servicePinnedRefusal(pinned);
  }

  // Same carrier account as stored: the numbers already in the pool were judged when they
  // were added and are filtered at the dial; only the new ones are judged now. Moving between
  // the service's account and a credential on one carrier is NOT the same account (CR8).
  const judged = judgedCallerIds(effective, stored);
  if (judged.length === 0) return null;
  const allowed = new Set(await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(
    scope.tenantId, scope.accountId, credentialId, judged,
  ));
  const foreign = judged.filter((id) => !allowed.has(id));
  if (foreign.length > 0) {
    return {
      kind: 'validation',
      details: {
        caller_ids: `every caller ID must be an active number on the chosen carrier account and available to this account; not: ${listed(foreign)}`,
      },
    };
  }
  return null;
}

/**
 * Why a campaign pinned to a tenant credential may not start or resume now: the
 * credential is no longer `active`. Null when it may (or the campaign dials on the
 * service's own account). The dial itself re-checks at the call insert; this is the
 * answer while a supervisor is present to read it.
 */
export async function campaignCredentialStartRefusal(
  campaign: { telephony_credential_id: string | null },
): Promise<CodedRefusal | null> {
  if (!campaign.telephony_credential_id) return null;
  const credential = await telephonyCredentialRepository.findById(campaign.telephony_credential_id);
  if (!credential) {
    return { ...notFound, message: 'The carrier account this campaign dials on no longer exists. Choose another carrier account.' };
  }
  if (credential.status === 'active') return null;
  return {
    kind: 'coded', status: 409, code: 'telephony_credential_not_active',
    message: `This campaign dials on a carrier account that is ${credential.status}. Contact support to have it re-enabled, or move the campaign to another carrier account before starting it.`,
  };
}
