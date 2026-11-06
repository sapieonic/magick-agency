/**
 * The customer-history reads, composed (`docs/customer-history.md`): who the caller is in the
 * tenant (CH2), and every row the visible accounts hold about one number, read through the
 * repository's indexed, account-scoped statements (CH9) and handed to the pure assembler
 * (`./assemble.ts`).
 */
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import {
  agencyCustomerHistoryRepository,
  type CustomerHistoryCampaignRow,
  type CustomerHistoryScope,
} from '../../db/repositories/agency.repository.js';
import { namesIn } from '../insights/shared.js';
import { buildViewer, isTenantWide, membershipAccountIds, type CustomerHistoryViewer } from './visibility.js';
import { userIdsOf, type CustomerHistoryData } from './assemble.js';

/** The caller's visible accounts and role in each, from their active memberships in the tenant. */
export async function resolveViewer(userId: string, tenantId: string): Promise<CustomerHistoryViewer> {
  const memberships = await membershipRepository.findByUserAndTenant(userId, tenantId);
  const accounts = isTenantWide(memberships)
    ? await accountRepository.findByTenantId(tenantId)
    : await accountRepository.findByIds(membershipAccountIds(memberships), tenantId);
  return buildViewer(
    userId,
    memberships.map((m) => ({ account_id: m.account_id, role: m.role, status: m.status })),
    accounts.map((a) => ({ id: a.id, name: a.name ?? null })),
  );
}

/** Every row about `phone` (E.164) in the viewer's accounts. */
export async function loadCustomerHistory(
  viewer: CustomerHistoryViewer,
  tenantId: string,
  phone: string,
  now: Date = new Date(),
): Promise<CustomerHistoryData> {
  const repo = agencyCustomerHistoryRepository;
  const scope: CustomerHistoryScope = { tenantId, accountIds: [...viewer.accounts.keys()] };

  const [contacts, dnc] = await Promise.all([repo.contactsForNumber(scope, phone), repo.dncForNumber(scope, phone)]);
  const contactIds = contacts.map((c) => c.id);
  const [attempts, manualCalls] = await Promise.all([
    repo.attemptsForContacts(scope, contactIds),
    repo.manualCallsForNumber(scope, phone, contactIds),
  ]);

  // Campaigns: every one a row names, then any chain root not among them (CH7's filter names roots).
  const campaignIds = new Set<string>();
  for (const c of contacts) campaignIds.add(c.campaign_id);
  for (const a of attempts) campaignIds.add(a.campaign_id);
  for (const m of manualCalls) if (m.campaign_id) campaignIds.add(m.campaign_id);
  for (const d of dnc) if (d.campaign_id) campaignIds.add(d.campaign_id);
  const campaigns = new Map<string, CustomerHistoryCampaignRow>();
  for (const g of await repo.campaignsByIds(scope, [...campaignIds])) campaigns.set(g.id, g);
  const missingRoots = [...new Set([...campaigns.values()].map((g) => g.root_id))].filter((id) => !campaigns.has(id));
  for (const g of await repo.campaignsByIds(scope, missingRoots)) campaigns.set(g.id, g);

  const legIds = [
    ...attempts.map((a) => a.webrtc_call_id),
    ...manualCalls.map((m) => m.webrtc_call_id),
  ].filter((id): id is string => typeof id === 'string');
  const contactCampaignIds = [...new Set(contacts.map((c) => c.campaign_id))];
  const [legs, uploads] = await Promise.all([
    repo.mediaLegs(scope, legIds),
    repo.uploads(scope, contactCampaignIds),
  ]);

  const names = await namesIn(userIdsOf({ contacts, attempts, manualCalls, dnc }), tenantId);

  return {
    now,
    viewer,
    contacts,
    campaigns,
    attempts,
    manualCalls,
    dnc,
    mediaLegs: new Map(legs.map((l) => [l.id, { recording_url: l.recording_url }])),
    uploads,
    names,
  };
}
