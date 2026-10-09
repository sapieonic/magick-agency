import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** NEW (magick-agency, no source): the lane-A background work wiring. */

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

import { startPlatform } from '../../../src/bootstrap/platform.js';
import type { AppContext } from '../../../src/app-context.js';

function ctx(overrides: { enabled?: boolean; localCache?: boolean } = {}): AppContext {
  const sub = { on: vi.fn(), quit: vi.fn().mockResolvedValue('OK') };
  return {
    config: {
      auditPartitions: { enabled: overrides.enabled ?? true, retentionDays: 85, monthsAhead: 3, intervalMs: 60_000 },
      localCache: { enabled: overrides.localCache ?? false, ttlMs: 5000, maxEntries: 10 },
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
});
