/**
 * A tenant carrier account's own concurrency cap (docs/carriers.md CR13), the parts that need no
 * Redis: the compatibility path of `acquireTelephonyConcurrency` with a credential (taken after
 * the other scopes, every one handed back on a refusal), the guard host's credential handling
 * (an unreadable cap fails closed, not provider-scoped; every call on a credential takes its
 * scope, capped or not, and only a cap refuses; a legacy account's credential scope is taken
 * after its global and account scopes and hands them back when full), the admission metric
 * (only admissions against a cap are samples), the admission's refusal
 * (`carrier_account_concurrency_limit`, 429), the release's per-scope fallback, and every
 * caller's reading of the new refusal as back-pressure. The Lua is proven against real Redis in
 * `test/integration/core/credential-concurrency.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLog, capRead } = vi.hoisted(() => ({
  mockLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  capRead: vi.fn(),
}));

vi.mock('@magick-agency/observability', async () => ({
  Traced: (await import('@magick-agency/observability/tracing')).Traced,
  logger: mockLog,
  createChildLogger: () => mockLog,
}));
vi.mock('@magick-agency/observability/metrics/voice', () => ({
  trackProviderConcurrencyAdmission: vi.fn(),
  trackProviderConcurrencyReconciliation: vi.fn(),
  trackCredentialConcurrencyAdmission: vi.fn(),
  trackCredentialConcurrencyReconciliation: vi.fn(),
}));
vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: 'test:' },
    concurrency: { maxConcurrentCalls: 10, callTimeoutSeconds: 300, reconcileIntervalMs: 300000, staleCallSweepMinutes: 30 },
  },
}));
vi.mock('@magick-agency/db/repositories/provider-concurrency.repository', () => ({
  providerConcurrencyRepository: {
    getProviderLimit: vi.fn().mockResolvedValue({ mode: 'legacy_total', limit: null, total: 5, version: 1 }),
  },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { getMaxConcurrentCalls: vi.fn().mockResolvedValue(100) },
}));
vi.mock('@magick-agency/db/repositories/telephony-credential.repository', () => ({
  telephonyCredentialRepository: { getConcurrencyCap: capRead },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  agencyCallRepository: { failStaleActive: vi.fn().mockResolvedValue([]) },
  webrtcCallRepository: { failStaleActive: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({ trackWebrtcCallRejected: vi.fn() }));

import { acquireTelephonyConcurrency } from '../../../src/core/telephony-concurrency.js';
import { TelephonyGuardHost } from '../../../src/core/telephony-guard-host.js';
import { admitBridgeCall } from '../../../src/core/bridge/admission.js';
import { releaseTelephonyLease } from '../../../src/core/telephony-release.js';
import { WebRtcCallError } from '../../../src/core/bridge/bridge-types.js';
import { classifyDialRefusal } from '../../../src/core/bridge/dial-refusals.js';
import { countsTowardBreaker } from '../../../src/agency/carrier-refusal-breaker.js';
import { manualDialFailureFor } from '../../../src/agency/softphone/manual-dialer.js';
import { trackWebrtcCallRejected } from '../../../src/analytics/posthog.js';
import { CredentialConcurrencyGuard } from '../../../src/core/credential-concurrency-guard.js';
import { ProviderConcurrencyGuard } from '../../../src/core/provider-concurrency-guard.js';
import { providerConcurrencyRepository } from '@magick-agency/db/repositories/provider-concurrency.repository';
import { trackCredentialConcurrencyAdmission } from '@magick-agency/observability/metrics/voice';

beforeEach(() => {
  vi.clearAllMocks();
  capRead.mockResolvedValue(2);
});

/** The per-scope guards of a test double, every one admitting. */
function doubles(credential: 'acquired' | 'credential_full' | 'redis_unavailable' = 'acquired') {
  return {
    concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    providerConcurrencyGuard: {
      tryAcquire: vi.fn().mockResolvedValue({ result: 'acquired', providerScoped: true, newlyAcquired: true }),
      release: vi.fn().mockResolvedValue(undefined),
    },
    credentialConcurrencyGuard: {
      resolveCap: vi.fn().mockResolvedValue(2 as number | null),
      tryAcquire: vi.fn().mockResolvedValue(credential),
    },
  };
}

