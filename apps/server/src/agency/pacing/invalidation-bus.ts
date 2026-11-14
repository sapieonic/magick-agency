/**
 * The pacing invalidation bus: how the places that change what a pacing tick reads
 * tell every pacing engine that its cached reads are stale and that a campaign is
 * worth a full tick again.
 *
 * ── Why a bus, and why these events ─────────────────────────────────────────
 * A leader ticks each campaign every 250 ms (`pacing-engine.ts`). Most of those
 * ticks, on a floor where every agent is on a call or the account is at its limit,
 * read four or five statements and reserve nothing. The engine skips such a tick
 * when nothing that could change its answer has happened since the last full one,
 * and it caches the campaign row, the account limit and the campaign's dedicated
 * caller IDs between full ticks (`dedicated-caller-ids.ts`). Both need to hear about
 * change, and each event below names one thing a tick reads:
 *
 * | Event                    | What changed                                | Published by |
 * |--------------------------|---------------------------------------------|--------------|
 * | `campaign_changed`       | the campaign row (status, caller IDs, window) | `AgencyCampaignRepository` writes |
 * | `account_limit_changed`  | the account's concurrency allocation        | the `ConcurrencyControl` seam's limit invalidations (`withPacingInvalidation`) |
 * | `account_capacity_freed` | a live call on the account ended            | the attempt and manual-call end writes |
 * | `agent_available`        | an agent entered `available`, or attached a station | `AgentStateMachine` (via the runtime), the station attach |
 * | `contacts_changed`       | contacts arrived on the campaign            | the CSV ingest's roster chunks |
 * | `station_ready`          | a station was sent `ready` on a `strict` / `preferred` campaign, so what it last heard of its queue is that frame's | the station attach |
| `dedications_changed`    | the campaign's effective dedicated caller IDs (DN1): one set, replaced or released, or an agent's staffing on it closed | `AgencyAgentCallerIdRepository.set` / `.clear`, `returnContactsOnUnstaff` (every unstaff path) |
 * | `inbound_waiting`        | how many inbound callers wait for the account's agents, and whom they want (docs/inbound.md §5.2) | the inbound connector (P2; no consumer yet) |
 * | `campaign_stats_stale`   | nothing pacing reads: a write the campaign's stats show (a forced return to available) | `POST /sessions/:id/force-available` |
 *
 * One consumer outside pacing: the supervisors' shared campaign stats read
 * (`agency/campaign-stats-reads.ts`) drops a campaign's read on `campaign_changed`,
 * `contacts_changed` and `campaign_stats_stale`, so the console's re-read after a supervisor's
 * own write is fresh. The bus is how a write served by a media worker reaches that read, which
 * lives on the primary (`pacing.invalidate` over IPC). Its backstop is its TTL
 * (`AGENCY_CAMPAIGN_STATS_CACHE_MS`).
 *
 * ── Serialisable on purpose ─────────────────────────────────────────────────
 * Events are plain JSON objects and carry ids only, never a row, a callback or a
 * class instance. The in-process implementation below round-trips every event
 * through `JSON.stringify` and {@link parsePacingInvalidationEvent} before it
 * delivers it, so the path every event takes today is the path a child-process IPC
 * implementation (several processes on one host, coordinated by a parent over
 * Node's `child_process` channel) will take. Such an implementation drops in with
 * {@link setPacingInvalidationBus} at boot; pacing does not change.
 *
 * ── What the bus is NOT ─────────────────────────────────────────────────────
 * It is a hint, never an authority. Delivery may be late or lost (a process that
 * dies between a write and its publish, an IPC channel that drops). Every consumer
 * therefore keeps a bounded backstop: the engine's caches have a short TTL and its
 * skip logic a periodic safety tick (`PACING_SAFETY_TICK_MS`), so a lost event
 * costs at most that bound and never correctness. Nothing may rely on an event to
 * PREVENT a dial; the claim, the reservation CAS and the bridge's guards do that.
 */
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'agency-pacing-bus' });

