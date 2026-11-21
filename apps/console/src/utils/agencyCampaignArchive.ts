import { AGENCY_CAMPAIGN_ARCHIVABLE_STATUSES } from '@magick-agency/contracts/api/agency/agency-campaign';
import type { AgencyCampaign } from '../types/agency-campaign';
import { formatDayMonthYear } from './format/date';

/**
 * Archived campaigns (decisions AR1–AR6), the console's half: which campaigns can be archived,
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

/** Whether a campaign in `status` may be archived: a draft or a stopped campaign (AR2). */
export function isArchivableStatus(status: string): boolean {
  return (AGENCY_CAMPAIGN_ARCHIVABLE_STATUSES as readonly string[]).includes(status);
}

/** Whether Archive is offered on this campaign: archivable and not archived already. */
export function canArchiveCampaign(campaign: Pick<AgencyCampaign, 'status' | 'archived_at'>): boolean {
  return isArchivableStatus(campaign.status) && !isArchivedCampaign(campaign);
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

/** Why Start is refused on an archived draft, beside the disabled button. */
export const ARCHIVED_START_REASON = 'This campaign is archived. Restore it before starting it.';
