import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WithPageCrumbs, suppliedCrumbs } from '../helpers/pageCrumbs';
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
  getAgencyCampaignStats: vi.fn(),
  campaignLineage: vi.fn(),
  createAgencyCampaign: vi.fn(),
  getIngestLimits: vi.fn(),
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  downloadSkippedRows: vi.fn(),
  importCheckedFile: vi.fn(),
  updateAgencyCampaign: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));
// The tab bar's overdue-callbacks badge reads the allocation; never answered here, so no badge and no network.
vi.mock('../../api/agencyInsights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agencyInsights')>()),
  getInsightsAllocation: () => new Promise(() => {}),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  // The campaign's workspace (header, health strip, bar) around the upload reads these two.
  getAgencyCampaignStats: mocks.getAgencyCampaignStats,
  campaignLineage: mocks.campaignLineage,
  createAgencyCampaign: mocks.createAgencyCampaign,
  getIngestLimits: mocks.getIngestLimits,
  uploadRosterCsv: mocks.uploadRosterCsv,
  analyzeRosterColumns: mocks.analyzeRosterColumns,
  startRosterIngest: mocks.startRosterIngest,
  getIngestJob: mocks.getIngestJob,
  cancelIngestJob: mocks.cancelIngestJob,
  downloadRejectedRows: mocks.downloadRejectedRows,
  downloadSkippedRows: mocks.downloadSkippedRows,
  importCheckedFile: mocks.importCheckedFile,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
}));

