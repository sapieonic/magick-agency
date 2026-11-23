import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { AgencyIngestJob } from '../../types/agency-campaign';
import { ApiError } from '../../api/client';
import {
  ANALYSIS,
  UNSURE_ANALYSIS,
  applied,
  check,
  currentStep,
  dropCsv,
  fillBasics,
  footer,
  footerButton,
  goToStep,
  imported,
  job,
  openFold,
  renderPage,
  saveDraftButton,
  staffingHook,
} from './campaignBuilderFixtures';

/**
 * Customers and the draft at the PAGE level.
 *
 * The rule this file exists for: **a component test passing does not mean the page renders the
 * component.** So every assertion below goes through `CampaignBuilderPage`: the upload, the
 * check that starts by itself (CS8), "Add N customers" from the footer, the draft that import
 * creates, and what the page says about that draft.
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
  downloadSkippedRows: vi.fn(),
  importCheckedFile: vi.fn(),
  createAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  transitionAgencyCampaign: vi.fn(),
  applyStaffing: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({
  // The recording field reads the account's capabilities; allowed here.
  useGovernance: () => ({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() }),
}));
// The caller-ID picker is a hard gate on this page: The API rejects a campaign with
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
vi.mock('../../hooks/useCampaignStaffing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useCampaignStaffing')>()),
  useCampaignStaffing: () => staffingHook(mocks.applyStaffing),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getIngestLimits: mocks.getIngestLimits,
  uploadRosterCsv: mocks.uploadRosterCsv,
  analyzeRosterColumns: mocks.analyzeRosterColumns,
  startRosterIngest: mocks.startRosterIngest,
  getIngestJob: mocks.getIngestJob,
  cancelIngestJob: mocks.cancelIngestJob,
  downloadRejectedRows: mocks.downloadRejectedRows,
  downloadSkippedRows: mocks.downloadSkippedRows,
  importCheckedFile: mocks.importCheckedFile,
  createAgencyCampaign: mocks.createAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
  transitionAgencyCampaign: mocks.transitionAgencyCampaign,
}));

/** The jobs the poll is served, by id. */
function serveJobs(...jobs: AgencyIngestJob[]) {
  const byId = new Map(jobs.map((j) => [j.job_id, j]));
  mocks.getIngestJob.mockImplementation(async (id: string) => {
    const found = byId.get(id);
    if (!found) throw new Error(`no job ${id}`);
    return found;
  });
}

/** Basics in, on Customers, a file dropped and its check finished (the phone column is sure). */
async function reachCheck(checked: AgencyIngestJob = check()) {
  serveJobs(checked, imported());
  await renderPage();
  fillBasics();
  goToStep('Customers');
  dropCsv();
  await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
  return checked;
}

/** A file whose phone column is not sure: the column mapper asks. */
async function reachMapping() {
  mocks.analyzeRosterColumns.mockResolvedValue(UNSURE_ANALYSIS);
  await renderPage();
  fillBasics();
  goToStep('Customers');
  dropCsv();
  await screen.findByLabelText('Use Cust Mobile as');
}