describe('acquireTelephonyConcurrency with a credential', () => {
  it('forwards the credential as a sixth argument to the production entry point, and only then', async () => {
    const tryAcquireTelephonyConcurrency = vi.fn().mockResolvedValue({ result: 'acquired', providerScoped: false, newlyAcquired: true });
    const owner = { ...doubles(), tryAcquireTelephonyConcurrency };
    await acquireTelephonyConcurrency(owner, 'k', 't', 'a', 'plivo', 60, 'cred-1');
    expect(tryAcquireTelephonyConcurrency.mock.calls[0]).toEqual(['k', 't', 'a', 'plivo', 60, 'cred-1']);
    await acquireTelephonyConcurrency(owner, 'k2', 't', 'a', 'plivo', 60, null);
    expect(tryAcquireTelephonyConcurrency.mock.calls[1]).toEqual(['k2', 't', 'a', 'plivo', 60]);
  });

  it('compatibility path: takes the credential scope last, with the cap it read', async () => {
    const owner = doubles();
    await expect(acquireTelephonyConcurrency(owner, 'k', 't', 'a', 'plivo', 60, 'cred-1'))
      .resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
    expect(owner.credentialConcurrencyGuard.tryAcquire).toHaveBeenCalledWith('k', 'cred-1', 2, 'plivo', 60);
  });

  it.each(['credential_full', 'redis_unavailable'] as const)('compatibility path: %s hands every scope back', async (refusal) => {
    const owner = doubles(refusal);
    await expect(acquireTelephonyConcurrency(owner, 'k', 't', 'a', 'plivo', 60, 'cred-1'))
      .resolves.toEqual({ result: refusal, providerScoped: true });
    expect(owner.providerConcurrencyGuard.release).toHaveBeenCalledWith('k', 't', 'a', 'plivo');
    expect(owner.accountConcurrencyGuard.release).toHaveBeenCalledWith('k', 't', 'a');
    expect(owner.concurrencyGuard.release).toHaveBeenCalledWith('k');
  });

  it('compatibility path: a credential with no cap of its own still takes its scope, with no cap', async () => {
    const owner = doubles();
    owner.credentialConcurrencyGuard.resolveCap.mockResolvedValue(null);
    await expect(acquireTelephonyConcurrency(owner, 'k', 't', 'a', 'plivo', 60, 'cred-1'))
      .resolves.toMatchObject({ result: 'acquired' });
    expect(owner.credentialConcurrencyGuard.tryAcquire).toHaveBeenCalledWith('k', 'cred-1', null, 'plivo', 60);
  });

  it('compatibility path: Redis failing refuses a capped call but admits an uncapped one (no cap to over-commit)', async () => {
    const owner = doubles('redis_unavailable');
    owner.credentialConcurrencyGuard.resolveCap.mockResolvedValue(null);
    await expect(acquireTelephonyConcurrency(owner, 'k', 't', 'a', 'plivo', 60, 'cred-1'))
      .resolves.toMatchObject({ result: 'acquired' });
    expect(owner.concurrencyGuard.release).not.toHaveBeenCalled();
  });

  it('compatibility path: an unreadable cap fails closed before anything is taken, not provider-scoped', async () => {
    const owner = doubles();
    owner.credentialConcurrencyGuard.resolveCap.mockRejectedValue(new Error('db down'));
    await expect(acquireTelephonyConcurrency(owner, 'k', 't', 'a', 'plivo', 60, 'cred-1'))
      .resolves.toEqual({ result: 'allocation_unavailable', providerScoped: false });
    expect(owner.concurrencyGuard.tryAcquire).not.toHaveBeenCalled();
  });
});

