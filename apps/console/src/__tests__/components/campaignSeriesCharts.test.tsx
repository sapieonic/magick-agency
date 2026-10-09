import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CampaignActivityChart } from '../../components/agency/CampaignActivityChart';
import { CampaignRateChart } from '../../components/agency/CampaignRateChart';
import { bucketSeries } from '../../utils/agencyAgentPerformance';
import { rateTrend } from '../../utils/agencyCampaignSeries';
import type { AgencyAgentStatsBucket } from '../../types/agency-stats';
import type { AgencyCampaignSeries } from '../../types/agency-campaign-series';

/**
 * The campaign workspace's two series charts, as rendered.
 *
 * The derivations are pinned in `utils/agencyCampaignSeries.test.ts`; what is
 * asserted here is what only a component decides — that a run of measured days
 * becomes one `<path>` and a gap becomes a second one rather than a segment
 * drawn straight through it, that an isolated measured day is still on the
 * plot, and that a day with no reading says so in words instead of painting a
 * `0%` a supervisor would act on.
 *
 * Both components are fed through the real `bucketSeries` / `rateTrend` rather
 * than hand-built props: the withholding rule (`RATE_MIN_ATTEMPTS`) is the
 * source of most of the `null`s these charts exist to draw, and a fixture that
 * bypassed it would test a shape the app never produces.
 *
 * Class names are never asserted on — CSS Modules are not identity-transformed
 * here, so every one of them is a hash.
 */

afterEach(cleanup);

const BIG = 40; // comfortably over RATE_MIN_ATTEMPTS (25)

function bucket(over: Partial<AgencyAgentStatsBucket> & { bucket_start: string }): AgencyAgentStatsBucket {
  return {
    attempts: 0,
    connected: 0,
    successes: 0,
    talk_seconds: 0,
    wrapup_seconds: 0,
    ...over,
  };
}

function series(buckets: AgencyAgentStatsBucket[]): AgencyCampaignSeries {
  return { campaign_id: 'camp-1', bucket: 'day', timezone: 'Asia/Kolkata', buckets };
}

/** A day whose rates are both measurable and publishable. */
function measured(day: string, attempts = BIG, connected = 30, successes = 12) {
  return bucket({ bucket_start: day, attempts, connected, successes });
}

/** A day with nothing on it — no denominator, so both rates are `null`. */
function idle(day: string) {
  return bucket({ bucket_start: day });
}

