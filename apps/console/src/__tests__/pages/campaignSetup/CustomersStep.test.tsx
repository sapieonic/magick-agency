import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CustomersStep, type CustomersStepProps } from '../../../pages/campaigns/agency/setup/CustomersStep';
import { useRosterIngest } from '../../../hooks/useRosterIngest';
import { buildContextDisplay, initialMapping, setRole, type MappingState } from '../../../utils/agencyColumnMapping';
import { customersContinue } from '../../../utils/campaignSetup/ingestChips';
import { toggleCardColumn } from '../../../utils/campaignSetup/cardColumns';
import type { AgencyColumnAnalysis } from '../../../types/agency-campaign';
import {
  ANALYSIS,
  UPLOAD,
  fakeIngest,
  ingestJob,
  reviewingIngest,
} from '../../utils/campaignSetup/customersFixtures';

const api = vi.hoisted(() => ({
  getIngestLimits: vi.fn(),
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  downloadSkippedRows: vi.fn(),
  importCheckedFile: vi.fn(),
}));
vi.mock('../../../api/agencyCampaigns', () => api);

function renderStep(over: Partial<CustomersStepProps> = {}) {
  const props: CustomersStepProps = {
    ingest: fakeIngest(),
    basicsReady: true,
    blockReason: null,
    onPickFile: vi.fn(async () => {}),
    ...over,
  };
  render(<CustomersStep {...props} />);
  return props;
}

const csv = (name = 'list.csv') => new File(['phone\n9820041772\n'], name, { type: 'text/csv' });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the drop zone', () => {
  it('reads as the mock-up, CSV only (CS7), with the limits in Indian grouping', () => {
    renderStep();
    expect(screen.getByRole('heading', { name: 'Customers' })).toBeTruthy();
    expect(screen.getByText('Upload a CSV file. We check it for you.')).toBeTruthy();
    expect(screen.getByTestId('ingest-limits').textContent).toBe('Up to 10,00,000 rows and 512 MB per file.');
    expect((screen.getByLabelText('CSV file') as HTMLInputElement).accept).toBe('.csv,text/csv');
    expect(document.body.textContent).not.toMatch(/excel|xlsx/i);
  });

  it('shows drag-over, and takes one file at a time while the first is being taken', async () => {
    let finish!: () => void;
    const onPickFile = vi.fn((_file: File) => new Promise<void>((resolve) => { finish = resolve; }));
    renderStep({ onPickFile });
    const zone = screen.getByTestId('contacts-dropzone');
    fireEvent.dragOver(zone);
    expect(zone.getAttribute('data-drag-over')).toBe('true');

    fireEvent.drop(zone, { dataTransfer: { files: [csv('first.csv')] } });
    expect(zone.getAttribute('data-drag-over')).toBeNull();
    // Still `idle` (the page has not re-rendered): the step's own lock holds the second.
    fireEvent.drop(zone, { dataTransfer: { files: [csv('second.csv')] } });
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [csv('third.csv')] } });
    fireEvent.dragOver(zone);
    expect(zone.getAttribute('data-drag-over')).toBeNull();
    expect(onPickFile).toHaveBeenCalledTimes(1);
    expect(onPickFile.mock.calls[0]![0].name).toBe('first.csv');

    finish();
    await waitFor(() => {
      fireEvent.drop(zone, { dataTransfer: { files: [csv('fourth.csv')] } });
      expect(onPickFile).toHaveBeenCalledTimes(2);
    });
  });

  it('takes no file once an upload is under way, and says what is happening', () => {
    const onPickFile = vi.fn();
    renderStep({ onPickFile, ingest: fakeIngest({ phase: 'uploading' }) });
    expect(screen.getByText('Uploading…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Choose a CSV file' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.drop(screen.getByTestId('contacts-dropzone'), { dataTransfer: { files: [csv()] } });
    expect(onPickFile).not.toHaveBeenCalled();
    cleanup();
    renderStep({ ingest: fakeIngest({ phase: 'analyzing' }) });
    expect(screen.getByText('Reading the columns…')).toBeTruthy();
  });
});

