import { describe, it, expect } from 'vitest';
import {
  ClockOffsetEstimator,
  offsetFromSample,
  correctedInstant,
  elapsedSince,
  remainingUntil,
  formatDuration,
  CLOCK_SAMPLE_WINDOW,
} from '../../utils/agencyClock';

/**
 * requirement: the countdown *matches the server's timer within a
 * second and does not drift over a shift*.
 *
 * These tests use explicit `now` values rather than a real clock, because the
 * properties being asserted are precisely the ones a real clock hides: a wrong
 * client clock and an accumulating counter both look fine over the few hundred
 * milliseconds a test would otherwise observe.
 */

function sample(ts: number, serverTs: number, receivedAt: number) {
  return { ts, server_ts: serverTs, receivedAt };
}

describe('offset estimation', () => {
  it('recovers a pure clock skew with no network delay', () => {
    // Client thinks it is t=1000; server says 61000. Instant round trip.
    expect(offsetFromSample(sample(1000, 61_000, 1000))).toBe(60_000);
  });

  it('splits the round trip when there is latency', () => {
    // Sent at 1000, received at 1200 → RTT 200 → server observed us at ~1100.
    // Server said 61100, so the clocks actually agree apart from 60s of skew.
    expect(offsetFromSample(sample(1000, 61_100, 1200))).toBe(60_000);
  });

  it('is zero for a perfectly synced clock', () => {
    expect(offsetFromSample(sample(1000, 1100, 1200))).toBe(0);
  });
});

describe('ClockOffsetEstimator', () => {
  it('assumes no correction before any sample has landed', () => {
    // The honest position before a pong: we have no reason to believe the clock
    // is wrong, and inventing an offset would be worse than assuming none.
    expect(ClockOffsetEstimator.empty().offsetMs).toBe(0);
  });

  it('takes a median, so one wifi stall cannot poison the shift', () => {
    // Four clean samples at 60s skew, one catastrophic 3-second stall.
    let est = ClockOffsetEstimator.empty();
    for (const [ts, server, recv] of [
      [1000, 61_000, 1000],
      [2000, 62_000, 2000],
      [3000, 66_500, 6000], // a 3s stall: naive offset is way out
      [4000, 64_000, 4000],
      [5000, 65_000, 5000],
    ] as const) {
      est = est.push(sample(ts, server, recv));
    }

    expect(est.offsetMs).toBe(60_000);

    // A mean over the same samples would be visibly dragged off by the stall —
    // this is the whole reason the estimator is a median.
    const mean = [60_000, 60_000, 60_500, 60_000, 60_000].reduce((a, b) => a + b, 0) / 5;
    expect(mean).not.toBe(60_000);
  });

  it('keeps only the last five samples, so a fixed clock is tracked not baked in', () => {
    let est = ClockOffsetEstimator.empty();
    // Five samples at a 60s skew…
    for (let i = 0; i < 5; i += 1) est = est.push(sample(1000, 61_000, 1000));
    expect(est.offsetMs).toBe(60_000);

    // …then NTP lands and the client clock is corrected. Five more clean samples
    // must fully displace the old ones.
    for (let i = 0; i < 5; i += 1) est = est.push(sample(1000, 1000, 1000));
    expect(est.offsetMs).toBe(0);
    expect(est.sampleCount).toBe(CLOCK_SAMPLE_WINDOW);
  });

  it('is immutable, so it cannot be mutated past a React render', () => {
    const first = ClockOffsetEstimator.empty().push(sample(1000, 61_000, 1000));
    const second = first.push(sample(1000, 1000, 1000));
    expect(first.sampleCount).toBe(1);
    expect(second.sampleCount).toBe(2);
    expect(first).not.toBe(second);
  });
});

describe('correctedInstant', () => {
  it('subtracts the offset so a fast client clock does not skew the deadline', () => {
    // Machine is 90s fast. A server deadline of 12:00:00Z must be rendered
    // against the client's own (wrong) clock, i.e. 90s later in client terms.
    const serverDeadline = '2026-08-11T12:00:00.000Z';
    const offset = -90_000; // server_ts is 90s BEHIND client time
    expect(correctedInstant(serverDeadline, offset)).toBe(Date.parse(serverDeadline) + 90_000);
  });

  it('returns null rather than 0 for absent or unparseable input', () => {
    // 0 is 1970 and would render as a wildly expired deadline — the single
    // worst thing a countdown can do. Null renders no digits, which is right.
    expect(correctedInstant(null, 0)).toBeNull();
    expect(correctedInstant(undefined, 0)).toBeNull();
    expect(correctedInstant('not a date', 0)).toBeNull();
  });

  it('accepts epoch ms as well as ISO-8601', () => {
    expect(correctedInstant(1_000_000, 500)).toBe(999_500);
  });
});

describe('remainingUntil', () => {
  it('clamps at zero rather than counting negative', () => {
    // Reaching the deadline is NOT the end of wrap-up — that arrives on
    // `agent_state` — so the present passing `ends_at` is an expected state.
    // A negative value here would render as an overrun timer pointed at the
    // agent, which is what the clamp exists to prevent.
    const deadline = 1_000_000;
    expect(remainingUntil(deadline, 0, 1_005_000)).toBe(0);
  });

  it('is exact at the boundary', () => {
    expect(remainingUntil(1_000_000, 0, 1_000_000)).toBe(0);
  });

  it('applies the offset to an absolute deadline', () => {
    // Absolute does not mean trustworthy in client time.
    expect(remainingUntil(1_000_000, -5_000, 1_000_000)).toBe(5_000);
  });

  it('is null for an absent deadline, never zero', () => {
    // `ends_at: null` means "no deadline — ends when the agent acts", never
    // "expired". Zero would tell the agent they are out of time when they are not.
    expect(remainingUntil(null, 0, 1_000_000)).toBeNull();
  });
});

describe('elapsedSince', () => {
  it('floors at zero so a just-arrived anchor never reads negative', () => {
    expect(elapsedSince(1_000_000, 0, 999_000)).toBe(0);
  });

  it('measures from the server anchor, not from frame receipt', () => {
    // The talk timer's whole point: a frame that took 400ms to arrive must not
    // restart the clock at 00:00.
    expect(elapsedSince('2026-08-11T12:00:00.000Z', 0, Date.parse('2026-08-11T12:00:09.000Z')))
      .toBe(9_000);
  });
});

describe('formatDuration', () => {
  it('renders m:ss with padded seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9_000)).toBe('0:09');
    expect(formatDuration(69_000)).toBe('1:09');
    expect(formatDuration(600_000)).toBe('10:00');
  });

  it('rolls into h:mm:ss rather than showing eighty-seven minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(5_232_000)).toBe('1:27:12');
  });

  it('floors partial seconds so the digit matches the bar', () => {
    expect(formatDuration(9_999)).toBe('0:09');
  });

  it('never renders a negative duration', () => {
    expect(formatDuration(-5_000)).toBe('0:00');
  });
});
