/**
 * One campaign's stats read, shared between the supervisors who ask for it.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 * `GET /api/v1/agency-campaigns/:id/stats` runs two campaign-wide SQL reads: `stats()`
 * (one pass over ALL the campaign's contacts and ALL its attempts, plus the floor) and
 * `healthInputs()` (the pending contacts by timezone, the last dial, recent failures, breaks).
 * Each open campaign page asks every 10 s, so N supervisors on one big campaign ran N full
 * scans per 10 s, on the same pool the dial loop draws from. Here the pair is read once per
 * campaign and handed to every request that asks while it is being read, and to every request
 * in the `ttlMs` after it settled (`AGENCY_CAMPAIGN_STATS_CACHE_MS`, `config/blocks/agency.ts`).
 *
 * ── What is shared, and what is not ──────────────────────────────────────
 * Only the two SQL reads, keyed by campaign id. Both are a function of the campaign id alone
 * (and of the database's `now()`): no tenant, account, user or query parameter reaches them,
 * so the key fully determines the result, as `TtlCache` requires. The route's other inputs
 * (DNC state, the concurrency counters, station liveness and capability, the account's
 * limit, calling hours against `new Date()`) are read per request, after this, and are never
 * held here. Authorisation is not this module's: the route's `ownedCampaign` preHandler runs
 * for every request before the handler asks for a shared read, so a request that may not see
 * the campaign never reaches it.
 *
 * ── Read-your-writes ──────────────────────────────────────────────────────
 * The console re-reads `/stats` straight after a supervisor's own write and paints what comes
 * back: after start / pause / resume / stop (`useCampaignLifecycle`), after a forced return to
 * `available` (`AgentFloor`'s `onForced`), and on opening a campaign after a roster upload. A
 * draft or a drained pause does not poll, so a stale answer there would stay on screen until
 * the tab is left and re-entered. So those writes drop the campaign's shared read, and the next
 * request reads afresh rather than joining a read that began before the write
 * (`TtlCache.invalidate` stops sharing the load in flight):
 *  - `campaign_changed` on the pacing invalidation bus: every write to the campaign row
 *    (lifecycle transitions, settings saves such as the disposition catalogue and the
 *    abandonment ceiling, both of which `stats()` reads, the automatic pauses);
 *  - this cache's name on the cache-invalidation channel (`cache/cache-invalidation.ts`):
 *    a supervisor's force-available publishes it for its campaign, and the roster ingest once
 *    the roster is complete. No pacing event carries the force-available reliably
 *    (`agent_available` names no campaign when the agent has no station here, and it fires on
 *    every wrap-up end, far too often to drop a read on). With `MEDIA_WORKERS` the
 *    force-available route runs in a media worker; the channel carries it to the primary
 *    (`cache.invalidate` over IPC), where this read lives.
 *
 * ── Bursts ────────────────────────────────────────────────────────────────
 * `contacts_changed` (each roster chunk, the owner sweeps, an agent reopening contacts) comes in
 * bursts: a big ingest publishes one per chunk while supervisors poll. Dropping the read in flight
 * on each would start a new full scan per poll per chunk, overlapping the scans still running
 * over a growing `agency_contacts`. So it only marks the read stale (`TtlCache.markStale`): a
 * request while the read is in flight still joins it, nothing it returns is kept, and the first
 * request after it settles reads afresh. One scan at a time per campaign however long the burst;
 * an answer a chunk behind is the trade, and the ingest's own invalidation above makes the read
 * after a completed upload fresh.
 *
 * Everything else the payload counts (dials, outcomes, dispositions, agent state, a contact
 * edited on its own) moves without an event; the page polls for it, and an answer up to `ttlMs`
 * old is the trade.
 *
 * ── Reading past it ───────────────────────────────────────────────────────
 * Home's board keeps a still campaign's stats for a minute under its floor's signature, so a read
 * that predates that signature must not be kept (`home-board.ts`, `liveFor`). The route answers
 * every request with {@link CAMPAIGN_STATS_READ_HEADER}: `scanned` when this request's own read
 * ran (it began after anything the caller read before asking), `shared` when it was handed one
 * another request began. A caller that sends {@link CAMPAIGN_STATS_FRESH_HEADER} gets a read of
 * its own that no one else joins or is served, and the shared read is left as it is for everyone
 * else. Both headers are on the internal handler instance only, which never listens: the public
 * route forwards neither (`proxy-agency-campaigns/stats.ts`), so only an in-process `callCore`
 * caller can ask for a read past the shared one.
 *
 * ── One cache per registration ────────────────────────────────────────────
 * Each `registerCampaignStatsRoutes` opens its own {@link CampaignStatsReads} and closes it with
 * its app. Production registers the route once (the core handlers), so there is one; every test
 * that builds an app starts empty, with nothing left over from the last. A media worker builds
 * the core handlers too, so it holds one that nothing reads (the stats route is not forwarded to
 * workers): empty, so harmless, whatever the worker's own invalidations drop from it.
 */
