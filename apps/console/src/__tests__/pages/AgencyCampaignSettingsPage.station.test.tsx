import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ApiError } from '../../api/client';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * The agent station's settings on a campaign's Settings page (AS6, AS9, AS19, BE-6, BE-8, BE-13):
 * What agents see (the daily target, the number display, the customer card), Script, and the
 * pictures on outcomes and break reasons. What each sends (only what changed, `null` to clear the
 * target, the card merged into the stored display with `facts` and without the old amount-due and
 * due-date roles, the card with a script that needs it), what holds Save as it is typed (a script
 * key the card does not have, a fact the stored script uses), and each server refusal on the field
 * it names.
 */

const mocks = vi.hoisted(() => ({
  transitionAgencyCampaign: vi.fn(),
  useTenant: vi.fn(),
  getAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  getIngestJob: vi.fn(),
  getInsightsUploads: vi.fn(),
  showToast: vi.fn(),
  flag: vi.fn(),
  getCampaignContacts: vi.fn(),
  getCampaignContact: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agencyInsights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agencyInsights')>()),
  getInsightsAllocation: () => new Promise(() => {}),
  getInsightsSummary: () => new Promise(() => {}),
  getInsightsUploads: mocks.getInsightsUploads,
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() }),
}));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({
  useCallAnalysisProfiles: () => ({
    profiles: [], total: 0, defaultProfile: null, loading: false, error: null, reload: vi.fn(), remove: vi.fn(),
  }),
}));
vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: [{
      phone_number_id: 'pn-1', phone_number: '+912200000001', provider_name: 'voicelink',
      provider_display_name: 'VoiceLink', label: null, is_default: true,
    }],
    loading: false, error: null, reload: vi.fn(), defaultNumber: '+912200000001',
  }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
  transitionAgencyCampaign: mocks.transitionAgencyCampaign,
  getIngestJob: mocks.getIngestJob,
  campaignLineage: async () => ({ root_campaign_id: 'camp-1', campaigns: [] }),
}));
vi.mock('../../api/agencySpine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agencySpine')>()),
  getCampaignContacts: mocks.getCampaignContacts,
  getCampaignContact: mocks.getCampaignContact,
}));
vi.mock('../../hooks/useFeatureFlagEnabled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useFeatureFlagEnabled')>()),
  useFeatureFlagEnabled: mocks.flag,
}));

import SettingsPage from '../../pages/agency/AgencyCampaignSettingsPage';
import { saveSettings } from '../helpers/settingsForm';

function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
  return {
    id: 'camp-1',
    name: 'Collections',
    status: 'running',
    calling_window_start: '10:00',
    calling_window_end: '18:00',
    calling_days: [1, 2, 3],
    default_timezone: 'Asia/Kolkata',
    wrapup_seconds: 45,
    caller_ids: ['+912200000001'],
    disposition_catalog: [{ code: 'will_pay', label: 'Will pay' }, { code: 'refused', label: 'Refused', icon: 'thumbs_down' }],
    retry_policy: {},
    break_reasons: [],
    context_display: { hero: ['Due Amount'], hidden: ['PAN'] },
    // As the server sends it: null on a campaign that is not a retry.
    root_campaign_id: null,
    ...over,
  };
}

