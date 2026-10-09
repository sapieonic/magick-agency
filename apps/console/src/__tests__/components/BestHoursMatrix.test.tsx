import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { BestHoursMatrix } from '../../components/agency/BestHoursMatrix';
import {
  bestHoursMatrix,
  bestHoursZone,
  weekdayCoverage,
  type BestHoursView,
} from '../../utils/agencyBestHours';
import {
  FIXTURE_ZONE,
  SHORT_DAY,
  SHORT_FROM,
  SHORT_TO,
  bestHoursPage,
  hollowHourCell,
  hourCell,
  thinHourCell,
} from '../helpers/bestHours';
import type { AgencyGroupPage } from '../../types/agency-stats';

/**
 * The matrix, rendered from props — no hook, no network.
 *
 * ── What the DOM has to prove ─────────────────────────────────────────────
 *  - **A thin cell carries no ramp step.** The colour lives in `data-step`, so a
 *    withheld cell having none is the assertable form of "never coloured on the rate
 *    ramp". Not a pale step, not the bottom step: no step.
 *  - **Every cell carries its number.** A measured cell its rate, a cell off the
 *    ramp its dial count, and only a never-asked cell nothing at all.
 *  - **The hour axis names the campaign's zone, or names none.**
 *  - **An out-of-window row is marked as one**, on the row header as well as in the
 *    cells — a blank row beside a normal-weight weekday label is exactly the
 *    misreading.
 *
 * `agencyBestHours.test.ts` owns the derivations; this file owns what reaches the
 * screen.
 */

function renderMatrix(
  page: AgencyGroupPage = bestHoursPage(),
  view: BestHoursView = 'connect_rate',
) {
  const zone = bestHoursZone(page);
  const matrix = bestHoursMatrix(page, view, weekdayCoverage(page.from, page.to, zone));
  render(<BestHoursMatrix matrix={matrix} zone={zone} caption="When Renewals connects" />);
  return { matrix, zone };
}

function cell(day: number, hour: number): HTMLElement {
  return screen.getByTestId(`best-hours-cell-${day}-${hour}`);
}

function swatch(day: number, hour: number): HTMLElement {
  const inner = cell(day, hour).querySelector('span');
  if (inner === null) throw new Error(`no swatch in cell ${day}:${hour}`);
  return inner as HTMLElement;
}

afterEach(() => cleanup());

describe('BestHoursMatrix — the grid', () => {
  it('renders seven rows of twenty-four cells', () => {
    renderMatrix();
    for (let day = 0; day < 7; day += 1) {
      const row = screen.getByTestId(`best-hours-row-${day}`);
      expect(within(row).getAllByRole('cell')).toHaveLength(24);
    }
  });

  it('names the hour axis with the CAMPAIGN’s zone', () => {
    renderMatrix();
    expect(screen.getByTestId('best-hours-axis-zone').textContent).toContain('Asia/Kolkata');
  });

  it('renders NO zone on the axis when the field did not arrive', () => {
    /**
     * E3: absent means the matrix renders without an hour-axis zone label. It does not
     * guess, and it does not fall back to the reader's — the surface says the zone
     * could not be read instead (`BestHours.test.tsx` pins that sentence).
     */
    renderMatrix(bestHoursPage({ resolved_timezone: undefined }));
    expect(screen.queryByTestId('best-hours-axis-zone')).toBeNull();
  });
});

