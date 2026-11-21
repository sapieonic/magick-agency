import { isAgencyCampaignArchivableStatus } from '@magick-agency/contracts/api/agency/agency-campaign';
import type { AgencyCampaign } from '../types/agency-campaign';
import type { AgencyReportSubscription } from '@magick-agency/contracts/api/agency/reports';
import { trackAgencyCampaignArchiveAction } from '../analytics/events';
import { isKnownCampaignStatus } from './agencyCampaignControls';
import { formatDayMonthYear } from './format/date';

/**
 * Archived campaigns (decisions AR1–AR7), the console's half: which campaigns can be archived,
 * and what is said about one that is.
 *
 * Archiving is not a status. A draft or stopped campaign is archived to take it off the Campaigns
 * page; it keeps its status and badge, it is listed on Archived campaigns instead, and it can be
 * restored. The server is the authority (`campaign_not_archivable` and friends); this is the rule
 * the buttons are offered by, so they do not offer what the server refuses.
 */

/** Whether the campaign is archived. `archived_at` absent (an older server) reads as not archived. */
export function isArchivedCampaign(campaign: Pick<AgencyCampaign, 'archived_at'>): boolean {
  return Boolean(campaign.archived_at);
}

/** Whether Archive is offered on this campaign: a draft or stopped campaign (AR2), not archived already. */
export function canArchiveCampaign(campaign: Pick<AgencyCampaign, 'status' | 'archived_at'>): boolean {
  return isAgencyCampaignArchivableStatus(campaign.status) && !isArchivedCampaign(campaign);
}

/**
 * When and by whom it was archived: "Archived on 20 Nov 2026 by Ravi Kumar". The actor is left
 * out when the server named nobody, and falls back to nothing (not the raw id) when only an id was
 * recorded: a user id is not something a supervisor reads. `null` when it is not archived.
 */
export function archivedLine(campaign: Pick<AgencyCampaign, 'archived_at' | 'archived_by'>): string | null {
  if (!campaign.archived_at) return null;
  const when = new Date(campaign.archived_at);
  const on = Number.isNaN(when.getTime()) ? 'Archived' : `Archived on ${formatDayMonthYear(when)}`;
  const name = campaign.archived_by?.name?.trim();
  return name ? `${on} by ${name}` : on;
}

/** The confirm before archiving: what moves, and that nothing is lost. */
export const ARCHIVE_CONFIRM = {
  title: 'Archive this campaign?',
  message:
    'It moves off the Campaigns page to Archived campaigns. Its contacts, calls and reports are kept, '
    + 'and you can restore it at any time.',
  draftNote: 'An archived draft cannot be started until it is restored.',
} as const;

/** What an archive or a restore says, from a campaign's header or a row of Archived campaigns. */
export const ARCHIVE_TOASTS = {
  archived: 'Campaign archived. It is now under Archived campaigns.',
  restored: 'Campaign restored to the Campaigns page.',
  archiveFailed: 'Could not archive the campaign.',
  restoreFailed: 'Could not restore the campaign.',
} as const;

/** The analytics event for an archive or restore that succeeded; `campaign` is the server's answer. */
export function trackArchiveAction(
  campaign: Pick<AgencyCampaign, 'id' | 'status'>,
  action: 'archive' | 'unarchive',
  from: 'campaign_header' | 'archived_list',
): void {
  if (!isKnownCampaignStatus(campaign.status)) return;
  trackAgencyCampaignArchiveAction({ campaign_id: campaign.id, action, status: campaign.status, from });
}

/** Why Start is refused on an archived draft, beside the disabled button. */
export const ARCHIVED_START_REASON = 'This campaign is archived. Restore it before starting it.';

/** A campaign's name in a picker: "(archived)" after an archived one (AR1–AR7). */
export function pickerCampaignName(campaign: Pick<AgencyCampaign, 'name' | 'archived_at'>): string {
  return isArchivedCampaign(campaign) ? archivedName(campaign.name) : campaign.name;
}

function archivedName(name: string): string {
  return `${name} (archived)`;
}

/**
 * A picker's choices: the campaigns that are not archived, then the archived ones it already
 * holds (`held`), so a saved choice of a campaign archived since stays visible and can be
 * removed. Archived campaigns nobody chose are not offered.
 */
export function withHeldArchived<T extends Pick<AgencyCampaign, 'id'>>(
  campaigns: readonly T[],
  archived: readonly T[],
  held: Iterable<string>,
): T[] {
  const keep = new Set(held);
  const have = new Set(campaigns.map((c) => c.id));
  return [...campaigns, ...archived.filter((c) => keep.has(c.id) && !have.has(c.id))];
}

/**
 * The report subscription picker's options. The list leaves archived campaigns out (AR3), so a
 * subscription being edited whose campaign is missing from it was archived since: it keeps its
 * campaign as an option, marked, rather than showing "Choose a campaign" over a subject that
 * cannot change. Before the list is read (`null`) nothing is known to be missing, so the held
 * campaign is offered by its name alone.
 */
export function subscriptionCampaignOptions(
  campaigns: readonly Pick<AgencyCampaign, 'id' | 'name'>[] | null,
  editing: Pick<AgencyReportSubscription, 'kind' | 'subject'> | null | undefined,
): Array<{ id: string; name: string }> {
  const options = (campaigns ?? []).map((c) => ({ id: c.id, name: c.name }));
  if (editing?.kind !== 'campaign' || options.some((c) => c.id === editing.subject.id)) return options;
  const name = editing.subject.name ?? 'This campaign';
  return [...options, { id: editing.subject.id, name: campaigns ? archivedName(name) : name }];
}
