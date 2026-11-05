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
 * read, the others await the same one).
 *
 * Three rules keep the account's new dials within `limit − live`:
 *
 *  - WITHIN a round, the split below: every grant of the round comes out of one
 *    headroom `H = MAX(0, limit − live)`, never more than `H` in total, and no grant
 *    of the round is made before the round's live read was issued (every report
 *    awaits it), so the read never already contains a grant of its own round.
 *  - ACROSS rounds, the engine's PENDING-DIAL LEDGER (`PacingEngine.pendingDials`,
 *    per account): a tick granted k dials inserts each attempt and then awaits the
 *    carrier before the next, so it can outlive its 250 ms round, and later rounds
 *    pass that campaign by while it is still ticking. Its granted dials not yet
 *    inserted as attempt rows are in no database count, so a sibling ticking alone
 *    would be granted the same headroom again. The engine therefore adds the ledger
 *    to the live read: the value the round memoises is `countLiveForAccount + the
 *    ledger`, the ledger snapshotted synchronously BEFORE the query is issued. A
 *    dial leaves the ledger when its attempt row is inserted (it is in the count from
 *    then on); whatever a tick will not insert (agents not reserved, contacts not
 *    claimed, gates, an abort, a throw) leaves it as soon as the tick knows, and at
 *    the latest when the tick ends. A tick's hold with no progress (its grant, or an
 *    attempt insert) for `PACING_DIAL_HOLD_MAX_MS` (60 s: a tick hung in the carrier)
 *    is left out of the read, with one warning, so it cannot hold its siblings down
 *    until a restart; its own end still releases it.
 *  - ONE OPEN SPLIT PER ACCOUNT. The ledger can only hold a grant once it is made, so
 *    a later round must not read the account while an earlier round's split of it can
 *    still grant. An account's split OPENS when its first participant joins and CLOSES
 *    when every participant has reported or withdrawn, or when the engine closes it at
 *    its deadline ({@link PacingRound.isOpen}, {@link PacingRound.close}). The share wait
 *    running out does NOT close it (rule 4 below). While it is open, the engine starts no tick for
 *    any campaign of that account in a later round; they are picked up by the first
 *    round after it closes. Once closed it grants nothing more. So when a later round
 *    reads the account, every grant of every earlier split is already in the ledger
 *    (each tick adds its grant right after `submit` resolves, in microtasks, before any
 *    timer can start a round). A forced tick (`tickOnce`, its own round) is exempt: it
 *    has no production caller.
 *
 * The count itself errs only in the safe direction. A row inserted between the ledger
 * snapshot and the query is counted twice (an under-dial of one for one round); a
 * call that ENDS after the read is missed until the next round (an under-dial for
 * at most one round). Calls started outside pacing (a soft-phone dial) during the
 * round race it exactly as they raced a per-tick read; the account concurrency
 * guard refuses the excess. The database count is never carried across rounds; the
 * ledger is what carries.
 *
 * ── Several running campaigns on one account: the split (decisions MC1, MC2) ──
 * An account may run several campaigns at once. The headroom the two reads leave,
 * `H = MAX(0, limit − live)`, is not handed out first come first served (that gave
 * it to whichever campaign's tick drew on it first); the round is the account's
 * ARBITER:
 *
 *  1. The engine registers every campaign it starts this round as a participant of
 *     its account ({@link PacingRound.join}) before any tick runs: the split waits for
 *     each one's report or withdrawal. One known not to dial (led only to drain, or its
 *     last full tick found it not running) joins as NOT CONTENDING: it is waited for
 *     (it withdraws at once when it is still not running) but does not count towards
 *     {@link PacingRound.contended} unless it reports, so a paused sibling woken by an
 *     account event leaves a lone running campaign uncontended (no extra reads, no
 *     slot gauges). One that does report after all (resumed since its last tick) is
 *     split with the others.
 *  2. Each tick states its demand (available agents with work, bounded under
 *     contention by the contacts actually due and by the engine's claim-shortfall
 *     cap) and its own live calls ({@link PacingRound.submit}), or drops out
 *     ({@link PacingRound.withdraw}, always, in `finally`).
 *  3. Once every participant of the account has reported or dropped out, the
 *     headroom is split by {@link splitHeadroom}: each slot to the participant with
 *     the FEWEST live calls (its own plus what it was granted so far) that can still
 *     use one; ties round-robin across rounds ({@link ShareRotation}).
 *  4. The wait starts at the account's FIRST report, not at the round's start: when
 *     {@link PACING_SHARE_WAIT_MS} passes with a participant still unreported, the split
 *     runs among those that reported, and they go on to dial, so one slow read does
 *     not hold its siblings' grants back. The split stays OPEN until the slow ones have
 *     reported or withdrawn.
 *  5. A LATE reporter, one that reports after the split ran but while it is still open,
 *     gets `MIN(demand, leftover)` at once: the leftover is the headroom the split did
 *     not grant, handed out first come first served among late reporters (not by
 *     fewest live calls), and decremented by each late grant, so never more than `H`
 *     in total. Nothing can grant it twice: no later round reads the account while the
 *     split is open. A slow campaign is therefore served from what its siblings left,
 *     every round, rather than starved.
 *  6. The engine closes a split still open {@link PACING_SPLIT_DEADLINE_MS} after it
 *     opened ({@link PacingRound.close}): if it has not run, those that reported are
 *     split. A report after the CLOSE gets 0 (`closed`); the engine marks that tick held
 *     back by the share (not quiescent), so it takes part in the next split. So a stuck
 *     member holds its account's other campaigns back for at most the deadline.
 *
 * With one participant on the account the grant is exactly the per-tick law,
 * `MAX(0, MIN(limit − live, idle))`, and the round adds no statement (the ledger is
 * in memory, and empty for a campaign alone on its account: its own previous tick
 * has ended before its next starts).
 *
 * No Redis state: on this single-replica deployment one engine leads every campaign
 * of an account. While two processes lead campaigns of one account (a leader
 * failover, or a deploy overlap; MC3), each splits the database's headroom among its
 * own campaigns with its own ledger and its own open splits, so live attempt ROWS can
 * exceed `max_concurrent_calls`. An old leader learns that it lost a lease only at its
 * next renewal, so the overlap lasts at least until then. Calls stay bounded by the
 * account concurrency guard, which refuses the excess. An account-level lease is an
 * open decision.
 *
 * `fresh` marks a forced round (`tickOnce`): reads skip the engine's cross-round
 * caches (the campaign row, the account limit) and go to the database, as the
 * method has always done. A forced tick is its round's only participant.
 */