describe('a checked file (CS6)', () => {
  it('shows the file row: the name, its size and rows, and Replace file', () => {
    const props = renderStep({ ingest: reviewingIngest() });
    const row = screen.getByTestId('file-row');
    expect(within(row).getByText('collections_nov.csv').tagName).toBe('STRONG');
    expect(row.textContent).toContain('48 KB · 1,266 rows');
    fireEvent.click(within(row).getByRole('button', { name: 'Replace file' }));
    expect(props.ingest.reset).toHaveBeenCalledTimes(1);
    // No sample file: the repo has none to offer.
    expect(screen.queryByText(/sample file/i)).toBeNull();
  });

  it('shows the counts as chips, each download wired to its rows', () => {
    const props = renderStep({ ingest: reviewingIngest() });
    expect(screen.getByTestId('chip-ready').textContent).toBe('1,240 customers ready');
    expect(screen.getByTestId('chip-bad_phone').textContent).toContain('12 rows have a bad phone number. They will be left out');
    expect(screen.getByTestId('chip-dnc').textContent).toBe('8 on the Do Not Call list. They will be left out');
    expect(screen.getByTestId('chip-skipped').textContent).toContain('6 already in this campaign');

    const chips = screen.getByTestId('ingest-chips');
    fireEvent.click(within(chips).getByRole('button', { name: 'Download the rejected rows' }));
    expect(props.ingest.onDownloadRejected).toHaveBeenCalledTimes(1);
    fireEvent.click(within(chips).getByRole('button', { name: 'Download the skipped rows' }));
    expect(props.ingest.onDownloadSkipped).toHaveBeenCalledTimes(1);
  });

  it('keeps the full summary under Details, and says nothing was added yet', () => {
    renderStep({ ingest: reviewingIngest() });
    const details = screen.getByTestId('ingest-details');
    expect(details.tagName).toBe('DETAILS');
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(within(details).getByTestId('reconciliation').textContent).toBe(
      '1,240 ready + 6 already in this campaign + 20 rejected = 1,266 rows in the file',
    );
    expect(within(details).getByTestId('dnc-notice')).toBeTruthy();
    expect(screen.getByTestId('dry-run-note').textContent).toMatch(/Nothing is added yet/);
    expect(screen.getByTestId('check-expires')).toBeTruthy();
  });

  it('says why the file cannot be added yet', () => {
    renderStep({ ingest: reviewingIngest(), basicsReady: false, blockReason: 'Name the campaign first.' });
    expect(screen.getByTestId('customers-block').textContent).toBe('Name the campaign first.');
  });

  it('opens the column mapper on Change columns, and leads with the mapping when most rows were rejected', () => {
    const ingest = reviewingIngest({
      job: ingestJob({ rows_read: 100, accepted: 50, skipped: 0, rejected: 50, rejected_by_reason: { invalid_phone: 50 } }),
    });
    renderStep({ ingest });
    expect(screen.getByTestId('high-rejection').textContent).toMatch(/50% of your rows were rejected/);
    fireEvent.click(screen.getByTestId('change-columns'));
    expect(ingest.setPhase).toHaveBeenCalledWith('mapping');
    fireEvent.click(screen.getByRole('button', { name: 'Check the columns' }));
    expect(ingest.setPhase).toHaveBeenCalledTimes(2);
  });
});

