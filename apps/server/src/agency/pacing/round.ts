/**
 * One pacing ROUND: the ticks the engine starts together every `TICK_INTERVAL_MS`,
 * and the per-account work they share.
 *
 * ── What is shared, and why it cannot over-dial ─────────────────────────────
 * Every campaign of one account is capped by the same `max_concurrent_calls`
 * against the same live-call count (`countLiveForAccount`: the account's live
 * attempts plus its live soft-phone calls). Read per tick, N campaigns on an
 * account read the same two numbers N times a round. Here each is read ONCE per
 * account per round (a memoised promise: the first tick that needs it issues the
 * statement, the others await the same one).
 *
 * The count is never older than this round, and only in the safe direction: a call
 * that ENDS after the read is missed until the next round (an under-dial for at
 * most one round), and a call this round's ticks START is in the split below. Calls
 * started outside pacing (a soft-phone dial) during the round race it exactly as
 * they raced a per-tick read. It is never carried across rounds.
 *
 * ── Several running campaigns on one account: the split (decisions MC1, MC2) ──
 * An account may run several campaigns at once. The headroom the two reads leave,
 * `H = MAX(0, limit − live)`, is not handed out first come first served (that gave
 * it to whichever campaign's tick drew on it first); the round is the account's
 * ARBITER:
 *
 *  1. The engine registers every campaign it starts this round as a participant of
 *     its account ({@link PacingRound.join}) before any tick runs.
 *  2. Each tick states its demand (available agents with work, bounded under
 *     contention by the contacts actually due) and its own live calls
 *     ({@link PacingRound.submit}), or drops out ({@link PacingRound.withdraw},
 *     always, in `finally`).
 *  3. Once every participant of the account has reported or dropped out, the
 *     headroom is split by {@link splitHeadroom}: each slot to the participant with
 *     the FEWEST live calls (its own plus what it was granted so far) that can still
 *     use one; ties round-robin across rounds ({@link ShareRotation}).
 *  4. One that has not reported within {@link PACING_SHARE_WAIT_MS} of the first
 *     report is left out of the split, so one stuck read cannot freeze the account;
 *     if it reports later it gets what the split left over, capped by its demand.
 *     Never more than `H` in total.
 *
 * With one participant on the account the grant is exactly the per-tick law,
 * `MAX(0, MIN(limit − live, idle))`, and the round adds no statement.
 *
 * No Redis state: on this single-replica deployment one engine leads every campaign
 * of an account. During a leader failover two engines may each split only among
 * their own campaigns (MC3); the ceiling still holds, because each reads the
 * database's live count and the account concurrency guard refuses the excess.
 *
 * `fresh` marks a forced round (`tickOnce`): reads skip the engine's cross-round
 * caches (the campaign row, the account limit) and go to the database, as the
 * method has always done. A forced tick is its round's only participant.
 */

/** How long the round waits for an account's slowest participant before splitting without it (MC2). */
export const PACING_SHARE_WAIT_MS = 1_000;

/** What one participant asks of its account's headroom. */
export interface ShareClaim {
  /** The campaign. */
  id: string;
  /** How many new dials it could place now (≥ 0). */
  demand: number;
  /** Its own live calls as this round saw them (0 when not read: a lone participant). */
  ownLive: number;
}

/**
 * MC1's allocation, as a pure function: `headroom` slots, one at a time, each to the
 * claim with the fewest `ownLive + granted` that still has `demand − granted > 0`.
 * Ties go to the claim that comes first in `claims` sorted by id and rotated left by
 * `rotation` (so a rotation that advances each round takes turns). Never grants more
 * than `headroom` in total, nor more than a claim's demand; negative or fractional
 * inputs are floored at 0. With one claim the grant is `MAX(0, MIN(headroom, demand))`.
 * Every claim has an entry in the result (0 when it got nothing).
 */
export function splitHeadroom(headroom: number, claims: readonly ShareClaim[], rotation = 0): Map<string, number> {
  const grants = new Map<string, number>();
  if (claims.length === 0) return grants;
  const sorted = [...claims].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const start = ((Math.trunc(rotation) % sorted.length) + sorted.length) % sorted.length;
  const slots = [...sorted.slice(start), ...sorted.slice(0, start)].map((c) => ({
    id: c.id,
    demand: Math.max(0, Math.floor(c.demand)),
    load: Math.max(0, Math.floor(c.ownLive)),
    granted: 0,
  }));
  let left = Math.max(0, Math.floor(headroom));
  while (left > 0) {
    let best: (typeof slots)[number] | null = null;
    for (const s of slots) {
      if (s.granted >= s.demand) continue;
      // Strictly fewer: on a tie the first in rotated order keeps it.
      if (!best || s.load + s.granted < best.load + best.granted) best = s;
    }
    if (!best) break; // nobody can use another slot: the rest stays unused this round
    best.granted++;
    left--;
  }
  for (const s of slots) grants.set(s.id, s.granted);
  return grants;
}

