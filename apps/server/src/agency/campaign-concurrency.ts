/**
 * The `concurrency` block on a campaign's stats (decisions MC7): where one campaign
 * sits within its account's line limit now that an account may run several campaigns
 * at once (MC1, MC6).
 *
 * Pure: the stats route (`api/routes/agency-campaigns/stats.ts`) makes the reads, from
 * the sources pacing reads (`account_settings.max_concurrent_calls`,
 * `countLiveForAccount`, the account's `running` campaigns), and this shapes them. It
 * reports the EQUAL share, not the round's allocation: the allocation is decided per
 * pacing round (`pacing/round.ts`) and is gone by the time a supervisor reads it, while
 * the equal share is what fewest-live-calls-first converges on when every running
 * campaign is busy.
 */
import type { AgencyCampaignConcurrency } from '@magick-agency/contracts/agency';

/**
 * The statuses whose stats carry `concurrency`. A `stopping` or `paused` campaign holds
 * no share but can still have calls draining on the account's lines; a draft or a
 * finished campaign has nothing on them, so its block is `null`.
 */
export const CAMPAIGN_CONCURRENCY_STATUSES: ReadonlySet<string> = new Set(['running', 'stopping', 'paused']);

export interface CampaignConcurrencyInput {
  status: string;
  /** This campaign's live attempts (`attempts_live`). */
  campaignLive: number;
  accountLimit: number;
  accountLive: number;
  runningCampaigns: number;
}

/**
 * `fair_share` is `Math.floor(limit / running)` only while this campaign runs beside
 * at least one other; alone, it can use the whole limit and a "share" would say
 * nothing. A count read a moment apart from the campaign row (this campaign just
 * started, or just paused) is clamped so a running campaign is never reported beside
 * zero running campaigns.
 */
export function campaignConcurrency(input: CampaignConcurrencyInput): AgencyCampaignConcurrency {
  const running = input.status === 'running';
  const runningCampaigns = running ? Math.max(input.runningCampaigns, 1) : Math.max(input.runningCampaigns, 0);
  const accountLimit = Math.max(input.accountLimit, 0);
  return {
    campaign_live: input.campaignLive,
    fair_share: running && runningCampaigns > 1 ? Math.floor(accountLimit / runningCampaigns) : null,
    account_limit: accountLimit,
    account_live: input.accountLive,
    running_campaigns: runningCampaigns,
  };
}
