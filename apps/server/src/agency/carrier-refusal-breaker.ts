import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';
import { classifyDialRefusal } from '../core/bridge/dial-refusals.js';

const log = createChildLogger({ component: 'agency-carrier-refusal-breaker' });

/**
 * ─── THE CARRIER REFUSAL BREAKER (PL11) ─────────────────────────────────────
 *
 * Some refusals are about the carrier ACCOUNT rather than the contact, but no single one says
 * so: a destination the account is not enabled for (a 403, PL1), an account out of credit, a
 * caller ID the carrier rejects, a webhook base left unset. Each fails dial after dial, and
 * each carrier refusal is charged to the contact it was dialled for. So a campaign pinned to a
 * tenant credential counts its refusals in a row, and after
 * {@link CARRIER_REFUSAL_BREAKER_THRESHOLD} with no call placed in between the dialer pauses it
 * `carrier_refusing_calls` (`carrier-account-pause.ts`). Any placed call (the carrier answered
 * the create-call 2xx) resets the count.
 *
 * What counts ({@link countsTowardBreaker}): the carrier refusing a dial (`telephony_init_failed`
 * whose outcome is known: any status but 401 and 429), and a dial the adapter would not send
 * for the carrier's configuration (`carrier_dial_not_sent`, reason `configuration`). Not a 401
 * or an inactive credential (paused on the first one already), a rate limit (back-pressure),
 * an unknown outcome (the call may be placed), a malformed contact number (the contact's), the
 * API unreachable (the network's), an admission refusal or a bridge failure.
 *
 * The count is in Redis per campaign (`INCR` + `EXPIRE`, shared by every process that dials
 * it), with a TTL so an old streak does not combine with a refusal hours later. On a Redis
 * error it falls back to a count in this process, so a refusal streak still pauses the
 * campaign (later, if the dials are spread over processes) and a Redis fault never fails a
 * dial. A pause clears the count, so a resumed campaign starts afresh.
 */
export const CARRIER_REFUSAL_BREAKER_THRESHOLD = 5;

/** How long a refusal streak is remembered with no further refusal. */
export const CARRIER_REFUSAL_BREAKER_TTL_SECONDS = 15 * 60;

/**
 * Whether a dial's rejection counts toward the breaker (see the module note), read off the
 * bridge's rejection by `classifyDialRefusal`.
 */
export function countsTowardBreaker(err: unknown): boolean {
  const refusal = classifyDialRefusal(err);
  if (refusal.kind === 'carrier_refused') return !refusal.outcomeUnknown;
  if (refusal.kind === 'not_sent') return refusal.reason === 'configuration';
  return false;
}

export class CarrierRefusalBreaker {
  /** campaignId → the in-process count, used while Redis errors. */
  private readonly local = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly redis: Redis | null,
    private readonly keyPrefix: string,
    private readonly opts: { threshold?: number; ttlSeconds?: number; now?: () => number } = {},
  ) {}

  private get threshold(): number { return this.opts.threshold ?? CARRIER_REFUSAL_BREAKER_THRESHOLD; }
  private get ttlSeconds(): number { return this.opts.ttlSeconds ?? CARRIER_REFUSAL_BREAKER_TTL_SECONDS; }
  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }

  private key(campaignId: string): string {
    return `${this.keyPrefix}agency:carrier-refusals:${campaignId}`;
  }

  /**
   * Count one refusal for the campaign. True when the streak has reached the threshold: the
   * caller pauses the campaign (and the count is cleared here). Never throws.
   */
  async noteRefusal(campaignId: string): Promise<boolean> {
    let count: number;
    try {
      if (!this.redis) throw new Error('no Redis');
      const key = this.key(campaignId);
      const result = await this.redis.multi().incr(key).expire(key, this.ttlSeconds).exec();
      const incr = result?.[0];
      if (!incr || incr[0] || typeof incr[1] !== 'number') throw incr?.[0] ?? new Error('INCR answered nothing');
      count = incr[1];
    } catch (err) {
      if (this.redis) log.warn({ err, campaignId }, 'Carrier refusal count not written to Redis — counting in this process');
      count = this.noteLocally(campaignId);
    }
    if (count < this.threshold) return false;
    await this.clear(campaignId);
    return true;
  }

  /** A call was placed on the campaign: the streak is broken. Never throws. */
  async notePlaced(campaignId: string): Promise<void> {
    await this.clear(campaignId);
  }

  private noteLocally(campaignId: string): number {
    const now = this.now();
    const current = this.local.get(campaignId);
    const count = current && current.expiresAt > now ? current.count + 1 : 1;
    this.local.set(campaignId, { count, expiresAt: now + this.ttlSeconds * 1000 });
    return count;
  }

  private async clear(campaignId: string): Promise<void> {
    this.local.delete(campaignId);
    if (!this.redis) return;
    try {
      await this.redis.del(this.key(campaignId));
    } catch (err) {
      log.warn({ err, campaignId }, 'Carrier refusal count not cleared in Redis — it lapses with its TTL');
    }
  }
}
