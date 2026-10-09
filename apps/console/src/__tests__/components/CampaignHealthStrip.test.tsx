import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgencyCampaignStats } from '../../types/agency-campaign';
import type { Role } from '../../types/auth';

/**
 * The health strip, as rendered.
 *
 * Its copy and its thresholds are asserted against fixtures in
 * `utils/agencyHealthStrip.test.ts`. What is asserted HERE is only what exists
 * in the component: that the two action links are gated on the permissions
 * master actually enforces — including the one that matters most, an UNKNOWN
 * role rendering neither — and that a meter with nothing to draw draws nothing
 * rather than a zero-width bar that reads as "idle" or as a reassuring 0%.
 */

const mocks = vi.hoisted(() => ({
  trackAgencyCampaignStallSurfaced: vi.fn(),
  trackAgencyCampaignStallExpanded: vi.fn(),
}));

vi.mock('../../analytics/events', () => ({
  trackAgencyCampaignStallSurfaced: mocks.trackAgencyCampaignStallSurfaced,
  trackAgencyCampaignStallExpanded: mocks.trackAgencyCampaignStallExpanded,
}));

import { CampaignHealthStrip } from '../../components/agency/CampaignHealthStrip';

function stats(over: Partial<AgencyCampaignStats> = {}): AgencyCampaignStats {
  return {
    stall: null,
    other_stalls: [],
    concurrency_limit: 10,
    concurrency_in_use: 3,
    abandonment_ceiling_pct: 5,
    connect_rate_pct: 66,
    human_connects: 40,
    machine_connects: 12,
    unclassified_connects: 0,
    machine_connects_available: true,
    aht_seconds: 134,
    aht_seconds_including_machine: 151,
    avg_wrapup_seconds: 18,
    ...over,
  };
}

const STALLED = stats({
  stall: {
    code: 'no_agents_available',
    agents_on_shift: 2,
    on_break_by_reason: {},
    on_call: 0,
    last_dial_at: '2026-08-23T15:51:00.000Z',
  },
});

function renderStrip(props: Partial<Parameters<typeof CampaignHealthStrip>[0]> = {}) {
  return render(
    <MemoryRouter>
      <CampaignHealthStrip
        stats={STALLED}
        campaignId="camp-1"
        campaignStatus="running"
        {...props}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the diagnosis banner', () => {
  it('renders nothing at all when there is no stall', () => {
    // Never a green "all good" banner: a banner present when everything is fine
    // trains a supervisor to skim past the one place a diagnosis will appear.
    renderStrip({ stats: stats(), mode: 'diagnosis' });
    expect(screen.queryByTestId('health-strip-diagnosis')).toBeNull();
  });

  it('reads as a headline plus a run of facts with the numbers emphasised', () => {
    renderStrip({ mode: 'diagnosis' });
    const banner = screen.getByTestId('health-strip-diagnosis');

    expect(banner.getAttribute('data-stall-code')).toBe('no_agents_available');
    expect(banner.getAttribute('aria-live')).toBe('polite');
    expect(within(banner).getByText('Nobody is free to take a call.')).toBeTruthy();
    // Three separate facts, not one paragraph — and each number is its own
    // element, which is what lets the eye land on it.
    expect(within(banner).getByText('2')).toBeTruthy();
    expect(within(banner).getByText('0')).toBeTruthy();
    expect(banner.textContent).toContain('agents on shift');
    expect(banner.textContent).toContain('on a call');
    expect(banner.textContent).toContain('Last call placed at');
  });

  it('keeps the additional-blockers disclosure, in priority order', () => {
    renderStrip({
      mode: 'diagnosis',
      stats: stats({
        ...STALLED,
        other_stalls: ['elevated_failure_rate', 'dnc_unavailable'],
      }),
    });

    expect(screen.queryByTestId('health-strip-others')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /2 additional blockers/ }));

    const list = screen.getByTestId('health-strip-others');
    const items = within(list).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Do Not Call check unavailable', 'Unusually many failed calls']);
    expect(mocks.trackAgencyCampaignStallExpanded).toHaveBeenCalledTimes(1);
  });
});

describe('the action links, and their gate', () => {
  it('renders NEITHER link when the role is unknown', () => {
    /**
     * The failure mode this gate exists for. A caller that does not know the
     * role has not established that the viewer may follow the link, and master
     * enforces `agency.supervise` / `audit.read` on the two routes — a link
     * that renders and then 403s on arrival is worse than no link.
     */
    renderStrip({ mode: 'diagnosis' });
    expect(screen.queryByRole('link')).toBeNull();
  });

  const linkNames = (role: Role) => {
    cleanup();
    renderStrip({ mode: 'diagnosis', role });
    return screen.queryAllByRole('link').map((a) => a.textContent);
  };

  it('gives a supervisor both destinations, campaign-scoped', () => {
    renderStrip({ mode: 'diagnosis', role: 'account_admin' });
    const floor = screen.getByRole('link', { name: 'Open the floor' });
    const activity = screen.getByRole('link', { name: 'See the activity trail' });
    expect(floor.getAttribute('href')).toBe('/agency/campaigns/camp-1/agents');
    expect(activity.getAttribute('href')).toBe('/agency/campaigns/camp-1/activity');
  });

  it('gives an agent or an operator neither, because master would refuse both', () => {
    // `agency.supervise` and `audit.read` both floor at `account_admin`.
    expect(linkNames('agent')).toEqual([]);
    expect(linkNames('viewer')).toEqual([]);
    expect(linkNames('operator')).toEqual([]);
    expect(linkNames('tenant_owner')).toEqual([
      'Open the floor',
      'See the activity trail',
    ]);
  });
});

