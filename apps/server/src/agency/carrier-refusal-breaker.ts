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
 * What counts ({@link countsTowardBreaker}): the carrier refusing a dial with a 4xx
 * (`telephony_init_failed` whose outcome is known and whose adapter error carries a 4xx
 * status, 401 and 429 excepted: they have their own codes), and a dial the adapter would not
 * send for the carrier's configuration (`carrier_dial_not_sent`, reason `configuration`). Not
 * a 5xx (a fault on the carrier's platform: an outage there would otherwise pause every
 * campaign on every tenant's account with it), a refusal that carries no status, a 401 or an
 * inactive credential (paused on the first one already), a rate limit (back-pressure), an
 * unknown outcome (the call may be placed), a malformed contact number (the contact's), the
 * API unreachable (the network's), an admission refusal or a bridge failure.
 *
 * The count is in Redis per campaign (`INCR` + `EXPIRE`, shared by every process that dials
 * it), with a TTL so an old streak does not combine with a refusal hours later. On a Redis
 * error it falls back to a count in this process, so a refusal streak still pauses the
 * campaign (later, if the dials are spread over processes) and a Redis fault never fails a
 * dial. A pause clears the count, so a resumed campaign starts afresh.
 *
 * ── A placed call's reset, and who counts a campaign ─────────────────────────
 *
 * The dials of one campaign run where its agents' stations are: in one process (the default,
 * `MEDIA_WORKERS=0`), or spread over the media workers that own them (`docs/scaling.md`:
 * pacing decides in the primary, `dial.execute` runs `AgencyDialer` in the worker holding
 * the agent's station). Where ONE process dials every campaign ({@link CarrierRefusalBreakerOptions.soleCounter}),
 * it saw every refusal, so it remembers per campaign whether a streak may be open (a refusal
 * since its last clear; and, until its first clear, a streak left in Redis by the process
 * before a restart) and a placed call with none sends nothing. With media workers each one
 * counts the refusals of its own agents' dials into the shared key and cannot know of another
 * worker's, so every placed call clears it (one `DEL`, off the dial path): skipping it there
 * would let refusals on one worker survive calls placed on another.
 *
 * ── The API streak: an account that logs in but cannot dial (CR4) ────────────
 *
 * A tenant VoiceLink account's login is the only verdict on its credential, so an `add_lead`
 * still 401 after a successful fresh re-login marks nothing and pauses nothing on its own
 * (another process's login may have retired the token). An account whose API access was
 * withdrawn fails EVERY dial that way, though, so the breaker keeps a second streak per
 * campaign for it ({@link RefusalStreak} `api`, the bridge's `carrier_api_refused`), with a
 * higher threshold ({@link CARRIER_API_REFUSAL_BREAKER_THRESHOLD}): a token race explains one
 * or two in a row, never ten with no call placed between. It trips the same pause
 * (`carrier_refusing_calls`, its audit row's `cause` naming the API streak).
 *
 * Two counters, not one weighted one: each refusal counts in exactly one streak
 * ({@link refusalStreakOf}), so PL11 keeps its count and its threshold exactly, and neither kind
 * is ever counted twice. A streak that mixes the two kinds trips when either count reaches its
 * own threshold (a weighted sum would trip a mix sooner, but would change PL11's rule for every
 * carrier for a case one carrier's accounts can hit). Both streaks share everything else: the
 * TTL, the Redis fallback, and the clear: a placed call or a trip clears both (one `DEL` of
 * both keys).
 */
export const CARRIER_REFUSAL_BREAKER_THRESHOLD = 5;

/**
 * Dials in a row refused `carrier_api_refused` (the carrier took the login and refused the dial
 * request with 401) with no call placed between, before the campaign is paused. Higher than
 * {@link CARRIER_REFUSAL_BREAKER_THRESHOLD}: a single such refusal can be a token another
 * process's login retired. A constant, not configurable, as PL11's is.
 */
export const CARRIER_API_REFUSAL_BREAKER_THRESHOLD = 10;

/**
 * Which streak a refusal counts in: `account` (PL11: a 4xx refusal, a dial not sent for the
 * carrier's configuration) or `api` (the carrier refused the dial request after taking the
 * login, CR4).
 */
export type RefusalStreak = 'account' | 'api';

const STREAKS: readonly RefusalStreak[] = ['account', 'api'];

/** How long a refusal streak is remembered with no further refusal. */
export const CARRIER_REFUSAL_BREAKER_TTL_SECONDS = 15 * 60;

/**
 * The streak a dial's rejection counts in (see the module note), or null when it counts in
 * neither; read off the bridge's rejection by `classifyDialRefusal`. One streak at most, so no
 * refusal is counted twice.
 */
export function refusalStreakOf(err: unknown): RefusalStreak | null {
  const refusal = classifyDialRefusal(err);
  if (refusal.kind === 'carrier_api_refused') return 'api';
  if (refusal.kind === 'carrier_refused') {
    return !refusal.outcomeUnknown && refusal.httpStatus !== null && refusal.httpStatus >= 400 && refusal.httpStatus < 500
      ? 'account' : null;
  }
  if (refusal.kind === 'not_sent') return refusal.reason === 'configuration' ? 'account' : null;
  return null;
}

/** Whether a dial's rejection counts toward PL11's streak (`account`, {@link refusalStreakOf}). */
export function countsTowardBreaker(err: unknown): boolean {
  return refusalStreakOf(err) === 'account';
}

export interface CarrierRefusalBreakerOptions {
  /** PL11's threshold (the `account` streak). */
  threshold?: number;
  /** The `api` streak's threshold. */
  apiThreshold?: number;
  ttlSeconds?: number;
  now?: () => number;
  /**
   * True when this process places every dial of every campaign it counts (one process, no
   * media workers): a placed call clears the streak only when a refusal may have opened one
   * since this process last cleared it (see the module note). False (the default) clears on
   * every placed call.
   */
  soleCounter?: boolean;
}

export class CarrierRefusalBreaker {
  /** `streak:campaignId` → the in-process count, used while Redis errors. */
  private readonly local = new Map<string, { count: number; expiresAt: number }>();
  /** campaignId → refusals noted here (a counter only ever raised), for {@link clearedAt}. */
  private readonly refusalsNoted = new Map<string, number>();
  /**
   * campaignId → the {@link refusalsNoted} value when this process last cleared the streak.
   * Equal: no refusal since, so no streak can be open (with {@link CarrierRefusalBreakerOptions.soleCounter}).
   * Absent: never cleared here, so one left from before this process started may be.
   */
  private readonly clearedAt = new Map<string, number>();

  constructor(
    private readonly redis: Redis | null,
    private readonly keyPrefix: string,
    private readonly opts: CarrierRefusalBreakerOptions = {},
  ) {}

  private threshold(streak: RefusalStreak): number {
    return streak === 'api'
      ? this.opts.apiThreshold ?? CARRIER_API_REFUSAL_BREAKER_THRESHOLD
      : this.opts.threshold ?? CARRIER_REFUSAL_BREAKER_THRESHOLD;
  }
  private get ttlSeconds(): number { return this.opts.ttlSeconds ?? CARRIER_REFUSAL_BREAKER_TTL_SECONDS; }
  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }

  /** PL11's key is unchanged (`agency:carrier-refusals:`), so a streak a running server left survives a deploy. */
  private key(campaignId: string, streak: RefusalStreak): string {
    return `${this.keyPrefix}agency:${streak === 'api' ? 'carrier-api-refusals' : 'carrier-refusals'}:${campaignId}`;
  }

  /**
   * Count one refusal for the campaign in `streak` (PL11's `account` by default). True when
   * that streak has reached its threshold: the caller pauses the campaign (and both streaks
   * are cleared here). Never throws.
   */
  async noteRefusal(campaignId: string, streak: RefusalStreak = 'account'): Promise<boolean> {
    // Raised before anything is awaited, so a placed call's clear in flight is not taken as
    // having covered this refusal.
    const noted = (this.refusalsNoted.get(campaignId) ?? 0) + 1;
    this.refusalsNoted.set(campaignId, noted);
    let count: number;
    try {
      if (!this.redis) throw new Error('no Redis');
      const key = this.key(campaignId, streak);
      const result = await this.redis.multi().incr(key).expire(key, this.ttlSeconds).exec();
      const incr = result?.[0];
      if (!incr || incr[0] || typeof incr[1] !== 'number') throw incr?.[0] ?? new Error('INCR answered nothing');
      count = incr[1];
    } catch (err) {
      if (this.redis) log.warn({ err, campaignId, streak }, 'Carrier refusal count not written to Redis — counting in this process');
      count = this.noteLocally(`${streak}:${campaignId}`);
    }
    if (count < this.threshold(streak)) return false;
    await this.clearNoting(campaignId, noted);
    return true;
  }

  /**
   * A call was placed on the campaign: both streaks are broken. Never throws. As the sole
   * counter, nothing is sent while no refusal has been noted since the last clear.
   */
  async notePlaced(campaignId: string): Promise<void> {
    const noted = this.refusalsNoted.get(campaignId) ?? 0;
    if (this.opts.soleCounter && this.clearedAt.get(campaignId) === noted) return;
    await this.clearNoting(campaignId, noted);
  }

  /** Clear the streak, and remember it cleared up to refusal `noted` once the clear took. */
  private async clearNoting(campaignId: string, noted: number): Promise<void> {
    if (await this.clear(campaignId)) this.clearedAt.set(campaignId, noted);
  }

  private noteLocally(localKey: string): number {
    const now = this.now();
    const current = this.local.get(localKey);
    const count = current && current.expiresAt > now ? current.count + 1 : 1;
    this.local.set(localKey, { count, expiresAt: now + this.ttlSeconds * 1000 });
    return count;
  }

  /** True when both streaks are cleared (nothing in Redis to clear, or the `DEL` answered). */
  private async clear(campaignId: string): Promise<boolean> {
    for (const streak of STREAKS) this.local.delete(`${streak}:${campaignId}`);
    if (!this.redis) return true;
    try {
      await this.redis.del(...STREAKS.map((streak) => this.key(campaignId, streak)));
      return true;
    } catch (err) {
      log.warn({ err, campaignId }, 'Carrier refusal count not cleared in Redis — it lapses with its TTL');
      return false;
    }
  }
}
