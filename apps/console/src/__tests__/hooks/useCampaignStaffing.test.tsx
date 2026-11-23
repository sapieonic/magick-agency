import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { TenantMember } from '../../types/team';
import type { AgencyAssignedAgent } from '../../types/agency-campaign';

/**
 * Step 4's staffing (CS10): who can be picked, who is on the campaign, and applying the ticks
 * with the assignment routes, each failure reported without losing the others.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  useTeam: vi.fn(),
  useNavGate: vi.fn(),
  listCampaignAgents: vi.fn(),
  assignAgent: vi.fn(),
  unassignAgent: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useTeam', () => ({ useTeam: mocks.useTeam }));
vi.mock('../../hooks/useNavGate', () => ({ useNavGate: mocks.useNavGate }));
vi.mock('../../api/agency', () => ({
  listCampaignAgents: mocks.listCampaignAgents,
  assignAgent: mocks.assignAgent,
  unassignAgent: mocks.unassignAgent,
}));

import { staffingFailureMessage, useCampaignStaffing } from '../../hooks/useCampaignStaffing';

function member(
  id: string,
  name: string | null,
  role: TenantMember['membership']['role'],
  extra: Partial<TenantMember['membership']> = {},
): TenantMember {
  return {
    membership: {
      id: `m-${id}-${extra.account_id ?? 'org'}`,
      user_id: id,
      tenant_id: 't1',
      account_id: 'a1',
      role,
      status: 'active',
      invited_by: null,
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
      ...extra,
    },
    user: {
      id,
      firebase_uid: `fb-${id}`,
      email: `${id}@example.com`,
      display_name: name,
      avatar_url: null,
      status: 'active',
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
    },
  };
}

function assigned(id: string, name: string | null = null, role: string | null = 'agent'): AgencyAssignedAgent {
  return { user_id: id, name, email: name ? null : `${id}@example.com`, role, assigned_at: '2026-11-02T00:00:00Z' };
}

const TEAM: TenantMember[] = [
  member('u-ravi', 'Ravi Kumar', 'agent'),
  member('u-asha', 'Asha Rao', 'agent', { invite_state: 'pending' }),
  member('u-meena', 'Meena Iyer', 'account_admin'),
  member('u-owner', 'Owner', 'tenant_owner', { account_id: null }),
  member('u-other', 'Other Account', 'agent', { account_id: 'a2' }),
  member('u-gone', 'Gone', 'agent', { status: 'revoked' }),
];

const NAV = { role: 'account_admin', isFlagEnabled: () => true, isCapabilityEnabled: () => true, missedAvailable: false };

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1', role: 'account_admin' });
  mocks.useTeam.mockReturnValue({ members: TEAM, loaded: true, loading: false, error: null, reload: vi.fn(async () => {}) });
  mocks.useNavGate.mockReturnValue(NAV);
  mocks.listCampaignAgents.mockResolvedValue({ agents: [] });
  mocks.assignAgent.mockResolvedValue({ user_id: 'x', campaign_id: 'c1', assigned_at: 'now' });
  mocks.unassignAgent.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useCampaignStaffing: who can be picked', () => {
  it('lists this account’s active people who may hold a station, by name, with their persona', async () => {
    const { result } = renderHook(() => useCampaignStaffing(null));
    expect(result.current.agents.map((a) => a.id)).toEqual(['u-asha', 'u-meena', 'u-owner', 'u-ravi']);
    const asha = result.current.agents[0]!;
    expect(asha).toMatchObject({ name: 'Asha Rao', persona: 'Agent', notSignedIn: true, inTeam: true });
    expect(result.current.agents[1]).toMatchObject({ name: 'Meena Iyer', persona: 'Supervisor' });
    // No campaign yet: nothing is read, nothing is assigned.
    expect(mocks.listCampaignAgents).not.toHaveBeenCalled();
    expect(result.current.assignedIds).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('lists someone assigned who is not among them, so their tick can be taken off', async () => {
    mocks.listCampaignAgents.mockResolvedValue({ agents: [assigned('u-ravi'), assigned('u-other', 'Other Account')] });
    const { result } = renderHook(() => useCampaignStaffing('c1'));
    await waitFor(() => expect(result.current.assignedIds).toEqual(['u-ravi', 'u-other']));
    expect(mocks.listCampaignAgents).toHaveBeenCalledWith('c1', 't1', 'a1');
    expect(result.current.agents.find((a) => a.id === 'u-other')).toMatchObject({ name: 'Other Account', inTeam: false });
    expect(result.current.agents.filter((a) => a.id === 'u-ravi')).toHaveLength(1);
  });

  it('offers the invite link only to a reader who may invite', () => {
    const { result, rerender } = renderHook(() => useCampaignStaffing(null));
    expect(result.current.invitePath).toBe('/settings/team');
    mocks.useNavGate.mockReturnValue({ ...NAV, role: 'operator' });
    rerender();
    expect(result.current.invitePath).toBeNull();
  });

  it('says why when the team or the campaign’s staffing cannot be read', async () => {
    mocks.useTeam.mockReturnValue({ members: [], loaded: false, loading: false, error: 'Failed to load team', reload: vi.fn() });
    mocks.listCampaignAgents.mockRejectedValue(new Error('Network down'));
    const { result } = renderHook(() => useCampaignStaffing('c1'));
    await waitFor(() => expect(result.current.error).toBe('Failed to load team Network down'));
  });
});

describe('useCampaignStaffing: applyStaffing', () => {
  it('diffs against what the server has now, and assigns and unassigns only the difference', async () => {
    mocks.listCampaignAgents.mockResolvedValue({ agents: [assigned('u-ravi'), assigned('u-meena')] });
    const { result } = renderHook(() => useCampaignStaffing(null));
    let outcome!: Awaited<ReturnType<typeof result.current.applyStaffing>>;
    await act(async () => {
      outcome = await result.current.applyStaffing('c-new', ['u-ravi', 'u-asha']);
    });
    expect(mocks.listCampaignAgents).toHaveBeenCalledWith('c-new', 't1', 'a1');
    expect(mocks.assignAgent).toHaveBeenCalledTimes(1);
    expect(mocks.assignAgent).toHaveBeenCalledWith('c-new', 'u-asha', 't1', 'a1');
    expect(mocks.unassignAgent).toHaveBeenCalledTimes(1);
    expect(mocks.unassignAgent).toHaveBeenCalledWith('c-new', 'u-meena', 't1', 'a1');
    expect(outcome).toEqual({ added: ['u-asha'], removed: ['u-meena'], failures: [], readError: null });
    expect(staffingFailureMessage(outcome)).toBeNull();
  });

  it('changes nothing when the ticks already match', async () => {
    mocks.listCampaignAgents.mockResolvedValue({ agents: [assigned('u-ravi')] });
    const { result } = renderHook(() => useCampaignStaffing(null));
    await act(async () => {
      await result.current.applyStaffing('c1', ['u-ravi']);
    });
    expect(mocks.assignAgent).not.toHaveBeenCalled();
    expect(mocks.unassignAgent).not.toHaveBeenCalled();
  });

  it('reports each failure by name and keeps every call that worked', async () => {
    mocks.listCampaignAgents.mockResolvedValue({ agents: [assigned('u-meena')] });
    mocks.assignAgent.mockImplementation(async (_c: string, userId: string) => {
      if (userId === 'u-asha') throw new Error('That user is not a member of this organisation.');
      return { user_id: userId, campaign_id: 'c1', assigned_at: 'now' };
    });
    mocks.unassignAgent.mockRejectedValue(new Error('Server busy'));
    const { result } = renderHook(() => useCampaignStaffing(null));
    let outcome!: Awaited<ReturnType<typeof result.current.applyStaffing>>;
    await act(async () => {
      outcome = await result.current.applyStaffing('c1', ['u-asha', 'u-ravi']);
    });
    expect(outcome.added).toEqual(['u-ravi']);
    expect(outcome.removed).toEqual([]);
    expect(outcome.failures).toEqual([
      { userId: 'u-asha', name: 'Asha Rao', action: 'add', message: 'That user is not a member of this organisation.' },
      { userId: 'u-meena', name: 'Meena Iyer', action: 'remove', message: 'Server busy' },
    ]);
    expect(staffingFailureMessage(outcome)).toBe('Could not add Asha Rao to this campaign. Could not take Meena Iyer off this campaign.');
  });

  it('changes nothing when the current staffing cannot be read', async () => {
    mocks.listCampaignAgents.mockRejectedValue(new Error('Network down'));
    const { result } = renderHook(() => useCampaignStaffing(null));
    let outcome!: Awaited<ReturnType<typeof result.current.applyStaffing>>;
    await act(async () => {
      outcome = await result.current.applyStaffing('c1', ['u-ravi']);
    });
    expect(mocks.assignAgent).not.toHaveBeenCalled();
    expect(outcome.readError).toBe('Network down');
    expect(staffingFailureMessage(outcome)).toBe('Could not change who calls on this campaign: Network down');
  });

  it('reads the campaign again afterwards when it is the one the hook shows', async () => {
    mocks.listCampaignAgents.mockResolvedValueOnce({ agents: [] });
    const { result } = renderHook(() => useCampaignStaffing('c1'));
    await waitFor(() => expect(mocks.listCampaignAgents).toHaveBeenCalledTimes(1));
    mocks.listCampaignAgents.mockResolvedValueOnce({ agents: [] }).mockResolvedValueOnce({ agents: [assigned('u-ravi')] });
    await act(async () => {
      await result.current.applyStaffing('c1', ['u-ravi']);
    });
    expect(mocks.listCampaignAgents).toHaveBeenCalledTimes(3);
    expect(result.current.assignedIds).toEqual(['u-ravi']);
  });
});
