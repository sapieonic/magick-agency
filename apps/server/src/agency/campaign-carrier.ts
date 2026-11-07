/*
 * Which carrier account a campaign dials on, checked at the write (decisions B18–B22).
 *
 * A campaign names a carrier (`telephony_provider`) and, for a carrier dialled on the
 * TENANT's own account, the credential it dials with (`telephony_credential_id`). The
 * rules, decided per carrier by whether it takes tenant credentials (a credential spec
 * exists for it), never by its name:
 *
 *  - the carrier must be an active `telephony_providers` row;
 *  - a carrier on the service's own account (no credential spec) takes no credential;
 *  - a tenant-account carrier requires a credential of THIS tenant on THAT carrier, and
 *    it must be `active` to be pinned;
 *  - on a tenant-account carrier every caller ID must be an active number synced from
 *    that credential and available to the campaign's account. A service-account
 *    campaign's caller IDs stay shape-checked only (`callerIdsIssue`).
 *
 * The composite foreign key on `agency_campaigns` already makes Postgres refuse a
 * credential of another tenant or carrier; this module turns those cases into answers
 * an operator can act on, and adds the status and caller-ID rules Postgres cannot see.
 *
 * Messages are British English and name no carrier brand (they can reach the console).
 */
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';
import { telephonyProviderRepository } from '../db/repositories/telephony-provider.repository.js';
import { findCredentialSpec } from '../telephony/credentials/credential-specs.js';
import { UUID_RE } from '../utils/uuid.js';

/** The carrier on the service's own account, and every campaign's default (the column DEFAULT). */
export const DEFAULT_CAMPAIGN_PROVIDER = 'voicelink';

/** A refusal: a 400 naming fields, or a coded 404/409. */
export type CampaignCarrierRefusal =
  | { kind: 'validation'; details: Record<string, string> }
  | { kind: 'coded'; status: 404 | 409; code: 'telephony_credential_not_found' | 'telephony_credential_not_active'; message: string };

/** Whether a carrier is dialled on a tenant's own account (it takes tenant credentials). */
export function carrierTakesTenantCredential(provider: string): boolean {
  return findCredentialSpec(provider) !== undefined;
}

type CodedRefusal = Extract<CampaignCarrierRefusal, { kind: 'coded' }>;

const notActive = (status: string): CodedRefusal => ({
  kind: 'coded', status: 409, code: 'telephony_credential_not_active',
  message: `The carrier account this campaign would dial on is ${status}, so it cannot be used. Contact support to have it re-enabled, or choose another carrier account.`,
});

const notFound: CodedRefusal = {
  kind: 'coded', status: 404, code: 'telephony_credential_not_found',
  message: 'telephony_credential_id does not name a carrier account of this tenant on the chosen carrier.',
};

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
 *  - the caller IDs against the credential's numbers, whenever any of the three changes.
 *    When the write leaves the campaign on the carrier account it is `stored` on, only
 *    the caller IDs it ADDS are judged: a number already in the pool that a sync or a
 *    super-admin has since retired may stay (the dial skips it, `usableCallerIds` and
 *    PL13), so a rename or a calling-hours fix is never refused over a number the
 *    supervisor can no longer see. `stored` is null on a create.
 *
 * Returns null when the write may go ahead.
 */
export async function campaignCarrierRefusal(
  scope: { tenantId: string; accountId: string },
  effective: { telephony_provider: unknown; telephony_credential_id: unknown; caller_ids: readonly string[] },
  changed: { provider: boolean; credential: boolean; callerIds: boolean },
  stored: { telephony_provider: string | null; telephony_credential_id: string | null; caller_ids: readonly string[] } | null = null,
): Promise<CampaignCarrierRefusal | null> {
  if (!changed.provider && !changed.credential && !changed.callerIds) return null;
  const provider = effective.telephony_provider;
  const credentialId = effective.telephony_credential_id ?? null;
  // Only the caller IDs change, on a campaign that dials on the service's own account:
  // they are shape-checked (`callerIdsIssue`) and there is nothing else to judge.
  if (!changed.provider && !changed.credential && credentialId === null) return null;

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

  if (!carrierTakesTenantCredential(provider)) {
    if (credentialId !== null) {
      return {
        kind: 'validation',
        details: { telephony_credential_id: 'must be null: this carrier dials on the service’s own account' },
      };
    }
    return null;
  }

  if (credentialId === null) {
    return { kind: 'validation', details: { telephony_credential_id: 'is required: this carrier dials on the tenant’s own carrier account' } };
  }
  if (changed.provider || changed.credential) {
    const credential = await telephonyCredentialRepository.findById(credentialId);
    if (!credential || credential.tenant_id !== scope.tenantId || credential.provider !== provider) return notFound;
    if (credential.status !== 'active') return notActive(credential.status);
  }

  // Same carrier account as stored: the numbers already in the pool were judged when they
  // were added and are filtered at the dial; only the new ones are judged now.
  const sameAccount = stored !== null
    && stored.telephony_provider === provider
    && (stored.telephony_credential_id ?? null) === credentialId;
  const judged = sameAccount
    ? effective.caller_ids.filter((id) => !stored.caller_ids.includes(id))
    : effective.caller_ids;
  if (judged.length === 0) return null;
  const allowed = new Set(await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(
    scope.tenantId, scope.accountId, credentialId, judged,
  ));
  const foreign = judged.filter((id) => !allowed.has(id));
  if (foreign.length > 0) {
    return {
      kind: 'validation',
      details: {
        caller_ids: `every caller ID must be an active number on the chosen carrier account and available to this account; not: ${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ` and ${foreign.length - 5} more` : ''}`,
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