import { TtlCache } from '@magick-agency/db/utils/ttl-cache';
import { agencyCampaignStatsReadsTotal } from '@magick-agency/observability/metrics/agency';
import { agencyCampaignRepository } from '../db/repositories/agency.repository.js';
import { onCacheInvalidation } from '../cache/cache-invalidation.js';
import { getPacingInvalidationBus, type PacingInvalidationBus } from './pacing/invalidation-bus.js';

/** This cache's name, on the cache-invalidation channel and as the `TtlCache`'s label. */
export const CAMPAIGN_STATS_CACHE = 'agency-campaign-stats' as const;

/** Request header, internal instance only: `1` reads past the shared read (see the module note). */
export const CAMPAIGN_STATS_FRESH_HEADER = 'x-mgkvc-stats-fresh';

/** Response header, internal instance only: `scanned` or `shared` (see the module note). */
export const CAMPAIGN_STATS_READ_HEADER = 'x-mgkvc-stats-read';

/** The two campaign-scoped reads behind one stats response. Shared: never mutate. */
export interface CampaignStatsRead {
  stats: Awaited<ReturnType<typeof agencyCampaignRepository.stats>>;
  health: Awaited<ReturnType<typeof agencyCampaignRepository.healthInputs>>;
}

/** One request's answer: the shared pair, and whether this request's own read produced it. */
export interface CampaignStatsAnswer extends CampaignStatsRead {
  /** True when the read ran for this request (began in it); false when another request's was handed over. */
  scanned: boolean;
}

/**
 * Campaigns held at once. Only a campaign someone looked at in the last `ttlMs` is worth
 * holding; 500 is far above the campaigns a process's supervisors watch inside a few seconds,
 * and bounds memory at 500 floors' worth of rows whatever is browsed.
 */
export const CAMPAIGN_STATS_READS_MAX_ENTRIES = 500;

/** Both reads for one campaign, together. A rejection of either rejects the pair (never cached). */
async function readCampaign(campaignId: string): Promise<CampaignStatsRead> {
  const [stats, health] = await Promise.all([
    agencyCampaignRepository.stats(campaignId),
    agencyCampaignRepository.healthInputs(campaignId),
  ]);
  return { stats, health };
}

export class CampaignStatsReads {
  private readonly cache: TtlCache<CampaignStatsRead>;
  private readonly unsubscribe: Array<() => void>;

  constructor(opts: {
    /** `AGENCY_CAMPAIGN_STATS_CACHE_MS`. `0`: share a read in flight, serve nothing settled. */
    ttlMs: number;
    /** The bus whose campaign events drop a read. The process's bus unless given. */
    bus?: PacingInvalidationBus;
    maxEntries?: number;
  }) {
    this.cache = new TtlCache<CampaignStatsRead>({
      ttlMs: opts.ttlMs,
      maxEntries: opts.maxEntries ?? CAMPAIGN_STATS_READS_MAX_ENTRIES,
      name: CAMPAIGN_STATS_CACHE,
    });
    this.unsubscribe = [
      (opts.bus ?? getPacingInvalidationBus()).subscribe((event) => {
        if (event.type === 'campaign_changed') this.invalidate(event.campaignId);
        // A burst: let the read in flight finish, unkept (the module note's "Bursts").
        else if (event.type === 'contacts_changed') this.cache.markStale(event.campaignId);
      }),
      onCacheInvalidation(CAMPAIGN_STATS_CACHE, (campaignId) => this.invalidate(campaignId)),
    ];
  }

  /**
   * The campaign's two reads: a settled one younger than `ttlMs`, the one in flight, or a new
   * one; with `fresh`, a new one of this caller's own that is neither shared nor kept. Call it
   * only for a campaign the caller has already been authorised for.
   */
  async read(campaignId: string, opts: { fresh?: boolean } = {}): Promise<CampaignStatsAnswer> {
    if (opts.fresh) {
      const own = await readCampaign(campaignId);
      agencyCampaignStatsReadsTotal.inc({ result: 'scanned' });
      return { ...own, scanned: true };
    }
    let scanned = false;
    const read = await this.cache.getOrLoad(campaignId, () => {
      // Only the request whose loader runs reads the database; a joined or served request's
      // loader is never called.
      scanned = true;
      return readCampaign(campaignId);
    });
    agencyCampaignStatsReadsTotal.inc({ result: scanned ? 'scanned' : 'shared' });
    return { ...read, scanned };
  }

  /** Drop the campaign's read: the next request reads afresh (see the module note). */
  invalidate(campaignId: string): void {
    this.cache.invalidate(campaignId);
  }

  /** Stop listening and hold nothing more. Idempotent. */
  close(): void {
    for (const off of this.unsubscribe) off();
    this.cache.clear();
  }
}
