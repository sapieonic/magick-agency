import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { ApiError } from '../../api/client';
import type { AgencyAssignedAgent } from '../../types/agency-campaign';
import type {
  AgencyAgentCallerId,
  AgencyAgentCallerIds,
} from '@magick-agency/contracts/api/agency/agent-caller-id';

/**
 * Dedicated caller IDs on the campaign's Agents tab, through the staffing list
 * that carries them: each staffed agent's number or "Shared rotation", the stale
 * flag, the picker (numbers another agent holds offered disabled with the
 * holder's name), set and clear, every refusal in words, the all-dedicated
 * warning; and with the flag off, a dedication shown with only its release, or
 * nothing at all when there is none.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  listCampaignAgents: vi.fn(),
  assignAgent: vi.fn(),
  unassignAgent: vi.fn(),
  getAgentCallerIds: vi.fn(),
  setAgentCallerId: vi.fn(),
  clearAgentCallerId: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
vi.mock('../../hooks/useTeam', () => ({
  useTeam: () => ({ members: [], loaded: true, loading: false, error: null, reload: vi.fn() }),
}));
vi.mock('../../api/agency', () => ({
  listCampaignAgents: mocks.listCampaignAgents,
  assignAgent: mocks.assignAgent,
  unassignAgent: mocks.unassignAgent,
}));
vi.mock('../../api/agencyAssignment', () => ({
  getAgentCallerIds: mocks.getAgentCallerIds,
  setAgentCallerId: mocks.setAgentCallerId,
  clearAgentCallerId: mocks.clearAgentCallerId,
}));

import { CampaignAgentAssignments } from '../../components/agency/CampaignAgentAssignments';

const N1 = '+912200000001';
const N2 = '+912200000002';
const N3 = '+912200000003';

function agent(userId: string, name: string): AgencyAssignedAgent {
  return { user_id: userId, name, email: null, role: 'agent', assigned_at: '2026-11-01T09:00:00.000Z' };
}
const ASHA = agent('u-asha', 'Asha');
const RAVI = agent('u-ravi', 'Ravi');
const MEERA = agent('u-meera', 'Meera');

function dedication(over: Partial<AgencyAgentCallerId> & Pick<AgencyAgentCallerId, 'user_id' | 'caller_id'>): AgencyAgentCallerId {
  return {
    campaign_id: 'camp-1',
    agent_name: null,
    in_campaign: true,
    set_at: '2026-11-02T09:00:00.000Z',
    set_by_user_id: 'u-sup',
    ...over,
  };
}

/** Asha holds N1, Ravi holds N2; Meera has none; N3 is free. */
const STATE: AgencyAgentCallerIds = {
  campaign_id: 'camp-1',
  caller_ids: [N1, N2, N3],
  dedicated: [
    dedication({ user_id: 'u-asha', agent_name: 'Asha', caller_id: N1 }),
    dedication({ user_id: 'u-ravi', agent_name: 'Ravi', caller_id: N2 }),
  ],
  rotation: [N3],
  all_dedicated: false,
};

function renderPanel(assignmentEnabled = true) {
  return render(
    <CampaignAgentAssignments
      campaignId="camp-1"
      canSupervise
      liveAgentUserIds={null}
      assignmentEnabled={assignmentEnabled}
    />,
  );
}

function refusal(status: number, code: string, details?: Record<string, unknown>) {
  return new ApiError(status, { error: 'Refused', code, message: `server says ${code}`, ...(details ? { details } : {}) });
}

