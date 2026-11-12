import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AgencyPushFailureReason, AgencyPushPlatform, AgencyRingPush } from '@magick-agency/contracts/agency';
import {
  getPushSender,
  resetPushSender,
  setPushSender,
  type PushSendOptions,
  type PushSendResult,
  type PushSender,
  type PushSenderDevice,
} from '../../../src/seams/push-sender.js';

// The agency → platform push seam (docs/seams.md §3.6; Mode B, IQ58–IQ74). Pins the interface
// both sides build against (WP1 implements it, WP2 and WP5 call it) and the unwired default:
// nothing registered answers `unconfigured` and is not configured for any platform, so nobody is
// rung and `away_ring` is refused `push_unavailable`.

const DEVICE: PushSenderDevice = { id: 'dev-row-1', platform: 'android', fcm_token: 'fcm-1', voip_token: null };
const RING: AgencyRingPush = {
  type: 'ring', call_id: 'call-1', offer_token: 'tok', ring_expires_at: '2026-11-12T10:00:20.000Z', session_id: 'sess-1',
};

afterEach(resetPushSender);

describe('the push-sender seam', () => {
  it('pins the interface: send(device, payload, { ttlMs }) → ok or a contract failure reason; configured(platform)', () => {
    expectTypeOf<PushSender['send']>().parameters.toEqualTypeOf<[PushSenderDevice, AgencyRingPush, PushSendOptions]>();
    expectTypeOf<PushSender['send']>().returns.toEqualTypeOf<Promise<PushSendResult>>();
    expectTypeOf<PushSender['configured']>().parameters.toEqualTypeOf<[AgencyPushPlatform]>();
    expectTypeOf<PushSender['configured']>().returns.toEqualTypeOf<boolean>();
    expectTypeOf<PushSendOptions>().toEqualTypeOf<{ ttlMs: number }>();
    expectTypeOf<PushSendResult>().toEqualTypeOf<{ ok: true } | { ok: false; reason: AgencyPushFailureReason }>();
    expectTypeOf<AgencyPushFailureReason>().toEqualTypeOf<'unregistered' | 'invalid' | 'rate_limited' | 'unavailable' | 'unconfigured'>();
    // A sender reads only where to send and the row id; never the agent or the tenant.
    expectTypeOf<keyof PushSenderDevice>().toEqualTypeOf<'id' | 'platform' | 'fcm_token' | 'voip_token'>();
  });

  it('unwired: every send answers unconfigured and no platform is configured', async () => {
    const unwired = getPushSender();
    expect(await unwired.send(DEVICE, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unconfigured' });
    expect(await unwired.send({ ...DEVICE, platform: 'ios', voip_token: 'v' }, { type: 'test_ring' }, { ttlMs: 1 }))
      .toEqual({ ok: false, reason: 'unconfigured' });
    expect(unwired.configured('android')).toBe(false);
    expect(unwired.configured('ios')).toBe(false);
  });

  it('set registers an implementation, set(null) and reset restore the unwired default', async () => {
    const unwired = getPushSender();
    const real: PushSender = {
      send: vi.fn(async () => ({ ok: true }) as const),
      configured: vi.fn((platform: AgencyPushPlatform) => platform === 'android'),
    };
    setPushSender(real);
    expect(getPushSender()).toBe(real);
    expect(await getPushSender().send(DEVICE, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(real.send).toHaveBeenCalledWith(DEVICE, RING, { ttlMs: 20_000 });
    expect(getPushSender().configured('android')).toBe(true);

    setPushSender(null);
    expect(getPushSender()).toBe(unwired);
    setPushSender(real);
    resetPushSender();
    expect(getPushSender()).toBe(unwired);
    expect(getPushSender().configured('android')).toBe(false);
  });
});
