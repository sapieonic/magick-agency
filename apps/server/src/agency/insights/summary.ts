/**
 * `GET …/insights/summary`: the header, settings, the status headline and the roster buckets, as
 * of now. Part of `src/agency/insights/` (docs/insights.md "API").
 *
 * ── The headline per status (exactly one member is non-null) ────────────────
 *  - **running**: the stats strip's own live numbers, read through the internal handler the strip
 *    is served by (`GET /agency-campaigns/:id/stats`: `agents_by_state`, `attempts_live`, the
 *    concurrency pair, the `campaign-health.ts` stall diagnosis, the 24 h abandonment pair), never
 *    re-derived here; and the pace from the last hour of dials (`dialPace`):
 *    - `dials_per_hour` = dials placed in the last 15 min × 4; null before the campaign's first
 *      dial (none placed on the whole roster), 0 when it has dialled before but not lately;
 *    - `eta_seconds` = pending contacts ÷ contacts finished in the last hour × 3600: hours of
 *      DIALLING at the current pace, i.e. calling-hours time (the clock stops while the window is
 *      shut; the console says "inside calling hours"). "Finished" = dialled in the last hour and
 *      now completed, exhausted or suppressed. Null when none finished (rate 0 or unknown).
 *  - **paused**: `paused_at`, who (the row's `last_transition_by`, null for the guardrail), why,
 *    the frozen rate of an auto-pause, live attempts still finishing, contacts due now (what a
 *    resume dials first), callbacks that fell due since the pause, and callbacks due before
 *    today's calling window closes (`windowEndToday`).
 *  - **stopping**: when Stop was pressed (its transition, else the row's `updated_at`), who, and
 *    the live attempts still draining.
 *  - **stopped**: `ended_at`, who pressed Stop (`stopping → stopped` keeps that actor), the pending
 *    contacts left, the future callbacks (the roster's `waiting_callback`), the contacts never
 *    dialled, and what the console's default retry selector would pick up.
 *  - **completed**: `ended_at`, start to end, reached (`completed`), successes, not reached
 *    (exhausted + pending attempted and not connected), DNC, and the retry selector's count.
 *  - **draft**: `ready` from the readiness checks.
 *
 * `retry_matched` is what the console's `DEFAULT_RETRY_SELECTOR`
 * (`{ last_outcome: ['no_answer', 'busy', '__none__'] }`) would pick up: the retry preview's
 * selection counted without its fingerprint DISTINCT (`retryMatchCount`, 0.3 s against the
 * preview's 5.0 s on a 1M-contact campaign; the two differ only for legacy rows with no stored
 * fingerprint that duplicate one another). Read only for a stopped or completed campaign, which
 * the console does not poll, and cached with the rest of the summary.
 */
import type { AgencyCampaignStats, AgencyRetrySelector } from '@magick-agency/contracts/agency';
import type {
  AgencyInsightsHeadline,
  AgencyInsightsSummary,
} from '@magick-agency/contracts/api/agency/insights';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { callAnalysisProfileRepository } from '@magick-agency/db/repositories/call-analysis-profile.repository';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import {
  agencyCampaignRepository,
  agencyInsightsReadRepository,
  type RosterCounts,
} from '../../db/repositories/agency.repository.js';
import { agentNamesOrNone } from '../agency-agent-identity.js';
import { windowEndToday } from '../calling-hours.js';
import { isCarrierAccountPauseReason } from '../carrier-account-pause-reasons.js';
import { RETRY_NO_OUTCOME } from '../spine-filters.js';
import { computeReadiness } from './readiness.js';
import { readRoster, rosterWire } from './roster.js';
import { insightsSettings } from './settings.js';
import { actorOf, iso, userIdOf } from './shared.js';
import { campaignTransitions } from './transitions.js';

/** The console's `DEFAULT_RETRY_SELECTOR` (`apps/console/src/utils/agencyRetrySelector.ts`). */
export const DEFAULT_RETRY_SELECTOR: AgencyRetrySelector = { last_outcome: ['no_answer', 'busy', RETRY_NO_OUTCOME] };

