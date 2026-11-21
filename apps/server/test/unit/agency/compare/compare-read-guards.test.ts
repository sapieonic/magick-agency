import { describe, expect, it } from 'vitest';
import type { AgencyCompareMetricInfo } from '@magick-agency/contracts/api/agency/compare';
import { compareCacheKey, TenantReadLimiter, type CompareQueryRead } from '../../../../src/agency/compare/read.js';

/**
 * Compare agents' guards that need no database (docs/compare-agents.md §7): the per-tenant limit and
 * the cache key. The limit refusing, the timeout and the cache serving are held on real Postgres in
 * `test/integration/api/compare-agents.test.ts`.
 */

describe('TenantReadLimiter', () => {
  it('admits up to the limit per tenant, refuses past it, and never across tenants', () => {
    const limiter = new TenantReadLimiter(2);
    const r1 = limiter.tryAcquire('t1');
    const r2 = limiter.tryAcquire('t1');
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(limiter.tryAcquire('t1')).toBeNull();
    expect(limiter.tryAcquire('t2')).not.toBeNull();
    r1!();
    expect(limiter.inFlight('t1')).toBe(1);
    expect(limiter.tryAcquire('t1')).not.toBeNull();
  });

  it('a release is idempotent: a second call cannot free a slot someone else holds', () => {
    const limiter = new TenantReadLimiter(1);
    const release = limiter.tryAcquire('t')!;
    release();
    const other = limiter.tryAcquire('t');
    expect(other).not.toBeNull();
    release();
    expect(limiter.inFlight('t')).toBe(1);
    expect(limiter.tryAcquire('t')).toBeNull();
  });

  it('refuses a limit that is not a positive integer', () => {
    expect(() => new TenantReadLimiter(0)).toThrow(RangeError);
  });
});

describe('compareCacheKey', () => {
  const metric = (id: string) => ({ id }) as AgencyCompareMetricInfo;
  const base: CompareQueryRead = {
    tenantId: 't', accountId: 'acc', campaignId: 'c', from: '2026-11-01', to: '2026-11-02', timezone: 'Asia/Kolkata',
    start: new Date(0), end: new Date(1), agentIds: ['a', 'b'], metrics: [metric('success_rate'), metric('outcomes:higher:x')], trend: null,
  };
  const key = (o: Partial<CompareQueryRead>) => compareCacheKey({ ...base, ...o });

  it('keys by tenant, account (the caller\'s scope), campaign, window, zone, agents in order, metric ids in order and the trend', () => {
    const k = key({});
    for (const o of [
      { tenantId: 't2' }, { accountId: 'acc2' }, { campaignId: 'c2' }, { from: '2026-10-31' }, { to: '2026-11-03' },
      { timezone: 'UTC' }, { agentIds: ['b', 'a'] }, { metrics: [metric('outcomes:higher:x'), metric('success_rate')] },
      { trend: metric('outcomes:higher:x') },
    ] satisfies Array<Partial<CompareQueryRead>>) {
      expect(key(o), JSON.stringify(o)).not.toBe(k);
    }
  });

  it('a label is not part of the key (the id carries no label)', () => {
    const labelled = { ...metric('outcomes:higher:x'), label: 'Pays' } as AgencyCompareMetricInfo;
    expect(key({ metrics: [metric('success_rate'), labelled] })).toBe(key({}));
  });
});