export type PacingInvalidationEvent =
  | { type: 'campaign_changed'; campaignId: string }
  | { type: 'account_limit_changed'; tenantId: string; accountId: string }
  | { type: 'account_capacity_freed'; tenantId: string; accountId: string }
  /** `campaignId` null when the publisher does not know it; consumers then resolve it or widen. */
  | { type: 'agent_available'; sessionId: string; campaignId: string | null }
  | { type: 'contacts_changed'; campaignId: string }
  /** For the shared campaign stats read only (`campaign-stats-reads.ts`); pacing ignores it. */
  | { type: 'campaign_stats_stale'; campaignId: string }
  /**
   * The engine forgets the last `queue` frame it sent this session (contact assignment, CA3):
   * the `ready` replaced it on the station, or cleared it when its queue read failed, so the
   * next tick sends the agent's queue again.
   */
  | { type: 'station_ready'; sessionId: string; campaignId: string }
  /**
   * The campaign's dedicated caller-ID map (`DedicatedCallerIdCache`) is stale. Wakes nothing:
   * a dedication changes which number a dial uses, never whether the campaign can dial.
   */
  | { type: 'dedications_changed'; campaignId: string }
  /**
   * Inbound callers wait for the account's agents (docs/inbound.md §5.2, P2): pacing should leave
   * them room. `n` callers are queued; `preferredSessionIds` are the sessions they are sticky to,
   * stations that can take inbound calls only (IQ46; pacing drops them from its candidates); the hold applies to the campaigns in
   * `poolCampaignIds` (null: every campaign of the account; the route's agent pool), and lapses
   * `ttlMs` after it arrives unless republished (a hint, never an authority: see the module note).
   * `n = 0` with no ids lifts it. Bounded by {@link parsePacingInvalidationEvent}.
   */
  | {
    type: 'inbound_waiting';
    tenantId: string;
    accountId: string;
    n: number;
    preferredSessionIds: string[];
    poolCampaignIds: string[] | null;
    ttlMs: number;
  };

export type PacingInvalidationEventType = PacingInvalidationEvent['type'];

export type PacingInvalidationHandler = (event: PacingInvalidationEvent) => void;

export interface PacingInvalidationBus {
  /** Fire and forget. Never throws into the publisher. */
  publish(event: PacingInvalidationEvent): void;
  /** Returns the unsubscribe. */
  subscribe(handler: PacingInvalidationHandler): () => void;
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;

/** Bounds of an `inbound_waiting` event, enforced by {@link parsePacingInvalidationEvent}. */
export const INBOUND_WAITING_LIMITS = Object.freeze({
  /** Callers counted; past it the event is malformed (a route's `max_waiting` is at most 100). */
  MAX_N: 500,
  /** Ids in `preferredSessionIds` and in `poolCampaignIds` each; more is malformed. */
  MAX_IDS: 100,
  /** `ttlMs` is clamped into this range: a hold never lasts less than a second or more than 30. */
  TTL_MS: Object.freeze({ min: 1_000, max: 30_000 }),
});

/** A list of at most `INBOUND_WAITING_LIMITS.MAX_IDS` ids, de-duplicated in order; null when malformed. */
function idList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > INBOUND_WAITING_LIMITS.MAX_IDS || !v.every(isId)) return null;
  return [...new Set(v as string[])];
}

function parseInboundWaiting(e: Record<string, unknown>): PacingInvalidationEvent | null {
  if (!isId(e['tenantId']) || !isId(e['accountId'])) return null;
  const n = e['n'];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > INBOUND_WAITING_LIMITS.MAX_N) return null;
  const preferredSessionIds = idList(e['preferredSessionIds']);
  if (!preferredSessionIds) return null;
  const rawPool = e['poolCampaignIds'];
  const poolCampaignIds = rawPool === null || rawPool === undefined ? null : idList(rawPool);
  if (rawPool !== null && rawPool !== undefined && !poolCampaignIds) return null;
  const ttl = e['ttlMs'];
  if (typeof ttl !== 'number' || !Number.isFinite(ttl)) return null;
  const { min, max } = INBOUND_WAITING_LIMITS.TTL_MS;
  return {
    type: 'inbound_waiting',
    tenantId: e['tenantId'],
    accountId: e['accountId'],
    n,
    preferredSessionIds,
    poolCampaignIds,
    ttlMs: Math.min(max, Math.max(min, Math.round(ttl))),
  };
}

