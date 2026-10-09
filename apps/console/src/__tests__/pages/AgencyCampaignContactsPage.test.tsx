import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AgencyCampaign, AgencyColumnAnalysis } from '../../types/agency-campaign';

/**
 * Adding contacts to an EXISTING campaign.
 *
 * Two things distinguish this from the builder and are what this file pins:
 * the ingest must target the campaign in the URL rather than creating a draft,
 * and a campaign that can never dial again must not accept an import at all —
 * the server would happily accept those rows and they would sit unreachable, which
 * looks exactly like a successful import.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getAgencyCampaign: vi.fn(),
  createAgencyCampaign: vi.fn(),
  getIngestLimits: vi.fn(),
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  updateAgencyCampaign: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  createAgencyCampaign: mocks.createAgencyCampaign,
  getIngestLimits: mocks.getIngestLimits,
  uploadRosterCsv: mocks.uploadRosterCsv,
  analyzeRosterColumns: mocks.analyzeRosterColumns,
  startRosterIngest: mocks.startRosterIngest,
  getIngestJob: mocks.getIngestJob,
  cancelIngestJob: mocks.cancelIngestJob,
  downloadRejectedRows: mocks.downloadRejectedRows,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
}));

const ANALYSIS: AgencyColumnAnalysis = {
  headers: ['Mobile', 'Name'],
  columns: [
    { name: 'Mobile', index: 0, samples: ['9820041772'], non_empty: 100, phone_score: 0.95 },
    { name: 'Name', index: 1, samples: ['Priya Menon'], non_empty: 100, phone_score: 0 },
  ],
  rows_sampled: 100,
  truncated: false,
  suggested_phone_column: 'Mobile',
  phone_column_ambiguous: false,
  phone_column_candidates: [],
};

function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
  return { id: 'camp-1', name: 'Collections', status: 'paused', ...over };
}

import ContactsPage from '../../pages/agency/AgencyCampaignContactsPage';

/**
 * Mounted at `…/contacts/add`, which is where this page lives.
 *
 * It previously mounted at `…/contacts` and kept passing after that path was
 * reassigned to the roster — so it asserted the behaviour of a URL this
 * component no longer owns, and would have passed identically against an
 * un-refactored `App.tsx`. The route table itself is covered separately, in
 * `agencyRoutes.test.tsx`.
 */
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/camp-1/contacts/add']}>
      <Routes>
        <Route path="/agency/campaigns/:id/contacts/add" element={<ContactsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Wait for the page's own load to finish, then hand over the picked file. */
async function pickFile() {
  await waitFor(() => expect(document.querySelector('input[type=file]')).toBeTruthy());
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(['Mobile,Name\n98200,Priya'], 'f.csv', { type: 'text/csv' })] },
  });
  await waitFor(() => expect(screen.getByText(/f\.csv/)).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'tenant_owner',
  });
  mocks.getAgencyCampaign.mockResolvedValue(campaign());
  mocks.getIngestLimits.mockResolvedValue({ max_rows: 1_000_000, max_file_bytes: 536_870_912 });
  mocks.uploadRosterCsv.mockResolvedValue({ s3_key: 'agency-ingest/t/u/f.csv', file_name: 'f.csv' });
  mocks.analyzeRosterColumns.mockResolvedValue(ANALYSIS);
  mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'running' });
  mocks.getIngestJob.mockResolvedValue({
    job_id: 'job-1',
    campaign_id: 'camp-1',
    status: 'running',
    file_name: 'f.csv',
    rows_read: 10,
    accepted: 10,
    rejected: 0,
    duplicates: 0,
    rejected_by_reason: {},
    progress_pct: 20,
    dry_run: false,
  });
});

afterEach(cleanup);

describe('add contacts — a campaign that can still dial', () => {
  it('never creates a new campaign — the roster targets the one in the URL', async () => {
    renderPage();

    await pickFile();
    fireEvent.click(screen.getByRole('button', { name: /add to campaign/i }));

    await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
    const [request] = mocks.startRosterIngest.mock.calls[0]!;
    expect(request.campaign_id).toBe('camp-1');
    // The builder's `ensureCampaign` has no business running here.
    expect(mocks.createAgencyCampaign).not.toHaveBeenCalled();
  });

  it('threads the account through the ingest start', async () => {
    renderPage();

    await pickFile();
    fireEvent.click(screen.getByRole('button', { name: /add to campaign/i }));

    await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
    const [, tenantId, accountId] = mocks.startRosterIngest.mock.calls[0]!;
    expect(tenantId).toBe('tenant-1');
    expect(accountId).toBe('account-1');
  });

  it('warns that a running campaign picks up new contacts immediately', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));

    renderPage();

    expect(await screen.findByText(/agents may start receiving them/i)).toBeTruthy();
  });
});

describe('add contacts — a campaign that has finished', () => {
  it.each(['stopped', 'completed'])('refuses the upload for a %s campaign', async (status) => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status }));

    renderPage();

    expect(await screen.findByText(/would never be dialed/i)).toBeTruthy();
    // Not merely disabled — absent. A disabled file picker on a dead campaign
    // reads as a permissions problem the operator might go looking to fix.
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('still offers the upload for a draft campaign', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));

    renderPage();

    await waitFor(() => expect(document.querySelector('input[type=file]')).toBeTruthy());
    expect(screen.queryByText(/would never be dialed/i)).toBeNull();
  });
});
