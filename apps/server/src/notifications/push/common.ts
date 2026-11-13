/**
 * What the two push senders (`fcm-sender.ts`, `apns-sender.ts`) share: the per-platform sender
 * interface the routing sender composes, the data payload's string form, the `Retry-After` gate,
 * and the one place a send is counted and logged.
 *
 * Logs name the device row id, the push type and the call id, never a push token, an offer token,
 * an access token or the payload.
 */
import { logger } from '@magick-agency/observability';
import { trackPushSend, type PushSendMetricResult } from '@magick-agency/observability/metrics/platform';
import type { AgencyPushPlatform, AgencyRingPush } from '@magick-agency/contracts/agency';
import type { PushFailureScope, PushSendOptions, PushSendResult, PushSenderDevice } from '../../seams/push-sender.js';

/** Each carrier request (the OAuth exchange, a send) is bounded by this: a ring window is 20 s. */
export const PUSH_REQUEST_TIMEOUT_MS = 5_000;

/**
 * One platform's sender. `send` never throws; `start` (optional, at boot) begins its background
 * work, never awaited; `close` stops it and releases its connections (at stop).
 */
export interface PlatformPushSender {
  readonly platform: AgencyPushPlatform;
  send(device: PushSenderDevice, payload: AgencyRingPush, opts: PushSendOptions): Promise<PushSendResult>;
  start?(): void;
  close(): Promise<void>;
}

/** The payload's fields as strings (FCM `data` takes strings only), unset ones left out. */
export function pushData(payload: AgencyRingPush): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

/** With no `Retry-After`, a 429 holds the device back this long. */
export const DEFAULT_RETRY_AFTER_MS = 10_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** A `Retry-After` header (seconds, or an HTTP date) in ms from `now`, clamped to [1 s, 1 h]. */
export function parseRetryAfter(header: string | null | undefined, now: number): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const trimmed = header.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const at = Date.parse(trimmed);
    ms = Number.isNaN(at) ? DEFAULT_RETRY_AFTER_MS : at - now;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, ms));
}

/**
 * The carrier asked us to slow down: until its `Retry-After` has passed, a send it holds back
 * answers `rate_limited` without a request. Nothing is retried inside a ring (its window is shorter
 * than any sensible back-off); the agency side treats it as a failed send.
 *
 * A hold is kept as wide as whose trouble the 429 that set it was (`PushFailureScope`), and a held
 * send answers with that scope: an APNs 429 is per token (`device`: that device alone is held), an
 * FCM 429 the project's quota (`service`: every send of this sender, so of its platform, is held),
 * so a service hold pauses ringing rather than marking a phone as one this caller never rings again,
 * and costs no request per phone while it lasts.
 */
export class RetryAfterGate {
  readonly #devices = new Map<string, number>();
  /** Epoch ms until which every send is held (a `service` 429); 0: none. */
  #serviceUntil = 0;

  constructor(private readonly now: () => number) {}

  /** The scope of the hold on a send to `deviceId` while it lasts; null when there is none. */
  blocked(deviceId: string): PushFailureScope | null {
    const now = this.now();
    if (now < this.#serviceUntil) return 'service';
    const until = this.#devices.get(deviceId);
    if (until === undefined) return null;
    if (now < until) return 'device';
    this.#devices.delete(deviceId);
    return null;
  }

  /** Hold `deviceId` back for `ms` (`device`), or every send (`service`). */
  hold(deviceId: string, ms: number, scope: PushFailureScope): void {
    const now = this.now();
    if (scope === 'service') {
      this.#serviceUntil = now + ms;
      return;
    }
    if (this.#devices.size >= 10_000) {
      for (const [id, until] of this.#devices) if (until <= now) this.#devices.delete(id);
    }
    this.#devices.set(deviceId, now + ms);
  }
}

/** What a send ended as, and what the log line may say about it. */
export interface SendOutcome {
  result: PushSendResult;
  /** Not sent by design (iOS and a non-call push). */
  skipped?: boolean;
  /** The carrier's HTTP status, when it answered. */
  status?: number;
  /** The carrier's error code (FCM `errorCode`/`status`, APNs `reason`), or ours (`timeout`, `network`, `no_token`, ...). */
  code?: string;
  /** Set when the send reached for the carrier: seconds from the start of the send. */
  seconds?: number;
}

/** Count the send, log a failure, and answer the seam's result. */
export function settle(
  platform: AgencyPushPlatform,
  device: PushSenderDevice,
  payload: AgencyRingPush,
  outcome: SendOutcome,
): PushSendResult {
  const metric: PushSendMetricResult = outcome.result.ok ? (outcome.skipped ? 'skipped' : 'ok') : outcome.result.reason;
  trackPushSend(platform, metric, outcome.seconds);
  if (!outcome.result.ok) {
    logger.warn({
      platform,
      push_device_id: device.id,
      push_type: payload.type,
      call_id: payload.call_id,
      reason: outcome.result.reason,
      carrier_status: outcome.status,
      carrier_code: outcome.code,
    }, 'Push send failed');
  }
  return outcome.result;
}
