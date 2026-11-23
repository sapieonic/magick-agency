import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentPicker, type AgentPickerProps } from '../../../pages/campaigns/agency/setup/AgentPicker';
import type { StaffingAgent } from '../../../hooks/useCampaignStaffing';

/** Step 4's agent cards (CS10). */

function agent(id: string, name: string, extra: Partial<StaffingAgent> = {}): StaffingAgent {
  return {
    id,
    name,
    email: `${id}@example.com`,
    persona: 'Agent',
    avatar: { display_name: name, email: `${id}@example.com`, avatar_url: null },
    notSignedIn: false,
    inTeam: true,
    ...extra,
  };
}

const AGENTS = [
  agent('u-asha', 'Asha Rao', { notSignedIn: true }),
  agent('u-meena', 'Meena Iyer', { persona: 'Supervisor' }),
  agent('u-ravi', 'Ravi Kumar'),
];

function renderPicker(props: Partial<AgentPickerProps> = {}) {
  const onChange = vi.fn();
  render(
    <MemoryRouter>
      <AgentPicker agents={AGENTS} selected={[]} onChange={onChange} loading={false} error={null} {...props} />
    </MemoryRouter>,
  );
  return { onChange };
}

afterEach(cleanup);

describe('AgentPicker', () => {
  it('is a tick box per person, named by their name, with the persona and initials beside it', () => {
    renderPicker({ selected: ['u-ravi'] });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    const ravi = screen.getByRole('checkbox', { name: 'Ravi Kumar' }) as HTMLInputElement;
    expect(ravi.checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Meena Iyer', description: 'Supervisor' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Asha Rao', description: 'Agent Has not signed in yet' })).toBeTruthy();
    expect(screen.getByText('RK')).toBeTruthy();
  });

  it('adds and removes ticks, in list order', () => {
    const { onChange } = renderPicker({ selected: ['u-ravi'] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Asha Rao' }));
    expect(onChange).toHaveBeenLastCalledWith(['u-asha', 'u-ravi']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ravi Kumar' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('keeps a tick whose person is not in the list', () => {
    const { onChange } = renderPicker({ selected: ['u-unknown'] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ravi Kumar' }));
    expect(onChange).toHaveBeenLastCalledWith(['u-ravi', 'u-unknown']);
  });

  it('locks every card when disabled', () => {
    renderPicker({ disabled: true });
    expect(screen.getByRole('group').hasAttribute('disabled')).toBe(true);
  });

  it('with nobody to pick, says so and links to Team for a reader who may invite', () => {
    renderPicker({ agents: [], invitePath: '/settings/team' });
    expect(screen.getByText('Nobody in this account can take calls yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Invite people' }).getAttribute('href')).toBe('/settings/team');
  });

  it('with nobody to pick and no right to invite, sends the reader to an administrator', () => {
    renderPicker({ agents: [], invitePath: null });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/Ask an administrator to invite your agents/)).toBeTruthy();
  });

  it('shows a failed read as the failure, never as an empty team', () => {
    const onRetry = vi.fn();
    renderPicker({ agents: [], error: 'Failed to load team', onRetry });
    expect(screen.getByRole('alert').textContent).toContain('Failed to load team');
    expect(screen.queryByTestId('agent-picker-empty')).toBeNull();
  });

  it('says it is loading before the first list arrives', () => {
    renderPicker({ agents: [], loading: true });
    expect(screen.getByRole('status').textContent).toBe('Loading your team…');
  });
});
