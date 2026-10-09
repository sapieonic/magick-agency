import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect, useState } from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { compareMissing } from '../../utils/agencyCompareTray';
import { hollowRow, rosterBenchmark, rosterPage, rosterRow, thinRow } from '../helpers/roster';
import type { AgencyRosterPage } from '../../types/agency-stats';

/**
 * The compare tray — two to four people from the roster against the floor's band.
 *
 * ── E7 is the whole file ──────────────────────────────────────────────────
 *  1. **It issues ZERO requests.** Every API function this repo's agency surfaces use
 *     is stubbed below and asserted never called, through opening the tray, picking
 *     people and rendering the comparison. The mutation that reds it is any fetch at
 *     all — including the tempting one, a `compare_to` param on the per-agent route,
 *     which would expose that param on the AGENT's own scorecard in the same edit
 *     because the server shares one query whitelist between the two.
 *  2. **It is suppressed entirely on a pooled cohort.** A pooled multi-campaign band
 *     is not a peer group, and `mixedCohortNote` above the table has already told the
 *     reader the per-person comparison is switched off there.
 *  3. **A metric withheld on the roster stays withheld here.** The tray may not be a
 *     way to read a number the table declined to print.
 */

const mocks = vi.hoisted(() => ({
  getAgencyGroupedStats: vi.fn(),
  getAgencyRoster: vi.fn(),
  getAgentStats: vi.fn(),
  getMyStats: vi.fn(),
  getAgentAttempts: vi.fn(),
  getMyAttempts: vi.fn(),
  getMyCampaigns: vi.fn(),
  trackOpened: vi.fn(),
}));

/*
  Every read on this module, stubbed. The tray imports none of them — which is the
  point: this mock is what turns "it fetches nothing" from a claim about the import
  list into an assertion that fails the moment somebody adds one.
*/
vi.mock('../../api/agencyStats', () => ({
  getAgencyGroupedStats: mocks.getAgencyGroupedStats,
  getAgencyRoster: mocks.getAgencyRoster,
  getAgentStats: mocks.getAgentStats,
  getMyStats: mocks.getMyStats,
  getAgentAttempts: mocks.getAgentAttempts,
  getMyAttempts: mocks.getMyAttempts,
  getMyCampaigns: mocks.getMyCampaigns,
}));
vi.mock('../../analytics/events', () => ({
  trackAgencyCompareTrayOpened: mocks.trackOpened,
}));

import { CompareTray } from '../../components/agency/CompareTray';

/**
 * The tray is a CONTROLLED component, so its tests need an owner.
 *
 * Its open state and its selection moved out to `AgentAnalyticsSection` because they
 * have to outlive the `loading` transition every roster refetch passes through — the
 * tray is mounted only on a `ready` page, so state held inside it was destroyed by
 * every column-header press, and its own pruning of ids a new page no longer carries
 * was unreachable code.
 *
 * This host is the minimum of that contract: it owns the two values and prunes on a
 * page change, exactly as the section does. The pruning is replicated here rather
 * than asserted here — the REAL owner's effect is pinned in
 * `AgentAnalyticsSection.test.tsx` ("prunes a compare selection the new page no
 * longer carries"), so nothing in this file passes because the harness was written
 * to make it pass.
 */
function TrayHost({ page }: { page: AgencyRosterPage }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<readonly string[]>([]);
  useEffect(() => {
    const missing = compareMissing(page, selected);
    if (missing.length === 0) return;
    setSelected((prev) => prev.filter((id) => !missing.includes(id)));
  }, [page, selected]);
  return (
    <CompareTray
      page={page}
      window="week"
      open={open}
      onOpenChange={setOpen}
      selected={selected}
      onSelectedChange={setSelected}
    />
  );
}

function renderTray(page: AgencyRosterPage = rosterPage({ rows: [rosterRow(), thinRow()] })) {
  const view = render(<TrayHost page={page} />);
  return {
    rerenderWith: (next: AgencyRosterPage) => view.rerender(<TrayHost page={next} />),
  };
}

