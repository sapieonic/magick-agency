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
  xlsxUpload,
} from '../../utils/campaignSetup/customersFixtures';
import { watchFileInputClears } from '../../helpers/fileInputClears';
import { BUSY_REFUSALS, WORKBOOK_TOO_LARGE, WORKBOOK_UNSUPPORTED } from '../../helpers/uploadRefusals';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
  getIngestLimits: vi.fn(),
  uploadCustomerFile: vi.fn(),
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
  it('reads as the mock-up, Excel or CSV (CS7), with the limits in Indian grouping', () => {
    renderStep();
    expect(screen.getByRole('heading', { name: 'Customers' })).toBeTruthy();
    expect(screen.getByText('Upload an Excel or CSV file. We check it for you.')).toBeTruthy();
    expect(screen.getByText('Drop an Excel or CSV file here, or choose one. We find the phone number column for you.')).toBeTruthy();
    expect(screen.getByTestId('ingest-limits').textContent).toBe('Up to 10,00,000 rows and 512 MB per file.');
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeTruthy();
    // By extension and by type; a legacy .xls is not offered (the server refuses it, IM8).
    const accept = (screen.getByLabelText('Excel or CSV file') as HTMLInputElement).accept.split(',');
    expect(accept).toEqual(['.csv', 'text/csv', '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    expect(accept).not.toContain('.xls');
    expect(accept).not.toContain('application/vnd.ms-excel');
  });

  it('hands a dropped Excel file over as it does a CSV', () => {
    const onPickFile = vi.fn(async () => {});
    renderStep({ onPickFile });
    const workbook = new File(['PK'], 'Customers May.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    fireEvent.drop(screen.getByTestId('contacts-dropzone'), { dataTransfer: { files: [workbook] } });
    expect(onPickFile).toHaveBeenCalledWith(workbook);
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
    fireEvent.change(screen.getByLabelText('Excel or CSV file'), { target: { files: [csv('third.csv')] } });
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

  it('clears the picker after each pick, so the same file can be chosen again after a refusal', async () => {
    const onPickFile = vi.fn(async () => {});
    renderStep({ onPickFile });
    const input = screen.getByLabelText('Excel or CSV file') as HTMLInputElement;
    const clears = watchFileInputClears(input);
    fireEvent.change(input, { target: { files: [csv()] } });
    expect(onPickFile).toHaveBeenCalledTimes(1);
    expect(clears()).toBe(1);
    expect(input.value).toBe('');
    await waitFor(() => {
      fireEvent.change(input, { target: { files: [csv()] } });
      expect(onPickFile).toHaveBeenCalledTimes(2);
    });
    expect(clears()).toBeGreaterThanOrEqual(2);
  });

  it('says an Excel file is being read as well as sent, which can take a while after the bytes are up', () => {
    renderStep({ ingest: fakeIngest({ phase: 'uploading', uploadingWorkbook: true }) });
    expect(screen.getByRole('status').textContent).toBe('Uploading and reading the file…');
    expect(screen.queryByText('Uploading…')).toBeNull();
  });

  it('takes no file once an upload is under way, and says what is happening', () => {
    const onPickFile = vi.fn();
    renderStep({ onPickFile, ingest: fakeIngest({ phase: 'uploading' }) });
    expect(screen.getByText('Uploading…')).toBeTruthy();
    expect(screen.queryByText('Uploading and reading the file…')).toBeNull();
    expect((screen.getByRole('button', { name: 'Choose a file' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.drop(screen.getByTestId('contacts-dropzone'), { dataTransfer: { files: [csv()] } });
    expect(onPickFile).not.toHaveBeenCalled();
    cleanup();
    renderStep({ ingest: fakeIngest({ phase: 'analyzing' }) });
    expect(screen.getByText('Reading the columns…')).toBeTruthy();
  });
});

describe('an Excel upload’s sheets (CS7)', () => {
  it('says nothing about sheets for a CSV', () => {
    renderStep({ ingest: reviewingIngest() });
    expect(screen.getByTestId('file-row')).toBeTruthy();
    expect(screen.queryByTestId('sheet-read')).toBeNull();
    expect(screen.queryByTestId('sheet-others')).toBeNull();
    expect(screen.getByTestId('file-row').textContent).not.toMatch(/sheet/i);
  });

  it('names the sheet read, in the file row, and nothing more when it is the only one', () => {
    renderStep({ ingest: reviewingIngest({ upload: xlsxUpload() }) });
    const row = screen.getByTestId('file-row');
    expect(within(row).getByText('Customers May.xlsx').tagName).toBe('STRONG');
    expect(within(row).getByTestId('sheet-read').textContent).toBe('Read from the sheet ‘Customers’.');
    expect(screen.queryByTestId('sheet-others')).toBeNull();
  });

  it('announces the notice, as the step’s other notes are', () => {
    renderStep({ ingest: reviewingIngest({ upload: xlsxUpload(['Paid']) }) });
    const notice = within(screen.getByTestId('file-row')).getByTestId('sheet-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(within(notice).getByTestId('sheet-read')).toBeTruthy();
    expect(within(notice).getByTestId('sheet-others')).toBeTruthy();
  });

  it('counts every other sheet, and lists the first five', () => {
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'];
    renderStep({ ingest: reviewingIngest({ upload: xlsxUpload(names, 300) }) });
    expect(screen.getByTestId('sheet-others').textContent).toBe(
      'This file has 300 other sheets (‘Jan’, ‘Feb’, ‘Mar’, ‘Apr’, ‘May’ and 295 more) that were not read. To import them, move those customers to the sheet ‘Customers’, or save each sheet as its own file.',
    );
  });

  it('names one other sheet that was not read, and how to import it', () => {
    renderStep({ ingest: reviewingIngest({ upload: xlsxUpload(['Paid']) }) });
    expect(within(screen.getByTestId('file-row')).getByTestId('sheet-others').textContent).toBe(
      'This file has 1 other sheet (‘Paid’) that was not read. To import it, move those customers to the sheet ‘Customers’, or save that sheet as its own file.',
    );
  });

  it('names several other sheets that were not read, in tab order', () => {
    renderStep({ ingest: reviewingIngest({ upload: xlsxUpload(['Paid', 'Archive']) }) });
    expect(screen.getByTestId('sheet-read').textContent).toBe('Read from the sheet ‘Customers’.');
    expect(screen.getByTestId('sheet-others').textContent).toBe(
      'This file has 2 other sheets (‘Paid’, ‘Archive’) that were not read. To import them, move those customers to the sheet ‘Customers’, or save each sheet as its own file.',
    );
  });

  it('shows the sheet while the columns are being picked too', () => {
    renderStep({
      ingest: fakeIngest({ phase: 'mapping', upload: xlsxUpload(['Paid']), analysis: { ...ANALYSIS, suggested_phone_column: null, phone_column_ambiguous: true }, mapping: initialMapping(ANALYSIS) }),
    });
    expect(screen.getByTestId('customers-mapper')).toBeTruthy();
    expect(within(screen.getByTestId('file-row')).getByTestId('sheet-read').textContent).toBe('Read from the sheet ‘Customers’.');
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
    expect(within(section).getByRole('heading', { name: 'Tick what goes on the customer card' })).toBeTruthy();
    const table = within(section).getByRole('table');
    expect(table.textContent).toContain('98••• ••772');
    expect(table.textContent).not.toContain('9820041772');
    expect(table.textContent).toContain('Priya Menon');
    expect(section.textContent).toContain(
      "The ticked columns become the customer card on the agent screen. Agents see every other column under More details, below the card; you can turn any of them off in the campaign's Settings. Phone numbers stay partly hidden from agents unless you change it in step 4.",
    );
  });

  it('ticks a column onto the card through the mapper’s own roles', () => {
    const ingest = reviewingIngest();
    renderStep({ ingest });
    const name = screen.getByRole('switch', { name: 'Put Full Name on the card' }) as HTMLButtonElement;
    expect(name.getAttribute('aria-checked')).toBe('true');
    expect(name.disabled).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Put Amount Due on the card' }));
    const next = (ingest.setMapping as ReturnType<typeof vi.fn>).mock.calls[0]![0] as MappingState;
    expect(next.heroOrder).toEqual(['Amount Due']);
    expect(buildContextDisplay(next).roles).toEqual({ name: 'Full Name', place: 'City' });
  });

  it('disables the other switches once four facts are on, and says why', () => {
    let mapping = initialMapping(ANALYSIS);
    for (const column of ['Amount Due', 'Due Date', 'Loan No', 'Branch']) mapping = toggleCardColumn(mapping, column, true);
    renderStep({ ingest: reviewingIngest({ mapping }) });
    const tz = screen.getByRole('switch', { name: 'Put TZ on the card' }) as HTMLButtonElement;
    expect(tz.disabled).toBe(true);
    const reason = document.getElementById(tz.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe('The card shows 4 facts at most. Untick one to show this instead.');
    expect((screen.getByRole('switch', { name: 'Put Branch on the card' }) as HTMLButtonElement).disabled).toBe(false);
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
    expect((screen.getByRole('switch', { name: 'Put Amount Due on the card' }) as HTMLButtonElement).disabled).toBe(true);
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
        {ingest.error ? <p data-testid="harness-error">{ingest.error}</p> : null}
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
    api.uploadCustomerFile.mockResolvedValue(UPLOAD);
    api.startRosterIngest.mockResolvedValue({ job_id: 'check-1', status: 'pending' });
    api.getIngestJob.mockResolvedValue(ingestJob());
    api.importCheckedFile.mockResolvedValue({ job_id: 'import-1', status: 'pending', check_job_id: 'check-1', already_started: false });
  });

  async function dropFile() {
    fireEvent.drop(screen.getByTestId('contacts-dropzone'), { dataTransfer: { files: [csv()] } });
  }

  it('says an Excel file is being read as well as sent while it uploads, and a CSV only that it is sent', async () => {
    api.uploadCustomerFile.mockImplementation(() => new Promise(() => {}));
    render(<Harness />);
    const workbook = new File(['PK'], 'Customers May.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    fireEvent.drop(screen.getByTestId('contacts-dropzone'), { dataTransfer: { files: [workbook] } });
    expect((await screen.findByRole('status')).textContent).toBe('Uploading and reading the file…');
    cleanup();
    render(<Harness />);
    await dropFile();
    expect((await screen.findByRole('status')).textContent).toBe('Uploading…');
  });

  it('says a file over the size limit plainly, with the limit, when the 413 is not the server’s own (an HTML page from the proxy)', async () => {
    api.uploadCustomerFile.mockRejectedValue(new ApiError(413, undefined));
    render(<Harness />);
    await waitFor(() => expect(api.getIngestLimits).toHaveBeenCalled());
    await screen.findByTestId('ingest-limits');
    await dropFile();
    expect((await screen.findByTestId('harness-error')).textContent).toBe('This file is too large. A file can be up to 512 MB.');
    expect(screen.getByTestId('contacts-dropzone')).toBeTruthy();
  });

  it('uses the server’s words for its own file_too_large', async () => {
    api.uploadCustomerFile.mockRejectedValue(new ApiError(413, WORKBOOK_TOO_LARGE.body));
    render(<Harness />);
    await dropFile();
    expect((await screen.findByTestId('harness-error')).textContent).toBe(WORKBOOK_TOO_LARGE.body.message);
  });

  it.each([[WORKBOOK_UNSUPPORTED.status, WORKBOOK_UNSUPPORTED], ...BUSY_REFUSALS])(
    'shows a %i refusal in the server’s words, and the same file can be chosen again',
    async (status, refusal) => {
      api.uploadCustomerFile.mockRejectedValueOnce(new ApiError(status, refusal.body));
      api.uploadCustomerFile.mockResolvedValueOnce(UPLOAD);
      api.analyzeRosterColumns.mockResolvedValue(ANALYSIS);
      render(<Harness />);
      const input = screen.getByLabelText('Excel or CSV file') as HTMLInputElement;
      const clears = watchFileInputClears(input);
      fireEvent.change(input, { target: { files: [csv()] } });
      expect((await screen.findByTestId('harness-error')).textContent).toBe(refusal.body.message);
      expect(clears()).toBe(1);
      fireEvent.change(screen.getByLabelText('Excel or CSV file'), { target: { files: [csv()] } });
      await waitFor(() => expect(api.uploadCustomerFile).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByTestId('harness-error')).toBeNull());
    },
  );

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

    fireEvent.click(screen.getByRole('switch', { name: 'Put Amount Due on the card' }));
    expect(screen.getByRole('switch', { name: 'Put Amount Due on the card' }).getAttribute('aria-checked')).toBe('true');
    // The check still stands: its Add button is still offered, and it imports.
    expect(screen.getByTestId('footer-next').textContent).toBe('Add 1,240 customers');
    fireEvent.click(screen.getByTestId('footer-next'));
    await waitFor(() => expect(api.importCheckedFile).toHaveBeenCalledWith('check-1', 'camp-1', 't1', 'a1'));
    const mapping = onIngestStarted.mock.calls[0]![1];
    expect(buildContextDisplay(mapping).facts?.map((f) => f.column)).toEqual(['Amount Due']);
  });

  it('reads an Excel file the same way, says which sheet was read, and names the downloads without .xlsx', async () => {
    api.uploadCustomerFile.mockResolvedValue(xlsxUpload(['Paid', 'Archive']));
    api.analyzeRosterColumns.mockResolvedValue(ANALYSIS);
    api.getIngestJob.mockResolvedValue(ingestJob({ file_name: 'Customers May.xlsx' }));
    api.downloadRejectedRows.mockResolvedValue(new Blob(['x']));
    api.downloadSkippedRows.mockResolvedValue(new Blob(['x']));
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    try {
      render(<Harness />);
      const workbook = new File(['PK'], 'Customers May.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      fireEvent.drop(screen.getByTestId('contacts-dropzone'), { dataTransfer: { files: [workbook] } });
      await waitFor(() => expect(screen.getByTestId('chip-ready').textContent).toBe('1,240 customers ready'));
      expect(api.uploadCustomerFile.mock.calls[0]![0]).toBe(workbook);
      // The check reads the stored CSV, under the name the supervisor's file had.
      expect(api.startRosterIngest.mock.calls[0]![0]).toMatchObject({ file_name: 'Customers May.xlsx', dry_run: true });
      const row = screen.getByTestId('file-row');
      expect(within(row).getByTestId('sheet-read').textContent).toBe('Read from the sheet ‘Customers’.');
      expect(within(row).getByTestId('sheet-others').textContent).toContain('2 other sheets (‘Paid’, ‘Archive’) that were not read');

      const chips = screen.getByTestId('ingest-chips');
      fireEvent.click(within(chips).getByRole('button', { name: 'Download the rejected rows' }));
      await waitFor(() => expect(names).toEqual(['Customers May-rejected-rows.csv']));
      fireEvent.click(within(chips).getByRole('button', { name: 'Download the skipped rows' }));
      await waitFor(() => expect(names).toEqual(['Customers May-rejected-rows.csv', 'Customers May-skipped-rows.csv']));
    } finally {
      click.mockRestore();
    }
  });

  it.each([
    ['a CSV’s, whatever its case', 'NOV LIST.CSV', 'NOV LIST-rejected-rows.csv'],
    ['a macro workbook’s (the server reads it by its content)', 'Customers.xlsm', 'Customers-rejected-rows.csv'],
  ])('names %s downloads without the extension', async (_what, fileName, expected) => {
    api.analyzeRosterColumns.mockResolvedValue(ANALYSIS);
    api.getIngestJob.mockResolvedValue(ingestJob({ file_name: fileName }));
    api.downloadRejectedRows.mockResolvedValue(new Blob(['x']));
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    try {
      render(<Harness />);
      await dropFile();
      await waitFor(() => expect(screen.getByTestId('chip-ready')).toBeTruthy());
      expect(screen.queryByTestId('sheet-read')).toBeNull();
      fireEvent.click(within(screen.getByTestId('ingest-chips')).getByRole('button', { name: 'Download the rejected rows' }));
      await waitFor(() => expect(names).toEqual([expected]));
    } finally {
      click.mockRestore();
    }
  });
});
