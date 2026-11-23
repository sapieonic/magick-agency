import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  AgencyCampaignTemplateEffective,
  AgencyCampaignTemplateSections,
  AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { builtinTemplateSections, resolveTemplateSections } from '@magick-agency/domain/campaign-templates';
import type { AgencyColumnAnalysis } from '../../types/agency-campaign';
import { scriptPlaceholdersFor, unknownPlaceholdersIn } from '@magick-agency/domain/fact-fields';

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
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  useCallAnalysisProfiles: vi.fn(),
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
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({ useCallAnalysisProfiles: mocks.useCallAnalysisProfiles }));
vi.mock('../../hooks/useAgencyCarriers', () => ({ useAgencyCarriers: () => ({ carriers: null, error: null }) }));
vi.mock('../../api/agencyCampaigns', () => ({
  getIngestLimits: mocks.getIngestLimits,
  uploadRosterCsv: mocks.uploadRosterCsv,
  analyzeRosterColumns: mocks.analyzeRosterColumns,
  startRosterIngest: mocks.startRosterIngest,
  getIngestJob: mocks.getIngestJob,
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

const PROFILES = [
  { id: 'prof-default', name: 'Standard summary', is_default: true },
  { id: 'prof-collections', name: 'Collections dimensions', is_default: false },
];

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
  // The banner's stamp says the year only when it is not this one: pin today.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
  mocks.flags = { agency_campaign_templates_enabled: true };
  mocks.getIngestLimits.mockRejectedValue(new Error('not needed here'));
  mocks.createAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Diwali', status: 'draft' });
  mocks.updateAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Diwali', status: 'draft' });
  mocks.listCampaignTemplates.mockResolvedValue([ACCOUNT, ORG]);
  mocks.getEffectiveCampaignTemplate.mockImplementation(async (id: string | null) => (id === 'org-1' ? FROM_ORG : FROM_ACCOUNT));
  mocks.useCallAnalysisProfiles.mockReturnValue({ profiles: PROFILES, loading: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('New campaign starts from a template', () => {
  it('opens filled in from the account’s default, saying where from, with its notes', async () => {
    await renderPage();
    expect(mocks.getEffectiveCampaignTemplate).toHaveBeenCalledWith(null, 't1', 'a1');
    expect((screen.getByTestId('start-from-select') as HTMLSelectElement).value).toBe('acc-1');
    // Which default is which (CTC4): the account's is the one New campaign opens on.
    expect([...(screen.getByTestId('start-from-select') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Pune collections (account default)',
      'Standard (organisation default)',
      'Built-in settings',
    ]);
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
    // Unanswered calls are part of Outcomes, and say so (N8).
    expect(chip('Unanswered calls')).toBe(chip('Outcomes'));
    expect(screen.getByTestId('review-note-Unanswered calls').textContent).toBe('Goes with Outcomes: Reset there puts both back.');
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
    // Choosing in the list starts nothing by itself (U12): the button does.
    expect(mocks.getEffectiveCampaignTemplate).not.toHaveBeenCalledWith('org-1', 't1', 'a1');
    fireEvent.click(screen.getByTestId('start-from-use'));
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
    fireEvent.click(screen.getByRole('button', { name: 'Use the built-in settings' }));
    await act(async () => {});
    const dialog = screen.getByRole('dialog');
    // The hours only: the number picked on Basics is kept, since the built-in settings leave numbers alone.
    expect(dialog.textContent).toContain('You changed a section of these settings. Starting from another template replaces it');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start from it' }));
    await act(async () => {});
    expect(screen.getByTestId('start-from-banner').textContent).toContain('Filled in from the built-in settings.');
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('09:00');
    expect(mocks.started).toHaveBeenLastCalledWith({ source: 'builtin', preselected: false, note_count: 0 });
    goToStep('Name & numbers');
    expect((screen.getByRole('checkbox', { name: /\+912200000001/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Campaign name/) as HTMLInputElement).value).toBe('Diwali');
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

const tick = (number: string) => fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(number.replace('+', '\\+')) }));
const ticked = (number: string) =>
  (screen.getByRole('checkbox', { name: new RegExp(number.replace('+', '\\+')) }) as HTMLInputElement).checked;
const pickStart = async (value: string) => {
  fireEvent.change(screen.getByTestId('start-from-select'), { target: { value } });
  fireEvent.click(screen.getByTestId('start-from-use'));
  await act(async () => {});
};

/** A second account template that sets other numbers. */
const OTHER = summary({ id: 'acc-2', name: 'Mumbai sales', version: 1 });
const FROM_OTHER = effective({ id: 'acc-2', name: 'Mumbai sales', version: 1, scope: 'account' }, {
  numbers: { caller_ids: ['+912200000001'], telephony_provider: 'voicelink', telephony_credential_id: null },
}, ORG_SECTIONS);

describe('the numbers picked on Basics (CTC2)', () => {
  beforeEach(() => {
    mocks.listCampaignTemplates.mockResolvedValue([ACCOUNT, OTHER, ORG]);
    mocks.getEffectiveCampaignTemplate.mockImplementation(async (id: string | null) =>
      (id === 'acc-1' || id === null ? FROM_ACCOUNT : id === 'acc-2' ? FROM_OTHER : FROM_ORG));
  });

  it('are not a change while the start leaves numbers built-in: no chip, no Reset, no question on a switch', async () => {
    // The organisation's default: it sets no numbers.
    mocks.getEffectiveCampaignTemplate.mockImplementation(async (id: string | null) => (id === 'acc-1' ? FROM_ACCOUNT : FROM_ORG));
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    tick('+912200000001');
    goToStep('Review & save');
    expect(screen.queryByTestId('review-source-Call from')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset Call from to the template' })).toBeNull();

    await pickStart('__builtin__');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('start-from-banner').textContent).toContain('Filled in from the built-in settings.');
    goToStep('Name & numbers');
    expect(ticked('+912200000001')).toBe(true);
  });

  it('survive a Reset of another section', async () => {
    mocks.getEffectiveCampaignTemplate.mockImplementation(async () => FROM_ORG);
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    tick('+912200000002');
    goToStep('When to call');
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '07:00' } });
    goToStep('Review & save');
    fireEvent.click(screen.getByRole('button', { name: 'Reset Hours to the template' }));
    goToStep('Name & numbers');
    expect(ticked('+912200000002')).toBe(true);
  });

  it('are replaced by a template that sets numbers, without asking when the operator picked none of their own', async () => {
    await renderPage();
    expect(ticked('+912200000002')).toBe(true);
    await pickStart('acc-2');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ticked('+912200000001')).toBe(true);
    expect(ticked('+912200000002')).toBe(false);
  });

  async function pickedOwnThenSwitch() {
    await renderPage();
    // Pune collections sets +912200000002; the operator adds +912200000001.
    tick('+912200000001');
    await pickStart('acc-2');
  }

  it('are replaced by a template that sets other numbers only after asking, when the operator picked their own', async () => {
    await pickedOwnThenSwitch();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('You changed a section of these settings.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start from it' }));
    await act(async () => {});
    expect(ticked('+912200000001')).toBe(true);
    expect(ticked('+912200000002')).toBe(false);
  });

  it('stay when that question is answered Cancel', async () => {
    await pickedOwnThenSwitch();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(ticked('+912200000001')).toBe(true);
    expect(ticked('+912200000002')).toBe(true);
    expect((screen.getByTestId('start-from-select') as HTMLSelectElement).value).toBe('acc-1');
  });

  it('go back to the template’s with Reset on Call from', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    tick('+912200000001');
    tick('+912200000002');
    goToStep('Review & save');
    expect(chip('Call from')).toBe('Changed for this campaign');
    fireEvent.click(screen.getByRole('button', { name: 'Reset Call from to the template' }));
    expect(chip('Call from')).toBe('Account template');
    goToStep('Name & numbers');
    expect(ticked('+912200000002')).toBe(true);
    expect(ticked('+912200000001')).toBe(false);
  });
});

describe('the default chain read landing late (CTC8)', () => {
  it('still offers Start from, fills only what was not touched and names the template on the create', async () => {
    let land: (value: AgencyCampaignTemplateEffective) => void = () => {};
    mocks.getEffectiveCampaignTemplate.mockImplementation((id: string | null) =>
      (id === null
        ? new Promise<AgencyCampaignTemplateEffective>((resolve) => {
          land = resolve;
        })
        : Promise.resolve(FROM_ORG)));
    await renderPage();
    expect(screen.queryByTestId('start-from')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    tick('+912200000001');
    goToStep('When to call');
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '07:00' } });

    await act(async () => land(FROM_ACCOUNT));
    expect((screen.getByTestId('start-from-select') as HTMLSelectElement).value).toBe('acc-1');
    // The hours typed stay; the wrap-up nobody touched comes from the template.
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('07:00');
    goToStep('Review & save');
    expect(chip('Hours')).toBe('Changed for this campaign');
    expect(chip('Wrap-up')).toBe('Organisation template');
    // The number ticked stays in place of the template's.
    expect(chip('Call from')).toBe('Changed for this campaign');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save campaign' })[0]!);
    await act(async () => {});
    const body = mocks.createAgencyCampaign.mock.calls[0]![0];
    expect(body.template_id).toBe('acc-1');
    expect(body.caller_ids).toEqual(['+912200000001']);
    expect(body.calling_window_start).toBe('07:00');
    expect(body.wrapup_seconds).toBe(45);
  });
});

