import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { AgentPerformancePanel } from '../../components/agency/AgentPerformancePanel';
import {
  AGENT_HISTORY_REACH_NOTE,
  AGENT_STATS_WINDOWS,
  headlineTrio,
  type AgentStatsWindow,
} from '../../utils/agencyAgentPerformance';
import type { PeriodStates } from '../../hooks/useAgentPerformance';
import type { AgencyAgentStats } from '../../types/agency-stats';

/**
 * The shared panel, driven directly rather than through either of its two pages.
 *
 * ── Why some of this cannot be tested through a page ───────────────────────
 * `campaignFilter` is a controlled prop: the panel renders the value, the caller
 * owns it. Two of the rules below are about states a caller can be IN but that no
 * sequence of clicks on either page produces on demand — chiefly "a scope is
 * applied and is not in the options list", which is what a workspace switch used
 * to leave behind. Reaching that through `AgentPerformancePage` would mean
 * arranging a stale id through the very reset that now prevents it, which tests
 * the arrangement rather than the rule.
 *
 * The pages keep their own end-to-end coverage of the wiring; this file pins the
 * panel's own contract.
 */

afterEach(cleanup);

function stats(over: Partial<AgencyAgentStats> = {}): AgencyAgentStats {
  return {
    agent_user_id: 'user-1',
    bucket: 'day',
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-20T12:00:00.000Z',
    totals: {
      attempts: 42,
      connected: 17,
      connect_rate_pct: 40.5,
      successes: 4,
      success_rate_pct: 23.5,
      talk_seconds: 1800,
      wrapup_seconds: 240,
      aht_seconds: 105,
      campaigns: 1,
    },
    buckets: [],
    by_campaign: [],
    ...over,
  };
}

const READY: PeriodStates = {
  today: { status: 'ready', stats: stats() },
  week: { status: 'ready', stats: stats() },
  last_week: { status: 'ready', stats: stats() },
  month: { status: 'ready', stats: stats() },
  last_month: { status: 'ready', stats: stats() },
};

function renderPanel(options: {
  names?: [string, string | null][];
  scope?: string | null;
  onChange?: (id: string | null) => void;
  withFilter?: boolean;
}) {
  const { names = [], scope = null, onChange = vi.fn(), withFilter = true } = options;
  return render(
    <AgentPerformancePanel
      periods={READY}
      windows={AGENT_STATS_WINDOWS}
      selected="today"
      onSelect={vi.fn()}
      campaignNames={new Map(names)}
      campaignFilter={withFilter ? { value: scope, onChange } : undefined}
    />,
  );
}

