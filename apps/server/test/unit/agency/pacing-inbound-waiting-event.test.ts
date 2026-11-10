import { describe, expect, it, vi } from 'vitest';

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  INBOUND_WAITING_LIMITS,
  InProcessPacingInvalidationBus,
  parsePacingInvalidationEvent,
  type PacingInvalidationEvent,
} from '../../../src/agency/pacing/invalidation-bus.js';

/*
 * The `inbound_waiting` pacing bus event (docs/inbound.md §5.2, P2): plain JSON that round-trips
 * through the wire format every event takes, bounded so a malformed or hostile publisher (an IPC
 * peer) cannot hand pacing an unbounded list or a hold that never lapses. No consumer yet (WP-C).
 */

const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'inbound_waiting', tenantId: T, accountId: A, n: 2,
    preferredSessionIds: ['s-1'], poolCampaignIds: ['c-1', 'c-2'], ttlMs: 5_000,
    ...over,
  };
}

describe('inbound_waiting', () => {
  it('round-trips through the bus exactly as published', () => {
    const bus = new InProcessPacingInvalidationBus();
    const seen: PacingInvalidationEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const published: PacingInvalidationEvent = {
      type: 'inbound_waiting', tenantId: T, accountId: A, n: 3,
      preferredSessionIds: ['s-1', 's-2'], poolCampaignIds: null, ttlMs: 4_000,
    };
    bus.publish(published);
    expect(seen).toEqual([published]);
    // `n = 0` with no ids is the lift, and is delivered too.
    bus.publish({ ...published, n: 0, preferredSessionIds: [] });
    expect(seen[1]).toMatchObject({ n: 0, preferredSessionIds: [] });
  });

  it('a pool of null is the whole account; an absent one reads as null; an empty one stays empty', () => {
    expect(parsePacingInvalidationEvent(event({ poolCampaignIds: null }))).toMatchObject({ poolCampaignIds: null });
    const { poolCampaignIds: _omit, ...absent } = event();
    expect(parsePacingInvalidationEvent(absent)).toMatchObject({ poolCampaignIds: null });
    expect(parsePacingInvalidationEvent(event({ poolCampaignIds: [] }))).toMatchObject({ poolCampaignIds: [] });
  });

  it('clamps the hold into its range, and de-duplicates the ids', () => {
    expect(parsePacingInvalidationEvent(event({ ttlMs: 0 }))).toMatchObject({ ttlMs: INBOUND_WAITING_LIMITS.TTL_MS.min });
    expect(parsePacingInvalidationEvent(event({ ttlMs: 86_400_000 }))).toMatchObject({ ttlMs: INBOUND_WAITING_LIMITS.TTL_MS.max });
    expect(parsePacingInvalidationEvent(event({ ttlMs: 2_500.4 }))).toMatchObject({ ttlMs: 2_500 });
    expect(parsePacingInvalidationEvent(event({ preferredSessionIds: ['s-1', 's-1', 's-2'] })))
      .toMatchObject({ preferredSessionIds: ['s-1', 's-2'] });
  });

  it('takes the bounds themselves', () => {
    const ids = Array.from({ length: INBOUND_WAITING_LIMITS.MAX_IDS }, (_, i) => `s-${i}`);
    expect(parsePacingInvalidationEvent(event({ n: INBOUND_WAITING_LIMITS.MAX_N, preferredSessionIds: ids, poolCampaignIds: ids })))
      .toMatchObject({ n: INBOUND_WAITING_LIMITS.MAX_N });
    expect(parsePacingInvalidationEvent(event({ n: 0 }))).toMatchObject({ n: 0 });
  });

  it.each([
    ['a missing tenant', { tenantId: undefined }],
    ['an empty account', { accountId: '' }],
    ['a negative count', { n: -1 }],
    ['a fractional count', { n: 1.5 }],
    ['a count past the bound', { n: INBOUND_WAITING_LIMITS.MAX_N + 1 }],
    ['a count as a string', { n: '2' }],
    ['preferred sessions that are not a list', { preferredSessionIds: 's-1' }],
    ['a missing preferred list', { preferredSessionIds: undefined }],
    ['a preferred id that is not an id', { preferredSessionIds: ['s-1', 7] }],
    ['an over-long id', { preferredSessionIds: ['x'.repeat(129)] }],
    ['too many preferred ids', { preferredSessionIds: Array.from({ length: INBOUND_WAITING_LIMITS.MAX_IDS + 1 }, (_, i) => `s-${i}`) }],
    ['too many pool ids', { poolCampaignIds: Array.from({ length: INBOUND_WAITING_LIMITS.MAX_IDS + 1 }, (_, i) => `c-${i}`) }],
    ['a pool that is not a list', { poolCampaignIds: 'c-1' }],
    ['a missing hold', { ttlMs: undefined }],
    ['a hold that is not finite', { ttlMs: Number.POSITIVE_INFINITY }],
  ])('drops %s', (_label, over) => {
    expect(parsePacingInvalidationEvent(event(over as Record<string, unknown>))).toBeNull();
  });

  it('a malformed event never reaches a subscriber', () => {
    const bus = new InProcessPacingInvalidationBus();
    const handler = vi.fn();
    bus.subscribe(handler);
    bus.publish(event({ n: -1 }) as unknown as PacingInvalidationEvent);
    expect(handler).not.toHaveBeenCalled();
  });
});
