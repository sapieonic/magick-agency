/**
 * The platform area's `PushSender` (`seams/push-sender.ts`, `docs/seams.md` §3.6): routes a send by
 * the device's platform to FCM (`fcm-sender.ts`, Android) or APNs (`apns-sender.ts`, iOS VoIP).
 * A platform whose `PUSH_*` keys are not set has no sender: `configured(platform)` is false and a
 * send to it answers `unconfigured`. `bootstrap/platform.ts` registers it when at least one
 * platform is configured and clears it at stop.
 *
 * The carriers' hosts are fixed. A test reaches a mock carrier (`test/mocks/push/`) through the
 * transports: passed to {@link createPushSender}, or installed for the senders the bootstrap builds
 * with {@link setPushTransportsForTests} (as `setPlivoTransportForTests`). No configuration can.
 */
import type { AgencyPushPlatform, AgencyRingPush } from '@magick-agency/contracts/agency';
import type { PushSendOptions, PushSendResult, PushSender, PushSenderDevice } from '../../seams/push-sender.js';
import type { ApnsCredentials, FcmCredentials } from './credentials.js';
import { FcmSender, type FcmTimers, type PushFetch } from './fcm-sender.js';
import { ApnsSender, type ApnsConnect } from './apns-sender.js';
import { settle, type PlatformPushSender } from './common.js';

/** The parsed `push` config block (`config.push`). */
export interface PushConfig {
  fcm?: FcmCredentials;
  apns?: ApnsCredentials;
}

export interface PushTransports {
  /** FCM's OAuth exchange and sends. */
  fetch?: PushFetch;
  /** APNs' HTTP/2 sessions. */
  apnsConnect?: ApnsConnect;
  /** Each request's bound (tests). */
  timeoutMs?: number;
  /** The clock the token caches read (tests). */
  now?: () => number;
  /** The timers FCM's background token refresh runs on (tests). */
  fcmTimers?: FcmTimers;
}

export class RoutingPushSender implements PushSender {
  readonly #senders: Partial<Record<AgencyPushPlatform, PlatformPushSender>>;

  constructor(senders: Partial<Record<AgencyPushPlatform, PlatformPushSender>>) {
    this.#senders = senders;
  }

  async send(device: PushSenderDevice, payload: AgencyRingPush, opts: PushSendOptions): Promise<PushSendResult> {
    const sender = this.#senders[device.platform];
    if (!sender) return settle(device.platform, device, payload, { result: { ok: false, reason: 'unconfigured' } });
    try {
      return await sender.send(device, payload, opts);
    } catch {
      // A platform sender never throws; should one, the seam still answers.
      return { ok: false, reason: 'unavailable' };
    }
  }

  configured(platform: AgencyPushPlatform): boolean {
    return this.#senders[platform] !== undefined;
  }

  /** Start each sender's background work (FCM: its access token traded now and kept fresh). Not awaited. */
  start(): void {
    for (const sender of Object.values(this.#senders)) sender.start?.();
  }

  async close(): Promise<void> {
    await Promise.all(Object.values(this.#senders).map((s) => s.close().catch(() => {})));
  }
}

let testTransports: PushTransports | null = null;

/**
 * Tests only: the senders {@link createPushSender} builds from now on use these transports (the
 * mock carrier's) instead of `fetch` and `http2.connect`; null restores them. The URLs and the
 * origins stay the fixed ones.
 */
export function setPushTransportsForTests(transports: PushTransports | null): void {
  testTransports = transports;
}

/** A sender for each configured platform; null when neither is. */
export function createPushSender(
  push: PushConfig,
  transports: PushTransports | null = testTransports,
): RoutingPushSender | null {
  if (!push.fcm && !push.apns) return null;
  const t = transports ?? {};
  const common = {
    ...(t.timeoutMs !== undefined ? { timeoutMs: t.timeoutMs } : {}),
    ...(t.now ? { now: t.now } : {}),
  };
  return new RoutingPushSender({
    ...(push.fcm ? {
      android: new FcmSender({
        credentials: push.fcm, ...common, ...(t.fetch ? { fetchImpl: t.fetch } : {}), ...(t.fcmTimers ? { timers: t.fcmTimers } : {}),
      }),
    } : {}),
    ...(push.apns ? { ios: new ApnsSender({ credentials: push.apns, ...common, ...(t.apnsConnect ? { connect: t.apnsConnect } : {}) }) } : {}),
  });
}
