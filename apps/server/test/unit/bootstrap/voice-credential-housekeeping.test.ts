import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tenant carrier credentials' housekeeping in the voice bootstrap: the keyring check and
 * the sweep, at boot and on the interval, and the metrics behind
 * `agy-credential-keyring-missing-keys` and `agy-credential-sweep-failing`.
 */

const metrics = vi.hoisted(() => ({
  prime: vi.fn(),
  missing: vi.fn(),
  sweep: vi.fn(),
}));

vi.mock('@magick-agency/observability/metrics/voice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability/metrics/voice')>()),
  primeTelephonyCredentialSweeps: metrics.prime,
  trackTelephonyCredentialMissingKeyIds: metrics.missing,
  trackTelephonyCredentialSweep: metrics.sweep,
}));

import { startCredentialHousekeeping, type CredentialHousekeepingService } from '../../../src/bootstrap/voice.js';

const HOUR = 60 * 60 * 1000;

function service(overrides: Partial<{ missingKeyIds: () => Promise<string[]>; sweep: () => Promise<{ shredded: number; pruned: number }> }> = {}) {
  return {
    missingKeyIds: vi.fn(overrides.missingKeyIds ?? (async () => [])),
    sweep: vi.fn(overrides.sweep ?? (async () => ({ shredded: 0, pruned: 0 }))),
  } satisfies CredentialHousekeepingService;
}

describe('startCredentialHousekeeping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    metrics.prime.mockReset();
    metrics.missing.mockReset();
    metrics.sweep.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('primes the sweep counter, publishes the boot keyring check and counts the boot sweep', async () => {
    const svc = service({
      missingKeyIds: async () => ['v1', 'v0'],
      sweep: async () => ({ shredded: 2, pruned: 1 }),
    });
    const stop = await startCredentialHousekeeping(svc, HOUR);
    expect(metrics.prime).toHaveBeenCalledTimes(1);
    expect(metrics.missing).toHaveBeenCalledWith(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.sweep).toHaveBeenCalledTimes(1);
    expect(metrics.sweep).toHaveBeenCalledWith('ok', 2);
    stop();
  });

  it('publishes 0 when every stored key id is in the keyring', async () => {
    const stop = await startCredentialHousekeeping(service(), HOUR);
    expect(metrics.missing).toHaveBeenCalledWith(0);
    stop();
  });

  it('a keyring check that throws publishes nothing (the gauge keeps its last value)', async () => {
    const svc = service({ missingKeyIds: async () => { throw new Error('pool exhausted'); } });
    const stop = await startCredentialHousekeeping(svc, HOUR);
    expect(metrics.missing).not.toHaveBeenCalled();
    stop();
  });

  it('a sweep that throws counts failed and the housekeeping carries on', async () => {
    const svc = service();
    svc.sweep.mockRejectedValueOnce(new Error('db down'));
    const stop = await startCredentialHousekeeping(svc, HOUR);
    await vi.advanceTimersByTimeAsync(0);
    expect(metrics.sweep).toHaveBeenCalledWith('failed');
    expect(metrics.sweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(metrics.sweep).toHaveBeenLastCalledWith('ok', 0);
    stop();
  });

  it('sweeps and re-checks the keyring every interval, and stops', async () => {
    const svc = service();
    const stop = await startCredentialHousekeeping(svc, HOUR);
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.missingKeyIds).toHaveBeenCalledTimes(1);
    expect(svc.sweep).toHaveBeenCalledTimes(1);

    svc.missingKeyIds.mockResolvedValueOnce(['v9']);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(svc.sweep).toHaveBeenCalledTimes(2);
    expect(svc.missingKeyIds).toHaveBeenCalledTimes(2);
    expect(metrics.missing).toHaveBeenLastCalledWith(1);

    stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(svc.sweep).toHaveBeenCalledTimes(2);
  });

  it('never starts a pass while the previous one runs', async () => {
    let release!: () => void;
    const svc = service();
    svc.sweep.mockImplementationOnce(() => new Promise((r) => { release = () => r({ shredded: 0, pruned: 0 }); }));
    const stop = await startCredentialHousekeeping(svc, HOUR);
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(svc.sweep).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(svc.sweep).toHaveBeenCalledTimes(2);
    stop();
  });
});
