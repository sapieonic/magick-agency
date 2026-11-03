import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  AgencyAssignmentProgress,
  AgencyContactBucketCounts,
} from '@magick-agency/contracts/api/agency/assignment';

/**
 * Contacts by agent on the campaign's Agents panel: the per-agent counts (each a
 * link to the roster narrowed to that owner and state), the pool, strict mode's
 * unassigned warning, and the "due while away" flag whose Reassign… opens the
 * reassign dialog with that agent filled in.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  showToast: vi.fn(),
  getAssignmentProgress: vi.fn(),
  previewAssignment: vi.fn(),
  commitAssignment: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../api/agencyAssignment', () => ({
  getAssignmentProgress: mocks.getAssignmentProgress,
  previewAssignment: mocks.previewAssignment,
  commitAssignment: mocks.commitAssignment,
}));

import { CampaignAssignmentProgress } from '../../components/agency/CampaignAssignmentProgress';

function counts(over: Partial<AgencyContactBucketCounts> = {}): AgencyContactBucketCounts {
  return {
    pending: 0, callback: 0, not_reached: 0, in_progress: 0, reached: 0, exhausted: 0, suppressed: 0, ...over,
  };
}

const PROGRESS: AgencyAssignmentProgress = {
  campaign_id: 'camp-1',
  assignment_mode: 'strict',
  agents: [
    {
      agent_user_id: 'agent-a', agent_name: 'Asha', staffed: true, live: true, last_seen_at: null,
      assigned: 40, counts: counts({ pending: 20, callback: 3, not_reached: 12, reached: 5 }),
      attempted: 20, due_now: 4, last_activity_at: '2026-11-03T09:00:00.000Z', due_while_absent: 0,
    },
    {
      agent_user_id: 'agent-b', agent_name: 'Bilal', staffed: true, live: false, last_seen_at: null,
      assigned: 10, counts: counts({ pending: 10 }),
      attempted: 0, due_now: 6, last_activity_at: null, due_while_absent: 6,
    },
    {
      agent_user_id: 'gone', agent_name: null, staffed: false, live: false, last_seen_at: null,
      assigned: 2, counts: counts({ pending: 2 }),
      attempted: 0, due_now: 0, last_activity_at: null, due_while_absent: 0,
    },
  ],
  pool: { total: 7, counts: counts({ pending: 7 }), due_now: 7 },
  unassigned_open: 7,
  absent_after_minutes: 15,
  generated_at: '2026-11-03T10:00:00.000Z',
};

function renderPanel() {
  return render(
    <MemoryRouter>
      <CampaignAssignmentProgress campaignId="camp-1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin' });
  mocks.getAssignmentProgress.mockResolvedValue(PROGRESS);
  mocks.previewAssignment.mockResolvedValue({
    kind: 'reassign', preview_token: 'tok', seed: null, matched: 10, moving: 10, skipped_live: 0, unchanged: 0,
    to_pool: 0, per_agent: [], same_number_groups: 0,
  });
});

afterEach(() => cleanup());

describe('contacts by agent', () => {
  it('lists each agent’s counts, linked to the roster by owner and state', async () => {
    renderPanel();
    const row = await screen.findByTestId('progress-row-agent-a');
    const notReached = within(row).getByRole('link', { name: '12 Not reached' });
    const href = notReached.getAttribute('href')!;
    const query = new URLSearchParams(href.split('?')[1]);
    expect(href.startsWith('/agency/campaigns/camp-1/contacts?')).toBe(true);
    expect(query.getAll('assigned_to')).toEqual(['agent-a']);
    expect(query.getAll('state')).toEqual(['pending']);
    expect(within(row).getByText('Asha')).toBeTruthy();
    expect(screen.getByTestId('progress-row-gone').textContent).toContain('Former member');
    expect(screen.getByTestId('progress-row-gone').textContent).toContain('not on this campaign');
  });

  it('groups counts the way every analytics surface does (formatCount, en-IN), not the browser’s locale', async () => {
    mocks.getAssignmentProgress.mockResolvedValue({
      ...PROGRESS,
      agents: [{ ...PROGRESS.agents[0]!, assigned: 123456, counts: counts({ not_reached: 234567 }), attempted: 345678 }],
      pool: { total: 1234567, counts: counts({ pending: 1234567 }), due_now: 0 },
    });
    renderPanel();
    const row = await screen.findByTestId('progress-row-agent-a');
    expect(within(row).getByRole('link', { name: '1,23,456' })).toBeTruthy();
    expect(within(row).getByRole('link', { name: '2,34,567 Not reached' }).textContent).toBe('2,34,567');
    expect(within(row).getByText('3,45,678')).toBeTruthy();
    expect(within(screen.getByTestId('progress-pool')).getAllByText('12,34,567').length).toBeGreaterThan(0);
  });

  it('shows the pool, linked to the unassigned filter', async () => {
    renderPanel();
    const pool = await screen.findByTestId('progress-pool');
    const link = within(pool).getAllByRole('link')[0]!;
    expect(new URLSearchParams(link.getAttribute('href')!.split('?')[1]).getAll('assigned_to')).toEqual(['unassigned']);
  });

  it('warns about unassigned open contacts in strict mode, and only there', async () => {
    renderPanel();
    expect((await screen.findByTestId('progress-unassigned-open')).textContent)
      .toContain('7 open contacts are unassigned and will not be dialled.');
    cleanup();
    mocks.getAssignmentProgress.mockResolvedValue({ ...PROGRESS, assignment_mode: 'preferred' });
    renderPanel();
    await screen.findByTestId('progress-row-agent-a');
    expect(screen.queryByTestId('progress-unassigned-open')).toBeNull();
  });

  it('flags contacts due while an agent is away, and Reassign… opens the dialog with them filled in', async () => {
    renderPanel();
    expect((await screen.findByTestId('progress-absent-agent-b')).textContent).toContain('6 due — agent away > 15 min');
    expect(screen.queryByTestId('progress-absent-agent-a')).toBeNull();

    fireEvent.click(screen.getByTestId('progress-reassign-agent-b'));
    const dialog = await screen.findByTestId('assignment-dialog');
    expect((within(dialog).getByTestId('assign-from') as HTMLSelectElement).value).toBe('agent-b');
    // Only staffed agents can receive, and never the agent the contacts come from.
    const to = within(dialog).getByTestId('assign-to') as HTMLSelectElement;
    expect([...to.options].map((o) => o.value)).toEqual(['', 'agent-a']);
    fireEvent.change(to, { target: { value: 'agent-a' } });
    fireEvent.click(within(dialog).getByTestId('assign-preview'));
    await waitFor(() => expect(mocks.previewAssignment).toHaveBeenCalledWith('camp-1', {
      kind: 'reassign', from_user_id: 'agent-b', to_user_id: 'agent-a', group_same_number: true,
    }, 'tenant-1', 'account-1'));
  });
});
