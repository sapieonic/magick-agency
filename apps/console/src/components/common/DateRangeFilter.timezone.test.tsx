import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState, useCallback } from 'react';
import { DateRangeFilter, type DateRangeValue } from './DateRangeFilter';

/**
 * The "Last 7 days" lower bound, read from a zone that springs forward.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `startOfDaysAgo` subtracts days by CALENDAR arithmetic — `new Date(y, m,
 * d - 6)`, which `Date` normalizes — rather than by subtracting
 * `6 * 86_400_000` milliseconds from local midnight. The two agree everywhere
 * except across a daylight-saving transition inside the window: a spring-forward
 * makes the six-day span 143 hours rather than 144, so the millisecond form
 * lands at 23:00 on the day BEFORE the one it means. `getDate()` then reads a
 * day early, the emitted `from` is a day early with it, and the filter that says
 * "Last 7 days" quietly asks the server for eight — on a call list where the
 * count is the thing being read.
 *
 * ── Why this file is `.timezone.test.tsx`, and why the assertion moved here ─
 * It was written as an ordinary `it` inside `DateRangeFilter.test.tsx`, naming
 * the bug exactly and setting `process.env.TZ = 'America/New_York'` to reproduce
 * it. It could not. That file runs in the `unit` project on `pool: 'threads'`
 * (`vite.config.ts`), and Node applies a `TZ` change only when it is assigned on
 * a process's MAIN thread — inside a worker the assignment updates the variable
 * and changes nothing about `new Date()`. So the test read UTC, which has no
 * transitions at all, and passed against the millisecond form as readily as
 * against the calendar one: replacing the arithmetic with the very subtraction
 * the comment forbids left the file 26/26 green.
 *
 * The `.timezone.test.tsx` suffix puts the file in its own vitest project on
 * `pool: 'forks'` — the main thread of its own child process — which is the only
 * place {@link inZone} is real. `agencyAttemptRange.timezone.test.ts` and
 * `agencyBucketDates.timezone.test.tsx` are the two existing residents.
 *
 * Only this one assertion moved. The other twenty-five say nothing about a zone
 * and belong in the pinned-UTC project, where they cost no process spawn.
 */

/** Controlled wrapper, matching how the list pages drive the component. */
function Harness({ onApply }: { onApply: (range: DateRangeValue | undefined) => void }) {
  const [value, setValue] = useState<DateRangeValue | undefined>(undefined);
  const handle = useCallback(
    (range: DateRangeValue | undefined) => {
      setValue(range);
      onApply(range);
    },
    [onApply],
  );
  return <DateRangeFilter value={value} onApply={handle} />;
}

/**
 * Run `body` with the process in `zone`, restoring whatever was there before.
 *
 * The zone is asserted to have actually taken, which is the assertion that keeps
 * everything below falsifiable: on the `threads` pool the switch is a no-op and
 * every expectation in this file would be read in UTC and pass whatever the code
 * did. Nothing else here can tell the difference, so this has to.
 */
function inZone<T>(zone: string, body: () => T): T {
  const previous = process.env['TZ'];
  try {
    process.env['TZ'] = zone;
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
    return body();
  } finally {
    if (previous === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previous;
  }
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('DateRangeFilter — Last 7 days across a spring-forward', () => {
  it('lands six calendar days back, not on the hour six days of milliseconds back', () => {
    inZone('America/New_York', () => {
      // 2026's US spring-forward is 8 March. A clock just after midnight on the
      // 11th puts the lost hour inside the six-day window and nothing else:
      // 144 hours before 11 Mar 00:00 EDT is 4 Mar 23:00 EST.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 2, 11, 0, 30, 0));

      const onApply = vi.fn<(range: DateRangeValue | undefined) => void>();
      render(<Harness onApply={onApply} />);
      fireEvent.click(screen.getByRole('button', { name: /Last 7 days/ }));

      const emitted = onApply.mock.calls[0];
      expect(emitted, 'the preset emitted no range').toBeDefined();
      const range = emitted![0];
      expect(range, 'the preset emitted a clear rather than a range').toBeDefined();

      const from = new Date(range!.from!);
      // 11 March minus six calendar days is the 5th. The millisecond form says
      // the 4th at 23:00, which is a window of eight days, not seven.
      expect(from.getMonth()).toBe(2);
      expect(from.getDate()).toBe(5);
      expect(from.getHours()).toBe(0);
    });
  });
});