const ANALYSIS: AgencyColumnAnalysis = {
  headers: ['Mobile', 'Name'],
  columns: [
    { name: 'Mobile', index: 0, samples: ['9820041772'], non_empty: 100, phone_score: 0.95, distinct: 100, distinct_phones: 100 },
    { name: 'Name', index: 1, samples: ['Priya Menon'], non_empty: 100, phone_score: 0, distinct: 100, distinct_phones: 100 },
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
import { noLineage, workspaceStats } from '../helpers/campaignWorkspace';

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
      <WithPageCrumbs>
        <Routes>
          <Route path="/agency/campaigns/:id/contacts/add" element={<ContactsPage />} />
        </Routes>
      </WithPageCrumbs>
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
  mocks.getAgencyCampaignStats.mockResolvedValue(workspaceStats());
  mocks.campaignLineage.mockResolvedValue(noLineage());
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

describe('add contacts — the breadcrumb', () => {
  it('names the campaign and leads back to its contacts', async () => {
    renderPage();
    await waitFor(() => expect(suppliedCrumbs()).toBe(
      'Collections→/agency/campaigns/camp-1 / Contacts→/agency/campaigns/camp-1/contacts / Add contacts',
    ));
  });
});

describe('add contacts — in the campaign’s workspace', () => {
  it('sits under the campaign’s header and the Contacts tab, titled as a section', async () => {
    renderPage();

    expect(await screen.findByTestId('campaign-workspace')).toBeTruthy();
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Collections');
    expect((await screen.findByTestId('campaign-tab-contacts')).getAttribute('aria-current')).toBe('page');
    expect(await screen.findByRole('heading', { level: 2, name: 'Add contacts' })).toBeTruthy();
  });
});

describe('add contacts — one read of the campaign, shared with the header', () => {
  it('reads the campaign once on opening: the header’s read is the section’s', async () => {
    renderPage();

    await waitFor(() => expect(document.querySelector('input[type=file]')).toBeTruthy());
    expect(mocks.getAgencyCampaign).toHaveBeenCalledTimes(1);
  });

  it('repaints the header and the form together when the start finds the campaign ended', async () => {
    renderPage();
    await pickFile();
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'stopped' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import without checking' }));

    // The form is closed, and the header says the same status rather than its own older read.
    expect(await screen.findByText(/has finished, so contacts added now would never be dialled/i)).toBeTruthy();
    expect(mocks.startRosterIngest).not.toHaveBeenCalled();
    const actions = screen.getByTestId('campaign-actions');
    expect(within(actions).getByRole('link', { name: 'New campaign' })).toBeTruthy();
    expect(within(actions).queryByRole('link', { name: 'Add contacts' })).toBeNull();
  });

  it('says once that the campaign could not be read, and Retry brings the form', async () => {
    mocks.getAgencyCampaign.mockRejectedValueOnce(new Error('Campaign service unavailable'));
    renderPage();

    expect(await screen.findAllByText('Campaign service unavailable')).toHaveLength(1);
    expect(document.querySelector('input[type=file]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    await waitFor(() => expect(document.querySelector('input[type=file]')).toBeTruthy());
    expect(screen.queryByText('Campaign service unavailable')).toBeNull();
  });
});

describe('add contacts — a campaign that can still dial', () => {
  it('never creates a new campaign — the roster targets the one in the URL', async () => {
    renderPage();

    await pickFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import without checking' }));

    await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
    const [request] = mocks.startRosterIngest.mock.calls[0]!;
    expect(request.campaign_id).toBe('camp-1');
    // The builder's `ensureCampaign` has no business running here.
    expect(mocks.createAgencyCampaign).not.toHaveBeenCalled();
  });

  it('threads the account through the ingest start', async () => {
    renderPage();

    await pickFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import without checking' }));

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

    expect(await screen.findByText(/would never be dialled/i)).toBeTruthy();
    // Not merely disabled — absent. A disabled file picker on a dead campaign
    // reads as a permissions problem the operator might go looking to fix.
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('still offers the upload for a draft campaign', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));

    renderPage();

    await waitFor(() => expect(document.querySelector('input[type=file]')).toBeTruthy());
    expect(screen.queryByText(/would never be dialled/i)).toBeNull();
  });
});

/** A finished job as the server serves it, with the IM fields (check or import). */
function finishedJob(over: Record<string, unknown> = {}) {
  return {
    job_id: 'check-1', campaign_id: 'camp-1', status: 'completed', dry_run: true, file_name: 'f.csv',
    dedupe_columns: [], progress_pct: 100, rows_read: 10, accepted: 6, skipped: 2, rejected: 2, duplicates: 1,
    rejected_by_reason: { invalid_phone: 1, duplicate_phone: 1 }, dnc_by_scope: {},
    rejected_sample: [
      { row_number: 3, column: 'Mobile', raw_value: '98765-0000', reason_code: 'invalid_phone', reason: "'98765-0000' is not a phone number we can dial. Check the digits." },
      { row_number: 7, column: 'Mobile', raw_value: '9820041772', reason_code: 'duplicate_phone', reason: '+919820041772 is already on row 2 of this file, so this row was left out.' },
    ],
    core_rejected_duplicate_rows: 0, core_duplicate_source_rows: [], chunks_sent: 0, headers: ['Mobile', 'Name'], context_columns: ['Name'],
    has_rejected_export: true, rejected_row_count: 2, rejected_truncated: false,
    has_skipped_export: true, skipped_row_count: 2, skipped_truncated: false,
    check_job_id: null, import_job_id: null, check_expires_at: '2026-11-16T10:00:00.000Z',
    error_code: null, error_message: null, created_by: null,
    created_at: '2026-11-15T10:00:00.000Z', started_at: '2026-11-15T10:00:01.000Z', finished_at: '2026-11-15T10:00:05.000Z',
    ...over,
  };
}

describe('add contacts — check, review, then import (IM1, IM2, IM3)', () => {
  it('checks against this campaign, shows what will happen, and imports the checked file', async () => {
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'check-1', status: 'pending' });
    mocks.getIngestJob.mockResolvedValue(finishedJob());
    renderPage();
    await pickFile();
    fireEvent.click(screen.getByRole('button', { name: 'Check the file' }));

    // The check names the campaign, so the server compares the file with its roster.
    await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
    expect(mocks.startRosterIngest.mock.calls[0]![0]).toMatchObject({ dry_run: true, campaign_id: 'camp-1' });

    const summary = await screen.findByTestId('ingest-summary');
    expect(summary.getAttribute('data-kind')).toBe('check');
    expect(screen.getByTestId('dry-run-note').textContent).toContain('nothing has been imported yet');
    expect(screen.getByTestId('count-accepted').textContent).toBe('6');
    expect(screen.getByTestId('count-skipped').textContent).toBe('2');
    expect(screen.getByTestId('count-rejected').textContent).toBe('2');
    expect(screen.getByTestId('reconciliation').textContent)
      .toBe('6 ready + 2 already in this campaign + 2 rejected = 10 rows in the file');
    expect(screen.getByTestId('skipped-notice').textContent).toContain('already in this campaign from an earlier import');
    // The rejected rows, with what to fix, on screen.
    const sample = screen.getByTestId('rejected-sample');
    expect(within(sample).getByText('98765-0000')).toBeTruthy();
    expect(within(sample).getByText(/already on row 2 of this file/)).toBeTruthy();

    // Both downloads are offered.
    mocks.downloadSkippedRows.mockResolvedValue(new Blob(['x']));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'Download the skipped rows' }));
    await waitFor(() => expect(mocks.downloadSkippedRows).toHaveBeenCalledWith('check-1', 'tenant-1', 'account-1'));
    expect(screen.getByRole('button', { name: 'Download rejected rows' })).toBeTruthy();

    // Import N contacts: the check's own file and mapping, by its id.
    mocks.importCheckedFile.mockResolvedValue({ job_id: 'import-1', status: 'pending', check_job_id: 'check-1', already_started: false });
    mocks.getIngestJob.mockResolvedValue(finishedJob({
      job_id: 'import-1', dry_run: false, accepted: 5, skipped: 3, check_job_id: 'check-1', check_expires_at: null,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 6 contacts' }));
    await waitFor(() => expect(mocks.importCheckedFile).toHaveBeenCalledWith('check-1', 'camp-1', 'tenant-1', 'account-1'));
    expect(mocks.startRosterIngest).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(screen.getByTestId('ingest-summary').getAttribute('data-kind')).toBe('import'));
    expect(screen.getByTestId('count-accepted').textContent).toBe('5');
    expect(screen.getByTestId('reconciliation').textContent).toBe('5 imported + 3 already in this campaign + 2 rejected = 10 rows read');
    // The roster moved between the check and the import: said, not left unexplained.
    expect(screen.getByTestId('check-comparison').textContent).toContain('The check expected 6 to import; 5 were imported.');
    expect(screen.queryByTestId('review-next-steps')).toBeNull();
  });

  it('offers no import when nothing in the file is new, and says why', async () => {
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'check-1', status: 'pending' });
    mocks.getIngestJob.mockResolvedValue(finishedJob({ accepted: 0, skipped: 8 }));
    renderPage();
    await pickFile();
    fireEvent.click(screen.getByRole('button', { name: 'Check the file' }));

    const button = (await screen.findByRole('button', { name: 'Nothing new to import' })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Upload a corrected file' })).toBeTruthy();
  });

  it("shows the server's refusal when another import is running, and stays on the review", async () => {
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'check-1', status: 'pending' });
    mocks.getIngestJob.mockResolvedValue(finishedJob());
    mocks.importCheckedFile.mockRejectedValue(new Error('Another import into this campaign is still running (other.csv). Wait for it to finish, then import again.'));
    renderPage();
    await pickFile();
    fireEvent.click(screen.getByRole('button', { name: 'Check the file' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import 6 contacts' }));

    expect(await screen.findByText(/Another import into this campaign is still running/)).toBeTruthy();
    expect(screen.getByTestId('review-next-steps')).toBeTruthy();
  });

  it('Upload a corrected file starts again from the file picker', async () => {
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'check-1', status: 'pending' });
    mocks.getIngestJob.mockResolvedValue(finishedJob());
    renderPage();
    await pickFile();
    fireEvent.click(screen.getByRole('button', { name: 'Check the file' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Upload a corrected file' }));
    expect(screen.queryByTestId('ingest-summary')).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose a CSV' })).toBeTruthy();
  });
});
