import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The DNC registry after the collapse (decision B8): `check` is an indexed read of
// `dnc_entries` through `DncRepository.findSuppressed`, and fails CLOSED.
//
// PORT NOTE (magick-agency, lane B1). Ported from core
// test/unit/agency/dnc-registry.test.ts@4850d1d9 (23 cases). KEPT verbatim: the
// three `normalizeE164` cases (both sides of the comparison). MODIFIED: "reports
// unverifiable for a phone it cannot normalize, without asking Redis" → without
// asking the database. REPLACED by the cases below: the Redis-shaped `check` cases
// ("answers suppressed for a member…", "refuses to dial when the tenant has never
// synced", "refuses to dial when Redis throws", "…when there is no Redis at all",
// "reads the version key and the set in one script") — the set, the version and the
// script no longer exist. DELETED with the Redis set (not ported): the five
// `applyDelta` cases, the six `applyReplace` cases and the three `appliedVersion`
// cases. What the real table does (scopes, a real DB error) is asserted against
// Postgres in test/integration/agency/dnc-registry.test.ts.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@magick-agency/db', () => ({ getPool: () => ({ query: vi.fn() }) }));

const { DncRegistry, normalizeE164 } = await import('../../../src/agency/dnc-registry.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CAMPAIGN = '33333333-3333-4333-8333-333333333333';
const NONE = { accountId: null, campaignId: null };

const findSuppressed = vi.fn();
const registry = new DncRegistry({ findSuppressed });

beforeEach(() => {
  findSuppressed.mockReset();
});

describe('check — every failure stops the dial', () => {
  it('answers suppressed for a number on the list and clear for one that is not', async () => {
    findSuppressed.mockResolvedValueOnce(new Set(['+14155550100']));
    expect(await registry.check(TENANT, '+14155550100', NONE)).toBe('suppressed');
    // an EMPTY answer from a read that completed is clear — the opposite of core's
    // empty-Redis-set case, which had to be `unavailable` (no version key)
    findSuppressed.mockResolvedValueOnce(new Set());
    expect(await registry.check(TENANT, '+14155550100', NONE)).toBe('clear');
  });

  it('refuses to dial (unavailable) when the read throws — never clear', async () => {
    findSuppressed.mockRejectedValueOnce(new Error('connection terminated'));
    expect(await registry.check(TENANT, '+14155550100', NONE)).toBe('unavailable');
  });

  it('refuses to dial when there is no database pool at all', async () => {
    // the default repository calls `getPool()`, which throws before init
    const bare = new DncRegistry({
      findSuppressed: async () => { throw new Error('Database pool not initialized'); },
    });
    expect(await bare.check(TENANT, '+14155550100', NONE)).toBe('unavailable');
  });

  it('asks about the normalized number, in the scope it was given', async () => {
    findSuppressed.mockResolvedValue(new Set());
    await registry.check(TENANT, ' +1 415 555 0100 ', { accountId: ACCOUNT, campaignId: CAMPAIGN });
    expect(findSuppressed).toHaveBeenCalledWith(
      { tenantId: TENANT, accountId: ACCOUNT, campaignId: CAMPAIGN },
      ['+14155550100'],
    );
  });

  it('matches on the normalized form, so a stored `14155550100` cannot be dialled as `+14155550100`', async () => {
    findSuppressed.mockResolvedValue(new Set(['+14155550100']));
    expect(await registry.check(TENANT, '14155550100', NONE)).toBe('suppressed');
  });
});

describe('check — a bad row must not halt the campaign', () => {
  it('reports unverifiable for a phone it cannot normalize, without asking the database', async () => {
    // `unverifiable` and `unavailable` both stop THIS dial, and collapsing them
    // would be the tempting simplification — but one is a property of a single
    // roster row and the other of the whole registry. If a malformed phone
    // returned `unavailable`, one junk CSV row would stop dialing for every
    // contact on the campaign, and the outage would look like a database problem.
    for (const bad of ['', '   ', 'not-a-number', '+0123', '+1', 'tel:+14155550100', '0']) {
      expect(await registry.check(TENANT, bad, NONE)).toBe('unverifiable');
    }
    expect(findSuppressed).not.toHaveBeenCalled();
  });
});

describe('normalizeE164 — both sides of the comparison', () => {
  it('produces one canonical form for the shapes a CSV and an API produce', () => {
    for (const raw of [
      '+14155550100', '14155550100', ' +1 415 555 0100 ',
      '+1-415-555-0100', '(1) 415-555-0100',
    ]) {
      expect(normalizeE164(raw)).toBe('+14155550100');
    }
  });

  it('cannot reconcile a national-format number, and does not pretend to', async () => {
    expect(normalizeE164('4155550100')).toBe('+4155550100');
    expect(normalizeE164('4155550100')).not.toBe('+14155550100');
  });

  it('rejects rather than repairs what it cannot read', () => {
    for (const bad of [
      '', '  ', 'null', '+', '+0', '+01234567', '4155550100x123',
      '+1415555010012345678', 'anything', null, undefined,
    ]) {
      expect(normalizeE164(bad as string)).toBeNull();
    }
  });
});
