import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ApiError } from '../../api/client';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * The agent station's settings on a campaign's Settings page (AS6, AS9, BE-6, BE-8, BE-13): What
 * agents see (the daily target, the number display, the customer facts), Script, and the pictures
 * on outcomes and break reasons. What each sends (only what changed, `null` to clear the target,
 * the facts merged into the stored display), what holds Save as it is typed, and each server
 * refusal on the field it names.
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
    mocks.updateAgencyCampaign.mockRejectedValue(refusal({ daily_target_calls: 'daily_target_calls must be a whole number from 1 to 2000, or null for no target.' }));
    renderPage();
    await screen.findByTestId('daily-target');
    fireEvent.change(target(), { target: { value: '50' } });
    save();
    const message = await screen.findByText(/or null for no target/);
    expect(target().getAttribute('aria-describedby')).toContain(message.closest('p')!.id);
  });
});

describe('Settings › What agents see: the customer’s number (AS9)', () => {
  it('previews both, and sends masked when chosen', async () => {
    renderPage();
    await screen.findByTestId('phone-display-full');
    expect(screen.getByTestId('phone-display-preview-masked').textContent).toBe('98••• ••321');
    expect(screen.getByTestId('phone-display-preview-full').textContent).toBe('98765 43321');
    expect((screen.getByTestId('phone-display-full') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('phone-display-masked'));
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({ phone_display: 'masked' });
  });
});

describe('Settings › Script (BE-8)', () => {
  it('adds steps, inserts a placeholder at the caret of the field last typed in, counts, and sends it trimmed', async () => {
    renderPage();
    const opening = await screen.findByTestId('script-opening') as HTMLTextAreaElement;
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
  });

  it('stops at twelve steps', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ agent_script: { steps: Array.from({ length: 12 }, (_, i) => ({ text: `S${i}` })) } }));
    renderPage();
    const add = await screen.findByTestId('script-add-step') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByText('A script can have at most 12 steps.')).toBeTruthy();
  });

  it('holds Save on a word the station cannot fill, said on its step', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('script-add-step'));
    fireEvent.change(screen.getByTestId('script-step-0'), { target: { value: 'Hi {Name}' } });
    expect(await screen.findByText(/\{Name\} is not a word the script can fill in/)).toBeTruthy();
    save();
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
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

describe('Settings › What agents see: the customer facts (BE-6)', () => {
  it('offers the newest completed imports’ columns, hidden ones left out, and sends the facts merged into the display', async () => {
    renderPage();
    const name = await screen.findByTestId('fact-role-name') as HTMLSelectElement;
    await waitFor(() => expect(within(name).queryByRole('option', { name: 'City' })).not.toBeNull());
    const offered = within(name).getAllByRole('option').map((o) => o.textContent);
    expect(offered).toEqual(['Not set', 'Borrower', 'City', 'Due Amount', 'Due Date']);
    expect(mocks.getIngestJob).toHaveBeenCalledTimes(2);
    expect(mocks.getIngestJob.mock.calls.map((c) => c[0])).toEqual(['job-new', 'job-old']);

    fireEvent.change(name, { target: { value: 'Borrower' } });
    fireEvent.change(screen.getByTestId('fact-role-amount_due'), { target: { value: 'Due Amount' } });
    // The amount due is read as money whatever its type: shown fixed.
    expect((screen.getByTestId('fact-type-Due Amount') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('fact-type-Due Date'), { target: { value: 'date' } });
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody().context_display).toEqual({
      hero: ['Due Amount'], hidden: ['PAN'],
      roles: { name: 'Borrower', amount_due: 'Due Amount' },
      types: { 'Due Date': 'date' },
    });
  });

  it('reads the columns once, after the campaign loads, and a retry campaign’s one read names its root', async () => {
    /** The columns' reads of the upload history (the page's history section reads it too, for camp-1). */
    const uploadReads = (campaignId: string) => mocks.getInsightsUploads.mock.calls.filter((c) => c[0] === campaignId).length;
    const settle = async () => {
      const name = await screen.findByTestId('fact-role-name');
      await waitFor(() => expect(within(name).queryByRole('option', { name: 'City' })).not.toBeNull());
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    };

    renderPage();
    await settle();
    const history = 1;
    expect(uploadReads('camp-1')).toBe(1 + history);
    expect(mocks.getIngestJob).toHaveBeenCalledTimes(2);

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

  it('holds Save on one column in two roles', async () => {
    renderPage();
    const name = await screen.findByTestId('fact-role-name');
    await waitFor(() => expect(within(name).queryByRole('option', { name: 'City' })).not.toBeNull());
    fireEvent.change(name, { target: { value: 'City' } });
    fireEvent.change(screen.getByTestId('fact-role-place'), { target: { value: 'City' } });
    expect(await screen.findByText(/‘City’ is already the customer name/)).toBeTruthy();
    save();
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal on the role and on the column it names', async () => {
    mocks.updateAgencyCampaign.mockRejectedValue(refusal({
      'context_display.roles.place': 'There is no column here.',
      'context_display.types.Due Date': 'Not this type.',
    }));
    renderPage();
    const place = await screen.findByTestId('fact-role-place');
    await waitFor(() => expect(within(place).queryByRole('option', { name: 'City' })).not.toBeNull());
    fireEvent.change(place, { target: { value: 'City' } });
    save();
    const roleMessage = await screen.findByText('There is no column here.');
    expect(place.getAttribute('aria-describedby')).toContain(roleMessage.closest('p')!.id);
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
    mocks.updateAgencyCampaign.mockRejectedValue(refusal({ 'break_reasons[1].icon': 'icon must be one of the tile pictures.' }));
    renderPage();
    fireEvent.click(await screen.findByTestId('break-icon-lunch'));
    fireEvent.click(screen.getByTestId('tile-icon-option-lunch'));
    save();
    const message = await screen.findByText('icon must be one of the tile pictures.');
    expect(screen.getByTestId('break-limit-row-lunch').contains(message)).toBe(true);
  });
});
