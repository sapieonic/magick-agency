import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import {
  applied,
  currentStep,
  fillBasics,
  footer,
  footerButton,
  goToStep,
  renderPage,
  saveDraftButton,
  stepCard,
  staffingHook,
} from './campaignBuilderFixtures';

/**
 * New campaign's path at the PAGE level (CS1): the four step cards, one step on screen at a
 * time, the footer that moves between them, and the leave guard. Whether an operator can walk
 * one decision at a time, skip what they do not have yet, and jump back without losing what they
 * typed. The upload, config and Start contracts live in the sibling page tests.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getIngestLimits: vi.fn(),
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  createAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  transitionAgencyCampaign: vi.fn(),
  applyStaffing: vi.fn(),
  trackStepViewed: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({
  // The recording field reads the account's capabilities; allowed here.
  useGovernance: () => ({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() }),
}));
vi.mock('../../analytics/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../analytics/events')>()),
  trackAgencyCampaignBuilderStepViewed: mocks.trackStepViewed,
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
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  downloadSkippedRows: vi.fn(),
  importCheckedFile: vi.fn(),
  createAgencyCampaign: mocks.createAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
  transitionAgencyCampaign: mocks.transitionAgencyCampaign,
}));

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
  mocks.applyStaffing.mockResolvedValue(applied());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the page', () => {
  it('says what it is, how long it takes, and offers a way out', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'New campaign' })).toBeTruthy();
    expect(screen.getByText('4 short steps · you can come back to any step')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Campaigns list')).toBeTruthy();
  });

  it('has no Review step and no summary rail: four step cards, and only the current step', async () => {
    await renderPage();
    const cards = within(screen.getByRole('navigation', { name: 'Campaign setup' })).getAllByRole('button');
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual([
      'Name & number',
      'Customers',
      'Purpose & buttons',
      'Agents & timing',
    ]);
    expect(screen.queryByLabelText('Campaign summary')).toBeNull();
    expect(screen.queryByText(/Review/)).toBeNull();
    expect(screen.getByTestId('name-number-step')).toBeTruthy();
    expect(screen.queryByTestId('customers-step')).toBeNull();
  });
});

describe('the guided setup path', () => {
  it('opens on Name & number, and keeps later steps closed until those exist', async () => {
    await renderPage();

    expect(currentStep()).toBe('basics');
    expect(screen.getByLabelText(/Campaign name/)).toBeTruthy();
    expect(stepCard('Customers').disabled).toBe(true);
    expect(stepCard('Agents & timing').disabled).toBe(true);
    expect(footerButton('Continue')).toBeTruthy();
    // Nothing to go back to on the first step.
    expect(footer().queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('names the missing basic on Continue rather than failing later at upload', async () => {
    await renderPage();
    expect(footer().getByText('Name the campaign first.')).toBeTruthy();
    expect(footerButton('Continue').disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Collections' } });
    expect(footer().getByText('Pick at least one number to call from.')).toBeTruthy();
  });

  it('unlocks the rest of the path once basics are filled, and Continue advances', async () => {
    await renderPage();
    fillBasics();

    expect(stepCard('Customers').disabled).toBe(false);
    fireEvent.click(footerButton('Continue'));
    expect(currentStep()).toBe('contacts');
    expect(screen.getByLabelText('Excel or CSV file')).toBeTruthy();
    expect(stepCard('Customers').getAttribute('aria-current')).toBe('step');
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
    goToStep('Customers');

    const dropzone = screen.getByTestId('contacts-dropzone');
    const first = new File(['phone\n+912200000001\n'], 'first.csv', { type: 'text/csv' });
    const second = new File(['phone\n+912200000002\n'], 'second.csv', { type: 'text/csv' });

    fireEvent.dragOver(dropzone);
    expect(dropzone.getAttribute('data-drag-over')).toBe('true');

    fireEvent.change(screen.getByLabelText('Excel or CSV file'), { target: { files: [first] } });

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

  it('moves focus to the new step’s heading after navigation, and reports the step by its id', async () => {
    await renderPage();
    fillBasics();
    goToStep('Customers');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Customers' }));
    expect(mocks.trackStepViewed).toHaveBeenLastCalledWith({ step: 'contacts', step_index: 1 });

    fireEvent.click(footerButton('Skip for now'));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'What is this campaign for?' }));
    expect(mocks.trackStepViewed).toHaveBeenLastCalledWith({ step: 'purpose', step_index: 2 });

    fireEvent.click(footerButton('Continue'));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Who will call' }));
    expect(mocks.trackStepViewed).toHaveBeenLastCalledWith({ step: 'agents', step_index: 3 });
  });

  it('lets an operator skip customers and reach the last step, whose footer reads Ready', async () => {
    await renderPage();
    fillBasics();
    fireEvent.click(footerButton('Continue'));
    fireEvent.click(footerButton('Skip for now'));
    expect(currentStep()).toBe('purpose');
    expect(footerButton('Back')).toBeTruthy();

    fireEvent.click(footerButton('Continue'));
    expect(currentStep()).toBe('agents');
    // No Continue on the last step: Ready, Save as draft and Start.
    expect(footer().queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getByTestId('ready-line').textContent).toBe('Ready: no agents · 9 AM – 8 PM · 5 days a week');
    expect(saveDraftButton()).toBeTruthy();
    expect(footerButton('Start campaign')).toBeTruthy();

    fireEvent.click(footerButton('Back'));
    expect(currentStep()).toBe('purpose');
  });

  it('keeps typed values when jumping back from a later step', async () => {
    await renderPage();
    fillBasics('August collections');
    goToStep('Agents & timing');
    expect(currentStep()).toBe('agents');

    goToStep('Name & number');
    expect((screen.getByLabelText(/Campaign name/) as HTMLInputElement).value).toBe('August collections');
  });

  it('saves as a draft from any step and offers a way into it', async () => {
    await renderPage();
    fillBasics();
    expect(saveDraftButton().className).toContain('btn-secondary');
    fireEvent.click(saveDraftButton());

    await waitFor(() => expect(mocks.createAgencyCampaign).toHaveBeenCalled());
    expect(await screen.findByRole('link', { name: 'Open campaign' })).toBeTruthy();
    expect(screen.getByText('Saved as a draft.', { exact: false })).toBeTruthy();
  });
});

describe('the footer on a phone', () => {
  /** The body of the block opened by `head`, braces balanced. */
  function block(css: string, head: string): string {
    const at = css.indexOf(`${head} {`);
    if (at < 0) throw new Error(`no block ${head}`);
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
    }
    throw new Error(`unbalanced block ${head}`);
  }

  /*
    happy-dom applies no stylesheet and no container query, so the rule is read from the sheet:
    the rows wrap, the Ready line takes its own row, and the buttons fill theirs at a finger's
    height.
  */
  it('wraps cleanly: the Ready line on its own row, the buttons filling theirs', () => {
    const css = readFileSync(resolve(__dirname, '../../pages/campaigns/agency/CampaignBuilderPage.module.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(block(css, '.footerMain')).toMatch(/flex-wrap:\s*wrap;/);
    expect(block(css, '.actions')).toMatch(/flex-wrap:\s*wrap;/);
    const phone = block(css, '@container builder (max-width: 560px)');
    expect(block(phone, '.ready')).toMatch(/flex-basis:\s*100%;/);
    expect(block(phone, '.footerMain > button,\n  .actions > button')).toMatch(/min-height:\s*44px;/);
  });
});

