import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BACKOFF_MS,
  FLAP_LIMIT,
  FLAP_WINDOW_MS,
  MISSED_PING_LIMIT,
  backoffFor,
  recordLiveThenDead,
  silentTooLong,
  withDeadline,
} from '../../utils/agencyStationLiveness';

afterEach(() => {
  vi.useRealTimers();
});

describe('backoffFor — the client’s own retry ladder', () => {
  it('walks the ladder and holds at the ceiling', () => {
    expect(BACKOFF_MS.map((_, i) => backoffFor(i))).toEqual([...BACKOFF_MS]);
    expect(backoffFor(BACKOFF_MS.length + 10)).toBe(15_000);
  });
});

describe('silentTooLong — silence is evidence only once we have asked', () => {
  const HEARTBEAT = 10_000;

  it('is false with nothing outstanding, however long', () => {
    expect(silentTooLong(0, 1e12, HEARTBEAT)).toBe(false);
  });

  it('turns at exactly MISSED_PING_LIMIT intervals of an unanswered ping', () => {
    const sent = 1_000;
    expect(MISSED_PING_LIMIT).toBe(3);
    expect(silentTooLong(sent, sent + 3 * HEARTBEAT - 1, HEARTBEAT)).toBe(false);
    expect(silentTooLong(sent, sent + 3 * HEARTBEAT, HEARTBEAT)).toBe(true);
  });
});

describe('recordLiveThenDead — the flap cap', () => {
  it('flaps on the cycle after FLAP_LIMIT inside the window', () => {
    let stamps: number[] = [];
    let flapping = false;
    for (let i = 0; i < FLAP_LIMIT; i += 1) {
      ({ stamps, flapping } = recordLiveThenDead(stamps, i * 1_000));
      expect(flapping).toBe(false);
    }
    ({ flapping } = recordLiveThenDead(stamps, FLAP_LIMIT * 1_000));
    expect(flapping).toBe(true);
  });

  it('forgets cycles older than the window, so a slow pattern never flaps', () => {
    let stamps: number[] = [];
    let flapping = false;
    for (let i = 0; i < FLAP_LIMIT * 3; i += 1) {
      ({ stamps, flapping } = recordLiveThenDead(stamps, i * FLAP_WINDOW_MS));
      expect(flapping).toBe(false);
      expect(stamps).toHaveLength(1);
    }
  });

  it('does not mutate the array it was given', () => {
    const given = [1, 2];
    recordLiveThenDead(given, 3);
    expect(given).toEqual([1, 2]);
  });
});

describe('withDeadline — a bound on a request that has none', () => {
  it('rejects with the message once the deadline passes', async () => {
    vi.useFakeTimers();
    const hung = withDeadline(new Promise(() => {}), 15_000, 'too slow');
    const settled = expect(hung).rejects.toThrow('too slow');
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
  });

  it('resolves with the value and leaves no timer behind', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.resolve('ok'), 15_000, 'too slow')).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });
});