describe('CampaignActivityChart', () => {
  const activity = bucketSeries([
    bucket({ bucket_start: '2026-03-01', attempts: 40, connected: 12 }),
    bucket({ bucket_start: '2026-03-02', attempts: 90, connected: 31 }),
    bucket({ bucket_start: '2026-03-03', attempts: 12, connected: 4 }),
  ]);

  it('draws one group per bucket, with the accessible name naming the range', () => {
    render(<CampaignActivityChart series={activity} />);

    expect(screen.getByTestId('campaign-activity-bucket-2026-03-01')).toBeTruthy();
    expect(screen.getByTestId('campaign-activity-bucket-2026-03-02')).toBeTruthy();
    expect(screen.getByTestId('campaign-activity-bucket-2026-03-03')).toBeTruthy();

    const chart = screen.getByTestId('campaign-activity-chart');
    expect(chart.getAttribute('role')).toBe('img');
    expect(chart.textContent).toContain('3 days');
  });

  it('labels the busiest day and only that one', () => {
    render(<CampaignActivityChart series={activity} />);

    const peaks = screen.getAllByTestId('campaign-activity-peak');
    expect(peaks).toHaveLength(1);
    expect(peaks[0]?.textContent).toBe('90');
    // And it belongs to the day that actually was the peak.
    expect(
      within(screen.getByTestId('campaign-activity-bucket-2026-03-02'))
        .getByTestId('campaign-activity-peak'),
    ).toBeTruthy();
  });

  it('names both series in a legend, so identity is never colour alone', () => {
    render(<CampaignActivityChart series={activity} />);
    expect(screen.getByText('Dials')).toBeTruthy();
    expect(screen.getByText('Spoke to a person')).toBeTruthy();
  });

  it('keeps the numbers behind the disclosure until it is pressed', () => {
    render(<CampaignActivityChart series={activity} />);

    expect(screen.queryByTestId('campaign-activity-table')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show the numbers' }));

    const table = screen.getByTestId('campaign-activity-table');
    expect(within(table).getByText('90')).toBeTruthy();
    expect(within(table).getByText('31')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide the numbers' })).toBeTruthy();
  });

  it('renders no heading or card chrome of its own — the Section owns those', () => {
    render(<CampaignActivityChart series={activity} />);
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

/**
 * The connect line's `<path>` elements.
 *
 * A prefix query, because the testid carries the RUN's start index: one series
 * with a gap draws several paths, and that is the property most of these tests
 * are about. A bare `getAllByTestId` on a shared id would work only for the
 * single-run case — and `getByTestId` would throw on exactly the gapped one.
 */
function connectPaths(): Element[] {
  return [...document.querySelectorAll('[data-testid^="campaign-rate-line-connect"]')];
}

/** The conversion line's `<path>` elements. See {@link connectPaths}. */
function conversionPaths(): Element[] {
  return [...document.querySelectorAll('[data-testid^="campaign-rate-line-conversion"]')];
}

describe('CampaignRateChart', () => {
  it('breaks the line at a gap instead of drawing through it', () => {
    /**
     * Three measured days, then an idle one, then two more. A single `<path>`
     * across the array would assert a trend through a day nobody dialled.
     */
    const trend = rateTrend(series([
      measured('2026-03-01'),
      measured('2026-03-02'),
      measured('2026-03-03'),
      idle('2026-03-04'),
      measured('2026-03-05'),
      measured('2026-03-06'),
    ]));
    render(<CampaignRateChart trend={trend} />);

    // Two runs → two paths. One path spanning the gap would assert a trend
    // through a day nobody measured; a value plotted at 0% would be worse still.
    expect(connectPaths()).toHaveLength(2);
    expect(conversionPaths()).toHaveLength(2);
  });

  it('draws an isolated measured day as a dot, since a line needs two points', () => {
    const trend = rateTrend(series([
      measured('2026-03-01'),
      idle('2026-03-02'),
      // The lone island. Its own run has length 1.
      measured('2026-03-03'),
      idle('2026-03-04'),
      measured('2026-03-05'),
      measured('2026-03-06'),
    ]));
    render(<CampaignRateChart trend={trend} />);

    // The island is a dot; the trailing pair is still a path.
    expect(screen.getAllByTestId('campaign-rate-dot-connect')).toHaveLength(2);
    expect(connectPaths()).toHaveLength(1);
  });

  it('says "not enough calls" rather than 0% where there is no reading', () => {
    const trend = rateTrend(series([
      measured('2026-03-01'),
      idle('2026-03-02'),
      measured('2026-03-03'),
    ]));
    render(<CampaignRateChart trend={trend} />);

    const idleDay = screen.getByTestId('campaign-rate-day-2026-03-02');
    expect(idleDay.textContent).toContain('not enough calls');
    expect(idleDay.textContent).not.toContain('0%');

    const busyDay = screen.getByTestId('campaign-rate-day-2026-03-01');
    expect(busyDay.textContent).toContain('75%'); // 30 of 40 dials
    expect(busyDay.textContent).toContain('40%'); // 12 of 30 conversations
  });

  it('renders an em dash in the table for a day with no reading', () => {
    const trend = rateTrend(series([
      measured('2026-03-01'),
      idle('2026-03-02'),
      measured('2026-03-03'),
    ]));
    render(<CampaignRateChart trend={trend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show the numbers' }));

    const table = screen.getByTestId('campaign-rate-table');
    const cells = Array.from(table.querySelectorAll('tbody tr'))[1];
    expect(cells).toBeTruthy();
    const text = Array.from(cells!.querySelectorAll('td')).map((td) => td.textContent);
    expect(text).toEqual(['0', '0', '—', '—']);
    expect(text).not.toContain('0%');
  });

  it('withholds a day whose denominator is under the floor, and says so on the page', () => {
    const trend = rateTrend(series([
      measured('2026-03-01'),
      // Four dials: a real reading, and one that swings too much to plot.
      bucket({ bucket_start: '2026-03-02', attempts: 4, connected: 2, successes: 1 }),
      measured('2026-03-03'),
    ]));
    render(<CampaignRateChart trend={trend} />);

    const note = screen.getByTestId('campaign-rate-withheld');
    expect(note.textContent).toContain('25');

    // The withheld day is a gap in the plot AND a dash in the table — the chart
    // and the table must not disagree about what was published. Withholding the
    // middle day strands the two survivors, so each is a dot and there is no
    // segment anywhere: a line joining them would be drawn straight over the
    // reading the floor just declined to publish.
    expect(screen.getAllByTestId('campaign-rate-dot-connect')).toHaveLength(2);
    expect(connectPaths()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Show the numbers' }));
    const row = Array.from(
      screen.getByTestId('campaign-rate-table').querySelectorAll('tbody tr'),
    )[1];
    const text = Array.from(row!.querySelectorAll('td')).map((td) => td.textContent);
    expect(text).toEqual(['4', '2', '—', '—']);
  });

  it('omits the withheld sentence when nothing was withheld', () => {
    const trend = rateTrend(series([measured('2026-03-01'), measured('2026-03-02')]));
    render(<CampaignRateChart trend={trend} />);
    expect(screen.queryByTestId('campaign-rate-withheld')).toBeNull();
  });

  it('carries each series denominator in its own legend entry', () => {
    const trend = rateTrend(series([measured('2026-03-01'), measured('2026-03-02')]));
    render(<CampaignRateChart trend={trend} />);

    const connect = screen.getByTestId('campaign-rate-legend-connect');
    expect(connect.textContent).toContain('Connect rate');
    expect(connect.textContent).toContain('of dials placed that day');

    const conversion = screen.getByTestId('campaign-rate-legend-conversion');
    expect(conversion.textContent).toContain('Conversion');
    expect(conversion.textContent).toContain('of calls that spoke to a person that day');
  });

  it('labels the last measured point of each line, and no other point', () => {
    const trend = rateTrend(series([
      measured('2026-03-01', BIG, 30, 12),
      measured('2026-03-02', BIG, 20, 5),
      measured('2026-03-03', BIG, 26, 9),
    ]));
    render(<CampaignRateChart trend={trend} />);

    expect(screen.getAllByTestId('campaign-rate-end-connect')).toHaveLength(1);
    expect(screen.getAllByTestId('campaign-rate-end-conversion')).toHaveLength(1);
    expect(screen.getByTestId('campaign-rate-end-connect').textContent).toBe('65%');
  });

  it('is an image with an accessible name that admits the gaps', () => {
    const trend = rateTrend(series([
      measured('2026-03-01'),
      idle('2026-03-02'),
      measured('2026-03-03'),
    ]));
    render(<CampaignRateChart trend={trend} />);

    const chart = screen.getByTestId('campaign-rate-chart');
    expect(chart.getAttribute('role')).toBe('img');
    const titleId = chart.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    const title = chart.querySelector(`#${CSS.escape(titleId!)}`);
    expect(title?.textContent).toContain('gaps');
  });

  it('renders no heading or card chrome of its own — the Section owns those', () => {
    const trend = rateTrend(series([measured('2026-03-01'), measured('2026-03-02')]));
    render(<CampaignRateChart trend={trend} />);
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

describe('one phrase for `human_connects`, across the whole feature', () => {
  /*
    The pulse strip teaches, carefully, that "Reached someone"
    (`attempts_connected`, machines included) and "Spoke to a person"
    (`human_connects`) are deliberately different numbers. These charts plot the
    SECOND one — and the accessible name, the table caption and the legend all
    used to disagree with each other, one of them ("reached a person") a single
    word away from the concept it is not.
  */
  it('says the same thing in the legend, the caption and the accessible name', () => {
    const points = bucketSeries([
      { bucket_start: '2026-03-01', attempts: 40, connected: 12, successes: 3, talk_seconds: 0, wrapup_seconds: 0 },
      { bucket_start: '2026-03-02', attempts: 50, connected: 18, successes: 4, talk_seconds: 0, wrapup_seconds: 0 },
    ]);
    render(<CampaignActivityChart series={points} />);

    expect(screen.getByText('Spoke to a person')).toBeTruthy();

    const svg = screen.getByTestId('campaign-activity-chart');
    expect(svg.querySelector('title')?.textContent).toContain('spoke to a person');
    // And never the other concept's words.
    expect(svg.querySelector('title')?.textContent).not.toContain('reached a person');
    expect(svg.querySelector('title')?.textContent).not.toContain('Reached someone');

    fireEvent.click(screen.getByRole('button', { name: 'Show the numbers' }));
    const caption = screen.getByTestId('campaign-activity-table').querySelector('caption');
    expect(caption?.textContent).toContain('spoke to a person');
    expect(caption?.textContent).not.toContain('reached a person');
  });
});
