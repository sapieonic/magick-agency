import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ApiError } from '../../api/client';
import type { AgencyKeysetPage, AgencyRosterContact } from '../../types/agency-spine';
import type {
  AgencyAssignmentPreview,
  AgencyAssignmentProgress,
  AgencyAssignmentProgressRow,
} from '@magick-agency/contracts/api/agency/assignment';

/**
 * The roster's contact-assignment tools: who owns each contact, the owner
 * filter, row selection, and the preview-then-commit dialog — including the
 * `409 preview_stale` round where the roster moved underneath the supervisor.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  getAgencyCampaign: vi.fn(),
  getCampaignContacts: vi.fn(),
  downloadSpineCsv: vi.fn(),
  listCampaignAgents: vi.fn(),
  previewAssignment: vi.fn(),
  commitAssignment: vi.fn(),
  getAssignmentProgress: vi.fn(),
  flag: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  retryPreview: vi.fn(),
  createRetry: vi.fn(),
}));
vi.mock('../../api/agencySpine', () => ({
  getCampaignContacts: mocks.getCampaignContacts,
  downloadSpineCsv: mocks.downloadSpineCsv,
}));
vi.mock('../../api/agency', () => ({ listCampaignAgents: mocks.listCampaignAgents }));
vi.mock('../../api/agencyAssignment', () => ({
  previewAssignment: mocks.previewAssignment,
  commitAssignment: mocks.commitAssignment,
  getAssignmentProgress: mocks.getAssignmentProgress,
}));
vi.mock('../../hooks/useFeatureFlagEnabled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useFeatureFlagEnabled')>()),
  useFeatureFlagEnabled: mocks.flag,
}));

import RosterPage from '../../pages/agency/AgencyCampaignRosterPage';

const BASE: AgencyRosterContact = {
  id: 'c1', phone_e164: '+919800000001', state: 'pending', attempt_count: 0,
  our_fault_attempts: 0, last_outcome: null, last_disposition: null,
  next_attempt_at: '2026-11-03T09:00:00.000Z', suppressed_reason: null, timezone: null,
  csv_line_number: 2, assigned_user_id: 'agent-a', assigned_at: '2026-11-03T08:00:00.000Z',
  created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:00:00.000Z',
};
const ROWS: AgencyRosterContact[] = [
  BASE,
  { ...BASE, id: 'c2', phone_e164: '+919800000002', assigned_user_id: null, assigned_at: null },
  { ...BASE, id: 'c3', phone_e164: '+919800000003', assigned_user_id: 'gone-user' },
  { ...BASE, id: 'c4', phone_e164: '+919800000004', assigned_user_id: null, assigned_at: null },
];

const PREVIEW: AgencyAssignmentPreview = {
  kind: 'range', preview_token: 'tok-1', seed: null, matched: 3, moving: 2, skipped_live: 1,
  unchanged: 0, to_pool: 0, same_number_groups: 0,
  per_agent: [{ agent_user_id: 'agent-b', receiving: 2, giving: 0 }],
};

const NO_COUNTS = { pending: 0, callback: 0, not_reached: 0, in_progress: 0, reached: 0, exhausted: 0, suppressed: 0 };
function holder(agent_user_id: string, agent_name: string | null, staffed: boolean): AgencyAssignmentProgressRow {
  return {
    agent_user_id, agent_name, staffed, live: false, last_seen_at: null, assigned: 3, counts: NO_COUNTS,
    attempted: 0, due_now: 0, last_activity_at: null, due_while_absent: 0,
  };
}
function progress(agents: AgencyAssignmentProgressRow[]): AgencyAssignmentProgress {
  return {
    campaign_id: 'camp-1', assignment_mode: 'strict', agents,
    pool: { total: 2, counts: NO_COUNTS, due_now: 0 }, unassigned_open: 2, absent_after_minutes: 15,
    generated_at: '2026-11-03T10:00:00.000Z',
  };
}

function page(rows: AgencyRosterContact[]): AgencyKeysetPage<AgencyRosterContact> {
  return { rows, next_cursor: null, limit: 50 };
}

function LocationProbe() {
  return <span data-testid="location-search">{useLocation().search}</span>;
}

function renderPage(query = '') {
  return render(
    <MemoryRouter initialEntries={[`/agency/campaigns/camp-1/contacts${query}`]}>
      <LocationProbe />
      <Routes>
        <Route path="/agency/campaigns/:id/contacts" element={<RosterPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flag.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin' });
  mocks.getAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Renewals', status: 'running', disposition_catalog: [] });
  mocks.getCampaignContacts.mockResolvedValue(page(ROWS));
  mocks.listCampaignAgents.mockResolvedValue({
    agents: [
      { user_id: 'agent-a', name: 'Asha', email: 'a@x.test', role: 'agent', assigned_at: '' },
      { user_id: 'agent-b', name: 'Bilal', email: 'b@x.test', role: 'agent', assigned_at: '' },
    ],
  });
  mocks.getAssignmentProgress.mockResolvedValue(progress([
    holder('agent-a', 'Asha', true), holder('agent-b', 'Bilal', true), holder('gone-user', null, false),
  ]));
  mocks.previewAssignment.mockResolvedValue(PREVIEW);
  mocks.commitAssignment.mockResolvedValue({
    kind: 'range', batch_id: 'batch-1', moved: 2, skipped_live: 1, unchanged: 0, to_pool: 0, per_agent: [],
  });
});

afterEach(() => cleanup());

async function rendered(query = '') {
  renderPage(query);
  await screen.findByTestId('roster-row-c1');
  await waitFor(() => expect(screen.getByTestId('roster-assignee-c1').textContent).toBe('Asha'));
}

describe('with the flag off', () => {
  it('is the roster it was: no owner column, no checkboxes, no toolbar, and no owner filter sent', async () => {
    mocks.flag.mockReturnValue(false);
    renderPage('?assigned_to=agent-a');
    await screen.findByTestId('roster-row-c1');
    expect(screen.queryByText('Assigned to')).toBeNull();
    expect(screen.queryByTestId('roster-select-c1')).toBeNull();
    expect(screen.queryByTestId('assign-toolbar')).toBeNull();
    expect(mocks.listCampaignAgents).not.toHaveBeenCalled();
    expect(mocks.getCampaignContacts.mock.calls[0]![1]).toEqual({});
  });
});

describe('who owns each contact', () => {
  it('names the agent, the pool, and a former member', async () => {
    await rendered();
    expect(screen.getByTestId('roster-assignee-c2').textContent).toBe('Unassigned');
    expect(screen.getByTestId('roster-assignee-c3').textContent).toBe('Former member');
  });

  it('filters by owner through the URL, and sends it', async () => {
    await rendered();
    const filter = screen.getByTestId('roster-assignee-filter');
    fireEvent.click(within(filter).getByLabelText('Unassigned'));
    fireEvent.click(within(filter).getByLabelText('Bilal'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const query = new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
      expect(query.getAll('assigned_to')).toEqual(['unassigned', 'agent-b']);
    });
    await waitFor(() => expect(mocks.getCampaignContacts).toHaveBeenLastCalledWith(
      'camp-1', { assigned_to: ['unassigned', 'agent-b'] }, { limit: 50 }, 'tenant-1', 'account-1',
    ));
  });

  it('offers a chip for an owner in the link who is no longer staffed', async () => {
    await rendered('?assigned_to=gone-user');
    expect(within(screen.getByTestId('roster-assignee-filter')).getByLabelText('Former member')).toBeTruthy();
  });

  it('names an unstaffed holder (on_unstaff keep), offers them as an owner chip and a Reassign source — never a target', async () => {
    mocks.getAssignmentProgress.mockResolvedValue(progress([
      holder('agent-a', 'Asha', true), holder('agent-b', 'Bilal', true), holder('agent-c', 'Chitra', false),
    ]));
    mocks.getCampaignContacts.mockResolvedValue(page([BASE, { ...BASE, id: 'c5', assigned_user_id: 'agent-c' }]));
    await rendered();
    await waitFor(() => expect(screen.getByTestId('roster-assignee-c5').textContent).toBe('Chitra'));
    expect(within(screen.getByTestId('roster-assignee-filter')).getByLabelText('Chitra')).toBeTruthy();
    expect(mocks.getAssignmentProgress).toHaveBeenCalledWith('camp-1', {}, 'tenant-1', 'account-1');

    fireEvent.click(screen.getByTestId('assign-op-reassign'));
    const dialog = await screen.findByTestId('assignment-dialog');
    const from = within(dialog).getByTestId('assign-from') as HTMLSelectElement;
    const to = within(dialog).getByTestId('assign-to') as HTMLSelectElement;
    expect([...from.options].map((o) => o.textContent)).toContain('Chitra');
    expect([...to.options].map((o) => o.textContent)).not.toContain('Chitra');

    // Counts read with the console's grouping (formatCount), not the browser's.
    mocks.previewAssignment.mockResolvedValueOnce({ ...PREVIEW, kind: 'reassign', matched: 123456, moving: 123456 });
    fireEvent.change(from, { target: { value: 'agent-c' } });
    fireEvent.change(to, { target: { value: 'agent-a' } });
    fireEvent.click(within(dialog).getByTestId('assign-preview'));
    await within(dialog).findByTestId('assign-preview-result');
    expect(mocks.previewAssignment.mock.lastCall![1]).toMatchObject({ kind: 'reassign', from_user_id: 'agent-c' });
    expect(within(dialog).getByTestId('assign-moving').textContent).toBe('1,23,456');
  });

  it('falls back to the staffed agents when the holders cannot be read', async () => {
    mocks.getAssignmentProgress.mockRejectedValue(new ApiError(500, { message: 'x' }));
    await rendered();
    expect(screen.getByTestId('roster-assignee-c3').textContent).toBe('Former member');
  });
});

describe('row selection', () => {
  it('ticks rows, shift-click selects a range, and "select page" ticks every row', async () => {
    await rendered();
    fireEvent.click(screen.getByTestId('roster-select-c1'));
    expect(screen.getByTestId('assign-selection-count').textContent).toBe('1 selected');
    fireEvent.click(screen.getByTestId('roster-select-c3'), { shiftKey: true });
    expect(screen.getByTestId('assign-selection-count').textContent).toBe('3 selected');
    expect((screen.getByTestId('roster-select-c2') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('roster-select-c4') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId('roster-select-page'));
    expect(screen.getByTestId('assign-selection-count').textContent).toBe('4 selected');
    fireEvent.click(screen.getByTestId('roster-select-page'));
    expect(screen.getByTestId('assign-selection-count').textContent).toBe('Tick rows, or assign by rule');
  });

  it('keeps "Selected rows" off until something is ticked', async () => {
    await rendered();
    expect((screen.getByTestId('assign-op-range') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('roster-select-c2'));
    expect((screen.getByTestId('assign-op-range') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('preview, then commit', () => {
  async function openRangeDialog() {
    await rendered();
    fireEvent.click(screen.getByTestId('roster-select-c2'));
    fireEvent.click(screen.getByTestId('roster-select-c4'));
    fireEvent.click(screen.getByTestId('assign-op-range'));
    const dialog = await screen.findByTestId('assignment-dialog');
    fireEvent.change(within(dialog).getByTestId('assign-agent'), { target: { value: 'agent-b' } });
    return dialog;
  }

  it('previews the selected rows, then commits with the preview token', async () => {
    const dialog = await openRangeDialog();
    expect((within(dialog).getByTestId('assign-commit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByTestId('assign-preview'));
    await within(dialog).findByTestId('assign-preview-result');
    expect(mocks.previewAssignment).toHaveBeenCalledWith('camp-1', {
      kind: 'range', agent_user_id: 'agent-b', contact_ids: ['c2', 'c4'], group_same_number: true,
    }, 'tenant-1', 'account-1');
    expect(within(dialog).getByTestId('assign-sentence').textContent).toContain('on a call — won’t move');
    expect(within(dialog).getByTestId('assign-skipped-live').textContent).toBe('1');
    expect(within(dialog).getByTestId('assign-agent-agent-b').textContent).toContain('Bilal');

    fireEvent.click(within(dialog).getByTestId('assign-commit'));
    await waitFor(() => expect(mocks.commitAssignment).toHaveBeenCalledWith('camp-1', {
      operation: { kind: 'range', agent_user_id: 'agent-b', contact_ids: ['c2', 'c4'], group_same_number: true },
      preview_token: 'tok-1',
    }, 'tenant-1', 'account-1'));
    await waitFor(() => expect(screen.queryByTestId('assignment-dialog')).toBeNull());
    expect(mocks.showToast).toHaveBeenCalledWith('Moved 2 contacts. 1 on a call didn’t move.', 'success');
    // Reloaded: the first load plus the one after the commit.
    expect(mocks.getCampaignContacts).toHaveBeenCalledTimes(2);
  });

  it('sends "Keep same number together" off when unticked, and an edit drops the preview', async () => {
    const dialog = await openRangeDialog();
    fireEvent.click(within(dialog).getByTestId('assign-preview'));
    await within(dialog).findByTestId('assign-preview-result');
    fireEvent.click(within(dialog).getByTestId('assign-group-same-number'));
    expect(within(dialog).queryByTestId('assign-preview-result')).toBeNull();
    expect((within(dialog).getByTestId('assign-commit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByTestId('assign-preview'));
    await within(dialog).findByTestId('assign-preview-result');
    expect(mocks.previewAssignment.mock.calls[1]![1]).toMatchObject({ group_same_number: false });
  });

  it('on 409 preview_stale shows the fresh preview and asks to confirm again with its token', async () => {
    const fresh: AgencyAssignmentPreview = { ...PREVIEW, preview_token: 'tok-2', moving: 1, skipped_live: 2 };
    mocks.commitAssignment
      .mockRejectedValueOnce(new ApiError(409, {
        error: 'Conflict', code: 'preview_stale', message: 'The roster changed.', preview: fresh,
      }))
      .mockResolvedValueOnce({
        kind: 'range', batch_id: 'b2', moved: 1, skipped_live: 2, unchanged: 0, to_pool: 0, per_agent: [],
      });
    const dialog = await openRangeDialog();
    fireEvent.click(within(dialog).getByTestId('assign-preview'));
    await within(dialog).findByTestId('assign-preview-result');
    fireEvent.click(within(dialog).getByTestId('assign-commit'));

    await within(dialog).findByTestId('assign-stale');
    expect(within(dialog).getByTestId('assign-moving').textContent).toBe('1');
    expect(within(dialog).getByTestId('assign-commit').textContent).toBe('Assign — confirm again');
    expect(screen.getByTestId('assignment-dialog')).toBeTruthy();

    fireEvent.click(within(dialog).getByTestId('assign-commit'));
    await waitFor(() => expect(mocks.commitAssignment).toHaveBeenCalledTimes(2));
    expect(mocks.commitAssignment.mock.calls[1]![1]).toMatchObject({ preview_token: 'tok-2' });
    await waitFor(() => expect(screen.queryByTestId('assignment-dialog')).toBeNull());
  });

  it('says a refusal in words and keeps the dialog open', async () => {
    mocks.commitAssignment.mockRejectedValueOnce(new ApiError(400, {
      error: 'Bad Request', code: 'agent_not_staffed', message: 'x', details: { agent_user_ids: ['agent-b'] },
    }));
    const dialog = await openRangeDialog();
    fireEvent.click(within(dialog).getByTestId('assign-preview'));
    await within(dialog).findByTestId('assign-preview-result');
    fireEvent.click(within(dialog).getByTestId('assign-commit'));
    expect((await within(dialog).findByTestId('assign-error')).textContent)
      .toBe('One of the agents you picked is no longer on this campaign. Refresh and pick again.');
  });

  it('a random split commits the seed its preview used, and offers only staffed agents', async () => {
    mocks.previewAssignment.mockResolvedValueOnce({ ...PREVIEW, kind: 'random_split', seed: 'seed-9' });
    await rendered();
    fireEvent.click(screen.getByTestId('assign-op-random_split'));
    const dialog = await screen.findByTestId('assignment-dialog');
    const agents = within(dialog).getByTestId('assign-agents');
    expect(within(agents).getAllByRole('checkbox')).toHaveLength(2);
    fireEvent.click(within(agents).getByLabelText('Asha'));
    fireEvent.click(within(agents).getByLabelText('Bilal'));
    fireEvent.click(within(dialog).getByTestId('assign-preview'));
    await within(dialog).findByTestId('assign-preview-result');
    fireEvent.click(within(dialog).getByTestId('assign-commit'));
    await waitFor(() => expect(mocks.commitAssignment).toHaveBeenCalled());
    expect(mocks.commitAssignment.mock.calls[0]![1].operation).toEqual({
      kind: 'random_split', agent_user_ids: ['agent-a', 'agent-b'], only_unassigned: true,
      group_same_number: true, seed: 'seed-9',
    });
  });
});
