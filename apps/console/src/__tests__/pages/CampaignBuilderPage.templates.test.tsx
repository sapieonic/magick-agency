import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, act, within, waitFor } from '@testing-library/react';
import type {
  AgencyCampaignTemplateEffective,
  AgencyCampaignTemplateSections,
  AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { builtinTemplateSections, resolveTemplateSections } from '@magick-agency/domain/campaign-templates';
import { scriptPlaceholdersFor, unknownPlaceholdersIn } from '@magick-agency/domain/fact-fields';
import type { AgencyColumnAnalysis } from '../../types/agency-campaign';
import {
  ANALYSIS,
  applied,
  check,
  currentStep,
  dropCsv,
  footer,
  footerButton,
  goToStep,
  imported,
  openFold,
  renderPage as renderBuilder,
  saveDraftButton,
  stepCard,
  staffingHook,
} from './campaignBuilderFixtures';

/**
 * New campaign with campaign templates (`docs/campaign-templates.md` §7, CS17–CS20): the form opens
 * filled in from the account's default chain (`/campaign-templates/effective`), with "Start from"
 * above the step cards and the line saying where from; switching re-fills it, asking first when
 * something was changed; each section's source chip and Reset sit at the block that edits it on its
 * step (Review is gone, CS1); a template's script is on Purpose & buttons, and held there when the
 * roster's card cannot fill it; the create names the template. With the flag off, or the read
 * failing, the page is as before.
 */

const mocks = vi.hoisted(() => ({
  flags: { agency_campaign_templates_enabled: true } as Record<string, boolean>,
  useTenant: vi.fn(),
  getIngestLimits: vi.fn(),
  createAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  transitionAgencyCampaign: vi.fn(),
  listCampaignTemplates: vi.fn(),
  getEffectiveCampaignTemplate: vi.fn(),
  started: vi.fn(),
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  importCheckedFile: vi.fn(),
  useCallAnalysisProfiles: vi.fn(),
  applyStaffing: vi.fn(),
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
  importCheckedFile: mocks.importCheckedFile,
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  downloadSkippedRows: vi.fn(),
  createAgencyCampaign: mocks.createAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
  transitionAgencyCampaign: mocks.transitionAgencyCampaign,
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

/** The numbers as the cards name them. */
const N1 = '+91 22000 00001';
const N2 = '+91 22000 00002';

async function renderPage(role = 'account_admin') {
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1', role });
  await renderBuilder();
  await act(async () => {});
  await act(async () => {});
}

const typeName = (value = 'Diwali') => fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value } });
const tick = (number: string) => fireEvent.click(screen.getByRole('checkbox', { name: number }));
const ticked = (number: string) => (screen.getByRole('checkbox', { name: number }) as HTMLInputElement).checked;
const startSelect = () => screen.getByTestId('start-from-select') as HTMLSelectElement;
const startInput = () => screen.getByLabelText('Start') as HTMLInputElement;
const pickStart = async (value: string) => {
  fireEvent.change(startSelect(), { target: { value } });
  fireEvent.click(screen.getByTestId('start-from-use'));
  await act(async () => {});
};
const createBody = () => mocks.createAgencyCampaign.mock.calls[0]![0] as Record<string, unknown>;
const lastPatch = () => mocks.updateAgencyCampaign.mock.calls.at(-1)![1] as Record<string, unknown>;
const save = async () => {
  fireEvent.click(saveDraftButton());
  await act(async () => {});
};

/** The block (by test id) that edits a section, and the chip and Reset in it (CS18). */
const block = (testId: string) => within(screen.getByTestId(testId));
const chip = (testId: string) => block(testId).getByTestId('section-source-chip').textContent;
const chipSource = (testId: string) => block(testId).getByTestId('section-source-chip').getAttribute('data-source');
const resetIn = (testId: string, section: string) => block(testId).queryByRole('button', { name: `Reset ${section} to the template` });

/** Where each section's chip sits on its step, by the block's test id. */
const AGENTS_BLOCKS = {
  hours: 'when-to-call',
  retries: 'unanswered-rule',
  wrapup: 'wrapup-row',
  record: 'record-row',
  summary: 'summary-row',
  phoneDisplay: 'phone-display-row',
  dailyTarget: 'daily-target-row',
} as const;

beforeEach(() => {
  // The line's stamp says the year only when it is not this one: pin today.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
  mocks.flags = { agency_campaign_templates_enabled: true };
  mocks.getIngestLimits.mockRejectedValue(new Error('not needed here'));
  mocks.createAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Diwali', status: 'draft' });
  mocks.updateAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Diwali', status: 'draft' });
  mocks.listCampaignTemplates.mockResolvedValue([ACCOUNT, ORG]);
  mocks.getEffectiveCampaignTemplate.mockImplementation(async (id: string | null) => (id === 'org-1' ? FROM_ORG : FROM_ACCOUNT));
  mocks.useCallAnalysisProfiles.mockReturnValue({ profiles: PROFILES, loading: false, error: null });
  mocks.applyStaffing.mockResolvedValue(applied());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('New campaign starts from a template (CS17)', () => {
  it('opens filled in from the account’s default, above the step cards, saying where from, with its notes', async () => {
    await renderPage();
    expect(mocks.getEffectiveCampaignTemplate).toHaveBeenCalledWith(null, 't1', 'a1');
    expect(startSelect().value).toBe('acc-1');
    // A slim card above the four step cards (CS17).
    const panel = screen.getByTestId('start-from');
    expect(panel.tagName).toBe('SECTION');
    expect(panel.compareDocumentPosition(screen.getByRole('navigation', { name: 'Campaign setup' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Which default is which (CTC4): the account's is the one New campaign opens on.
    expect([...startSelect().options].map((o) => o.textContent)).toEqual([
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
    // The template's numbers are picked on Name & number; its hours are on Agents & timing.
    expect(ticked(N2)).toBe(true);
    typeName();
    goToStep('Agents & timing');
    expect(startInput().value).toBe('10:00');
    expect(mocks.started).toHaveBeenCalledWith({ source: 'account', preselected: true, note_count: 1 });
  });

  it('labels each section at the block that edits it, and resets a changed section there (CS18)', async () => {
    await renderPage();
    typeName();
    // Name & number: the numbers.
    expect(chip('caller-id-field')).toBe('Account template');
    // Purpose & buttons: the buttons (neither template sets them).
    goToStep('Purpose & buttons');
    expect(chip('buttons-block')).toBe('Built-in');
    // Agents & timing: hours, retries, wrap-up, recording and the agent screen.
    goToStep('Agents & timing');
    expect(chip(AGENTS_BLOCKS.hours)).toBe('Account template');
    expect(chip(AGENTS_BLOCKS.wrapup)).toBe('Organisation template');
    expect(chip(AGENTS_BLOCKS.retries)).toBe('Built-in');
    expect(chip(AGENTS_BLOCKS.record)).toBe('Built-in');
    expect(chip(AGENTS_BLOCKS.summary)).toBe('Built-in');
    expect(chip(AGENTS_BLOCKS.phoneDisplay)).toBe('Built-in');
    expect(chip(AGENTS_BLOCKS.dailyTarget)).toBe('Built-in');
    // Under Advanced: the retry table, the abandonment limit and the break limits.
    openFold('advanced-settings');
    expect(chip('sourced-retries')).toBe('Built-in');
    expect(chip('sourced-safety')).toBe('Built-in');
    expect(chip('sourced-breaks')).toBe('Built-in');
    // Flag-gated sections show only where their flag is on.
    expect(screen.queryByTestId('sourced-assignment')).toBeNull();
    expect(screen.queryByTestId('sourced-inbound')).toBeNull();
    expect(resetIn(AGENTS_BLOCKS.hours, 'calling hours')).toBeNull();

    fireEvent.change(startInput(), { target: { value: '11:00' } });
    expect(chip(AGENTS_BLOCKS.hours)).toBe('Changed for this campaign');
    expect(chipSource(AGENTS_BLOCKS.hours)).toBe('campaign');
    // No extra mark on the step card: the chip says it.
    expect(stepCard('Agents & timing').getAttribute('aria-label')).toBe('Agents & timing');
    fireEvent.click(resetIn(AGENTS_BLOCKS.hours, 'calling hours')!);
    expect(chip(AGENTS_BLOCKS.hours)).toBe('Account template');
    expect(startInput().value).toBe('10:00');
  });

  it('shows the assignment and inbound chips under Advanced where their flags are on', async () => {
    mocks.flags = { agency_campaign_templates_enabled: true, agency_contact_assignment_enabled: true, agency_inbound_enabled: true };
    await renderPage();
    typeName();
    goToStep('Agents & timing');
    openFold('advanced-settings');
    expect(chip('sourced-assignment')).toBe('Built-in');
    expect(chip('sourced-inbound')).toBe('Built-in');
  });

  it('keeps the unanswered calls with the buttons: one chip, and their Reset puts both back (N8)', async () => {
    await renderPage();
    typeName();
    goToStep('Purpose & buttons');
    openFold('purpose-advanced');
    const noAnswer = () => screen.getByLabelText('No answer') as HTMLSelectElement;
    const before = noAnswer().value;
    const other = [...noAnswer().options].map((o) => o.value).find((v) => v !== before && v !== '')!;
    fireEvent.change(noAnswer(), { target: { value: other } });
    expect(chip('buttons-block')).toBe('Changed for this campaign');
    fireEvent.click(resetIn('buttons-block', 'outcomes')!);
    expect(chip('buttons-block')).toBe('Built-in');
    expect(noAnswer().value).toBe(before);
  });

  it('starts Purpose & buttons’ rows afresh when the Reset puts the buttons back', async () => {
    await renderPage();
    typeName();
    goToStep('Purpose & buttons');
    fireEvent.click(screen.getByTestId('button-edit-0'));
    fireEvent.change(screen.getByTestId('button-success-0'), { target: { value: 'yes' } });
    expect(chip('buttons-block')).toBe('Changed for this campaign');
    expect(screen.getByTestId('button-sentence-0')).toBeTruthy();
    fireEvent.click(resetIn('buttons-block', 'outcomes')!);
    expect(chip('buttons-block')).toBe('Built-in');
    // The row open on the old buttons is not left open on the new ones.
    expect(screen.queryByTestId('button-sentence-0')).toBeNull();
  });

  it('re-fills the form from another template, asking first when something was changed', async () => {
    await renderPage();
    fireEvent.change(startSelect(), { target: { value: 'org-1' } });
    // Choosing in the list starts nothing by itself (U12): the button does.
    expect(mocks.getEffectiveCampaignTemplate).not.toHaveBeenCalledWith('org-1', 't1', 'a1');
    fireEvent.click(screen.getByTestId('start-from-use'));
    await act(async () => {});
    // Nothing was changed: no question.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.getEffectiveCampaignTemplate).toHaveBeenLastCalledWith('org-1', 't1', 'a1');
    expect(screen.getByTestId('start-from-banner').textContent).toContain('Filled in from Standard (version 2');
    // The organisation template sets no numbers: Name & number asks again.
    expect(ticked(N2)).toBe(false);
    tick(N1);
    typeName();
    goToStep('Agents & timing');
    expect(startInput().value).toBe('08:00');

    fireEvent.change(startInput(), { target: { value: '07:00' } });
    await pickStart('__builtin__');
    const dialog = screen.getByRole('dialog');
    // The hours only: the number picked is kept, since the built-in settings leave numbers alone.
    expect(dialog.textContent).toContain('You changed a section of these settings. Starting from another template replaces it');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start from it' }));
    await act(async () => {});
    expect(screen.getByTestId('start-from-banner').textContent).toContain('Filled in from the built-in settings.');
    // The built-in 9 AM – 8 PM is a choice of its own.
    expect((screen.getByRole('radio', { name: '9 AM – 8 PM' }) as HTMLInputElement).checked).toBe(true);
    expect(mocks.started).toHaveBeenLastCalledWith({ source: 'builtin', preselected: false, note_count: 0 });
    goToStep('Name & number');
    expect(ticked(N1)).toBe(true);
    expect((screen.getByLabelText(/Campaign name/) as HTMLInputElement).value).toBe('Diwali');
  });

  it('names the template on the create, with the sections as on the form', async () => {
    await renderPage();
    typeName();
    await save();
    const body = createBody();
    expect(body.template_id).toBe('acc-1');
    expect(body.caller_ids).toEqual(['+912200000002']);
    expect(body.calling_window_start).toBe('10:00');
    expect(body.wrapup_seconds).toBe(45);
    expect(body.break_reasons).toEqual([]);
    expect(body.record_calls).toBe(false);
    expect(body.phone_display).toBe('full');
    expect(body.daily_target_calls).toBeNull();
  });

  it('sends the agent screen and the break limits as changed on Agents & timing, and marks the sections changed', async () => {
    await renderPage();
    typeName();
    goToStep('Agents & timing');
    fireEvent.change(screen.getByTestId('daily-target'), { target: { value: '40' } });
    fireEvent.click(within(screen.getByTestId('phone-display-row')).getByRole('switch'));
    expect(chip(AGENTS_BLOCKS.dailyTarget)).toBe('Changed for this campaign');
    expect(chip(AGENTS_BLOCKS.phoneDisplay)).toBe('Changed for this campaign');
    await save();
    expect(createBody()).toMatchObject({ template_id: 'acc-1', daily_target_calls: 40, phone_display: 'masked' });
    // The draft has them from the create: the save that follows does not send them again.
    expect(lastPatch()).not.toHaveProperty('daily_target_calls');
    expect(lastPatch()).not.toHaveProperty('phone_display');
  });

  it('puts the agent screen back with its Reset', async () => {
    await renderPage();
    typeName();
    goToStep('Agents & timing');
    fireEvent.change(screen.getByTestId('daily-target'), { target: { value: '40' } });
    fireEvent.click(resetIn(AGENTS_BLOCKS.dailyTarget, 'what agents see')!);
    expect((screen.getByTestId('daily-target') as HTMLInputElement).value).toBe('');
    expect(chip(AGENTS_BLOCKS.dailyTarget)).toBe('Built-in');
  });

  it('says nothing of templates, reads none and names none with the flag off', async () => {
    mocks.flags = {};
    await renderPage();
    expect(screen.queryByTestId('start-from')).toBeNull();
    expect(mocks.listCampaignTemplates).not.toHaveBeenCalled();
    expect(mocks.getEffectiveCampaignTemplate).not.toHaveBeenCalled();
    typeName();
    tick(N1);
    expect(screen.queryByTestId(/^section-source-/)).toBeNull();
    goToStep('Purpose & buttons');
    expect(screen.queryByTestId(/^section-source-/)).toBeNull();
    expect(screen.queryByTestId('builder-script')).toBeNull();
    goToStep('Agents & timing');
    openFold('advanced-settings');
    expect(screen.queryByTestId(/^section-source-/)).toBeNull();
    expect(screen.queryByTestId(/^sourced-/)).toBeNull();
    await save();
    expect(Object.keys(createBody()).sort()).toEqual(
      ['abandonment_ceiling_pct', 'abandonment_grace_ms', 'caller_ids', 'name', 'telephony_credential_id', 'telephony_provider'],
    );
  });

  it('starts as before when the read fails', async () => {
    mocks.getEffectiveCampaignTemplate.mockRejectedValue(new Error('down'));
    await renderPage();
    expect(screen.queryByTestId('start-from')).toBeNull();
    // Not past Name & number without a name and a number.
    expect(stepCard('Agents & timing').disabled).toBe(true);
    typeName();
    tick(N1);
    goToStep('Agents & timing');
    expect((screen.getByRole('radio', { name: '9 AM – 8 PM' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId(/^section-source-/)).toBeNull();
    await save();
    expect(createBody()).not.toHaveProperty('template_id');
  });
});

describe('step 3’s starting points are not templates (CS20)', () => {
  it('calls its cards “What is this campaign for?” and never says template', async () => {
    await renderPage();
    typeName();
    goToStep('Purpose & buttons');
    const step = screen.getByTestId('purpose-buttons-step');
    expect(within(step).getByRole('heading', { name: 'What is this campaign for?' })).toBeTruthy();
    expect(screen.getByTestId('purpose-presets').textContent).not.toMatch(/template/i);
    // Only the source chip in the buttons' heading names a template, as every step's chips do.
    const words = step.cloneNode(true) as HTMLElement;
    words.querySelectorAll('[data-testid^="section-source-"]').forEach((node) => node.remove());
    expect(words.textContent).not.toMatch(/template/i);
  });
});

/** A second account template that sets other numbers. */
const OTHER = summary({ id: 'acc-2', name: 'Mumbai sales', version: 1 });
const FROM_OTHER = effective({ id: 'acc-2', name: 'Mumbai sales', version: 1, scope: 'account' }, {
  numbers: { caller_ids: ['+912200000001'], telephony_provider: 'voicelink', telephony_credential_id: null },
}, ORG_SECTIONS);

const NUMBERS = 'caller-id-field';

describe('the numbers picked on Name & number (CTC2)', () => {
  beforeEach(() => {
    mocks.listCampaignTemplates.mockResolvedValue([ACCOUNT, OTHER, ORG]);
    mocks.getEffectiveCampaignTemplate.mockImplementation(async (id: string | null) =>
      (id === 'acc-1' || id === null ? FROM_ACCOUNT : id === 'acc-2' ? FROM_OTHER : FROM_ORG));
  });

  it('are not a change while the start leaves numbers built-in: no chip, no Reset, no question on a switch', async () => {
    // The organisation's default: it sets no numbers.
    mocks.getEffectiveCampaignTemplate.mockImplementation(async (id: string | null) => (id === 'acc-1' ? FROM_ACCOUNT : FROM_ORG));
    await renderPage();
    typeName();
    tick(N1);
    expect(block(NUMBERS).queryByTestId('section-source-chip')).toBeNull();
    expect(resetIn(NUMBERS, 'numbers to call from')).toBeNull();

    await pickStart('__builtin__');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('start-from-banner').textContent).toContain('Filled in from the built-in settings.');
    expect(ticked(N1)).toBe(true);
  });

  it('survive a Reset of another section', async () => {
    mocks.getEffectiveCampaignTemplate.mockImplementation(async () => FROM_ORG);
    await renderPage();
    typeName();
    tick(N2);
    goToStep('Agents & timing');
    fireEvent.change(startInput(), { target: { value: '07:00' } });
    fireEvent.click(resetIn(AGENTS_BLOCKS.hours, 'calling hours')!);
    goToStep('Name & number');
    expect(ticked(N2)).toBe(true);
  });

  it('are replaced by a template that sets numbers, without asking when the operator picked none of their own', async () => {
    await renderPage();
    expect(ticked(N2)).toBe(true);
    await pickStart('acc-2');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ticked(N1)).toBe(true);
    expect(ticked(N2)).toBe(false);
  });

  async function pickedOwnThenSwitch() {
    await renderPage();
    // Pune collections sets +912200000002; the operator adds +912200000001.
    tick(N1);
    await pickStart('acc-2');
  }

  it('are replaced by a template that sets other numbers only after asking, when the operator picked their own', async () => {
    await pickedOwnThenSwitch();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('You changed a section of these settings.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start from it' }));
    await act(async () => {});
    expect(ticked(N1)).toBe(true);
    expect(ticked(N2)).toBe(false);
  });

  it('stay when that question is answered Cancel', async () => {
    await pickedOwnThenSwitch();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(ticked(N1)).toBe(true);
    expect(ticked(N2)).toBe(true);
    expect(startSelect().value).toBe('acc-1');
  });

  it('go back to the template’s with the Reset on the numbers block', async () => {
    await renderPage();
    typeName();
    tick(N1);
    tick(N2);
    expect(chip(NUMBERS)).toBe('Changed for this campaign');
    fireEvent.click(resetIn(NUMBERS, 'numbers to call from')!);
    expect(chip(NUMBERS)).toBe('Account template');
    expect(ticked(N2)).toBe(true);
    expect(ticked(N1)).toBe(false);
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
    typeName();
    tick(N1);
    goToStep('Agents & timing');
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(startInput(), { target: { value: '07:00' } });
    fireEvent.change(screen.getByTestId('daily-target'), { target: { value: '25' } });

    await act(async () => land(FROM_ACCOUNT));
    expect(startSelect().value).toBe('acc-1');
    // The hours and the target typed stay; the wrap-up nobody touched comes from the template.
    expect(startInput().value).toBe('07:00');
    expect((screen.getByTestId('daily-target') as HTMLInputElement).value).toBe('25');
    expect(chip(AGENTS_BLOCKS.hours)).toBe('Changed for this campaign');
    expect(chip(AGENTS_BLOCKS.dailyTarget)).toBe('Changed for this campaign');
    expect(chip(AGENTS_BLOCKS.wrapup)).toBe('Organisation template');
    // The number ticked stays in place of the template's.
    goToStep('Name & number');
    expect(chip(NUMBERS)).toBe('Changed for this campaign');
    await save();
    const body = createBody();
    expect(body.template_id).toBe('acc-1');
    expect(body.caller_ids).toEqual(['+912200000001']);
    expect(body.calling_window_start).toBe('07:00');
    expect(body.wrapup_seconds).toBe(45);
    expect(body.daily_target_calls).toBe(25);
  });
});

/** Serve the check and its import: "Add 3 customers" imports the file and the import completes. */
function serveJobs() {
  const jobs = new Map([check(), imported()].map((j) => [j.job_id, j]));
  mocks.getIngestJob.mockImplementation(async (id: string) => {
    const found = jobs.get(id);
    if (!found) throw new Error(`no job ${id}`);
    return found;
  });
}

/** On Customers: drop a file, tick `facts` for the card, and add the customers, which makes the draft. */
async function addCustomers(facts: string[] = []) {
  goToStep('Customers');
  dropCsv();
  await screen.findByRole('button', { name: 'Add 3 customers' }, { timeout: 4000 });
  for (const fact of facts) fireEvent.click(screen.getByRole('switch', { name: `Show ${fact} to agents` }));
  fireEvent.click(footerButton('Add 3 customers'));
  await waitFor(() => expect(mocks.importCheckedFile).toHaveBeenCalled());
  await waitFor(() => expect(currentStep()).toBe('purpose'), { timeout: 4000 });
}

function withRoster(analysis: AgencyColumnAnalysis = ANALYSIS) {
  mocks.uploadRosterCsv.mockResolvedValue({ s3_key: 'k', file_name: 'collections_aug.csv', dedupe_columns: [], file_size_bytes: 10 });
  mocks.analyzeRosterColumns.mockResolvedValue(analysis);
  mocks.startRosterIngest.mockResolvedValue({ job_id: 'check-1', status: 'pending' });
  mocks.importCheckedFile.mockResolvedValue({ job_id: 'import-1', status: 'pending', check_job_id: 'check-1', already_started: false });
  serveJobs();
}

describe('the draft a roster upload makes (CTC1)', () => {
  beforeEach(() => withRoster());

  it('is created with the template named, and Save as draft then sends the hours changed after it', async () => {
    await renderPage();
    typeName();
    await addCustomers();
    expect(createBody()).toMatchObject({ template_id: 'acc-1', calling_window_start: '10:00' });
    // Locked once the draft exists, and says so (CS17).
    expect(startSelect().disabled).toBe(true);
    expect(screen.getByTestId('start-from').textContent).toContain('The draft is made. Change its settings in the steps below.');

    goToStep('Agents & timing');
    fireEvent.change(startInput(), { target: { value: '11:00' } });
    expect(chip(AGENTS_BLOCKS.hours)).toBe('Changed for this campaign');
    await save();
    expect(mocks.createAgencyCampaign).toHaveBeenCalledTimes(1);
    const patch = mocks.updateAgencyCampaign.mock.calls.at(-1)!;
    expect(patch[0]).toBe('camp-1');
    expect(patch[1]).toMatchObject({ calling_window_start: '11:00', calling_window_end: '20:00', wrapup_seconds: 45 });
  });

  it('names only the template while a setting is still being fixed: the server fills the rest from it, and Save as draft sends them', async () => {
    await renderPage();
    typeName();
    goToStep('Agents & timing');
    // Start and end the same: the hours cannot be saved yet.
    fireEvent.change(startInput(), { target: { value: '20:00' } });
    await addCustomers();
    expect(Object.keys(createBody()).sort()).toEqual([
      'abandonment_ceiling_pct', 'abandonment_grace_ms', 'caller_ids', 'name', 'telephony_credential_id', 'telephony_provider', 'template_id',
    ]);
    expect(createBody().template_id).toBe('acc-1');
    goToStep('Agents & timing');
    fireEvent.change(startInput(), { target: { value: '10:00' } });
    await save();
    expect(lastPatch()).toMatchObject({ calling_window_start: '10:00', wrapup_seconds: 45 });
  });
});

describe('the built-in settings', () => {
  it('are named on the create as template_id null', async () => {
    await renderPage();
    await pickStart('__builtin__');
    typeName();
    tick(N1);
    await save();
    const body = createBody();
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
describe('a template’s script on Purpose & buttons (CS19, CTC10)', () => {
  const OPENING = 'Hello {name}. Your {amount_due} is due on {due_date}.';
  const SCRIPTED = effective({ id: 'acc-1', name: 'Pune collections', version: 4, scope: 'account' }, {
    ...ACCOUNT_SECTIONS,
    agent_screen: { agent_script: { opening: OPENING } },
  }, ORG_SECTIONS);
  let stored: Record<string, unknown> = {};

  /** A roster whose card can hold the script's keys. */
  const WITH_AMOUNTS: AgencyColumnAnalysis = {
    ...ANALYSIS,
    headers: [...ANALYSIS.headers, 'Amount Due', 'Due Date'],
    columns: [
      ...ANALYSIS.columns,
      { name: 'Amount Due', index: 4, samples: ['12000'], non_empty: 100, phone_score: 0, distinct: 100, distinct_phones: 0 },
      { name: 'Due Date', index: 5, samples: ['2026-12-01'], non_empty: 100, phone_score: 0, distinct: 100, distinct_phones: 0 },
    ],
  };

  beforeEach(() => {
    mocks.getEffectiveCampaignTemplate.mockResolvedValue(SCRIPTED);
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

  it('shows the template’s script under the buttons, read-only with Edit, carrying the agent screen chip', async () => {
    await renderPage();
    typeName();
    goToStep('Purpose & buttons');
    const card = screen.getByTestId('builder-script');
    // Under the buttons step, as Settings shows its Script.
    expect(screen.getByTestId('purpose-buttons-step').compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getByTestId('script-summary').textContent).toContain(OPENING);
    expect(chip('builder-script')).toBe('Account template');
    fireEvent.click(within(card).getByRole('button', { name: 'Edit the script' }));
    fireEvent.change(within(card).getByLabelText('Opening line'), { target: { value: 'Hello {name}.' } });
    expect(chip('builder-script')).toBe('Changed for this campaign');
    await save();
    expect(createBody().agent_script).toEqual({ opening: 'Hello {name}.' });
  });

  it('shows no script card for a template without one', async () => {
    mocks.getEffectiveCampaignTemplate.mockResolvedValue(FROM_ACCOUNT);
    await renderPage();
    typeName();
    goToStep('Purpose & buttons');
    expect(screen.queryByTestId('builder-script')).toBeNull();
  });

  it('imports the roster all the same, then holds the script back on Purpose & buttons, marks the step, and the saves wait for the fix', async () => {
    withRoster();
    await renderPage();
    typeName();
    expect(mocks.createAgencyCampaign.mock.calls[0]?.[0]).toBeUndefined();
    await addCustomers(['Internal Score']);
    expect(screen.queryByTestId('builder-error')).toBeNull();
    expect(createBody().agent_script).toEqual({ opening: OPENING });
    // The card's save carried an empty script: the draft has none for now.
    expect(stored.agent_script).toEqual({});

    // Purpose & buttons is marked, and the saves wait, pointing at it from another step.
    expect(stepCard('Purpose & buttons').getAttribute('aria-label')).toMatch(/needs fixing/);
    goToStep('Agents & timing');
    expect(saveDraftButton().disabled).toBe(true);
    expect(footerButton('Start campaign').disabled).toBe(true);
    expect(footer().getByTestId('script-block').textContent).toContain('Change the script on Purpose & buttons before you save.');
    fireEvent.click(footer().getByRole('button', { name: /^Go to Purpose & buttons/ }));
    expect(currentStep()).toBe('purpose');
    expect(footer().getByTestId('script-block').textContent).toContain('Change the script below before you save.');

    const problem = screen.getByTestId('script-problem');
    // Said as a status: it changes as the script is typed, and an alert would be read out at each key (U12).
    expect(problem.getAttribute('role')).toBe('status');
    expect(problem.textContent).toContain(
      'The script uses {amount_due} and {due_date}, which are not facts on the card. Add them as facts or take them out.',
    );
    // The editor is open on the card's keys.
    fireEvent.change(screen.getByLabelText('Opening line'), { target: { value: 'Hello {name}. Your {internal_score} is due.' } });
    expect(screen.queryByTestId('script-problem')).toBeNull();
    expect(screen.queryByTestId('script-block')).toBeNull();
    expect(chip('builder-script')).toBe('Changed for this campaign');
    expect(stepCard('Purpose & buttons').getAttribute('aria-label')).not.toMatch(/needs fixing/);
    expect(saveDraftButton().disabled).toBe(false);
    await save();
    expect(screen.queryByTestId('builder-error')).toBeNull();
    expect(stored.agent_script).toEqual({ opening: 'Hello {name}. Your {internal_score} is due.' });
  });

  it('keeps the script whole when the card has its keys', async () => {
    withRoster(WITH_AMOUNTS);
    await renderPage();
    typeName();
    await addCustomers(['Amount Due', 'Due Date']);
    expect(screen.queryByTestId('builder-error')).toBeNull();
    expect(screen.queryByTestId('script-problem')).toBeNull();
    expect(screen.queryByTestId('script-block')).toBeNull();
    expect(stored.agent_script).toEqual({ opening: OPENING });
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1]).not.toHaveProperty('agent_script');
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
  const summarySelect = () => screen.getByRole('combobox', { name: 'Call summary' }) as HTMLSelectElement;
  const recordSwitch = () => within(screen.getByTestId('record-row')).getByRole('switch') as HTMLButtonElement;

  beforeEach(() => {
    mocks.getEffectiveCampaignTemplate.mockImplementation(async (id: string | null) => (id === 'org-1' ? FROM_ORG : PROFILED));
  });

  it('fills the picker, carries the template’s chip on both rows, and is sent on the create and the save', async () => {
    await renderPage();
    typeName();
    goToStep('Agents & timing');
    expect(recordSwitch().getAttribute('aria-checked')).toBe('true');
    expect(summarySelect().value).toBe('prof-collections');
    expect(chip(AGENTS_BLOCKS.record)).toBe('Account template');
    expect(chip(AGENTS_BLOCKS.summary)).toBe('Account template');
    // Filled in, not typed: nothing to warn about.
    expect(screen.queryByTestId('draft-note')).toBeNull();

    await save();
    expect(createBody()).toMatchObject({ template_id: 'acc-1', record_calls: true, analysis_profile_id: 'prof-collections' });
    expect(lastPatch()).toMatchObject({ record_calls: true, analysis_profile_id: 'prof-collections' });
  });

  it('marks the recording section changed when the profile is changed, and sends the one picked', async () => {
    await renderPage();
    typeName();
    goToStep('Agents & timing');
    fireEvent.change(summarySelect(), { target: { value: 'prof-default' } });
    expect(chip(AGENTS_BLOCKS.record)).toBe('Changed for this campaign');
    expect(chip(AGENTS_BLOCKS.summary)).toBe('Changed for this campaign');
    expect(chipSource(AGENTS_BLOCKS.record)).toBe('campaign');
    await save();
    expect(createBody()).toMatchObject({ record_calls: true, analysis_profile_id: 'prof-default' });
  });

  it('puts the template’s profile back, with the flag, on the Reset of Recording', async () => {
    await renderPage();
    typeName();
    goToStep('Agents & timing');
    fireEvent.click(recordSwitch());
    fireEvent.change(summarySelect(), { target: { value: '__none__' } });
    expect(chip(AGENTS_BLOCKS.record)).toBe('Changed for this campaign');
    fireEvent.click(resetIn(AGENTS_BLOCKS.record, 'recording')!);
    expect(chip(AGENTS_BLOCKS.record)).toBe('Account template');
    expect(chip(AGENTS_BLOCKS.summary)).toBe('Account template');
    expect(recordSwitch().getAttribute('aria-checked')).toBe('true');
    expect(summarySelect().value).toBe('prof-collections');
  });

  it('asks before replacing a profile the operator changed, and a template without one clears it', async () => {
    await renderPage();
    typeName();
    goToStep('Agents & timing');
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
    typeName();
    goToStep('Agents & timing');
    expect(summarySelect().value).toBe('__none__');
    expect(chip(AGENTS_BLOCKS.summary)).toBe('Account template');
    await save();
    expect(createBody()).toMatchObject({ record_calls: true, analysis_profile_id: null });
  });
});