describe('BestHoursMatrix — E5, a thin cell is off the ramp', () => {
  it('gives a measured cell a ramp step and a thin cell none', () => {
    /**
     * The mutation this case exists for: giving the thin cell `data-step="0"` to "keep
     * the grid even" puts a 50%-on-two-dials cell back on the scale as its palest
     * step, which reads as a low value rather than an absent one.
     */
    renderMatrix(
      bestHoursPage({ rows: [hourCell({ day: 1, hour: 10, attempts: 300 }), thinHourCell()] }),
    );
    expect(swatch(1, 10).getAttribute('data-state')).toBe('measured');
    expect(swatch(1, 10).getAttribute('data-step')).toBe('4');

    const thin = swatch(0, 20);
    expect(thin.getAttribute('data-state')).toBe('withheld');
    expect(thin.getAttribute('data-step')).toBeNull();
  });

  it('keeps the thin cell’s DIAL COUNT on screen and its rate off it', () => {
    renderMatrix(
      bestHoursPage({ rows: [hourCell({ day: 1, hour: 10, attempts: 300 }), thinHourCell()] }),
    );
    // "we barely called then" is itself the answer to a rostering question.
    expect(cell(0, 20).textContent).toContain('2');
    // And the served 50% appears nowhere: a bright square is never one answered call.
    expect(screen.queryByText('50%')).toBeNull();
    expect(document.body.textContent).not.toContain('50%');
  });

  it('says in the legend that the hatched cells are off the scale', () => {
    renderMatrix();
    const scale = screen.getByTestId('best-hours-scale');
    expect(scale.textContent).toContain('not on this scale');
    expect(screen.getByTestId('best-hours-keys').textContent).toContain('Too few calls to rate');
  });

  it('drops the withheld key from the VOLUME legend, where nothing is gated', () => {
    renderMatrix(bestHoursPage(), 'volume');
    expect(screen.getByTestId('best-hours-keys').textContent).not.toContain(
      'Too few calls to rate',
    );
    expect(screen.getByTestId('best-hours-scale').textContent).not.toContain('not on this scale');
  });

  it('gives the conversion view’s FOURTH state a key of its own', () => {
    /**
     * ⚠️ The conversion view has a visible treatment the legend did not mention: a
     * cell that dialled and reached nobody has no denominator to divide, so it is
     * flat rather than hatched and prints its dial count. Three states were keyed and
     * four were drawn.
     *
     * Its only explanation was the cell's `title` — unavailable on a touch screen,
     * not reachable by keyboard, and not where a reader looks to find out what a
     * treatment means. A legend that omits one of the four things on screen is worse
     * than no legend for that one thing: it implies the list is complete.
     *
     * The swatch has to match the CELL, or the key describes a map the reader is not
     * looking at — so the key's `data-state` is asserted, not just the words.
     */
    renderMatrix(
      bestHoursPage({ rows: [hourCell({ day: 4, hour: 3, attempts: 30, connected: 0 })] }),
      'conversion_rate',
    );

    expect(swatch(4, 3).getAttribute('data-state')).toBe('unmeasured');
    const keys = screen.getByTestId('best-hours-keys');
    expect(keys.textContent).toContain('no connect to convert');
    expect(keys.querySelector('[data-state="unmeasured"]')).toBeTruthy();
  });

  it('does not key that state on the two views where it cannot appear', () => {
    // A key for a swatch that cannot be drawn is a legend describing a different map.
    // On the connect rate the state is unreachable (an attempts-driven read cannot
    // emit a cell with no dials); on volume there is no rate to be missing.
    for (const view of ['connect_rate', 'volume'] as const) {
      cleanup();
      renderMatrix(bestHoursPage(), view);
      expect(screen.getByTestId('best-hours-keys').textContent).not.toContain(
        'no connect to convert',
      );
    }
  });
});

describe('BestHoursMatrix — E4, absent is two different facts', () => {
  it('marks an out-of-window row on its header and empties its cells', () => {
    /**
     * A blank row beside a normal-weight weekday label reads as "we dialled Tuesday
     * and connected nobody", which is the direction a supervisor acts on. So the row
     * header carries the fact too.
     */
    renderMatrix(
      bestHoursPage({
        from: SHORT_FROM,
        to: SHORT_TO,
        rows: [hourCell({ day: SHORT_DAY, hour: 2, attempts: 300 })],
      }),
    );
    expect(screen.getByTestId('best-hours-out-2').textContent).toContain('not in window');
    expect(swatch(2, 10).getAttribute('data-state')).toBe('out_of_window');
    // No zero, no rate, nothing that sits on a scale.
    expect(cell(2, 10).textContent).toBe('Not in this window — never asked about');
    expect(swatch(2, 10).getAttribute('data-step')).toBeNull();
  });

  it('prints a real zero for a covered hour nobody dialled', () => {
    renderMatrix(
      bestHoursPage({
        from: SHORT_FROM,
        to: SHORT_TO,
        rows: [hourCell({ day: SHORT_DAY, hour: 2, attempts: 300 })],
      }),
    );
    expect(swatch(SHORT_DAY, 5).getAttribute('data-state')).toBe('no_dials');
    expect(cell(SHORT_DAY, 5).textContent).toContain('0');
    // The covered weekday's own header carries no "not in window" marker.
    expect(screen.queryByTestId(`best-hours-out-${SHORT_DAY}`)).toBeNull();
  });

  it('marks NEITHER when the zone is missing, and says so in the key', () => {
    renderMatrix(bestHoursPage({ resolved_timezone: undefined }));
    expect(swatch(5, 5).getAttribute('data-state')).toBe('unknown_coverage');
    expect(screen.getByTestId('best-hours-keys').textContent).toContain('coverage unknown');
    // Nothing is claimed to be out of window, so no row header claims it either.
    expect(screen.queryByTestId('best-hours-out-2')).toBeNull();
  });
});

