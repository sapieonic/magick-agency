import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';
import type { AgencyCampaignStats, AgencySupervisorAgent } from '../../types/agency-campaign';
import { ApiError } from '../../api/client';

/**
 * The agent floor and the force-return control, as rendered.
 *
 * The ordering itself is asserted in `utils/agencyAgentFloor.test.ts` against
 * fixtures spanning every adjacent rank boundary. What is asserted HERE is the
 * part that only exists in the component: that the rendered DOM order is the
 * ranked order (a table can be correct and still paint alphabetically), that the
 * duration ticks rather than sitting where the server left it, and that the
 * control's two gates — the session's state and the viewer's permission — both
 * hold.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  forceAgentAvailable: vi.fn(),
  trackAgencyFloorIntervention: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
vi.mock('../../api/agency', () => ({ forceAgentAvailable: mocks.forceAgentAvailable }));
vi.mock('../../analytics/events', () => ({
  trackAgencyFloorIntervention: mocks.trackAgencyFloorIntervention,
}));

import { AgentFloor } from '../../components/agency/AgentFloor';

/** Pinned so `state_since` offsets are exact. */
const NOW = Date.parse('2026-08-15T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function agent(over: Partial<AgencySupervisorAgent> = {}): AgencySupervisorAgent {
  return {
    session_id: 'sess-1',
    agent_user_id: 'usr_abcdef123456',
    agent_name: 'Ravi',
    state: 'available',
    state_since: ago(10),
    connected: true,
    break_reason: null,
    calls_handled: 3,
    ...over,
  };
}

function stats(agents: AgencySupervisorAgent[] | undefined, over: Partial<AgencyCampaignStats> = {}): AgencyCampaignStats {
  return {
    campaign_id: 'camp-1',
    agents_live: agents?.length,
    stall: null,
    other_stalls: [],
    concurrency_limit: 5,
    concurrency_in_use: 2,
    abandonment_ceiling_pct: 3,
    aht_seconds: 120,
    agents,
    ...over,
  };
}

