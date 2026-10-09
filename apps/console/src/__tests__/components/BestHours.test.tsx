import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import {
  SHORT_DAY,
  SHORT_FROM,
  SHORT_TO,
  bestHoursPage,
  hourCell,
  thinHourCell,
  withoutSuccessFlag,
} from '../helpers/bestHours';

/**
 * The best-hours surface's wiring — what it asks for, and what it says about the
 * answer.
 *
 * ── The two rulings this file exists to pin ───────────────────────────────
 *  - **E6: a view switch RE-RENDERS.** Every metric is on every cell of the one page
 *    in hand, so flipping the colour control must fire nothing. A switch that
 *    refetched would let the three views disagree about one campaign's week — two
 *    reads a second apart straddle a dial.
 *  - **E2/E3: one campaign, and the zone comes off the payload.** The read carries
 *    `campaign_id` always, no `limit`, no `sort`; and where `resolved_timezone` did not
 *    arrive the surface says the zone could not be read rather than labelling the axis
 *    with the reader's.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getAgencyGroupedStats: vi.fn(),
  trackViewed: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../analytics/events', () => ({
  trackAgencyBestHoursViewed: mocks.trackViewed,
}));
/*
  Mocked at the API boundary, the seam every other agency test mocks at. This is also
  the only seam that can prove "one request": a component that fetched on a view
  switch would show up here as a second call.
*/
vi.mock('../../api/agencyStats', () => ({
  getAgencyGroupedStats: mocks.getAgencyGroupedStats,
}));

import { BestHours } from '../../components/agency/BestHours';

function tenant(over: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'account_admin',
    accountResolution: 'ready',
    accountError: null,
    reloadAccounts: vi.fn(),
    ...over,
  };
}

const NAMES = new Map<string, string | null>([
  ['camp-1', 'Renewals'],
  ['camp-2', 'Winbacks'],
]);

function renderView(over: Partial<Parameters<typeof BestHours>[0]> = {}) {
  const onBack = vi.fn();
  const onCampaignChange = vi.fn();
  const props = {
    campaignId: 'camp-1',
    campaignNames: NAMES,
    period: 'week' as const,
    onCampaignChange,
    onBack,
    ...over,
  };
  const view = render(<BestHours {...props} />);
  /*
    `campaignId` is a CONTROLLED prop, so a case about what changing it re-reads has
    to re-render with the new value the way the caller would — without remounting,
    because the window and the view are meant to survive it.
  */
  const setCampaign = (campaignId: string) =>
    view.rerender(<BestHours {...props} campaignId={campaignId} />);
  return { onBack, onCampaignChange, setCampaign };
}

type SentQuery = {
  group_by: readonly string[];
  campaign_id?: string;
  limit?: number;
  sort?: string;
  order?: string;
  from: string;
  to: string;
};

function queries(): SentQuery[] {
  return mocks.getAgencyGroupedStats.mock.calls.map((call) => call[0] as SentQuery);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue(tenant());
  mocks.getAgencyGroupedStats.mockResolvedValue(bestHoursPage());
});

afterEach(() => cleanup());

describe('BestHours — what it asks for', () => {
  it('makes ONE request, cut by weekday and hour, for one campaign', async () => {
    renderView();
    await waitFor(() => expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(1));
    const [query] = queries();
    expect(query?.group_by).toEqual(['day_of_week', 'hour_of_day']);
    // E2: required, not optional. A pooled read is a 400 upstream, because both time
    // dimensions are grouped and the zone is unambiguous only under one campaign.
    expect(query?.campaign_id).toBe('camp-1');
  });

  it('sends no `limit`, no `sort` and no `order`', async () => {
    /**
     * A matrix renders every cell, so no order is meaningful and the surface offers no
     * sort. `limit` is left at the route's default of 200: `limit=168` would be this
     * client's arithmetic on the wire, and it would silently truncate the map the day a
     * seventh `day_of_week` value appears.
     */
    renderView();
    await waitFor(() => expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(1));
    const [query] = queries();
    expect(query).not.toHaveProperty('limit');
    expect(query).not.toHaveProperty('sort');
    expect(query).not.toHaveProperty('order');
  });

  it('offers no "all campaigns" option on its selector', async () => {
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-matrix')).toBeTruthy());
    const select = screen.getByTestId('best-hours-campaign') as HTMLSelectElement;
    const values = [...select.options].map((option) => option.value);
    expect(values).not.toContain('');
    expect(values).toContain('camp-1');
  });

  it('refuses a blank campaign rather than sending the POOLED read', async () => {
    /**
     * E2: the client must not send this read without `campaign_id`. `groupQuery` drops
     * a falsy one — correctly, because a cleared selector's empty string would read as
     * a filter matching nothing — so letting it through here would silently become the
     * pooled read that upstream answers `400 timezone_ambiguous`.
     *
     * The state is unreachable through the caller (the entry button only appears with a
     * campaign in scope, and this selector has no "all campaigns" option). The guard is
     * what makes it a refusal rather than a wrong request if it ever becomes reachable —
     * and the mutation that reds this case is deleting it.
     */
    renderView({ campaignId: '' });
    await waitFor(() => expect(screen.getByTestId('best-hours-error')).toBeTruthy());
    expect(screen.getByTestId('best-hours-error').textContent).toContain('one campaign');
    expect(mocks.getAgencyGroupedStats).not.toHaveBeenCalled();
  });

  it('waits for both ids rather than firing a read master would 400', async () => {
    mocks.useTenant.mockReturnValue(tenant({ accountId: null }));
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-loading')).toBeTruthy());
    expect(mocks.getAgencyGroupedStats).not.toHaveBeenCalled();
  });
});