describe('BestHoursMatrix — E6, three views over the same grid', () => {
  it('shows a rate on the rate views and a count on the volume view', () => {
    const page = bestHoursPage({
      rows: [hourCell({ day: 1, hour: 10, attempts: 300, connected: 100, successes: 25 })],
    });
    renderMatrix(page, 'connect_rate');
    expect(cell(1, 10).textContent).toContain('33.3%');
    cleanup();
    renderMatrix(page, 'volume');
    expect(cell(1, 10).textContent).toContain('300');
    cleanup();
    renderMatrix(page, 'conversion_rate');
    expect(cell(1, 10).textContent).toContain('25%');
  });

  it('colours the connect rate and withholds the conversion rate on one cell', () => {
    /**
     * 41 dials, 11 connects. `rates_reportable` clears the dial threshold and
     * `success_rate_reportable` does not clear the connect one — the same cell, two
     * answers, which is why the two views cannot share one flag.
     */
    const page = bestHoursPage({ rows: [hollowHourCell()] });
    renderMatrix(page, 'connect_rate');
    expect(swatch(2, 11).getAttribute('data-state')).toBe('measured');
    cleanup();
    renderMatrix(page, 'conversion_rate');
    expect(swatch(2, 11).getAttribute('data-state')).toBe('withheld');
    expect(cell(2, 11).textContent).toContain('11 connects');
  });
});

describe('BestHoursMatrix — nothing is conveyed by colour alone', () => {
  it('puts every cell’s finding in words as well as in its fill', () => {
    /**
     * Two steps of a five-step ramp are not reliably distinguishable, and a `title`
     * alone is unreachable by keyboard. So the finding is in the cell's text content
     * for a screen reader, and the full sentence — weekday, hour and zone — is in the
     * `title` for a reader who hovers.
     */
    renderMatrix(
      bestHoursPage({ rows: [hourCell({ day: 1, hour: 10, attempts: 300, connected: 100 })] }),
    );
    expect(cell(1, 10).textContent).toContain('300 dials connected');
    expect(swatch(1, 10).getAttribute('title')).toContain('Monday 10:00');
    expect(swatch(1, 10).getAttribute('title')).toContain('Asia/Kolkata');
  });

  it('states the scale’s two ends as NUMBERS', () => {
    renderMatrix(
      bestHoursPage({
        rows: [
          hourCell({ day: 1, hour: 10, attempts: 300, connected: 100 }),
          hourCell({ day: 2, hour: 10, attempts: 300, connected: 60 }),
        ],
      }),
    );
    const scale = screen.getByTestId('best-hours-scale').textContent ?? '';
    expect(scale).toContain('Lightest 20%');
    expect(scale).toContain('darkest 33.3%');
  });

  it('names the campaign’s zone in a cell’s sentence, never the reader’s', () => {
    /**
     * The zone is a PROP, so the grid cannot reach for the browser's default even by
     * accident — `Pacific/Chatham` here is a zone no CI machine runs in.
     */
    const page = bestHoursPage({ resolved_timezone: 'Pacific/Chatham' });
    renderMatrix(page);
    const reader = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByTestId('best-hours-axis-zone').textContent).toContain('Pacific/Chatham');
    expect(screen.getByTestId('best-hours-axis-zone').textContent).not.toContain(reader);
    expect(FIXTURE_ZONE).not.toBe('Pacific/Chatham');
  });
});
