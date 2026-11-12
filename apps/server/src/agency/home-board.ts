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
 *  - the overdue callbacks of every campaign on the board in one read
 *    (`callbacksOverdueByCampaign`: the insights allocation's `callbacks_overdue` predicate).
 *
 * ── What it costs, and why it reuses ─────────────────────────────────────────
 * The console asks for the board every 10 s while Home is open and every 60 s for each other
 * tab's sidebar badge. Three memos keep that from costing more than the reads it replaced:
 *
 *  - **The account's board** is reused for {@link HOME_BOARD_MS}, and requests that arrive while
 *    it is computed share that computation (single flight). Only the per-campaign reads are
 *    memoised: the campaign list is read on every request, and the memo's key carries each
 *    listed campaign's id, status and `updated_at`, so a campaign starting, stopping or being
 *    edited misses at once.
 *  - **A still campaign's stats** (not running or stopping, no live calls, nobody on shift on its
 *    floor: the campaigns home's `needsPolling` rule, read from the payload itself) are reused for
 *    {@link HOME_STILL_MS} while its floor holds: the memo's key carries the floor's signature
 *    (`floorSignatures`, one indexed read for the board: open sessions, newest state change,
 *    newest join), so an agent joining a paused campaign's floor, or a signed-out station being
 *    reaped, misses at once. A moving campaign's are read on every board.
 *  - **The overdue count** is reused for {@link HOME_STILL_MS} per campaign (a follow-up count,
 *    not a live queue; it was the console's 60 s tick). The campaigns that miss are read together.
 *
 * The last two are keyed by the campaign's status and `updated_at` (`insightsCacheKey`), so a
 * pause, resume, stop or settings edit misses at once. In process: HTTP is served by one process.
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

/** How long an account's board is reused (single flight while it is computed). */
export const HOME_BOARD_MS = 5_000;

/** How long a still campaign's stats, and any campaign's overdue count, are reused. */
export const HOME_STILL_MS = 60_000;

/** Campaigns whose stats are read at once: a board is at most 25 campaigns, one per account per {@link HOME_BOARD_MS}. */
export const HOME_READ_CONCURRENCY = 8;

/** What the board reads per campaign. The route supplies them (`liveStats` is a `callCore` hop). */
export interface HomeBoardDeps {
  /** The internal stats handler's payload under the campaign's own account; null when it refused. */
  liveStats: (campaign: AgencyCampaignRecord) => Promise<Partial<AgencyCampaignStats> | null>;
  /** `totals.callbacks_overdue` of each campaign's insights allocation, by id (absent: 0). */
  callbacksOverdue: (campaigns: AgencyCampaignRecord[]) => Promise<ReadonlyMap<string, number>>;
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

/** The most campaigns each per-campaign memo remembers (oldest first out). */
const MEMO_MAX_ENTRIES = 500;

/**
 * A per-campaign value reused {@link HOME_STILL_MS} while the campaign's status and `updated_at`
 * hold, and `extra` (the floor's signature, for the stats) with them.
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

const still = new CampaignMemo<Partial<AgencyCampaignStats>>('home-stats');
const overdue = new CampaignMemo<number>('home-overdue');
/** Each account's per-campaign reads, {@link HOME_BOARD_MS} (the clock read when it is used). */
const boards = new InsightsCache(HOME_BOARD_MS, MEMO_MAX_ENTRIES, () => Date.now(), 1);

/** Tests only: forget every memo. */
export function resetHomeBoardMemosForTests(): void {
  still.clear();
  overdue.clear();
  boards.clear();
}

/**
 * A campaign's stats: a still one's kept while its floor's signature holds (`floor`: undefined when
 * the signature read failed, and then nothing is reused).
 */
async function statsFor(
  campaign: AgencyCampaignRecord,
  deps: HomeBoardDeps,
  now: number,
  floor: string | undefined,
): Promise<Partial<AgencyCampaignStats> | null> {
  const kept = floor === undefined ? undefined : still.get(campaign, now, floor);
  if (kept) return kept;
  const stats = await deps.liveStats(campaign);
  still.delete(campaign.id);
  if (stats && floor !== undefined && !campaignMoving(campaign.status, stats)) still.set(campaign, now, stats, floor);
  return stats;
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

/** Each campaign's overdue count: the kept ones, and the rest in one read (all null when it fails). */
async function overdueFor(
  campaigns: AgencyCampaignRecord[],
  deps: HomeBoardDeps,
  now: number,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const missing: AgencyCampaignRecord[] = [];
  for (const campaign of campaigns) {
    const kept = overdue.get(campaign, now);
    if (kept === undefined) missing.push(campaign);
    else out.set(campaign.id, kept);
  }
  if (missing.length === 0) return out;
  try {
    const counts = await deps.callbacksOverdue(missing);
    for (const campaign of missing) {
      const n = counts.get(campaign.id) ?? 0;
      overdue.set(campaign, now, n);
      out.set(campaign.id, n);
    }
  } catch (err) {
    log.warn({ err, campaigns: missing.length, read: 'callbacks_overdue' }, 'Home board read failed; serving null for it');
    for (const campaign of missing) out.set(campaign.id, null);
  }
  return out;
}

async function settle<T>(what: string, campaignId: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    log.warn({ err, campaignId, read: what }, 'Home board read failed; serving null for it');
    return null;
  }
}

async function readCampaigns(rows: AgencyCampaignRecord[], deps: HomeBoardDeps): Promise<AgencyHomeCampaign[]> {
  const now = Date.now();
  const floors = await floorsOf(rows);
  const [counts, stats] = await Promise.all([
    overdueFor(rows, deps, now),
    mapWithConcurrency(rows, HOME_READ_CONCURRENCY, (campaign) =>
      settle('stats', campaign.id, () => statsFor(campaign, deps, now, floors ? floors.get(campaign.id) ?? '' : undefined))),
  ]);
  return rows.map((campaign, i) => {
    const read = stats[i];
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status as AgencyHomeActiveStatus,
      stats: read ? homeStats(read) : null,
      callbacks_overdue: counts.get(campaign.id) ?? null,
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
  const key = [`home:${scope.tenantId}:${scope.accountId}`, ...rows.map((c) => insightsCacheKey('', c))].join('|');
  const campaigns = rows.length === 0 ? [] : await boards.get(key, () => readCampaigns(rows, deps));
  return { campaigns, active_total: activeTotal, any_campaign: anyCampaign || activeTotal > 0 };
}
