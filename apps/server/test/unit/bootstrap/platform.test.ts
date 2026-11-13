import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The platform background work wiring. */

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  attach: vi.fn(),
}));

vi.mock('../../../src/audit/audit-partition-maintenance.js', () => ({
  runAuditPartitionMaintenance: mocks.run,
}));
vi.mock('../../../src/cache/redis-cache.js', () => ({
  redisCache: { attachInvalidationSubscriber: mocks.attach, clearLocal: vi.fn() },
}));

import { logger } from '@magick-agency/observability';
import { startPlatform } from '../../../src/bootstrap/platform.js';
import type { AppContext } from '../../../src/app-context.js';
import { getPushSender, resetPushSender, setPushSender, type PushSender } from '../../../src/seams/push-sender.js';
import type { PushConfig } from '../../../src/notifications/push/push-sender.js';
import { MockPushCarrier } from '../../mocks/push/index.js';

function ctx(overrides: { enabled?: boolean; localCache?: boolean; push?: PushConfig } = {}): AppContext {
  const sub = { on: vi.fn(), quit: vi.fn().mockResolvedValue('OK') };
  return {
    config: {
      auditPartitions: { enabled: overrides.enabled ?? true, retentionDays: 85, monthsAhead: 3, intervalMs: 60_000 },
      localCache: { enabled: overrides.localCache ?? false, ttlMs: 5000, maxEntries: 10 },
      push: overrides.push ?? {},
    },
    redis: { duplicate: vi.fn(() => sub) },
    pool: {},
  } as unknown as AppContext;
}

describe('startPlatform', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.run.mockReset().mockResolvedValue({ created: {}, dropped: {}, defaultRowsDeleted: {}, errors: {} });
    mocks.attach.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs audit partition maintenance at boot and on every interval, with the configured window', async () => {
    const stop = await startPlatform(ctx());
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith({ retentionDays: 85, monthsAhead: 3 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.run).toHaveBeenCalledTimes(2);

    await stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it('never stacks a slow pass behind itself', async () => {
    let release!: () => void;
    mocks.run.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const stop = await startPlatform(ctx());
    await vi.advanceTimersByTimeAsync(180_000);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    await stop();
  });

  it('does nothing when the job is disabled', async () => {
    const stop = await startPlatform(ctx({ enabled: false }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.run).not.toHaveBeenCalled();
    await stop();
  });

  it('attaches the cache invalidation subscriber only when the local cache is enabled', async () => {
    await (await startPlatform(ctx({ enabled: false }))).call(null);
    expect(mocks.attach).not.toHaveBeenCalled();
    const stop = await startPlatform(ctx({ enabled: false, localCache: true }));
    expect(mocks.attach).toHaveBeenCalledTimes(1);
    await stop();
  });

  describe('the push senders (seams/push-sender.ts, docs/seams.md §3.6)', () => {
    let carrier: MockPushCarrier;
    beforeEach(async () => {
      vi.useRealTimers();
      carrier = await MockPushCarrier.start();
      // The bootstrap starts FCM's token refresh: it reaches this carrier, never Google.
      carrier.install();
    });
    afterEach(async () => {
      resetPushSender();
      await carrier.stop();
    });

    it('unconfigured: the seam is left unwired and boot says no phone can be rung', async () => {
      const info = vi.spyOn(logger, 'info');
      const unwired = getPushSender();
      const stop = await startPlatform(ctx({ enabled: false }));
      expect(getPushSender()).toBe(unwired);
      expect(getPushSender().configured('android')).toBe(false);
      expect(info).toHaveBeenCalledWith({ android: false, ios: false }, 'Push senders not configured: no phone can be rung while away');
      await stop();
      expect(getPushSender()).toBe(unwired);
      info.mockRestore();
    });

    it('configured: registered at start with what each platform can do, logged without secrets, cleared at stop', async () => {
      const info = vi.spyOn(logger, 'info');
      const unwired = getPushSender();
      carrier.install();
      const stop = await startPlatform(ctx({ enabled: false, push: carrier.config }));
      const wired = getPushSender();
      expect(wired).not.toBe(unwired);
      expect(wired.configured('android')).toBe(true);
      expect(wired.configured('ios')).toBe(true);
      expect(await wired.send(MockPushCarrier.device('android'), { type: 'test_ring' }, { ttlMs: 30_000 })).toEqual({ ok: true });
      expect(info).toHaveBeenCalledWith({ android: true, ios: true, apns_env: 'production' }, 'Push senders configured');
      expect(JSON.stringify(info.mock.calls)).not.toContain('PRIVATE KEY');
      await stop();
      expect(getPushSender()).toBe(unwired);
      info.mockRestore();
    });

    it('Android only: iOS is not configured', async () => {
      const stop = await startPlatform(ctx({ enabled: false, push: { fcm: carrier.config.fcm } }));
      expect(getPushSender().configured('android')).toBe(true);
      expect(getPushSender().configured('ios')).toBe(false);
      await stop();
    });

    it('stop leaves a sender registered after its own alone', async () => {
      const stop = await startPlatform(ctx({ enabled: false, push: carrier.config }));
      const other: PushSender = { send: async () => ({ ok: true }), configured: () => true };
      setPushSender(other);
      await stop();
      expect(getPushSender()).toBe(other);
    });
  });
});
