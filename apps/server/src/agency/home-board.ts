/**
 * Home's board (decision B28a, `GET /proxy/agency/home`, the wire is
 * `packages/contracts/src/api/agency/home.ts`): the account's active campaigns and, per campaign,
 * what the campaign Overview's "Needs your attention" rules read, in one answer, so Home's list is
 * the Overview's. Assembled from reads that already exist, never a second copy of their rules:
 *
 *  - the campaigns: `agencyCampaignRepository.listForHome` (the Campaigns page's order, capped);
 *  - per campaign, the internal stats handler's payload (`liveStats`, the route's hop through
 *    `callCore`, so the stall, the guardrail's 24 hours and the floor are the health strip's
 *    own), projected to the fields Home and the Campaigns page's Active cards read
 *    (`homeStats`), and the allocation's staffing (`campaignStaffing`: assigned agents and how
 *    many are on the floor);
 *  - per campaign, the insights allocation (`cachedAllocation`, the Insights tab's own cache)
 *    projected by `attentionAllocation`: overdue callbacks and due contacts held by away agents;
 *  - per campaign, today's carrier failures and recording (`rangeAttentionFigures` over
 *    `todayRange`: the Health tab's "Today");
 *  - the campaign's recording and calling-hours settings, from the row (`insightsSettings`).
 *
 * The last four are the insights reads' (`agency.supervise`): a board for a reader below that
 * (the route's `insights: null`; the Campaigns page's Active cards for a viewer or operator)
 * serves them null and reads none of them, and is cached apart from a supervisor's.
 *
 * ── What it costs, and why it reuses ─────────────────────────────────────────
 * The console asks for the board every 10 s while Home is open, every 10 s while the Campaigns
 * page shows an active campaign, and every 60 s for each other tab's sidebar badge. Memos keep
 * that bounded:
 *
 *  - **The account's board** is reused for {@link HOME_BOARD_MS}, and requests that arrive while
 *    it is computed share that computation (single flight). Only the per-campaign reads are
 *    memoised: the campaign list is read on every request, and the memo's key carries each
 *    listed campaign's id, status and `updated_at`, so a campaign starting, stopping or being
 *    edited misses at once.
 *  - **A still campaign's stats and staffing** (not running or stopping, no live calls, nobody on
 *    shift on its floor: the campaigns home's `needsPolling` rule, read from the payload itself)
 *    are reused for {@link HOME_STILL_MS} while its floor holds: the memo's key carries the floor's
 *    signature (`floorSignatures`, one indexed read for the board: open sessions, newest state
 *    change, newest join), so an agent joining a paused campaign's floor, or a signed-out station
 *    being reaped, misses at once. A moving campaign's are read on every board.
 *  - **The allocation figures and today's figures** are reused for {@link HOME_STILL_MS} per
 *    campaign (follow-up counts, not a live queue). At most one allocation per campaign per minute
 *    on the board, shared with any Insights tab open on it through the insights cache. Today's
 *    range is worked out on every board (`todayRange`, the Health tab's "Today") and its start is
 *    part of the memo's key, so at the campaign zone's midnight the old day's figures miss at once
 *    (Home never shows yesterday while the Health tab shows today).
 *
 * All are keyed by the campaign's status and `updated_at` (`insightsCacheKey`), so a pause,
 * resume, stop or settings edit misses at once. In process: HTTP is served by one process.
 *
 * A campaign's read that fails is `null` on the board (logged), never a guess and never a failed
 * board: the console keeps what it showed for that campaign, and says so.
 */
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyCampaignStats } from '@magick-agency/contracts/agency';
import {
  AGENCY_HOME_ACTIVE_STATUSES,
  AGENCY_HOME_CAMPAIGN_CAP,
  AGENCY_HOME_STATS_FIELDS,
  attentionSettings,
  type AgencyAttentionAllocation,
  type AgencyAttentionRangeFigures,
  type AgencyAttentionStaffing,
  type AgencyHomeActiveStatus,
  type AgencyHomeBoard,
  type AgencyHomeCampaign,
  type AgencyHomeCampaignStats,
} from '@magick-agency/contracts/api/agency/home';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';
import { agencyCampaignRepository } from '../db/repositories/agency.repository.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { InsightsCache, insightsCacheKey } from './insights/cache.js';
import { insightsSettings } from './insights/settings.js';
import { todayRange } from './insights/health.js';
import type { ServedInsightsRange } from './insights/range.js';

const log = createChildLogger({ component: 'agency-home-board' });

/** How long an account's board is reused (single flight while it is computed). */
export const HOME_BOARD_MS = 5_000;

/** How long a still campaign's stats, and any campaign's allocation and today's figures, are reused. */
export const HOME_STILL_MS = 60_000;

/** Campaigns read at once: a board is at most 25 campaigns, one per account per {@link HOME_BOARD_MS}. */
export const HOME_READ_CONCURRENCY = 8;