/** How long the round waits for an account's slowest participant before splitting without it (MC2). */
export const PACING_SHARE_WAIT_MS = 1_000;

/**
 * The longest an account's split may stay open before the engine closes it (rules "one
 * open split per account" and 6 above), counted from its open: the bound on how long a
 * participant stuck before reporting holds back its account's other campaigns. The
 * engine uses the larger of this and its share wait.
 */
export const PACING_SPLIT_DEADLINE_MS = 5_000;

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
  if (claims.length === 1) {
    // What the loop below grants a lone claim, without the sort and the slot copies.
    const only = claims[0]!;
    return grants.set(only.id, Math.max(0, Math.min(Math.floor(headroom), Math.floor(only.demand))));
  }
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
    this.next.set(accountKey, n + 1);
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
  /**
   * New dials it may place this round. A report after the split RAN without it (MC2's wait
   * ran out first) while the split was still OPEN gets `MIN(demand, leftover)`, the leftover
   * being what the split did not grant, first come first served among such reports.
   */
  grant: number;
  /**
   * It reported after the split CLOSED (the engine's deadline closed it, or it joined only
   * at its report after the close): its grant is 0, and it takes part in a later split.
   */
  closed: boolean;
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
  /** The participants that count for {@link PacingRound.contended} (joined as dialling, or reported). */
  contenders: Set<string>;
  /** Joined, and neither reported nor withdrawn: the split waits for these. */
  pending: Set<string>;
  /** Reported, waiting for the split. */
  waiting: Map<string, Waiting>;
  /** `MAX(0, limit − live)`, from the first report (every tick reads the same memoised pair). */
  headroom: number | null;
  /** The split RAN (every member reported or withdrew, or the wait ran out). */
  split: boolean;
  /** What the split did not grant; a report after it, while open, draws on this. */
  leftover: number;
  /** The split is CLOSED: no member is pending, or it was closed: a later report gets 0. */
  closed: boolean;
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

  /**
   * Register `campaignId` as a participant of `accountKey`'s split, before its tick starts:
   * the split waits for its report or withdrawal. `contends: false` (a campaign whose last
   * tick found it not dialling) leaves it out of {@link contended} until it reports, so a
   * paused sibling does not make a lone running campaign contended. The account's first
   * join opens its split.
   */
  join(accountKey: string, campaignId: string, opts: { contends?: boolean } = {}): void {
    const previous = this.accountOf.get(campaignId);
    if (previous === accountKey) return;
    if (previous !== undefined) this.withdraw(campaignId);
    const share = this.share(accountKey);
    this.accountOf.set(campaignId, accountKey);
    if (opts.contends !== false) share.contenders.add(campaignId);
    if (!share.closed) share.pending.add(campaignId);
  }

  /**
   * Whether the account has two or more CONTENDING participants still in this round
   * (joined as dialling, or reported; not withdrawn): a tick then reads its own live calls
   * and bounds its demand by its due contacts. False for a lone participant, and so for a
   * forced round.
   */
  contended(accountKey: string): boolean {
    return (this.accounts.get(accountKey)?.contenders.size ?? 0) >= 2;
  }

  /**
   * Whether the account's split was opened in this round and has not closed: while it is,
   * the engine starts no tick for the account's campaigns in a later round.
   */
  isOpen(accountKey: string): boolean {
    const share = this.accounts.get(accountKey);
    return share !== undefined && !share.closed;
  }

  /**
   * Report a participant's demand and own live calls, and wait for its grant. `limit`
   * and `live` are the account's (the memoised reads above). Resolves when every
   * participant of the account has reported or withdrawn, or `shareWaitMs` after the
   * account's first report (the wait is armed by that report); at once for a lone
   * participant. Reporting after the split ran but while it is still open: at once,
   * `MIN(demand, leftover)`, first come first served. Reporting after it closed
   * (`closed`): at once, 0. A campaign that never joined (a forced tick) joins here.
   */
  submit(
    accountKey: string,
    campaignId: string,
    report: { demand: number; ownLive: number | null; limit: number; live: number },
  ): Promise<ShareGrant> {
    if (this.accountOf.get(campaignId) !== accountKey) this.join(accountKey, campaignId);
    const share = this.share(accountKey);
    share.pending.delete(campaignId);
    share.contenders.add(campaignId); // it states a demand: it dials after all
    if (share.headroom === null) share.headroom = Math.max(0, report.limit - report.live);
    const demand = Math.max(0, Math.floor(report.demand));

    if (share.closed) {
      // Closed (MC2): nothing now. A grant made after the close could reach the engine's
      // pending-dial ledger after a later round had read the account.
      return Promise.resolve({ grant: 0, closed: true });
    }
    if (share.split) {
      // Late but open (MC2): the split ran without it. No later round has read the account
      // (the split is open), so the leftover is still unspent. The tick adds this grant to
      // the ledger in the microtasks that follow, before any later round (a timer) can start,
      // even when this report is the one that closes the split.
      const grant = Math.min(demand, share.leftover);
      share.leftover -= grant;
      if (share.pending.size === 0) this.closeShare(share);
      return Promise.resolve({ grant, closed: false });
    }

    const promise = new Promise<ShareGrant>((resolve) => {
      share.waiting.set(campaignId, {
        claim: { id: campaignId, demand, ownLive: Math.max(0, report.ownLive ?? 0) },
        resolve,
      });
    });
    if (share.pending.size === 0) {
      this.runSplit(accountKey, share);
    } else if (!share.cancelTimer) {
      share.cancelTimer = this.schedule(() => {
        share.cancelTimer = null;
        this.runSplit(accountKey, share);
      }, this.shareWaitMs);
    }
    return promise;
  }

  /**
   * Drop out of the split: called for every tick that joined and did not report (an
   * early return, an error, a revoked lead), always in `finally`. A no-op once it
   * reported, and for a campaign that never joined. The last pending participant
   * dropping out runs the split for the others at once if it has not run, and closes it.
   */
  withdraw(campaignId: string): void {
    const accountKey = this.accountOf.get(campaignId);
    if (accountKey === undefined) return;
    const share = this.accounts.get(accountKey);
    if (!share || !share.pending.has(campaignId)) return; // reported, or left already
    share.pending.delete(campaignId);
    share.contenders.delete(campaignId);
    this.accountOf.delete(campaignId);
    if (share.pending.size > 0) return;
    if (!share.split) this.runSplit(accountKey, share); // closes it: nobody is pending
    else this.closeShare(share);
  }

  /**
   * Close the account's split now, if it is open: if it has not run, those that reported
   * are split as the wait running out would split them; any member still pending then
   * reports into a CLOSED split (grant 0). The engine's deadline.
   */
  close(accountKey: string): void {
    const share = this.accounts.get(accountKey);
    if (!share || share.closed) return;
    if (!share.split) this.runSplit(accountKey, share, true);
    else this.closeShare(share);
  }

  private share(accountKey: string): AccountShare {
    let share = this.accounts.get(accountKey);
    if (!share) {
      share = {
        contenders: new Set(), pending: new Set(), waiting: new Map(),
        headroom: null, split: false, leftover: 0, closed: false, cancelTimer: null,
      };
      this.accounts.set(accountKey, share);
    }
    return share;
  }

  /** Mark the split closed (once). */
  private closeShare(share: AccountShare): void {
    if (share.closed) return;
    share.closed = true;
    share.cancelTimer?.();
    share.cancelTimer = null;
  }

  /**
   * Split among those that reported (once). The split stays OPEN while a member is still
   * pending (the wait ran out first): a later report draws on the leftover. It closes here
   * when nobody is pending, or when `forceClose` (the engine's deadline).
   */
  private runSplit(accountKey: string, share: AccountShare, forceClose = false): void {
    if (share.split) return;
    share.split = true;
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
    // Closed before the grants resolve: their ticks put them in the engine's ledger in
    // microtasks after this, before anything can start a later split of the account.
    if (forceClose || share.pending.size === 0) this.closeShare(share);
    for (const w of waiting) w.resolve({ grant: grants.get(w.claim.id) ?? 0, closed: false });
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