describe('TelephonyGuardHost with a credential', () => {
  it('fails closed (allocation_unavailable) when the cap cannot be read, taking nothing; not provider-scoped, the mode unknown', async () => {
    const host = new TelephonyGuardHost(null);
    capRead.mockRejectedValue(new Error('db down'));
    const all = vi.spyOn(host.providerConcurrencyGuard, 'tryAcquireAll');
    const legacyGlobal = vi.spyOn(host.concurrencyGuard, 'tryAcquire');
    // A legacy account (the mocked allocation): the refusal is not provider-scoped.
    await expect(host.tryAcquireTelephonyConcurrency('k', 't', 'a', 'plivo', 60, 'cred-1'))
      .resolves.toEqual({ result: 'allocation_unavailable', providerScoped: false });
    expect(all).not.toHaveBeenCalled();
    expect(legacyGlobal).not.toHaveBeenCalled();
    // A credential last read as uncapped is refused too once its cap cannot be read (it may
    // have been capped since): the cache has expired or been dropped.
    capRead.mockResolvedValue(null);
    await expect(host.tryAcquireTelephonyConcurrency('k1', 't', 'a', 'plivo', 60, 'cred-2')).resolves.toMatchObject({ result: 'acquired' });
    host.credentialConcurrencyGuard.invalidateCap('cred-2');
    capRead.mockRejectedValue(new Error('db down'));
    await expect(host.tryAcquireTelephonyConcurrency('k2', 't', 'a', 'plivo', 60, 'cred-2'))
      .resolves.toEqual({ result: 'allocation_unavailable', providerScoped: false });
  });

  it('the provider allocation\'s own refusal stays provider-scoped (the provider guard answered)', async () => {
    const host = new TelephonyGuardHost(null);
    vi.mocked(providerConcurrencyRepository.getProviderLimit).mockRejectedValueOnce(new Error('db down'));
    await expect(host.tryAcquireTelephonyConcurrency('k', 't', 'a-unread', 'plivo', 60, 'cred-1'))
      .resolves.toEqual({ result: 'allocation_unavailable', providerScoped: true });
  });

  it('hands the composite the credential scope with its cap and keys (CR13), and an uncapped one with no cap', async () => {
    const host = new TelephonyGuardHost(null);
    const all = vi.spyOn(host.providerConcurrencyGuard, 'tryAcquireAll')
      .mockResolvedValue({ result: 'acquired', providerScoped: true, newlyAcquired: true });
    await host.tryAcquireTelephonyConcurrency('k', 't', 'a', 'plivo', 60, 'cred-1');
    expect(all).toHaveBeenLastCalledWith('k', 't', 'a', 'plivo', 60, {
      credentialId: 'cred-1', cap: 2,
      counter: 'test:active_calls:credential:cred-1',
      lock: 'test:active_calls:credential:cred-1:lock:k',
      generation: 'test:active_calls:credential:cred-1:generation',
    });
    capRead.mockResolvedValue(null);
    host.credentialConcurrencyGuard.invalidateCap('cred-1');
    await host.tryAcquireTelephonyConcurrency('k2', 't', 'a', 'plivo', 60, 'cred-1');
    expect(all).toHaveBeenLastCalledWith('k2', 't', 'a', 'plivo', 60, {
      credentialId: 'cred-1', cap: null,
      counter: 'test:active_calls:credential:cred-1',
      lock: 'test:active_calls:credential:cred-1:lock:k2',
      generation: 'test:active_calls:credential:cred-1:generation',
    });
    await host.tryAcquireTelephonyConcurrency('k3', 't', 'a', 'voicelink', 60);
    expect(all).toHaveBeenLastCalledWith('k3', 't', 'a', 'voicelink', 60, null);
  });

  it('legacy account: the credential scope is taken after global and account, and a refusal hands both back', async () => {
    const host = new TelephonyGuardHost(null);
    vi.spyOn(host.credentialConcurrencyGuard, 'tryAcquire').mockResolvedValue('credential_full');
    const releaseGlobal = vi.spyOn(host.concurrencyGuard, 'release');
    const releaseAccount = vi.spyOn(host.accountConcurrencyGuard, 'release');
    await expect(host.tryAcquireTelephonyConcurrency('k', 't', 'a', 'plivo', 60, 'cred-1'))
      .resolves.toEqual({ result: 'credential_full', providerScoped: false });
    expect(releaseGlobal).toHaveBeenCalledWith('k');
    expect(releaseAccount).toHaveBeenCalledWith('k', 't', 'a');
    // Both process-local counters are back where they were: the next call is admitted.
    vi.mocked(host.credentialConcurrencyGuard.tryAcquire).mockResolvedValue('acquired');
    await expect(host.tryAcquireTelephonyConcurrency('k2', 't', 'a', 'plivo', 60, 'cred-1'))
      .resolves.toMatchObject({ result: 'acquired' });
  });

  it('legacy account, no Redis: a capped credential is refused (no process-local share of a carrier\'s cap)', async () => {
    const host = new TelephonyGuardHost(null);
    const take = vi.spyOn(host.credentialConcurrencyGuard, 'tryAcquire');
    await expect(host.tryAcquireTelephonyConcurrency('k', 't', 'a', 'plivo', 60, 'cred-1'))
      .resolves.toEqual({ result: 'redis_unavailable', providerScoped: false });
    // An uncapped credential is admitted as before: its scope is asked for (with no cap) and,
    // Redis being down, the call goes ahead without the lease.
    capRead.mockResolvedValue(null);
    host.credentialConcurrencyGuard.invalidateCap('cred-1');
    await expect(host.tryAcquireTelephonyConcurrency('k2', 't', 'a', 'plivo', 60, 'cred-1'))
      .resolves.toMatchObject({ result: 'acquired' });
    expect(take).toHaveBeenLastCalledWith('k2', 'cred-1', null, 'plivo', 60);
  });
});

