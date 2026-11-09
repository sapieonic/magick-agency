import type { InboundCallerView } from './eligibility.js';

/**
 * ─── THE INBOUND QUEUE (docs/inbound.md §2 step 3, §5.1; P2) ───────────────────────────────
 *
 * The callers this process holds who have heard their preamble and wait for an agent, in memory
 * (one process, IB8: a restart ends every held call, and the startup sweep writes their
 * follow-ups). Per route, first in first out by when they first queued; a caller whose offer was
 * cancelled before audio bound (the station lost) goes back to the HEAD ({@link requeueHead}),
 * keeping its first `queued_at`, so its maximum wait still counts from then.
 *
 * An entry stays here from {@link admit} until {@link remove}, offered or not: an offered entry
 * (`offeredTo`) is not waiting, and is skipped by every read of the waiting callers. Its timers:
 *  - the route's maximum wait (`queue_max_wait_seconds` from `queued_at`): `onMaxWait`, once; the
 *    connector overflows a caller still waiting and, for one on offer, waits for the offer's end
 *    ({@link maxWaitLapsed});
 *  - the sticky wait (`loose` with a sticky agent: `sticky_wait_seconds` from `queued_at`):
 *    `onStickyLapse`, once; the connector searches again, now with the team.
 *
 * Limits (§5.1): `max_waiting` is the callers waiting on a route at once. {@link admit} answers
 * whether this caller is over it (`over_cap`); it is queued either way, so an agent free right now
 * still takes them, and the connector overflows them if none did.
 *
 * Timers come from `timers` (tests inject fake ones; `unref`ed in production).
 */

/** One caller in the queue. */
export interface InboundQueueEntry extends InboundCallerView {
  routeId: string;
  /** Epoch ms after which the caller has waited too long (`queued_at` + the route's maximum wait). */
  maxWaitAt: number;
}

interface Held {
  entry: InboundQueueEntry;
  /** The session it is offered to; null while waiting. */
  offeredTo: string | null;
  /** Requeued (its offer was cancelled): served before every caller that never was. */
  head: number;
  seq: number;
  maxWaitLapsed: boolean;
  timers: unknown[];
}

export interface InboundQueueTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const NODE_TIMERS: InboundQueueTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, Math.max(0, ms));
    t.unref?.();
    return t;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface InboundQueueOptions {
  now?: () => number;
  timers?: InboundQueueTimers;
  /** The caller has waited the route's maximum (once per entry). */
  onMaxWait?: (callId: string) => void;
  /** A `loose` caller's sticky wait is over: the team may take them now (once per entry). */
  onStickyLapse?: (callId: string) => void;
}

/** One route's queue, as the supervisor's tile reads it. */
export interface InboundQueueRouteSnapshot {
  routeId: string;
  tenantId: string;
  accountId: string;
  /** Callers waiting (not on offer). */
  waiting: number;
  /** Callers on offer to an agent (audio not bound yet). */
  offered: number;
  /** The longest current wait, whole seconds (from `queued_at`); 0 with nobody waiting. */
  longestWaitSeconds: number;
}

/** What `inbound_waiting` says for an account (`pacing/invalidation-bus.ts`). */
export interface InboundWaitingSummary {
  n: number;
  /** The waiting callers' sticky agents (user ids; the connector maps them to sessions). */
  stickyUserIds: string[];
  /** The campaigns the hold applies to; null: every campaign of the account. */
  poolCampaignIds: string[] | null;
}

export const accountKeyOfCall = (tenantId: string, accountId: string): string => `${tenantId}:${accountId}`;

export class InboundQueue {
  private readonly held = new Map<string, Held>();
  private seq = 0;
  private heads = 0;
  private readonly now: () => number;
  private readonly timers: InboundQueueTimers;

  constructor(private readonly opts: InboundQueueOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? NODE_TIMERS;
  }

  /** Callers waiting on `routeId` now (not on offer). */
  waitingOnRoute(routeId: string): number {
    let n = 0;
    for (const h of this.held.values()) if (h.entry.routeId === routeId && h.offeredTo === null) n++;
    return n;
  }

  /**
   * Queue a caller and arm its timers. `over_cap`: the route already had `maxWaiting` callers
   * waiting, so this one may stay only if an agent takes them at once. A caller already here is
   * left as it is (`queued`).
   */
  admit(entry: InboundQueueEntry, maxWaiting: number): 'queued' | 'over_cap' {
    if (this.held.has(entry.callId)) return 'queued';
    const over = this.waitingOnRoute(entry.routeId) >= maxWaiting;
    const h: Held = { entry, offeredTo: null, head: 0, seq: ++this.seq, maxWaitLapsed: false, timers: [] };
    this.held.set(entry.callId, h);
    const now = this.now();
    h.timers.push(this.timers.set(() => {
      if (this.held.get(entry.callId) !== h) return;
      h.maxWaitLapsed = true;
      this.opts.onMaxWait?.(entry.callId);
    }, entry.maxWaitAt - now));
    if (entry.stickyMode === 'loose' && entry.stickyUserId) {
      h.timers.push(this.timers.set(() => {
        if (this.held.get(entry.callId) === h) this.opts.onStickyLapse?.(entry.callId);
      }, entry.queuedAt + entry.stickyWaitMs - now));
    }
    return over ? 'over_cap' : 'queued';
  }

