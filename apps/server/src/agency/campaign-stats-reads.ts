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
 * the tab is left and re-entered. So the writes that matter drop the campaign's shared read,
 * and the next request reads afresh rather than joining a read that began before the write
 * (`TtlCache.invalidate` stops sharing the load in flight):
 *  - `campaign_changed` on the pacing invalidation bus: every write to the campaign row
 *    (lifecycle transitions, settings saves such as the disposition catalogue and the
 *    abandonment ceiling, both of which `stats()` reads, the automatic pauses);
 *  - `contacts_changed`: contacts arrived (each roster chunk), the owner sweeps moved some, an
 *    agent reopened some;
 *  - a supervisor's force-available, which calls {@link invalidateCampaignStatsReads} itself:
 *    no bus event carries it reliably (`agent_available` names no campaign when the agent has
 *    no station here, and it fires on every wrap-up end, far too often to drop a read on).
 * Everything else the payload counts (dials, outcomes, dispositions, agent state, a contact
 * edited on its own) moves without an event; the page polls for it, and an answer up to `ttlMs`
 * old is the trade. Home's board keeps a still campaign's stats for a minute under its floor's
 * signature, so it reads such a campaign past this (`home-board.ts`, `liveFor`): a shared read
 * could predate the signature it would be kept under.
 *
 * ── One cache per registration ────────────────────────────────────────────
 * Each `registerCampaignStatsRoutes` opens its own {@link CampaignStatsReads} and closes it with
 * its app. Production registers the route once (the core handlers), so there is one; every test
 * that builds an app starts empty, with nothing left over from the last. Writes that happen
 * outside the route's plugin reach every open one through {@link invalidateCampaignStatsReads}.
 */
import { TtlCache } from '@magick-agency/db/utils/ttl-cache';
import { agencyCampaignStatsReadsTotal } from '@magick-agency/observability/metrics/agency';
import { agencyCampaignRepository } from '../db/repositories/agency.repository.js';
import { getPacingInvalidationBus, type PacingInvalidationBus } from './pacing/invalidation-bus.js';

/** The two campaign-scoped reads behind one stats response. Shared: never mutate. */
export interface CampaignStatsRead {
  stats: Awaited<ReturnType<typeof agencyCampaignRepository.stats>>;
  health: Awaited<ReturnType<typeof agencyCampaignRepository.healthInputs>>;
}

/**
 * Campaigns held at once. Only a campaign someone looked at in the last `ttlMs` is worth
 * holding; 500 is far above the campaigns a process's supervisors watch inside a few seconds,
 * and bounds memory at 500 floors' worth of rows whatever is browsed.
 */
export const CAMPAIGN_STATS_READS_MAX_ENTRIES = 500;

const open = new Set<CampaignStatsReads>();

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
  private readonly unsubscribe: () => void;

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
      name: 'agency-campaign-stats',
    });
    this.unsubscribe = (opts.bus ?? getPacingInvalidationBus()).subscribe((event) => {
      if (event.type === 'campaign_changed' || event.type === 'contacts_changed') this.invalidate(event.campaignId);
    });
    open.add(this);
  }

  /**
   * The campaign's two reads: a settled one younger than `ttlMs`, the one in flight, or a new
   * one. Call it only for a campaign the caller has already been authorised for.
   */
  async read(campaignId: string): Promise<CampaignStatsRead> {
    let scanned = false;
    const read = await this.cache.getOrLoad(campaignId, () => {
      // Only the request whose loader runs reads the database; a joined or served request's
      // loader is never called.
      scanned = true;
      return readCampaign(campaignId);
    });
    agencyCampaignStatsReadsTotal.inc({ result: scanned ? 'scanned' : 'shared' });
    return read;
  }

  /** Drop the campaign's read: the next request reads afresh (see the module note). */
  invalidate(campaignId: string): void {
    this.cache.invalidate(campaignId);
  }

  /** Stop listening and hold nothing more. Idempotent. */
  close(): void {
    this.unsubscribe();
    this.cache.clear();
    open.delete(this);
  }
}

/**
 * Drop `campaignId`'s shared read in every open {@link CampaignStatsReads}, from a write path
 * outside the stats route (a supervisor's force-available). Total: never throws into the write.
 */
export function invalidateCampaignStatsReads(campaignId: string): void {
  for (const reads of open) reads.invalidate(campaignId);
}
