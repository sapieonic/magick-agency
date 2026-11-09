import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AgencyCampaignStats, AgencySupervisorAgent } from '../../types/agency-campaign';
import { ApiError } from '../../api/client';

/**
 * An agent in an inbound wrap-up on the supervisor's floor (`docs/inbound.md` §6): their ended
 * inbound call still owes its outcome (`inbound_outcome_owed`). The floor names it, and the drawer
 * offers "Close and make available": force-available, which closes the call's outcome as lapsed
 * ("closed by a supervisor") and returns the agent. The API is mocked; a server that predates
 * closing an inbound wrap-up refuses `409 inbound_call_live`, which the drawer says plainly.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  forceAgentAvailable: vi.fn(),
  trackAgencyFloorIntervention: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
vi.mock('../../api/agency', () => ({ forceAgentAvailable: mocks.forceAgentAvailable }));
vi.mock('../../analytics/events', () => ({ trackAgencyFloorIntervention: mocks.trackAgencyFloorIntervention }));

import { AgentFloor } from '../../components/agency/AgentFloor';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

function agent(over: Partial<AgencySupervisorAgent> = {}): AgencySupervisorAgent {
  return {
    session_id: 'sess-in', agent_user_id: 'usr_person', agent_name: 'Ravi', state: 'wrapup',
    state_since: new Date(NOW - 300_000).toISOString(), connected: true, break_reason: null, calls_handled: 1,
    client_kind: 'web', on_inbound_call: false, inbound_outcome_owed: true, ...over,
  };
}

function stats(agents: AgencySupervisorAgent[]): AgencyCampaignStats {
  return {
    campaign_id: 'camp-1', agents_live: agents.length, stall: null, other_stalls: [], concurrency_limit: 5,
    concurrency_in_use: 0, abandonment_ceiling_pct: 3, aht_seconds: 120, agents,
  };
}

function open(a: AgencySupervisorAgent, onForced = vi.fn()) {
  render(<AgentFloor campaignId="camp-1" stats={stats([a])} wrapupSeconds={30} canSupervise onForced={onForced} />);
  fireEvent.click(screen.getByTestId(`floor-row-${a.session_id}`));
  return onForced;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin' });
  mocks.forceAgentAvailable.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('an inbound wrap-up on the floor', () => {
  it('is named for what it is, and the drawer offers Close and make available', () => {
    open(agent());
    expect(screen.getByTestId('agent-drawer-state').textContent).toBe('Wrapping up an inbound call');
    expect(screen.getByTestId('force-available-button').textContent).toBe('Close and make available');
  });

  it('confirms, saying the inbound call closes with no outcome as closed by a supervisor, then returns the agent', async () => {
    const onForced = open(agent());
    fireEvent.click(screen.getByTestId('force-available-button'));
    expect(screen.getByText('Close this inbound call and make the agent available?')).toBeTruthy();
    const message = screen.getByText(/recorded as closed by a supervisor/);
    expect(message.textContent).toContain('Ravi hasn’t saved the outcome of an inbound call yet.');
    expect(message.textContent).toContain('can’t be filled in afterwards');
    expect(mocks.forceAgentAvailable).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close the call and return them' }));
    await waitFor(() => expect(mocks.forceAgentAvailable).toHaveBeenCalledTimes(1));
    expect(mocks.forceAgentAvailable.mock.calls[0]![0]).toBe('sess-in');
    await waitFor(() => expect(onForced).toHaveBeenCalled());
    expect(mocks.showToast).toHaveBeenCalledWith('Ravi is available again. Their inbound call is closed.', 'success');
  });

  it('says plainly when the server would not close the inbound call', async () => {
    mocks.forceAgentAvailable.mockRejectedValueOnce(
      new ApiError(409, { error: 'Conflict', code: 'inbound_call_live', message: 'An inbound call is in progress.', inbound_call_id: 'ib-1' }),
    );
    const onForced = open(agent());
    fireEvent.click(screen.getByTestId('force-available-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Close the call and return them' }));
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalled());
    expect((mocks.showErrorToast.mock.calls[0]![0] as Error).message)
      .toBe('Ravi still owes this inbound call’s outcome and it couldn’t be closed. Ask them to save it, then try again.');
    expect(onForced).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('a campaign wrap-up keeps End wrap-up and its own confirm', () => {
    open(agent({ inbound_outcome_owed: false }));
    expect(screen.getByTestId('agent-drawer-state').textContent).toBe('Wrapping up');
    expect(screen.getByTestId('force-available-button').textContent).toBe('End wrap-up');
    fireEvent.click(screen.getByTestId('force-available-button'));
    expect(screen.getByText(/no disposition/)).toBeTruthy();
  });

  it('a server that does not say (no field) is a campaign wrap-up', () => {
    const { inbound_outcome_owed: _omit, ...older } = agent();
    open(older as AgencySupervisorAgent);
    expect(screen.getByTestId('force-available-button').textContent).toBe('End wrap-up');
  });
});