/** Every stubbed read, so a case can assert the whole surface is silent. */
function totalRequests(): number {
  return (
    mocks.getAgencyGroupedStats.mock.calls.length +
    mocks.getAgencyRoster.mock.calls.length +
    mocks.getAgentStats.mock.calls.length +
    mocks.getMyStats.mock.calls.length +
    mocks.getAgentAttempts.mock.calls.length +
    mocks.getMyAttempts.mock.calls.length +
    mocks.getMyCampaigns.mock.calls.length
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('CompareTray — E7, it fetches nothing', () => {
  it('issues no request through opening, picking and rendering', () => {
    renderTray();
    expect(totalRequests()).toBe(0);

    fireEvent.click(screen.getByTestId('compare-tray-open'));
    expect(totalRequests()).toBe(0);

    fireEvent.click(screen.getByTestId('compare-pick-user-1'));
    fireEvent.click(screen.getByTestId('compare-pick-user-thin'));
    expect(screen.getByTestId('compare-tray-table')).toBeTruthy();
    expect(totalRequests()).toBe(0);
  });

  it('has no loading, error or retry state, because there is nothing to fail', () => {
    renderTray();
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    fireEvent.click(screen.getByTestId('compare-pick-user-1'));
    fireEvent.click(screen.getByTestId('compare-pick-user-thin'));
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('CompareTray — E7, suppressed where a band is not a peer group', () => {
  it('renders nothing at all on the pooled all-campaigns read', () => {
    /**
     * The mutation this case exists for. `campaign_id: null` pools every campaign in
     * the account into one cohort — different dealerships' lead lists — and
     * `mixedCohortNote` directly above the table says the per-person comparison is
     * switched off there. A tray is the most emphatic version of exactly that
     * comparison, so it must not even offer its opening control.
     */
    const { rerenderWith } = renderTray(
      rosterPage({ campaign_id: null, rows: [rosterRow(), thinRow()] }),
    );
    expect(screen.queryByTestId('compare-tray-open')).toBeNull();
    expect(screen.queryByTestId('compare-tray')).toBeNull();

    // And it is the POOLED scope doing it, not the row count: the same rows on one
    // campaign do offer the tray.
    rerenderWith(rosterPage({ rows: [rosterRow(), thinRow()] }));
    expect(screen.getByTestId('compare-tray-open')).toBeTruthy();
  });

  it('renders nothing with fewer than two people to compare', () => {
    renderTray(rosterPage({ rows: [rosterRow()] }));
    expect(screen.queryByTestId('compare-tray-open')).toBeNull();
  });

  it('disappears if a refetch pools the cohort while the tray is open', () => {
    /**
     * The guard is inside the component rather than only in the caller, so a page that
     * changes underneath an OPEN tray cannot leave a per-person comparison against a
     * pooled band on screen.
     */
    const { rerenderWith } = renderTray();
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    expect(screen.getByTestId('compare-tray')).toBeTruthy();
    rerenderWith(rosterPage({ campaign_id: null, rows: [rosterRow(), thinRow()] }));
    expect(screen.queryByTestId('compare-tray')).toBeNull();
  });
});

describe('CompareTray — the picker', () => {
  it('offers exactly the people on the page', () => {
    renderTray(rosterPage({ rows: [rosterRow(), hollowRow(), thinRow()] }));
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    expect(screen.getByTestId('compare-pick-user-1')).toBeTruthy();
    expect(screen.getByTestId('compare-pick-user-hollow')).toBeTruthy();
    expect(screen.getByTestId('compare-pick-user-thin')).toBeTruthy();
    expect(screen.queryByTestId('compare-pick-user-absent')).toBeNull();
  });

  it('asks for two before it shows anything', () => {
    renderTray();
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    expect(screen.getByTestId('compare-tray-incomplete')).toBeTruthy();
    fireEvent.click(screen.getByTestId('compare-pick-user-1'));
    expect(screen.getByTestId('compare-tray-hint').textContent).toContain('at least 2');
    expect(screen.queryByTestId('compare-tray-table')).toBeNull();
    fireEvent.click(screen.getByTestId('compare-pick-user-thin'));
    expect(screen.getByTestId('compare-tray-table')).toBeTruthy();
  });

  it('stops at four, and disables the rest rather than swapping one out', () => {
    /**
     * Beyond four a tray is a second roster and the roster already exists. Dropping the
     * oldest pick to make room would remove somebody the reader deliberately chose,
     * invisibly, at the far end of the table.
     */
    const rows = [1, 2, 3, 4, 5].map((n) =>
      rosterRow({ agent_user_id: `user-${n}`, agent_name: `Agent ${n}` }),
    );
    renderTray(rosterPage({ rows }));
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    for (const n of [1, 2, 3, 4]) {
      fireEvent.click(screen.getByTestId(`compare-pick-user-${n}`));
    }
    const fifth = screen.getByTestId('compare-pick-user-5') as HTMLInputElement;
    expect(fifth.disabled).toBe(true);
    expect(screen.getByTestId('compare-tray-hint').textContent).toContain('most this compares');
    // An untick still works at the cap.
    fireEvent.click(screen.getByTestId('compare-pick-user-1'));
    expect((screen.getByTestId('compare-pick-user-5') as HTMLInputElement).disabled).toBe(false);
  });

  it('prunes a pick the page no longer carries', () => {
    /**
     * A selection outlives a refetch. Left in place, the hint would read "2 picked"
     * over one column — the kind of small lie that makes a reader distrust the figures
     * beside it.
     */
    const { rerenderWith } = renderTray(rosterPage({ rows: [rosterRow(), thinRow()] }));
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    fireEvent.click(screen.getByTestId('compare-pick-user-1'));
    fireEvent.click(screen.getByTestId('compare-pick-user-thin'));
    expect(screen.getByTestId('compare-row-user-thin')).toBeTruthy();

    rerenderWith(rosterPage({ rows: [rosterRow(), hollowRow()] }));
    expect(screen.queryByTestId('compare-row-user-thin')).toBeNull();
    expect(screen.getByTestId('compare-tray-hint').textContent).toContain('at least 2');
  });

  it('lists the columns in the PAGE’s order, not the tick order', () => {
    renderTray(rosterPage({ rows: [rosterRow(), hollowRow(), thinRow()] }));
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    fireEvent.click(screen.getByTestId('compare-pick-user-thin'));
    fireEvent.click(screen.getByTestId('compare-pick-user-1'));
    const ids = [...screen.getByTestId('compare-tray-table').querySelectorAll('tbody tr')].map(
      (row) => row.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['compare-row-user-1', 'compare-row-user-thin']);
  });
});

describe('CompareTray — E7, a withheld metric stays withheld', () => {
  function openWith(page: AgencyRosterPage, ...ids: string[]) {
    renderTray(page);
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    for (const id of ids) fireEvent.click(screen.getByTestId(`compare-pick-${id}`));
  }

  it('prints WORDS, not a faint percentage, for a thin row’s rates', () => {
    /**
     * The mutation this case exists for: a tray that formatted the served rates
     * directly ("to keep the columns dense") would print `100%` and `27.3%` beside a
     * named person — the exact numbers the roster refuses to show for that row, one
     * click away, on a screen a supervisor acts on.
     *
     * Neither figure appears anywhere else in these fixtures, so their absence from
     * the DOM cannot pass by coincidence.
     */
    openWith(rosterPage({ rows: [rosterRow(), thinRow()] }), 'user-1', 'user-thin');
    const row = screen.getByTestId('compare-row-user-thin');
    expect(within(row).getAllByText('Not enough calls').length).toBeGreaterThan(0);
    expect(row.textContent).toContain('11 dials');
    expect(row.textContent).toContain('11 connects');
    expect(row.textContent).not.toContain('100%');
    expect(row.textContent).not.toContain('27.3%');
  });

  it('keeps the counts that explain WHY the rates were withheld', () => {
    openWith(rosterPage({ rows: [rosterRow(), thinRow()] }), 'user-1', 'user-thin');
    const row = screen.getByTestId('compare-row-user-thin');
    // Dials, connects and conversions all stay: a column of "Not enough calls" with no
    // denominator beside it is unreadable.
    expect(within(row).getAllByText('11').length).toBe(2);
    expect(within(row).getByText('3')).toBeTruthy();
  });

  it('withholds the CONVERSION rate alone on a row with dials and no connects', () => {
    /**
     * 400 dials, 3 connects. `rates_reportable` clears the dial threshold so the
     * connect rate is shown; `success_rate_reportable` does not clear the connect one,
     * so `33.3%` must be absent. The same row, two answers — which is why one flag over
     * one denominator cannot serve both rates.
     */
    openWith(rosterPage({ rows: [rosterRow(), hollowRow()] }), 'user-1', 'user-hollow');
    const row = screen.getByTestId('compare-row-user-hollow');
    expect(within(row).getByText('0.8%')).toBeTruthy();
    expect(row.textContent).not.toContain('33.3%');
    expect(row.textContent).toContain('3 connects');
  });

  it('says CONNECTS in the tooltip, on the surface most likely to be read closely', () => {
    /**
     * ⚠️ The third copy of "Fewer than 20 calls", and the one where it does the most
     * damage: every column beside a withheld cell here is another person's answer to
     * the same question, so a reader hovering the one that says "not enough calls"
     * beside a neighbour's real percentage is asking exactly what was not enough. On
     * this row it is connects — three of them — while four hundred dials sit in the
     * column to the left.
     */
    openWith(rosterPage({ rows: [rosterRow(), hollowRow()] }), 'user-1', 'user-hollow');
    const row = screen.getByTestId('compare-row-user-hollow');
    expect(within(row).getByTitle(/Fewer than 20 connects/)).toBeTruthy();
    expect(row.innerHTML).not.toContain('Fewer than 20 calls');
  });
});

describe('CompareTray — the floor row', () => {
  function open() {
    renderTray(rosterPage({ rows: [rosterRow(), thinRow()] }));
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    fireEvent.click(screen.getByTestId('compare-pick-user-1'));
    fireEvent.click(screen.getByTestId('compare-pick-user-thin'));
  }

  it('pins the FLOOR’s own figures and bands, named as the floor', () => {
    open();
    const floor = screen.getByTestId('compare-floor-row');
    expect(floor.textContent).toContain('This floor');
    expect(floor.textContent).toContain('everyone who dialled, not just the people above');
    // The benchmark's pooled counts, not the sum of the two columns above.
    expect(within(floor).getByText('2,495')).toBeTruthy();
    expect(screen.getByTestId('compare-band-connect_rate').textContent).toContain('middle half');
    expect(screen.getByTestId('compare-rated-count').textContent).toContain('enough calls to rate');
  });

  it('says the bands are the whole floor’s, not the middle half of the columns', () => {
    /**
     * The one sentence the tray adds. Without it "middle half 28.4%–41.2%" reads as a
     * claim about the two people picked, which is a much narrower claim than the one
     * being made.
     */
    open();
    expect(screen.getByTestId('compare-tray-basis').textContent).toContain('whole floor’s');
  });

  it('renders no AHT band when the payload did not carry the block', () => {
    renderTray(
      rosterPage({
        rows: [rosterRow(), thinRow()],
        benchmark: rosterBenchmark({ aht: undefined }),
      }),
    );
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    fireEvent.click(screen.getByTestId('compare-pick-user-1'));
    fireEvent.click(screen.getByTestId('compare-pick-user-thin'));
    expect(screen.queryByTestId('compare-band-aht')).toBeNull();
    // The pooled scalar beside it is unaffected and stays on screen.
    expect(screen.getByTestId('compare-floor-row').textContent).toContain('1:14');
  });

  it('shows a duration band in words and the cell figure as a stopwatch', () => {
    open();
    expect(screen.getByTestId('compare-band-aht').textContent).toContain('median 1m 14s');
    expect(screen.getByTestId('compare-row-user-1').textContent).toContain('1:15');
  });
});

describe('CompareTray — E10, one event on open', () => {
  it('fires once, describing the PAGE rather than a request', () => {
    renderTray(rosterPage({ rows: [rosterRow(), thinRow()] }));
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    expect(mocks.trackOpened).toHaveBeenCalledTimes(1);
    expect(mocks.trackOpened).toHaveBeenCalledWith({
      campaign_id: 'camp-1',
      window: 'week',
      rows_available: 2,
      agents_selected: 0,
      agents_rated: 6,
      benchmark_usable: true,
    });
  });

  it('does not re-fire on a close and re-open of the same page', () => {
    renderTray();
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    fireEvent.click(screen.getByTestId('compare-tray-close'));
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    expect(mocks.trackOpened).toHaveBeenCalledTimes(1);
  });

  it('fires again once the page underneath has actually changed', () => {
    const { rerenderWith } = renderTray();
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    fireEvent.click(screen.getByTestId('compare-tray-close'));
    rerenderWith(
      rosterPage({ rows: [rosterRow(), thinRow()], from: '2026-08-01T00:00:00.000Z' }),
    );
    fireEvent.click(screen.getByTestId('compare-tray-open'));
    expect(mocks.trackOpened).toHaveBeenCalledTimes(2);
  });
});
