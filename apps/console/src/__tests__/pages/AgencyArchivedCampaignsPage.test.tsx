import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Archived campaigns (AR1–AR6): the drafts and stopped campaigns taken off the Campaigns page.
 *
 * Pinned here: the list is the archived read (`archived=true`), newest archived first, each row
 * opening its campaign with when and by whom it was archived; Restore takes the row away at once
 * for a role that may archive and is not offered to one that may not; a refused restore says why
 * and re-reads the list; an account with none says how to archive one.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  listArchivedAgencyCampaignsPage: vi.fn(),
  setAgencyCampaignArchived: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agencyCampaigns', () => ({
  listArchivedAgencyCampaignsPage: mocks.listArchivedAgencyCampaignsPage,
  setAgencyCampaignArchived: mocks.setAgencyCampaignArchived,
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));

import { AgencyArchivedCampaignsPage } from '../../pages/agency/AgencyArchivedCampaignsPage';
import type { AgencyCampaign } from '../../types/agency-campaign';

const DRAFT: AgencyCampaign = {
  id: 'c-draft',
  name: 'Diwali leads',
  status: 'draft',
  archived_at: '2026-11-20T06:00:00Z',
  archived_by: { user_id: 'u-1', name: 'Ravi Kumar' },
};
const STOPPED: AgencyCampaign = {
  id: 'c-stopped',
  name: 'Spring renewals',
  status: 'stopped',
  archived_at: '2026-11-02T06:00:00Z',
  archived_by: null,
};

function tenant(role = 'account_admin') {
  return { tenantId: 'tenant-1', accountId: 'account-1', role, accounts: [{ id: 'account-1', name: 'Default', tenant_id: 'tenant-1' }] };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AgencyArchivedCampaignsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue(tenant());
  mocks.listArchivedAgencyCampaignsPage.mockResolvedValue({ campaigns: [DRAFT, STOPPED], total: 2 });
});

describe('AgencyArchivedCampaignsPage', () => {
  it('lists the archived campaigns, each opening its campaign and saying when and by whom it was archived', async () => {
    renderPage();
    const list = await screen.findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(mocks.listArchivedAgencyCampaignsPage).toHaveBeenCalledWith('tenant-1', 'account-1', 0, 100);
    const draft = within(rows[0]!).getByRole('link');
    expect(draft.getAttribute('href')).toBe('/agency/campaigns/c-draft');
    expect(draft.textContent).toContain('Diwali leads');
    expect(draft.textContent).toContain('Archived on 20 Nov 2026 by Ravi Kumar');
    expect(within(rows[1]!).getByRole('link').textContent).toContain('Archived on 2 Nov 2026');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Archived campaigns');
  });

  it('restores a campaign and takes its row away at once', async () => {
    mocks.setAgencyCampaignArchived.mockResolvedValue({ ...DRAFT, archived_at: null, archived_by: null });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Diwali leads' }));
    await waitFor(() => expect(screen.queryByText('Diwali leads')).toBeNull());
    expect(mocks.setAgencyCampaignArchived).toHaveBeenCalledWith('c-draft', 'unarchive', 'tenant-1', 'account-1');
    expect(mocks.showToast).toHaveBeenCalledWith('Campaign restored to the Campaigns page.', 'success');
    expect(screen.getByText('Spring renewals')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('says why a restore was refused, and re-reads the list', async () => {
    const refusal = new Error('This campaign is not archived.');
    mocks.setAgencyCampaignArchived.mockRejectedValue(refusal);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Spring renewals' }));
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith(refusal, 'Could not restore the campaign.'));
    expect(mocks.listArchivedAgencyCampaignsPage).toHaveBeenCalledTimes(2);
  });

  it('does not offer Restore to a role that may not archive', async () => {
    mocks.useTenant.mockReturnValue(tenant('viewer'));
    renderPage();
    await screen.findByText('Diwali leads');
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
  });

  it('says how to archive one when there are none', async () => {
    mocks.listArchivedAgencyCampaignsPage.mockResolvedValue({ campaigns: [], total: 0 });
    renderPage();
    expect((await screen.findByTestId('archived-empty')).textContent).toContain('Archive a draft or a stopped campaign from its page');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('loads older archived campaigns on request, from the end of the list held', async () => {
    mocks.listArchivedAgencyCampaignsPage
      .mockResolvedValueOnce({ campaigns: [DRAFT], total: 2 })
      .mockResolvedValueOnce({ campaigns: [STOPPED], total: 2 });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Show older campaigns' }));
    await screen.findByText('Spring renewals');
    expect(mocks.listArchivedAgencyCampaignsPage).toHaveBeenLastCalledWith('tenant-1', 'account-1', 1, 100);
    expect(screen.queryByRole('button', { name: 'Show older campaigns' })).toBeNull();
  });
});
