import { describe, it, expect, vi } from 'vitest';

/*
 * NEW (magick-agency, Phase 8), no source twin: the equivalence test for
 * `src/agency/dnc-availability.ts`, the stats route's `runtime.dnc.appliedVersion`
 * after the DNC collapse (decision B8).
 *
 * Core's health strip read the tenant's Redis set version and `campaignHealth`
 * diagnosed `dnc_unavailable` on `null`, because that is exactly when the pre-dial gate
 * halted. The set is gone; the gate is `DncRegistry.check` and halts only on
 * `unavailable`. The claim under test: **the probe answers `null` exactly when `check`
 * answers `unavailable`** — for every member of the `DncCheck` union, through the same
 * method the gate calls — so the strip can neither report a halt the gate would not make
 * nor miss one it would. The real-Postgres half (a real `22P02`) is in
 * `test/integration/agency/agency-campaign-stats.routes.test.ts`.
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@magick-agency/db', () => ({ getPool: () => ({ query: vi.fn() }) }));

const { dncAvailabilityProbe, DNC_PROBE_PHONE } = await import('../../../src/agency/dnc-availability.js');
const { DncRegistry, normalizeE164 } = await import('../../../src/agency/dnc-registry.js');
type DncCheck = import('../../../src/agency/dnc-registry.js').DncCheck;

const TENANT = '11111111-1111-4111-8111-111111111111';
const ALL_RESULTS: readonly DncCheck[] = ['clear', 'suppressed', 'unverifiable', 'unavailable'];

describe('dncAvailabilityProbe — null exactly when the gate would halt', () => {
  it.each(ALL_RESULTS)('check → %s', async (result) => {
    const check = vi.fn(async () => result);
    const version = await dncAvailabilityProbe({ check }).appliedVersion(TENANT);

    // The equivalence, stated as the biconditional rather than per value.
    expect(version === null).toBe(result === 'unavailable');
    // A non-null answer is the constant standing where a version stood.
    if (result !== 'unavailable') expect(version).toBe(1);
  });

  it('asks the gate\'s own method, for the tenant, tenant-wide, with a number that reaches the read', async () => {
    const check = vi.fn(async (): Promise<DncCheck> => 'clear');
    await dncAvailabilityProbe({ check }).appliedVersion(TENANT);

    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(TENANT, DNC_PROBE_PHONE, { accountId: null, campaignId: null });
    // A probe number `check` could not normalize would answer `unverifiable` without
    // ever reading the table, and the strip would then report "available" while the
    // read is down. It must be a syntactically valid E.164.
    expect(normalizeE164(DNC_PROBE_PHONE)).toBe(DNC_PROBE_PHONE);
  });

  it('through the real DncRegistry: a failed dnc_entries read is null, a completed one is not', async () => {
    const findSuppressed = vi.fn();
    const probe = dncAvailabilityProbe(new DncRegistry({ findSuppressed }));

    findSuppressed.mockResolvedValueOnce(new Set());
    expect(await probe.appliedVersion(TENANT)).toBe(1);

    // On the list is still a completed read: the gate would SKIP that contact, not halt.
    findSuppressed.mockResolvedValueOnce(new Set([DNC_PROBE_PHONE]));
    expect(await probe.appliedVersion(TENANT)).toBe(1);

    findSuppressed.mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
    expect(await probe.appliedVersion(TENANT)).toBeNull();

    expect(findSuppressed).toHaveBeenCalledWith(
      { tenantId: TENANT, accountId: null, campaignId: null },
      [DNC_PROBE_PHONE],
    );
  });
});