/**
 * Decode one event from the wire, or null for anything malformed. Unknown types are
 * dropped rather than thrown on, so a newer publisher cannot crash an older
 * consumer during a rolling restart of the processes on one host.
 */
export function parsePacingInvalidationEvent(raw: unknown): PacingInvalidationEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  switch (e['type']) {
    case 'campaign_changed':
    case 'contacts_changed':
    case 'dedications_changed':
    case 'campaign_stats_stale':
      return isId(e['campaignId']) ? { type: e['type'], campaignId: e['campaignId'] } : null;
    case 'account_limit_changed':
    case 'account_capacity_freed':
      return isId(e['tenantId']) && isId(e['accountId'])
        ? { type: e['type'], tenantId: e['tenantId'], accountId: e['accountId'] }
        : null;
    case 'agent_available': {
      const campaignId = e['campaignId'];
      if (!isId(e['sessionId'])) return null;
      if (campaignId !== null && campaignId !== undefined && !isId(campaignId)) return null;
      return { type: 'agent_available', sessionId: e['sessionId'], campaignId: campaignId ?? null };
    }
    case 'station_ready':
      return isId(e['sessionId']) && isId(e['campaignId'])
        ? { type: 'station_ready', sessionId: e['sessionId'], campaignId: e['campaignId'] }
        : null;
    case 'inbound_waiting':
      return parseInboundWaiting(e);
    default:
      return null;
  }
}

/**
 * Every subscriber in this process, synchronously, in subscription order. A handler
 * that throws is logged and the rest still run: one broken consumer must not
 * silence the others, and a publish must never fail the write that caused it.
 */
export class InProcessPacingInvalidationBus implements PacingInvalidationBus {
  private readonly handlers = new Set<PacingInvalidationHandler>();

  publish(event: PacingInvalidationEvent): void {
    let decoded: PacingInvalidationEvent | null;
    try {
      // The wire format, exercised on every event: see the module note.
      decoded = parsePacingInvalidationEvent(JSON.parse(JSON.stringify(event)));
    } catch (err) {
      log.warn({ err }, 'Pacing invalidation event could not be serialised — dropped');
      return;
    }
    if (!decoded) {
      log.warn({ type: (event as { type?: unknown }).type }, 'Malformed pacing invalidation event — dropped');
      return;
    }
    for (const handler of [...this.handlers]) {
      try {
        handler(decoded);
      } catch (err) {
        log.error({ err, type: decoded.type }, 'Pacing invalidation handler threw');
      }
    }
  }

  subscribe(handler: PacingInvalidationHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  /** Subscribers right now (tests). */
  get subscriberCount(): number {
    return this.handlers.size;
  }
}

let bus: PacingInvalidationBus = new InProcessPacingInvalidationBus();

/** The process's bus. Publishers and the runtime's engine use this one. */
export function getPacingInvalidationBus(): PacingInvalidationBus {
  return bus;
}

/** Install another implementation (an IPC bus) at boot, before the runtime starts. */
export function setPacingInvalidationBus(next: PacingInvalidationBus): void {
  bus = next;
}

/** Tests only: a fresh in-process bus. */
export function resetPacingInvalidationBusForTests(): InProcessPacingInvalidationBus {
  const fresh = new InProcessPacingInvalidationBus();
  bus = fresh;
  return fresh;
}

/**
 * Publish on the process bus from a write path. Total: a bus fault is logged and
 * swallowed, because the write it follows has already happened and the consumers'
 * backstops cover a lost event.
 */
export function publishPacingInvalidation(event: PacingInvalidationEvent): void {
  try {
    bus.publish(event);
  } catch (err) {
    log.warn({ err, type: event.type }, 'Pacing invalidation publish failed — consumers fall back to their backstop');
  }
}
