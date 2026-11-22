import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type {
  AgencyCampaignTemplate,
  AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { builtinTemplateSections, resolveTemplateSections } from '@magick-agency/domain/campaign-templates';

/**
 * Settings › Campaign templates (`docs/campaign-templates.md` §7): the list (default badge, what an
 * account template is based on, the sections it sets, who changed it and its version, Make default,
 * Archive, Restore, the organisation's templates read-only), "New template", and the editor (one
 * card per section with its summary, "Use …" / "Set in this template", Save with the version it
 * opened and "Reload the latest version" on a 409, History's comparison, Apply to draft campaigns
 * with its preview and results). Hidden with the flag off, and the organisation's page from anyone
 * without an organisation-wide seat of tenant admin or above.
 */

const mocks = vi.hoisted(() => ({
  tenant: {
    tenantId: 't-1', accountId: 'a-1', role: 'account_admin', organisationRole: undefined as string | undefined,
    accounts: [{ id: 'a-1', name: 'Pune', tenant_id: 't-1' }],
  },
  flags: { agency_campaign_templates_enabled: true } as Record<string, boolean>,
  showToast: vi.fn(),
  listCampaignTemplates: vi.fn(),
  getCampaignTemplate: vi.fn(),
  createCampaignTemplate: vi.fn(),
  replaceCampaignTemplate: vi.fn(),
  setCampaignTemplateDefault: vi.fn(),
  archiveCampaignTemplate: vi.fn(),
  restoreCampaignTemplate: vi.fn(),
  listCampaignTemplateVersions: vi.fn(),
  getCampaignTemplateVersion: vi.fn(),
  getEffectiveCampaignTemplate: vi.fn(),
  applyCampaignTemplate: vi.fn(),
  listAgencyCampaigns: vi.fn(),
  getAgencyCampaign: vi.fn(),
  track: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: () => mocks.tenant }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true }));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: () => ({ isEnabled: () => true, loading: false }) }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }) }));
vi.mock('../../components/common/CapabilityUnavailable', () => ({ CapabilityUnavailable: () => <div data-testid="capability-unavailable" /> }));
vi.mock('../../components/common/PageDescription', () => ({ PageDescription: () => null }));
vi.mock('../../hooks/useAgencyCarriers', () => ({ useAgencyCarriers: () => ({ carriers: [], error: null }) }));
vi.mock('../../hooks/usePhoneNumbers', () => ({ usePhoneNumbers: () => ({ phoneNumbers: [], loading: false, error: null, reload: vi.fn() }) }));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({ useCallAnalysisProfiles: () => ({ profiles: [], loading: false, error: null }) }));
vi.mock('../../analytics/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../analytics/events')>()),
  trackAgencyCampaignTemplateSaved: (p: unknown) => mocks.track('saved', p),
  trackAgencyCampaignTemplateAction: (p: unknown) => mocks.track('action', p),
  trackAgencyCampaignTemplateApplied: (p: unknown) => mocks.track('applied', p),
}));
vi.mock('../../api/campaignTemplates', () => ({
  listCampaignTemplates: mocks.listCampaignTemplates,
  getCampaignTemplate: mocks.getCampaignTemplate,
  createCampaignTemplate: mocks.createCampaignTemplate,
  replaceCampaignTemplate: mocks.replaceCampaignTemplate,
  setCampaignTemplateDefault: mocks.setCampaignTemplateDefault,
  archiveCampaignTemplate: mocks.archiveCampaignTemplate,
  restoreCampaignTemplate: mocks.restoreCampaignTemplate,
  listCampaignTemplateVersions: mocks.listCampaignTemplateVersions,
  getCampaignTemplateVersion: mocks.getCampaignTemplateVersion,
  getEffectiveCampaignTemplate: mocks.getEffectiveCampaignTemplate,
  applyCampaignTemplate: mocks.applyCampaignTemplate,
}));
vi.mock('../../api/agencyCampaigns', () => ({
  listAgencyCampaigns: mocks.listAgencyCampaigns,
  getAgencyCampaign: mocks.getAgencyCampaign,
}));

import CampaignTemplatesPage from '../../pages/settings/campaign-templates/CampaignTemplatesPage';
import CampaignTemplateEditorPage from '../../pages/settings/campaign-templates/CampaignTemplateEditorPage';

const PRIYA = { user_id: 'u-1', name: 'Priya' };

const summary = (over: Partial<AgencyCampaignTemplateSummary>): AgencyCampaignTemplateSummary => ({
  id: 'x',
  scope: 'account',
  account_id: 'a-1',
  name: 'x',
  description: null,
  is_default: false,
  version: 1,
  based_on: null,
  sections_set: [],
  created_at: '2026-11-01T09:00:00Z',
  updated_at: '2026-11-18T16:12:00Z',
  updated_by: PRIYA,
  archived_at: null,
  archived_by: null,
  ...over,
});

const ACCOUNT = summary({ id: 'acc-1', name: 'Pune collections', is_default: true, version: 4, sections_set: ['hours'] });
const SPARE = summary({ id: 'acc-2', name: 'Weekend push', version: 1, based_on: { id: 'org-2', name: 'Recovery', version: 3, archived: false }, sections_set: [] });
const ORG = summary({ id: 'org-1', scope: 'organisation', account_id: null, name: 'Standard', is_default: true, version: 2, sections_set: ['wrapup'] });

const HOURS = { calling_window_start: '10:00', calling_window_end: '20:00', calling_days: [1, 2, 3, 4, 5, 6], default_timezone: 'Asia/Kolkata' };
const ORG_SECTIONS = { wrapup: { wrapup_seconds: 45, wrapup_auto_return: true, allow_wrapup_redial: false } };

const DETAIL: AgencyCampaignTemplate = {
  ...ACCOUNT,
  sections: { hours: HOURS },
  follows: { id: 'org-1', name: 'Standard', version: 2, via: 'organisation_default', archived: false, sections: ORG_SECTIONS },
};

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

async function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/campaign-templates" element={<CampaignTemplatesPage scope="account" />} />
        <Route path="/settings/campaign-templates/:id" element={<CampaignTemplateEditorPage scope="account" />} />
        <Route path="/settings/organisation-campaign-templates" element={<CampaignTemplatesPage scope="organisation" />} />
        <Route path="/settings/organisation-campaign-templates/:id" element={<CampaignTemplateEditorPage scope="organisation" />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {});
}

