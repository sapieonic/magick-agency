import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgencyCampaign } from '../../types/agency-campaign';
import type { AgencyCampaignSeries } from '../../types/agency-campaign-series';

/**
 * The shell both charts of the campaign workspace live in.
 *
 * The charts themselves are covered in `campaignSeriesCharts.test.tsx` and the
 * arithmetic in `agencyCampaignSeries.test.ts`. What is left — and what is only
 * testable here — is the part a reader meets FIRST and most often: the four
 * states, the range picker, and the three sentences that qualify what is on
 * screen.
 *
 * Two of those are the ones worth writing down:
 *
 * - **An empty range is not a broken chart.** A campaign that dialled nothing
 *   in the window, a range that resolved to one day, and a range where no day
 *   cleared the publishing threshold are three different answers, each with a
 *   different next action. Collapsing them into one "no data" is how a quiet
 *   week gets filed as a bug.
 * - **A failed read has no Retry.** A server that predates this route answers
 *   404 on every attempt, and this console cannot tell that from a transient
 *   failure — so the section says what happened and the rest of the panel,
 *   which does not depend on this read, carries on.
 */

const mocks = vi.hoisted(() => ({
  getAgencyCampaignSeries: vi.fn(),
  useTenant: vi.fn(),
}));

vi.mock('../../api/agencyCampaignSeries', () => ({
  getAgencyCampaignSeries: mocks.getAgencyCampaignSeries,
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: mocks.useTenant,
}));

import { CampaignSeriesSection } from '../../components/agency/CampaignSeriesSection';
import { RATE_MIN_ATTEMPTS } from '../../utils/agencyCampaignPerformance';

const NOW = new Date('2026-08-27T15:30:00.000Z');

function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
  return {
    id: 'camp-1',
    name: 'Renewals',
    status: 'running',
    started_at: '2026-08-01T09:00:00.000Z',
    ended_at: null,
    ...over,
  };
}

function bucket(start: string, attempts: number, connected: number, successes = 0) {
  return { bucket_start: start, attempts, connected, successes, talk_seconds: 0, wrapup_seconds: 0 };
}

function series(over: Partial<AgencyCampaignSeries> = {}): AgencyCampaignSeries {
  return { campaign_id: 'camp-1', bucket: 'day', buckets: [], ...over };
}

/** Days that comfortably clear the publishing threshold, so a chart draws. */
function busyDays(count: number) {
  return Array.from({ length: count }, (_, i) =>
    bucket(`2026-08-${String(10 + i).padStart(2, '0')}`, RATE_MIN_ATTEMPTS * 10, RATE_MIN_ATTEMPTS * 4, RATE_MIN_ATTEMPTS),
  );
}

/**
 * Settle the in-flight promise.
 *
 * `waitFor` polls on a timer that fake timers hold still, so settling is driven
 * through `act` instead — it flushes the microtask queue the promises actually
 * resolve on.
 */
