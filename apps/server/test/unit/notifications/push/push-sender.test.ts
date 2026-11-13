import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgencyRingPush } from '@magick-agency/contracts/agency';

// The routing sender (src/notifications/push/push-sender.ts; docs/seams.md §3.6): one sender per
// configured platform, `configured(platform)` true only for those, a send to another answers
// `unconfigured`; `createPushSender` builds it from the config block and the test transports. Run
// end to end against the mock carrier, so the real FCM and APNs code is on the path.

const metrics = vi.hoisted(() => ({ trackPushSend: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/platform', () => metrics);

import {
  RoutingPushSender, createPushSender, setPushTransportsForTests,
} from '../../../../src/notifications/push/push-sender.js';
import type { PlatformPushSender } from '../../../../src/notifications/push/common.js';
import type { PushSender } from '../../../../src/seams/push-sender.js';
import { MockPushCarrier } from '../../../mocks/push/index.js';

const RING: AgencyRingPush = {
  type: 'ring', call_id: 'call-1', offer_token: 'tok', ring_expires_at: '2026-11-12T10:00:20.000Z', session_id: 'sess-1',
};

let carrier: MockPushCarrier;
const opened: RoutingPushSender[] = [];
const track = <T extends RoutingPushSender | null>(s: T): T => { if (s) opened.push(s); return s; };

beforeAll(async () => { carrier = await MockPushCarrier.start(); });
afterAll(async () => { await carrier.stop(); });
beforeEach(() => { carrier.reset(); metrics.trackPushSend.mockReset(); });
afterEach(async () => {
  setPushTransportsForTests(null);
  await Promise.all(opened.splice(0).map((s) => s.close()));
});

describe('createPushSender', () => {
  it('is null when neither platform is configured (the seam stays unwired)', () => {
    expect(createPushSender({})).toBeNull();
  });

  it('both configured: each send goes to its platform\'s carrier, through the real senders', async () => {
    const sender: PushSender = track(carrier.sender());
    expect(sender.configured('android')).toBe(true);
    expect(sender.configured('ios')).toBe(true);
    const android = MockPushCarrier.device('android');
    const ios = MockPushCarrier.device('ios');
    expect(await sender.send(android, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(await sender.send(ios, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(carrier.sends.map((s) => [s.platform, s.token, s.authorized])).toEqual([
      ['android', android.fcm_token, true],
      ['ios', ios.voip_token, true],
    ]);
    expect(carrier.sends[0]!.android).toEqual({ priority: 'HIGH', ttl: '20s' });
    expect(carrier.oauthExchanges).toBe(1);
    expect(carrier.offHost).toEqual([]);
  });

  it('Android only: iOS is not configured and a send to it answers unconfigured, unsent and counted', async () => {
    const sender = track(carrier.sender({}, { fcm: carrier.config.fcm }));
    expect(sender.configured('android')).toBe(true);
    expect(sender.configured('ios')).toBe(false);
    expect(await sender.send(MockPushCarrier.device('ios', 'row-ios'), RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unconfigured' });
    expect(carrier.sends).toHaveLength(0);
    expect(carrier.apnsConnections).toBe(0);
    expect(metrics.trackPushSend).toHaveBeenCalledWith('ios', 'unconfigured', undefined);
  });

  it('iOS only: Android answers unconfigured', async () => {
    const sender = track(carrier.sender({}, { apns: carrier.config.apns }));
    expect(sender.configured('android')).toBe(false);
    expect(sender.configured('ios')).toBe(true);
    expect(await sender.send(MockPushCarrier.device('android'), RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unconfigured' });
    expect(carrier.oauthExchanges).toBe(0);
  });

  it('the transports installed with setPushTransportsForTests reach the senders it builds; none reach a host', async () => {
    carrier.install();
    const sender = track(createPushSender(carrier.config))!;
    expect(await sender.send(MockPushCarrier.device('android'), RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(await sender.send(MockPushCarrier.device('ios'), RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(carrier.sends).toHaveLength(2);
    carrier.uninstall();
  });

  it('the mock carrier refuses a credential it did not issue', async () => {
    const other = await MockPushCarrier.start();
    try {
      // Signed with `other`'s keys, sent to `carrier`.
      const sender = track(carrier.sender({}, other.config));
      expect(await sender.send(MockPushCarrier.device('android'), RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unavailable' });
      expect(await sender.send(MockPushCarrier.device('ios'), RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unavailable' });
      expect(carrier.sends.map((s) => [s.platform, s.authorized, s.status])).toEqual([['ios', false, 403]]);
    } finally {
      await other.stop();
    }
  });
});

describe('RoutingPushSender', () => {
  const stub = (platform: 'android' | 'ios', send: PlatformPushSender['send']): PlatformPushSender & { closed: boolean } => {
    const s = { platform, send, closed: false, async close() { s.closed = true; } };
    return s;
  };

  it('a platform sender that throws still answers: unavailable', async () => {
    const sender = new RoutingPushSender({ android: stub('android', async () => { throw new Error('boom'); }) });
    expect(await sender.send(MockPushCarrier.device('android'), RING, { ttlMs: 1 })).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('passes the device, payload and ttl through unchanged', async () => {
    const send = vi.fn(async () => ({ ok: true }) as const);
    const sender = new RoutingPushSender({ ios: stub('ios', send) });
    const device = MockPushCarrier.device('ios');
    await sender.send(device, RING, { ttlMs: 12_345 });
    expect(send).toHaveBeenCalledWith(device, RING, { ttlMs: 12_345 });
  });

  it('close() closes every platform sender, even when one fails', async () => {
    const android = stub('android', async () => ({ ok: true }));
    const ios = stub('ios', async () => ({ ok: true }));
    ios.close = async () => { ios.closed = true; throw new Error('close failed'); };
    await new RoutingPushSender({ android, ios }).close();
    expect(android.closed && ios.closed).toBe(true);
  });
});
