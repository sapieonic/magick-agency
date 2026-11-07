/**
 * The campaign's dedicated caller IDs (decisions DN1–DN4) as every dial path reads them: one
 * cached map per campaign, and {@link DedicatedCallerIdCache.callerIdForContact}, the one way a
 * dial to a campaign contact gets its number. The rule itself is `resolveCallerId`
 * (`caller-id-pool.ts`, pure); this module only feeds it the map.
 *
 * ── Who reads it ─────────────────────────────────────────────────────────────
 *  - Pacing reads the map ONCE per dialling batch, BEFORE it reserves an agent or claims a
 *    contact ({@link DedicatedCallerIdCache.read}), and applies `resolveCallerId` per contact
 *    itself (each contact its own owner, and the round-robin offset moves with the batch).
 *  - The agent's own call (`my-contact-call.ts`) and the wrap-up redial (`wrapup-redial.ts`) ask
 *    {@link DedicatedCallerIdCache.callerIdForContact} for one contact.
 *  - The soft phone tagged to a campaign reads the map ({@link DedicatedCallerIdCache.read}) and
 *    hands it to its pure `selectCallerId` (`softphone/manual-predial.ts`), which applies the
 *    same rule with the requested number as the sticky and refuses a number outside the set.
 *  A new dial path takes this object as a dependency (the runtime's `dedications`); calling
 *  `pickCallerId` over the campaign's numbers would skip the dedications.
 *
 * ── The cache: the pacing engine's mechanism, driven by the engine ──────────
 * A {@link GenerationTtlCache} keyed by campaign id, with the same TTL as the campaign row and
 * the account limit ({@link PACING_CACHE_TTL_MS}). The pacing engine that holds it (one per
 * runtime) drives it exactly as it drives those two:
 *  - {@link arm} when it subscribes to the invalidation bus, {@link disarm} when it unsubscribes
 *    (it leads nothing, or stops): both drop every entry, because what was cached while nothing
 *    listened cannot be trusted;
 *  - {@link invalidate} on `dedications_changed`, which every write that changes the effective
 *    map publishes after its commit: the PUT and the DELETE (`AgencyAgentCallerIdRepository.set`
 *    / `.clear`) and every unstaff (`returnContactsOnUnstaff`, which all three staffing-close
 *    paths call: a dedication stops counting when its staffing row closes,
 *    `EFFECTIVE_DEDICATION_SQL`). Nothing else changes the map: a re-staffing never revives an
 *    older row (DN1), the campaign PATCH cannot drop a dedicated number (DN6) and the map does
 *    not depend on `caller_ids` anyway (each dial path filters by the campaign's dialable caller
 *    IDs, `dialableCallerIds`, which a number sync, retire or unassign clears, PL13), and
 *    a user delete's cascade has no route (a raw delete is covered by the TTL).
 *  - The generation guard keeps a load that an invalidation overtook from being stored: a
 *    dial uses a released dedication only if its read started before the release committed,
 *    as it would with no cache. A PUT's number is in use within the bus's delivery, and within
 *    the TTL if its event is lost.
 *
 * **Unarmed, it reads through.** A media worker (`docs/scaling.md`) runs the agent's own call,
 * the redial and the soft phone, but no pacing, and its bus (`IpcPacingInvalidationBus`)
 * delivers nothing to the worker: events only travel worker → primary. Its runtime's engine never
 * leads, so its cache is never armed, and every read there is the database's. In a single
 * process the engine arms it while it leads a campaign, and those paths share pacing's cache.
 * Forced pacing ticks (`tickOnce`) read through too (`fresh`), as they do for the row and limit.
 */
import { agencyAgentCallerIdRepository } from '../../db/repositories/agency.repository.js';
import { dialableCallerIds, type DialabilityCampaign } from '../campaign-dialability.js';
import { resolveCallerId, type DedicatedCallerIds } from './caller-id-pool.js';
import { GenerationTtlCache, PACING_CACHE_TTL_MS } from './read-cache.js';

export type DedicatedCallerIdLoader = (campaignId: string) => Promise<DedicatedCallerIds>;

/** The database read: `AgencyAgentCallerIdRepository.mapForCampaign`, the effective dedications. */
const loadFromDatabase: DedicatedCallerIdLoader = (campaignId) => agencyAgentCallerIdRepository.mapForCampaign(campaignId);

export class DedicatedCallerIdCache {
  private readonly cache: GenerationTtlCache<DedicatedCallerIds>;
  private armed = false;

  constructor(
    ttlMs: number = PACING_CACHE_TTL_MS,
    now: () => number = Date.now,
    private readonly load: DedicatedCallerIdLoader = loadFromDatabase,
  ) {
    this.cache = new GenerationTtlCache(ttlMs, now);
  }

  /** Serve from the cache: its owner now hears `dedications_changed`. Starts empty. */
  arm(): void {
    this.cache.clear();
    this.armed = true;
  }

  /** Read through again: its owner no longer hears the events. Drops every entry. */
  disarm(): void {
    this.armed = false;
    this.cache.clear();
  }

  /** `dedications_changed`: the next read of the campaign goes to the database. */
  invalidate(campaignId: string): void {
    this.cache.invalidate(campaignId);
  }

  /** Whether reads are served from the cache (tests). */
  get isArmed(): boolean {
    return this.armed;
  }

  /**
   * Agent user id → effective dedicated number on the campaign. Cached while armed (a load an
   * invalidation overtook is returned, never stored); `fresh` reads through and still stores.
   * A failed read rejects and stores nothing: the caller decides (pacing dials nothing, the
   * agent's paths answer an error).
   */
  read(campaignId: string, opts: { fresh?: boolean } = {}): Promise<DedicatedCallerIds> {
    if (!this.armed) return this.load(campaignId);
    return this.cache.getOrLoad(campaignId, () => this.load(campaignId), opts);
  }

  /**
   * THE caller ID one dial to a contact of `campaign` goes out from (DN2 over PL13): the contact
   * owner's (`ownerUserId`, the contact's `assigned_user_id`) dedicated number while it is one of
   * the campaign's DIALABLE caller IDs, else `sticky` while it is in the rotation, else the
   * rotation's pick (`resolveCallerId` over `dialableCallerIds`). The pool is the dialable one:
   * on a campaign pinned to a tenant's own carrier account (PL13), only the stored numbers still
   * active on it, so a dedicated number the account no longer has falls back to the rotation; on
   * the service's own account, `usableCallerIds` with no read. Null only when the pool is empty.
   * Rejects when the map or the pool cannot be read.
   */
  async callerIdForContact(
    campaign: DialabilityCampaign,
    ownerUserId: string | null | undefined,
    opts: { sticky?: string | null } = {},
  ): Promise<string | null> {
    const [dedicated, usable] = await Promise.all([this.read(campaign.id), dialableCallerIds(campaign)]);
    return resolveCallerId({
      usable,
      dedicated,
      ownerUserId,
      offset: 0,
      sticky: opts.sticky ?? null,
    });
  }
}
