import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { AgentBucketChart } from '../components/agency/AgentBucketChart';
import { bucketSeries } from '../utils/agencyAgentPerformance';
import type { AgencyAgentStatsBucket } from '../types/agency-stats';

/**
 * The day-bucket labels, read from somewhere other than Greenwich.
 *
 * ── Why this file exists at all, and why it is `.timezone.test.tsx` ────────
 * The suite is pinned to `TZ=UTC` (`vite.config.ts`), which is what makes it
 * reproducible on a laptop and on CI. It is also, on its own, what makes this
 * entire class of defect **unfalsifiable**: in UTC, local time and the wire
 * agree, so a value read back in the wrong frame reads correctly anyway.
 * `AgentBucketChart.test.tsx` was green in CI for the whole life of the feature
 * against code that dated every bar a day early for the Americas.
 *
 * So the zone has to be varied deliberately, and that is harder than it looks:
 * Node applies a `TZ` change only when it is assigned on a process's MAIN
 * thread, and the rest of this suite runs on `pool: 'threads'`. A
 * `process.env.TZ = …` inside a worker updates the variable and changes nothing
 * about `new Date()` — the test reads UTC and passes whether the code is right
 * or wrong, which is worse than having no test, because it looks like coverage.
 *
 * The `.timezone.test.tsx` suffix puts this file in its own vitest project on
 * `pool: 'forks'`, i.e. on the main thread of its own child process, which is
 * what makes {@link inZone} real. Anything asserting a zone must live in a file
 * named this way; the same assertions in an ordinary test file are decoration.
 *
 * ── What is under test ─────────────────────────────────────────────────────
 * `bucket_start` is `YYYY-MM-DD` with no time and no offset — the server formats it in
 * SQL precisely so that none attaches. `new Date('2026-08-20')` is the one date
 * literal JS parses as **UTC midnight**, and `getDate()` /
 * `toLocaleDateString()` then read it back in LOCAL time. Under
 * `America/New_York` that is the 19th, and that 19th reached the axis label, the
 * tooltip, the peak label and the accessible table.
 *
 * ── Why the zones are the ones they are ────────────────────────────────────
 * Not a scatter of arbitrary offsets. Each breaks a different naive fix:
 *
 *  · `America/New_York` — behind Greenwich, the direction the original defect
 *    fell in, and where the largest share of this product's agents sit.
 *  · `Pacific/Kiritimati` — UTC+14, the far side. A "just subtract the offset"
 *    fix passes New York and fails here.
 *  · `America/Havana` on 2026-03-08 — the clocks go forward **at midnight**, so
 *    local midnight on that date DOES NOT EXIST. Anything anchored on midnight
 *    is resolving a time that is not on the calendar.
 *  · `Asia/Beirut` on 2026-10-25 — the clocks go back **at midnight**, so the
 *    hour before it happens twice. The mirror image, and between them the reason
 *    the parse is anchored at noon: noon exists exactly once in every zone there
 *    has ever been.
 */

/** Run one assertion with the reader somewhere else. Restored even on failure. */
function inZone<T>(zone: string, run: () => T): T {
  const previous = process.env['TZ'];
  process.env['TZ'] = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previous;
  }
}

function bucket(start: string): AgencyAgentStatsBucket {
  return {
    bucket_start: start,
    attempts: 1,
    connected: 1,
    successes: 0,
    talk_seconds: 0,
    wrapup_seconds: 0,
  };
}

/** Labels and titles for a two-bucket series, so `drawable` is satisfied. */
function labels(zone: string, starts: [string, string]) {
  return inZone(zone, () => {
    const series = bucketSeries([bucket(starts[0]), bucket(starts[1])]);
    return series.points.map((point) => ({ label: point.label, title: point.title }));
  });
}

afterEach(cleanup);

afterEach(() => {
  /*
    Belt and braces, and it is also the assertion that this file is running where
    it thinks it is: `inZone` restores in a `finally`, and the pin means the
    resting zone is UTC. A zone leaking out of a case would silently re-date
    every later one.
  */
  expect(process.env['TZ']).toBe('UTC');
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
});

