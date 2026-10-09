/**
 * The per-broadcast gate is released and extended from INSIDE the shared guard
 * primitives, so every existing teardown / cancel / rollback site covers a
 * grouped call without threading its group (ClickUp 14ygtkj9pgr):
 *   - AccountConcurrencyGuard.release  — per-scope fallback + every direct rollback cluster
 *   - ProviderConcurrencyGuard.releaseAll — the composite path of releaseTelephonyLease
 *   - ProviderConcurrencyGuard.extendAll  — queued-dial, transfer, WS-static extensions
 *
 * The guards carry no group lease hooks; the one case here pins the hookless
 * release ("makes exactly the call it always made").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@magick-agency/observability', async () => ({
  Traced: (await import('@magick-agency/observability/tracing')).Traced,
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { getMaxConcurrentCalls: vi.fn().mockResolvedValue(5) },
}));

import { AccountConcurrencyGuard } from '../../../src/core/account-concurrency-guard.js';

function redisMock() {
  return {
    eval: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    scan: vi.fn().mockResolvedValue(['0', []]),
    expire: vi.fn().mockResolvedValue(1),
    options: {},
  } as any;
}

describe('group lease hooks inside the guard primitives', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('AccountConcurrencyGuard.release', () => {
    it('without hooks, makes exactly the call it always made', async () => {
      const redis = redisMock();
      const guard = new AccountConcurrencyGuard(redis, 'p:', 300);
      await guard.release('row-1', 't1', 'a1');
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });
  });
});