/**
 * Where each account's tie-break starts, advanced once per split between two or more
 * campaigns, so equal campaigns take turns at the odd slot across rounds (MC1). Kept by
 * the engine (a round lives 250 ms), which {@link forget}s an account once it leads
 * none of its campaigns.
 */
export class ShareRotation {
  private readonly next = new Map<string, number>();

  /** The offset for this split; advances the account's counter. */
  take(accountKey: string): number {
    const n = this.next.get(accountKey) ?? 0;
    this.next.set(accountKey, n >= Number.MAX_SAFE_INTEGER - 1 ? 0 : n + 1);
    return n;
  }

  forget(accountKey: string): void {
    this.next.delete(accountKey);
  }

  /** Accounts with a counter (tests). */
  get size(): number {
    return this.next.size;
  }
}

/** What a participant was granted. */
export interface ShareGrant {
  /** New dials it may place this round. */
  grant: number;
  /** The account's headroom this round, `MAX(0, limit − live)`. */
  headroom: number;
  /** It reported after the split (MC2's wait ran out), and got the leftover. */
  late: boolean;
}

/** Round tunables. Production uses the defaults; tests shorten them. */
export interface PacingRoundOptions {
  /** {@link PACING_SHARE_WAIT_MS}. */
  shareWaitMs?: number;
  /** The engine's tie-break counters. Default: the round's own (no rotation across rounds). */
  rotation?: ShareRotation;
  /**
   * Run `fn` after `ms`, returning a cancel. Default: an `unref`'d `setTimeout`, so a
   * waiting round never keeps the process alive (and fake timers drive it in tests).
   */
  schedule?: (fn: () => void, ms: number) => () => void;
}

interface Waiting {
  claim: ShareClaim;
  resolve: (grant: ShareGrant) => void;
}

/** One account's arbiter, for one round. */
interface AccountShare {
  /** Joined (or reported) and not withdrawn. */
  members: Set<string>;
  /** Joined, and neither reported nor withdrawn: the split waits for these. */
  pending: Set<string>;
  /** Reported, waiting for the split. */
  waiting: Map<string, Waiting>;
  /** `MAX(0, limit − live)`, from the first report (every tick reads the same memoised pair). */
  headroom: number | null;
  /** The split ran; a later report draws on {@link leftover}. */
  settled: boolean;
  leftover: number;
  cancelTimer: (() => void) | null;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
}

