import type { DncEntryScope } from '../types/dnc';
import type { Membership } from '../types/auth';
import { hasPermission } from './permissions';

/**
 * How far a Do Not Call entry reaches, in the same words everywhere it is shown (DS7): the Do Not
 * Call page, customer history, the soft phone's refusal and its call detail. The mobile app says
 * the same (`apps/mobile/lib/core/dnc/dnc_scope_words.dart`).
 *
 *  - every campaign in the organisation: **Every campaign**
 *  - one account's campaigns: **North account** (the account's name), or **This account**
 *  - one campaign: **Campaign: Q4 Renewals**, or the caller's fallback when the name is not known
 *
 * The wire codes (`tenant`, `account`, `campaign`) are never shown.
 */
export const DNC_EVERY_CAMPAIGN = 'Every campaign';

export function dncScopeWords(
  scope: DncEntryScope,
  names: {
    accountName?: string | null;
    campaignName?: string | null;
    /** What a campaign entry is called when its name is not known. */
    unnamedCampaign?: string;
  } = {},
): string {
  switch (scope) {
    case 'tenant':
      return DNC_EVERY_CAMPAIGN;
    case 'account':
      return names.accountName?.trim() ? `${names.accountName.trim()} account` : 'This account';
    case 'campaign':
      return names.campaignName?.trim()
        ? `Campaign: ${names.campaignName.trim()}`
        : names.unnamedCampaign ?? 'A campaign that no longer exists';
  }
}

/**
 * Where an entry blocks the number, as the end of "already blocked …" (an add that a wider
 * entry already covers, DS4) and of "… can dial it again" (a removal).
 */
export function dncScopeWhere(
  scope: DncEntryScope,
  names: { accountName?: string | null; campaignName?: string | null } = {},
): string {
  switch (scope) {
    case 'tenant':
      return 'in every campaign';
    case 'account':
      return names.accountName?.trim() ? `in every campaign of the ${names.accountName.trim()} account` : 'in every campaign of this account';
    case 'campaign':
      return names.campaignName?.trim() ? `in ${names.campaignName.trim()}` : 'in that campaign';
  }
}

type MembershipLike = Pick<Membership, 'tenant_id' | 'account_id' | 'role' | 'status'>;

/**
 * The membership the server acts under for this request (`selectMembership`): the account's own
 * membership when there is one, else the one for the whole organisation.
 */
function resolvedMembership(
  memberships: readonly MembershipLike[],
  tenantId: string | null,
  accountId: string | null,
): MembershipLike | undefined {
  if (!tenantId) return undefined;
  const active = memberships.filter((m) => m.tenant_id === tenantId && m.status === 'active');
  return (accountId ? active.find((m) => m.account_id === accountId) : undefined)
    ?? active.find((m) => m.account_id === null);
}

/**
 * Whether this request acts as a member of the WHOLE organisation, who sees every Do Not Call
 * entry; anyone else sees their account's entries only (DS6). A person who holds both an
 * account membership and an organisation one acts as the account's member here, as the server
 * resolves it.
 */
export function actsForWholeOrganisation(
  memberships: readonly MembershipLike[],
  tenantId: string | null,
  accountId: string | null,
): boolean {
  return resolvedMembership(memberships, tenantId, accountId)?.account_id === null;
}

/**
 * Whether the caller may add or remove an every-campaign entry (DS3): `agency.dnc.manage` on a
 * membership of the whole organisation, the one the server resolves for this request.
 */
export function mayManageEveryCampaignDnc(
  memberships: readonly MembershipLike[],
  tenantId: string | null,
  accountId: string | null,
): boolean {
  const resolved = resolvedMembership(memberships, tenantId, accountId);
  return resolved !== undefined && resolved.account_id === null && hasPermission(resolved.role, 'agency.dnc.manage');
}