function upload(jobId: string, createdAt: string, status = 'completed') {
  return {
    job_id: jobId, file_name: 'list.csv', uploaded_by: null, created_at: createdAt, finished_at: createdAt, status, mode: 'append',
    rows_read: 1, accepted: 1, rejected: 0, skipped: 0, rejected_by_reason: {}, duplicates: 0, dedupe_columns: [], has_rejected_export: false,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/camp-1/settings']}>
      <Routes>
        <Route path="/agency/campaigns/:id/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flag.mockReturnValue(false);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' });
  mocks.getAgencyCampaign.mockResolvedValue(campaign());
  mocks.updateAgencyCampaign.mockImplementation(async (_id, body) => campaign(body));
  mocks.getInsightsUploads.mockResolvedValue({
    campaign_id: 'camp-1',
    uploads: [upload('job-old', '2026-11-01T10:00:00Z'), upload('job-new', '2026-11-10T10:00:00Z'), upload('job-failed', '2026-11-12T10:00:00Z', 'failed')],
    generated_at: '2026-11-20T10:00:00Z',
  });
  mocks.getIngestJob.mockImplementation(async (id: string) => ({
    id,
    context_columns: id === 'job-new' ? ['Borrower', 'City', 'Due Amount', 'PAN'] : ['Borrower', 'Due Date'],
  }));
  mocks.getCampaignContacts.mockResolvedValue({ rows: [{ id: 'ct-1' }, { id: 'ct-2' }], next_cursor: null, limit: 3 });
  mocks.getCampaignContact.mockImplementation(async (_campaign: string, contactId: string) => ({
    id: contactId,
    context: contactId === 'ct-1'
      ? { Borrower: 'Lakshmi Narayana', City: 'Pune', 'Due Amount': '125000', 'Due Date': '20/11/2026' }
      : { Borrower: 'Ravi', City: 'Nashik', 'Due Amount': '', 'Due Date': '' },
  }));
});

afterEach(() => cleanup());

const sentBody = () => mocks.updateAgencyCampaign.mock.calls[0]![1] as Record<string, unknown>;
const target = () => screen.getByTestId('daily-target') as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
const refusal = (details: Record<string, string>) =>
  new ApiError(400, { error: 'Bad Request', code: 'validation_failed', message: 'Invalid campaign config', details });

describe('Settings › What agents see: the daily target (AS6)', () => {
  it('sends a typed target, and nothing about the station when nothing of it changed', async () => {
    renderPage();
    await screen.findByTestId('daily-target');
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    for (const key of ['daily_target_calls', 'phone_display', 'agent_script', 'context_display']) {
      expect(sentBody()).not.toHaveProperty(key);
    }
    cleanup();
    vi.clearAllMocks();
    mocks.updateAgencyCampaign.mockImplementation(async (_id, body) => campaign(body));
    renderPage();
    await screen.findByTestId('daily-target');
    fireEvent.change(target(), { target: { value: '60' } });
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({ daily_target_calls: 60 });
  });

  it('clears a stored target with null', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ daily_target_calls: 40 }));
    renderPage();
    await screen.findByTestId('daily-target');
    expect(target().value).toBe('40');
    fireEvent.change(target(), { target: { value: '' } });
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody().daily_target_calls).toBeNull();
  });

  it('holds Save on a target out of 1 to 2,000, said on the field', async () => {
    renderPage();
    await screen.findByTestId('daily-target');
    fireEvent.change(target(), { target: { value: '2001' } });
    expect(await screen.findByText(/Enter a whole number of calls from 1 to 2,000/)).toBeTruthy();
    expect(target().getAttribute('aria-invalid')).toBe('true');
    save();
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal on the field', async () => {
    mocks.updateAgencyCampaign.mockRejectedValue(refusal({ daily_target_calls: 'Daily target must be a whole number from 1 to 2,000. Leave it empty for no target.' }));
    renderPage();
    await screen.findByTestId('daily-target');
    fireEvent.change(target(), { target: { value: '50' } });
    save();
    const message = await screen.findByText(/Leave it empty for no target/);
    expect(target().getAttribute('aria-describedby')).toContain(message.closest('p')!.id);
  });
});