export class PacingRound {
  private readonly limits = new Map<string, Promise<number>>();
  private readonly occupancy = new Map<string, Promise<number>>();
  private readonly ownOccupancy = new Map<string, Promise<Map<string, number>>>();
  private readonly accounts = new Map<string, AccountShare>();
  /** Each participant's account, so {@link withdraw} needs only the campaign. */
  private readonly accountOf = new Map<string, string>();
  private readonly shareWaitMs: number;
  private readonly rotation: ShareRotation;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(readonly fresh: boolean, options: PacingRoundOptions = {}) {
    this.shareWaitMs = options.shareWaitMs ?? PACING_SHARE_WAIT_MS;
    this.rotation = options.rotation ?? new ShareRotation();
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /** The account's limit for this round: loaded once, however many campaigns ask. */
  limit(accountKey: string, load: () => Promise<number>): Promise<number> {
    return memo(this.limits, accountKey, load);
  }

  /** The account's live calls at this round: loaded once, however many campaigns ask. */
  liveCalls(accountKey: string, load: () => Promise<number>): Promise<number> {
    return memo(this.occupancy, accountKey, load);
  }

  /**
   * The account's live attempts per campaign at this round: loaded once, however many
   * campaigns ask. Read only when the account is {@link contended}: a lone participant
   * needs no share, and issues exactly the statements it always has.
   */
  liveByCampaign(accountKey: string, load: () => Promise<Map<string, number>>): Promise<Map<string, number>> {
    return memo(this.ownOccupancy, accountKey, load);
  }

  /** Register `campaignId` as a participant of `accountKey`'s split, before its tick starts. */
  join(accountKey: string, campaignId: string): void {
    const previous = this.accountOf.get(campaignId);
    if (previous === accountKey) return;
    if (previous !== undefined) this.withdraw(campaignId);
    const share = this.share(accountKey);
    this.accountOf.set(campaignId, accountKey);
    share.members.add(campaignId);
    if (!share.settled) share.pending.add(campaignId);
  }

  /**
   * Whether the account has two or more participants still in this round (joined or
   * reported, not withdrawn): a tick then reads its own live calls and bounds its demand
   * by its due contacts. False for a lone participant, and so for a forced round.
   */
  contended(accountKey: string): boolean {
    return (this.accounts.get(accountKey)?.members.size ?? 0) >= 2;
  }

  /** How many participants the account has in this round (tests). */
  participants(accountKey: string): number {
    return this.accounts.get(accountKey)?.members.size ?? 0;
  }

  /**
   * Report a participant's demand and own live calls, and wait for its grant. `limit`
   * and `live` are the account's (the memoised reads above). Resolves when every
   * participant of the account has reported or withdrawn, or `shareWaitMs` after the
   * first report; at once for a lone participant, and for one reporting after the split
   * (the leftover). A campaign that never joined (a forced tick) joins here.
   */
  submit(
    accountKey: string,
    campaignId: string,
    report: { demand: number; ownLive: number | null; limit: number; live: number },
  ): Promise<ShareGrant> {
    if (this.accountOf.get(campaignId) !== accountKey) this.join(accountKey, campaignId);
    const share = this.share(accountKey);
    share.pending.delete(campaignId);
    if (share.headroom === null) share.headroom = Math.max(0, report.limit - report.live);
    const headroom = share.headroom;
    const demand = Math.max(0, Math.floor(report.demand));

    if (share.settled) {
      // Late (MC2): the split ran without it. The leftover, capped by its demand.
      const grant = Math.min(demand, share.leftover);
      share.leftover -= grant;
      return Promise.resolve({ grant, headroom, late: true });
    }

    const promise = new Promise<ShareGrant>((resolve) => {
      share.waiting.set(campaignId, {
        claim: { id: campaignId, demand, ownLive: Math.max(0, report.ownLive ?? 0) },
        resolve,
      });
    });
    if (share.pending.size === 0) {
      this.settle(accountKey, share);
    } else if (!share.cancelTimer) {
      share.cancelTimer = this.schedule(() => {
        share.cancelTimer = null;
        this.settle(accountKey, share);
      }, this.shareWaitMs);
    }
    return promise;
  }

  /**
   * Drop out of the split: called for every tick that joined and did not report (an
   * early return, an error, a revoked lead), always in `finally`. A no-op once it
   * reported, and for a campaign that never joined. The last pending participant
   * dropping out lets the split run for the others at once.
   */
  withdraw(campaignId: string): void {
    const accountKey = this.accountOf.get(campaignId);
    if (accountKey === undefined) return;
    const share = this.accounts.get(accountKey);
    if (!share || !share.pending.has(campaignId)) return; // reported, or left already
    share.pending.delete(campaignId);
    share.members.delete(campaignId);
    this.accountOf.delete(campaignId);
    if (share.pending.size === 0 && share.waiting.size > 0) this.settle(accountKey, share);
  }

  private share(accountKey: string): AccountShare {
    let share = this.accounts.get(accountKey);
    if (!share) {
      share = {
        members: new Set(), pending: new Set(), waiting: new Map(),
        headroom: null, settled: false, leftover: 0, cancelTimer: null,
      };
      this.accounts.set(accountKey, share);
    }
    return share;
  }

  /** Split among those that reported; any still pending (the wait ran out) report late. */
  private settle(accountKey: string, share: AccountShare): void {
    if (share.settled) return;
    share.settled = true;
    share.cancelTimer?.();
    share.cancelTimer = null;
    const headroom = share.headroom ?? 0;
    const waiting = [...share.waiting.values()];
    share.waiting.clear();
    // The rotation advances only when there are two campaigns to break a tie between.
    const rotation = waiting.length >= 2 ? this.rotation.take(accountKey) : 0;
    const grants = splitHeadroom(headroom, waiting.map((w) => w.claim), rotation);
    let granted = 0;
    for (const g of grants.values()) granted += g;
    share.leftover = Math.max(0, headroom - granted);
    for (const w of waiting) w.resolve({ grant: grants.get(w.claim.id) ?? 0, headroom, late: false });
  }
}

function memo<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = map.get(key);
  if (!p) {
    p = load();
    map.set(key, p);
  }
  return p;
}

export function accountKeyOf(tenantId: string, accountId: string): string {
  return `${tenantId}:${accountId}`;
}