/** What the board reads per campaign. The route supplies them (`liveStats` is a `callCore` hop). */
export interface HomeBoardDeps {
  /** The internal stats handler's payload under the campaign's own account; null when it refused. */
  liveStats: (campaign: AgencyCampaignRecord) => Promise<Partial<AgencyCampaignStats> | null>;
  /**
   * The insights reads, `agency.supervise`'s: given for a supervisor's board only. Null below that
   * floor: the board then serves `staffing`, `allocation`, `today` and `settings` null and makes
   * none of their reads (a viewer's board costs no allocation or range read).
   */
  insights: HomeInsightsDeps | null;
}

/** The insights reads of a supervisor's board (the insights routes' own reads). */
export interface HomeInsightsDeps {
  /** Assigned agents and how many are on the floor (`campaignStaffing`). */
  staffing: (campaign: AgencyCampaignRecord) => Promise<AgencyAttentionStaffing>;
  /** The insights allocation's attention figures (`attentionAllocation(cachedAllocation(…))`). */
  allocation: (campaign: AgencyCampaignRecord) => Promise<AgencyAttentionAllocation>;
  /**
   * Carrier failures and recording over `range` (`rangeAttentionFigures`): today in the campaign's
   * zone, as the board worked it out (`todayRange`), so the figures and the memo's key are one day.
   */
  today: (campaign: AgencyCampaignRecord, range: ServedInsightsRange) => Promise<AgencyAttentionRangeFigures>;
}

/**
 * Whether a campaign's live numbers move: running or stopping, or calls still live, or anyone on
 * shift on its floor. The console's campaigns home polls by the same rule (`needsPolling`).
 */
export function campaignMoving(status: string, stats: Partial<AgencyCampaignStats>): boolean {
  if (status === 'running' || status === 'stopping') return true;
  return (stats.attempts_live ?? 0) > 0 || (stats.agents_live ?? 0) > 0;
}

/**
 * The fields of `/stats` the board's readers use ({@link AGENCY_HOME_STATS_FIELDS}: Home's and the
 * Campaigns page's Active cards'), each as the payload has it (`stall` null when absent). Null for
 * a payload without the ceiling, which the internal stats handler always sends: that is not its
 * payload, and nothing on it is trusted.
 */
export function homeStats(stats: Partial<AgencyCampaignStats>): AgencyHomeCampaignStats | null {
  if (typeof stats.abandonment_ceiling_pct !== 'number') return null;
  const out: Record<string, unknown> = {};
  for (const field of AGENCY_HOME_STATS_FIELDS) out[field] = stats[field];
  out['stall'] = stats.stall ?? null;
  return out as AgencyHomeCampaignStats;
}

/** The most campaigns each per-campaign memo remembers (oldest first out). */
const MEMO_MAX_ENTRIES = 500;

/**
 * A per-campaign value reused {@link HOME_STILL_MS} while the campaign's status and `updated_at`
 * hold, and `extra` with them (the floor's signature for the live reads, today's start for today's
 * figures).
 */
class CampaignMemo<V> {
  private readonly entries = new Map<string, { key: string; at: number; value: V }>();

  constructor(private readonly section: string) {}

  private key(campaign: AgencyCampaignRecord, extra: string): string {
    return `${insightsCacheKey(this.section, campaign)}|${extra}`;
  }

  get(campaign: AgencyCampaignRecord, now: number, extra = ''): V | undefined {
    const kept = this.entries.get(campaign.id);
    return kept && kept.key === this.key(campaign, extra) && now - kept.at < HOME_STILL_MS
      ? kept.value
      : undefined;
  }