const apiError = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(String(body.message ?? 'refused')), { statusCode: status, details: body });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
  mocks.tenant = {
    tenantId: 't-1', accountId: 'a-1', role: 'account_admin', organisationRole: undefined, accounts: [{ id: 'a-1', name: 'Pune', tenant_id: 't-1' }],
  };
  mocks.flags = { agency_campaign_templates_enabled: true };
  mocks.listCampaignTemplates.mockImplementation(async (_t: string, _a: string, o?: { archived?: boolean }) =>
    o?.archived ? [summary({ id: 'acc-9', name: 'Old Diwali', archived_at: '2026-11-10T08:00:00Z', archived_by: PRIYA })] : [ACCOUNT, SPARE, ORG]);
  mocks.getCampaignTemplate.mockImplementation(async (id: string) =>
    id === 'acc-1' ? DETAIL : id === 'org-1' ? { ...ORG, sections: ORG_SECTIONS, follows: null } : { ...SPARE, sections: {}, follows: null });
  mocks.setCampaignTemplateDefault.mockResolvedValue({ template: SPARE, replaced: null });
  mocks.restoreCampaignTemplate.mockResolvedValue({ template: SPARE });
  mocks.replaceCampaignTemplate.mockImplementation(async (_id: string, _scope: string, body: { sections: object }) => ({
    ...DETAIL, version: 5, sections: body.sections,
  }));
  mocks.createCampaignTemplate.mockImplementation(async (body: { name: string; sections: object }) => ({
    ...DETAIL, id: 'acc-new', name: body.name, version: 1, sections: body.sections,
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('the list', () => {
  it('shows each template with its default badge, what it follows, the sections it sets and who changed it', async () => {
    await renderAt('/settings/campaign-templates');
    const row = screen.getByTestId('template-row-acc-1');
    expect(row.textContent).toContain('Pune collections');
    expect(within(row).getByText('Account default')).toBeTruthy();
    expect(row.textContent).toContain('Follows the organisation’s default');
    expect(within(row).getByRole('list', { name: 'Sections it sets' }).textContent).toBe('Calling hours');
    expect(row.textContent).toContain('Changed by Priya on 18 Nov, 4:12 PM · version 4');
    expect(within(row).getByRole('link', { name: 'Edit Pune collections' }).getAttribute('href')).toBe('/settings/campaign-templates/acc-1');
    expect(screen.getByTestId('template-row-acc-2').textContent).toContain('Based on Recovery');
  });

  it('lists the organisation’s templates read-only, under “From the organisation”, each with View (L4)', async () => {
    await renderAt('/settings/campaign-templates');
    const section = screen.getByRole('region', { name: 'From the organisation' });
    const row = within(section).getByTestId('template-row-org-1');
    expect(row.textContent).toContain('Standard');
    expect(within(row).queryByRole('button')).toBeNull();
    expect(within(row).getAllByRole('link').map((a) => [a.getAttribute('aria-label'), a.getAttribute('href')])).toEqual([
      ['View Standard', '/settings/campaign-templates/org-1'],
    ]);
    // Its default is the organisation's, not this account's (C4).
    expect(within(row).getByText('Organisation default')).toBeTruthy();
    expect(within(row).queryByText('Account default')).toBeNull();
  });

  it('never shows one view’s rows under the other view’s actions, while it loads or when it fails (U5)', async () => {
    let fail: (err: Error) => void = () => {};
    mocks.listCampaignTemplates.mockImplementation((_t: string, _a: string, o?: { archived?: boolean }) =>
      (o?.archived ? new Promise((_resolve, reject) => { fail = reject; }) : Promise.resolve([ACCOUNT, SPARE, ORG])));
    await renderAt('/settings/campaign-templates');
    expect(screen.getByTestId('template-row-acc-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await act(async () => {});
    expect(screen.queryByTestId('template-row-acc-1')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
    await act(async () => {
      fail(new Error('The templates could not be read.'));
    });
    expect(screen.getByText('The templates could not be read.')).toBeTruthy();
    expect(screen.queryByTestId('template-row-acc-1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore Pune collections' })).toBeNull();
  });

  it('names the template on “Stop using as default” (N3)', async () => {
    await renderAt('/settings/campaign-templates');
    expect(within(screen.getByTestId('template-row-acc-1')).getByRole('button', { name: 'Stop using Pune collections as the default' })).toBeTruthy();
  });

  it('opens on what new campaigns of the account start from now, section by section (L4)', async () => {
    const resolved = resolveTemplateSections({
      chosen: { scope: 'account', sections: DETAIL.sections }, basedOn: { sections: ORG_SECTIONS }, builtin: builtinTemplateSections(), can: { record: true, assignment: true, inbound: true },
    });
    mocks.getEffectiveCampaignTemplate.mockResolvedValue({
      template: { id: 'acc-1', name: 'Pune collections', version: 4, scope: 'account' },
      based_on: { id: 'org-1', name: 'Standard', version: 2 },
      config: resolved.config,
      sources: resolved.sources,
      notes: [{ code: 'recording_not_allowed', section: 'recording' }],
    });
    await renderAt('/settings/campaign-templates');
    expect(mocks.getEffectiveCampaignTemplate).toHaveBeenCalledWith(null, 't-1', 'a-1');
    const card = screen.getByRole('region', { name: 'New campaigns in this account start from' });
    expect(within(card).getByTestId('effective-start-name').textContent).toBe('Pune collections · based on Standard');
    const line = (key: string) => [...within(card).getByTestId(`effective-${key}`).children].map((c) => c.textContent);
    expect(line('hours')).toEqual(['Calling hours', 'Account template', '10:00 AM–8:00 PM · Mon to Sat · India time (IST)']);
    expect(line('wrapup')).toEqual(['Wrap-up', 'Organisation template', '45s, then agents return on their own']);
    expect(line('retries')).toEqual(['Retries', 'Built-in', 'The built-in retry rules']);
    expect(line('numbers')).toEqual(['Numbers to call from', 'Each campaign', 'Each new campaign picks its own numbers']);
    // Only the sections shown here: contact assignment is off.
    expect(within(card).queryByTestId('effective-assignment')).toBeNull();
    expect(within(card).getByTestId('effective-start-notes').textContent).toBe('Recording is off for this account, so this campaign starts with recording off.');
    // A new default moves the chain: read it again.
    fireEvent.click(screen.getByRole('button', { name: 'Make Weekend push the default' }));
    await act(async () => {});
    expect(mocks.getEffectiveCampaignTemplate).toHaveBeenCalledTimes(2);
  });

  it('says “Built-in settings” when no default is in the chain, and is not on the organisation’s page', async () => {
    mocks.getEffectiveCampaignTemplate.mockResolvedValue({
      template: null, based_on: null, config: resolveTemplateSections({ chosen: null, basedOn: null, builtin: builtinTemplateSections(), can: { record: true, assignment: true, inbound: true } }).config,
      sources: Object.fromEntries(['outcomes', 'retries', 'hours', 'wrapup', 'breaks', 'recording', 'agent_screen', 'safety', 'assignment', 'inbound', 'numbers'].map((k) => [k, 'builtin'])),
      notes: [],
    });
    await renderAt('/settings/campaign-templates');
    expect(screen.getByTestId('effective-start-name').textContent).toBe('Built-in settings');
    cleanup();
    mocks.tenant = { ...mocks.tenant, role: 'tenant_admin', organisationRole: 'tenant_admin' };
    mocks.getEffectiveCampaignTemplate.mockClear();
    await renderAt('/settings/organisation-campaign-templates');
    expect(screen.queryByTestId('effective-start')).toBeNull();
    expect(mocks.getEffectiveCampaignTemplate).not.toHaveBeenCalled();
  });

  it('makes a template the default, then reads the list again', async () => {
    await renderAt('/settings/campaign-templates');
    fireEvent.click(screen.getByRole('button', { name: 'Make Weekend push the default' }));
    await act(async () => {});
    expect(mocks.setCampaignTemplateDefault).toHaveBeenCalledWith('acc-2', 'account', true, 't-1', 'a-1');
    expect(mocks.showToast).toHaveBeenCalledWith(
      '“Weekend push” is now this account’s default. New campaigns in this account start from it.',
      'success',
    );
    expect(mocks.listCampaignTemplates).toHaveBeenCalledTimes(2);
    expect(mocks.track).toHaveBeenCalledWith('action', { scope: 'account', action: 'make_default' });
  });

  it('says what making an organisation template the default changes: accounts with no default of their own', async () => {
    mocks.tenant = { ...mocks.tenant, role: 'tenant_admin', organisationRole: 'tenant_admin' };
    mocks.listCampaignTemplates.mockResolvedValue([ORG, summary({ id: 'org-2', scope: 'organisation', account_id: null, name: 'Recovery' })]);
    await renderAt('/settings/organisation-campaign-templates');
    expect(within(screen.getByTestId('template-row-org-1')).getByText('Organisation default')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make Recovery the default' }));
    await act(async () => {});
    expect(mocks.setCampaignTemplateDefault).toHaveBeenCalledWith('org-2', 'organisation', true, 't-1', 'a-1');
    expect(mocks.showToast).toHaveBeenCalledWith(
      '“Recovery” is now the organisation default. New campaigns start from it in accounts with no default of their own.',
      'success',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop using Standard as the default' }));
    await act(async () => {});
    expect(mocks.showToast).toHaveBeenLastCalledWith(
      '“Standard” is no longer the organisation default. Accounts with no default of their own now start new campaigns from the built-in settings.',
      'success',
    );
  });

  it('archives after asking, and says which account templates stop an organisation template being archived', async () => {
    mocks.tenant = { ...mocks.tenant, role: 'tenant_admin', organisationRole: 'tenant_admin' };
    mocks.archiveCampaignTemplate.mockRejectedValue(apiError(409, {
      code: 'campaign_template_in_use',
      message: 'In use',
      templates: [{ id: 'acc-2', name: 'Weekend push', account_id: 'a-1', account_name: 'Pune' }],
    }));
    await renderAt('/settings/organisation-campaign-templates');
    fireEvent.click(screen.getByRole('button', { name: 'Archive Standard' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('New campaigns stop starting from it.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await act(async () => {});
    expect(mocks.archiveCampaignTemplate).toHaveBeenCalledWith('org-1', 'organisation', 't-1', 'a-1');
    expect(screen.getByRole('alert').textContent).toContain('Weekend push (Pune)');
  });

  it('lists archived templates with Restore', async () => {
    await renderAt('/settings/campaign-templates');
    // A filter of one list: two pressed buttons in a group, not tabs without panels (C9).
    const which = screen.getByRole('group', { name: 'Which templates' });
    expect(within(which).queryByRole('tab')).toBeNull();
    expect(within(which).getByRole('button', { name: 'Templates' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(which).getByRole('button', { name: 'Archived' }));
    await act(async () => {});
    expect(within(which).getByRole('button', { name: 'Archived' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(which).getByRole('button', { name: 'Templates' }).getAttribute('aria-pressed')).toBe('false');
    expect(mocks.listCampaignTemplates).toHaveBeenLastCalledWith('t-1', 'a-1', { archived: true });
    const row = screen.getByTestId('template-row-acc-9');
    expect(row.textContent).toContain('Archived by Priya on 10 Nov, 8:00 AM');
    fireEvent.click(within(row).getByRole('button', { name: 'Restore Old Diwali' }));
    await act(async () => {});
    expect(mocks.restoreCampaignTemplate).toHaveBeenCalledWith('acc-9', 'account', 't-1', 'a-1');
  });

  it('starts a new template from the Collections set', async () => {
    await renderAt('/settings/campaign-templates');
    fireEvent.click(screen.getByRole('button', { name: /New template/ }));
    fireEvent.click(screen.getByRole('radio', { name: /The Collections set/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'New campaign template' })).toBeTruthy();
    const outcomes = screen.getByTestId('template-section-outcomes');
    expect(outcomes.getAttribute('data-set')).toBe('true');
    expect(screen.getByTestId('template-summary-outcomes').textContent).toMatch(/^6 outcomes: Will pay, Call later/);
    expect((screen.getByLabelText('Name*') as HTMLInputElement).value).toBe('Collections');
    // Unset sections show what the organisation's default gives, dimmed.
    expect(screen.getByTestId('template-summary-wrapup').textContent).toBe('45s, then agents return on their own');
    expect(screen.getByTestId('template-summary-wrapup').hasAttribute('data-inherited')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    const body = mocks.createCampaignTemplate.mock.calls[0]![0];
    expect(body.scope).toBe('account');
    expect(body.name).toBe('Collections');
    expect(body.based_on_template_id).toBeNull();
    expect(Object.keys(body.sections)).toEqual(['outcomes']);
    expect(mocks.createCampaignTemplate.mock.calls[0]!.slice(1)).toEqual(['t-1', 'a-1']);
    await act(async () => {});
    // The editor moves to the template it made.
    expect(mocks.getCampaignTemplate).toHaveBeenCalledWith('acc-new', 't-1', 'a-1');
  });
});

describe('the editor', () => {
  it('opens each section with its summary, set or inherited, in the sections’ order', async () => {
    await renderAt('/settings/campaign-templates/acc-1');
    const cards = screen.getAllByTestId(/^template-section-/).map((c) => c.getAttribute('data-testid'));
    expect(cards).toEqual([
      'template-section-outcomes', 'template-section-retries', 'template-section-hours', 'template-section-wrapup',
      'template-section-breaks', 'template-section-recording', 'template-section-agent_screen', 'template-section-safety',
      'template-section-numbers',
    ]);
    expect(screen.getByTestId('template-summary-hours').textContent).toBe('10:00 AM–8:00 PM · Mon to Sat · India time (IST)');
    const hours = screen.getByTestId('template-section-hours');
    expect(within(hours).getByRole('radiogroup', { name: 'Calling hours: where it comes from' })).toBeTruthy();
    expect((within(hours).getByRole('radio', { name: 'Set in this template' }) as HTMLInputElement).checked).toBe(true);
    const wrapup = screen.getByTestId('template-section-wrapup');
    expect((within(wrapup).getByRole('radio', { name: 'Use the organisation’s default' }) as HTMLInputElement).checked).toBe(true);
    // Nothing changed: no Save.
    expect((screen.getByRole('button', { name: 'Save template' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sets a section and stops setting another, then saves the version it opened', async () => {
    await renderAt('/settings/campaign-templates/acc-1');
    const wrapup = screen.getByTestId('template-section-wrapup');
    fireEvent.click(within(wrapup).getByRole('radio', { name: 'Set in this template' }));
    // Set, the card opens on the existing editors, starting from what it inherited.
    expect((within(wrapup).getByLabelText(/Wrap-up seconds/) as HTMLInputElement).value).toBe('45');
    const hours = screen.getByTestId('template-section-hours');
    fireEvent.click(within(hours).getByRole('radio', { name: 'Use the organisation’s default' }));
    expect(screen.getByTestId('template-summary-hours').textContent).toBe('9:00 AM–8:00 PM · Mon to Fri · India time (IST)');

    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    const [id, scope, body] = mocks.replaceCampaignTemplate.mock.calls[0]!;
    expect([id, scope]).toEqual(['acc-1', 'account']);
    expect(body.expected_version).toBe(4);
    expect(Object.keys(body.sections)).toEqual(['wrapup']);
    expect(body.sections.wrapup).toEqual({ wrapup_seconds: 45, wrapup_auto_return: true, allow_wrapup_redial: false });
    expect(mocks.showToast).toHaveBeenCalledWith('“Pune collections” saved as version 5.', 'success');
    expect(mocks.track).toHaveBeenCalledWith('saved', { scope: 'account', created: false, sections_set: 1, version: 5 });
  });

  it('offers “Reload the latest version” when someone saved in between', async () => {
    mocks.replaceCampaignTemplate.mockRejectedValueOnce(apiError(409, { code: 'campaign_template_changed', message: 'Changed', current_version: 5 }));
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'For Pune' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    const banner = screen.getByTestId('template-conflict');
    expect(banner.textContent).toContain('Someone else saved this template after you opened it.');
    mocks.getCampaignTemplate.mockClear();
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload the latest version' }));
    await act(async () => {});
    await act(async () => {});
    expect(mocks.getCampaignTemplate).toHaveBeenCalledWith('acc-1', 't-1', 'a-1');
    expect(screen.queryByTestId('template-conflict')).toBeNull();
    expect((screen.getByLabelText('Description (optional)') as HTMLInputElement).value).toBe('');
  });

  it('saves a rename of a template whose script uses {amount_due} and {due_date}, which the server takes (U1)', async () => {
    const script = { opening: 'Your EMI of {amount_due} is due on {due_date}.' };
    mocks.getCampaignTemplate.mockImplementation(async (id: string) =>
      (id === 'acc-1' ? { ...DETAIL, sections: { ...DETAIL.sections, agent_screen: { agent_script: script } } } : { ...ORG, sections: ORG_SECTIONS, follows: null }));
    await renderAt('/settings/campaign-templates/acc-1');
    const screenCard = screen.getByTestId('template-section-agent_screen');
    expect(screenCard.getAttribute('data-invalid')).toBeNull();
    expect(screenCard.textContent).not.toMatch(/not a fact on the card/);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Pune EMI' } });
    expect(screen.queryByText('Fix the marked settings to save.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    const [, , body] = mocks.replaceCampaignTemplate.mock.calls[0]!;
    expect(body.name).toBe('Pune EMI');
    expect(body.sections.agent_screen.agent_script).toEqual(script);
  });

  it('keeps the name, description and Based on at the top, and only Discard and Save in the bar (U4)', async () => {
    await renderAt('/settings/campaign-templates/acc-1');
    const bar = screen.getByRole('region', { name: 'Save the template' });
    expect(within(bar).queryAllByRole('textbox')).toEqual([]);
    expect(within(bar).queryAllByRole('combobox')).toEqual([]);
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Discard', 'Save template']);
    const about = screen.getByRole('region', { name: 'About this template' });
    expect(within(about).getByLabelText(/^Name/)).toBeTruthy();
    expect(within(about).getByLabelText('Description (optional)')).toBeTruthy();
    expect(within(about).getByLabelText('Based on')).toBeTruthy();
    // Above the first section's card, so it scrolls away with the page.
    expect(about.compareDocumentPosition(screen.getByTestId('template-section-outcomes')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('marks a section with a field to fix in words, and takes the person to the field from the bar (U13)', async () => {
    mocks.getCampaignTemplate.mockImplementation(async (id: string) =>
      (id === 'acc-1'
        ? { ...DETAIL, sections: { ...DETAIL.sections, agent_screen: { agent_script: { opening: 'Your EMI {emi} is due' } } } }
        : { ...ORG, sections: ORG_SECTIONS, follows: null }));
    await renderAt('/settings/campaign-templates/acc-1');
    const card = screen.getByTestId('template-section-agent_screen');
    expect(card.getAttribute('data-invalid')).toBe('true');
    expect(within(card).getByText('Needs a fix')).toBeTruthy();
    expect(screen.getByTestId('template-section-hours').getAttribute('data-invalid')).toBeNull();
    fireEvent.click(screen.getByTestId('template-show-problem'));
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    expect(card.contains(document.activeElement)).toBe(true);
  });

  it('leaves unset numbers to each new campaign, and says so (U8)', async () => {
    await renderAt('/settings/campaign-templates/acc-1');
    const numbers = screen.getByTestId('template-section-numbers');
    expect((within(numbers).getByRole('radio', { name: 'Pick them in each campaign' }) as HTMLInputElement).checked).toBe(true);
    expect(within(numbers).queryByRole('radio', { name: /organisation/ })).toBeNull();
    expect(screen.getByTestId('template-summary-numbers').textContent).toBe('Each new campaign picks its own numbers');
    fireEvent.click(within(numbers).getByRole('radio', { name: 'Set in this template' }));
    expect(numbers.textContent).toContain('Pick at least one number, or let each new campaign pick its own.');
  });

  it('says when what it follows cannot be read, rather than showing built-in values under its name (U9)', async () => {
    const RECOVERY = summary({ id: 'org-2', scope: 'organisation', account_id: null, name: 'Recovery', version: 3, sections_set: ['wrapup'] });
    mocks.listCampaignTemplates.mockResolvedValue([ACCOUNT, SPARE, ORG, RECOVERY]);
    let recoveryReads = 0;
    mocks.getCampaignTemplate.mockImplementation(async (id: string) => {
      if (id === 'acc-2') return { ...SPARE, sections: {}, follows: null };
      recoveryReads += 1;
      if (recoveryReads === 1) throw new Error('down');
      return { ...RECOVERY, sections: { wrapup: { wrapup_seconds: 120, wrapup_auto_return: false, allow_wrapup_redial: true } }, follows: null };
    });
    await renderAt('/settings/campaign-templates/acc-2');
    await act(async () => {});
    expect(screen.getByText('Could not read Recovery, so the values it gives are not shown.')).toBeTruthy();
    expect(screen.getByTestId('template-summary-wrapup').textContent).toBe('Not shown: what it follows could not be read');
    fireEvent.click(screen.getByRole('button', { name: /Retry|Try again/ }));
    await act(async () => {});
    await act(async () => {});
    expect(screen.queryByText('Could not read Recovery, so the values it gives are not shown.')).toBeNull();
    expect(screen.getByTestId('template-summary-wrapup').textContent).toBe('120s, then agents mark themselves ready · Redial from wrap-up allowed');
  });

  it('puts a name the server refused under the Name field (N9)', async () => {
    mocks.replaceCampaignTemplate.mockRejectedValueOnce(apiError(400, {
      code: 'campaign_template_invalid', message: 'This template cannot be saved.', details: { name: 'The name has a character that cannot be shown. Take it out.' },
    }));
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Pune\u200b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    const about = screen.getByRole('region', { name: 'About this template' });
    expect(within(about).getByRole('alert').textContent).toBe('The name has a character that cannot be shown. Take it out.');
    expect(screen.queryByText('This template cannot be saved.')).toBeNull();
  });

  it('puts a section refusal on its card', async () => {
    mocks.replaceCampaignTemplate.mockRejectedValueOnce(apiError(400, {
      code: 'campaign_template_section_invalid', message: 'Invalid', sections: ['hours'], details: { calling_window_end: 'The end must differ from the start.' },
    }));
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    expect(screen.getByTestId('template-section-hours').getAttribute('data-invalid')).toBe('true');
    expect(screen.getByTestId('template-section-hours').textContent).toContain('The end must differ from the start.');
  });

  it('re-inherits the unset sections when “Based on” changes, and names what they use', async () => {
    const RECOVERY = summary({ id: 'org-2', scope: 'organisation', account_id: null, name: 'Recovery', version: 3, sections_set: ['wrapup'] });
    mocks.listCampaignTemplates.mockResolvedValue([ACCOUNT, SPARE, ORG, RECOVERY]);
    mocks.getCampaignTemplate.mockImplementation(async (id: string) =>
      (id === 'acc-1'
        ? DETAIL
        : { ...RECOVERY, sections: { wrapup: { wrapup_seconds: 120, wrapup_auto_return: false, allow_wrapup_redial: true } }, follows: null }));
    await renderAt('/settings/campaign-templates/acc-1');
    expect(screen.getByTestId('template-summary-wrapup').textContent).toBe('45s, then agents return on their own');
    fireEvent.change(screen.getByLabelText('Based on'), { target: { value: 'org-2' } });
    await act(async () => {});
    expect(mocks.getCampaignTemplate).toHaveBeenCalledWith('org-2', 't-1', 'a-1');
    expect(screen.getByTestId('template-summary-wrapup').textContent).toBe(
      '120s, then agents mark themselves ready · Redial from wrap-up allowed',
    );
    const wrapup = screen.getByTestId('template-section-wrapup');
    expect((within(wrapup).getByRole('radio', { name: 'Use Recovery' }) as HTMLInputElement).checked).toBe(true);
    // The set section keeps its own values.
    expect(screen.getByTestId('template-summary-hours').textContent).toBe('10:00 AM–8:00 PM · Mon to Sat · India time (IST)');
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    const body = mocks.replaceCampaignTemplate.mock.calls[0]![2];
    expect(body.based_on_template_id).toBe('org-2');
    expect(Object.keys(body.sections)).toEqual(['hours']);
  });

  it('asks before leaving with unsaved changes, and not once they are saved', async () => {
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'For Pune' } });
    fireEvent.click(screen.getByRole('link', { name: 'All templates' }));
    const dialog = screen.getByRole('dialog', { name: 'Leave without saving?' });
    expect(dialog.textContent).toContain('Your changes to this template are not saved.');
    fireEvent.click(within(dialog).getByRole('button', { name: /Cancel|Stay/ }));
    expect(screen.getByRole('heading', { name: 'Pune collections' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('link', { name: 'All templates' }));
    await act(async () => {});
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).toBeNull();
    expect(screen.getByTestId('template-row-acc-1')).toBeTruthy();
  });

  it('says the server’s sentence when what is archived is the template it is based on (C5)', async () => {
    mocks.replaceCampaignTemplate.mockRejectedValueOnce(apiError(409, {
      code: 'campaign_template_archived',
      message: 'The organisation template this is based on is archived. Choose another, or restore it first.',
    }));
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain(
      'The organisation template this is based on is archived. Choose another, or restore it first.',
    );
    expect(screen.queryByText('This template has been archived. Restore it first.')).toBeNull();
  });

  it('compares two versions, section by section, in plain words', async () => {
    mocks.listCampaignTemplateVersions.mockResolvedValue([
      { version: 4, name: 'Pune collections', based_on_template_id: null, sections_set: ['hours'], saved_at: '2026-11-18T16:12:00Z', saved_by: PRIYA },
      { version: 3, name: 'Pune collections', based_on_template_id: null, sections_set: ['hours'], saved_at: '2026-11-10T09:00:00Z', saved_by: null },
    ]);
    mocks.getCampaignTemplateVersion.mockResolvedValue({
      template_id: 'acc-1', version: 3, name: 'Pune collections', based_on_template_id: null, sections_set: ['hours'],
      saved_at: '2026-11-10T09:00:00Z', saved_by: null, sections: { hours: { ...HOURS, calling_window_start: '09:00' } },
    });
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByTestId('template-version-4').textContent).toBe('Version 4 · saved by Priya on 18 Nov, 4:12 PM · Calling hours');
    expect(mocks.getCampaignTemplateVersion).toHaveBeenCalledWith('acc-1', 3, 't-1', 'a-1');
    const row = within(screen.getByTestId('history-diff')).getByText('Calling hours').closest('li')!;
    expect(row.textContent).toContain('Changed: the start time');
    expect(row.textContent).toContain('9:00 AM–8:00 PM · Mon to Sat · India time (IST)');
    expect(row.textContent).toContain('10:00 AM–8:00 PM · Mon to Sat · India time (IST)');
  });

  it('applies to chosen drafts after a preview, then says each campaign’s result', async () => {
    const draft = { id: 'c-1', name: 'Diwali renewals', status: 'draft', calling_window_start: '09:00:00', calling_window_end: '20:00:00', calling_days: [1, 2, 3, 4, 5], default_timezone: 'UTC' };
    const other = { id: 'c-2', name: 'Old list', status: 'draft' };
    mocks.listAgencyCampaigns.mockResolvedValue([draft, other]);
    mocks.getAgencyCampaign.mockImplementation(async (id: string) => (id === 'c-1' ? draft : other));
    const resolved = resolveTemplateSections({ chosen: { scope: 'account', sections: DETAIL.sections }, basedOn: { sections: ORG_SECTIONS }, builtin: builtinTemplateSections(), can: { record: true, assignment: true, inbound: true } });
    mocks.getEffectiveCampaignTemplate.mockResolvedValue({ template: { id: 'acc-1', name: 'Pune collections', version: 4, scope: 'account' }, based_on: null, config: resolved.config, sources: resolved.sources, notes: [] });
    mocks.applyCampaignTemplate.mockResolvedValue({
      template: { id: 'acc-1', name: 'Pune collections', version: 4 },
      results: [
        { campaign_id: 'c-1', result: 'applied', changed_sections: ['hours'], template_source: { template: null, based_on: null, sections: {} } },
        { campaign_id: 'c-2', result: 'refused', code: 'campaign_not_draft', message: 'It has been started.' },
      ],
    });
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to draft campaigns…' }));
    await act(async () => {});
    expect(mocks.listAgencyCampaigns).toHaveBeenCalledWith('t-1', 'a-1', ['draft']);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Diwali renewals' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Old list' }));
    // The sections the template sets are chosen to start with.
    expect((within(dialog).getByRole('checkbox', { name: 'Calling hours' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('checkbox', { name: 'Outcomes' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(dialog).getByTestId('apply-preview'));
    await act(async () => {});
    expect(mocks.getEffectiveCampaignTemplate).toHaveBeenCalledWith('acc-1', 't-1', 'a-1');
    const diff = screen.getByTestId('apply-diff-c-1');
    expect(diff.textContent).toContain('Changed: the start time, the days and the time zone');
    fireEvent.click(screen.getByTestId('apply-confirm'));
    await act(async () => {});
    expect(mocks.applyCampaignTemplate).toHaveBeenCalledWith(
      'acc-1', { campaign_ids: ['c-1', 'c-2'], sections: ['hours'], expected_version: 4 }, 't-1', 'a-1',
    );
    const results = screen.getByTestId('apply-results');
    expect(results.textContent).toContain('Diwali renewals: Applied. Changed calling hours.');
    expect(results.textContent).toContain('Old list: Not changed. It has been started.');
    expect(mocks.track).toHaveBeenCalledWith('applied', { scope: 'account', campaign_count: 2, applied_count: 1, refused_count: 1, section_count: 1 });
  });

  it('fills every section from a campaign with “Copy from a campaign…”', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([{ id: 'c-1', name: 'Diwali renewals', status: 'running' }]);
    mocks.getAgencyCampaign.mockResolvedValue({ id: 'c-1', name: 'Diwali renewals', status: 'running', wrapup_seconds: 90, record_calls: true, caller_ids: ['+912200000001'] });
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.click(screen.getByRole('button', { name: 'Copy from a campaign…' }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy settings' }));
    await act(async () => {});
    expect(screen.getByTestId('template-summary-wrapup').textContent).toBe('90s, then agents return on their own');
    expect(screen.getByTestId('template-section-recording').getAttribute('data-set')).toBe('true');
    expect(screen.getByTestId('template-summary-recording').textContent).toBe('Every call is recorded');
    // Only the sections shown are set: contact assignment and inbound are off here (C6).
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    const keys = Object.keys(mocks.replaceCampaignTemplate.mock.calls[0]![2].sections);
    expect(keys).not.toContain('assignment');
    expect(keys).not.toContain('inbound');
    expect(keys).toContain('numbers');
  });

  it('copies a campaign whose script uses its card’s facts without the script, and says so (U2)', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([{ id: 'c-1', name: 'Diwali renewals', status: 'running' }]);
    mocks.getAgencyCampaign.mockResolvedValue({
      id: 'c-1', name: 'Diwali renewals', status: 'running', phone_display: 'masked', caller_ids: ['+912200000001'],
      agent_script: { opening: 'Your EMI {emi} is due' }, context_display: { facts: [{ key: 'emi', column: 'EMI', label: 'EMI' }] },
    });
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.click(screen.getByRole('button', { name: 'Copy from a campaign…' }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy settings' }));
    await act(async () => {});
    expect(screen.getByTestId('template-notice').textContent).toBe('This campaign’s script uses facts from its roster card, which a template cannot hold, so the template leaves the script out.');
    const card = screen.getByTestId('template-section-agent_screen');
    expect(card.getAttribute('data-set')).toBe('true');
    expect(card.getAttribute('data-invalid')).toBeNull();
    expect(screen.getByTestId('template-summary-agent_screen').textContent).toBe('Hidden number · No daily target · No script');
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    const saved = mocks.replaceCampaignTemplate.mock.calls[0]![2].sections.agent_screen;
    expect(saved.phone_display).toBe('masked');
    expect(saved.agent_script ?? {}).toEqual({});
  });

  it('names the numbers group, and lists the current version once in History (C12)', async () => {
    mocks.listCampaignTemplateVersions.mockResolvedValue([
      { version: 4, name: 'Pune collections', based_on_template_id: null, sections_set: ['hours'], saved_at: '2026-11-18T16:12:00Z', saved_by: PRIYA },
      { version: 3, name: 'Pune collections', based_on_template_id: null, sections_set: ['hours'], saved_at: '2026-11-10T09:00:00Z', saved_by: null },
    ]);
    mocks.getCampaignTemplateVersion.mockResolvedValue({
      template_id: 'acc-1', version: 3, name: 'Pune collections', based_on_template_id: null, sections_set: ['hours'],
      saved_at: '2026-11-10T09:00:00Z', saved_by: null, sections: { hours: HOURS },
    });
    await renderAt('/settings/campaign-templates/acc-1');
    const numbers = screen.getByTestId('template-section-numbers');
    fireEvent.click(within(numbers).getByRole('radio', { name: 'Set in this template' }));
    expect(within(numbers).getByRole('group', { name: 'Numbers to call from' })).toBeTruthy();
    expect(numbers.querySelector('label[for="template-caller-ids"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await act(async () => {});
    await act(async () => {});
    const options = [...(screen.getByLabelText('With') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(['Version 4 (now)', 'Version 3']);
  });

  it('compares a version’s name and “Based on” too, not only its sections (U11)', async () => {
    mocks.listCampaignTemplateVersions.mockResolvedValue([
      { version: 4, name: 'Pune collections', based_on_template_id: null, sections_set: ['hours'], saved_at: '2026-11-18T16:12:00Z', saved_by: PRIYA },
      { version: 3, name: 'Pune old', based_on_template_id: 'org-1', sections_set: ['hours'], saved_at: '2026-11-10T09:00:00Z', saved_by: null },
    ]);
    mocks.getCampaignTemplateVersion.mockResolvedValue({
      template_id: 'acc-1', version: 3, name: 'Pune old', based_on_template_id: 'org-1', sections_set: ['hours'],
      saved_at: '2026-11-10T09:00:00Z', saved_by: null, sections: { hours: HOURS },
    });
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await act(async () => {});
    await act(async () => {});
    expect(screen.queryByTestId('history-diff-empty')).toBeNull();
    const diff = screen.getByTestId('history-diff');
    const row = (key: string) => diff.querySelector(`li[data-section="${key}"]`)!.textContent;
    expect(row('name')).toBe('NameChangedVersion 3Pune oldVersion 4 (now)Pune collections');
    expect(row('based_on')).toBe('Based onChangedVersion 3StandardVersion 4 (now)The organisation’s default');
    expect(diff.querySelector('li[data-section="hours"]')).toBeNull();
  });

  it('says a template with one version has nothing to compare yet (N4)', async () => {
    mocks.listCampaignTemplateVersions.mockResolvedValue([
      { version: 4, name: 'Pune collections', based_on_template_id: null, sections_set: ['hours'], saved_at: '2026-11-18T16:12:00Z', saved_by: PRIYA },
    ]);
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await act(async () => {});
    expect(screen.getByTestId('history-only-version').textContent).toBe('This is the only version so far. Each save adds one you can compare with.');
    expect(screen.queryByLabelText('Compare')).toBeNull();
    expect(mocks.getCampaignTemplateVersion).not.toHaveBeenCalled();
  });

  it('clears a version’s read error once another version is read (N4)', async () => {
    mocks.listCampaignTemplateVersions.mockResolvedValue([
      { version: 4, name: 'Pune collections', based_on_template_id: null, sections_set: ['hours'], saved_at: '2026-11-18T16:12:00Z', saved_by: PRIYA },
      { version: 3, name: 'Pune collections', based_on_template_id: null, sections_set: ['hours'], saved_at: '2026-11-10T09:00:00Z', saved_by: null },
      { version: 2, name: 'Pune collections', based_on_template_id: null, sections_set: [], saved_at: '2026-11-09T09:00:00Z', saved_by: null },
    ]);
    mocks.getCampaignTemplateVersion.mockImplementation(async (_id: string, n: number) => {
      if (n === 3) throw new Error('Could not load that version.');
      return { template_id: 'acc-1', version: n, name: 'Pune collections', based_on_template_id: null, sections_set: [], saved_at: '2026-11-09T09:00:00Z', saved_by: null, sections: {} };
    });
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByText('Could not load that version.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Compare'), { target: { value: '2' } });
    await act(async () => {});
    expect(screen.queryByText('Could not load that version.')).toBeNull();
    expect(within(screen.getByTestId('history-diff')).getByText('Set only in Version 4 (now)')).toBeTruthy();
  });
});

describe('apply to draft campaigns (C7)', () => {
  const DRAFT = { id: 'c-1', name: 'Diwali renewals', status: 'draft' };
  const effective = () => {
    const resolved = resolveTemplateSections({ chosen: { scope: 'account', sections: DETAIL.sections }, basedOn: { sections: ORG_SECTIONS }, builtin: builtinTemplateSections(), can: { record: true, assignment: true, inbound: true } });
    return { template: { id: 'acc-1', name: 'Pune collections', version: 4, scope: 'account' }, based_on: null, config: resolved.config, sources: resolved.sources, notes: [] };
  };

  beforeEach(() => {
    mocks.getAgencyCampaign.mockResolvedValue(DRAFT);
    mocks.getEffectiveCampaignTemplate.mockResolvedValue(effective());
  });

  const openApply = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Apply to draft campaigns…' }));
    await act(async () => {});
    return screen.getByRole('dialog');
  };

  it('says the drafts could not be read, with Retry, rather than that there are none', async () => {
    mocks.listAgencyCampaigns.mockRejectedValueOnce(new Error('down')).mockResolvedValue([DRAFT]);
    await renderAt('/settings/campaign-templates/acc-1');
    const dialog = await openApply();
    expect(dialog.textContent).toContain('Could not load the draft campaigns.');
    expect(dialog.textContent).not.toContain('has no draft campaigns');
    fireEvent.click(within(dialog).getByRole('button', { name: /Retry|Try again/ }));
    await act(async () => {});
    expect(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Diwali renewals' })).toBeTruthy();
  });

  it('starts on the sections the template sets each time it opens, after a save changed them', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([DRAFT]);
    mocks.replaceCampaignTemplate.mockImplementation(async (_id: string, _scope: string, body: { sections: object }) => ({
      ...DETAIL, version: 5, sections: body.sections, sections_set: Object.keys(body.sections),
    }));
    await renderAt('/settings/campaign-templates/acc-1');
    let dialog = await openApply();
    expect((within(dialog).getByRole('checkbox', { name: 'Calling hours' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('checkbox', { name: 'Wrap-up' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    const wrapup = screen.getByTestId('template-section-wrapup');
    fireEvent.click(within(wrapup).getByRole('radio', { name: 'Set in this template' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    dialog = await openApply();
    expect((within(dialog).getByRole('checkbox', { name: 'Calling hours' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('checkbox', { name: 'Wrap-up' }) as HTMLInputElement).checked).toBe(true);
  });

  it('reloads the latest version after a 409 and applies it, keeping the dialog open', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([DRAFT]);
    mocks.applyCampaignTemplate
      .mockRejectedValueOnce(apiError(409, { code: 'campaign_template_changed', message: 'Changed', current_version: 5 }))
      .mockResolvedValue({ template: { id: 'acc-1', name: 'Pune collections', version: 5 }, results: [{ campaign_id: 'c-1', result: 'applied', changed_sections: [], template_source: { template: null, based_on: null, sections: {} } }] });
    await renderAt('/settings/campaign-templates/acc-1');
    const dialog = await openApply();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Diwali renewals' }));
    fireEvent.click(within(dialog).getByTestId('apply-preview'));
    await act(async () => {});
    fireEvent.click(screen.getByTestId('apply-confirm'));
    await act(async () => {});
    expect(screen.getByTestId('apply-stale').textContent).toContain('Nothing was applied.');
    mocks.getCampaignTemplate.mockResolvedValue({ ...DETAIL, version: 5 });
    fireEvent.click(within(screen.getByTestId('apply-stale')).getByRole('button', { name: 'Reload the latest version' }));
    await act(async () => {});
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('apply-reloaded').textContent).toBe('Now on version 5. Check what changes again before you apply.');
    fireEvent.click(screen.getByTestId('apply-preview'));
    await act(async () => {});
    fireEvent.click(screen.getByTestId('apply-confirm'));
    await act(async () => {});
    expect(mocks.applyCampaignTemplate).toHaveBeenLastCalledWith(
      'acc-1', { campaign_ids: ['c-1'], sections: ['hours'], expected_version: 5 }, 't-1', 'a-1',
    );
    expect(screen.getByTestId('apply-results')).toBeTruthy();
  });

  it('says why a refused campaign was not changed, from the refusal’s details (U3)', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([DRAFT]);
    mocks.applyCampaignTemplate.mockResolvedValue({
      template: { id: 'acc-1', name: 'Pune collections', version: 4 },
      results: [{
        campaign_id: 'c-1', result: 'refused', code: 'campaign_rejected', message: 'The campaign’s settings refused this change.', status: 400,
        details: { calling_window_end: 'The end must be after the start', 'agent_script.opening': 'The script uses {emi}, which is not a fact on the card.' },
      }],
    });
    await renderAt('/settings/campaign-templates/acc-1');
    const dialog = await openApply();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Diwali renewals' }));
    fireEvent.click(within(dialog).getByTestId('apply-preview'));
    await act(async () => {});
    fireEvent.click(screen.getByTestId('apply-confirm'));
    await act(async () => {});
    const results = screen.getByTestId('apply-results');
    expect(results.textContent).toContain('Diwali renewals: Not changed. The campaign’s settings refused this change.');
    expect([...within(results).getByTestId('apply-refusal-c-1').querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'The end must be after the start.',
      'The script uses {emi}, which is not a fact on the card.',
    ]);
    // Said, and the focus moves to the results (U12).
    expect(screen.getByTestId('apply-summary').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('apply-summary').textContent).toBe('1 campaign not changed.');
    expect(document.activeElement).toBe(screen.getByTestId('apply-summary'));
  });

  it('selects no section when the template sets none, and never offers numbers it does not set (U3)', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([DRAFT]);
    mocks.getCampaignTemplate.mockImplementation(async (id: string) =>
      (id === 'acc-1' ? { ...DETAIL, sections: {}, sections_set: [] } : { ...ORG, sections: ORG_SECTIONS, follows: null }));
    await renderAt('/settings/campaign-templates/acc-1');
    const dialog = await openApply();
    const boxes = within(within(dialog).getByRole('group', { name: 'Sections to apply' })).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.filter((b) => b.checked)).toEqual([]);
    expect(within(dialog).queryByRole('checkbox', { name: 'Numbers to call from' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Diwali renewals' }));
    // Nothing chosen: nothing to see.
    expect((within(dialog).getByTestId('apply-preview') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers numbers when the template sets them', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([DRAFT]);
    const numbers = { caller_ids: ['+912200000001'], telephony_provider: 'voicelink', telephony_credential_id: null };
    mocks.getCampaignTemplate.mockImplementation(async (id: string) =>
      (id === 'acc-1' ? { ...DETAIL, sections: { ...DETAIL.sections, numbers }, sections_set: ['hours', 'numbers'] } : { ...ORG, sections: ORG_SECTIONS, follows: null }));
    await renderAt('/settings/campaign-templates/acc-1');
    const dialog = await openApply();
    expect((within(dialog).getByRole('checkbox', { name: 'Numbers to call from' }) as HTMLInputElement).checked).toBe(true);
  });

  it('shows a refusal of the whole apply with its details as sentences (U3)', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([DRAFT]);
    mocks.applyCampaignTemplate.mockRejectedValue(apiError(400, {
      code: 'campaign_template_invalid', message: 'This apply cannot be made.', details: { sections: 'This template does not set numbers, so they cannot be applied' },
    }));
    await renderAt('/settings/campaign-templates/acc-1');
    const dialog = await openApply();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Diwali renewals' }));
    fireEvent.click(within(dialog).getByTestId('apply-preview'));
    await act(async () => {});
    fireEvent.click(screen.getByTestId('apply-confirm'));
    await act(async () => {});
    const error = screen.getByTestId('apply-error');
    expect(error.textContent).toContain('This apply cannot be made.');
    expect(error.textContent).toContain('This template does not set numbers, so they cannot be applied.');
  });

  it('forgets a preview that lands after the dialog was closed (U10)', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([DRAFT]);
    let land: (v: unknown) => void = () => {};
    mocks.getEffectiveCampaignTemplate.mockImplementation(() => new Promise((resolve) => { land = resolve; }));
    await renderAt('/settings/campaign-templates/acc-1');
    let dialog = await openApply();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Diwali renewals' }));
    fireEvent.click(within(dialog).getByTestId('apply-preview'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      land(effective());
    });
    dialog = await openApply();
    expect(within(dialog).queryByTestId('apply-preview-list')).toBeNull();
    expect(within(dialog).queryByTestId('apply-confirm')).toBeNull();
    expect((within(dialog).getByRole('checkbox', { name: 'Diwali renewals' }) as HTMLInputElement).checked).toBe(false);
  });

  it('says which account’s drafts change on the organisation’s page', async () => {
    mocks.tenant = { ...mocks.tenant, role: 'tenant_admin', organisationRole: 'tenant_admin' };
    mocks.listAgencyCampaigns.mockResolvedValue([]);
    await renderAt('/settings/organisation-campaign-templates/org-1');
    const dialog = await openApply();
    expect(within(dialog).getByRole('heading', { name: 'Apply “Standard” to draft campaigns of Pune' })).toBeTruthy();
    expect(dialog.textContent).toContain('Pune has no draft campaigns.');
  });
});

describe('new template (C6, C12)', () => {
  const openNew = async (path = '/settings/campaign-templates') => {
    await renderAt(path);
    fireEvent.click(screen.getByRole('button', { name: /New template/ }));
    await act(async () => {});
  };
  const startedWith = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await act(async () => {});
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    return mocks.createCampaignTemplate.mock.calls[0]![0] as { sections: Record<string, Record<string, unknown>> };
  };

  it('copies a campaign’s shown sections only: none whose feature is off', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([{ id: 'c-1', name: 'Diwali renewals', status: 'running' }]);
    mocks.getAgencyCampaign.mockResolvedValue({ id: 'c-1', name: 'Diwali renewals', status: 'running', wrapup_seconds: 90, assignment_mode: 'sticky', inbound_sticky_enabled: true, caller_ids: ['+912200000001'] });
    await openNew();
    fireEvent.click(screen.getByRole('radio', { name: /A copy of a campaign/ }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Campaign to copy'), { target: { value: 'c-1' } });
    const body = await startedWith();
    expect(body.sections.wrapup!.wrapup_seconds).toBe(90);
    expect(body.sections).not.toHaveProperty('assignment');
    expect(body.sections).not.toHaveProperty('inbound');
  });

  it('copies a campaign whose script uses its card’s facts without the script, and says so in the editor (U2)', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([{ id: 'c-1', name: 'Diwali renewals', status: 'running' }]);
    mocks.getAgencyCampaign.mockResolvedValue({
      id: 'c-1', name: 'Diwali renewals', status: 'running', caller_ids: ['+912200000001'],
      agent_script: { opening: 'Your EMI {emi} is due' }, context_display: { facts: [{ key: 'emi', column: 'EMI', label: 'EMI' }] },
    });
    await openNew();
    fireEvent.click(screen.getByRole('radio', { name: /A copy of a campaign/ }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Campaign to copy'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByTestId('template-notice').textContent).toBe('This campaign’s script uses facts from its roster card, which a template cannot hold, so the template leaves the script out.');
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    const body = mocks.createCampaignTemplate.mock.calls[0]![0] as { sections: Record<string, Record<string, unknown>> };
    expect(body.sections.agent_screen!.agent_script ?? {}).toEqual({});
  });

  it('copies an account template into an organisation one without the account’s parts', async () => {
    mocks.tenant = { ...mocks.tenant, role: 'tenant_admin', organisationRole: 'tenant_admin' };
    mocks.getCampaignTemplate.mockImplementation(async (id: string) => (id === 'acc-1'
      ? {
        ...DETAIL,
        sections: {
          hours: HOURS,
          recording: { record_calls: true, analysis_profile_id: 'prof-1' },
          numbers: { caller_ids: ['+912200000001'], telephony_provider: 'voicelink', telephony_credential_id: null },
        },
      }
      : { ...ORG, sections: ORG_SECTIONS, follows: null }));
    mocks.listCampaignTemplates.mockResolvedValue([ORG]);
    await openNew('/settings/organisation-campaign-templates');
    // The organisation page offers its own templates; the account template is copied through the same rule.
    fireEvent.click(screen.getByRole('radio', { name: /A copy of a template/ }));
    const select = screen.getByLabelText('Template to copy') as HTMLSelectElement;
    const option = document.createElement('option');
    option.value = 'acc-1';
    select.appendChild(option);
    fireEvent.change(select, { target: { value: 'acc-1' } });
    const body = await startedWith();
    expect(Object.keys(body.sections).sort()).toEqual(['hours', 'recording']);
    expect(body.sections.recording).toEqual({ record_calls: true });
  });

  it('forgets the choice and any error when closed', async () => {
    mocks.getAgencyCampaign.mockRejectedValue(new Error('down'));
    mocks.listAgencyCampaigns.mockResolvedValue([{ id: 'c-1', name: 'Diwali renewals', status: 'running' }]);
    await openNew();
    fireEvent.click(screen.getByRole('radio', { name: /A copy of a campaign/ }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Campaign to copy'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await act(async () => {});
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /New template/ }));
    await act(async () => {});
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByRole('radio', { name: /Built-in settings/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('“Copy from a campaign…” forgets its choice and error when closed', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([{ id: 'c-1', name: 'Diwali renewals', status: 'running' }]);
    mocks.getAgencyCampaign.mockRejectedValue(new Error('down'));
    await renderAt('/settings/campaign-templates/acc-1');
    fireEvent.click(screen.getByRole('button', { name: 'Copy from a campaign…' }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy settings' }));
    await act(async () => {});
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('down');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy from a campaign…' }));
    await act(async () => {});
    expect((screen.getByLabelText('Campaign') as HTMLSelectElement).value).toBe('');
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull();
  });
});

describe('an organisation template from an account’s page (L4, N7)', () => {
  it('opens read-only: each section’s summary and where it comes from, no choices, no Save', async () => {
    await renderAt('/settings/campaign-templates/org-1');
    expect(screen.getByRole('heading', { name: 'Standard' })).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Save the template' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy from a campaign…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply to draft campaigns…' })).toBeNull();
    expect(screen.queryByLabelText(/^Name/)).toBeNull();
    // An organisation template's own sections: no numbers; unset ones are the built-in settings.
    expect(screen.queryByTestId('template-section-numbers')).toBeNull();
    expect(screen.getByTestId('template-from-wrapup').textContent).toBe('Set in this template');
    expect(screen.getByTestId('template-summary-wrapup').textContent).toBe('45s, then agents return on their own');
    expect(screen.getByTestId('template-from-hours').textContent).toBe('Built-in settings');
    expect(screen.getByTestId('template-summary-hours').textContent).toBe('9:00 AM–8:00 PM · Mon to Fri · India time (IST)');
    // A supervisor cannot change it elsewhere either.
    expect(screen.queryByTestId('template-edit-there')).toBeNull();
    expect(screen.getByRole('button', { name: 'History' })).toBeTruthy();
  });

  it('links an organisation admin to its own editor', async () => {
    mocks.tenant = { ...mocks.tenant, role: 'tenant_admin', organisationRole: 'tenant_admin' };
    await renderAt('/settings/campaign-templates/org-1');
    expect(screen.getByTestId('template-edit-there').getAttribute('href')).toBe('/settings/organisation-campaign-templates/org-1');
  });
});

describe('who sees it', () => {
  it('hides everything with the flag off', async () => {
    mocks.flags = {};
    await renderAt('/settings/campaign-templates');
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    expect(mocks.listCampaignTemplates).not.toHaveBeenCalled();
  });

  it('keeps the organisation’s templates from a supervisor, and from a tenant admin whose seat is one account’s', async () => {
    await renderAt('/settings/organisation-campaign-templates');
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    cleanup();
    mocks.tenant = { ...mocks.tenant, role: 'tenant_admin', organisationRole: undefined };
    await renderAt('/settings/organisation-campaign-templates/org-1');
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    expect(mocks.getCampaignTemplate).not.toHaveBeenCalled();
  });

  it('gives an organisation-wide tenant admin the organisation’s editor, with the built-in settings as what a section follows', async () => {
    mocks.tenant = { ...mocks.tenant, role: 'tenant_admin', organisationRole: 'tenant_admin' };
    await renderAt('/settings/organisation-campaign-templates/org-1');
    await waitFor(() => expect(screen.getByTestId('template-section-wrapup')).toBeTruthy());
    expect(screen.queryByTestId('template-section-numbers')).toBeNull();
    const hours = screen.getByTestId('template-section-hours');
    expect(within(hours).getByRole('radio', { name: 'Use built-in settings' })).toBeTruthy();
    expect(screen.queryByLabelText('Based on')).toBeNull();
  });

  it('hides a section whose feature is off, and shows it when on', async () => {
    await renderAt('/settings/campaign-templates/acc-1');
    expect(screen.queryByTestId('template-section-assignment')).toBeNull();
    expect(screen.queryByTestId('template-section-inbound')).toBeNull();
    cleanup();
    mocks.flags = { agency_campaign_templates_enabled: true, agency_inbound_enabled: true };
    await renderAt('/settings/campaign-templates/acc-1');
    expect(screen.getByTestId('template-section-inbound')).toBeTruthy();
  });
});