/** What the summary reads through the route layer (the internal handler hop). */
export interface SummaryDeps {
  /** The stats strip's payload for the campaign, or null when it could not be read. */
  liveStats: () => Promise<Partial<AgencyCampaignStats> | null>;
}

/** `dials_per_hour` and `eta_seconds` from the pace and the roster (pure). */
export function pace(input: { dials15m: number; finished1h: number; open: number; everDialled: boolean }): {
  dials_per_hour: number | null; eta_seconds: number | null;
} {
  return {
    dials_per_hour: input.everDialled ? input.dials15m * 4 : null,
    eta_seconds: input.finished1h > 0 ? Math.round((input.open / input.finished1h) * 3600) : null,
  };
}

const EMPTY_HEADLINE: AgencyInsightsHeadline = {
  running: null, paused: null, stopping: null, stopped: null, completed: null, draft: null,
};

function retryMatched(campaignId: string): Promise<number> {
  return agencyInsightsReadRepository.retryMatchCount(campaignId, DEFAULT_RETRY_SELECTOR);
}

export async function computeSummary(campaign: AgencyCampaignRecord, deps: SummaryDeps): Promise<AgencyInsightsSummary> {
  const now = new Date();
  const status = campaign.status;
  const paused = status === 'paused';
  const roster = await readRoster(campaign, {
    pausedAt: paused ? campaign.paused_at : null,
    windowEndAt: paused
      ? windowEndToday({
          start: campaign.calling_window_start,
          end: campaign.calling_window_end,
          days: campaign.calling_days,
          timezone: campaign.default_timezone,
        }, now)
      : null,
  });

  const creatorId = userIdOf(campaign.created_by);
  const transitionBy = userIdOf(campaign.last_transition_by_user_id);
  const [transitions, lineage, upload, account, profile, names, headline] = await Promise.all([
    campaignTransitions(campaign),
    agencyCampaignRepository.campaignLineage(campaign.tenant_id, campaign.account_id, campaign.id),
    agencyInsightsReadRepository.latestCompletedUpload(campaign.tenant_id, campaign.id),
    accountRepository.findByIdInTenant(campaign.account_id, campaign.tenant_id),
    campaign.analysis_profile_id
      ? callAnalysisProfileRepository.findByIdScoped(campaign.analysis_profile_id, campaign.tenant_id, campaign.account_id)
      : Promise.resolve(null),
    agentNamesOrNone([creatorId, transitionBy], campaign.tenant_id, 'insights'),
    statusHeadline(campaign, roster, deps),
  ]);

  const transitionActor = transitionBy === null ? null : {
    user_id: transitionBy,
    name: names.get(transitionBy) ?? campaign.last_transition_by_name ?? null,
  };
  // The headline's actor and instants need the transitions and names read above.
  // An automatic pause (the guardrail, or the carrier-account pause) has no actor.
  if (headline.paused) headline.paused.actor = campaign.pause_reason === 'abandonment_ceiling' || isCarrierAccountPauseReason(campaign.pause_reason) ? null : transitionActor;
  if (headline.stopping) {
    const pressed = [...transitions].reverse().find((t) => t.to_status === 'stopping');
    headline.stopping.actor = transitionActor;
    headline.stopping.stopped_at = pressed?.at ?? iso(campaign.updated_at)!;
  }
  if (headline.stopped) headline.stopped.actor = transitionActor;

  const lineageRows = lineage?.campaigns ?? [];
  const parent = campaign.parent_campaign_id ? lineageRows.find((c) => c.id === campaign.parent_campaign_id) : undefined;

  return {
    campaign_id: campaign.id,
    name: campaign.name,
    status,
    account: { id: campaign.account_id, name: account?.name ?? null },
    created_at: iso(campaign.created_at)!,
    created_by: actorOf(creatorId, names),
    started_at: iso(campaign.started_at),
    ended_at: iso(campaign.ended_at),
    transitions,
    dedupe_columns: upload?.dedupe_columns ?? [],
    parent_campaign: parent ? { id: parent.id, name: parent.name } : null,
    child_campaigns: lineageRows
      .filter((c) => c.parent_campaign_id === campaign.id)
      .map((c) => ({ id: c.id, name: c.name, status: c.status })),
    settings: insightsSettings(campaign, profile ? { id: profile.id, name: profile.name ?? null } : null),
    headline,
    roster: rosterWire(roster),
    generated_at: now.toISOString(),
  };
}