describe('the running zone is genuinely changeable here', () => {
  it('actually relocates the clock, which the threads pool cannot', () => {
    /**
     * The guard on the guard. Without this, a future change to the pool or to
     * the project globs would turn every case below into a UTC read that passes
     * unconditionally — the failure mode this whole file exists to escape, and
     * one that leaves no trace in the output.
     */
    inZone('America/New_York', () => {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
      expect(new Date('2026-08-20').getDate()).toBe(19);
    });
  });
});

describe('bucket labels are the day the server named', () => {
  it('does not lose a day west of Greenwich', () => {
    expect(labels('America/New_York', ['2026-08-19', '2026-08-20'])).toEqual([
      { label: '19', title: 'Aug 19' },
      { label: '20', title: 'Aug 20' },
    ]);
  });

  it('does not gain a day east of it either', () => {
    // UTC+14. A fix that merely shifted the parse the other way would pass New
    // York and break every agent in the Line Islands.
    expect(labels('Pacific/Kiritimati', ['2026-08-19', '2026-08-20'])).toEqual([
      { label: '19', title: 'Aug 19' },
      { label: '20', title: 'Aug 20' },
    ]);
  });

  it('survives a day whose local midnight does not exist', () => {
    /**
     * Cuba springs forward AT midnight: 2026-03-08 00:00 becomes 01:00, so there
     * is no 00:00 on that date at all. A date anchored on local midnight is being
     * asked to resolve a time that is not on the calendar, and what it resolves
     * to is the engine's business rather than the contract's.
     */
    expect(labels('America/Havana', ['2026-03-07', '2026-03-08'])).toEqual([
      { label: '7', title: 'Mar 7' },
      { label: '8', title: 'Mar 8' },
    ]);
  });

  it('survives a day whose local midnight happens twice', () => {
    /**
     * Lebanon falls back AT midnight: 2026-10-25 00:00 sends the clocks to
     * 2026-10-24 23:00, so that hour occurs at two different offsets.
     */
    expect(labels('Asia/Beirut', ['2026-10-24', '2026-10-25'])).toEqual([
      { label: '24', title: 'Oct 24' },
      { label: '25', title: 'Oct 25' },
    ]);
  });

  it('keeps the raw value for something that is not a day, in any zone', () => {
    /**
     * The malformed-input fallback is unchanged and must stay zone-independent.
     * Dropping the bucket would break the one property this chart can be checked
     * against — that the bars sum to the totals — and would do it silently.
     */
    for (const zone of ['UTC', 'America/New_York', 'Asia/Beirut']) {
      expect(labels(zone, ['not-a-date', '2026-08-20'])[0]).toEqual({
        label: 'not-a-date',
        title: 'not-a-date',
      });
    }
  });

  it('refuses a date that would silently roll over into another month', () => {
    /**
     * `new Date(2026, 12, 45)` is a perfectly good `Date` in February 2027.
     * Labelling a bar with a month the server did not name is worse than
     * labelling it with the string the server did.
     */
    expect(labels('America/New_York', ['2026-13-45', '2026-08-20'])[0]).toEqual({
      label: '2026-13-45',
      title: '2026-13-45',
    });
  });
});

describe('the day reaches the screen intact', () => {
  it('dates the tooltip and the numbers table for a reader in New York', () => {
    /**
     * The parse is unit-tested above; this asserts the day survives the whole
     * render, because every one of the four places a date appears on this chart
     * — axis label, group tooltip, peak label, accessible table — reads it back
     * through the same helper and all four were wrong together.
     */
    inZone('America/New_York', () => {
      render(<AgentBucketChart series={bucketSeries([bucket('2026-08-19'), bucket('2026-08-20')])} />);

      expect(screen.getByTestId('bucket-2026-08-19').querySelector('title')?.textContent).toBe(
        'Aug 19: 1 dials, 1 conversations',
      );

      fireEvent.click(screen.getByRole('button', { name: /show the numbers/i }));
      const table = screen.getByTestId('bucket-chart-table');
      expect(within(table).getByText('Aug 19')).toBeTruthy();
      expect(within(table).getByText('Aug 20')).toBeTruthy();
    });
  });
});
