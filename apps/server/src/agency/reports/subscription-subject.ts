/**
 * Is a subscription's subject still there? The reports tick asks at each claim
 * (`tick.ts`), so a subscription whose subject is gone is disabled instead of producing a run that
 * fails `subject_unavailable` and emails its recipients a failure every period.
 *
 * The rule is the dataset builders' own (`datasets/`, `ReportSubjectUnavailableError`), so the
 * tick disables exactly the subscriptions whose next run would fail for that reason, and never one
 * whose run would succeed:
 *  - every kind: the account still exists in the tenant (`runTenancy`);
 *  - agent: a membership of the agent (any status: a departed agent's review stays readable, as on
 *    the agent record) reaches the account;
 *  - campaign: the campaign is still the tenant's and the account's; its CURRENT
 *    `default_timezone` comes back with it (RP3: the period is cut in it);
 *  - account: the subject is the subscription's own account.
 */
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import {
  agencyCampaignRepository,
  type ReportSubscriptionRecord,
} from '../../db/repositories/agency.repository.js';
import { isMemberOfAccountEver } from './access.js';

export type ReportSubscriptionSubject =
  | { available: false; reason: string }
  /** `timezone`: the campaign's current zone for a campaign subscription; null for the others. */
  | { available: true; timezone: string | null };

export type SubjectRef = Pick<ReportSubscriptionRecord, 'tenant_id' | 'account_id' | 'kind' | 'subject_id'>;

export async function probeSubscriptionSubject(sub: SubjectRef): Promise<ReportSubscriptionSubject> {
  const gone = (reason: string): ReportSubscriptionSubject => ({ available: false, reason });
  if (!sub.account_id) return gone('the subscription has no account');
  const account = await accountRepository.findByIdInTenant(sub.account_id, sub.tenant_id);
  if (!account) return gone('the account no longer exists');
  switch (sub.kind) {
    case 'agent':
      return (await isMemberOfAccountEver(sub.subject_id, sub.tenant_id, sub.account_id))
        ? { available: true, timezone: null }
        : gone('the agent is not a member of the account');
    case 'campaign': {
      const campaign = await agencyCampaignRepository.findById(sub.subject_id);
      if (!campaign || campaign.tenant_id !== sub.tenant_id || campaign.account_id !== sub.account_id) {
        return gone('the campaign no longer exists in the account');
      }
      return { available: true, timezone: campaign.default_timezone };
    }
    case 'account':
      return sub.subject_id === sub.account_id ? { available: true, timezone: null } : gone('an account report is about its own account');
  }
}