/** The status's headline member; actors and the stop instant are filled in by the caller. */
async function statusHeadline(campaign: AgencyCampaignRecord, roster: RosterCounts, deps: SummaryDeps): Promise<AgencyInsightsHeadline> {
  const b = roster.buckets;
  switch (campaign.status) {
    case 'running': {
      const [stats, dial] = await Promise.all([deps.liveStats(), agencyInsightsReadRepository.dialPace(campaign.id)]);
      const limit = typeof stats?.concurrency_limit === 'number' && stats.concurrency_limit > 0 ? stats.concurrency_limit : null;
      const callsLive = stats?.attempts_live ?? b.on_call + b.in_wrapup;
      return {
        ...EMPTY_HEADLINE,
        running: {
          agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0, ...(stats?.agents_by_state ?? {}) },
          calls_live: callsLive,
          // The account's distributed count when Redis answered, else null (the strip's own
          // `null`). Not this campaign's live calls: that is a different number (one campaign, not
          // the account), and set beside the account's limit it would read as headroom that is
          // not there.
          concurrency_in_use: typeof stats?.concurrency_in_use === 'number' ? stats.concurrency_in_use : null,
          concurrency_limit: limit,
          ...pace({ dials15m: dial.dials_15m, finished1h: dial.finished_1h, open: roster.pending, everDialled: roster.dials_placed > 0 }),
          stall: stats?.stall ?? null,
          other_stalls: stats?.other_stalls ?? [],
          abandonment_rate_24h: { abandoned: stats?.abandoned_24h ?? 0, answered: stats?.answered_24h ?? 0 },
        },
      };
    }
    case 'paused': {
      const live = await agencyInsightsReadRepository.liveAttempts(campaign.id);
      return {
        ...EMPTY_HEADLINE,
        paused: {
          paused_at: iso(campaign.paused_at ?? campaign.updated_at)!,
          actor: null,
          reason: campaign.pause_reason ?? 'supervisor',
          abandonment_rate_pct_at_pause: campaign.pause_reason === 'abandonment_ceiling' ? campaign.pause_abandonment_rate_pct : null,
          calls_finishing: live,
          waiting_to_resume: b.waiting_due_now,
          callbacks_missed_while_paused: roster.callbacks_missed_while_paused,
          callbacks_due_before_window_end: roster.callbacks_due_before_window_end,
        },
      };
    }
    case 'stopping': {
      const live = await agencyInsightsReadRepository.liveAttempts(campaign.id);
      return { ...EMPTY_HEADLINE, stopping: { stopped_at: iso(campaign.updated_at)!, actor: null, calls_finishing: live } };
    }
    case 'stopped':
      return {
        ...EMPTY_HEADLINE,
        stopped: {
          stopped_at: iso(campaign.ended_at ?? campaign.updated_at)!,
          actor: null,
          pending: roster.pending,
          callbacks_scheduled: b.waiting_callback,
          never_attempted: roster.total - roster.attempted,
          retry_matched: await retryMatched(campaign.id),
        },
      };
    case 'completed': {
      const end = campaign.ended_at ?? campaign.updated_at;
      const start = campaign.started_at ?? campaign.created_at;
      return {
        ...EMPTY_HEADLINE,
        completed: {
          completed_at: iso(end)!,
          duration_seconds: Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000)),
          reached: b.completed,
          successes: roster.successes,
          not_reached: b.exhausted + roster.not_reached,
          dnc: b.suppressed_dnc,
          retry_matched: await retryMatched(campaign.id),
        },
      };
    }
    case 'draft':
    default: {
      const readiness = await computeReadiness(campaign, roster);
      return { ...EMPTY_HEADLINE, draft: { ready: readiness.ready } };
    }
  }
}