const ANALYSIS: AgencyColumnAnalysis = {
  headers: ['Mobile', 'Full Name', 'Loan No'],
  columns: [
    { name: 'Mobile', index: 0, samples: ['9820041772'], non_empty: 10, phone_score: 0.95, distinct: 10, distinct_phones: 10 },
    { name: 'Full Name', index: 1, samples: ['Priya Menon'], non_empty: 10, phone_score: 0, distinct: 10, distinct_phones: 0 },
    { name: 'Loan No', index: 2, samples: ['L-1'], non_empty: 10, phone_score: 0, distinct: 10, distinct_phones: 0 },
  ],
  rows_sampled: 10,
  truncated: false,
  suggested_phone_column: 'Mobile',
  phone_column_ambiguous: false,
  phone_column_candidates: [],
};

/** Upload a roster on Contacts and import it: the roster upload creates the draft. */
async function importRoster(onCard: string | null = null) {
  goToStep('Who to call');
  const input = screen.getByLabelText('CSV file') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['Mobile\n9820041772\n'], 'r.csv', { type: 'text/csv' })] } });
  await screen.findByLabelText('Use Mobile as');
  if (onCard) fireEvent.change(screen.getByLabelText(`Use ${onCard} as`), { target: { value: 'hero' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import without checking' }));
  await waitFor(() => expect(mocks.startRosterIngest).toHaveBeenCalled());
}

describe('the draft a roster upload makes (CTC1)', () => {
  beforeEach(() => {
    mocks.uploadRosterCsv.mockResolvedValue({ s3_key: 'k', file_name: 'r.csv', dedupe_columns: [], file_size_bytes: 10 });
    mocks.analyzeRosterColumns.mockResolvedValue(ANALYSIS);
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'running' });
    mocks.getIngestJob.mockReturnValue(new Promise(() => {}));
  });

  it('is created with the template named, and Save campaign then sends the hours changed after it', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    await importRoster();
    expect(mocks.createAgencyCampaign.mock.calls[0]![0]).toMatchObject({ template_id: 'acc-1', calling_window_start: '10:00' });
    expect((screen.getByTestId('start-from-select') as HTMLSelectElement).disabled).toBe(true);

    goToStep('When to call');
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '11:00' } });
    goToStep('Review & save');
    expect(chip('Hours')).toBe('Changed for this campaign');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save campaign' })[0]!);
    await act(async () => {});
    expect(mocks.createAgencyCampaign).toHaveBeenCalledTimes(1);
    const patch = mocks.updateAgencyCampaign.mock.calls.at(-1)!;
    expect(patch[0]).toBe('camp-1');
    expect(patch[1]).toMatchObject({ calling_window_start: '11:00', calling_window_end: '20:00', wrapup_seconds: 45 });
  });

  it('names only the template while a setting is still being fixed: the server fills the rest from it, and Save campaign sends them', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    goToStep('When to call');
    // Start and end the same: the hours cannot be saved yet.
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '20:00' } });
    await importRoster();
    expect(Object.keys(mocks.createAgencyCampaign.mock.calls[0]![0]).sort()).toEqual([
      'abandonment_ceiling_pct', 'caller_ids', 'name', 'telephony_credential_id', 'telephony_provider', 'template_id',
    ]);
    expect(mocks.createAgencyCampaign.mock.calls[0]![0].template_id).toBe('acc-1');
  });
});