/**
 * The builder guards what has been typed, as campaign Settings does: leaving with input not
 * yet saved asks first, and nothing is held once it is saved or while the form is untouched.
 */
describe('leaving the builder', () => {
  const dialog = () => screen.getByRole('dialog', { name: 'Leave without saving?' });

  it('lets an untouched builder go at once', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(screen.getByText('Campaigns list')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before leaving what has been typed, from the page’s own Cancel too; Cancel in the dialog keeps it', async () => {
    await renderPage();
    fillBasics('Renewals');

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(dialog()).toBeTruthy();
    expect(screen.getByText(/new campaign is not saved/)).toBeTruthy();

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText(/Campaign name/) as HTMLInputElement).value).toBe('Renewals');

    // The header's Cancel is a way out like any other.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dialog()).toBeTruthy();
  });

  it('leaves on "Leave without saving"', async () => {
    await renderPage();
    fillBasics('Renewals');
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave without saving' }));
    expect(screen.getByText('Campaigns list')).toBeTruthy();
  });

  it('counts a setting changed on a later step, and nothing once all is put back', async () => {
    await renderPage();
    fillBasics('Renewals');
    goToStep('Agents & timing');
    fireEvent.click(screen.getByRole('radio', { name: '9 AM – 6 PM' }));
    // The basics put back as they were: only the calling window differs now.
    goToStep('Name & number');
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '+91 22000 00001' }));

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(dialog()).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    fillBasics('Renewals');
    goToStep('Agents & timing');
    fireEvent.click(screen.getByRole('radio', { name: '9 AM – 8 PM' }));
    goToStep('Name & number');
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '+91 22000 00001' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Campaigns list')).toBeTruthy();
  });

  it('counts an agent ticked and not yet saved', async () => {
    await renderPage();
    fillBasics('Renewals');
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(screen.getByText('Saved as a draft.', { exact: false })).toBeTruthy());
    goToStep('Agents & timing');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Asha Rao' }));

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(dialog()).toBeTruthy();
  });

  it('holds nothing once the campaign is saved, settings and all', async () => {
    await renderPage();
    fillBasics('Renewals');
    goToStep('Agents & timing');
    fireEvent.click(screen.getByRole('radio', { name: '9 AM – 6 PM' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Asha Rao' }));
    mocks.applyStaffing.mockResolvedValue(applied({ added: ['u-asha'] }));
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(screen.getByText('Saved as a draft.', { exact: false })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Campaigns list')).toBeTruthy();
  });
});
