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
import { WEBRTC_MAX_DURATION_SECONDS } from '../../config/call-duration-limits.js';

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
/**
 * How often an insert may sweep the unstored-token memory for expired entries. Gated on
 * time, not size: the memory fills during a Redis outage, which is exactly when a scan on
 * every insert would sit on the dial path.
 */
export const UNSTORED_WS_TOKEN_SWEEP_MS = 10_000;
/**
 * How long a call's signed-callback nonces are remembered after its last callback
 * ({@link BridgeWsTokens.claimCallbackNonce}): past the longest a callback can still pass the
 * webhook token (the call, then WEBHOOK_TOKEN_POST_END_GRACE_SECONDS after it ends), so a
 * captured callback cannot be replayed while its token would still let it through. Every
 * callback re-arms it, but the call may run on after its last one (its answer) for as long
 * as an account's max duration allows, so the TTL is the longest any account's call may
 * last (`WEBRTC_MAX_DURATION_SECONDS`, 4 h) plus that grace.
 */
export const CALLBACK_NONCE_TTL_SECONDS = WEBHOOK_TOKEN_POST_END_GRACE_SECONDS + WEBRTC_MAX_DURATION_SECONDS;
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
  private lastUnstoredSweepAt = 0;

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
    // Bounded: prune expired entries, at most once per sweep interval (a sustained Redis
    // outage adds two entries per call, each dropped once its window passes).
    if (now - this.lastUnstoredSweepAt >= UNSTORED_WS_TOKEN_SWEEP_MS) {
      this.lastUnstoredSweepAt = now;
      for (const [key, expiresAt] of this.unstoredWsTokens) if (expiresAt <= now) this.unstoredWsTokens.delete(key);
    }
    const key = this.unstoredWsTokenKey(callId, purpose);
    // Re-noting a key moves it to the newest end (Map order is insertion order).
    this.unstoredWsTokens.delete(key);
    // ...and capped even when nothing has expired: one insert evicts at most the oldest.
    if (this.unstoredWsTokens.size >= UNSTORED_WS_TOKEN_CAP) {
      const oldest = this.unstoredWsTokens.keys().next();
      if (!oldest.done) this.unstoredWsTokens.delete(oldest.value);
      log.warn({ cap: UNSTORED_WS_TOKEN_CAP }, 'Unstored WebRTC token memory full — forgetting the oldest');
    }
    this.unstoredWsTokens.set(key, now + forMs);
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

  private callbackNonceKey(callId: string): string {
    return `${this.keyPrefix}webrtc:callback-nonces:${callId}`;
  }

  /**
   * Record a signed carrier callback's nonce for its call, once its signature verified:
   * true the first time, false for a nonce this call has already seen (a replay of a
   * captured callback, which the signature alone would accept for as long as the webhook
   * token lives). One Redis set per call (`SADD`, re-armed to
   * {@link CALLBACK_NONCE_TTL_SECONDS}), shared by every process, so a replay is refused
   * whichever worker it reaches. Fails OPEN: with no Redis, or Redis erroring, the callback
   * is accepted and logged, never a real callback refused over an outage.
   */
  async claimCallbackNonce(callId: string, nonce: string): Promise<boolean> {
    if (!this.redis) return true;
    const key = this.callbackNonceKey(callId);
    try {
      const result = await this.redis.multi().sadd(key, nonce).expire(key, CALLBACK_NONCE_TTL_SECONDS).exec();
      const added = result?.[0];
      if (!added || added[0]) throw added?.[0] ?? new Error('SADD answered nothing');
      return added[1] === 1;
    } catch (err) {
      log.warn({ err, callId }, 'Carrier callback nonce not recorded (Redis) — accepting the callback unchecked for replay');
      return true;
    }
  }

  /**
   * Forget a nonce whose callback could not be processed, so the carrier's retry of that
   * same request is not refused as a replay. Never throws.
   */
  async releaseCallbackNonce(callId: string, nonce: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.srem(this.callbackNonceKey(callId), nonce);
    } catch (err) {
      log.warn({ err, callId }, 'Carrier callback nonce not released (Redis) — a retry of it may be refused');
    }
  }

  private credentialNonceKey(credentialId: string, nonce: string): string {
    return `${this.keyPrefix}webrtc:credential-callback-nonce:${credentialId}:${nonce}`;
  }

  /**
   * The same replay guard for a callback that names no call of ours: the inbound Application's
   * credential-level URLs (docs/inbound.md §3.1), whose token is the credential's and does not
   * die with a call. One key per (credential, nonce), `SET NX` with
   * {@link CALLBACK_NONCE_TTL_SECONDS}: a set per credential would grow with every call the
   * number ever took. Past the TTL a replay is answered idempotently by the call it names (the
   * spine is unique on the carrier's call id). Fails OPEN on Redis, as the per-call guard.
   */
  async claimCredentialCallbackNonce(credentialId: string, nonce: string): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const set = await this.redis.set(this.credentialNonceKey(credentialId, nonce), '1', 'EX', CALLBACK_NONCE_TTL_SECONDS, 'NX');
      return set === 'OK';
    } catch (err) {
      log.warn({ err, credentialId }, 'Credential callback nonce not recorded (Redis) — accepting the callback unchecked for replay');
      return true;
    }
  }

  /** Forget a credential callback's nonce whose processing failed, so the carrier's retry is not a replay. Never throws. */
  async releaseCredentialCallbackNonce(credentialId: string, nonce: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(this.credentialNonceKey(credentialId, nonce));
    } catch (err) {
      log.warn({ err, credentialId }, 'Credential callback nonce not released (Redis) — a retry of it may be refused');
    }
  }

  async clearWsToken(callId: string): Promise<void> {
    // Q6: the media legs' tokens die with the call; the WEBHOOK token (and a remembered
    // unstored one) outlives it by the grace window, because the carrier's terminal report
    // and recording URL arrive after teardown and a missing key is refused.
    this.unstoredWsTokens.delete(this.unstoredWsTokenKey(callId, 'provider'));
    if (this.unstoredWsTokens.has(this.unstoredWsTokenKey(callId, 'webhook'))) {
      // Re-noted, so the re-armed window moves to the newest end of the eviction order.
      this.noteUnstoredWsToken(callId, 'webhook', WEBHOOK_TOKEN_POST_END_GRACE_SECONDS * 1000);
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
