import { describe, expect, it } from 'vitest';
import { holdBackForInbound, inboundHoldApplies, type InboundHold } from '../../../src/agency/pacing/inbound-hold-back.js';

/**
 * Pacing leaves room for waiting inbound callers (docs/inbound.md §5.2, IQ2): the preferred
 * sessions, then `n` longest-idle candidates, only on campaigns the hold applies to, and never
 * once it has lapsed.
 */

const NOW = 10_000;
/** Longest idle first, as `planTick` sorts them. */
const CANDIDATES = ['s1', 's2', 's3', 's4'].map((sessionId) => ({ sessionId }));

function hold(over: Partial<InboundHold> = {}): InboundHold {
  return { n: 1, preferredSessionIds: new Set(), poolCampaignIds: null, expiresAt: NOW + 5_000, ...over };
}

const ids = (xs: Array<{ sessionId: string }>) => xs.map((x) => x.sessionId);

describe('holdBackForInbound', () => {
  it('no hold: every candidate', () => {
    expect(ids(holdBackForInbound(CANDIDATES, undefined, 'c1', NOW))).toEqual(['s1', 's2', 's3', 's4']);
  });
  it('holds back the n longest idle', () => {
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 2 }), 'c1', NOW))).toEqual(['s3', 's4']);
  });
  it('drops the preferred sessions first, then n of the rest', () => {
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 1, preferredSessionIds: new Set(['s3']) }), 'c1', NOW))).toEqual(['s2', 's4']);
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 0, preferredSessionIds: new Set(['s1']) }), 'c1', NOW))).toEqual(['s2', 's3', 's4']);
  });
  it('n larger than the candidates left: none', () => {
    expect(holdBackForInbound(CANDIDATES, hold({ n: 9 }), 'c1', NOW)).toEqual([]);
  });
  it('only on the pool`s campaigns (null: every campaign of the account; []: none)', () => {
    expect(ids(holdBackForInbound(CANDIDATES, hold({ poolCampaignIds: new Set(['c2']) }), 'c1', NOW))).toEqual(['s1', 's2', 's3', 's4']);
    expect(ids(holdBackForInbound(CANDIDATES, hold({ poolCampaignIds: new Set(['c1']) }), 'c1', NOW))).toEqual(['s2', 's3', 's4']);
    expect(ids(holdBackForInbound(CANDIDATES, hold({ poolCampaignIds: new Set() }), 'c1', NOW))).toEqual(['s1', 's2', 's3', 's4']);
  });
  it('a lapsed hold is ignored (the bus is a hint: the TTL backstop)', () => {
    expect(inboundHoldApplies(hold(), 'c1', NOW + 4_999)).toBe(true);
    expect(inboundHoldApplies(hold(), 'c1', NOW + 5_000)).toBe(false);
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 4 }), 'c1', NOW + 5_000))).toEqual(['s1', 's2', 's3', 's4']);
  });
  it('a hold of nothing (n 0, nobody preferred) changes nothing; the order is kept', () => {
    expect(inboundHoldApplies(hold({ n: 0 }), 'c1', NOW)).toBe(false);
    const out = holdBackForInbound(CANDIDATES, hold({ n: 0 }), 'c1', NOW);
    expect(out).not.toBe(CANDIDATES);
    expect(ids(out)).toEqual(['s1', 's2', 's3', 's4']);
  });
});
