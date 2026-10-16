/**
 * The bridge's purpose-bound per-call credentials (the carrier's media-socket and
 * webhook tokens) in Redis, and the process-local memory of tokens whose SET
 * failed. Split out of `webrtc-bridge-manager.ts`, which keeps `verifyWsToken` as a
 * delegate (the webhook route and the PSTN leg call it there); its log lines keep
 * the manager's component name. No metrics are imported here (see the note in
 * `hangupProviderLeg`).
 */
import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';
import { WEBHOOK_TOKEN_POST_END_GRACE_SECONDS } from '../../telephony/webhook-grace.js';

const log = createChildLogger({ component: 'webrtc-bridge-manager' });

const WS_TOKEN_MIN_TTL_SECONDS = 120;
/** The per-call credentials the bridge mints: the carrier's media socket and its webhooks. */
export type WsTokenPurpose = 'provider' | 'webhook';
/**
 * Hard ceiling on the unstored-token memory (`unstoredWsTokens`). Expired entries
 * are pruned first; past this the oldest go, because a sustained Redis outage can
 * add entries faster than their windows close (each webhook entry outlives its call
 * by the post-end grace). The oldest are the windows nearest to ending.
 */
export const UNSTORED_WS_TOKEN_CAP = 10_000;
/*
 * WEBHOOK_TOKEN_POST_END_GRACE_SECONDS (`telephony/webhook-grace.ts`), Q6 (Manas,
 * 2026-10-09): how long a call's WEBHOOK token stays verifiable after the call ends. VoiceLink keeps posting to `/webrtc-status/:callId` after our teardown — the
 * carrier's own terminal report lands at dial+45–75s and carries the recording URL that
 * `persistLateVoicelinkTerminal` saves for playback and analysis (which waits up to
 * `DIALER_ANALYSIS_RECORDING_WAIT_MINUTES`, default 30). A missing key is refused, so the
 * token is kept for this window instead of being deleted at teardown (a 122-bit secret
 * held in Redis two more hours, not an open door). Two hours is four times the default recording
 * wait.
 *
 * DEPLOYMENT INVARIANT (Q6): Redis must keep these keys for their TTL — persistence on
 * (AOF/RDB) and an eviction policy that cannot drop them (`noeviction`, or a `volatile-*`
 * policy only if nothing else with a TTL competes for memory). A key lost early is now a
 * REFUSAL: an evicted provider/webhook token cuts a live call's carrier leg and status
 * events, and a Redis restarted without persistence refuses every in-flight call's posts.
 */

export class BridgeWsTokens {
  /**
   * Q6 (Manas, 2026-10-09): tokens this process MINTED but could not store (Redis errored
   * on the SET), keyed `${purpose}:${callId}` → expiry (epoch ms). `verifyWsToken` refuses a
   * missing key only when it knows the key should exist; for these it cannot, so it
   * accepts (never hard-fail a live call over an outage). Process-local, which is
   * enough: one replica and a bridged call does not survive a restart.
   */
  private readonly unstoredWsTokens = new Map<string, number>();

  constructor(
    private readonly redis: Redis | null,
    private readonly keyPrefix: string,
  ) {}

  // ── Purpose-bound per-call credentials ─────────────────────────────────────
  // Random nonces in Redis (replica-safe). Separate high-entropy tokens per purpose
  // keep the provider-WSS and webhook trust domains distinct; both live only in the
  // URLs we send VoiceLink. (Every leg is borrowed, so there is no browser token.)
  private wsTokenKey(callId: string, purpose: WsTokenPurpose): string {
    return `${this.keyPrefix}webrtc:ws-token:${purpose}:${callId}`;
  }

  async storeWsToken(
    callId: string,
    token: string,
    ttlSeconds: number,
    purpose: WsTokenPurpose,
  ): Promise<void> {
    if (!this.redis) return;
    const ttl = Math.max(WS_TOKEN_MIN_TTL_SECONDS, ttlSeconds);
    try {
      // TTL spans the whole call (cleared on end) so the token never expires
      // mid-call — keeping verifyWsToken a real comparison rather than the
      // degraded accept-on-missing-key fallback while the call is live.
      await this.redis.set(this.wsTokenKey(callId, purpose), token, 'EX', ttl);
    } catch (err) {
      log.warn({ err, callId, purpose }, 'Failed to store WebRTC WS token');
      // Q6: remember that this key will be missing for a reason that is not forgery, so the
      // live call keeps working (`verifyWsToken`). Held as long as the key would have lived
      // plus the post-end webhook grace.
      this.noteUnstoredWsToken(callId, purpose, (ttl + WEBHOOK_TOKEN_POST_END_GRACE_SECONDS) * 1000);
    }
  }

  private unstoredWsTokenKey(callId: string, purpose: WsTokenPurpose): string {
    return `${purpose}:${callId}`;
  }