  set(campaign: AgencyCampaignRecord, now: number, value: V, extra = ''): void {
    this.entries.delete(campaign.id);
    this.entries.set(campaign.id, { key: this.key(campaign, extra), at: now, value });
    while (this.entries.size > MEMO_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(campaignId: string): void {
    this.entries.delete(campaignId);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** A campaign's live reads: the stats payload and the staffing, each null when it failed or was not read. */
interface LiveReads {
  stats: Partial<AgencyCampaignStats> | null;
  staffing: AgencyAttentionStaffing | null;
}

/** A still campaign's kept live reads: the staffing is absent when the board that read them had no insights. */
interface KeptLive {
  stats: Partial<AgencyCampaignStats>;
  staffing?: AgencyAttentionStaffing;
}

const still = new CampaignMemo<KeptLive>('home-live');
const allocations = new CampaignMemo<AgencyAttentionAllocation>('home-allocation');
const todays = new CampaignMemo<AgencyAttentionRangeFigures>('home-today');
/** Each account's per-campaign reads, {@link HOME_BOARD_MS} (the clock read when it is used). */
const boards = new InsightsCache(HOME_BOARD_MS, MEMO_MAX_ENTRIES, () => Date.now(), 1);

/** Tests only: forget every memo. */
export function resetHomeBoardMemosForTests(): void {
  still.clear();
  allocations.clear();
  todays.clear();
  boards.clear();
}

async function settle<T>(what: string, campaignId: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    log.warn({ err, campaignId, read: what }, 'Home board read failed; serving null for it');
    return null;
  }
}

/**
 * A campaign's stats and, on a supervisor's board, its staffing: a still one's kept while its
 * floor's signature holds (`floor`: undefined when the signature read failed, and then nothing is
 * reused). Kept only when every read made answered. Without insights the staffing is neither read
 * nor served; a kept entry without it serves a viewer's board but not a supervisor's.
 */
async function liveFor(
  campaign: AgencyCampaignRecord,
  deps: HomeBoardDeps,
  now: number,
  floor: string | undefined,
): Promise<LiveReads> {
  const { insights } = deps;
  const kept = floor === undefined ? undefined : still.get(campaign, now, floor);
  if (kept && (!insights || kept.staffing)) {
    return { stats: kept.stats, staffing: insights ? kept.staffing! : null };
  }
  const [stats, staffing] = await Promise.all([
    settle('stats', campaign.id, () => deps.liveStats(campaign)),
    insights ? settle('staffing', campaign.id, () => insights.staffing(campaign)) : Promise.resolve(null),
  ]);
  still.delete(campaign.id);
  if (stats && (staffing || !insights) && floor !== undefined && !campaignMoving(campaign.status, stats)) {
    still.set(campaign, now, staffing ? { stats, staffing } : { stats }, floor);
  }
  return { stats, staffing };
}

/**
 * A value reused {@link HOME_STILL_MS} per campaign while `extra` holds too; a failed read is null
 * and read again next board.
 */
async function memoised<V>(
  memo: CampaignMemo<V>,
  what: string,
  campaign: AgencyCampaignRecord,
  now: number,
  read: () => Promise<V>,
  extra = '',
): Promise<V | null> {
  const kept = memo.get(campaign, now, extra);
  if (kept !== undefined) return kept;
  const value = await settle(what, campaign.id, read);
  if (value === null) memo.delete(campaign.id);
  else memo.set(campaign, now, value, extra);
  return value;
}

/**
 * Today's carrier failures and recording: the range is today in the campaign's zone at `now`, and
 * its start keys the memo, so a new day misses at once. A range that cannot be worked out is a
 * failed read (null).
 */
async function todayFor(
  campaign: AgencyCampaignRecord,
  insights: HomeInsightsDeps,
  now: number,
): Promise<AgencyAttentionRangeFigures | null> {
  const range = await settle('today_range', campaign.id, async () => todayRange(campaign, new Date(now)));
  if (!range) return null;
  return memoised(todays, 'today', campaign, now, () => insights.today(campaign, range), range.from.toISOString());
}

/**
 * Each campaign's floor signature (`floorSignatures`: open sessions, newest state change, newest
 * join; '' for an empty floor), or null when the read failed.
 */
async function floorsOf(rows: AgencyCampaignRecord[]): Promise<Map<string, string> | null> {
  try {
    return await agencyCampaignRepository.floorSignatures(rows.map((c) => c.id));
  } catch (err) {
    log.warn({ err, campaigns: rows.length, read: 'floor_signatures' }, 'Home board read failed; reading every campaign’s stats');
    return null;
  }
}

async function readCampaigns(rows: AgencyCampaignRecord[], deps: HomeBoardDeps): Promise<AgencyHomeCampaign[]> {
  const now = Date.now();
  const floors = await floorsOf(rows);
  const { insights } = deps;
  return mapWithConcurrency(rows, HOME_READ_CONCURRENCY, async (campaign): Promise<AgencyHomeCampaign> => {
    const [live, allocation, today] = await Promise.all([
      liveFor(campaign, deps, now, floors ? floors.get(campaign.id) ?? '' : undefined),
      insights ? memoised(allocations, 'allocation', campaign, now, () => insights.allocation(campaign)) : null,
      insights ? todayFor(campaign, insights, now) : null,
    ]);
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status as AgencyHomeActiveStatus,
      stats: live.stats ? homeStats(live.stats) : null,
      staffing: live.staffing,
      allocation,
      today,
      settings: insights ? attentionSettings(insightsSettings(campaign, null)) : null,
    };
  });
}

/** The board for one account. Throws only when the campaign list cannot be read. */
export async function computeHomeBoard(
  scope: { tenantId: string; accountId: string },
  deps: HomeBoardDeps,
): Promise<AgencyHomeBoard> {
  const { rows, activeTotal, anyCampaign } = await agencyCampaignRepository.listForHome(
    scope.tenantId, scope.accountId, AGENCY_HOME_ACTIVE_STATUSES, AGENCY_HOME_CAMPAIGN_CAP,
  );
  // A supervisor's board and a viewer's are different answers: never one served for the other.
  const tier = deps.insights ? 'supervise' : 'campaigns';
  const key = [`home:${scope.tenantId}:${scope.accountId}:${tier}`, ...rows.map((c) => insightsCacheKey('', c))].join('|');
  const campaigns = rows.length === 0 ? [] : await boards.get(key, () => readCampaigns(rows, deps));
  return { campaigns, active_total: activeTotal, any_campaign: anyCampaign || activeTotal > 0 };
}