describe('AgentPerformancePanel — the campaign scope selector', () => {
  it('is absent when there is no choice to make and nothing applied', () => {
    // One nameable campaign means the record already IS that campaign's, so a
    // selector would offer a filter whose only setting changes nothing.
    renderPanel({ names: [['camp-1', 'Renewals']] });
    expect(screen.queryByTestId('campaign-scope')).toBeNull();
  });

  it('is absent when the caller threads no filter at all', () => {
    // A caller that has not wired the scope into its hook must not show a control
    // whose choice would change nothing, which is worse than no control.
    renderPanel({ names: [['camp-1', 'Renewals'], ['camp-2', 'Winback']], withFilter: false });
    expect(screen.queryByTestId('campaign-scope')).toBeNull();
  });

  it('is present, and clearable, when a scope is applied with nothing to choose from', () => {
    /**
     * The defect. Visibility was `scopeOptions.length > 1` while the filter
     * APPLIES on `value !== null`, so a scope could be in force with no control on
     * screen: the three tiles counted one campaign, the note said "Every figure
     * below counts this campaign only", and there was no way to switch it off.
     *
     * That is precisely what a workspace switch produced — a campaign id from the
     * previous tenant, absent from the new options list. The page now remounts the
     * scope on a switch; this is the rule that makes the control honest whatever
     * put the value there.
     */
    const onChange = vi.fn();
    renderPanel({ names: [['camp-1', 'Renewals']], scope: 'camp-9', onChange });

    const select = screen.getByTestId('campaign-scope') as HTMLSelectElement;
    // It reports what is actually applied, rather than falling back to "All
    // campaigns" while the request is scoped.
    expect(select.value).toBe('camp-9');
    expect(screen.getByTestId('campaign-scope-note')).toBeTruthy();

    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('labels an applied scope it cannot name with the shortened id, never a blank', () => {
    // The same degradation the per-campaign breakdown uses. A blank option would
    // say the figures belong to nothing; an invented name would assert something
    // the server declined to.
    renderPanel({ names: [['camp-1', 'Renewals']], scope: '4f21ab90-1111-2222-3333-444455556666' });
    expect(screen.getByTestId('campaign-scope').textContent).toContain('Campaign 4f21ab90');
  });

  it('does not duplicate an applied scope that IS in the options', () => {
    renderPanel({
      names: [['camp-1', 'Renewals'], ['camp-2', 'Winback']],
      scope: 'camp-2',
    });
    const options = within(screen.getByTestId('campaign-scope')).getAllByRole('option');
    expect(options.map((option) => (option as HTMLOptionElement).value))
      .toEqual(['', 'camp-1', 'camp-2']);
  });

  it('is reachable by its own label rather than only by a test id', () => {
    /**
     * Stripping `htmlFor` from the label left 111 tests across four files
     * passing, because every one of them reached the control by `data-testid`. A
     * test id is not an accessible name.
     */
    renderPanel({ names: [['camp-1', 'Renewals'], ['camp-2', 'Winback']] });
    expect(screen.getByLabelText('Campaign')).toBe(screen.getByTestId('campaign-scope'));
  });
});

describe('AgentPerformancePanel — the headline trio', () => {
  it('renders each figure’s hint, not just its label', () => {
    /**
     * `headlineTrio` has always populated `hint` and the panel never read it, so
     * the agent got a bare "Dials · Connect rate · Conversations" while the
     * supervisor's campaign screens explained each of their own figures. The
     * person being measured is the one who most needs to know what the number
     * counts.
     */
    renderPanel({});
    for (const figure of headlineTrio(undefined)) {
      // The label appears on all three tiles as well as in the key, so it is
      // asserted as "present at least once"; the hint is said exactly once.
      expect(screen.getAllByText(figure.label).length).toBeGreaterThan(0);
      expect(screen.getByText(figure.hint)).toBeTruthy();
    }
  });

  it('associates each hint with the figure it explains', () => {
    // Rendered as a definition list, so the pairing is in the markup rather than
    // in the reading order — the label and its clause are not adjacent on screen.
    renderPanel({});
    const key = screen.getByTestId('headline-key');
    const terms = within(key).getAllByRole('term');
    const definitions = within(key).getAllByRole('definition');

    expect(terms.map((node) => node.textContent)).toEqual(['Dials', 'Connect rate', 'Conversations']);
    expect(definitions.map((node) => node.textContent)).toEqual(
      headlineTrio(undefined).map((figure) => figure.hint),
    );
  });

  it('says the dialer placed the call, not that it was placed TO the agent', () => {
    /**
     * "Calls placed to you" is backwards for an outbound predictive dialer: core
     * places the dial to a CUSTOMER and reserves the agent onto it. An agent
     * reading that their dials were "placed to" them would reasonably conclude
     * this screen is counting inbound calls.
     */
    const dials = headlineTrio(undefined)[0]!;
    expect(dials.hint).not.toMatch(/placed to you/i);
    expect(dials.hint).toMatch(/dialer/i);
    expect(screen.queryByText(/calls placed to you/i)).toBeNull();
  });
});

describe('AgentPerformancePanel — the period tiles are tabs', () => {
  /** A driver, so a click has somewhere to move the selection to. */
  function Tabs() {
    const [selected, setSelected] = useState<AgentStatsWindow>('today');
    return (
      <AgentPerformancePanel
        periods={READY}
        windows={AGENT_STATS_WINDOWS}
        selected={selected}
        onSelect={setSelected}
        campaignNames={new Map()}
      />
    );
  }

  it('exposes every window as a tab, with the selected one marked', () => {
    /**
     * Removing `role="tab"` and `aria-selected` from these tiles left every test
     * that reached them by `data-testid` passing — so the one thing a screen
     * reader uses to tell a period selector from a row of buttons was unpinned.
     *
     * Asserted against `AGENT_STATS_WINDOWS` rather than a literal count. The
     * count was 3 and is 5, and the reason it moved is that "three tiles fit in
     * a row" had become the reason an agent could not ask what they did last
     * month — so a test that pins a number here would be pinning the layout that
     * caused it.
     */
    render(<Tabs />);

    expect(screen.getAllByRole('tab')).toHaveLength(AGENT_STATS_WINDOWS.length);
    expect(screen.getByRole('tab', { name: /^Today/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /^This week/ }).getAttribute('aria-selected')).toBe('false');
  });

  it('offers the two COMPLETED windows, which is the whole point of widening it', () => {
    /**
     * The regression that matters. An agent asking "what did I do last month"
     * had no answer anywhere in the product: every window ended at `now`, so on
     * the 1st of a month "This month" was today, and their own history was a few
     * hours long. Losing these two tiles would restore that silently — every
     * other assertion here would still pass.
     */
    render(<Tabs />);

    expect(screen.getByRole('tab', { name: /^Last week/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Last month/ })).toBeTruthy();
  });

  it('states how far back the figures reach when the caller supplies the note', () => {
    /*
     * Five windows read as "all of it" to somebody who has worked here a year, so
     * the page states its reach. The reach is a PRODUCT limit, not a server one:
     * the per-agent read accepts 366 days and 92 is the roster's bound. This
     * comment used to name the roster's, and the copy inherited it.
     */
    render(
      <AgentPerformancePanel
        periods={READY}
        windows={AGENT_STATS_WINDOWS}
        selected="today"
        onSelect={vi.fn()}
        reachNote={AGENT_HISTORY_REACH_NOTE}
        campaignNames={new Map()}
      />,
    );

    const note = screen.getByTestId('history-reach-note').textContent;
    expect(note).toContain('last month');
    expect(note).toMatch(/My calls/i);
    // Pinned as an absence too — presence-only assertions stay green if the
    // 92-day ceiling is put back. See the page-level twin for the full argument.
    expect(note).not.toMatch(/\b92\b/);
    expect(note).not.toMatch(/\bcaps?\b/i);
    expect(note).not.toMatch(/\bserver\b/i);
  });

  it('moves the selection when a tab is chosen', () => {
    render(<Tabs />);
    fireEvent.click(screen.getByRole('tab', { name: /^This month/ }));

    expect(screen.getByRole('tab', { name: /^This month/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /^Today/ }).getAttribute('aria-selected')).toBe('false');
  });

  it('points every tab at the panel it controls', () => {
    // Otherwise the tablist is three buttons beside an unrelated region, and the
    // relationship exists only visually.
    render(<Tabs />);
    const panel = screen.getByRole('tabpanel');
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    }
  });
});