  has(callId: string): boolean {
    return this.held.has(callId);
  }

  get(callId: string): InboundQueueEntry | undefined {
    return this.held.get(callId)?.entry;
  }

  offeredTo(callId: string): string | null {
    return this.held.get(callId)?.offeredTo ?? null;
  }

  /** Whether the caller's maximum wait has passed (an offer in flight runs to its bind or its cancel). */
  maxWaitLapsed(callId: string): boolean {
    return this.held.get(callId)?.maxWaitLapsed ?? false;
  }

  /** Out of the queue for good (connected, overflowed, gone); its timers cleared. */
  remove(callId: string): InboundQueueEntry | undefined {
    const h = this.held.get(callId);
    if (!h) return undefined;
    for (const t of h.timers) this.timers.clear(t);
    this.held.delete(callId);
    return h.entry;
  }

  /** On offer to `sessionId`: no longer waiting. */
  markOffered(callId: string, sessionId: string): void {
    const h = this.held.get(callId);
    if (h) h.offeredTo = sessionId;
  }

  /** The offer was cancelled before audio bound: waiting again, at the head. False when not held. */
  requeueHead(callId: string): boolean {
    const h = this.held.get(callId);
    if (!h) return false;
    h.offeredTo = null;
    h.head = ++this.heads;
    return true;
  }

  /**
   * The waiting callers (not on offer), in service order: requeued callers first (the latest
   * requeue first, as each went back to the head), then by first queueing, then arrival. Of one
   * account (`tenantId:accountId`) when given.
   */
  waiting(accountKey?: string): InboundQueueEntry[] {
    return [...this.held.values()]
      .filter((h) => h.offeredTo === null && (accountKey === undefined || accountKeyOfCall(h.entry.tenantId, h.entry.accountId) === accountKey))
      .sort((a, b) => b.head - a.head || a.entry.queuedAt - b.entry.queuedAt || a.seq - b.seq)
      .map((h) => h.entry);
  }

  /** The accounts with at least one caller held (waiting or on offer). */
  accounts(): string[] {
    return [...new Set([...this.held.values()].map((h) => accountKeyOfCall(h.entry.tenantId, h.entry.accountId)))];
  }

  /**
   * What `inbound_waiting` says for `accountKey` (see {@link InboundWaitingSummary}). `n` leaves
   * out the callers `notTheTeams` names: those no team agent will be given (the connector decides:
   * a `strict` caller's sticky agent not away, a hand-over). Holding team agents back for them
   * would keep idle agents from dialling for callers they cannot take.
   */
  waitingSummary(accountKey: string, notTheTeams: (entry: InboundQueueEntry) => boolean = () => false): InboundWaitingSummary {
    return summarizeWaiting(this.waiting(accountKey), notTheTeams);
  }

  /** Every route with a caller held, for the supervisor's queue tile. */
  snapshot(): InboundQueueRouteSnapshot[] {
    const now = this.now();
    const byRoute = new Map<string, InboundQueueRouteSnapshot>();
    for (const h of this.held.values()) {
      const e = h.entry;
      let s = byRoute.get(e.routeId);
      if (!s) {
        s = { routeId: e.routeId, tenantId: e.tenantId, accountId: e.routeAccountId, waiting: 0, offered: 0, longestWaitSeconds: 0 };
        byRoute.set(e.routeId, s);
      }
      if (h.offeredTo !== null) {
        s.offered++;
        continue;
      }
      s.waiting++;
      s.longestWaitSeconds = Math.max(s.longestWaitSeconds, Math.max(0, Math.floor((now - e.queuedAt) / 1000)));
    }
    return [...byRoute.values()];
  }

  /** Every entry's timers cleared and the queue emptied (the connector's stop). */
  clear(): void {
    for (const id of [...this.held.keys()]) this.remove(id);
  }

  size(): number {
    return this.held.size;
  }
}

/**
 * {@link InboundQueue.waitingSummary} over `waiting`, an account's waiting callers as
 * {@link InboundQueue.waiting} answers them (the connector reads them once per publish).
 */
export function summarizeWaiting(
  waiting: readonly InboundQueueEntry[],
  notTheTeams: (entry: InboundQueueEntry) => boolean = () => false,
): InboundWaitingSummary {
  const sticky = new Set<string>();
  let pool: Set<string> | null = new Set<string>();
  let n = 0;
  for (const e of waiting) {
    if (e.stickyMode !== 'off' && e.stickyUserId) sticky.add(e.stickyUserId);
    if (!notTheTeams(e)) n++;
    const scoped = e.accountId === e.routeAccountId && e.poolCampaignIds.length > 0;
    if (!scoped) pool = null;
    else if (pool) for (const id of e.poolCampaignIds) pool.add(id);
  }
  return { n, stickyUserIds: [...sticky], poolCampaignIds: waiting.length === 0 ? [] : pool ? [...pool] : null };
}