function renderFloor(props: Partial<Parameters<typeof AgentFloor>[0]> = {}) {
  return render(
    <AgentFloor
      campaignId="camp-1"
      stats={stats([agent()])}
      wrapupSeconds={30}
      canSupervise
      onForced={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' });
  mocks.forceAgentAvailable.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('agent floor — what the DOM order actually is', () => {
  it('paints rows in risk order, not the order they arrived', () => {
    // Deliberately hostile: the calm agent is alphabetically first AND has been
    // in state longest, so a table that fell back to either would put them first.
    const agents = [
      agent({ session_id: 'calm', agent_name: 'Aaron', state_since: ago(9000) }),
      agent({ session_id: 'drop', agent_name: 'Bea', connected: false, state_since: ago(5) }),
      agent({ session_id: 'brk', agent_name: 'Cal', state: 'break', break_reason: 'Lunch', state_since: ago(3600) }),
      agent({ session_id: 'call', agent_name: 'Dev', state: 'on_call', state_since: ago(300) }),
      agent({ session_id: 'wrap', agent_name: 'Eve', state: 'wrapup', state_since: ago(200) }),
    ];
    renderFloor({ stats: stats(agents) });

    const rows = screen.getByTestId('agent-floor-rows');
    const order = Array.from(rows.children).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'floor-row-wrap',
      'floor-row-call',
      'floor-row-brk',
      'floor-row-drop',
      'floor-row-calm',
    ]);
  });

  it('re-paints alphabetically when the supervisor asks for roll-call', () => {
    const agents = [
      agent({ session_id: 'wrap', agent_name: 'Zoe', state: 'wrapup', state_since: ago(200) }),
      agent({ session_id: 'calm', agent_name: 'Aaron' }),
    ];
    renderFloor({ stats: stats(agents) });

    fireEvent.click(screen.getByRole('button', { name: 'By name' }));
    const rows = screen.getByTestId('agent-floor-rows');
    expect(Array.from(rows.children).map((el) => el.getAttribute('data-testid')))
      .toEqual(['floor-row-calm', 'floor-row-wrap']);
  });

  it('defaults to risk — the default is what gets used', () => {
    renderFloor({ stats: stats([agent(), agent({ session_id: 'sess-2', agent_name: 'Bo' })]) });
    expect(screen.getByRole('button', { name: 'Needs attention' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'By name' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('agent floor — the warning glyph', () => {
  it('marks ranks 1–4 and leaves everyone else unmarked', () => {
    const agents = [
      agent({ session_id: 'wrap', state: 'wrapup', state_since: ago(200) }),
      agent({ session_id: 'call', state: 'on_call', state_since: ago(300) }),
      agent({ session_id: 'brk', state: 'break', break_reason: 'Lunch', state_since: ago(3600) }),
      agent({ session_id: 'drop', connected: false }),
      agent({ session_id: 'calm' }),
    ];
    renderFloor({ stats: stats(agents) });

    for (const id of ['wrap', 'call', 'brk', 'drop']) {
      expect(screen.getByTestId(`floor-warning-${id}`)).toBeTruthy();
      expect(screen.getByTestId(`floor-row-${id}`).getAttribute('data-warning')).toBe('true');
    }
    expect(screen.queryByTestId('floor-warning-calm')).toBeNull();
    expect(screen.getByTestId('floor-row-calm').getAttribute('data-warning')).toBe('false');
  });

  it('does NOT flag a long call when AHT is unmeasured', () => {
    // The documented rank-2 decision, at the point it reaches a screen: a
    // forty-minute call on a campaign with no AHT shows its duration and no
    // warning, because the console has no idea what normal is here.
    renderFloor({
      stats: stats([agent({ session_id: 'call', state: 'on_call', state_since: ago(2400) })], { aht_seconds: null }),
    });
    expect(screen.queryByTestId('floor-warning-call')).toBeNull();
    expect(screen.getByTestId('floor-row-call').getAttribute('data-risk')).toBe('none');
    // The duration is still on screen — not flagging is not hiding.
    expect(within(screen.getByTestId('floor-row-call')).getByTestId('floor-duration').textContent).toBe('40:00');
  });
});

describe('agent floor — `connected: null` is not “disconnected”', () => {
  it('renders no disconnection warning when the server could not determine it', () => {
    // A degraded Redis read must never manufacture "this agent has dropped" on
    // a floor a supervisor is about to act on.
    renderFloor({ stats: stats([agent({ session_id: 'maybe', connected: null })]) });
    expect(screen.getByTestId('floor-row-maybe').getAttribute('data-risk')).toBe('none');
    expect(screen.queryByTestId('floor-offline-maybe')).toBeNull();
    expect(screen.queryByTestId('floor-warning-maybe')).toBeNull();
    expect(screen.queryByText(/Disconnected/)).toBeNull();
  });

  it('renders it on `false`', () => {
    renderFloor({ stats: stats([agent({ session_id: 'gone', connected: false })]) });
    expect(screen.getByTestId('floor-offline-gone')).toBeTruthy();
    expect(screen.getByTestId('floor-row-gone').getAttribute('data-risk')).toBe('disconnected');
  });

  it('says so in its own words in the drawer, rather than picking a side', () => {
    renderFloor({ stats: stats([agent({ session_id: 'maybe', connected: null })]) });
    fireEvent.click(screen.getByTestId('floor-row-maybe'));
    const connection = screen.getByTestId('agent-drawer-connection');
    expect(connection.getAttribute('data-tone')).toBe('unknown');
    expect(connection.textContent).toMatch(/couldn’t check/i);
  });
});

describe('agent floor — the name the server could not resolve', () => {
  it('shows a shortened user id, never blank and never “Unknown”', () => {
    renderFloor({ stats: stats([agent({ session_id: 'ghost', agent_name: null })]) });
    const row = screen.getByTestId('floor-row-ghost');
    expect(row.textContent).toContain('Agent usr_abcd');
    expect(row.textContent).not.toMatch(/unknown/i);
  });
});

describe('agent floor — time in state ticks client-side', () => {
  it('advances without a poll', () => {
    // The server never sends a duration and this must not wait for one: the poll
    // interval is ten seconds, so a server-rendered figure would sit frozen for
    // ten of them at exactly the moment a supervisor is watching an overrun.
    renderFloor({ stats: stats([agent({ session_id: 'sess-1', state_since: ago(65) })]) });
    expect(screen.getByTestId('floor-duration').textContent).toBe('1:05');

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId('floor-duration').textContent).toBe('1:08');
  });

  it('renders a dash, never 0:00, for an anchor that will not parse', () => {
    renderFloor({ stats: stats([agent({ state_since: 'nope' })]) });
    expect(screen.getByTestId('floor-duration-unknown').textContent).toBe('—');
    expect(screen.queryByTestId('floor-duration')).toBeNull();
  });
});

describe('agent floor — an absent roster is not an empty floor', () => {
  it('says the list did not load, rather than “nobody is here”', () => {
    // `undefined` and `[]` are different facts. Rendering the first as the
    // second is a confident claim about staffing drawn from our own ignorance.
    render(<AgentFloor campaignId="camp-1" stats={stats(undefined, { agents_live: 4 })} wrapupSeconds={30} canSupervise onForced={() => {}} />);
    const note = screen.getByTestId('floor-unavailable');
    expect(note.textContent).toMatch(/didn’t load/);
    expect(note.textContent).toContain('4 agents are on this campaign');
    expect(screen.queryByTestId('floor-empty')).toBeNull();
  });

  it('says nobody is here for an empty roster', () => {
    render(<AgentFloor campaignId="camp-1" stats={stats([])} wrapupSeconds={30} canSupervise onForced={() => {}} />);
    expect(screen.getByTestId('floor-empty').textContent).toMatch(/Nobody is on this campaign/);
    expect(screen.queryByTestId('floor-unavailable')).toBeNull();
  });

  it('still says who is on shift if only the roster goes missing', () => {
    // Defensive only. The server tallies `agents_by_state` from the same array
    // `agents[]` comes from, so today the two always arrive together and this
    // payload cannot occur — pinned so the component keeps degrading correctly
    // rather than because the state is reachable.
    render(
      <AgentFloor
        campaignId="camp-1"
        stats={stats(undefined, {
          agents_live: 4,
          agents_by_state: { offline: 0, available: 1, reserved: 0, on_call: 3, wrapup: 0, break: 0 },
        })}
        wrapupSeconds={30}
        canSupervise
        onForced={() => {}}
      />,
    );
    expect(screen.getByTestId('floor-state-summary').textContent).toBe('3 on a call · 1 available');
  });

  it('renders no summary line at all when the counts are absent', () => {
    render(<AgentFloor campaignId="camp-1" stats={stats(undefined, { agents_live: 4 })} wrapupSeconds={30} canSupervise onForced={() => {}} />);
    expect(screen.queryByTestId('floor-state-summary')).toBeNull();
  });

  it('rolls the floor up by state above the grid', () => {
    render(
      <AgentFloor
        campaignId="camp-1"
        stats={stats([agent()], {
          agents_by_state: { offline: 0, available: 2, reserved: 0, on_call: 0, wrapup: 1, break: 0 },
        })}
        wrapupSeconds={30}
        canSupervise
        onForced={() => {}}
      />,
    );
    expect(screen.getByTestId('floor-state-summary').textContent).toBe('1 wrapping up · 2 available');
  });

  it('shows no summary beside “nobody is here” — there is nothing to roll up', () => {
    render(
      <AgentFloor
        campaignId="camp-1"
        stats={stats([], {
          agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0 },
        })}
        wrapupSeconds={30}
        canSupervise
        onForced={() => {}}
      />,
    );
    expect(screen.queryByTestId('floor-state-summary')).toBeNull();
  });
});

describe('force-return — the two gates', () => {
  const wrapping = agent({ session_id: 'wrap', agent_name: 'Ravi', state: 'wrapup', state_since: ago(200) });

  it('is offered on a wrap-up to a viewer who holds agency.supervise', () => {
    renderFloor({ stats: stats([wrapping]), canSupervise: true });
    fireEvent.click(screen.getByTestId('floor-row-wrap'));
    expect(screen.getByTestId('force-available-button')).toBeTruthy();
  });

  it('is HIDDEN without agency.supervise, even on a wrap-up', () => {
    /*
     * The UI gate must be the API gate. The server gates the route on
     * `requirePermission('agency.supervise')`, which under the role hierarchy a `viewer`,
     * `operator` or `agent` cannot reach — so a looser gate here would render a
     * button that 403s on click, and the person it would tempt most is the agent
     * whose own disposition it would skip.
     */
    renderFloor({ stats: stats([wrapping]), canSupervise: false });
    fireEvent.click(screen.getByTestId('floor-row-wrap'));
    expect(screen.queryByTestId('force-available-button')).toBeNull();
    // The drawer still opens — the refusal is about one control, not the row.
    expect(screen.getByTestId('agent-drawer-facts')).toBeTruthy();
  });

  it('is hidden on every state that is not a wrap-up, permission or no', () => {
    for (const state of ['available', 'on_call', 'break', 'reserved', 'offline'] as const) {
      cleanup();
      renderFloor({ stats: stats([agent({ session_id: 'x', state, state_since: ago(30) })]), canSupervise: true });
      fireEvent.click(screen.getByTestId('floor-row-x'));
      expect(screen.queryByTestId('force-available-button')).toBeNull();
    }
  });
});

describe('force-return — the action', () => {
  const wrapping = agent({ session_id: 'wrap-sess', agent_user_id: 'usr_person', agent_name: 'Ravi', state: 'wrapup', state_since: ago(200) });

  function openAndClickForce(onForced = vi.fn()) {
    renderFloor({ stats: stats([wrapping]), canSupervise: true, onForced });
    fireEvent.click(screen.getByTestId('floor-row-wrap-sess'));
    fireEvent.click(screen.getByTestId('force-available-button'));
    return onForced;
  }

  it('confirms first, naming the consequence the supervisor cares about', () => {
    openAndClickForce();
    // Not "returns the agent to the pool" — the half that matters is that the
    // call being written up loses its outcome, permanently.
    const confirmMessage = screen.getByText(/no disposition/);
    // The person, so a supervisor clicking down a list sees which row.
    expect(confirmMessage.textContent).toContain('Ravi');
    expect(confirmMessage.textContent).toContain('cannot be filled in afterwards');
    // Nothing has been sent yet.
    expect(mocks.forceAgentAvailable).not.toHaveBeenCalled();
  });

  it('sends nothing when the confirm is cancelled', () => {
    openAndClickForce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.forceAgentAvailable).not.toHaveBeenCalled();
  });

  it('addresses the SESSION id, not the user id', async () => {
    // A session is one shift on one campaign; the user id is the person. Every
    // control is addressed to the session, and swapping them would 404 at best
    // and act on the wrong shift at worst.
    const onForced = openAndClickForce();
    fireEvent.click(screen.getByRole('button', { name: 'End wrap-up and return' }));

    await waitFor(() => expect(mocks.forceAgentAvailable).toHaveBeenCalledTimes(1));
    expect(mocks.forceAgentAvailable.mock.calls[0]![0]).toBe('wrap-sess');
    expect(mocks.forceAgentAvailable.mock.calls[0]![0]).not.toBe('usr_person');
    await waitFor(() => expect(onForced).toHaveBeenCalled());
  });

  it('passes the typed reason through', async () => {
    openAndClickForce();
    // Reason typed before confirming — the textarea lives in the drawer.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Left for the day' } });
    fireEvent.click(screen.getByTestId('force-available-button'));
    fireEvent.click(screen.getByRole('button', { name: 'End wrap-up and return' }));

    await waitFor(() => expect(mocks.forceAgentAvailable).toHaveBeenCalled());
    expect(mocks.forceAgentAvailable.mock.calls[0]![1]).toBe('Left for the day');
  });

  it('handles a 403 with a sentence about permission, rather than failing silently', async () => {
    // A control that silently does nothing is worse than one that refuses: the
    // supervisor's next move is to click it again.
    mocks.forceAgentAvailable.mockRejectedValueOnce(new ApiError(403, { error: 'Forbidden' }));
    const onForced = openAndClickForce();
    fireEvent.click(screen.getByRole('button', { name: 'End wrap-up and return' }));

    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalled());
    const [err] = mocks.showErrorToast.mock.calls[0]!;
    expect((err as Error).message).toMatch(/permission/i);
    expect(onForced).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('reports any other failure without claiming success', async () => {
    mocks.forceAgentAvailable.mockRejectedValueOnce(new ApiError(409, { message: 'Not in wrap-up' }));
    const onForced = openAndClickForce();
    fireEvent.click(screen.getByRole('button', { name: 'End wrap-up and return' }));

    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalled());
    expect(onForced).not.toHaveBeenCalled();
  });
});

describe('the floor summary card', () => {
  const floor = [
    agent({ session_id: 'a', agent_name: 'Ann', state: 'on_call', state_since: ago(30), calls_handled: 14 }),
    agent({ session_id: 'b', agent_name: 'Bo', state: 'available', calls_handled: 6 }),
    agent({ session_id: 'c', agent_name: 'Cy', state: 'available', calls_handled: 10 }),
  ];
  const byState = { offline: 0, available: 2, reserved: 0, on_call: 1, wrapup: 0, break: 0 };

  it('draws one band per occupied state and names the empty ones once', () => {
    renderFloor({ stats: stats(floor, { agents_by_state: byState }) });
    const card = screen.getByLabelText('The floor right now');

    // Busiest first, and the zeroes collapsed rather than given a swatch each.
    expect(within(card).getByText('On a call')).toBeTruthy();
    expect(within(card).getByText('Available')).toBeTruthy();
    expect(within(card).getByText('Wrapping up 0 · Reserved 0 · On break 0 · Offline 0')).toBeTruthy();
    expect(within(card).queryByText('Reserved')).toBeNull();
  });

  it('answers “how many are free” and “how much has this shift done”', () => {
    renderFloor({ stats: stats(floor, { agents_by_state: byState }) });
    expect(screen.getByTestId('floor-available').textContent).toBe('2');
    expect(screen.getByText('of 3 on shift')).toBeTruthy();
    expect(screen.getByTestId('floor-handled').textContent).toBe('30');
    expect(screen.getByText('10.0 per agent')).toBeTruthy();
  });

  it('says how many agents need a look, in words, above the rows', () => {
    renderFloor({
      stats: stats([agent({ session_id: 'wrap', state: 'wrapup', state_since: ago(200) }), ...floor], {
        agents_by_state: byState,
      }),
    });
    expect(screen.getByTestId('floor-risk-summary').textContent)
      .toContain('1 agent needs a look — past the wrap-up window.');
  });

  it('renders no risk pill on a calm floor', () => {
    renderFloor({ stats: stats(floor, { agents_by_state: byState }) });
    expect(screen.queryByTestId('floor-risk-summary')).toBeNull();
  });

  it('draws no bar when the roll-up is absent, but still counts the roster', () => {
    // `agents_by_state` absent is "we don't know how the floor is distributed" —
    // which is not the same as an empty floor, and must not be drawn as one.
    renderFloor({ stats: stats(floor) });
    expect(screen.queryByTestId('floor-state-summary')).toBeNull();
    expect(screen.queryByText(/Reserved 0/)).toBeNull();
    expect(screen.getByTestId('floor-available').textContent).toBe('2');
  });
});

describe('the floor as a table', () => {
  it('fixes identity, state and duration, and lets the measure take the slack', () => {
    // The bug this replaced: percentage columns stretched the name across a gulf
    // of empty row on a wide monitor. The fourth column is deliberately the only
    // one with no width of its own.
    renderFloor();
    const cols = Array.from(document.querySelectorAll('colgroup col'));
    expect(cols).toHaveLength(5);
    // CSS Modules hash the names, so this matches on the readable stem.
    expect(cols.map((col) => /col(Agent|State|For|Actions)/.exec(col.className)?.[0] ?? null)).toEqual([
      'colAgent', 'colState', 'colFor', null, 'colActions',
    ]);
  });

  it('puts the ranked rows in the table body, in order', () => {
    const agents = [
      agent({ session_id: 'calm', agent_name: 'Aaron', state_since: ago(9000) }),
      agent({ session_id: 'wrap', agent_name: 'Eve', state: 'wrapup', state_since: ago(200) }),
    ];
    renderFloor({ stats: stats(agents) });
    const body = screen.getByTestId('agent-floor-rows');
    expect(body.tagName).toBe('TBODY');
    expect(Array.from(body.children).map((row) => row.tagName)).toEqual(['TR', 'TR']);
    expect(Array.from(body.children).map((row) => row.getAttribute('data-testid')))
      .toEqual(['floor-row-wrap', 'floor-row-calm']);
  });

  it('renders one row per agent — every state, nobody dropped', () => {
    /*
     * The floor is a claim about staffing, so the count of rows IS part of the
     * claim: a supervisor reading "3 of 9 on shift" above eight rows concludes
     * an agent has gone missing, and they would be right to. `rankFloor` filters
     * nothing, so this pins the rows against the readouts over a roster spanning
     * every state — including the two that carry no colour of their own
     * (`offline`, `reserved`) and the one whose anchor will not parse.
     *
     * ── Rows and "on shift" are deliberately DIFFERENT numbers ──────────────
     * A signed-out agent is still a row — they worked this shift and their
     * handled calls are real — but they are not ON it. `offline` is excluded
     * from the readout and the bar for the reason `agencyCampaignOverview`'s
     * rail excludes it and the server's own `shift_seconds` does: otherwise Overview
     * and this tab report different denominators for one payload.
     */
    const roster = [
      agent({ session_id: 'a', agent_name: 'Ann', state: 'on_call', state_since: ago(30), calls_handled: 14 }),
      agent({ session_id: 'b', agent_name: 'Bo', state: 'on_call', state_since: ago(600), calls_handled: 9 }),
      agent({ session_id: 'c', agent_name: 'Cy', state: 'wrapup', state_since: ago(200), calls_handled: 16 }),
      agent({ session_id: 'd', agent_name: 'Di', state: 'available', calls_handled: 12 }),
      agent({ session_id: 'e', agent_name: 'Ed', state: 'available', calls_handled: 8 }),
      agent({ session_id: 'f', agent_name: 'Fay', state: 'available', calls_handled: 11 }),
      agent({ session_id: 'g', agent_name: 'Gus', state: 'break', break_reason: 'Lunch', state_since: ago(3600), calls_handled: 10 }),
      agent({ session_id: 'h', agent_name: 'Hal', state: 'reserved', connected: null, calls_handled: 7 }),
      agent({ session_id: 'i', agent_name: 'Ivy', state: 'offline', state_since: 'nope', connected: false, calls_handled: 5 }),
    ];
    renderFloor({
      stats: stats(roster, {
        agents_by_state: { offline: 1, available: 3, reserved: 1, on_call: 2, wrapup: 1, break: 1 },
      }),
    });

    const body = screen.getByTestId('agent-floor-rows');
    expect(body.children).toHaveLength(roster.length);
    // Every agent, by session — not merely the right NUMBER of rows.
    expect(Array.from(body.children).map((row) => row.getAttribute('data-testid')).sort())
      .toEqual(roster.map((a) => `floor-row-${a.session_id}`).sort());

    // The card's arithmetic is over that same roster, at that same moment.
    expect(screen.getByTestId('floor-available').textContent).toBe('3');
    // Nine rows, EIGHT on shift: Ivy signed out.
    const onShift = roster.filter((a) => a.state !== 'offline').length;
    expect(onShift).toBe(roster.length - 1);
    expect(screen.getByText(`of ${onShift} on shift`)).toBeTruthy();
    expect(screen.getByTestId('floor-handled').textContent)
      .toBe(String(roster.reduce((sum, a) => sum + a.calls_handled, 0)));
    // And the heading agrees with both.
    expect(screen.getByRole('heading', { name: /Agents/ }).textContent).toContain(String(roster.length));

    // Sorting is a reorder, never a filter.
    fireEvent.click(screen.getByRole('button', { name: 'By name' }));
    expect(screen.getByTestId('agent-floor-rows').children).toHaveLength(roster.length);
  });

  it('names the risk in the row’s own words, not only as a glyph', () => {
    renderFloor({ stats: stats([agent({ session_id: 'call', state: 'on_call', state_since: ago(600) })]) });
    expect(screen.getByTestId('floor-row-call').textContent).toContain('2× AHT');
  });

  it('keeps the break reason beside the state', () => {
    renderFloor({ stats: stats([agent({ session_id: 'brk', state: 'break', break_reason: 'Lunch' })]) });
    expect(screen.getByTestId('floor-row-brk').textContent).toContain('On break · Lunch');
  });
});

describe('a row is reachable without a mouse', () => {
  it('opens the drawer from a real button carrying the agent’s name', () => {
    // A `<button>` cannot wrap a `<tr>` and `role="button"` on the row would
    // take the table's semantics away — so the keyboard path is a control in the
    // identity cell, and it must actually open the drawer.
    renderFloor({ stats: stats([agent({ session_id: 'sess-1', agent_name: 'Ravi' })]) });
    fireEvent.click(screen.getByRole('button', { name: 'Ravi' }));
    expect(screen.getByTestId('agent-drawer-facts')).toBeTruthy();
  });

  it('opens it once, not twice, when the press lands on an inner control', () => {
    // The row's own click handler is an extra affordance, so an inner control
    // stops propagation — or every press through a button would fire the
    // intervention event twice.
    renderFloor({ stats: stats([agent({ session_id: 'sess-1', agent_name: 'Ravi' })]) });
    fireEvent.click(screen.getByRole('button', { name: 'Ravi' }));
    expect(mocks.trackAgencyFloorIntervention).toHaveBeenCalledTimes(1);
  });

  it('offers the wrap-up control on the row, and it opens the same drawer', () => {
    renderFloor({
      stats: stats([agent({ session_id: 'wrap', state: 'wrapup', state_since: ago(200) })]),
      canSupervise: true,
    });
    fireEvent.click(screen.getByRole('button', { name: /End wrap-up/ }));
    expect(screen.getByTestId('force-available-button')).toBeTruthy();
    expect(mocks.trackAgencyFloorIntervention).toHaveBeenCalledTimes(1);
  });

  it('withholds that row control from a viewer who cannot supervise', () => {
    renderFloor({
      stats: stats([agent({ session_id: 'wrap', state: 'wrapup', state_since: ago(200) })]),
      canSupervise: false,
    });
    expect(screen.queryByRole('button', { name: /End wrap-up/ })).toBeNull();
    // The risk is still stated — the refusal is about one control, not the row.
    expect(screen.getByTestId('floor-row-wrap').textContent).toContain('Past wrap-up');
  });
});
