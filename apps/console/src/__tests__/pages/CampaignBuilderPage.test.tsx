import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgencyColumnAnalysis, AgencyIngestJob } from '../../types/agency-campaign';

/**
 * `AD-P3-U-01` at the PAGE level.
 *
 * The rule this file exists for: **a component test passing does not mean the
 * page renders the component.** `AD-P2-U-01` was claimable on green component
 * tests while `AgentConsolePage.tsx` composed none of them. So every assertion
 * below goes through `CampaignBuilderPage` — the mapper, the summary and the
 * counters are asserted where an operator would see them.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getIngestLimits: vi.fn(),
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  createAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
// The caller-ID picker is a hard gate on this page: core rejects a campaign with
// an empty `caller_ids`, so nothing downstream runs until one is chosen.
vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: [
      {
        phone_number_id: 'pn-1',
        phone_number: '+912200000001',
        provider_name: 'voicelink',
        provider_display_name: 'VoiceLink',
        label: 'Outbound 1',
        is_default: true,
      },
    ],
    loading: false,
    error: null,
    reload: vi.fn(),
    defaultNumber: '+912200000001',
  }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getIngestLimits: mocks.getIngestLimits,
  uploadRosterCsv: mocks.uploadRosterCsv,
  analyzeRosterColumns: mocks.analyzeRosterColumns,
  startRosterIngest: mocks.startRosterIngest,
  getIngestJob: mocks.getIngestJob,
  cancelIngestJob: mocks.cancelIngestJob,
  downloadRejectedRows: mocks.downloadRejectedRows,
  createAgencyCampaign: mocks.createAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
}));

const ANALYSIS: AgencyColumnAnalysis = {
  headers: ['Cust Mobile', 'Full Name', 'TZ', 'Internal Score'],
  columns: [
    { name: 'Cust Mobile', index: 0, samples: ['9820041772'], non_empty: 100, phone_score: 0.95 },
    { name: 'Full Name', index: 1, samples: ['Priya Menon'], non_empty: 100, phone_score: 0 },
    { name: 'TZ', index: 2, samples: ['Asia/Kolkata'], non_empty: 100, phone_score: 0 },
    { name: 'Internal Score', index: 3, samples: ['0.82'], non_empty: 100, phone_score: 0 },
  ],
  rows_sampled: 100,
  truncated: true,
  suggested_phone_column: 'Cust Mobile',
  phone_column_ambiguous: false,
  phone_column_candidates: [],
};

function job(over: Partial<AgencyIngestJob> = {}): AgencyIngestJob {
  return {
    job_id: 'job-1',
    campaign_id: 'camp-1',
    status: 'completed',
    dry_run: false,
    file_name: 'collections_aug.csv',
    progress_pct: 100,
    rows_read: 12_481,
    accepted: 11_712,
    rejected: 769,
    duplicates: 192,
    rejected_by_reason: {
      invalid_phone: 412,
      duplicate_phone: 192,
      missing_phone_value: 124,
      dnc_suppressed: 41,
    },
    core_rejected_duplicate_rows: 0,
    core_duplicate_source_rows: [],
    chunks_sent: 24,
    headers: ANALYSIS.headers,
    context_columns: ['Full Name', 'TZ'],
    has_rejected_export: true,
    rejected_row_count: 769,
    rejected_truncated: false,
    error_code: null,
    error_message: null,
    created_at: '2026-08-11T10:00:00.000Z',
    started_at: '2026-08-11T10:00:01.000Z',
    finished_at: '2026-08-11T10:04:00.000Z',
    ...over,
  };
}

async function renderPage() {
  const { default: CampaignBuilderPage } = await import(
    '../../pages/campaigns/agency/CampaignBuilderPage'
  );
  return render(
    <MemoryRouter>
      <CampaignBuilderPage />
    </MemoryRouter>,
  );
}

function fillBasics(name = 'Collections') {
  fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: name } });
  fireEvent.click(screen.getByRole('checkbox', { name: /\+912200000001/ }));
}

function goToStep(title: string) {
  fireEvent.click(screen.getByRole('button', { name: title }));
}

/** Upload a file and get as far as the mapping screen. */
async function reachMapping() {
  await renderPage();
  fillBasics();
  goToStep('Who to call');
  const input = screen.getByLabelText('CSV file') as HTMLInputElement;
  const file = new File(['Cust Mobile\n9820041772\n'], 'collections_aug.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByLabelText('Use Cust Mobile as');
}

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
  mocks.getIngestLimits.mockResolvedValue({
    max_rows: 1_000_000,
    max_columns: 50,
    max_cell_bytes: 4096,
    max_file_bytes: 512 * 1024 * 1024,
  });
  mocks.uploadRosterCsv.mockResolvedValue({
    s3_key: 'agency-ingest/t1/u1/collections_aug.csv',
    file_name: 'collections_aug.csv',
    file_size_bytes: 4096,
  });
  mocks.analyzeRosterColumns.mockResolvedValue(ANALYSIS);
  mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'running' });
  mocks.getIngestJob.mockResolvedValue(job());
  mocks.createAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
  mocks.updateAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the page composes the mapper', () => {
  it('shows the real row limit from master rather than a copied constant', async () => {
    await renderPage();
    fillBasics();
    goToStep('Who to call');
    // §B.2: the number the admin is told must be the real one.
    expect((await screen.findByTestId('ingest-limits')).textContent).toContain('1,000,000 rows');
  });

  it('renders one role select per column, with samples from the file', async () => {
    await reachMapping();
    for (const column of ANALYSIS.columns) {
      expect(screen.getByLabelText(`Use ${column.name} as`)).toBeTruthy();
    }
    // A header alone cannot identify a phone column; the values are the evidence.
    expect(screen.getByText('9820041772')).toBeTruthy();
  });

  it('preselects the suggested phone column and lets the operator move it', async () => {
    await reachMapping();
    const suggested = screen.getByLabelText('Use Cust Mobile as') as HTMLSelectElement;
    expect(suggested.value).toBe('phone');

    fireEvent.change(screen.getByLabelText('Use Full Name as'), { target: { value: 'phone' } });
    expect((screen.getByLabelText('Use Full Name as') as HTMLSelectElement).value).toBe('phone');
    // Moved, not duplicated — two phone columns is not a state that exists.
    expect((screen.getByLabelText('Use Cust Mobile as') as HTMLSelectElement).value).toBe('detail');
  });

  it('sends an arbitrarily-named phone column and the timezone column on ingest', async () => {
    await reachMapping();
    fireEvent.change(screen.getByLabelText('Use TZ as'), { target: { value: 'timezone' } });
    fireEvent.change(screen.getByLabelText('Use Internal Score as'), {
      target: { value: 'ignore' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Import contacts' }));

    await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
    expect(mocks.startRosterIngest.mock.calls[0]![0]).toMatchObject({
      phone_column: 'Cust Mobile',
      timezone_column: 'TZ',
      ignore_columns: ['Internal Score'],
      campaign_id: 'camp-1',
    });
  });

  /**
   * The country code applied to numbers written without one.
   *
   * Master normalises every un-prefixed number by prepending a server-side
   * default (`91` unless the env says otherwise). Nothing surfaced it, so a US
   * roster imported "100% accepted" and dialed India.
   */
  it('offers the country code on the mapping screen, and sends NOTHING when untouched', async () => {
    await reachMapping();
    // The control is on the screen where the phone column is chosen — that is
    // the moment the operator is looking at the numbers.
    expect(screen.getByLabelText(/country code for numbers without one/i)).toBeTruthy();

     fireEvent.click(screen.getByRole('button', { name: 'Import contacts' }));

    await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
    // Zero behaviour change at the default: the key is absent, not empty.
    expect('default_country_code' in mocks.startRosterIngest.mock.calls[0]![0]).toBe(false);
  });

  it('sends the country code the operator typed', async () => {
    await reachMapping();
     fireEvent.change(screen.getByLabelText(/country code for numbers without one/i), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import contacts' }));

    await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
    expect(mocks.startRosterIngest.mock.calls[0]![0]).toMatchObject({ default_country_code: '1' });
  });

  it('blocks the import on a malformed country code rather than 400ing after upload', async () => {
    await reachMapping();
     fireEvent.change(screen.getByLabelText(/country code for numbers without one/i), {
      target: { value: '1234' },
    });

    expect(screen.getByTestId('country-code-error')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Import contacts' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(mocks.startRosterIngest).not.toHaveBeenCalled();
  });

  it('refuses to start an import with no phone column mapped', async () => {
    await reachMapping();
    fireEvent.change(screen.getByLabelText('Use Cust Mobile as'), { target: { value: 'detail' } });
    expect(screen.getByTestId('mapping-block')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Import contacts' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });
});

describe('the page composes the ingest summary', () => {
  it('renders counters that reconcile to the file, and does not add duplicates in', async () => {
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'completed' });
    mocks.getIngestJob.mockResolvedValue(job());

    await reachMapping();
     fireEvent.click(screen.getByRole('button', { name: 'Import contacts' }));

    const summary = await screen.findByTestId('ingest-summary', undefined, { timeout: 4000 });
    expect(summary).toBeTruthy();

    const read = Number(screen.getByTestId('count-rows_read').textContent!.replace(/[^0-9]/g, ''));
    const accepted = Number(screen.getByTestId('count-accepted').textContent!.replace(/[^0-9]/g, ''));
    const rejected = Number(screen.getByTestId('count-rejected').textContent!.replace(/[^0-9]/g, ''));

    expect(accepted + rejected).toBe(read);
    expect(read).toBe(12_481);
    // The duplicate count is on the screen, but not as a counter tile — adding
    // it in overshoots the operator's own file.
    expect(screen.queryByTestId('count-duplicates')).toBeNull();
    expect(screen.getByTestId('reconciliation').textContent).toContain('= 12,481 rows read');
  });

  it('reports DNC suppressions separately AND says which total they sit in', async () => {
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'completed' });
    await reachMapping();
     fireEvent.click(screen.getByRole('button', { name: 'Import contacts' }));

    const notice = await screen.findByTestId('dnc-notice', undefined, { timeout: 4000 });
    expect(notice.textContent).toContain('41');
    expect(notice.textContent).toContain('rejected total');
  });

  it('offers the per-row error report when master kept one', async () => {
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'completed' });
    mocks.downloadRejectedRows.mockResolvedValue(new Blob(['row_number,_reason\n88,bad\n']));

    await reachMapping();
     fireEvent.click(screen.getByRole('button', { name: 'Import contacts' }));

    const download = await screen.findByRole(
      'button',
      { name: 'Download rejected rows' },
      { timeout: 4000 },
    );
    fireEvent.click(download);
    await waitFor(() => expect(mocks.downloadRejectedRows).toHaveBeenCalledWith('job-1', 't1', 'a1'));
  });

  it('leads with a mapping warning when most of the file was rejected', async () => {
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'completed' });
    mocks.getIngestJob.mockResolvedValue(
      job({
        rows_read: 1000,
        accepted: 300,
        rejected: 700,
        duplicates: 0,
        rejected_by_reason: { invalid_phone: 700 },
      }),
    );

    await reachMapping();
     fireEvent.click(screen.getByRole('button', { name: 'Import contacts' }));

    const warning = await screen.findByRole('alert', undefined, { timeout: 4000 });
    expect(warning.textContent).toContain('70%');
    expect(screen.getByRole('button', { name: 'Check the column mapping' })).toBeTruthy();
  });

  it('shows a determinate progress bar while the ingest runs, not a hang', async () => {
    // (d): *a large file shows ingest progress rather than appearing hung*.
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'running' });
    mocks.getIngestJob.mockResolvedValue(
      job({ status: 'running', progress_pct: 42, rows_read: 5_000, finished_at: null }),
    );

    await reachMapping();
     fireEvent.click(screen.getByRole('button', { name: 'Import contacts' }));

    const progress = await screen.findByTestId('ingest-progress');
    expect(progress).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByLabelText('Import progress').getAttribute('value')).toBe('42'),
    );
    expect(screen.getByRole('button', { name: 'Stop the import' })).toBeTruthy();
  });

  it('surfaces what core refused on arrival, outside the reconciling counters', async () => {
    // Master threads core's own duplicate count through the job payload. It is
    // NOT a slice of `rejected` — those are rows master never sent — so it
    // cannot be a tile or a rejection group, and the accepted count it qualifies
    // has to be named as an overstatement rather than silently corrected.
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'completed' });
    mocks.getIngestJob.mockResolvedValue(
      job({
        rows_read: 5_000,
        accepted: 4_800,
        rejected: 200,
        duplicates: 0,
        rejected_by_reason: { invalid_phone: 200 },
        core_rejected_duplicate_rows: 1_204,
        core_duplicate_source_rows: [3, 8, 12],
      }),
    );

    await reachMapping();
     fireEvent.click(screen.getByRole('button', { name: 'Import contacts' }));

    const block = await screen.findByTestId('core-refused', undefined, { timeout: 4000 });
    expect(block.textContent).toContain('At least 1,204');
    expect(block.textContent).toContain('overstates');
    // The tiles still balance against the operator's own file.
    expect(screen.getByTestId('reconciliation').textContent).toContain('= 5,000 rows read');
    expect(screen.getByTestId('count-rejected').textContent).toContain('200');
    // Sampled rows are examples from the start of the file, never a spread.
    expect(screen.getByTestId('core-refused-sample').textContent).toContain('start of the file');
  });

  it('shows no refusal block when core refused nothing', async () => {
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'completed' });

    await reachMapping();
     fireEvent.click(screen.getByRole('button', { name: 'Import contacts' }));

    await screen.findByTestId('ingest-summary', undefined, { timeout: 4000 });
    expect(screen.queryByTestId('core-refused')).toBeNull();
  });

  it('says plainly that a dry run imported nothing', async () => {
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'completed' });
    mocks.getIngestJob.mockResolvedValue(job({ dry_run: true, campaign_id: null }));

    await reachMapping();
    fireEvent.click(screen.getByRole('button', { name: 'Check the file first' }));

    expect(await screen.findByTestId('dry-run-note', undefined, { timeout: 4000 })).toBeTruthy();
    // A check must not create a campaign — it is a check.
    expect(mocks.createAgencyCampaign).not.toHaveBeenCalled();
  });
});