describe('the card switches (CS9)', () => {
  it('shows sample rows with phone numbers partly hidden, and the hint', () => {
    renderStep({ ingest: reviewingIngest() });
    const section = screen.getByTestId('card-columns');
    expect(within(section).getByRole('heading', { name: 'Tick what agents should see on their screen' })).toBeTruthy();
    const table = within(section).getByRole('table');
    expect(table.textContent).toContain('98••• ••772');
    expect(table.textContent).not.toContain('9820041772');
    expect(table.textContent).toContain('Priya Menon');
    expect(section.textContent).toContain(
      'The ticked columns become the customer card on the agent screen. Phone numbers stay partly hidden from agents unless you change it in step 4.',
    );
  });

  it('ticks a column onto the card through the mapper’s own roles', () => {
    const ingest = reviewingIngest();
    renderStep({ ingest });
    const name = screen.getByRole('switch', { name: 'Show Full Name to agents' }) as HTMLButtonElement;
    expect(name.getAttribute('aria-checked')).toBe('true');
    expect(name.disabled).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Show Amount Due to agents' }));
    const next = (ingest.setMapping as ReturnType<typeof vi.fn>).mock.calls[0]![0] as MappingState;
    expect(next.heroOrder).toEqual(['Amount Due']);
    expect(buildContextDisplay(next).roles).toEqual({ name: 'Full Name', place: 'City' });
  });

  it('disables the other switches once four facts are on, and says why', () => {
    let mapping = initialMapping(ANALYSIS);
    for (const column of ['Amount Due', 'Due Date', 'Loan No', 'Branch']) mapping = toggleCardColumn(mapping, column, true);
    renderStep({ ingest: reviewingIngest({ mapping }) });
    const tz = screen.getByRole('switch', { name: 'Show TZ to agents' }) as HTMLButtonElement;
    expect(tz.disabled).toBe(true);
    const reason = document.getElementById(tz.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe('The card shows 4 facts at most. Untick one to show this instead.');
    expect((screen.getByRole('switch', { name: 'Show Branch to agents' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('is left out where the card is not this step’s to choose', () => {
    renderStep({ ingest: reviewingIngest(), cardChoice: false });
    expect(screen.queryByTestId('card-columns')).toBeNull();
  });
});

describe('running, failed and imported', () => {
  it('shows the check running, and stops it', () => {
    const ingest = fakeIngest({
      phase: 'ingesting', running: true, upload: UPLOAD, analysis: ANALYSIS, mapping: initialMapping(ANALYSIS),
      job: ingestJob({ status: 'running', progress_pct: 40, rows_read: 500 }),
    });
    renderStep({ ingest });
    const progress = screen.getByTestId('ingest-progress');
    expect(progress.textContent).toContain('Checking the file…');
    expect(progress.textContent).toContain('500 rows read · 40%');
    fireEvent.click(screen.getByRole('button', { name: 'Stop the check' }));
    expect(ingest.onCancelIngest).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Replace file' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a failed check in full, with the ways back', () => {
    const ingest = reviewingIngest({
      reviewing: false,
      job: ingestJob({ status: 'failed', error_message: 'The file could not be read as a CSV.', rows_read: 0, accepted: 0, rejected: 0, skipped: 0 }),
    });
    renderStep({ ingest });
    expect(screen.getByTestId('ingest-summary').textContent).toContain('The file could not be read as a CSV.');
    expect(screen.queryByTestId('ingest-chips')).toBeNull();
    const recovery = screen.getByTestId('ingest-recovery');
    fireEvent.click(within(recovery).getByRole('button', { name: 'Upload a corrected file' }));
    expect(ingest.reset).toHaveBeenCalledTimes(1);
    fireEvent.click(within(recovery).getByRole('button', { name: 'Change columns' }));
    expect(ingest.setPhase).toHaveBeenCalledWith('mapping');
  });

  it('after a failed import whose check stands, says the retry is the next step (IM2)', () => {
    renderStep({
      ingest: reviewingIngest({
        reviewing: false,
        retryable: true,
        checkJob: ingestJob(),
        job: ingestJob({ job_id: 'import-1', dry_run: false, status: 'failed', accepted: 0, rejected: 0, skipped: 0, rows_read: 0 }),
      }),
    });
    expect(screen.getByTestId('ingest-retry-note')).toBeTruthy();
    expect(screen.queryByTestId('ingest-recovery')).toBeNull();
  });

  it('after an import, says what was added and shows the card as saved', () => {
    renderStep({
      ingest: reviewingIngest({
        reviewing: false,
        checkJob: ingestJob(),
        job: ingestJob({ job_id: 'import-1', dry_run: false, campaign_id: 'camp-1', check_job_id: 'check-1', check_expires_at: null }),
      }),
    });
    expect(screen.getByTestId('chip-ready').textContent).toBe('1,240 customers added');
    expect(screen.queryByRole('button', { name: 'Replace file' })).toBeNull();
    expect(screen.queryByTestId('change-columns')).toBeNull();
    expect(screen.queryByTestId('dry-run-note')).toBeNull();
    expect((screen.getByRole('switch', { name: 'Show Amount Due to agents' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('card-locked')).toBeTruthy();
  });

  it('asks for the phone column when the analysis is not sure, and only checks (CS8)', () => {
    const unsure: AgencyColumnAnalysis = { ...ANALYSIS, suggested_phone_column: null, phone_column_ambiguous: true, phone_column_candidates: ['Cust Mobile', 'Loan No'] };
    const mapping = setRole(initialMapping(unsure), 'Cust Mobile', 'phone');
    const ingest = fakeIngest({ phase: 'mapping', upload: UPLOAD, analysis: unsure, mapping });
    renderStep({ ingest });
    expect(screen.getByTestId('phone-ambiguous')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /without checking/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check the file' }));
    expect(ingest.startIngest).toHaveBeenCalledWith(true);
  });
});

/**
 * The step over the real `useRosterIngest`, with the page's part played by a footer that runs
 * `customersContinue`: the CS8 check that starts by itself, and a check that stands while the
 * card's columns are picked.
 */
describe('with the roster ingest itself', () => {
  const onIngestStarted = vi.fn(async (_id: string, _mapping: MappingState) => {});

  function Harness() {
    const ingest = useRosterIngest('t1', 'a1', {
      source: 'builder',
      resolveCampaignId: async () => 'camp-1',
      peekCampaignId: () => undefined,
      onIngestStarted,
    });
    const next = customersContinue(ingest.phase, ingest.job, ingest.checkJob, { importing: ingest.importing });
    return (
      <>
        <CustomersStep ingest={ingest} basicsReady blockReason={null} onPickFile={ingest.onPickFile} />
        {next ? (
          <button type="button" data-testid="footer-next" onClick={() => void (next.action === 'import' ? ingest.importChecked() : undefined)}>
            {next.label}
          </button>
        ) : null}
      </>
    );
  }

  beforeEach(() => {
    api.getIngestLimits.mockResolvedValue({ max_rows: 1_000_000, max_columns: 50, max_cell_bytes: 4096, max_file_bytes: 512 * 1024 * 1024 });
    api.uploadRosterCsv.mockResolvedValue(UPLOAD);
    api.startRosterIngest.mockResolvedValue({ job_id: 'check-1', status: 'pending' });
    api.getIngestJob.mockResolvedValue(ingestJob());
    api.importCheckedFile.mockResolvedValue({ job_id: 'import-1', status: 'pending', check_job_id: 'check-1', already_started: false });
  });

  async function dropFile() {
    fireEvent.drop(screen.getByTestId('contacts-dropzone'), { dataTransfer: { files: [csv()] } });
  }

  it('checks a file whose phone column is sure as soon as it is read, and shows the chips', async () => {
    api.analyzeRosterColumns.mockResolvedValue(ANALYSIS);
    render(<Harness />);
    await dropFile();
    await waitFor(() => expect(screen.getByTestId('chip-ready').textContent).toBe('1,240 customers ready'));
    expect(api.startRosterIngest).toHaveBeenCalledTimes(1);
    expect(api.startRosterIngest.mock.calls[0]![0]).toMatchObject({ phone_column: 'Cust Mobile', dry_run: true });
    expect(screen.queryByTestId('customers-mapper')).toBeNull();
    expect(screen.getByTestId('footer-next').textContent).toBe('Add 1,240 customers');

    // Change columns opens the mapper and does not check again by itself.
    fireEvent.click(screen.getByTestId('change-columns'));
    expect(screen.getByTestId('customers-mapper')).toBeTruthy();
    expect(api.startRosterIngest).toHaveBeenCalledTimes(1);
  });

  it('asks instead when the analysis is not sure', async () => {
    api.analyzeRosterColumns.mockResolvedValue({ ...ANALYSIS, suggested_phone_column: null, phone_column_ambiguous: true });
    render(<Harness />);
    await dropFile();
    await waitFor(() => expect(screen.getByTestId('customers-mapper')).toBeTruthy());
    expect(api.startRosterIngest).not.toHaveBeenCalled();
    expect(screen.queryByTestId('footer-next')).toBeNull();
  });

  it('keeps the check when the card’s columns are picked after it, and saves the picks with the import', async () => {
    api.analyzeRosterColumns.mockResolvedValue(ANALYSIS);
    render(<Harness />);
    await dropFile();
    await waitFor(() => expect(screen.getByTestId('footer-next').textContent).toBe('Add 1,240 customers'));

    fireEvent.click(screen.getByRole('switch', { name: 'Show Amount Due to agents' }));
    expect(screen.getByRole('switch', { name: 'Show Amount Due to agents' }).getAttribute('aria-checked')).toBe('true');
    // The check still stands: its Add button is still offered, and it imports.
    expect(screen.getByTestId('footer-next').textContent).toBe('Add 1,240 customers');
    fireEvent.click(screen.getByTestId('footer-next'));
    await waitFor(() => expect(api.importCheckedFile).toHaveBeenCalledWith('check-1', 'camp-1', 't1', 'a1'));
    const mapping = onIngestStarted.mock.calls[0]![1];
    expect(buildContextDisplay(mapping).facts?.map((f) => f.column)).toEqual(['Amount Due']);
  });
});
