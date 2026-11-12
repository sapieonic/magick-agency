import { describe, expect, it } from 'vitest';
import {
  ackOf,
  homeAckDay,
  splitAcknowledged,
  stillAcknowledged,
  todaysAcks,
  type HomeAck,
} from '../../utils/agency/homeAcks';
import type { HomeTone } from '../../utils/agency/home';

/**
 * Home's "Got it" rules (B28a): a row put aside stays aside until it gets worse (its count grows,
 * or its kind or tone changes) or until the reader's next local midnight (the zones are in
 * `agencyHome.timezone.test.ts`; this project runs in UTC).
 */

const row = (id: string, kind: string, tone: HomeTone, count: number | null) => ({ id, kind, tone, count });

describe('stillAcknowledged', () => {
  const ack: HomeAck = { kind: 'callbacks-overdue', tone: 'danger', count: 3 };

  it('holds while the count is the same or lower', () => {
    expect(stillAcknowledged(row('a', 'callbacks-overdue', 'danger', 3), ack)).toBe(true);
    expect(stillAcknowledged(row('a', 'callbacks-overdue', 'danger', 1), ack)).toBe(true);
  });

  it('lets go when the count grows, the tone changes or the kind changes', () => {
    expect(stillAcknowledged(row('a', 'callbacks-overdue', 'danger', 4), ack)).toBe(false);
    expect(stillAcknowledged(row('a', 'callbacks-overdue', 'warning', 3), ack)).toBe(false);
    expect(stillAcknowledged(row('a', 'held-by-absent', 'danger', 3), ack)).toBe(false);
    expect(stillAcknowledged(row('a', 'callbacks-overdue', 'danger', 3), undefined)).toBe(false);
  });

  it('a row that counts nothing holds on its kind and tone (a stall’s code; near to over the ceiling)', () => {
    const stall = ackOf(row('stall:c1', 'stall:no_carrier_capacity', 'danger', null));
    expect(stillAcknowledged(row('stall:c1', 'stall:no_carrier_capacity', 'danger', null), stall)).toBe(true);
    expect(stillAcknowledged(row('stall:c1', 'stall:dnc_unavailable', 'danger', null), stall)).toBe(false);
    const near = ackOf(row('abandonment:c1', 'abandonment', 'warning', null));
    expect(stillAcknowledged(row('abandonment:c1', 'abandonment', 'danger', null), near)).toBe(false);
  });
});

describe('rows that may not be put aside', () => {
  it('a row whose count cannot grow is never still acknowledged', () => {
    const capped = { ...row('missed', 'missed', 'warning', 100), ackable: false };
    expect(stillAcknowledged(capped, ackOf(capped))).toBe(false);
    expect(splitAcknowledged([capped], { missed: ackOf(capped) }).open).toEqual([capped]);
    expect(stillAcknowledged({ ...capped, ackable: true }, ackOf(capped))).toBe(true);
  });
});

describe('the day', () => {
  it('is the reader’s calendar day (UTC here)', () => {
    expect(homeAckDay(new Date('2026-11-12T23:59:00Z'))).toBe('2026-11-12');
    expect(homeAckDay(new Date('2026-11-13T00:01:00Z'))).toBe('2026-11-13');
  });

  it('drops another day’s acknowledgements and anything unreadable', () => {
    const acks = { a: { kind: 'missed', tone: 'warning', count: 2 } };
    expect(todaysAcks({ day: '2026-11-12', acks }, '2026-11-12')).toEqual(acks);
    expect(todaysAcks({ day: '2026-11-11', acks }, '2026-11-12')).toEqual({});
    expect(todaysAcks('nonsense', '2026-11-12')).toEqual({});
    expect(todaysAcks(null, '2026-11-12')).toEqual({});
    expect(todaysAcks({ day: '2026-11-12', acks: { a: { kind: 'x', tone: 'loud', count: 1 }, b: { kind: 'y', tone: 'info', count: 'two' } } }, '2026-11-12')).toEqual({});
  });
});

describe('splitAcknowledged', () => {
  it('keeps the list’s order on both sides', () => {
    const items = [row('1', 'k', 'danger', 1), row('2', 'k', 'danger', 1), row('3', 'k', 'info', null)];
    const { open, acknowledged } = splitAcknowledged(items, { 2: ackOf(items[1]!), 3: ackOf(items[2]!) });
    expect(open.map((i) => i.id)).toEqual(['1']);
    expect(acknowledged.map((i) => i.id)).toEqual(['2', '3']);
  });
});