  private noteUnstoredWsToken(callId: string, purpose: WsTokenPurpose, forMs: number): void {
    const now = Date.now();
    // Bounded: prune expired entries before growing (a sustained Redis outage adds two
    // entries per call, each dropped once its window passes).
    if (this.unstoredWsTokens.size >= 1000) {
      for (const [key, expiresAt] of this.unstoredWsTokens) if (expiresAt <= now) this.unstoredWsTokens.delete(key);
    }
    // ...and capped even when nothing has expired (Map order is insertion order).
    if (this.unstoredWsTokens.size >= UNSTORED_WS_TOKEN_CAP) {
      let evicted = 0;
      for (const key of this.unstoredWsTokens.keys()) {
        if (this.unstoredWsTokens.size < UNSTORED_WS_TOKEN_CAP) break;
        this.unstoredWsTokens.delete(key);
        evicted++;
      }
      log.warn({ evicted, cap: UNSTORED_WS_TOKEN_CAP }, 'Unstored WebRTC token memory full — forgetting the oldest');
    }
    this.unstoredWsTokens.set(this.unstoredWsTokenKey(callId, purpose), now + forMs);
  }

  private wasUnstored(callId: string, purpose: WsTokenPurpose): boolean {
    const key = this.unstoredWsTokenKey(callId, purpose);
    const expiresAt = this.unstoredWsTokens.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.unstoredWsTokens.delete(key);
      return false;
    }
    return true;
  }

  async verifyWsToken(
    callId: string,
    token: string | undefined,
    purpose: WsTokenPurpose,
  ): Promise<boolean> {
    // Q6 (Manas, 2026-10-09) — the middle option. A present-but-wrong token is refused, and
    // so is a missing key while Redis ANSWERS, because every token this bridge verifies is
    // minted and stored before the leg it guards can exist:
    //  - `provider` / `webhook`: stored in `placeOutboundLeg` (step 5) BEFORE the dial
    //    (step 6) that hands them to VoiceLink, for the whole call (maxDuration + 60s), and
    //    the webhook token is kept WEBHOOK_TOKEN_POST_END_GRACE_SECONDS past the end
    //    (`clearWsToken`) for the carrier's late terminal posts.
    // A key can still be missing legitimately when its SET failed (Redis errored at dial
    // time and recovered since): that is remembered in `unstoredWsTokens` and still
    // accepted. Redis absent or erroring here still accepts — never hard-fail a live call
    // on an outage; the unguessable callId is then the guard.
    if (!this.redis) return true; // degraded — unguessable callId is the guard
    try {
      const stored = await this.redis.get(this.wsTokenKey(callId, purpose));
      if (stored === null) {
        if (this.wasUnstored(callId, purpose)) {
          log.warn({ callId, purpose }, 'WebRTC WS token was never stored (Redis failed at mint) — allowing (degraded)');
          return true;
        }
        // Never minted, cleared at teardown, or past its post-end grace: there is no
        // credential this caller can match, so nothing is accepted on the call id alone.
        // Logged: a burst of these for LIVE calls means the keys vanished (eviction, a flushed
        // or non-persistent Redis), not forgery — see WEBHOOK_TOKEN_POST_END_GRACE_SECONDS.
        log.warn({ callId, purpose }, 'WebRTC WS token missing while Redis answered — rejecting');
        return false;
      }
      if (!token) return false;
      const a = Buffer.from(token);
      const b = Buffer.from(stored);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (err) {
      log.warn({ err, callId, purpose }, 'WebRTC WS token verify failed — allowing (degraded)');
      return true;
    }
  }

  async clearWsToken(callId: string): Promise<void> {
    // Q6: the media legs' tokens die with the call; the WEBHOOK token (and a remembered
    // unstored one) outlives it by the grace window, because the carrier's terminal report
    // and recording URL arrive after teardown and a missing key is refused.
    this.unstoredWsTokens.delete(this.unstoredWsTokenKey(callId, 'provider'));
    if (this.unstoredWsTokens.has(this.unstoredWsTokenKey(callId, 'webhook'))) {
      this.unstoredWsTokens.set(this.unstoredWsTokenKey(callId, 'webhook'), Date.now() + WEBHOOK_TOKEN_POST_END_GRACE_SECONDS * 1000);
    }
    if (!this.redis) return;
    try {
      await Promise.all([
        this.redis.del(this.wsTokenKey(callId, 'provider')),
        // Q6: kept for the post-end grace rather than deleted. `EXPIRE` on a missing key is
        // a no-op, so a call that never stored one gains nothing here.
        this.redis.expire(this.wsTokenKey(callId, 'webhook'), WEBHOOK_TOKEN_POST_END_GRACE_SECONDS),
      ]);
    } catch {
      /* TTLs out anyway */
    }
  }
}
