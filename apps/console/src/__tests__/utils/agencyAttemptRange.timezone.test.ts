import { describe, it, expect, afterEach } from 'vitest';
import { attemptDateRange } from '../../utils/agencyAttemptFilters';

/**
 * The attempt list's inclusive `to`, across a daylight-saving transition.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * The end of the range used to be the literal `` `${to}T23:59:59.999` ``. That
 * string is **ambiguous** wherever the clocks go back AT midnight — Chile,
 * Paraguay, Cuba and Lebanon all do. In `Asia/Beirut`, 2026-10-25 00:00 sends the
 * clocks to 2026-10-24 23:00, so the wall-clock hour 23:00–23:59 on the 24th
 * happens twice, at two different offsets. JS resolves it to the earlier one, so
 * the range ended an hour before the day did and the last hour of that day's
 * calls was silently absent — beneath rendered copy promising "Both dates are
 * included", which is what makes it a lie rather than a rounding error.
 *
 * ── Why this file is `.timezone.test.ts` ───────────────────────────────────
 * The suite is pinned to UTC, which has no transitions at all, so none of this is
 * expressible there. The suffix puts the file in its own vitest project on
 * `pool: 'forks'`, i.e. the main thread of its own child process, which is the
 * only place a `TZ` change actually moves the clock — on the default `threads`
 * pool `process.env.TZ = …` updates the variable and nothing else, and every
 * assertion below would silently pass in UTC whatever the code did.
 *
 * ── Why the expectations are written as UTC instants ───────────────────────
 * They are what goes on the wire. A local-time expectation would be a
 * restatement of the code's own arithmetic; an absolute instant is a claim about
 * which calls the server will be asked for.
 */

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

afterEach(() => {
  // Also the guard that this file is running where it thinks it is: on the
  // threads pool the zone would never have changed in the first place.
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
});

describe('attemptDateRange across a midnight DST transition', () => {
  it('keeps the repeated last hour when Beirut’s clocks go back at midnight', () => {
    /**
     * 2026-10-25 00:00 EEST → 2026-10-24 23:00 EET. The true end of local
     * 2026-10-24 is 22:00:00Z (the next local day begins then, at UTC+2); the
     * ambiguous literal resolved to 20:59:59.999Z and dropped the whole
     * 21:00–22:00Z hour, which is the SECOND pass through 23:00–24:00 local.
     */
    const range = inZone('Asia/Beirut', () => attemptDateRange('2026-10-24', '2026-10-24'));
    expect(range.to).toBe('2026-10-24T21:59:59.999Z');
    expect(range.from).toBe('2026-10-23T21:00:00.000Z');
  });

  it('keeps the repeated last hour in Santiago too, on its own transition date', () => {
    // Chile ends DST at 00:00 on 2026-04-05, so 2026-04-04's last hour repeats.
    // A fix that special-cased one zone or one date would pass Beirut and fail
    // here.
    const range = inZone('America/Santiago', () => attemptDateRange('2026-04-04', '2026-04-04'));
    expect(range.to).toBe('2026-04-05T03:59:59.999Z');
  });

  it('starts the range at the first instant that exists, when midnight does not', () => {
    /**
     * The mirror image: Cuba springs forward AT midnight on 2026-03-08, so local
     * 00:00 does not exist on that date and the day genuinely begins at 01:00
     * CDT = 05:00Z. This is why both ends are anchored on noon and walked to the
     * day boundary rather than spelled out — noon exists exactly once in every
     * zone there has ever been.
     */
    const range = inZone('America/Havana', () => attemptDateRange('2026-03-08', '2026-03-08'));
    expect(range.from).toBe('2026-03-08T05:00:00.000Z');
    // And the end is one millisecond before local 2026-03-09 00:00, which by then
    // is at CDT (-04:00) rather than CST — the offset moved inside the range.
    expect(range.to).toBe('2026-03-09T03:59:59.999Z');
  });

  it('still covers exactly one local day on an ordinary date', () => {
    // The regression guard on the fix itself: a derived end must not drift on the
    // ~363 days a year that have no transition at all.
    const range = inZone('Asia/Beirut', () => attemptDateRange('2026-08-20', '2026-08-20'));
    expect(range.from).toBe('2026-08-19T21:00:00.000Z');
    expect(range.to).toBe('2026-08-20T20:59:59.999Z');
  });

  it('covers a full 25-hour local day when one exists', () => {
    /**
     * The property, stated arithmetically rather than by instant: the day the
     * clocks go back is 25 hours long, and an inclusive range over it has to be
     * 25 hours wide. The old literal produced 24, which is how the missing hour
     * went unnoticed — nothing looked wrong about the number.
     */
    const range = inZone('Asia/Beirut', () => attemptDateRange('2026-10-24', '2026-10-24'));
    const width = new Date(range.to!).getTime() - new Date(range.from!).getTime();
    expect(width).toBe(25 * 60 * 60 * 1000 - 1);
  });

  it('covers a 23-hour local day when the clocks go forward', () => {
    // And the other direction, so the derivation is not merely "always add an
    // hour": the day Cuba springs forward is 23 hours long.
    const range = inZone('America/Havana', () => attemptDateRange('2026-03-08', '2026-03-08'));
    const width = new Date(range.to!).getTime() - new Date(range.from!).getTime();
    expect(width).toBe(23 * 60 * 60 * 1000 - 1);
  });
});
