import { describe, expect, it } from 'vitest';
import { holdBackForInbound, inboundHoldApplies, type InboundHold } from '../../../src/agency/pacing/inbound-hold-back.js';

/**
 * Pacing leaves room for waiting inbound callers (docs/inbound.md §5.2, IQ2): the preferred
 * sessions, then `n` longest-idle candidates, only on campaigns the hold applies to, and never
 * once it has lapsed; only stations that can take inbound calls (IQ46).
 */

const NOW = 10_000;
/** Longest idle first, as `planTick` sorts them. */
const CANDIDATES = ['s1', 's2', 's3', 's4'].map((sessionId) => ({ sessionId }));

function hold(over: Partial<InboundHold> = {}): InboundHold {
  return { n: 1, preferredSessionIds: new Set(), poolCampaignIds: null, expiresAt: NOW + 5_000, ...over };
}

const ids = (xs: ReadonlyArray<{ sessionId: string }>) => xs.map((x) => x.sessionId);
/** Every station can take inbound calls (a console, or a phone with `caps=inbound`). */
const ALL_CAN = () => true;
/** Every station but these (older app builds, no `caps=inbound`). */
const allBut = (...old: string[]) => (sessionId: string) => !old.includes(sessionId);

describe('holdBackForInbound', () => {
  it('no hold: every candidate', () => {
    expect(ids(holdBackForInbound(CANDIDATES, undefined, 'c1', NOW, ALL_CAN))).toEqual(['s1', 's2', 's3', 's4']);
  });
  it('holds back the n longest idle', () => {
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 2 }), 'c1', NOW, ALL_CAN))).toEqual(['s3', 's4']);
  });
  it('drops the preferred sessions first, then n of the rest', () => {
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 1, preferredSessionIds: new Set(['s3']) }), 'c1', NOW, ALL_CAN))).toEqual(['s2', 's4']);
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 0, preferredSessionIds: new Set(['s1']) }), 'c1', NOW, ALL_CAN))).toEqual(['s2', 's3', 's4']);
  });
  it('n larger than the candidates left: none', () => {
    expect(holdBackForInbound(CANDIDATES, hold({ n: 9 }), 'c1', NOW, ALL_CAN)).toEqual([]);
  });
  it('only on the pool`s campaigns (null: every campaign of the account; []: none)', () => {
    expect(ids(holdBackForInbound(CANDIDATES, hold({ poolCampaignIds: new Set(['c2']) }), 'c1', NOW, ALL_CAN))).toEqual(['s1', 's2', 's3', 's4']);
    expect(ids(holdBackForInbound(CANDIDATES, hold({ poolCampaignIds: new Set(['c1']) }), 'c1', NOW, ALL_CAN))).toEqual(['s2', 's3', 's4']);
    expect(ids(holdBackForInbound(CANDIDATES, hold({ poolCampaignIds: new Set() }), 'c1', NOW, ALL_CAN))).toEqual(['s1', 's2', 's3', 's4']);
  });
  it('a lapsed hold is ignored (the bus is a hint: the TTL backstop)', () => {
    expect(inboundHoldApplies(hold(), 'c1', NOW + 4_999)).toBe(true);
    expect(inboundHoldApplies(hold(), 'c1', NOW + 5_000)).toBe(false);
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 4 }), 'c1', NOW + 5_000, ALL_CAN))).toEqual(['s1', 's2', 's3', 's4']);
  });
  it('a station that cannot take inbound calls is never held back nor counted toward n (IQ46)', () => {
    // s1 and s3 are older app builds: the two held back are the two longest idle that can take a caller.
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 2 }), 'c1', NOW, allBut('s1', 's3')))).toEqual(['s1', 's3']);
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 1 }), 'c1', NOW, allBut('s1')))).toEqual(['s1', 's3', 's4']);
    // n larger than the stations that can take a caller: only those are held.
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 9 }), 'c1', NOW, allBut('s2')))).toEqual(['s2']);
  });
  it('a preferred session whose station cannot take inbound calls is kept (it is never offered the caller)', () => {
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 0, preferredSessionIds: new Set(['s1', 's2']) }), 'c1', NOW, allBut('s1'))))
      .toEqual(['s1', 's3', 's4']);
    expect(ids(holdBackForInbound(CANDIDATES, hold({ n: 1, preferredSessionIds: new Set(['s2']) }), 'c1', NOW, allBut('s2', 's1'))))
      .toEqual(['s1', 's2', 's4']);
  });
  it('a hold of nothing (n 0, nobody preferred) changes nothing: the candidates themselves, not a copy', () => {
    expect(inboundHoldApplies(hold({ n: 0 }), 'c1', NOW)).toBe(false);
    const out = holdBackForInbound(CANDIDATES, hold({ n: 0 }), 'c1', NOW, ALL_CAN);
    expect(out).toBe(CANDIDATES);
    expect(ids(out)).toEqual(['s1', 's2', 's3', 's4']);
  });
});
