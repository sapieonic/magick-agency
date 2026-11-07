import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dedicatedCallerIdOf,
  NO_DEDICATED_CALLER_IDS,
  pickCallerId,
  resolveCallerId,
  rotationCallerIds,
} from '../../../src/agency/pacing/caller-id-pool.js';

/*
 * The one caller-ID rule every dial path uses (decisions DN2, DN3): the contact's owner's
 * dedicated number while the campaign still has it, else the rotation (the usable numbers minus
 * every dedicated one, or all of them when every one is dedicated), else null on an empty pool.
 * The wrap-up redial's previous number (`sticky`, WR7) is kept only while it is in the rotation.
 *
 * Mutation-checked: making `dedicatedCallerIdOf` skip the "still usable" test reds "a stale
 * dedication"; returning `[...usable]` from `rotationCallerIds` reds "the rotation excludes".
 */

const USABLE = ['+918041000001', '+918041000002', '+918041000003'];

afterEach(() => vi.useRealTimers());

describe('dedicatedCallerIdOf', () => {
  it('the owner\'s number while it is usable; else null', () => {
    const dedicated = new Map([['a', '+918041000002'], ['b', '+919999999999']]);
    expect(dedicatedCallerIdOf(USABLE, dedicated, 'a')).toBe('+918041000002');
    expect(dedicatedCallerIdOf(USABLE, dedicated, 'b')).toBeNull();
    expect(dedicatedCallerIdOf(USABLE, dedicated, 'c')).toBeNull();
    expect(dedicatedCallerIdOf(USABLE, dedicated, null)).toBeNull();
    expect(dedicatedCallerIdOf(USABLE, dedicated, undefined)).toBeNull();
    expect(dedicatedCallerIdOf([], dedicated, 'a')).toBeNull();
  });
});

describe('rotationCallerIds (DN3)', () => {
  it('no dedications: the usable list, in order (a copy)', () => {
    const r = rotationCallerIds(USABLE, NO_DEDICATED_CALLER_IDS);
    expect(r).toEqual(USABLE);
    expect(r).not.toBe(USABLE);
  });

  it('the rotation excludes every dedicated number, whoever holds it', () => {
    const dedicated = new Map([['a', '+918041000002'], ['b', '+918041000003']]);
    expect(rotationCallerIds(USABLE, dedicated)).toEqual(['+918041000001']);
  });

  it('a dedicated number the campaign no longer has removes nothing', () => {
    expect(rotationCallerIds(USABLE, new Map([['a', '+919999999999']]))).toEqual(USABLE);
  });

  it('every usable number dedicated: the full list, so the campaign never halts', () => {
    const dedicated = new Map(USABLE.map((n, i) => [`u${i}`, n]));
    expect(rotationCallerIds(USABLE, dedicated)).toEqual(USABLE);
  });

  it('empty usable list: empty, whatever is dedicated', () => {
    expect(rotationCallerIds([], new Map([['a', '+918041000001']]))).toEqual([]);
  });
});

describe('resolveCallerId (DN2)', () => {
  const dedicated = new Map([['a', '+918041000002'], ['b', '+918041000003']]);

  it('the owner\'s dedicated number, whatever the offset', () => {
    for (const offset of [0, 1, 2, 7]) {
      expect(resolveCallerId({ usable: USABLE, dedicated, ownerUserId: 'a', offset })).toBe('+918041000002');
    }
  });

  it('a stale dedication (the campaign dropped the number) falls to the rotation', () => {
    const stale = new Map([['a', '+919999999999'], ['b', '+918041000003']]);
    for (const offset of [0, 1, 2]) {
      const picked = resolveCallerId({ usable: USABLE, dedicated: stale, ownerUserId: 'a', offset });
      expect(['+918041000001', '+918041000002']).toContain(picked);
    }
  });

  it('an unowned contact, or one whose owner has no number, rotates over the undedicated numbers only', () => {
    const seen = new Set<string | null>();
    for (let offset = 0; offset < 20; offset++) {
      seen.add(resolveCallerId({ usable: USABLE, dedicated, ownerUserId: null, offset }));
      seen.add(resolveCallerId({ usable: USABLE, dedicated, ownerUserId: 'c', offset }));
    }
    expect([...seen]).toEqual(['+918041000001']);
  });

  it('the rotation is round-robin over what is left (pickCallerId over rotationCallerIds)', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const one = new Map([['a', '+918041000003']]);
    const rotation = rotationCallerIds(USABLE, one);
    for (let offset = 0; offset < 4; offset++) {
      expect(resolveCallerId({ usable: USABLE, dedicated: one, ownerUserId: null, offset })).toBe(pickCallerId(rotation, offset));
    }
    expect(new Set([0, 1].map((offset) => resolveCallerId({ usable: USABLE, dedicated: one, ownerUserId: null, offset }))))
      .toEqual(new Set(['+918041000001', '+918041000002']));
  });

  it('every number dedicated: an unowned contact shares them all', () => {
    const all = new Map(USABLE.map((n, i) => [`u${i}`, n]));
    const seen = new Set(Array.from({ length: 6 }, (_, offset) => resolveCallerId({ usable: USABLE, dedicated: all, ownerUserId: null, offset })));
    expect(seen).toEqual(new Set(USABLE));
  });

  it('empty pool: null, even for an owner with a number (pickCallerId\'s contract)', () => {
    expect(resolveCallerId({ usable: [], dedicated, ownerUserId: 'a', offset: 0 })).toBeNull();
    expect(resolveCallerId({ usable: [], dedicated: NO_DEDICATED_CALLER_IDS, ownerUserId: null, offset: 3 })).toBeNull();
  });

  it('sticky (WR7): kept while in the rotation; a number since dedicated to someone else is not reused', () => {
    expect(resolveCallerId({ usable: USABLE, dedicated, ownerUserId: null, offset: 0, sticky: '+918041000001' })).toBe('+918041000001');
    // Dedicated to b since: not reused for a contact that is not b's.
    expect(resolveCallerId({ usable: USABLE, dedicated, ownerUserId: null, offset: 0, sticky: '+918041000003' })).toBe('+918041000001');
    // No longer on the campaign at all.
    expect(resolveCallerId({ usable: USABLE, dedicated, ownerUserId: null, offset: 0, sticky: '+919999999999' })).toBe('+918041000001');
    // The owner's number wins over the previous one.
    expect(resolveCallerId({ usable: USABLE, dedicated, ownerUserId: 'a', offset: 0, sticky: '+918041000001' })).toBe('+918041000002');
    // Every number dedicated: the rotation is the full list, so the previous number is kept.
    const all = new Map(USABLE.map((n, i) => [`u${i}`, n]));
    expect(resolveCallerId({ usable: USABLE, dedicated: all, ownerUserId: null, offset: 0, sticky: '+918041000003' })).toBe('+918041000003');
  });
});
