import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  AgencyCampaignTemplateEffective,
  AgencyCampaignTemplateSections,
  AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { builtinTemplateSections, resolveTemplateSections } from '@magick-agency/domain/campaign-templates';

/**
 * New campaign with campaign templates (`docs/campaign-templates.md` §7): the form opens filled in
 * from the account's default chain (`/campaign-templates/effective`), with a "Start from" picker
 * and the banner saying where from; switching re-fills it, asking first when something was
 * changed; Review labels each section with its source and offers Reset once it is changed; the
 * create names the template. With the flag off, or the read failing, the page is as before.
 */

const mocks = vi.hoisted(() => ({
  flags: { agency_campaign_templates_enabled: true } as Record<string, boolean>,
  useTenant: vi.fn(),
  getIngestLimits: vi.fn(),
  createAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  listCampaignTemplates: vi.fn(),
  getEffectiveCampaignTemplate: vi.fn(),
  started: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() }),
}));
vi.mock('../../analytics/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../analytics/events')>()),
  trackAgencyCampaignTemplateStartedFrom: mocks.started,
}));
vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: ['+912200000001', '+912200000002'].map((n, i) => ({
      phone_number_id: `pn-${i}`, phone_number: n, provider_name: 'voicelink', provider_display_name: 'VoiceLink', label: `Outbound ${i}`, is_default: i === 0,
    })),
    loading: false, error: null, reload: vi.fn(), defaultNumber: '+912200000001',
  }),
}));
vi.mock('../../hooks/useAgencyCarriers', () => ({ useAgencyCarriers: () => ({ carriers: null, error: null }) }));
vi.mock('../../api/agencyCampaigns', () => ({
  getIngestLimits: mocks.getIngestLimits,
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  createAgencyCampaign: mocks.createAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
}));
vi.mock('../../api/campaignTemplates', () => ({
  listCampaignTemplates: mocks.listCampaignTemplates,
  getEffectiveCampaignTemplate: mocks.getEffectiveCampaignTemplate,
}));

const summary = (over: Partial<AgencyCampaignTemplateSummary>): AgencyCampaignTemplateSummary => ({
  id: 'x', scope: 'account', account_id: 'a1', name: 'x', description: null, is_default: false, version: 1, based_on: null,
  sections_set: [], created_at: '2026-11-01T09:00:00Z', updated_at: '2026-11-18T16:12:00Z', updated_by: { user_id: 'u-1', name: 'Priya' },
  archived_at: null, archived_by: null, ...over,
});

const ACCOUNT = summary({ id: 'acc-1', name: 'Pune collections', is_default: true, version: 4 });
const ORG = summary({ id: 'org-1', scope: 'organisation', account_id: null, name: 'Standard', is_default: true, version: 2 });

const ORG_SECTIONS: AgencyCampaignTemplateSections = {
  wrapup: { wrapup_seconds: 45, wrapup_auto_return: true, allow_wrapup_redial: false },
  hours: { calling_window_start: '08:00', calling_window_end: '18:00', calling_days: [1, 2, 3, 4, 5], default_timezone: 'Asia/Kolkata' },
};
const ACCOUNT_SECTIONS: AgencyCampaignTemplateSections = {
  hours: { calling_window_start: '10:00', calling_window_end: '20:00', calling_days: [1, 2, 3, 4, 5, 6], default_timezone: 'Asia/Kolkata' },
  numbers: { caller_ids: ['+912200000002'], telephony_provider: 'voicelink', telephony_credential_id: null },
};

function effective(
  template: AgencyCampaignTemplateEffective['template'],
  chosen: AgencyCampaignTemplateSections,
  basedOn: AgencyCampaignTemplateSections | null,
  notes: AgencyCampaignTemplateEffective['notes'] = [],
): AgencyCampaignTemplateEffective {
  const resolved = resolveTemplateSections({
    chosen: template ? { scope: template.scope, sections: chosen } : null,
    basedOn: basedOn ? { sections: basedOn } : null,
    builtin: builtinTemplateSections(),
    can: { record: true, assignment: true, inbound: true },
  });
  return { template, based_on: null, config: resolved.config, sources: resolved.sources, notes };
}

const FROM_ACCOUNT = effective({ id: 'acc-1', name: 'Pune collections', version: 4, scope: 'account' }, ACCOUNT_SECTIONS, ORG_SECTIONS, [
  { code: 'recording_not_allowed', section: 'recording' },
]);
const FROM_ORG = effective({ id: 'org-1', name: 'Standard', version: 2, scope: 'organisation' }, ORG_SECTIONS, null);

async function renderPage(role = 'account_admin') {
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1', role });
  const { default: CampaignBuilderPage } = await import('../../pages/campaigns/agency/CampaignBuilderPage');
  render(
    <MemoryRouter>
      <CampaignBuilderPage />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {});
}

const goToStep = (title: string) => fireEvent.click(screen.getByRole('button', { name: title }));
const chip = (label: string) => screen.getByTestId(`review-source-${label}`).textContent;

