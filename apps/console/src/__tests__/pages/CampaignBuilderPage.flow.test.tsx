import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

/**
 * The guided create path, at the PAGE level.
 *
 * These assertions are about sequence and orientation — can an operator walk
 * one decision at a time, skip what they do not have yet, and jump back
 * without losing what they already typed. The mapping/ingest/config contracts
 * live in the sibling page tests.
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
vi.mock('../../contexts/GovernanceContext', () => ({
  // The recording field reads the account's capabilities; allowed here.
  useGovernance: () => ({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() }),
}));
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

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
  mocks.getIngestLimits.mockResolvedValue({
    max_rows: 1_000_000,
    max_columns: 50,
    max_cell_bytes: 4096,
    max_file_bytes: 512 * 1024 * 1024,
  });
  mocks.createAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
  mocks.updateAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the guided setup path', () => {
  it('opens on name and numbers, and keeps later steps closed until those exist', async () => {
    await renderPage();

    expect(screen.getByTestId('builder-step').getAttribute('data-step')).toBe('basics');
    expect(screen.getByLabelText(/Campaign name/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Who to call' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Review & save' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('names the missing basic on Continue rather than failing later at upload', async () => {
    await renderPage();
    expect(screen.getByText('Name the campaign first.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Collections' } });
    expect(screen.getByText('Pick at least one number to call from.')).toBeTruthy();
  });

  it('keeps the summary rail to a short hours line, not the full echo', async () => {
    await renderPage();
    const rail = screen.getByLabelText('Campaign summary');
    expect(rail.textContent).toContain('Mon–Fri · 09:00–20:00 · Asia/Kolkata');
    expect(rail.textContent).not.toContain('Right now');
  });

  it('unlocks the rest of the path once basics are filled, and Continue advances', async () => {
    await renderPage();
    fillBasics();

    expect((screen.getByRole('button', { name: 'Who to call' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByTestId('builder-step').getAttribute('data-step')).toBe('contacts');
    expect(screen.getByLabelText('CSV file')).toBeTruthy();
  });

  it('clears drag feedback and accepts only one file while upload is busy', async () => {
    mocks.uploadRosterCsv.mockImplementation(
      () => new Promise(() => {
        // Keep the first upload in flight. A second drop/change must be ignored
        // before the API promise has a chance to settle.
      }),
    );

    await renderPage();
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Who to call' }));

    const dropzone = screen.getByTestId('contacts-dropzone');
    const first = new File(['phone\n+912200000001\n'], 'first.csv', { type: 'text/csv' });
    const second = new File(['phone\n+912200000002\n'], 'second.csv', { type: 'text/csv' });

    fireEvent.dragOver(dropzone);
    expect(dropzone.getAttribute('data-drag-over')).toBe('true');

    fireEvent.change(screen.getByLabelText('CSV file'), {
      target: { files: [first] },
    });

    await waitFor(() => {
      expect(screen.getByTestId('contacts-dropzone').getAttribute('data-drag-over')).toBeNull();
    });
    expect(mocks.uploadRosterCsv).toHaveBeenCalledTimes(1);

    const busyDropzone = screen.getByTestId('contacts-dropzone');
    fireEvent.dragOver(busyDropzone);
    expect(busyDropzone.getAttribute('data-drag-over')).toBeNull();
    fireEvent.drop(busyDropzone, { dataTransfer: { files: [second] } });
    expect(mocks.uploadRosterCsv).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the new step heading after navigation', async () => {
    await renderPage();
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Who to call' }));

    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Who to call' }),
    );
  });

  it('lets an operator skip contacts and still reach review', async () => {
    await renderPage();
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.getByTestId('builder-step').getAttribute('data-step')).toBe('hours');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByTestId('builder-step').getAttribute('data-step')).toBe('behaviour');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const review = screen.getByTestId('builder-review');
    expect(review.textContent).toContain('None imported yet — you can add a list after saving.');
    expect(review.textContent).toContain('Collections');
    expect(review.textContent).toContain('+912200000001');
  });

  it('keeps typed values when jumping back from a later step', async () => {
    await renderPage();
    fillBasics('August collections');
    fireEvent.click(screen.getByRole('button', { name: 'How agents work' }));
    expect(screen.getByTestId('builder-step').getAttribute('data-step')).toBe('behaviour');

    fireEvent.click(screen.getByRole('button', { name: 'Name & numbers' }));
    expect((screen.getByLabelText(/Campaign name/) as HTMLInputElement).value).toBe(
      'August collections',
    );
  });

  it('saves from review and offers a way into the draft', async () => {
    await renderPage();
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Review & save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save campaign' }));

    await waitFor(() => expect(mocks.createAgencyCampaign).toHaveBeenCalled());
    expect(await screen.findByRole('link', { name: 'Open campaign' })).toBeTruthy();
    expect(screen.getByText('Saved.')).toBeTruthy();
  });
});

/** Stands in for the sidebar or search: a push navigation from outside the page. */
function JumpAway() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/agency/campaigns')}>Jump</button>;
}

async function renderWithExit() {
  const { default: CampaignBuilderPage } = await import(
    '../../pages/campaigns/agency/CampaignBuilderPage'
  );
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/new']}>
      <Routes>
        <Route path="/agency/campaigns/new" element={<CampaignBuilderPage />} />
        <Route path="*" element={<p>Campaigns list</p>} />
      </Routes>
      <JumpAway />
    </MemoryRouter>,
  );
}

/**
 * The builder guards what has been typed, as campaign Settings does: leaving with input not
 * yet saved asks first, and nothing is held once it is saved or while the form is untouched.
 */
describe('leaving the builder', () => {
  it('lets an untouched builder go at once', async () => {
    await renderWithExit();
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(screen.getByText('Campaigns list')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before leaving what has been typed; Cancel keeps it', async () => {
    await renderWithExit();
    fillBasics('Renewals');

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(screen.getByRole('dialog', { name: 'Leave without saving?' })).toBeTruthy();
    expect(screen.getByText(/new campaign is not saved/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText(/Campaign name/) as HTMLInputElement).value).toBe('Renewals');
  });

  it('leaves on "Leave without saving"', async () => {
    await renderWithExit();
    fillBasics('Renewals');
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave without saving' }));
    expect(screen.getByText('Campaigns list')).toBeTruthy();
  });

  it('counts a setting changed on a later step, and nothing once all is put back', async () => {
    await renderWithExit();
    fillBasics('Renewals');
    fireEvent.click(screen.getByRole('button', { name: 'When to call' }));
    fireEvent.change(screen.getByDisplayValue('09:00'), { target: { value: '10:00' } });
    // The basics put back as they were: only the calling window differs now.
    fireEvent.click(screen.getByRole('button', { name: 'Name & numbers' }));
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /\+912200000001/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(screen.getByRole('dialog', { name: 'Leave without saving?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fillBasics('Renewals');
    fireEvent.click(screen.getByRole('button', { name: 'When to call' }));
    fireEvent.change(screen.getByDisplayValue('10:00'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Name & numbers' }));
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /\+912200000001/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Campaigns list')).toBeTruthy();
  });

  it('holds nothing once the campaign is saved, settings and all', async () => {
    await renderWithExit();
    fillBasics('Renewals');
    fireEvent.click(screen.getByRole('button', { name: 'When to call' }));
    fireEvent.change(screen.getByDisplayValue('09:00'), { target: { value: '10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save campaign' }));
    await waitFor(() => expect(screen.getByText('Saved.', { exact: false })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Campaigns list')).toBeTruthy();
  });
});