describe('the stepper does not tick a step nobody has been to', () => {
  /*
    Measured on production: on step 1 of 5, steps 3 ("When to call") and 4 ("How
    agents work") already carried ticks while step 2 did not.

    The cause is that both are keyed on the config passing validation, and
    `emptyCampaignConfig()` — what the wizard seeds — already passes. So the
    ticks were reporting "these defaults are valid", which an operator reads as
    "there is nothing for you here". Those two steps are where the calling
    window and the disposition catalog are decided, including which outcomes
    carry `suppress` and take a contact off the list for good.
  */
  const tickOf = (title: string) =>
    screen.getByRole('button', { name: title }).getAttribute('data-complete');

  it('shows no tick on the two defaulted steps before they are opened', async () => {
    await renderPage();

    expect(tickOf('When to call')).toBeNull();
    expect(tickOf('How agents work')).toBeNull();
  });

  it('still shows no tick once basics are filled in', async () => {
    // Filling in step 1 makes steps 3 and 4 REACHABLE, which is what made the
    // old behaviour look plausible. Reachable is not the same as done.
    await renderPage();
    fillBasics();

    expect(tickOf('When to call')).toBeNull();
    expect(tickOf('How agents work')).toBeNull();
  });

  it('ticks a step once it has been visited and still validates', async () => {
    await renderPage();
    fillBasics();
    goToStep('When to call');
    // Leave it, so the step is visited but is no longer current — the stepper
    // only draws a tick on a step that is complete AND not the one you are on.
    goToStep('Who to call');

    expect(tickOf('When to call')).toBe('true');
    // The step never opened stays untouched, which is the whole distinction.
    expect(tickOf('How agents work')).toBeNull();
  });
});
