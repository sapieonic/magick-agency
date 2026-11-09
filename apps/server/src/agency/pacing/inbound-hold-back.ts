/**
 * ─── PACING LEAVES ROOM FOR WAITING INBOUND CALLERS (docs/inbound.md §5.2, Q2; P2) ─────────
 *
 * The inbound connector publishes `inbound_waiting` (`invalidation-bus.ts`) for an account while
 * callers wait for its agents: `n` callers, the sessions they are sticky to, and the campaigns
 * the hold applies to (the routes' agent pools; null: every campaign of the account). The pacing
 * engine keeps the latest per account ({@link InboundHold}) and, on every tick of a campaign the
 * hold applies to, takes agents OUT OF ITS CANDIDATES before it reserves anyone:
 *
 *  1. the preferred sessions (a caller sticky to that agent waits for them: pacing must not put
 *     them on an outbound call first);
 *  2. then the `n` longest-idle candidates left (the ones the connector's search would offer the
 *     callers to: it orders the team longest idle first, as pacing does).
 *
 * It subtracts from the idle side, never from `limit − occupied`, which already counts the
 * waiting calls through the account's live total (IB5's third arm), Q2. The hold is per campaign,
 * so with several campaigns on the account it may hold back up to `n` agents on each: an
 * over-hold, accepted and bounded by `n` (Q2), and only while callers wait.
 *
 * It is a hint, never an authority: the reservation CAS decides (an inbound offer and a pacing
 * reservation both CAS from `available`; one wins). So the hold lapses at `expiresAt` unless
 * republished (the connector republishes every 2 s while callers wait, and once with `n = 0`).
 */

/** The latest `inbound_waiting` an engine heard for one account. */
export interface InboundHold {
  n: number;
  preferredSessionIds: ReadonlySet<string>;
  /** The campaigns it applies to; null: every campaign of the account. */
  poolCampaignIds: ReadonlySet<string> | null;
  /** Epoch ms: ignored from then on (the bus's backstop). */
  expiresAt: number;
}

/** Whether `hold` applies to `campaignId` at `now`. */
export function inboundHoldApplies(hold: InboundHold | undefined, campaignId: string, now: number): hold is InboundHold {
  if (!hold || now >= hold.expiresAt) return false;
  if (hold.n <= 0 && hold.preferredSessionIds.size === 0) return false;
  return hold.poolCampaignIds === null || hold.poolCampaignIds.has(campaignId);
}

/**
 * The candidates pacing may still reserve (see the header). `candidates` must already be in the
 * engine's order (longest idle first), which is kept. Pure.
 */
export function holdBackForInbound<T extends { sessionId: string }>(
  candidates: readonly T[],
  hold: InboundHold | undefined,
  campaignId: string,
  now: number,
): T[] {
  if (!inboundHoldApplies(hold, campaignId, now)) return [...candidates];
  const rest = candidates.filter((c) => !hold.preferredSessionIds.has(c.sessionId));
  return rest.slice(Math.min(Math.max(0, hold.n), rest.length));
}