async function openEditor(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Change caller ID for ${name}` }));
  return screen.getByRole('group', { name: `Caller ID for ${name}` });
}

beforeEach(() => {
  // Reset, not clear: a `…Once` a test queued but never used must not leak into
  // the next test.
  vi.resetAllMocks();
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin' });
  mocks.listCampaignAgents.mockResolvedValue({ agents: [ASHA, RAVI, MEERA] });
  mocks.getAgentCallerIds.mockResolvedValue(STATE);
  mocks.setAgentCallerId.mockResolvedValue(dedication({ user_id: 'u-meera', caller_id: N3 }));
  mocks.clearAgentCallerId.mockResolvedValue(undefined);
  mocks.unassignAgent.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('the caller ID on each staffed agent', () => {
  it('shows the dedicated number, or "Shared rotation" when there is none', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('caller-id-u-asha').textContent).toContain('+91 22000 00001'));
    expect(screen.getByTestId('caller-id-u-ravi').textContent).toContain('+91 22000 00002');
    expect(screen.getByTestId('caller-id-u-meera').textContent).toContain('Shared rotation');
    expect(mocks.getAgentCallerIds).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1');
    expect(screen.queryByTestId('caller-id-stale-u-asha')).toBeNull();
    expect(screen.queryByTestId('caller-ids-all-dedicated')).toBeNull();
  });

  it('flags a dedication whose number is no longer one of the campaign’s caller IDs', async () => {
    mocks.getAgentCallerIds.mockResolvedValue({
      ...STATE,
      caller_ids: [N2, N3],
      dedicated: [
        dedication({ user_id: 'u-asha', agent_name: 'Asha', caller_id: N1, in_campaign: false }),
        STATE.dedicated[1]!,
      ],
    });
    renderPanel();
    const flag = await screen.findByTestId('caller-id-stale-u-asha');
    expect(flag.textContent).toBe(
      'No longer a caller ID this campaign can dial from, so their calls use the shared rotation.',
    );
    expect(screen.queryByTestId('caller-id-stale-u-ravi')).toBeNull();
  });

  it('warns when every caller ID is dedicated', async () => {
    mocks.getAgentCallerIds.mockResolvedValue({
      ...STATE, caller_ids: [N1, N2], rotation: [N1, N2], all_dedicated: true,
    });
    renderPanel();
    expect((await screen.findByTestId('caller-ids-all-dedicated')).textContent)
      .toBe('Every caller ID is dedicated, so contacts without one share them.');
  });

  it('a failed read claims no number for anyone: it says so, with a retry', async () => {
    mocks.getAgentCallerIds.mockRejectedValueOnce(new ApiError(503, { message: 'Down for a moment' }));
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('caller-id-u-meera').textContent).toContain('Unavailable'));
    expect(screen.queryByText('Shared rotation')).toBeNull();
    expect(screen.queryByRole('button', { name: /Change caller ID/ })).toBeNull();
  });

});

describe('with the contact-assignment flag off', () => {
  const NONE: AgencyAgentCallerIds = { ...STATE, dedicated: [], rotation: [N1, N2, N3] };

  it('with no dedications, renders nothing new (the one read is made, and answers none)', async () => {
    mocks.getAgentCallerIds.mockResolvedValue(NONE);
    renderPanel(false);
    await screen.findByText('Asha');
    // The read happens: it is how the panel learns there is nothing to release.
    await waitFor(() => expect(mocks.getAgentCallerIds).toHaveBeenCalledTimes(1));
    expect(mocks.getAgentCallerIds).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1');
    expect(screen.queryByTestId('caller-id-u-asha')).toBeNull();
    expect(screen.queryByTestId('caller-ids-flag-off')).toBeNull();
    expect(screen.queryByText(/caller ID/i)).toBeNull();
    expect(screen.queryByText('Shared rotation')).toBeNull();
  });

  it('a failed read renders nothing new either: no error, no "Unavailable"', async () => {
    mocks.getAgentCallerIds.mockRejectedValue(refusal(403, 'assignment_disabled'));
    renderPanel(false);
    await screen.findByText('Asha');
    await waitFor(() => expect(mocks.getAgentCallerIds).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/caller ID/i)).toBeNull();
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  it('shows a dedicated number with only its release, which calls DELETE', async () => {
    mocks.getAgentCallerIds
      .mockResolvedValueOnce({ ...STATE, dedicated: [STATE.dedicated[0]!], rotation: [N2, N3] })
      .mockResolvedValueOnce(NONE);
    renderPanel(false);
    await waitFor(() => expect(screen.getByTestId('caller-id-u-asha').textContent).toContain('+91 22000 00001'));
    expect(screen.getByTestId('caller-ids-flag-off').textContent).toContain('no new caller IDs can be dedicated');
    // Only the agent who holds one: nobody else's row gains anything.
    expect(screen.queryByTestId('caller-id-u-ravi')).toBeNull();
    expect(screen.queryByTestId('caller-id-u-meera')).toBeNull();
    // No picker, no Dedicate, no way into one.
    expect(screen.queryByRole('combobox', { name: /Number for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dedicate' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Change caller ID/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Use shared rotation for Asha' }));
    await waitFor(() => expect(mocks.clearAgentCallerId)
      .toHaveBeenCalledWith('camp-1', 'u-asha', 'tenant-1', 'account-1'));
    expect(mocks.setAgentCallerId).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.showToast)
      .toHaveBeenCalledWith('Asha’s contacts are back on the shared rotation.', 'success'));
    // Read again, it answers none: the row is as it was before dedicated caller IDs.
    await waitFor(() => expect(screen.queryByTestId('caller-id-u-asha')).toBeNull());
    expect(screen.queryByTestId('caller-ids-flag-off')).toBeNull();
  });

  it('flags a stale dedication, and a refused release says why in place', async () => {
    mocks.getAgentCallerIds.mockResolvedValue({
      ...STATE,
      caller_ids: [N2, N3],
      dedicated: [dedication({ user_id: 'u-asha', agent_name: 'Asha', caller_id: N1, in_campaign: false })],
    });
    mocks.clearAgentCallerId.mockRejectedValueOnce(refusal(404, 'campaign_not_found'));
    renderPanel(false);
    expect(await screen.findByTestId('caller-id-stale-u-asha')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use shared rotation for Asha' }));
    expect((await screen.findByTestId('caller-id-refusal-u-asha')).textContent)
      .toBe('This campaign no longer exists, or isn’t in this account.');
  });
});

describe('the picker', () => {
  it('lists the campaign’s numbers, with one another agent holds disabled and named', async () => {
    renderPanel();
    const editor = await openEditor('Meera');
    const options = within(editor).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
      ['Choose a number…', false],
      ['+91 22000 00001 — dedicated to Asha', true],
      ['+91 22000 00002 — dedicated to Ravi', true],
      ['+91 22000 00003', false],
    ]);
  });

  it('offers an agent’s own number as current, not as taken', async () => {
    renderPanel();
    const editor = await openEditor('Asha');
    const own = within(editor).getByRole('option', { name: '+91 22000 00001 (current)' }) as HTMLOptionElement;
    expect(own.disabled).toBe(false);
    expect((within(editor).getByRole('combobox') as HTMLSelectElement).value).toBe(N1);
    // Nothing to save until a different number is picked.
    expect((within(editor).getByRole('button', { name: 'Dedicate' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('dedicates the picked number to the agent, then reads the list again', async () => {
    renderPanel();
    const editor = await openEditor('Meera');
    // No dedication yet, so there is nothing to clear.
    expect(within(editor).queryByRole('button', { name: 'Use shared rotation' })).toBeNull();
    fireEvent.change(within(editor).getByRole('combobox'), { target: { value: N3 } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Dedicate' }));
    await waitFor(() => expect(mocks.setAgentCallerId)
      .toHaveBeenCalledWith('camp-1', 'u-meera', N3, 'tenant-1', 'account-1'));
    await waitFor(() => expect(mocks.getAgentCallerIds).toHaveBeenCalledTimes(2));
    expect(mocks.showToast).toHaveBeenCalledWith('Calls to Meera’s contacts now go from +91 22000 00003.', 'success');
    expect(screen.queryByRole('group', { name: 'Caller ID for Meera' })).toBeNull();
  });

  it('“Use shared rotation” clears the agent’s number', async () => {
    renderPanel();
    const editor = await openEditor('Asha');
    fireEvent.click(within(editor).getByRole('button', { name: 'Use shared rotation' }));
    await waitFor(() => expect(mocks.clearAgentCallerId)
      .toHaveBeenCalledWith('camp-1', 'u-asha', 'tenant-1', 'account-1'));
    expect(mocks.setAgentCallerId).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.showToast)
      .toHaveBeenCalledWith('Asha’s contacts are back on the shared rotation.', 'success'));
  });

  it('removing someone from the campaign reads the caller IDs again (their number is released)', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Asha from this campaign' }));
    await waitFor(() => expect(mocks.getAgentCallerIds).toHaveBeenCalledTimes(2));
  });
});

describe('refusals, in words', () => {
  async function dedicateN3ToMeera() {
    renderPanel();
    const editor = await openEditor('Meera');
    fireEvent.change(within(editor).getByRole('combobox'), { target: { value: N3 } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Dedicate' }));
    return screen.findByTestId('caller-id-refusal-u-meera');
  }

  it('caller_id_taken names the agent who holds it', async () => {
    mocks.setAgentCallerId.mockRejectedValueOnce(
      refusal(409, 'caller_id_taken', { user_id: 'u-other', agent_name: 'Kiran' }),
    );
    expect((await dedicateN3ToMeera()).textContent)
      .toBe('That number is already dedicated to Kiran. Pick another, or clear theirs first.');
    // The editor stays open with the refusal, so the supervisor can pick again.
    expect(screen.getByRole('group', { name: 'Caller ID for Meera' })).toBeTruthy();
  });

  it('caller_id_taken without a name still says it is taken', async () => {
    mocks.setAgentCallerId.mockRejectedValueOnce(refusal(409, 'caller_id_taken'));
    expect((await dedicateN3ToMeera()).textContent)
      .toBe('That number is already dedicated to another agent on this campaign.');
  });

  it('caller_id_not_in_campaign', async () => {
    mocks.setAgentCallerId.mockRejectedValueOnce(refusal(409, 'caller_id_not_in_campaign', { caller_ids: [N1, N2] }));
    expect((await dedicateN3ToMeera()).textContent)
      .toBe('That number is no longer a caller ID this campaign can dial from. Refresh and pick another.');
  });

  it('agent_not_staffed', async () => {
    mocks.setAgentCallerId.mockRejectedValueOnce(refusal(404, 'agent_not_staffed'));
    expect((await dedicateN3ToMeera()).textContent)
      .toBe('This agent is no longer on this campaign.');
  });

  it('an unknown code falls through to the server’s message, and reads nothing again', async () => {
    mocks.setAgentCallerId.mockRejectedValueOnce(refusal(500, 'something_new'));
    expect((await dedicateN3ToMeera()).textContent).toBe('server says something_new');
    expect(mocks.getAgentCallerIds).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['caller_id_taken', 409],
    ['caller_id_not_in_campaign', 409],
    ['agent_not_staffed', 404],
  ])('after %s, reads the caller IDs again so the open picker is not stale', async (code, status) => {
    // What the server holds now: N3 went to Kiran meanwhile.
    mocks.getAgentCallerIds
      .mockResolvedValueOnce(STATE)
      .mockResolvedValueOnce({
        ...STATE,
        dedicated: [...STATE.dedicated, dedication({ user_id: 'u-kiran', agent_name: 'Kiran', caller_id: N3 })],
        rotation: [],
      });
    mocks.setAgentCallerId.mockRejectedValueOnce(refusal(status, code));
    await dedicateN3ToMeera();
    await waitFor(() => expect(mocks.getAgentCallerIds).toHaveBeenCalledTimes(2));
    // The editor stays open, its refusal shown, over the list as it is now.
    const editor = screen.getByRole('group', { name: 'Caller ID for Meera' });
    expect(screen.getByTestId('caller-id-refusal-u-meera')).toBeTruthy();
    await waitFor(() => expect(
      (within(editor).getByRole('option', { name: '+91 22000 00003 — dedicated to Kiran' }) as HTMLOptionElement).disabled,
    ).toBe(true));
  });

  it('agent_not_staffed also reads the staffed agents again, so the unstaffed row goes', async () => {
    mocks.listCampaignAgents
      .mockResolvedValueOnce({ agents: [ASHA, RAVI, MEERA] })
      .mockResolvedValueOnce({ agents: [ASHA, RAVI] });
    mocks.setAgentCallerId.mockRejectedValueOnce(refusal(404, 'agent_not_staffed'));
    renderPanel();
    const editor = await openEditor('Meera');
    fireEvent.change(within(editor).getByRole('combobox'), { target: { value: N3 } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Dedicate' }));
    await waitFor(() => expect(mocks.listCampaignAgents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Meera')).toBeNull());
    expect(screen.queryByTestId('caller-id-u-meera')).toBeNull();
    expect(screen.getByText('Asha')).toBeTruthy();
    expect(mocks.showToast).toHaveBeenCalledWith('Meera is no longer on this campaign.', 'info');
  });

  it.each([
    ['caller_id_taken', 409],
    ['caller_id_not_in_campaign', 409],
    ['something_new', 500],
  ])('after %s, the staffed agents are not read again', async (code, status) => {
    mocks.setAgentCallerId.mockRejectedValueOnce(refusal(status, code));
    await dedicateN3ToMeera();
    expect(mocks.listCampaignAgents).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Meera')).toBeTruthy();
  });

  it('a flag-off release refused with agent_not_staffed reads the staffed agents again', async () => {
    mocks.listCampaignAgents
      .mockResolvedValueOnce({ agents: [ASHA, RAVI, MEERA] })
      .mockResolvedValueOnce({ agents: [RAVI, MEERA] });
    mocks.clearAgentCallerId.mockRejectedValueOnce(refusal(404, 'agent_not_staffed'));
    renderPanel(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Use shared rotation for Asha' }));
    await waitFor(() => expect(mocks.listCampaignAgents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Asha')).toBeNull());
  });

  it('a refused clear that means the list is stale reads it again too', async () => {
    mocks.clearAgentCallerId.mockRejectedValueOnce(refusal(404, 'agent_not_staffed'));
    renderPanel();
    const editor = await openEditor('Asha');
    fireEvent.click(within(editor).getByRole('button', { name: 'Use shared rotation' }));
    expect((await screen.findByTestId('caller-id-refusal-u-asha')).textContent)
      .toBe('This agent is no longer on this campaign.');
    await waitFor(() => expect(mocks.getAgentCallerIds).toHaveBeenCalledTimes(2));
  });
});