describe('the read-out meters', () => {
  const meters = (testId: string) =>
    screen.getByTestId(testId).querySelectorAll('[style*="width"]');

  it('fills the concurrency meter to the ratio of the account limit', () => {
    renderStrip({ mode: 'readouts', stats: stats({ concurrency_limit: 30, concurrency_in_use: 12 }) });
    const readout = screen.getByTestId('concurrency-readout');
    expect(within(readout).getByText('12 of 30')).toBeTruthy();
    expect(readout.getAttribute('data-saturated')).toBe('false');
    expect(meters('concurrency-readout')[0]?.getAttribute('style')).toContain('width: 40%');
  });

  it('draws NO bar for an unreadable line count — never a zero-width one', () => {
    // `null` is Redis failing to answer. A 0%-wide fill is a drawn claim that
    // the account is idle, which is not what we failed to read.
    renderStrip({ mode: 'readouts', stats: stats({ concurrency_in_use: null }) });
    const readout = screen.getByTestId('concurrency-readout');
    expect(readout.getAttribute('data-unknown')).toBe('true');
    expect(readout.getAttribute('data-saturated')).toBe('false');
    expect(meters('concurrency-readout')).toHaveLength(0);
  });

  it('scales abandonment against the campaign’s own ceiling, tick and all', () => {
    renderStrip({
      mode: 'readouts',
      stats: stats({ abandonment_ceiling_pct: 5, abandonment_rate_24h_pct: 2.5 }),
    });
    const readout = screen.getByTestId('abandonment-readout');
    expect(within(readout).getByText('2.5%')).toBeTruthy();
    expect(readout.getAttribute('data-over')).toBe('false');
    // The track's full width IS the ceiling, so half the ceiling is half a bar.
    expect(meters('abandonment-readout')[0]?.getAttribute('style')).toContain('width: 50%');
    expect(readout.querySelector('[title="5% ceiling"]')).toBeTruthy();
  });

  it('renders a null rate as “No data” with no bar, never a reassuring 0%', () => {
    /**
     * Core sends `null` when nothing was answered in the window. This is the
     * rule the field exists for, so it is pinned in the DOM as well as in the
     * derivation: an empty green bar would be the same lie as "0.0%".
     */
    renderStrip({ mode: 'readouts', stats: stats({ abandonment_rate_24h_pct: null }) });
    const readout = screen.getByTestId('abandonment-readout');
    expect(within(readout).getByText('No data')).toBeTruthy();
    expect(readout.textContent).not.toContain('0.0%');
    expect(meters('abandonment-readout')).toHaveLength(0);
  });

  it('flags a saturated account and an over-ceiling rate', () => {
    renderStrip({
      mode: 'readouts',
      stats: stats({
        concurrency_limit: 10,
        concurrency_in_use: 10,
        abandonment_ceiling_pct: 3,
        abandonment_rate_24h_pct: 4.2,
      }),
    });
    expect(screen.getByTestId('concurrency-readout').getAttribute('data-saturated')).toBe('true');
    expect(screen.getByTestId('abandonment-readout').getAttribute('data-over')).toBe('true');
  });
});

describe('mode', () => {
  it('mode="diagnosis" shows no read-outs and mode="readouts" no diagnosis', () => {
    renderStrip({ mode: 'diagnosis', role: 'account_admin' });
    expect(screen.queryByTestId('concurrency-readout')).toBeNull();
    expect(screen.queryByTestId('abandonment-readout')).toBeNull();

    cleanup();
    vi.clearAllMocks();
    renderStrip({ mode: 'readouts', role: 'account_admin' });
    expect(screen.queryByTestId('health-strip-diagnosis')).toBeNull();
    expect(screen.getByTestId('concurrency-readout')).toBeTruthy();
    // The read-outs instance must never double-count a stall the diagnosis
    // instance beside it has already reported.
    expect(mocks.trackAgencyCampaignStallSurfaced).not.toHaveBeenCalled();
  });

  it('reports a surfaced stall once per mount, not once per poll tick', () => {
    const { rerender } = renderStrip({ mode: 'diagnosis' });
    rerender(
      <MemoryRouter>
        <CampaignHealthStrip stats={STALLED} campaignId="camp-1" campaignStatus="running" />
      </MemoryRouter>,
    );
    expect(mocks.trackAgencyCampaignStallSurfaced).toHaveBeenCalledTimes(1);
  });
});

describe('the evidence facts are separated by real text', () => {
  it('does not run two facts together when the text is read or copied', () => {
    /*
      The facts render as adjacent spans, and a CSS `gap` is not a character:
      copy/paste and a screen reader both saw "9 agents on shift7 on a call".
      The separator is deliberately not `aria-hidden` — hiding it would leave
      assistive tech with exactly the run-on this prevents.
    */
    render(
      <CampaignHealthStrip
        stats={stats({
          stall: {
            code: 'no_agents_available',
            agents_on_shift: 9,
            on_call: 7,
            on_break_by_reason: {},
            last_dial_at: null,
          },
        })}
        campaignId="camp-1"
        campaignStatus="running"
      />,
    );

    const evidence = screen.getByTestId('health-strip-diagnosis').textContent ?? '';
    expect(evidence).not.toContain('shift7');
    expect(evidence).toContain('·');
  });
});
