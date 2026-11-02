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
 * statement, the others await the same one) and the headroom it leaves is a
 * BUDGET the ticks draw from synchronously ({@link takeHeadroom}): a campaign that
 * plans k dials takes k, so the next campaign of the account plans against what is
 * left. That is stricter than per-tick reads, where two campaigns ticking together
 * each saw the other's dials missing from their count until its attempt rows were
 * inserted.
 *
 * The count is never older than this round, and only in the safe direction: a call
 * that ENDS after the read is missed until the next round (an under-dial for at
 * most one round), and a call this round's ticks START is in the budget. Calls
 * started outside pacing (a soft-phone dial) during the round race it exactly as
 * they raced a per-tick read. It is never carried across rounds.
 *
 * `fresh` marks a forced round (`tickOnce`): reads skip the engine's cross-round
 * caches (the campaign row, the account limit) and go to the database, as the
 * method has always done.
 */
export class PacingRound {
  private readonly limits = new Map<string, Promise<number>>();
  private readonly occupancy = new Map<string, Promise<number>>();
  private readonly taken = new Map<string, number>();

  constructor(readonly fresh: boolean) {}

  /** The account's limit for this round: loaded once, however many campaigns ask. */
  limit(accountKey: string, load: () => Promise<number>): Promise<number> {
    return memo(this.limits, accountKey, load);
  }

  /** The account's live calls at this round: loaded once, however many campaigns ask. */
  liveCalls(accountKey: string, load: () => Promise<number>): Promise<number> {
    return memo(this.occupancy, accountKey, load);
  }

  /**
   * How many new dials a campaign may place: `MAX(0, MIN(limit − live − taken, idle))`,
   * where `taken` is what the account's other campaigns already planned this round.
   * Synchronous, so no other tick can interleave between the read of the budget and
   * the draw on it. With one campaign on the account (`taken` 0) it is exactly the
   * per-tick law: `MAX(0, MIN(limit − live, idle))`.
   */
  takeHeadroom(accountKey: string, limit: number, live: number, idle: number): number {
    const taken = this.taken.get(accountKey) ?? 0;
    const toDial = Math.max(0, Math.min(limit - live - taken, idle));
    this.taken.set(accountKey, taken + toDial);
    return toDial;
  }
}

function memo(map: Map<string, Promise<number>>, key: string, load: () => Promise<number>): Promise<number> {
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