describe('the credential admission metric counts only admissions against a cap (CR13)', () => {
  /** A Redis double whose every script answers `reply`. */
  const redisAnswering = (reply: number) => ({ eval: vi.fn().mockResolvedValue(reply), options: {} });

  it('the credential guard alone: a sample with a cap, none without', async () => {
    const guard = new CredentialConcurrencyGuard(redisAnswering(1) as never, 'p:', 300);
    await expect(guard.tryAcquire('k', 'cred-1', null, 'plivo')).resolves.toBe('acquired');
    await expect(new CredentialConcurrencyGuard(null, 'p:', 300).tryAcquire('k', 'cred-1', null, 'plivo')).resolves.toBe('redis_unavailable');
    expect(trackCredentialConcurrencyAdmission).not.toHaveBeenCalled();
    await expect(guard.tryAcquire('k', 'cred-1', 2, 'plivo')).resolves.toBe('acquired');
    expect(trackCredentialConcurrencyAdmission).toHaveBeenCalledExactlyOnceWith('plivo', 'acquired');
  });

  it('the composite: a sample with a cap, none without; the Lua is told \'none\' for no cap', async () => {
    vi.mocked(providerConcurrencyRepository.getProviderLimit)
      .mockResolvedValueOnce({ mode: 'provider_breakdown', limit: 5, total: 10, version: 1 } as never);
    const redis = redisAnswering(1);
    const guard = new ProviderConcurrencyGuard(redis as never, 'p:', 300, 100);
    const scope = (cap: number | null) => ({ credentialId: 'cred-1', cap, counter: 'c', lock: 'l', generation: 'g' });
    await expect(guard.tryAcquireAll('k', 't', 'a', 'plivo', 60, scope(null))).resolves.toMatchObject({ result: 'acquired' });
    expect(trackCredentialConcurrencyAdmission).not.toHaveBeenCalled();
    const evalCall = redis.eval.mock.calls[0]!;
    // 12 keys (four scopes), then the three limits, the TTL and the credential's 'none'.
    expect(evalCall[1]).toBe(12);
    expect(evalCall.slice(-5)).toEqual([100, 10, 5, 60, 'none']);
    // The allocation is cached: the second admission is provider mode too.
    await expect(guard.tryAcquireAll('k2', 't', 'a', 'plivo', 60, scope(3))).resolves.toMatchObject({ result: 'acquired' });
    expect(redis.eval.mock.calls[1]!.slice(-1)).toEqual([3]);
    expect(trackCredentialConcurrencyAdmission).toHaveBeenCalledExactlyOnceWith('plivo', 'acquired');
  });
});

describe('CredentialConcurrencyGuard cap cache', () => {
  it('reads the cap once per few seconds, and again after an invalidation', async () => {
    const guard = new CredentialConcurrencyGuard(null, 'p:', 300);
    await expect(guard.resolveCap('cred-1')).resolves.toBe(2);
    capRead.mockResolvedValue(7);
    await expect(guard.resolveCap('cred-1')).resolves.toBe(2);
    expect(capRead).toHaveBeenCalledTimes(1);
    guard.invalidateCap('cred-1');
    await expect(guard.resolveCap('cred-1')).resolves.toBe(7);
  });

  it('reads a cap that is not a positive whole number as none', async () => {
    const guard = new CredentialConcurrencyGuard(null, 'p:', 300);
    capRead.mockResolvedValue(0);
    await expect(guard.resolveCap('cred-0')).resolves.toBeNull();
  });

  it('without Redis the counts are unavailable, never zero', async () => {
    const guard = new CredentialConcurrencyGuard(null, 'p:', 300);
    await expect(guard.getCounts(['cred-1'])).resolves.toEqual({ status: 'unavailable', counts: new Map() });
    await expect(guard.getCounts([])).resolves.toEqual({ status: 'available', counts: new Map() });
  });
});

