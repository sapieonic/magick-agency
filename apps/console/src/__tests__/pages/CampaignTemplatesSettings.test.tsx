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

  it('lists the organisation’s templates read-only, under “From the organisation”', async () => {
    await renderAt('/settings/campaign-templates');
    const section = screen.getByRole('region', { name: 'From the organisation' });
    const row = within(section).getByTestId('template-row-org-1');
    expect(row.textContent).toContain('Standard');
    expect(within(row).queryByRole('button')).toBeNull();
    expect(within(row).queryByRole('link')).toBeNull();
    // Its default is the organisation's, not this account's (C4).
    expect(within(row).getByText('Organisation default')).toBeTruthy();
    expect(within(row).queryByText('Account default')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Stop using as default' }));
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
    expect(screen.getByTestId('template-summary-hours').textContent).toBe('10:00 AM–8:00 PM · Mon to Sat · Asia/Kolkata');
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
    expect(screen.getByTestId('template-summary-hours').textContent).toBe('9:00 AM–8:00 PM · Mon to Fri · Asia/Kolkata');

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
    expect(screen.getByTestId('template-summary-hours').textContent).toBe('10:00 AM–8:00 PM · Mon to Sat · Asia/Kolkata');
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
    expect(row.textContent).toContain('9:00 AM–8:00 PM · Mon to Sat · Asia/Kolkata');
    expect(row.textContent).toContain('10:00 AM–8:00 PM · Mon to Sat · Asia/Kolkata');
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
    expect(options).toEqual(['Now (version 4)', 'Version 3']);
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