describe('BestHours — E6, a view switch re-renders and never re-reads', () => {
  it('fires no request when the colour control moves', async () => {
    /**
     * The mutation this case exists for: making `view` an input to `useBestHours` (or
     * adding a metric param to the query) turns a re-render into a re-read, and the
     * three views then become capable of disagreeing — a reader flipping between
     * "connect rate" and "volume" would watch the map change under a control that is
     * supposed to be re-colouring the same numbers.
     */
    renderView();
    await waitFor(() => expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('best-hours-view'), { target: { value: 'volume' } });
    await waitFor(() => expect(screen.getByTestId('best-hours-matrix')).toBeTruthy());
    fireEvent.change(screen.getByTestId('best-hours-view'), {
      target: { value: 'conversion_rate' },
    });
    await waitFor(() => expect(screen.getByTestId('best-hours-matrix')).toBeTruthy());

    expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(1);
  });

  it('re-colours the SAME cells from the payload already in hand', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue(
      bestHoursPage({
        rows: [hourCell({ day: 1, hour: 10, attempts: 300, connected: 100, successes: 25 })],
      }),
    );
    renderView();
    await waitFor(() =>
      expect(screen.getByTestId('best-hours-cell-1-10').textContent).toContain('33.3%'),
    );
    fireEvent.change(screen.getByTestId('best-hours-view'), { target: { value: 'volume' } });
    await waitFor(() =>
      expect(screen.getByTestId('best-hours-cell-1-10').textContent).toContain('300'),
    );
    expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(1);
  });

  it('DOES re-read when the window or the campaign moves', async () => {
    /**
     * The counterweight: the no-refetch assertion above must not be passing because
     * nothing on this screen refetches at all.
     */
    const { setCampaign } = renderView();
    await waitFor(() => expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId('best-hours-period'), { target: { value: 'month' } });
    await waitFor(() => expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(2));
    setCampaign('camp-2');
    await waitFor(() => expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(3));
    expect(queries()[2]?.campaign_id).toBe('camp-2');
  });
});

describe('BestHours — E3, two zones on one screen and both are named', () => {
  it('labels the hour axis with the campaign’s zone and the window with the reader’s', async () => {
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-matrix')).toBeTruthy());
    expect(screen.getByTestId('best-hours-axis-zone').textContent).toContain('Asia/Kolkata');
    /*
      The window readout is in the READER's zone and correctly so — `windowRange` cut
      those bounds from a local `Date`. Both are on screen, and each says which it is;
      what must never happen is one standing in for the other.
    */
    const reader = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByTestId('best-hours-window-range').textContent).toContain(reader);
    expect(screen.queryByTestId('best-hours-zone-unknown')).toBeNull();
  });

  it('says the zone could not be read when the field did not arrive', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue(
      bestHoursPage({ resolved_timezone: undefined }),
    );
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-zone-unknown')).toBeTruthy());
    // And the axis carries no zone at all — not the reader's.
    expect(screen.queryByTestId('best-hours-axis-zone')).toBeNull();
    const reader = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByTestId('best-hours-matrix').textContent).not.toContain(reader);
  });
});