async function settle() {
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.getAgencyCampaignSeries.mockResolvedValue(series());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CampaignSeriesSection', () => {
  it('shows a skeleton the size of the plot rather than a spinner, while loading', () => {
    // Never resolves: the loading state is the state under test.
    mocks.getAgencyCampaignSeries.mockReturnValue(new Promise(() => {}));
    render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
    expect(screen.getByTestId('campaign-series-loading')).toBeTruthy();
    expect(screen.queryByTestId('campaign-series-notes')).toBeNull();
  });

  it('surfaces the server’s own sentence on a failed read, with no retry control', async () => {
    mocks.getAgencyCampaignSeries.mockRejectedValue(new Error('Not Found'));
    render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
    await settle();

    expect(screen.getByTestId('campaign-series-error').textContent).toContain('Not Found');
    // A server that predates this route answers 404 every time; a Retry here
    // would be a control that cannot work.
    expect(screen.queryByRole('button', { name: /retry|try again/i })).toBeNull();
    // The heading and the picker survive the failure — the section is still
    // identifiable and the reader can still widen the range.
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toBeTruthy();
  });

  it('renders the two charts under their own headings', async () => {
    mocks.getAgencyCampaignSeries.mockResolvedValue(series({ buckets: busyDays(6) }));

    const { unmount } = render(
      <CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />,
    );
    await settle();
    expect(screen.getByTestId('campaign-series-activity')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Dialing activity' })).toBeTruthy();
    unmount();

    render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="rates" />);
    await settle();
    expect(screen.getByTestId('campaign-series-rates')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Are the rates holding?' })).toBeTruthy();
  });

  describe('the three ways there is nothing to draw', () => {
    it('says nothing was dialed, rather than drawing a plot of nothing', async () => {
      /*
        THE COMMON CASE, and the one that was missing. Every day in the range
        arrives with zeros (the endpoint's contract), so a fortnight in which
        nothing was dialed is fourteen buckets — `drawable` by count — and it
        drew fourteen zero-height bars on a blank axis with no sentence at all.
        A supervisor reads that as a broken screen.
      */
      mocks.getAgencyCampaignSeries.mockResolvedValue(series({
        buckets: [
          bucket('2026-08-20', 0, 0),
          bucket('2026-08-21', 0, 0),
          bucket('2026-08-22', 0, 0),
        ],
      }));
      render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
      await settle();

      expect(screen.getByTestId('campaign-series-single').textContent).toContain('Nothing was dialed');
      expect(screen.queryByTestId('campaign-activity-chart')).toBeNull();
    });

    it('distinguishes a range with no days from one where nothing was dialed', async () => {
      /*
        These two used to be one sentence on this side and two on the rate chart
        — so the same empty response produced contradictory explanations on the
        two tabs of one workspace.
      */
      mocks.getAgencyCampaignSeries.mockResolvedValue(series({ buckets: [] }));
      render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
      await settle();

      expect(screen.getByTestId('campaign-series-single').textContent)
        .toContain('There are no days in this range');
    });

    it('names the range that WOULD draw, for a one-day window', async () => {
      mocks.getAgencyCampaignSeries.mockResolvedValue(series({ buckets: busyDays(1) }));
      render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
      await settle();

      // Not "no data": a single-column bar chart is a stat tile wearing axes,
      // and the next action — pick a wider range — is the whole message.
      expect(screen.getByTestId('campaign-series-single').textContent).toMatch(/wider range/i);
    });

    it('explains a rate chart that declined to draw, and does not print 0%', async () => {
      // Every day below the publishing threshold: measured, but not publishable.
      mocks.getAgencyCampaignSeries.mockResolvedValue(series({
        buckets: [bucket('2026-08-20', 4, 2, 1), bucket('2026-08-21', 3, 1, 0)],
      }));
      render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="rates" />);
      await settle();

      const note = screen.getByTestId('campaign-series-no-trend').textContent ?? '';
      expect(note).toContain(String(RATE_MIN_ATTEMPTS));
      expect(note).not.toContain('0%');
      expect(screen.queryByTestId('campaign-rate-chart')).toBeNull();
    });
  });

  describe('the notes that qualify what is on screen', () => {
    it('names the campaign’s own time zone when the server echoed one back', async () => {
      mocks.getAgencyCampaignSeries.mockResolvedValue(
        series({ buckets: busyDays(4), timezone: 'Asia/Kolkata' }),
      );
      render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
      await settle();

      expect(screen.getByTestId('campaign-series-notes').textContent).toContain('Asia/Kolkata');
    });

    it('says today is still filling on a live campaign', async () => {
      mocks.getAgencyCampaignSeries.mockResolvedValue(series({ buckets: busyDays(4) }));
      render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
      await settle();

      expect(screen.getByTestId('campaign-series-notes').textContent).toContain('still in progress');
    });

    it('does NOT say that on a campaign that has stopped', async () => {
      /*
        A timezone, so the notes block RENDERS and the assertion below is about
        what it says rather than about whether it exists. Without one this
        campaign produces no notes at all, and "the text is absent" would pass
        for the wrong reason — the vacuous version of this test.
      */
      mocks.getAgencyCampaignSeries.mockResolvedValue(
        series({ buckets: busyDays(4), timezone: 'Europe/London' }),
      );
      render(
        <CampaignSeriesSection
          campaignId="camp-1"
          campaign={campaign({ status: 'stopped', ended_at: '2026-08-20T18:00:00.000Z' })}
          chart="activity"
        />,
      );
      await settle();

      // Nothing else will be dialled on it, so "today is still filling" would be
      // a sentence about a campaign that is finished.
      const notes = screen.getByTestId('campaign-series-notes').textContent ?? '';
      expect(notes).toContain('Europe/London');
      expect(notes).not.toContain('still in progress');
    });
  });

  describe('the range picker', () => {
    it('opens on the whole campaign for a terminal one, and 14 days for a live one', async () => {
      render(
        <CampaignSeriesSection
          campaignId="camp-1"
          campaign={campaign({ status: 'stopped', ended_at: '2026-08-20T18:00:00.000Z' })}
          chart="activity"
        />,
      );
      await settle();
      expect(screen.getByRole('button', { name: 'Whole campaign' }).getAttribute('aria-pressed')).toBe('true');
      cleanup();

      render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
      await settle();
      expect(screen.getByRole('button', { name: 'Last 14 days' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('withholds "Whole campaign" when the campaign has no start we were told about', async () => {
      render(
        <CampaignSeriesSection
          campaignId="camp-1"
          campaign={campaign({ started_at: null })}
          chart="activity"
        />,
      );
      await settle();
      // Offering it would mean labelling a fallback 14-day window "Whole
      // campaign" on exactly the campaigns the option exists for.
      expect(screen.queryByRole('button', { name: 'Whole campaign' })).toBeNull();
    });

    it('re-reads with a new range when a window is picked', async () => {
      render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
      await settle();
      const firstFrom = mocks.getAgencyCampaignSeries.mock.calls[0]![1].from;

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
      });
      await settle();

      expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(2);
      expect(mocks.getAgencyCampaignSeries.mock.calls[1]![1].from).not.toBe(firstFrom);
      expect(screen.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('is a group of pressed buttons, not a tablist and not a radiogroup', async () => {
      render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
      await settle();

      // `aria-pressed` promises no keyboard contract beyond Tab, which is what
      // plain tabbable buttons actually provide. A radiogroup would promise
      // arrow-key traversal with a roving tabindex; a tablist would claim the
      // content below is one tab among several already on the page.
      expect(screen.getByRole('group', { name: 'Date range' })).toBeTruthy();
      expect(screen.queryByRole('radiogroup')).toBeNull();
      expect(screen.queryByRole('tablist')).toBeNull();
    });
  });

  describe('the campaign\'s status reaches the range, not just its timestamps', () => {
    /*
      The pure range function decides "has this finished?" from the STATUS,
      because `ended_at` is optional on the row. The hook builds its argument
      from individual primitives, and it left `status` out — so the function saw
      a campaign with no status, concluded it was live, and stamped
      `partialToday` on every range. The unit tests all passed: they call the
      pure function directly, where the caller's omission is invisible.

      These assert through the real component, which is the only level the hole
      existed at.
    */
    it('does not tell a stopped campaign that today is still in progress', async () => {
      mocks.getAgencyCampaignSeries.mockResolvedValue(
        series({ buckets: busyDays(4), timezone: 'Europe/London' }),
      );
      render(
        <CampaignSeriesSection
          campaignId="camp-1"
          // No `ended_at` — the case a server that predates the timestamps sends.
          campaign={campaign({ status: 'stopped', ended_at: null })}
          chart="activity"
        />,
      );
      await settle();

      expect(screen.getByTestId('campaign-series-notes').textContent)
        .not.toContain('still in progress');
    });

    it('still says it about a campaign that really is running', async () => {
      mocks.getAgencyCampaignSeries.mockResolvedValue(series({ buckets: busyDays(4) }));
      render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
      await settle();

      expect(screen.getByTestId('campaign-series-notes').textContent)
        .toContain('still in progress');
    });

    it('opens a finished campaign on its whole life, timestamp or not', async () => {
      render(
        <CampaignSeriesSection
          campaignId="camp-1"
          campaign={campaign({ status: 'completed', ended_at: null })}
          chart="activity"
        />,
      );
      await settle();

      expect(screen.getByRole('button', { name: 'Whole campaign' }).getAttribute('aria-pressed'))
        .toBe('true');
    });
  });

  describe('a status change that moves no boundary is not a refetch', () => {
    /*
      Pause is the control a supervisor presses while watching this page. The
      range depends on whether the campaign has FINISHED, and `running → paused`
      does not change that — `from`, `to` and the default window are all
      identical — so a refetch there buys nothing and costs the chart.
    */
    it('does not re-read when a campaign is paused or resumed', async () => {
      mocks.getAgencyCampaignSeries.mockResolvedValue(series({ buckets: busyDays(4) }));
      const { rerender } = render(
        <CampaignSeriesSection campaignId="camp-1" campaign={campaign({ status: 'running' })} chart="activity" />,
      );
      await settle();
      expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(1);

      rerender(
        <CampaignSeriesSection campaignId="camp-1" campaign={campaign({ status: 'paused' })} chart="activity" />,
      );
      await settle();
      rerender(
        <CampaignSeriesSection campaignId="camp-1" campaign={campaign({ status: 'running' })} chart="activity" />,
      );
      await settle();

      expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(1);
    });

    it('DOES re-read when the campaign actually finishes', async () => {
      mocks.getAgencyCampaignSeries.mockResolvedValue(series({ buckets: busyDays(4) }));
      const { rerender } = render(
        <CampaignSeriesSection campaignId="camp-1" campaign={campaign({ status: 'running' })} chart="activity" />,
      );
      await settle();

      rerender(
        <CampaignSeriesSection campaignId="camp-1" campaign={campaign({ status: 'stopped' })} chart="activity" />,
      );
      await settle();

      expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(2);
    });

    it('keeps the drawn chart on screen while a refetch is in flight', async () => {
      mocks.getAgencyCampaignSeries.mockResolvedValue(series({ buckets: busyDays(4) }));
      render(
        <CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />,
      );
      await settle();
      expect(screen.getByTestId('campaign-activity-chart')).toBeTruthy();

      // A read that never settles, so the in-flight state is the state under
      // test. The chart must still be there, marked as one read behind.
      mocks.getAgencyCampaignSeries.mockReturnValue(new Promise(() => {}));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
      });

      expect(screen.getByTestId('campaign-activity-chart')).toBeTruthy();
      expect(screen.queryByTestId('campaign-series-loading')).toBeNull();
      expect(screen.getByTestId('campaign-series-body').getAttribute('data-stale')).toBe('true');
    });

    it('still shows a skeleton for the very first read', async () => {
      // There is genuinely nothing behind it yet.
      mocks.getAgencyCampaignSeries.mockReturnValue(new Promise(() => {}));
      render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
      expect(screen.getByTestId('campaign-series-loading')).toBeTruthy();
    });
  });

  describe('the Refresh control reaches the charts', () => {
    it('re-reads when the token changes, and not on the first render', async () => {
      /*
        The hook deliberately does not poll, so Refresh was the only way to bring
        these charts forward — and it was not wired. Pressing it moved the
        counters and the "Updated" stamp while the charts silently kept showing
        the older read, with nothing on screen saying they were stale.
      */
      const { rerender } = render(
        <CampaignSeriesSection
          campaignId="camp-1"
          campaign={campaign()}
          chart="activity"
          reloadToken={0}
        />,
      );
      await settle();
      // Mount fetches once; the token effect must NOT add a second request.
      expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(1);

      rerender(
        <CampaignSeriesSection
          campaignId="camp-1"
          campaign={campaign()}
          chart="activity"
          reloadToken={1}
        />,
      );
      await settle();
      expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(2);
    });

    it('ignores a re-render that does not move the token', async () => {
      // The page re-renders every 10s from the stats poll. If that reached the
      // charts, each tick would re-request up to 92 buckets.
      const { rerender } = render(
        <CampaignSeriesSection
          campaignId="camp-1"
          campaign={campaign()}
          chart="activity"
          reloadToken={3}
        />,
      );
      await settle();
      rerender(
        <CampaignSeriesSection
          campaignId="camp-1"
          // A fresh campaign object each tick, exactly as the poll hands down.
          campaign={campaign()}
          chart="activity"
          reloadToken={3}
        />,
      );
      await settle();
      expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(1);
    });
  });

  it('sends nothing before TenantContext has resolved an account', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: undefined });
    render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
    await settle();

    // A request without `X-Account-Id` comes back as a 400 about a header this
    // client never sent — an error with nothing pointing back here.
    expect(mocks.getAgencyCampaignSeries).not.toHaveBeenCalled();
  });

  it('asks for day buckets over the half-open range it will then describe', async () => {
    render(<CampaignSeriesSection campaignId="camp-1" campaign={campaign()} chart="activity" />);
    await settle();

    const [id, query, tenant, account] = mocks.getAgencyCampaignSeries.mock.calls[0]!;
    expect(id).toBe('camp-1');
    expect(query.bucket).toBe('day');
    // The exclusive end is the start of the day AFTER the last day shown —
    // never a `T23:59:59.999` literal, which is ambiguous wherever the clocks
    // go back at midnight.
    expect(query.to).toBe('2026-08-28T00:00:00.000Z');
    expect(tenant).toBe('tenant-1');
    expect(account).toBe('account-1');
  });
});