describe('Settings › What agents see: the customer’s number (AS9)', () => {
  it('previews both, and sends masked when chosen', async () => {
    renderPage();
    await screen.findByTestId('phone-display-full');
    // One word for each choice, as the activity log says it (never "Masked").
    expect(screen.getByRole('radio', { name: /^Full number/ })).toBe(screen.getByTestId('phone-display-full'));
    expect(screen.getByRole('radio', { name: /^Hidden number/ })).toBe(screen.getByTestId('phone-display-masked'));
    expect(screen.getByTestId('phone-display-masked').closest('fieldset')!.textContent).not.toMatch(/mask/i);
    expect(screen.getByTestId('phone-display-preview-masked').textContent).toBe('98••• ••321');
    expect(screen.getByTestId('phone-display-preview-full').textContent).toBe('+91 98765 43321');
    expect((screen.getByTestId('phone-display-full') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('phone-display-masked'));
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({ phone_display: 'masked' });
  });
});

/** The card's rows, once the roster's columns have opened it. */
const factRows = () => within(screen.getByTestId('fact-rows')).queryAllByRole('listitem');
const factKeys = () => factRows().map((row) => row.querySelector('code')!.textContent);
/** Waits for the columns' read to open the card (an old-model campaign's pre-fill needs them). */
async function cardReady() {
  const name = await screen.findByTestId('fact-role-name');
  await waitFor(() => expect(within(name).queryByRole('option', { name: 'City' })).not.toBeNull());
  return name as HTMLSelectElement;
}

describe('Settings › Script (BE-8, AS19)', () => {
  it('adds steps, inserts a key at the caret of the field last typed in, counts, and sends it trimmed', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ context_display: { facts: [{ column: 'Due Amount', label: 'Amount due', key: 'amount_due' }], hidden: ['PAN'] } }));
    renderPage();
    await cardReady();
    const opening = screen.getByTestId('script-opening') as HTMLTextAreaElement;
    fireEvent.focus(opening);
    fireEvent.change(opening, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('script-chip-name'));
    expect(opening.value).toBe('Hello {name}');
    fireEvent.click(screen.getByTestId('script-add-step'));
    const step = screen.getByTestId('script-step-0') as HTMLTextAreaElement;
    fireEvent.focus(step);
    fireEvent.change(step, { target: { value: 'You owe today' } });
    step.setSelectionRange(8, 8);
    fireEvent.click(screen.getByTestId('script-chip-amount_due'));
    expect(step.value).toBe('You owe {amount_due} today');
    expect(within(screen.getByTestId('script-editor')).getByText('26 / 200')).toBeTruthy();
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody().agent_script).toEqual({ opening: 'Hello {name}', steps: [{ text: 'You owe {amount_due} today' }] });
    // The card did not change and the stored one allows every key: it is not sent.
    expect(sentBody()).not.toHaveProperty('context_display');
    expect(mocks.showToast).toHaveBeenCalledWith('Saved. Agents see this from their next call.', 'success');
  });

  it('stops at twelve steps', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ agent_script: { steps: Array.from({ length: 12 }, (_, i) => ({ text: `S${i}` })) } }));
    renderPage();
    const add = await screen.findByTestId('script-add-step') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByText('A script can have at most 12 steps.')).toBeTruthy();
  });

  it('holds Save on a key the card has no fact for, said on its step as the server says it', async () => {
    renderPage();
    await cardReady();
    fireEvent.click(screen.getByTestId('script-add-step'));
    fireEvent.change(screen.getByTestId('script-step-0'), { target: { value: 'Hi {Name} from {branch_office}' } });
    expect(await screen.findByText('The script uses {Name} and {branch_office}, which are not facts on the card. Add them as facts or take them out.')).toBeTruthy();
    save();
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('“Add as a fact” puts the column on the card, and the script and the card go in one save', async () => {
    renderPage();
    await cardReady();
    const opening = screen.getByTestId('script-opening') as HTMLTextAreaElement;
    fireEvent.change(opening, { target: { value: 'Calling from {Borrower}' } });
    fireEvent.click(await screen.findByTestId('script-fix-opening-Borrower-add'));
    // `Borrower` cannot be a key as written: the fact gets the default key, and the script follows it.
    expect(opening.value).toBe('Calling from {borrower}');
    expect(factKeys()).toEqual(['{due_amount}', '{borrower}']);
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody().agent_script).toEqual({ opening: 'Calling from {borrower}' });
    expect((sentBody().context_display as Record<string, unknown>).facts).toEqual([
      { column: 'Due Amount', label: 'Due Amount', key: 'due_amount' },
      { column: 'Borrower', label: 'Borrower', key: 'borrower' },
    ]);
  });

  it('reads the script with a sample customer, a missing value as “not given”', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      agent_script: { opening: 'Namaste {name}, {due_amount} is due.' },
      context_display: { roles: { name: 'Borrower' }, facts: [{ column: 'Due Amount', label: 'Amount due', key: 'due_amount' }], types: { 'Due Amount': 'money' } },
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId('script-preview-opening').textContent).toBe('Namaste Lakshmi Narayana, ₹1,25,000 is due.'));
    fireEvent.click(screen.getByRole('button', { name: 'Next sample customer' }));
    expect(screen.getByTestId('script-preview-opening').textContent).toBe('Namaste Ravi, Amount due not given is due.');
  });

  it('shows the server’s refusal on the opening line and on the step it names', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ agent_script: { opening: 'Hi', steps: [{ text: 'A' }, { text: 'B' }] } }));
    mocks.updateAgencyCampaign.mockRejectedValue(refusal({
      'agent_script.opening': 'The opening line is refused here.',
      'agent_script.steps[1].text': 'Step 2 is refused here.',
    }));
    renderPage();
    const second = await screen.findByTestId('script-step-1');
    fireEvent.change(second, { target: { value: 'B2' } });
    save();
    const stepMessage = await screen.findByText('Step 2 is refused here.');
    expect(second.getAttribute('aria-describedby')).toContain(stepMessage.closest('p')!.id);
    const openingMessage = screen.getByText('The opening line is refused here.');
    expect(screen.getByTestId('script-opening').getAttribute('aria-describedby')).toContain(openingMessage.closest('p')!.id);
  });
});