describe('admitBridgeCall: the carrier account\'s cap is full', () => {
  it('throws carrier_account_concurrency_limit, 429, and reports it', async () => {
    const host = { tryAcquireTelephonyConcurrency: vi.fn().mockResolvedValue({ result: 'credential_full', providerScoped: true }) };
    const err = await admitBridgeCall(host as never, {
      concurrencyKey: 'k', tenantId: 't', accountId: 'a', provider: 'plivo', slotTtlSeconds: 60, telephonyCredentialId: 'cred-1',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebRtcCallError);
    expect(err).toMatchObject({ code: 'carrier_account_concurrency_limit', statusCode: 429 });
    expect(host.tryAcquireTelephonyConcurrency).toHaveBeenCalledWith('k', 't', 'a', 'plivo', 60, 'cred-1');
    expect(trackWebrtcCallRejected).toHaveBeenCalledWith({ tenantId: 't', accountId: 'a', reason: 'carrier_account_concurrency_limit', provider: 'plivo' });
  });

  it('a call on the service\'s own account passes no credential', async () => {
    const host = { tryAcquireTelephonyConcurrency: vi.fn().mockResolvedValue({ result: 'acquired', providerScoped: true, newlyAcquired: true }) };
    await admitBridgeCall(host as never, { concurrencyKey: 'k', tenantId: 't', accountId: 'a', provider: 'voicelink', slotTtlSeconds: 60, telephonyCredentialId: null });
    expect(host.tryAcquireTelephonyConcurrency.mock.calls[0]).toEqual(['k', 't', 'a', 'voicelink', 60]);
  });
});

describe('every caller reads carrier_account_concurrency_limit as provider_concurrency_limit', () => {
  const refusal = (code: string) => new WebRtcCallError('full', code as never, 429);
  it.each(['provider_concurrency_limit', 'carrier_account_concurrency_limit'])('%s', (code) => {
    // The paced dialler (the contact goes back at once, uncharged; nothing paused) and the
    // dial dispatcher read it through this one classifier.
    expect(classifyDialRefusal(refusal(code))).toEqual({ kind: 'capacity' });
    // The PL11 refusal breaker does not count it.
    expect(countsTowardBreaker(refusal(code))).toBe(false);
    // The soft phone answers "All lines are busy. Try again shortly."
    expect(manualDialFailureFor(refusal(code))).toBe('concurrency_limit');
  });
});

describe('releaseTelephonyLease with a credential', () => {
  function guards() {
    return {
      concurrencyGuard: { release: vi.fn().mockResolvedValue(undefined) },
      accountConcurrencyGuard: { release: vi.fn().mockResolvedValue(undefined) },
      providerConcurrencyGuard: {
        releaseAll: vi.fn().mockResolvedValue({ status: 'released', scopes: 4 }),
        release: vi.fn().mockResolvedValue(undefined),
      },
      credentialConcurrencyGuard: { release: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it('the composite release is told the credential, and four scopes is a complete lease', async () => {
    const g = guards();
    await expect(releaseTelephonyLease(g, {
      concurrencyKey: 'k', tenantId: 't', accountId: 'a', provider: 'plivo', source: 'webrtc', credentialId: 'cred-1',
    })).resolves.toBe('composite');
    expect(g.providerConcurrencyGuard.releaseAll).toHaveBeenCalledWith('k', 't', 'a', 'plivo', 'cred-1');
    expect(g.credentialConcurrencyGuard.release).not.toHaveBeenCalled();
  });

  it('without a credential the composite is called as before (four arguments)', async () => {
    const g = guards();
    await releaseTelephonyLease(g, { concurrencyKey: 'k', tenantId: 't', accountId: 'a', provider: 'voicelink', source: 'webrtc' });
    expect(g.providerConcurrencyGuard.releaseAll.mock.calls[0]).toEqual(['k', 't', 'a', 'voicelink']);
  });

  it('the per-scope fallback releases the credential scope too', async () => {
    const g = guards();
    g.providerConcurrencyGuard.releaseAll.mockResolvedValue({ status: 'failed', err: new Error('x') });
    await expect(releaseTelephonyLease(g, {
      concurrencyKey: 'k', tenantId: 't', accountId: 'a', provider: 'plivo', source: 'webrtc', credentialId: 'cred-1',
    })).resolves.toBe('failure');
    expect(g.credentialConcurrencyGuard.release).toHaveBeenCalledWith('k', 'cred-1');
    expect(g.providerConcurrencyGuard.release).toHaveBeenCalledWith('k', 't', 'a', 'plivo');
  });
});
