import { dispositionLabel } from '../agencySpineCopy';
import { attemptOutcomeLabel } from '../../types/agency-spine';
import type { AgencyDisposition } from '../../types/agency';
import type { AgencyManualCall, AgencySoftphoneBootstrap } from '../../types/softphone';

/**
 * Reading a manual call's outcome in a list: the outcome the agent saved, in the
 * words of the catalog it was saved against — the tagged campaign's, or the soft
 * phone's own (`disposition_source`) — and only otherwise what the line did.
 */

/** The catalog a call's `disposition_code` belongs to, from the bootstrap the screen already holds. */
export function catalogForCall(
  call: AgencyManualCall,
  bootstrap: AgencySoftphoneBootstrap | null,
): AgencyDisposition[] | undefined {
  if (!bootstrap) return undefined;
  const fromCampaign = call.disposition_source === 'campaign' || (call.disposition_source === null && call.tag !== null);
  if (fromCampaign && call.tag) {
    return bootstrap.taggable_campaigns.find((c) => c.campaign_id === call.tag!.campaign_id)?.disposition_catalog;
  }
  return bootstrap.untagged.disposition_catalog;
}

export type ManualOutcomeKind = 'saved' | 'awaiting' | 'live' | 'line';

export function manualCallOutcome(
  call: AgencyManualCall,
  catalog: readonly AgencyDisposition[] | undefined,
): { text: string; kind: ManualOutcomeKind } {
  if (call.disposition_code) {
    return { text: dispositionLabel(call.disposition_code, catalog) ?? call.disposition_code, kind: 'saved' };
  }
  if (call.settled_at === null && call.state === 'ended' && call.requires_disposition) {
    return { text: 'No outcome yet', kind: 'awaiting' };
  }
  if (call.state !== 'ended') return { text: 'On a call now', kind: 'live' };
  return { text: attemptOutcomeLabel(call.outcome), kind: 'line' };
}

/** "Home Loan Renewals – Oct" or the words for none. */
export function loggedToLabel(call: Pick<AgencyManualCall, 'tag'>): string {
  return call.tag?.campaign_name ?? 'Not logged to a campaign';
}