describe('Settings › What agents see: the customer card (AS19)', () => {
  it('offers the newest completed imports’ columns, hidden ones left out', async () => {
    renderPage();
    const name = await cardReady();
    const offered = within(name).getAllByRole('option').map((o) => o.textContent);
    expect(offered).toEqual(['Guess from the column names', 'Borrower', 'City', 'Due Amount', 'Due Date']);
    expect(mocks.getIngestJob).toHaveBeenCalledTimes(2);
    expect(mocks.getIngestJob.mock.calls.map((c) => c[0])).toEqual(['job-new', 'job-old']);
    // The add-fact picker: not the guessed line under the name, not a fact already on the card; a sample beside each.
    fireEvent.click(screen.getByTestId('fact-add'));
    const picker = screen.getByTestId('fact-picker');
    expect(within(picker).getAllByRole('button').map((b) => b.querySelector('b')!.textContent)).toEqual(['Borrower', 'Due Date']);
    await waitFor(() => expect(within(screen.getByTestId('fact-pick-Borrower')).getByText('e.g. Lakshmi Narayana')).toBeTruthy());
  });

  it('opens a campaign saved before AS19 with what its agents see today, and sends nothing until the card changes', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      context_display: { hero: ['Due Amount'], hidden: ['PAN'], roles: { name: 'Borrower', amount_due: 'Due Amount', due_date: 'Due Date' } },
    }));
    renderPage();
    await cardReady();
    await waitFor(() => expect(factKeys()).toEqual(['{amount_due}', '{due_date}']));
    expect(factRows().map((r) => (within(r).getByRole('textbox') as HTMLInputElement).value)).toEqual(['Due Amount', 'Due Date']);
    // The pre-fill is not a change: the bar stays away, and a save of something else sends no card.
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();
    fireEvent.change(target(), { target: { value: '25' } });
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()).not.toHaveProperty('context_display');
  });

  it('opens the old-model card again once the columns arrive, leaving out the column the card guesses as the line under the name', async () => {
    // Before the columns are read, `City` is just a hero; with them, it is the line under the name.
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ context_display: { hero: ['City', 'Due Amount'], hidden: ['PAN'] } }));
    renderPage();
    await cardReady();
    await waitFor(() => expect(factKeys()).toEqual(['{due_amount}']));
    // Still no change to save.
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();
  });

  it('saves the card as facts, the old amount and due-date roles dropped and their columns read as money and a date', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      context_display: { hero: ['Due Amount'], hidden: ['PAN'], roles: { name: 'Borrower', amount_due: 'Due Amount', due_date: 'Due Date' } },
    }));
    renderPage();
    await cardReady();
    await waitFor(() => expect(factKeys()).toEqual(['{amount_due}', '{due_date}']));
    fireEvent.change(screen.getByTestId('fact-label-0'), { target: { value: 'Amount due' } });
    fireEvent.click(screen.getByTestId('fact-highlight-1'));
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody().context_display).toEqual({
      hero: ['Due Amount'],
      hidden: ['PAN'],
      roles: { name: 'Borrower' },
      types: { 'Due Amount': 'money', 'Due Date': 'date' },
      facts: [
        { column: 'Due Date', label: 'Due Date', key: 'due_date', highlight: true },
        { column: 'Due Amount', label: 'Amount due', key: 'amount_due' },
      ],
    });
    expect(mocks.showToast).toHaveBeenCalledWith('Saved. Agents see this from their next call.', 'success');
  });

  it('holds Save while a fact the script uses is off the card, and “Put it back” restores it', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      agent_script: { opening: 'Pay by {due_date}' },
      context_display: { facts: [{ column: 'Due Amount', label: 'Amount', key: 'amount_due' }, { column: 'Due Date', label: 'Due date', key: 'due_date' }] },
    }));
    renderPage();
    await cardReady();
    fireEvent.click(screen.getByTestId('fact-remove-1'));
    const held = await screen.findAllByText('The script uses {due_date}. Take it out of the script first, or keep the fact.');
    expect(held.length).toBeGreaterThan(0);
    save();
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByTestId('fact-put-back-due_date')).getByRole('button', { name: 'Put ‘Due date’ back' }));
    expect(factKeys()).toEqual(['{amount_due}', '{due_date}']);
    expect(screen.queryByText(/Take it out of the script first/)).toBeNull();
  });

  it('removes a fact and its key from the script in one save, which the server checks as a pair', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      agent_script: { opening: 'Pay by {due_date}' },
      context_display: { facts: [{ column: 'Due Amount', label: 'Amount', key: 'amount_due' }, { column: 'Due Date', label: 'Due date', key: 'due_date' }] },
    }));
    renderPage();
    await cardReady();
    fireEvent.click(screen.getByTestId('fact-remove-1'));
    fireEvent.click(await screen.findByTestId('script-fix-opening-due_date-remove'));
    expect((screen.getByTestId('script-opening') as HTMLTextAreaElement).value).toBe('Pay by');
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody().agent_script).toEqual({ opening: 'Pay by' });
    expect((sentBody().context_display as Record<string, unknown>).facts).toEqual([{ column: 'Due Amount', label: 'Amount', key: 'amount_due' }]);
  });

  it('reads the columns once, after the campaign loads, and a retry campaign’s one read names its root', async () => {
    /** The columns' reads of the upload history (the page's history section reads it too, for camp-1). */
    const uploadReads = (campaignId: string) => mocks.getInsightsUploads.mock.calls.filter((c) => c[0] === campaignId).length;
    const settle = async () => {
      await cardReady();
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    };

    renderPage();
    await settle();
    const history = 1;
    expect(uploadReads('camp-1')).toBe(1 + history);
    expect(mocks.getIngestJob).toHaveBeenCalledTimes(2);
    expect(mocks.getCampaignContacts).toHaveBeenCalledTimes(1);

    cleanup();
    vi.clearAllMocks();
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ root_campaign_id: 'camp-root' }));
    mocks.getInsightsUploads.mockImplementation(async (campaignId: string) => ({
      campaign_id: campaignId,
      uploads: campaignId === 'camp-root'
        ? [upload('job-root', '2026-10-01T10:00:00Z')]
        : [upload('job-new', '2026-11-10T10:00:00Z')],
      generated_at: '2026-11-20T10:00:00Z',
    }));
    mocks.getIngestJob.mockImplementation(async (id: string) => ({
      id,
      context_columns: id === 'job-root' ? ['Branch'] : ['Borrower', 'City'],
    }));
    renderPage();
    await settle();
    expect(uploadReads('camp-1')).toBe(1 + history);
    expect(uploadReads('camp-root')).toBe(1);
    expect(mocks.getIngestJob.mock.calls.map((c) => c[0])).toEqual(['job-new', 'job-root']);
    expect(within(screen.getByTestId('fact-role-name')).queryByRole('option', { name: 'Branch' })).not.toBeNull();
  });

  it('holds Save on one column as both the name and the line under it', async () => {
    renderPage();
    const name = await cardReady();
    fireEvent.change(name, { target: { value: 'City' } });
    fireEvent.change(screen.getByTestId('fact-role-place'), { target: { value: 'City' } });
    expect(await screen.findByText('‘City’ is already the customer’s name. Choose another column.')).toBeTruthy();
    save();
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal on the role, on the fact and on the column it names', async () => {
    mocks.updateAgencyCampaign.mockRejectedValue(refusal({
      'context_display.roles.place': 'There is no column here.',
      'context_display.facts.0.label': 'A fact’s name is refused here.',
      'context_display.types.Due Date': 'Not this type.',
    }));
    renderPage();
    const place = await screen.findByTestId('fact-role-place');
    await waitFor(() => expect(within(place).queryByRole('option', { name: 'City' })).not.toBeNull());
    fireEvent.change(place, { target: { value: 'City' } });
    save();
    const roleMessage = await screen.findByText('There is no column here.');
    expect(place.getAttribute('aria-describedby')).toContain(roleMessage.closest('p')!.id);
    const labelMessage = screen.getByText('A fact’s name is refused here.');
    expect(screen.getByTestId('fact-label-0').getAttribute('aria-describedby')).toContain(labelMessage.closest('p')!.id);
    const typeMessage = screen.getByText('Not this type.');
    expect(screen.getByTestId('fact-type-Due Date').getAttribute('aria-describedby')).toContain(typeMessage.closest('p')!.id);
  });

  it('says to upload a list first when the campaign has none', async () => {
    mocks.getInsightsUploads.mockResolvedValue({ campaign_id: 'camp-1', uploads: [], generated_at: '2026-11-20T10:00:00Z' });
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ context_display: {} }));
    renderPage();
    expect(await screen.findByText(/Upload a customer list to this campaign first/)).toBeTruthy();
  });
});