describe('BestHours — E4 and E5, said out loud above the grid', () => {
  it('names the weekdays that were never in the window', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue(
      bestHoursPage({
        from: SHORT_FROM,
        to: SHORT_TO,
        rows: [hourCell({ day: SHORT_DAY, hour: 2, attempts: 300 })],
      }),
    );
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-coverage')).toBeTruthy());
    const note = screen.getByTestId('best-hours-coverage').textContent ?? '';
    expect(note).toContain('Tuesday');
    expect(note).toContain('blank rather than zero');
  });

  it('says nothing about coverage when the window covered every cell', async () => {
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-matrix')).toBeTruthy());
    expect(screen.queryByTestId('best-hours-coverage')).toBeNull();
  });

  it('states how many cells were withheld', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue(
      bestHoursPage({ rows: [hourCell({ day: 1, hour: 10, attempts: 300 }), thinHourCell()] }),
    );
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-withheld')).toBeTruthy());
    expect(screen.getByTestId('best-hours-withheld').textContent).toContain('1 cell has');
  });

  it('says nothing about withholding when nothing was withheld', async () => {
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-matrix')).toBeTruthy());
    expect(screen.queryByTestId('best-hours-withheld')).toBeNull();
  });

  it('withholds the conversion view entirely when the CONNECTS flag never arrived', async () => {
    /**
     * ⚠️ The visible shape of failing closed, end to end. The conversion gate used to
     * fall back to `rates_reportable` — dials — so a 20-dial/1-connect/1-conversion
     * cell painted its served `100%` as the darkest square on the map and set the
     * ramp's upper end, which is E5's own failure at 168× scale.
     *
     * On a core that predates `success_rate_reportable` the honest map is a hatched
     * one that says so, and the reader is told how many cells and what to do about
     * it. The connect-rate view beside it is unaffected: it has the flag it needs.
     */
    mocks.getAgencyGroupedStats.mockResolvedValue(
      bestHoursPage({
        rows: [
          withoutSuccessFlag(
            hourCell({ day: 0, hour: 20, attempts: 20, connected: 1, successes: 1 }),
          ),
        ],
      }),
    );
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-matrix')).toBeTruthy());

    // The connect rate is quotable and shown.
    expect(screen.queryByTestId('best-hours-withheld')).toBeNull();

    fireEvent.change(screen.getByTestId('best-hours-view'), {
      target: { value: 'conversion_rate' },
    });

    const note = screen.getByTestId('best-hours-withheld');
    expect(note.textContent).toContain('1 cell has');
    // Most of the dialled cells are withheld, so the remedy is named.
    expect(note.textContent).toContain('longer window');
    // And the served 100% is nowhere on screen.
    expect(document.body.textContent).not.toContain('100%');
  });

  it('counts the cells that had a dial against all 168', async () => {
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-count')).toBeTruthy());
    expect(screen.getByTestId('best-hours-count').textContent).toContain('of 168');
  });
});

describe('BestHours — the four states', () => {
  it('separates "nobody dialled" from "we could not ask"', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue(bestHoursPage({ rows: [], total_groups: 0 }));
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-empty')).toBeTruthy());
    expect(screen.getByTestId('best-hours-empty').textContent).toContain('Renewals');
    expect(screen.queryByTestId('best-hours-error')).toBeNull();
    expect(screen.queryByTestId('best-hours-matrix')).toBeNull();
  });

  it('shows the server’s own sentence and a retry on a failure', async () => {
    /**
     * A `timezone_ambiguous` 400 would arrive here too, and it is NOT retried with a
     * UTC fallback: an Asia/Kolkata campaign's real peak sits five and a half hours
     * from where UTC would draw it, and the only symptom is a quietly wrong rostering
     * decision.
     */
    mocks.getAgencyGroupedStats.mockRejectedValue(new Error('timezone_ambiguous'));
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-error')).toBeTruthy());
    expect(screen.getByTestId('best-hours-error').textContent).toContain('timezone_ambiguous');
    expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(1);
  });

  it('refuses a body whose rows are not an array', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue({ rows: undefined } as never);
    renderView();
    await waitFor(() => expect(screen.getByTestId('best-hours-error')).toBeTruthy());
    expect(screen.getByTestId('best-hours-error').textContent).toContain('shape this page');
  });
});

describe('BestHours — E10, one event carrying the honesty state', () => {
  it('fires once with the zone, the cell count and the withheld count', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue(
      bestHoursPage({ rows: [hourCell({ day: 1, hour: 10, attempts: 300 }), thinHourCell()] }),
    );
    renderView();
    await waitFor(() => expect(mocks.trackViewed).toHaveBeenCalledTimes(1));
    expect(mocks.trackViewed).toHaveBeenCalledWith(
      expect.objectContaining({
        campaign_id: 'camp-1',
        window: 'week',
        view: 'connect_rate',
        resolved_timezone: 'Asia/Kolkata',
        zone_read: true,
        cells: 168,
        cells_with_dials: 2,
        // The E5 number, derived once by the console rather than re-derived
        // downstream from three counts.
        withheld_cells: 1,
        coverage_known: true,
      }),
    );
  });

  it('does not re-fire on a view switch or a window change', async () => {
    renderView();
    await waitFor(() => expect(mocks.trackViewed).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId('best-hours-view'), { target: { value: 'volume' } });
    fireEvent.change(screen.getByTestId('best-hours-period'), { target: { value: 'month' } });
    await waitFor(() => expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(2));
    expect(mocks.trackViewed).toHaveBeenCalledTimes(1);
  });

  it('reports an unread zone rather than omitting the field', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue(
      bestHoursPage({ resolved_timezone: undefined }),
    );
    renderView();
    await waitFor(() => expect(mocks.trackViewed).toHaveBeenCalledTimes(1));
    expect(mocks.trackViewed).toHaveBeenCalledWith(
      expect.objectContaining({ resolved_timezone: null, zone_read: false, coverage_known: false }),
    );
  });
});
