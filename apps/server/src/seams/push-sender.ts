/**
 * SEAM: agency (the inbound connector, the away-ring routes and reconcile) → platform (the push
 * senders: FCM HTTP v1 for Android, APNs VoIP for iOS) (decision B11: seams are fixed files;
 * docs/seams.md §3.6; Mode B, IQ58–IQ74).
 *
 * The platform area owns the carriers of a push: their credentials (config `PUSH_*` keys), the
 * OAuth and JWT signing, the HTTP calls, the error mapping and the metrics
 * (`notifications/push/`). What a push MEANS (when a phone rings, why it stops, which device) is
 * the agency area's, and it reaches the senders only through this interface. The platform
 * bootstrap registers the implementation at start and clears it at stop.
 *
 * Until it is registered, or when the deployment has no credentials for a platform, every send
 * answers `unconfigured` and `configured()` is false, so `away_ring` is refused
 * (`push_unavailable`) and nobody is rung. Implementations never throw for a send that fails:
 * they answer `{ ok: false, reason }` (`AgencyPushFailureReason`, the contract's list, which the
 * device row's `last_failure_reason` stores).
 */
import type { AgencyPushFailureReason, AgencyPushPlatform, AgencyRingPush } from '@magick-agency/contracts/agency';
import type { PushDeviceRecord } from '@magick-agency/db/models/push-device.model';

/** What a sender needs of a device: where to send (`pushTokenOf`), and its id for logs (never the token). */
export type PushSenderDevice = Pick<PushDeviceRecord, 'id' | 'platform' | 'fcm_token' | 'voip_token'>;

export interface PushSendOptions {
  /**
   * How long the carrier may hold the push for a phone that is offline: a ring is worthless once
   * its window has passed (FCM `ttl`, APNs `apns-expiration`).
   */
  ttlMs: number;
}

/**
 * Whose trouble a failed send is:
 *
 *  - `device`: this device's alone. The others can still be pushed to. `unregistered` and `invalid`
 *    (the carrier refused this token: gone, another sender's, malformed) are permanent, and the
 *    device is revoked ({@link pushFailureRevokes}); a `rate_limited` the sender answers for one
 *    device (its own Retry-After hold on that device, or an APNs 429, which is per token) passes;
 *  - `service`: the push service's, so every device would fail alike: `unavailable` (5xx, 401/403,
 *    a timeout, a network error, a message the service refused as malformed), `unconfigured`, and
 *    an FCM 429 (`QUOTA_EXCEEDED` names no scope: treated as the project's quota).
 */
export type PushFailureScope = 'device' | 'service';

export type PushSendResult =
  | { ok: true }
  | {
    ok: false;
    reason: AgencyPushFailureReason;
    /** Set by a sender that knows better than the reason's default ({@link pushFailureScope}). */
    scope?: PushFailureScope;
  };

/** The failures that revoke the device: the carrier refused its token for good. */
export function pushFailureRevokes(reason: AgencyPushFailureReason): boolean {
  return reason === 'unregistered' || reason === 'invalid';
}

/** Whose trouble a failed send is ({@link PushFailureScope}): the sender's `scope`, else the reason's. */
export function pushFailureScope(result: Extract<PushSendResult, { ok: false }>): PushFailureScope {
  if (result.scope) return result.scope;
  return pushFailureRevokes(result.reason) ? 'device' : 'service';
}

export interface PushSender {
  /**
   * Send `payload` (IQ61: never a name or a number) to `device`. Resolves once the carrier has
   * accepted or refused it; never throws. iOS is sent `ring` and `test_ring` only (a VoIP push must
   * be a call, and the test ring is one the phone shows); `ring_cancel` and `ring_off` answer
   * `{ ok: true }` unsent.
   */
  send(device: PushSenderDevice, payload: AgencyRingPush, opts: PushSendOptions): Promise<PushSendResult>;
  /** Whether this deployment can send to `platform` at all (its credentials are set). */
  configured(platform: AgencyPushPlatform): boolean;
}

const UNWIRED: PushSender = {
  async send() {
    return { ok: false, reason: 'unconfigured' };
  },
  configured() {
    return false;
  },
};

let sender: PushSender = UNWIRED;

export function setPushSender(next: PushSender | null): void {
  sender = next ?? UNWIRED;
}

export function getPushSender(): PushSender {
  return sender;
}

/** Tests only. */
export function resetPushSender(): void {
  sender = UNWIRED;
}
