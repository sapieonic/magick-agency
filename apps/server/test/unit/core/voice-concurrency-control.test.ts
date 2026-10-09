// NEW (magick-agency, lane C): docs/seams.md §3.3. Each `ConcurrencyControl` method is a
// one-line forward to the guard method core's internal routes called, with the same
// arguments and the same result — pinned here per method; the same methods are exercised
// against real Redis in test/integration/core/voice-engine.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConcurrencyControl } from '../../../src/core/voice-concurrency-control.js';
import { getConcurrencyControl, resetConcurrencyControl } from '../../../src/seams/concurrency-control.js';
import { ensureVoiceEngine, getVoiceEngine, resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';

function fakeHost() {
  return {
    accountConcurrencyGuard: {
      invalidateLimit: vi.fn().mockResolvedValue(undefined),
      getAccountCount: vi.fn().mockResolvedValue(4),
      getDistributedAccountCount: vi.fn().mockResolvedValue({ status: 'available', count: 4 }),
    },
    providerConcurrencyGuard: {
      invalidateLimits: vi.fn().mockResolvedValue(undefined),
      getAccountProviderCounts: vi.fn().mockResolvedValue({ status: 'available', counts: new Map([['voicelink', 4]]) }),
    },
  };
}

describe('createConcurrencyControl', () => {
  it('invalidateAccountLimit → accountConcurrencyGuard.invalidateLimit(t, a)', async () => {
    const host = fakeHost();
    await createConcurrencyControl(host as any).invalidateAccountLimit('t', 'a');
    expect(host.accountConcurrencyGuard.invalidateLimit).toHaveBeenCalledWith('t', 'a');
  });

  it('invalidateProviderLimits → providerConcurrencyGuard.invalidateLimits(t, a)', async () => {
    const host = fakeHost();
    await createConcurrencyControl(host as any).invalidateProviderLimits('t', 'a');
    expect(host.providerConcurrencyGuard.invalidateLimits).toHaveBeenCalledWith('t', 'a');
  });

  it('getAccountProviderCounts → providerConcurrencyGuard.getAccountProviderCounts(t, a), result unchanged', async () => {
    const host = fakeHost();
    const out = await createConcurrencyControl(host as any).getAccountProviderCounts('t', 'a');
    expect(host.providerConcurrencyGuard.getAccountProviderCounts).toHaveBeenCalledWith('t', 'a');
    expect(out).toEqual({ status: 'available', counts: new Map([['voicelink', 4]]) });
  });

  it('getAccountCount → accountConcurrencyGuard.getAccountCount(t, a)', async () => {
    const host = fakeHost();
    await expect(createConcurrencyControl(host as any).getAccountCount('t', 'a')).resolves.toBe(4);
    expect(host.accountConcurrencyGuard.getAccountCount).toHaveBeenCalledWith('t', 'a');
  });

  it('getDistributedAccountCount → accountConcurrencyGuard.getDistributedAccountCount(t, a)', async () => {
    const host = fakeHost();
    await expect(createConcurrencyControl(host as any).getDistributedAccountCount('t', 'a'))
      .resolves.toEqual({ status: 'available', count: 4 });
    expect(host.accountConcurrencyGuard.getDistributedAccountCount).toHaveBeenCalledWith('t', 'a');
  });

  it('propagates a guard rejection (core\'s route surfaced it)', async () => {
    const host = fakeHost();
    host.accountConcurrencyGuard.invalidateLimit.mockRejectedValue(new Error('redis down'));
    await expect(createConcurrencyControl(host as any).invalidateAccountLimit('t', 'a')).rejects.toThrow('redis down');
  });
});

describe('the voice bootstrap registers the implementation (setConcurrencyControl)', () => {
  beforeEach(() => { resetVoiceEngineForTests(); resetConcurrencyControl(); });
  afterEach(() => { resetVoiceEngineForTests(); resetConcurrencyControl(); });

  it('before ensureVoiceEngine the seam is unwired and throws', async () => {
    await expect(getConcurrencyControl().getAccountCount('t', 'a')).rejects.toThrow(/not wired/);
  });

  it('ensureVoiceEngine wires it onto the engine\'s own guards, once', async () => {
    const engine = ensureVoiceEngine(null);
    expect(ensureVoiceEngine(null)).toBe(engine);
    expect(getVoiceEngine()).toBe(engine);
    // No Redis: the runtime accessor reads the process-local count (0), the control-plane
    // read refuses to substitute it (core's semantics).
    await expect(getConcurrencyControl().getAccountCount('t', 'a')).resolves.toBe(0);
    await expect(getConcurrencyControl().getDistributedAccountCount('t', 'a')).resolves.toEqual({ status: 'unavailable' });
    await expect(getConcurrencyControl().getAccountProviderCounts('t', 'a'))
      .resolves.toEqual({ status: 'unavailable', counts: new Map() });
    await expect(getConcurrencyControl().invalidateAccountLimit('t', 'a')).resolves.toBeUndefined();
    await expect(getConcurrencyControl().invalidateProviderLimits('t', 'a')).resolves.toBeUndefined();

    // And it is the ENGINE's guards that answer — not some other instance with the same defaults.
    const account = engine.guardHost.accountConcurrencyGuard;
    const provider = engine.guardHost.providerConcurrencyGuard;
    const getAccountCount = vi.spyOn(account, 'getAccountCount').mockResolvedValue(7);
    const getDistributed = vi.spyOn(account, 'getDistributedAccountCount')
      .mockResolvedValue({ status: 'available', count: 5 });
    const invalidateLimit = vi.spyOn(account, 'invalidateLimit');
    const getProviderCounts = vi.spyOn(provider, 'getAccountProviderCounts');
    const invalidateLimits = vi.spyOn(provider, 'invalidateLimits');
    await expect(getConcurrencyControl().getAccountCount('t', 'a')).resolves.toBe(7);
    expect(getAccountCount).toHaveBeenCalledWith('t', 'a');
    await expect(getConcurrencyControl().getDistributedAccountCount('t', 'a'))
      .resolves.toEqual({ status: 'available', count: 5 });
    expect(getDistributed).toHaveBeenCalledWith('t', 'a');
    await getConcurrencyControl().invalidateAccountLimit('t', 'a');
    expect(invalidateLimit).toHaveBeenCalledWith('t', 'a');
    await getConcurrencyControl().getAccountProviderCounts('t', 'a');
    expect(getProviderCounts).toHaveBeenCalledWith('t', 'a');
    await getConcurrencyControl().invalidateProviderLimits('t', 'a');
    expect(invalidateLimits).toHaveBeenCalledWith('t', 'a');
  });
});