describe('the built-in settings', () => {
  it('are named on the create as template_id null', async () => {
    await renderPage();
    await pickStart('__builtin__');
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    tick('+912200000001');
    goToStep('Review & save');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save campaign' })[0]!);
    await act(async () => {});
    const body = mocks.createAgencyCampaign.mock.calls[0]![0];
    expect(body).toHaveProperty('template_id', null);
    expect(body.calling_window_start).toBe('09:00');
  });
});

/*
  CTC10: a template whose script uses card keys (`{amount_due}`, `{due_date}`) passes the template's
  check (the legacy keys) and New campaign's create (no card yet: the legacy keys), but the card
  the roster import then saves has its own keys (AS19). The mock below refuses as the server does
  (`apps/server/src/agency/agent-script.ts`): a card that takes away a key the stored script uses,
  and a script with a key its card has no fact for.
*/
describe('a template script that uses keys the roster’s card does not have (CTC10)', () => {
  const SCRIPTED = effective({ id: 'acc-1', name: 'Pune collections', version: 4, scope: 'account' }, {
    ...ACCOUNT_SECTIONS,
    agent_screen: { agent_script: { opening: 'Hello {name}. Your {amount_due} is due on {due_date}.' } },
  }, ORG_SECTIONS);
  let stored: Record<string, unknown> = {};

  beforeEach(() => {
    mocks.getEffectiveCampaignTemplate.mockResolvedValue(SCRIPTED);
    mocks.uploadRosterCsv.mockResolvedValue({ s3_key: 'k', file_name: 'r.csv', dedupe_columns: [], file_size_bytes: 10 });
    mocks.analyzeRosterColumns.mockResolvedValue(ANALYSIS);
    mocks.startRosterIngest.mockResolvedValue({ job_id: 'job-1', status: 'running' });
    mocks.getIngestJob.mockReturnValue(new Promise(() => {}));
    stored = {};
    mocks.createAgencyCampaign.mockImplementation(async (body: Record<string, unknown>) => {
      stored = { ...body };
      return { id: 'camp-1', name: 'Diwali', status: 'draft' };
    });
    mocks.updateAgencyCampaign.mockImplementation(async (_id: string, body: Record<string, unknown>) => {
      const display = (body.context_display ?? stored.context_display) as { facts?: unknown[] } | undefined;
      const script = (body.agent_script ?? stored.agent_script ?? {}) as { opening?: string; steps?: Array<{ text: string }> };
      if (display?.facts) {
        const text = [script.opening ?? '', ...(script.steps ?? []).map((s) => s.text)].join('\n');
        const unknown = unknownPlaceholdersIn(text, scriptPlaceholdersFor(display as never));
        if (unknown.length > 0) {
          throw new Error(body.agent_script
            ? `The script uses ${unknown[0]}, which is not a fact on the card.`
            : `The script uses ${unknown[0]}. Take it out of the script first, or keep the fact.`);
        }
      }
      stored = { ...stored, ...body };
      return { id: 'camp-1', name: 'Diwali', status: 'draft' };
    });
  });

  it('imports the roster all the same, then says so on Review and lets the script be fixed there', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    expect((mocks.createAgencyCampaign.mock.calls[0]?.[0])).toBeUndefined();
    await importRoster('Loan No');
    expect(screen.queryByTestId('builder-error')).toBeNull();
    expect(mocks.createAgencyCampaign.mock.calls[0]![0].agent_script).toEqual({ opening: 'Hello {name}. Your {amount_due} is due on {due_date}.' });

    goToStep('Review & save');
    const problem = screen.getByTestId('review-script-problem');
    // Said as a status: it changes as the script is typed, and an alert would be read out at each key (U12).
    expect(problem.getAttribute('role')).toBe('status');
    expect(problem.textContent).toContain(
      'The script uses {amount_due} and {due_date}, which are not facts on the card. Add them as facts or take them out.',
    );
    const save = () => screen.getAllByRole('button', { name: 'Save campaign' })[0] as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Edit the script' }));
    fireEvent.change(screen.getByLabelText('Opening line'), { target: { value: 'Hello {name}. Your {loan_no} is due.' } });
    expect(screen.queryByTestId('review-script-problem')).toBeNull();
    expect(chip('What agents see')).toBe('Changed for this campaign');
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await act(async () => {});
    expect(screen.queryByTestId('builder-error')).toBeNull();
    expect(stored.agent_script).toEqual({ opening: 'Hello {name}. Your {loan_no} is due.' });
  });

  it('keeps the script whole when the card has its keys', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    await importRoster();
    expect(screen.queryByTestId('builder-error')).toBeNull();
    goToStep('Review & save');
    expect(screen.queryByTestId('review-script-problem')).toBeNull();
    expect(stored.agent_script).toEqual({ opening: 'Hello {name}. Your {amount_due} is due on {due_date}.' });
  });
});

