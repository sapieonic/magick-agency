/**
 * The summary's `transitions`: every lifecycle transition still in the audit window, oldest
 * first, read through the activity trail's merged reader (`fetchActivityPage`, both audit
 * tables). Part of `src/agency/insights/` (docs/insights.md "API").
 *
 * Which row says what (the two tables record some of the same names, `agency-activity.ts`):
 *
 * | Row | `to_status` | actor | `reason` |
 * |---|---|---|---|
 * | console `agency_campaign.started` | running | the user who pressed Start | `supervisor` |
 * | console `agency_campaign.paused` | paused | the user | `supervisor` |
 * | console `agency_campaign.resumed` | running | the user | `supervisor` |
 * | console `agency_campaign.stopped` (Stop pressed: the campaign drains) | stopping | the user | `supervisor` |
 * | dialer `agency_campaign.auto_paused` | paused | system | the row's `detail.reason`: `carrier_auth` (the carrier refused the campaign's credential), `carrier_account_unavailable` (the credential is no longer active) or `carrier_refusing_calls` (the carrier refused several dials in a row, PL11), all `carrier-account-pause.ts`, else `abandonment_ceiling` |
 * | dialer `agency_campaign.stopped` (the drain finished) | stopped | system | `calls_drained` |
 * | dialer `agency_campaign.completed` | completed | system | `completed_by_dialler` |
 *
 * The dialer's own `running` / `paused` / `stopping` rows record the same supervisor actions the
 * console rows do, so they are not read twice.
 */
import type { AgencyCampaignStatus } from '@magick-agency/contracts/agency';
import type { AgencyInsightsTransition } from '@magick-agency/contracts/api/agency/insights';
import { fetchActivityPage } from '../agency-activity.service.js';
import { isCarrierAccountPauseReason } from '../carrier-account-pause-reasons.js';
import { ACTIVITY_MAX_LIMIT, type ActivityCursor, type ActivityRow } from '../agency-activity.js';

/** The most transitions read (a campaign paused and resumed hundreds of times keeps its newest). */
export const TRANSITIONS_MAX = 500;

const TRANSITION_ACTIONS = [
  'agency_campaign.started',
  'agency_campaign.paused',
  'agency_campaign.resumed',
  'agency_campaign.stopped',
  'agency_campaign.auto_paused',
  'agency_campaign.completed',
];

/** A trail row as a transition, or null when the row is not one (see the table above). */
export function transitionOf(row: Pick<ActivityRow, 'source' | 'action' | 'at' | 'actor'> & { detail?: ActivityRow['detail'] }): Omit<AgencyInsightsTransition, 'actor'> & { user_id: string | null } | null {
  const user = row.actor.system ? null : row.actor.user_id;
  const make = (to: AgencyCampaignStatus, reason: string, userId: string | null) => ({ to_status: to, at: row.at, reason, user_id: userId });
  if (row.source === 'master') {
    switch (row.action) {
      case 'agency_campaign.started': return make('running', 'supervisor', user);
      case 'agency_campaign.paused': return make('paused', 'supervisor', user);
      case 'agency_campaign.resumed': return make('running', 'supervisor', user);
      case 'agency_campaign.stopped': return make('stopping', 'supervisor', user);
      default: return null;
    }
  }
  switch (row.action) {
    // Two writers: the abandonment guardrail (no `reason` on its oldest rows, and
    // `abandonment_ceiling` since) and the carrier-account pause, which says
    // `carrier_auth`, `carrier_account_unavailable` or `carrier_refusing_calls`.
    case 'agency_campaign.auto_paused': {
      const reason = row.detail?.['reason'];
      return make('paused', isCarrierAccountPauseReason(reason) ? reason : 'abandonment_ceiling', null);
    }
    case 'agency_campaign.stopped': return make('stopped', 'calls_drained', null);
    case 'agency_campaign.completed': return make('completed', 'completed_by_dialler', null);
    default: return null;
  }
}

/** The campaign's transitions, oldest first, with their actors' names. */
export async function campaignTransitions(campaign: { id: string; tenant_id: string; account_id: string }): Promise<AgencyInsightsTransition[]> {
  const rows: ActivityRow[] = [];
  let cursor: ActivityCursor = { master: null, core: null };
  while (rows.length < TRANSITIONS_MAX) {
    const page = await fetchActivityPage({
      tenantId: campaign.tenant_id,
      campaignId: campaign.id,
      accountId: campaign.account_id,
      actions: TRANSITION_ACTIONS,
      limit: ACTIVITY_MAX_LIMIT,
      cursor,
      skipTotal: true,
    });
    rows.push(...page.rows);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const out: AgencyInsightsTransition[] = [];
  for (const row of rows.slice(0, TRANSITIONS_MAX)) {
    const t = transitionOf(row);
    if (!t) continue;
    out.push({
      to_status: t.to_status,
      at: t.at,
      reason: t.reason,
      actor: t.user_id === null ? null : { user_id: t.user_id, name: row.actor.display },
    });
  }
  // The trail is newest first; the page reads oldest first.
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