/** Check then add, through the footer: the draft is created and the checked file imported. */
async function addChecked(label = 'Add 3 customers') {
  fireEvent.click(await screen.findByRole('button', { name: label }, { timeout: 4000 }));
  await waitFor(() => expect(mocks.importCheckedFile).toHaveBeenCalled());
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
    dedupe_columns: [],
    file_size_bytes: 4096,
  });
  mocks.analyzeRosterColumns.mockResolvedValue(ANALYSIS);
  mocks.startRosterIngest.mockResolvedValue({ job_id: 'check-1', status: 'pending' });
  mocks.importCheckedFile.mockResolvedValue({ job_id: 'import-1', status: 'pending', check_job_id: 'check-1', already_started: false });
  serveJobs(check(), imported());
  mocks.createAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
  mocks.updateAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
  mocks.applyStaffing.mockResolvedValue(applied());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the check that starts by itself, and Add N customers (CS8, IM2)', () => {
  it('checks a file whose phone column is sure, without creating a campaign, and says nothing was added', async () => {
    await reachCheck();
    // A check never creates the draft, and before the draft exists it names no campaign.
    expect(mocks.startRosterIngest.mock.calls[0]![0]).toMatchObject({ phone_column: 'Cust Mobile', dry_run: true });
    expect(mocks.startRosterIngest.mock.calls[0]![0]).not.toHaveProperty('campaign_id');
    expect((await screen.findByTestId('chip-ready', undefined, { timeout: 4000 })).textContent).toBe('3 customers ready');
    expect(screen.getByTestId('dry-run-note')).toBeTruthy();
    expect(mocks.createAgencyCampaign).not.toHaveBeenCalled();
    expect(footerButton('Add 3 customers')).toBeTruthy();
  });

  it('Add N customers creates the draft, imports the checked file into it, and moves on once it is in', async () => {
    await reachCheck();
    await addChecked();
    expect(mocks.importCheckedFile).toHaveBeenCalledWith('check-1', 'camp-1', 't1', 'a1');
    expect(mocks.createAgencyCampaign).toHaveBeenCalledTimes(1);
    // The file is never imported unchecked: the one ingest started is the check.
    expect(mocks.startRosterIngest).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(currentStep()).toBe('purpose'));

    // Back on Customers, the import is what is shown, and Continue moves on.
    goToStep('Customers');
    expect(screen.getByTestId('chip-ready').textContent).toBe('3 customers added');
    expect(footerButton('Continue')).toBeTruthy();
  });

  it('closes Customers again when the basics are taken off, so nothing can be added without them', async () => {
    await reachCheck();
    await screen.findByRole('button', { name: 'Add 3 customers' }, { timeout: 4000 });
    goToStep('Name & number');
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'Customers' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.createAgencyCampaign).not.toHaveBeenCalled();
  });

  it('a check that failed offers the way back: a corrected file, or other columns', async () => {
    await reachCheck(check({ status: 'failed', error_code: 'malformed_csv', error_message: 'Could not read the CSV: Invalid Closing Quote.' }));
    const recovery = await screen.findByTestId('ingest-recovery', undefined, { timeout: 4000 });
    expect(within(recovery).getByRole('button', { name: 'Upload a corrected file' })).toBeTruthy();
    expect(footerButton('Skip for now')).toBeTruthy();

    fireEvent.click(within(recovery).getByRole('button', { name: 'Change columns' }));
    expect(screen.queryByTestId('ingest-summary')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check the file' })).toBeTruthy();
  });

  it('an import of the checked file that failed offers Add customers again, while the check is valid, and stays on the step', async () => {
    serveJobs(check(), imported({
      status: 'failed', rows_read: 0, accepted: 0, rejected: 0,
      error_code: 'dnc_unavailable', error_message: 'The Do Not Call list could not be checked, so no contacts were imported. Nothing was dialled. Try the import again.',
    }));
    await renderPage();
    fillBasics();
    goToStep('Customers');
    dropCsv();
    await addChecked();

    const again = await screen.findByRole('button', { name: 'Add customers again' }, { timeout: 4000 });
    expect(currentStep()).toBe('contacts');
    mocks.importCheckedFile.mockResolvedValue({ job_id: 'import-2', status: 'pending', check_job_id: 'check-1', already_started: false });
    fireEvent.click(again);
    await waitFor(() => expect(mocks.importCheckedFile).toHaveBeenCalledTimes(2));
    expect(mocks.importCheckedFile.mock.calls[1]).toEqual(['check-1', 'camp-1', 't1', 'a1']);
    expect(mocks.createAgencyCampaign).toHaveBeenCalledTimes(1);
  });

  it('an import that failed after its check expired: no retry, and Change columns sets it aside for a new check', async () => {
    serveJobs(
      check({ check_expires_at: '2026-01-01T00:00:00.000Z' }),
      imported({ status: 'failed', rows_read: 0, accepted: 0, rejected: 0, error_code: 'unexpected_error', error_message: 'The import failed.' }),
    );
    await renderPage();
    fillBasics();
    goToStep('Customers');
    dropCsv();
    await addChecked();

    const recovery = await screen.findByTestId('ingest-recovery', undefined, { timeout: 4000 });
    expect(screen.queryByRole('button', { name: 'Add customers again' })).toBeNull();
    fireEvent.click(within(recovery).getByRole('button', { name: 'Change columns' }));
    expect(screen.queryByTestId('ingest-summary')).toBeNull();
    expect((screen.getByLabelText('Use Cust Mobile as') as HTMLSelectElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Check the file' })).toBeTruthy();
  });

  it('saves the columns ticked for the card as the new campaign’s facts, before the import (AS19, CS9)', async () => {
    await reachCheck();
    await screen.findByRole('button', { name: 'Add 3 customers' }, { timeout: 4000 });
    fireEvent.click(screen.getByRole('switch', { name: 'Show Internal Score to agents' }));
    await addChecked();
    expect(mocks.updateAgencyCampaign).toHaveBeenCalledWith(
      'camp-1',
      // The guessed name column goes as the name role, so it stays a hero (AS19 R1).
      { context_display: { facts: [{ column: 'Internal Score', label: 'Internal Score', key: 'internal_score' }], roles: { name: 'Full Name' } } },
      't1',
      'a1',
    );
    expect(mocks.updateAgencyCampaign.mock.invocationCallOrder[0]!).toBeLessThan(mocks.importCheckedFile.mock.invocationCallOrder[0]!);
  });
});

describe('the abandonment limit on a draft created by the roster import', () => {
  /*
    A roster import creates the draft before any config save. If the operator moved the line and
    never saved the config, the PATCH that carries it never happens, so the create has to:
    otherwise the draft keeps the server's 3%.
  */
  async function importWithCeiling(set: () => void) {
    await renderPage();
    fillBasics();
    goToStep('Agents & timing');
    openFold('advanced-settings');
    set();
    goToStep('Customers');
    dropCsv();
    await addChecked();
    return mocks.createAgencyCampaign.mock.calls[0]![0] as Record<string, unknown>;
  }
  const slider = () => screen.getByRole('slider', { name: 'Abandonment limit' });
  const box = () => screen.getByRole('spinbutton', { name: 'Pause above (%)' });

  it('sends the value the line was moved to on the create', async () => {
    const body = await importWithCeiling(() => {
      fireEvent.keyDown(slider(), { key: 'PageUp' });
      fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    });
    expect(body.abandonment_ceiling_pct).toBe(4.1);
    // And the import goes on into that draft, with no config save.
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it.each([
    ['an emptied box', ''],
    ['an out-of-range value', '15'],
  ])('leaves it off the create for %s, so the server default applies', async (_label, typed) => {
    const body = await importWithCeiling(() => fireEvent.change(box(), { target: { value: typed } }));
    expect(body).toEqual({
      name: 'Collections',
      caller_ids: ['+912200000001'],
      telephony_provider: 'voicelink',
      telephony_credential_id: null,
    });
  });
});

describe('the page composes the column mapper, when the phone column is not sure', () => {
  it('shows the real row limit from the API rather than a copied constant', async () => {
    await renderPage();
    fillBasics();
    goToStep('Customers');
    // The number the admin is told must be the real one, in Indian grouping.
    expect((await screen.findByTestId('ingest-limits')).textContent).toContain('10,00,000 rows');
  });

  it('renders one role select per column, with samples from the file, and checks nothing by itself', async () => {
    await reachMapping();
    for (const column of ANALYSIS.columns) {
      expect(screen.getByLabelText(`Use ${column.name} as`)).toBeTruthy();
    }
    // A header alone cannot identify a phone column; the values are the evidence.
    expect(screen.getAllByText('9820041772').length).toBeGreaterThan(0);
    expect(mocks.startRosterIngest).not.toHaveBeenCalled();
    // The mapper's own "Check the file" is the next move, so the footer offers none.
    expect(footer().queryByRole('button', { name: /Add|Skip|Continue/ })).toBeNull();
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

  it('sends an arbitrarily-named phone column and the timezone column on the check', async () => {
    await reachMapping();
    fireEvent.change(screen.getByLabelText('Use TZ as'), { target: { value: 'timezone' } });
    fireEvent.change(screen.getByLabelText('Use Internal Score as'), { target: { value: 'ignore' } });

    fireEvent.click(screen.getByRole('button', { name: 'Check the file' }));

    await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
    expect(mocks.startRosterIngest.mock.calls[0]![0]).toMatchObject({
      phone_column: 'Cust Mobile',
      timezone_column: 'TZ',
      ignore_columns: ['Internal Score'],
      dry_run: true,
    });
  });

  /**
   * The country code applied to numbers written without one.
   *
   * The API normalises every un-prefixed number by prepending a server-side default (`91`
   * unless the env says otherwise). Nothing surfaced it, so a US roster imported "100%
   * accepted" and dialled India.
   */
  it('offers the country code on the mapping screen, and sends NOTHING when untouched', async () => {
    await reachMapping();
    // The control is on the screen where the phone column is chosen — that is the moment the
    // operator is looking at the numbers.
    expect(screen.getByLabelText(/country code for numbers without one/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check the file' }));
    await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
    // Zero behaviour change at the default: the key is absent, not empty.
    expect('default_country_code' in mocks.startRosterIngest.mock.calls[0]![0]).toBe(false);
  });

  it('sends the country code the operator typed', async () => {
    await reachMapping();
    fireEvent.change(screen.getByLabelText(/country code for numbers without one/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check the file' }));
    await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
    expect(mocks.startRosterIngest.mock.calls[0]![0]).toMatchObject({ default_country_code: '1' });
  });

  it('blocks the check on a malformed country code rather than 400ing after upload', async () => {
    await reachMapping();
    fireEvent.change(screen.getByLabelText(/country code for numbers without one/i), { target: { value: '1234' } });
    expect(screen.getByTestId('country-code-error')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Check the file' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.startRosterIngest).not.toHaveBeenCalled();
  });

  it('refuses to check with no phone column mapped', async () => {
    await reachMapping();
    fireEvent.change(screen.getByLabelText('Use Cust Mobile as'), { target: { value: 'detail' } });
    expect(screen.getByTestId('mapping-block')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Check the file' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the page composes the ingest summary', () => {
  /** The draft's import of a big file, summarised under Details. */
  async function importBig(importJob: AgencyIngestJob, checked: AgencyIngestJob = check({ accepted: 11_712, rows_read: 12_481 })) {
    serveJobs(checked, importJob);
    await renderPage();
    fillBasics();
    goToStep('Customers');
    dropCsv();
    await addChecked('Add 11,712 customers');
    // Added, the page moves on; the summary is back on Customers.
    await waitFor(() => expect(currentStep()).toBe('purpose'), { timeout: 4000 });
    goToStep('Customers');
    expect(screen.getByTestId('chip-ready').textContent).toContain('added');
    return openFold('ingest-details');
  }

  it('renders counters that reconcile to the file, and does not add duplicates in', async () => {
    const details = await importBig(imported({ ...job(), job_id: 'import-1', check_job_id: 'check-1' }));
    const read = Number(within(details).getByTestId('count-rows_read').textContent!.replace(/[^0-9]/g, ''));
    const accepted = Number(within(details).getByTestId('count-accepted').textContent!.replace(/[^0-9]/g, ''));
    const rejected = Number(within(details).getByTestId('count-rejected').textContent!.replace(/[^0-9]/g, ''));

    expect(accepted + rejected).toBe(read);
    expect(read).toBe(12_481);
    // The duplicate count is on the screen, but not as a counter tile — adding it in overshoots
    // the operator's own file.
    expect(within(details).queryByTestId('count-duplicates')).toBeNull();
    expect(within(details).getByTestId('reconciliation').textContent).toContain('= 12,481 rows read');
  });

  it('reports DNC suppressions separately AND says which total they sit in', async () => {
    const details = await importBig(imported({ ...job(), job_id: 'import-1', check_job_id: 'check-1' }));
    const notice = within(details).getByTestId('dnc-notice');
    expect(notice.textContent).toContain('41');
    expect(notice.textContent).toContain('rejected total');
  });

  it('offers the per-row error report when the API kept one', async () => {
    mocks.downloadRejectedRows.mockResolvedValue(new Blob(['row_number,_reason\n88,bad\n']));
    await importBig(imported({ ...job(), job_id: 'import-1', check_job_id: 'check-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download the rejected rows' }));
    await waitFor(() => expect(mocks.downloadRejectedRows).toHaveBeenCalledWith('import-1', 't1', 'a1'));
  });

  it('surfaces what the API refused on arrival, outside the reconciling counters', async () => {
    // The server threads the dialer runtime's own duplicate count through the job payload. It is
    // NOT a slice of `rejected` — those are rows the API never sent — so it cannot be a tile or a
    // rejection group, and the accepted count it qualifies has to be named as an overstatement
    // rather than silently corrected.
    const details = await importBig(imported({
      ...job(),
      job_id: 'import-1',
      check_job_id: 'check-1',
      rows_read: 5_000,
      accepted: 4_800,
      rejected: 200,
      duplicates: 0,
      rejected_by_reason: { invalid_phone: 200 },
      core_rejected_duplicate_rows: 1_204,
      core_duplicate_source_rows: [3, 8, 12],
    }));
    const block = within(details).getByTestId('core-refused');
    expect(block.textContent).toContain('At least 1,204');
    expect(block.textContent).toContain('overstates');
    // The tiles still balance against the operator's own file.
    expect(within(details).getByTestId('reconciliation').textContent).toContain('= 5,000 rows read');
    expect(within(details).getByTestId('count-rejected').textContent).toContain('200');
    // Sampled rows are examples from the start of the file, never a spread.
    expect(within(details).getByTestId('core-refused-sample').textContent).toContain('start of the file');
  });

  it('shows no refusal block when the API refused nothing', async () => {
    const details = await importBig(imported({ ...job(), job_id: 'import-1', check_job_id: 'check-1' }));
    expect(within(details).queryByTestId('core-refused')).toBeNull();
  });

  it('leads with a column warning when most of the checked file was rejected', async () => {
    await reachCheck(check({ rows_read: 1000, accepted: 300, rejected: 700, rejected_by_reason: { invalid_phone: 700 } }));
    const warning = await screen.findByTestId('high-rejection', undefined, { timeout: 4000 });
    expect(warning.getAttribute('role')).toBe('alert');
    expect(warning.textContent).toContain('70%');
    expect(within(warning).getByRole('button', { name: 'Check the columns' })).toBeTruthy();
  });

  it('shows a determinate progress bar while the import runs, not a hang', async () => {
    serveJobs(check(), imported({ status: 'running', progress_pct: 42, rows_read: 5_000, finished_at: null }));
    await renderPage();
    fillBasics();
    goToStep('Customers');
    dropCsv();
    await addChecked();

    await waitFor(() => expect(screen.getByLabelText('Import progress').getAttribute('value')).toBe('42'));
    expect(screen.getByRole('button', { name: 'Stop the import' })).toBeTruthy();
    // Nothing to press in the footer while it runs, and the step stays put.
    expect(footer().queryByRole('button', { name: /Add|Skip|Continue/ })).toBeNull();
    expect(currentStep()).toBe('contacts');
  });
});

/**
 * A roster picked and waiting for its columns to be mapped is input the builder would lose:
 * leaving then asks, even with the name and numbers taken back off.
 */
describe('leaving the builder mid-upload', () => {
  const dialog = () => screen.getByRole('dialog', { name: 'Leave without saving?' });

  it('asks while a roster waits for its mapping', async () => {
    await reachMapping();
    // No draft yet (it is created when the import starts): take the basics back off.
    goToStep('Name & number');
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '+91 22000 00001' }));

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(dialog()).toBeTruthy();
    expect(mocks.createAgencyCampaign).not.toHaveBeenCalled();
  });

  it('after an import, says the customers are kept in the draft but the settings are not', async () => {
    await reachCheck();
    await addChecked();
    await waitFor(() => expect(currentStep()).toBe('purpose'));
    goToStep('Agents & timing');
    fireEvent.click(screen.getByRole('radio', { name: '9 AM – 6 PM' }));

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(dialog().textContent).toContain(
      'Your customers are in a draft of this campaign, but your latest changes are not saved. Leave now and the draft keeps the default settings; Cancel keeps you here to save them.',
    );
  });
});

/*
  Once a roster import has created the draft, Save as draft is a PATCH. A rename (or new numbers)
  on Name & number after the import has to ride on it, or the server keeps the old name while the
  page counts nothing unsaved and lets the person leave.
*/
describe('basics changed after the roster import created the draft', () => {
  async function importThenBack() {
    await reachCheck();
    await addChecked();
    await waitFor(() => expect(currentStep()).toBe('purpose'));
    goToStep('Name & number');
  }
  const patchBody = () => mocks.updateAgencyCampaign.mock.calls.at(-1)![1] as Record<string, unknown>;

  it('sends the new name on Save as draft, and not the numbers or carrier that did not move', async () => {
    await importThenBack();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Collections Q4 ' } });
    fireEvent.click(saveDraftButton());

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.createAgencyCampaign).toHaveBeenCalledTimes(1);
    expect(patchBody().name).toBe('Collections Q4');
    expect(patchBody()).not.toHaveProperty('caller_ids');
    expect(patchBody()).not.toHaveProperty('telephony_provider');
  });

  it('sends no basics when none moved since the draft was created', async () => {
    await importThenBack();
    fireEvent.click(saveDraftButton());

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(patchBody()).not.toHaveProperty('name');
    expect(patchBody()).not.toHaveProperty('caller_ids');
    expect(patchBody()).not.toHaveProperty('telephony_provider');
  });
});

describe('the draft a roster import creates', () => {
  /*
    The import creates the campaign as a draft with the name, numbers and carrier only; the
    other settings reach it with Save as draft. An operator who imported, changed a setting and
    never got a save through found the draft in the list with the recommended settings, and had
    to make every change again in its Settings. The page now says what the draft holds while the
    form differs from it.
  */
  async function importCustomers() {
    await reachCheck();
    await addChecked();
    await waitFor(() => expect(currentStep()).toBe('purpose'));
    goToStep('Agents & timing');
  }
  const wrapup = () => screen.getByRole('combobox', { name: 'Time to choose what happened after each call' }) as HTMLSelectElement;

  it('says nothing while the form matches the draft', async () => {
    await importCustomers();
    expect(screen.queryByTestId('draft-note')).toBeNull();
  });

  it('says the draft still has the recommended settings once something is changed', async () => {
    await importCustomers();
    fireEvent.change(wrapup(), { target: { value: '45' } });
    expect(screen.getByTestId('draft-note').textContent).toBe(
      'Your customers are in a draft of this campaign, but your settings are not saved yet. They reach the draft only when you click Save as draft or Start campaign.',
    );
    goToStep('Purpose & buttons');
    expect(screen.getByTestId('draft-note')).toBeTruthy();
  });

  it('goes once saved, and says only that changes since are unsaved after that', async () => {
    await importCustomers();
    fireEvent.change(wrapup(), { target: { value: '45' } });
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].wrapup_seconds).toBe(45);
    await waitFor(() => expect(screen.queryByTestId('draft-note')).toBeNull());

    fireEvent.change(wrapup(), { target: { value: '60' } });
    expect(screen.getByTestId('draft-note').textContent).toBe(
      'Some changes are not saved yet. They reach the campaign only when you click Save as draft or Start campaign.',
    );
  });

  it('does not talk of customers when the draft has none: a save whose settings were refused', async () => {
    mocks.updateAgencyCampaign.mockRejectedValueOnce(
      Object.assign(new Error('Validation Error'), {
        statusCode: 400,
        details: { details: { wrapup_seconds: 'Wrap-up is 0–600 seconds.' } },
      }),
    );
    await renderPage();
    fillBasics();
    goToStep('Agents & timing');
    fireEvent.change(wrapup(), { target: { value: '45' } });
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());

    expect(await screen.findByTestId('draft-note')).toBeTruthy();
    expect(screen.getByTestId('draft-note').textContent).toBe(
      'A draft of this campaign exists, but your settings are not saved yet. They reach the draft only when you click Save as draft or Start campaign.',
    );
    // The refusal is on its field, on the step that has it.
    expect(currentStep()).toBe('agents');
    expect(screen.getByText('Wrap-up is 0–600 seconds.')).toBeTruthy();
  });
});

/*
  CS10: the agents ticked on Agents & timing are staffed when a save goes through (the draft
  must exist first), through the assignment routes the campaign page uses.
*/
describe('staffing on save', () => {
  it('staffs the ticked agents once the draft exists and holds the settings', async () => {
    mocks.applyStaffing.mockResolvedValue(applied({ added: ['u-asha', 'u-ravi'] }));
    await renderPage();
    fillBasics();
    goToStep('Agents & timing');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Asha Rao' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ravi Kumar' }));
    fireEvent.click(saveDraftButton());

    await waitFor(() => expect(mocks.applyStaffing).toHaveBeenCalledWith('camp-1', ['u-asha', 'u-ravi']));
    expect(mocks.createAgencyCampaign.mock.invocationCallOrder[0]!).toBeLessThan(mocks.updateAgencyCampaign.mock.invocationCallOrder[0]!);
    expect(mocks.updateAgencyCampaign.mock.invocationCallOrder[0]!).toBeLessThan(mocks.applyStaffing.mock.invocationCallOrder[0]!);
    expect(await screen.findByText('Saved as a draft.', { exact: false })).toBeTruthy();
    expect(screen.queryByTestId('staffing-error')).toBeNull();
  });

  it('staffs nobody when a save is refused', async () => {
    mocks.updateAgencyCampaign.mockRejectedValueOnce(
      Object.assign(new Error('Validation Error'), { statusCode: 400, details: { details: { wrapup_seconds: 'Wrap-up is 0–600 seconds.' } } }),
    );
    await renderPage();
    fillBasics();
    goToStep('Agents & timing');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Asha Rao' }));
    fireEvent.click(saveDraftButton());
    await screen.findByText('Wrap-up is 0–600 seconds.');
    expect(mocks.applyStaffing).not.toHaveBeenCalled();
  });

  it('says who could not be staffed, keeps the save, and still counts that tick as unsaved', async () => {
    mocks.applyStaffing.mockResolvedValue(applied({
      added: ['u-asha'],
      failures: [{ userId: 'u-ravi', name: 'Ravi Kumar', action: 'add', message: 'Not allowed.' }],
    }));
    await renderPage();
    fillBasics();
    goToStep('Agents & timing');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Asha Rao' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ravi Kumar' }));
    fireEvent.click(saveDraftButton());

    const alert = await screen.findByTestId('staffing-error');
    expect(alert.textContent).toBe('Could not add Ravi Kumar to this campaign.');
    expect(screen.getByText('Saved as a draft.', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(screen.getByRole('dialog', { name: 'Leave without saving?' })).toBeTruthy();
  });
});

describe('the Ready line (CS15)', () => {
  it('counts the customers added, the agents ticked, the hours and the days', async () => {
    await reachCheck();
    await addChecked();
    await waitFor(() => expect(currentStep()).toBe('purpose'));
    goToStep('Agents & timing');
    expect(screen.getByTestId('ready-line').textContent).toBe('Ready: 3 customers · no agents · 9 AM – 8 PM · 5 days a week');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Asha Rao' }));
    fireEvent.click(screen.getByRole('radio', { name: '9 AM – 6 PM' }));
    expect(screen.getByTestId('ready-line').textContent).toBe('Ready: 3 customers · 1 agent · 9 AM – 6 PM · 5 days a week');
  });
});

/*
  CS15: Start campaign saves (creating the draft if need be), staffs, then starts. A step that
  fails stops the rest, the draft stays saved, and the refusal is said in words with a link to
  the campaign. Started, the page opens the campaign.
*/
describe('Start campaign', () => {
  const startButton = () => footerButton('Start campaign');

  /** Customers added, on Agents & timing with Asha ticked. */
  async function readyToStart() {
    await reachCheck();
    await addChecked();
    await waitFor(() => expect(currentStep()).toBe('purpose'));
    goToStep('Agents & timing');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Asha Rao' }));
  }

  it('is green, beside Save as draft, and held with its reason until customers are added', async () => {
    await renderPage();
    fillBasics();
    goToStep('Agents & timing');
    expect(startButton().className).toContain('btn-primary');
    expect(startButton().className).toMatch(/start/);
    expect(startButton().disabled).toBe(true);
    expect(screen.getByTestId('start-reason').textContent).toBe(
      'Add customers on the Customers step first: a campaign with no customers cannot start. You can save it as a draft now.',
    );
    expect(startButton().getAttribute('aria-describedby')).toBe(screen.getByTestId('start-reason').id);
    // Saving as a draft is still open.
    expect(saveDraftButton().disabled).toBe(false);
  });

  it('saves, staffs, then starts, in that order, and opens the campaign', async () => {
    mocks.applyStaffing.mockResolvedValue(applied({ added: ['u-asha'] }));
    mocks.transitionAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'running' });
    await readyToStart();
    expect(startButton().disabled).toBe(false);
    fireEvent.click(startButton());

    expect(await screen.findByText('Campaign page camp-1')).toBeTruthy();
    expect(mocks.transitionAgencyCampaign).toHaveBeenCalledWith('camp-1', 'start', 't1', 'a1');
    const save = mocks.updateAgencyCampaign.mock.invocationCallOrder.at(-1)!;
    const staff = mocks.applyStaffing.mock.invocationCallOrder[0]!;
    const start = mocks.transitionAgencyCampaign.mock.invocationCallOrder[0]!;
    expect(save).toBeLessThan(staff);
    expect(staff).toBeLessThan(start);
    expect(mocks.applyStaffing).toHaveBeenCalledWith('camp-1', ['u-asha']);
    // The draft the import made is the one saved and started; no second campaign.
    expect(mocks.createAgencyCampaign).toHaveBeenCalledTimes(1);
    // Nothing unsaved was left to ask about on the way out.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says a refused start in the server’s words, with a link to the draft, and stays', async () => {
    mocks.transitionAgencyCampaign.mockRejectedValue(new ApiError(409, {
      error: 'Not Dialable',
      code: 'campaign_no_caller_ids',
      message: 'None of this campaign’s caller IDs is available any more. Pick another number in its settings.',
    }));
    await readyToStart();
    fireEvent.click(startButton());

    const refusal = await screen.findByTestId('start-refusal');
    expect(refusal.textContent).toContain(
      'None of this campaign’s caller IDs is available any more. Pick another number in its settings. The campaign is saved as a draft and has not started.',
    );
    expect(refusal.textContent).not.toContain('campaign_no_caller_ids');
    expect(within(refusal).getByRole('link', { name: 'Open the campaign' }).getAttribute('href')).toBe('/agency/campaigns/camp-1');
    expect(currentStep()).toBe('agents');
    // The draft was saved and staffed before the start was asked for.
    expect(mocks.updateAgencyCampaign).toHaveBeenCalled();
    expect(mocks.applyStaffing).toHaveBeenCalled();
    expect(startButton().disabled).toBe(false);
  });

  it('says a carrier refusal in the console’s own sentence, never its code', async () => {
    mocks.transitionAgencyCampaign.mockRejectedValue(new ApiError(409, {
      error: 'Conflict',
      code: 'telephony_credential_not_active',
      message: 'telephony_credential_not_active',
    }));
    await readyToStart();
    fireEvent.click(startButton());

    const refusal = await screen.findByTestId('start-refusal');
    expect(refusal.textContent).toMatch(/carrier account is not active/);
    expect(refusal.textContent).not.toContain('telephony_credential_not_active');
  });

  it('does not start when staffing partly fails: says who, and that the draft is saved', async () => {
    mocks.applyStaffing.mockResolvedValue(applied({
      added: [],
      failures: [{ userId: 'u-asha', name: 'Asha Rao', action: 'add', message: 'Not allowed.' }],
    }));
    await readyToStart();
    fireEvent.click(startButton());

    const refusal = await screen.findByTestId('start-refusal');
    expect(refusal.textContent).toContain('Could not add Asha Rao to this campaign. The campaign is saved as a draft and has not started.');
    expect(within(refusal).getByRole('link', { name: 'Open the campaign' })).toBeTruthy();
    expect(mocks.transitionAgencyCampaign).not.toHaveBeenCalled();
    // Said once, in the refusal, not again as the staffing line.
    expect(screen.queryByTestId('staffing-error')).toBeNull();
  });

  it('neither staffs nor starts when the save is refused', async () => {
    mocks.updateAgencyCampaign.mockRejectedValueOnce(
      Object.assign(new Error('Validation Error'), { statusCode: 400, details: { details: { wrapup_seconds: 'Wrap-up is 0–600 seconds.' } } }),
    );
    await readyToStart();
    fireEvent.click(startButton());
    await screen.findByText('Wrap-up is 0–600 seconds.');
    expect(mocks.applyStaffing).not.toHaveBeenCalled();
    expect(mocks.transitionAgencyCampaign).not.toHaveBeenCalled();
    expect(screen.queryByTestId('start-refusal')).toBeNull();
  });

  it('sends one start for a double click', async () => {
    mocks.transitionAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'running' });
    await readyToStart();
    const button = startButton();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByText('Campaign page camp-1')).toBeTruthy();
    expect(mocks.transitionAgencyCampaign).toHaveBeenCalledTimes(1);
    expect(mocks.updateAgencyCampaign.mock.calls.filter((call) => 'disposition_catalog' in (call[1] as object))).toHaveLength(1);
  });
});