describe('the pictures on outcomes and break reasons (BE-13)', () => {
  it('picks an outcome’s picture, removes another’s, and sends them in the catalogue', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('outcome-icon-0'));
    fireEvent.click(screen.getByTestId('tile-icon-option-rupee'));
    expect(screen.getByTestId('outcome-icon-0').getAttribute('aria-label')).toBe('Picture for Will pay: Rupee');
    fireEvent.click(screen.getByTestId('outcome-icon-1'));
    fireEvent.click(screen.getByTestId('tile-icon-option-none'));
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const catalog = sentBody().disposition_catalog as Array<Record<string, unknown>>;
    expect(catalog[0]).toMatchObject({ code: 'will_pay', icon: 'rupee' });
    expect(JSON.parse(JSON.stringify(catalog[1]))).toEqual({ code: 'refused', label: 'Refused' });
  });

  it('picks a break reason’s picture: the built-ins are then saved as the campaign’s own', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('break-icon-tea'));
    fireEvent.click(screen.getByTestId('tile-icon-option-tea'));
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const reasons = sentBody().break_reasons as Array<Record<string, unknown>>;
    expect(reasons.find((r) => r.code === 'tea')).toMatchObject({ icon: 'tea', limit_minutes: 15 });
  });

  it('shows a refused picture on its break reason’s row', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ break_reasons: [{ code: 'tea', label: 'Tea' }, { code: 'lunch', label: 'Lunch' }] }));
    mocks.updateAgencyCampaign.mockRejectedValue(refusal({ 'break_reasons[1].icon': 'Choose one of the tile pictures, or no picture.' }));
    renderPage();
    fireEvent.click(await screen.findByTestId('break-icon-lunch'));
    fireEvent.click(screen.getByTestId('tile-icon-option-lunch'));
    save();
    const message = await screen.findByText('Choose one of the tile pictures, or no picture.');
    expect(screen.getByTestId('break-limit-row-lunch').contains(message)).toBe(true);
  });
});
