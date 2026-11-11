/**
 * Home's board (decision B28a, `GET /proxy/agency/home`, the wire is
 * `packages/contracts/src/api/agency/home.ts`): the account's active campaigns and, per campaign,
 * what Home reads, in one answer. Assembled from reads that already exist, never a second copy of
 * their rules:
 *
 *  - the campaigns: `agencyCampaignRepository.listForHome` (the Campaigns page's order, capped);
 *  - per campaign, the internal stats handler's payload (`liveStats`, the route's hop through
 *    `callCore`, so the stall, the guardrail's 24 hours and the floor are the health strip's
 *    own), projected to the fields Home reads;
 *  - per campaign, `totals.callbacks_overdue` of the insights allocation (`cachedAllocation`, the
 *    allocation route's own read and cache).
 *
 * ── What it costs, and why it reuses ─────────────────────────────────────────
 * The console asks for the board every 10 s while Home is open and every 60 s for the sidebar
 * badge. Two memos keep that from costing more than the reads it replaced:
 *
 *  - **A still campaign's stats** (not running or stopping, no live calls, nobody on its floor:
 *    the campaigns home's `needsPolling` rule, read from the payload itself) are reused for
 *    {@link HOME_STILL_MS}. A moving campaign's are read on every board. The console used to
 *    apply the same rule client-side.
 *  - **The overdue count** is reused for {@link HOME_STILL_MS} per campaign (a follow-up count,
 *    not a live queue; it was the console's 60 s tick), on top of the insights cache's own few
 *    seconds.
 *
 * Both are keyed by the campaign's status and `updated_at` (`insightsCacheKey`), so a pause,
 * resume, stop or settings edit misses at once. In process: HTTP is served by one process.
 *
 * A campaign's read that fails is `null` on the board (logged), never a guess and never a failed
 * board: the console keeps what it showed for that campaign.
 */
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyCampaignStats } from '@magick-agency/contracts/agency';
import {
  AGENCY_HOME_ACTIVE_STATUSES,
  AGENCY_HOME_CAMPAIGN_CAP,
  type AgencyHomeActiveStatus,
  type AgencyHomeBoard,
  type AgencyHomeCampaign,
  type AgencyHomeCampaignStats,
} from '@magick-agency/contracts/api/agency/home';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';
import { agencyCampaignRepository } from '../db/repositories/agency.repository.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { InsightsCache, insightsCacheKey } from './insights/cache.js';

const log = createChildLogger({ component: 'agency-home-board' });

/** How long a still campaign's stats, and any campaign's overdue count, are reused. */
export const HOME_STILL_MS = 60_000;

/** Campaigns whose reads run at once: a board is at most 25 campaigns, one request. */
export const HOME_READ_CONCURRENCY = 4;

/** What the board reads per campaign. The route supplies them (`liveStats` is a `callCore` hop). */
export interface HomeBoardDeps {
  /** The internal stats handler's payload under the campaign's own account; null when it refused. */
  liveStats: (campaign: AgencyCampaignRecord) => Promise<Partial<AgencyCampaignStats> | null>;
  /** `totals.callbacks_overdue` of the insights allocation. */
  callbacksOverdue: (campaign: AgencyCampaignRecord) => Promise<number>;
  now?: () => number;
}

/**
 * Whether a campaign's live numbers move: running or stopping, or calls still live, or anyone on
 * its floor. The console's campaigns home polls by the same rule (`needsPolling`).
 */
export function campaignMoving(status: string, stats: Partial<AgencyCampaignStats>): boolean {
  if (status === 'running' || status === 'stopping') return true;
  return (stats.attempts_live ?? 0) > 0 || (stats.agents_live ?? 0) > 0;
}

/**
 * The fields of `/stats` Home reads. Null for a payload without the ceiling, which the internal
 * stats handler always sends: that is not its payload, and nothing on it is trusted.
 */
export function homeStats(stats: Partial<AgencyCampaignStats>): AgencyHomeCampaignStats | null {
  if (typeof stats.abandonment_ceiling_pct !== 'number') return null;
  return {
    stall: stats.stall ?? null,
    abandoned_24h: stats.abandoned_24h,
    answered_24h: stats.answered_24h,
    abandonment_ceiling_pct: stats.abandonment_ceiling_pct,
    agents_live: stats.agents_live,
    agents_by_state: stats.agents_by_state,
  };
}

interface StillEntry {
  key: string;
  at: number;
  stats: Partial<AgencyCampaignStats>;
}

/** The most still campaigns remembered (oldest first out). */
const STILL_MAX_ENTRIES = 500;
const still = new Map<string, StillEntry>();
/** The overdue counts, reused {@link HOME_STILL_MS} (single flight, bounded). */
let overdueCache = new InsightsCache(HOME_STILL_MS);

/** Tests only: forget both memos. */
export function resetHomeBoardMemosForTests(): void {
  still.clear();
  overdueCache = new InsightsCache(HOME_STILL_MS);
}

async function statsFor(campaign: AgencyCampaignRecord, deps: HomeBoardDeps, now: number): Promise<Partial<AgencyCampaignStats> | null> {
  const key = insightsCacheKey('home-stats', campaign);
  const kept = still.get(campaign.id);
  if (kept && kept.key === key && now - kept.at < HOME_STILL_MS) return kept.stats;

  const stats = await deps.liveStats(campaign);
  still.delete(campaign.id);
  if (stats && !campaignMoving(campaign.status, stats)) {
    still.set(campaign.id, { key, at: now, stats });
    while (still.size > STILL_MAX_ENTRIES) {
      const oldest = still.keys().next().value;
      if (oldest === undefined) break;
      still.delete(oldest);
    }
  }
  return stats;
}

async function settle<T>(what: string, campaignId: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    log.warn({ err, campaignId, read: what }, 'Home board read failed; serving null for it');
    return null;
  }
}

/** The board for one account. Throws only when the campaign list cannot be read. */
export async function computeHomeBoard(
  scope: { tenantId: string; accountId: string },
  deps: HomeBoardDeps,
): Promise<AgencyHomeBoard> {
  const now = (deps.now ?? Date.now)();
  const { rows, activeTotal, anyCampaign } = await agencyCampaignRepository.listForHome(
    scope.tenantId, scope.accountId, AGENCY_HOME_ACTIVE_STATUSES, AGENCY_HOME_CAMPAIGN_CAP,
  );

  const campaigns = await mapWithConcurrency(rows, HOME_READ_CONCURRENCY, async (campaign): Promise<AgencyHomeCampaign> => {
    const [stats, overdue] = await Promise.all([
      settle('stats', campaign.id, () => statsFor(campaign, deps, now)),
      settle('callbacks_overdue', campaign.id, () =>
        overdueCache.get(insightsCacheKey('home-overdue', campaign), () => deps.callbacksOverdue(campaign))),
    ]);
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status as AgencyHomeActiveStatus,
      stats: stats ? homeStats(stats) : null,
      callbacks_overdue: overdue,
    };
  });

  return { campaigns, active_total: activeTotal, any_campaign: anyCampaign || activeTotal > 0 };
}
