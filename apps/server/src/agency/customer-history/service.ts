/**
 * The customer-history reads, composed (`docs/customer-history.md`): who the caller is in the
 * tenant (CH2); the summary, built once at search time from roster rows and SQL aggregates; and
 * one timeline page, read as keyset heads per source, merged, cut and enriched by primary key
 * (CH9). The pure halves are in `./assemble.ts`.
 */
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import type { CustomerHistorySummary, CustomerTimelineKind, CustomerTimelinePage } from '@magick-agency/contracts/api/agency/customer-history';
import {
  agencyCustomerHistoryRepository,
  CUSTOMER_HISTORY_MAX_CONTACT_ROWS,
  type CustomerHistoryPageQuery,
  type CustomerHistoryScope,
} from '../../db/repositories/agency.repository.js';
import { namesIn } from '../insights/shared.js';
import { buildViewer, isTenantWide, membershipAccountIds, type CustomerHistoryViewer } from './visibility.js';
import {
  buildSummary,
  buildTimeline,
  contactsAwaitingCallback,
  cutPage,
  entryCount,
  pageCampaignIds,
  pageUserIds,
  sourceBound,
  summaryCampaignIds,
  summaryUserIds,
  timelinePage,
} from './assemble.js';
import type { TimelinePosition } from './cursor.js';
import type { TimelineFilter } from './requests.js';

const repo = agencyCustomerHistoryRepository;

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

const scopeOf = (viewer: CustomerHistoryViewer, tenantId: string): CustomerHistoryScope =>
  ({ tenantId, accountIds: [...viewer.accounts.keys()] });

/**
 * The summary of `phone` (E.164) in the viewer's accounts, and how many timeline entries the
 * viewer can see (the audit's `result_count`). Read once, at search time.
 */
export async function loadCustomerSummary(
  viewer: CustomerHistoryViewer,
  tenantId: string,
  phone: string,
  now: Date = new Date(),
): Promise<{ summary: CustomerHistorySummary; resultCount: number }> {
  const scope = scopeOf(viewer, tenantId);
  const [contactRows, stats, lastPlaced, liveCalls, dnc] = await Promise.all([
    repo.summaryContacts(scope, phone, CUSTOMER_HISTORY_MAX_CONTACT_ROWS + 1),
    repo.callStats(scope, phone),
    repo.lastPlaced(scope, phone),
    repo.liveCalls(scope, phone),
    repo.dncForNumber(scope, phone),
  ]);
  const contactsTruncated = contactRows.length > CUSTOMER_HISTORY_MAX_CONTACT_ROWS;
  const contacts = contactsTruncated ? contactRows.slice(0, CUSTOMER_HISTORY_MAX_CONTACT_ROWS) : contactRows;

  // Each campaign with its chain root (CH7: the filter names roots).
  const campaignRows = await repo.campaignsWithRoots(scope, summaryCampaignIds({ contacts, stats, liveCalls, dnc }));
  const campaigns = new Map(campaignRows.map((g) => [g.id, g]));
  const awaiting = contactsAwaitingCallback(contacts, campaigns).map((c) => c.id);
  const uploadCampaigns = new Set<string>();
  for (const c of contacts) {
    uploadCampaigns.add(c.campaign_id);
    const root = campaigns.get(c.campaign_id)?.root_id;
    if (root) uploadCampaigns.add(root);
  }
  const userIds = summaryUserIds({ contacts, stats, lastPlaced, liveCalls, dnc });
  const [bookingRows, uploads, names] = await Promise.all([
    repo.latestBookings(scope, awaiting),
    repo.uploads(scope, [...uploadCampaigns]),
    namesIn(userIds, tenantId),
  ]);
  const bookings = new Map(bookingRows.map((b) => [b.contact_id, b.booked_by_user_id]));
  // A callback's booker the summary names nowhere else (usually none) is looked up after.
  const named = new Set(userIds);
  const bookers = [...bookings.values()].filter((id): id is string => id !== null && !named.has(id));
  for (const [id, name] of await namesIn(bookers, tenantId)) names.set(id, name);

  const summary = buildSummary({
    now, viewer, contacts, contactsTruncated, campaigns, stats, lastPlaced, liveCalls, bookings, dnc, uploads, names,
  });
  return { summary, resultCount: entryCount(stats, dnc.length) };
}

/** How many timeline entries the viewer can see of `phone` (the export audit's `result_count`). */
export async function countCustomerEntries(viewer: CustomerHistoryViewer, tenantId: string, phone: string): Promise<number> {
  return repo.entryCount(scopeOf(viewer, tenantId), phone);
}

/**
 * One timeline page: each source's rows strictly after `cursor` under the filters, at most
 * `limit + 1` each (keyset, in SQL), merged; the first `limit` are enriched and returned with the
 * cursor of the next page. A source a filter rules out is not read: the call-only filters read
 * only the call sources, `channel` only its own.
 */
export async function loadTimelinePage(
  viewer: CustomerHistoryViewer,
  tenantId: string,
  phone: string,
  filter: TimelineFilter,
  cursor: TimelinePosition | null,
  limit: number,
  now: Date = new Date(),
): Promise<CustomerTimelinePage> {
  const scope = scopeOf(viewer, tenantId);
  const q = (kind: CustomerTimelineKind): CustomerHistoryPageQuery => {
    const bound = sourceBound(kind, cursor);
    return { ...filter, cursorAt: bound.at, cursorId: bound.id, limit: limit + 1 };
  };
  const campaignCalls = filter.channel === null || filter.channel === 'campaign';
  const softphoneCalls = filter.channel === null || filter.channel === 'softphone';
  const others = !filter.callsOnly;
  const none = Promise.resolve([] as never[]);

  const [attempts, manualCalls, callbacks, dnc, contacts] = await Promise.all([
    campaignCalls ? repo.pageAttempts(scope, phone, q('campaign_call')) : none,
    softphoneCalls ? repo.pageManualCalls(scope, phone, q('softphone_call')) : none,
    others ? repo.pageCallbacks(scope, phone, q('callback')) : none,
    others ? repo.pageDnc(scope, phone, q('dnc_mark')) : none,
    others ? repo.pageContacts(scope, phone, q('roster_entry')) : none,
  ]);
  const cut = cutPage({ attempts, manualCalls, callbacks, dnc, contacts }, limit);
  const rows = cut.rows;

  const legIds = [...rows.attempts.map((a) => a.webrtc_call_id), ...rows.manualCalls.map((m) => m.webrtc_call_id)]
    .filter((id): id is string => typeof id === 'string');
  const [campaignRows, legs, uploads, callbackNext, names] = await Promise.all([
    repo.campaignsByIds(scope, pageCampaignIds(rows)),
    repo.mediaLegs(scope, legIds),
    repo.uploads(scope, rows.contacts.map((c) => c.campaign_id)),
    repo.callbackNext(scope, phone, rows.callbacks.map((c) => ({ id: c.id, at: c.at }))),
    namesIn(pageUserIds(rows), tenantId),
  ]);

  const entries = buildTimeline({
    ...rows,
    now,
    viewer,
    campaigns: new Map(campaignRows.map((g) => [g.id, g])),
    mediaLegs: new Map(legs.map((l) => [l.id, { recording_url: l.recording_url }])),
    uploads,
    names,
    callbackNext,
  });
  return timelinePage(entries, cut);
}