/*
  The recording section is the record flag AND the call summary profile (CT5: an account template's
  only; the server notes `analysis_profile_unavailable` and leaves it out when the account cannot
  use it). New campaign's picker is filled from it like the flag, Reset puts both back, and the
  create sends what the picker shows.
*/
describe('the call summary profile a template sets', () => {
  const PROFILED = effective({ id: 'acc-1', name: 'Pune collections', version: 4, scope: 'account' }, {
    ...ACCOUNT_SECTIONS,
    recording: { record_calls: true, analysis_profile_id: 'prof-collections' },
  }, ORG_SECTIONS);
  const summarySelect = () => screen.getByLabelText('Call summary') as HTMLSelectElement;
  const recordBox = () => screen.getByRole('checkbox', { name: /record every call on this campaign/i }) as HTMLInputElement;

  beforeEach(() => {
    mocks.getEffectiveCampaignTemplate.mockImplementation(async (id: string | null) => (id === 'org-1' ? FROM_ORG : PROFILED));
  });

  it('fills the picker, names it on Review with the template’s chip, and is sent on the create and the save', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    goToStep('How agents work');
    expect(recordBox().checked).toBe(true);
    expect(summarySelect().value).toBe('prof-collections');
    goToStep('Review & save');
    expect(screen.getByText('Collections dimensions')).toBeTruthy();
    expect(chip('Call summary')).toBe('Account template');
    expect(chip('Recording')).toBe('Account template');
    // Filled in, not typed: nothing to warn about on leaving before a draft exists.
    expect(screen.queryByTestId('draft-note')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Save campaign' })[0]!);
    await act(async () => {});
    const body = mocks.createAgencyCampaign.mock.calls[0]![0];
    expect(body).toMatchObject({ template_id: 'acc-1', record_calls: true, analysis_profile_id: 'prof-collections' });
    expect(mocks.updateAgencyCampaign.mock.calls.at(-1)![1]).toMatchObject({ record_calls: true, analysis_profile_id: 'prof-collections' });
  });

  it('marks the recording section changed when the profile is changed, and sends the one picked', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    goToStep('How agents work');
    fireEvent.change(summarySelect(), { target: { value: 'prof-default' } });
    goToStep('Review & save');
    expect(chip('Recording')).toBe('Changed for this campaign');
    expect(chip('Call summary')).toBe('Changed for this campaign');
    expect(screen.getByTestId('review-source-Recording').getAttribute('data-source')).toBe('campaign');

    fireEvent.click(screen.getAllByRole('button', { name: 'Save campaign' })[0]!);
    await act(async () => {});
    expect(mocks.createAgencyCampaign.mock.calls[0]![0]).toMatchObject({ record_calls: true, analysis_profile_id: 'prof-default' });
  });

  it('puts the template’s profile back, with the flag, on Reset of Recording', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    goToStep('How agents work');
    fireEvent.click(recordBox());
    fireEvent.change(summarySelect(), { target: { value: '__none__' } });
    goToStep('Review & save');
    expect(chip('Recording')).toBe('Changed for this campaign');
    fireEvent.click(screen.getByRole('button', { name: 'Reset Recording to the template' }));
    expect(chip('Recording')).toBe('Account template');
    expect(chip('Call summary')).toBe('Account template');
    goToStep('How agents work');
    expect(recordBox().checked).toBe(true);
    expect(summarySelect().value).toBe('prof-collections');
  });

  it('asks before replacing a profile the operator changed, and a template without one clears it', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    goToStep('How agents work');
    fireEvent.change(summarySelect(), { target: { value: 'prof-default' } });
    await pickStart('org-1');
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('You changed a section of these settings.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start from it' }));
    await act(async () => {});
    // An organisation template holds no profile (CT5).
    expect(summarySelect().value).toBe('__none__');
  });

  it('starts with no summary, and says why, when the server left the template’s profile out', async () => {
    const UNAVAILABLE = effective({ id: 'acc-1', name: 'Pune collections', version: 4, scope: 'account' }, {
      ...ACCOUNT_SECTIONS,
      recording: { record_calls: true, analysis_profile_id: null },
    }, ORG_SECTIONS, [{ code: 'analysis_profile_unavailable', section: 'recording' }]);
    mocks.getEffectiveCampaignTemplate.mockResolvedValue(UNAVAILABLE);
    await renderPage();
    expect(screen.getByTestId('start-from-notes').textContent).toBe(
      'The template’s call summary profile is no longer available, so this campaign starts with no summary.',
    );
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Diwali' } });
    goToStep('How agents work');
    expect(summarySelect().value).toBe('__none__');
    goToStep('Review & save');
    expect(chip('Call summary')).toBe('Account template');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save campaign' })[0]!);
    await act(async () => {});
    expect(mocks.createAgencyCampaign.mock.calls[0]![0]).toMatchObject({ record_calls: true, analysis_profile_id: null });
  });
});