beforeEach(() => {
  mocks.flags = { agency_campaign_templates_enabled: true };
  mocks.getIngestLimits.mockRejectedValue(new Error('not needed here'));
  mocks.createAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Diwali', status: 'draft' });
  mocks.updateAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Diwali', status: 'draft' });
  mocks.listCampaignTemplates.mockResolvedValue([ACCOUNT, ORG]);
  mocks.getEffectiveCampaignTemplate.mockImplementation(async (id: string | null) => (id === 'org-1' ? FROM_ORG : FROM_ACCOUNT));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('New campaign starts from a template', () => {
  it('opens filled in from the account’s default, saying where from, with its notes', async () => {
    await renderPage();
    expect(mocks.getEffectiveCampaignTemplate).toHaveBeenCalledWith(null, 't1', 'a1');
    expect((screen.getByTestId('start-from-select') as HTMLSelectElement).value).toBe('acc-1');
    const banner = screen.getByTestId('start-from-banner');
    expect(banner.textContent).toContain(
      'Filled in from Pune collections (version 4, changed by Priya on 18 Nov, 4:12 PM). Changes you make here apply to this campaign only.',
    );
    expect(within(banner).getByRole('link', { name: 'View template' }).getAttribute('href')).toBe('/settings/campaign-templates/acc-1');
    expect(screen.getByTestId('start-from-notes').textContent).toBe(
      'Recording is off for this account, so this campaign starts with recording off.',
    );
    // The template's numbers are picked on Basics; its hours are on When to call.
    expect((screen.getByRole('checkbox', { name: /\+912200000002/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    goToStep('When to call');
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('10:00');
    expect(mocks.started).toHaveBeenCalledWith({ source: 'account', preselected: true, note_count: 1 });
  });

  it('labels each Review row with its source, and resets a changed section', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    goToStep('Review & save');
    expect(chip('Hours')).toBe('Account template');
    expect(chip('Wrap-up')).toBe('Organisation template');
    expect(chip('Retries')).toBe('Built-in');
    expect(chip('Call from')).toBe('Account template');
    expect(screen.queryByRole('button', { name: 'Reset Hours to the template' })).toBeNull();

    goToStep('When to call');
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '11:00' } });
    goToStep('Review & save');
    expect(chip('Hours')).toBe('Changed for this campaign');
    expect(screen.getByTestId('review-source-Hours').getAttribute('data-source')).toBe('campaign');
    fireEvent.click(screen.getByRole('button', { name: 'Reset Hours to the template' }));
    expect(chip('Hours')).toBe('Account template');
    goToStep('When to call');
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('10:00');
  });

  it('re-fills the form from another template, asking first when something was changed', async () => {
    await renderPage();
    fireEvent.change(screen.getByTestId('start-from-select'), { target: { value: 'org-1' } });
    await act(async () => {});
    // Nothing was changed: no question.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.getEffectiveCampaignTemplate).toHaveBeenLastCalledWith('org-1', 't1', 'a1');
    expect(screen.getByTestId('start-from-banner').textContent).toContain('Filled in from Standard (version 2');
    // The organisation template sets no numbers: Basics asks again.
    expect((screen.getByRole('checkbox', { name: /\+912200000002/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /\+912200000001/ }));
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    goToStep('When to call');
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('08:00');

    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '07:00' } });
    fireEvent.change(screen.getByTestId('start-from-select'), { target: { value: '__builtin__' } });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Starting from another template replaces');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start from it' }));
    await act(async () => {});
    expect(screen.getByTestId('start-from-banner').textContent).toContain('Filled in from the built-in settings.');
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('09:00');
    expect(mocks.started).toHaveBeenLastCalledWith({ source: 'builtin', preselected: false, note_count: 0 });
  });

  it('names the template on the create, with the sections as on the form', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    goToStep('Review & save');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save campaign' })[0]!);
    await act(async () => {});
    const body = mocks.createAgencyCampaign.mock.calls[0]![0];
    expect(body.template_id).toBe('acc-1');
    expect(body.caller_ids).toEqual(['+912200000002']);
    expect(body.calling_window_start).toBe('10:00');
    expect(body.wrapup_seconds).toBe(45);
    expect(body.break_reasons).toEqual([]);
    expect(body.record_calls).toBe(false);
  });

  it('says nothing of templates, reads none and names none with the flag off', async () => {
    mocks.flags = {};
    await renderPage();
    expect(screen.queryByTestId('start-from')).toBeNull();
    expect(mocks.listCampaignTemplates).not.toHaveBeenCalled();
    expect(mocks.getEffectiveCampaignTemplate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /\+912200000001/ }));
    goToStep('Review & save');
    expect(screen.queryByTestId(/^review-source-/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Save campaign' })[0]!);
    await act(async () => {});
    expect(Object.keys(mocks.createAgencyCampaign.mock.calls[0]![0]).sort()).toEqual(
      ['abandonment_ceiling_pct', 'caller_ids', 'name', 'telephony_credential_id', 'telephony_provider'],
    );
  });

  it('starts as before when the read fails', async () => {
    mocks.getEffectiveCampaignTemplate.mockRejectedValue(new Error('down'));
    await renderPage();
    expect(screen.queryByTestId('start-from')).toBeNull();
    goToStep('When to call');
    // Not past Basics without a name and a number.
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /\+912200000001/ }));
    goToStep('When to call');
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('09:00');
    goToStep('Review & save');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save campaign' })[0]!);
    await act(async () => {});
    expect(mocks.createAgencyCampaign.mock.calls[0]![0]).not.toHaveProperty('template_id');
  });
});
