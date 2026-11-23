import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgencyCampaignTemplateSummary } from '@magick-agency/contracts/api/agency/campaign-templates';
import { builtinTemplateSections, resolveTemplateSections } from '@magick-agency/domain/campaign-templates';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * Campaign Settings' template line (`docs/campaign-templates.md` §7): "Started from <template>,
 * version n", that the template has moved on (the campaign is not affected), "See what's different
 * from the template now" per section, and "Save as template…" as a new template or in place of an
 * existing one's sections (with the version the list showed). Nothing with the flag off.
 */

const mocks = vi.hoisted(() => ({
  tenant: { tenantId: 't-1', accountId: 'a-1', role: 'account_admin', organisationRole: undefined as string | undefined },
  flags: { agency_campaign_templates_enabled: true } as Record<string, boolean>,
  showToast: vi.fn(),
  getCampaignTemplate: vi.fn(),
  getEffectiveCampaignTemplate: vi.fn(),
  listCampaignTemplates: vi.fn(),
  createCampaignTemplate: vi.fn(),
  replaceCampaignTemplate: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: () => mocks.tenant }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }) }));
vi.mock('../../api/campaignTemplates', () => ({
  getCampaignTemplate: mocks.getCampaignTemplate,
  getEffectiveCampaignTemplate: mocks.getEffectiveCampaignTemplate,
  listCampaignTemplates: mocks.listCampaignTemplates,
  createCampaignTemplate: mocks.createCampaignTemplate,
  replaceCampaignTemplate: mocks.replaceCampaignTemplate,
}));

import { CampaignTemplateSource } from '../../components/agency/campaignTemplates/CampaignTemplateSource';

const TEMPLATE_SECTIONS = {
  hours: { calling_window_start: '10:00', calling_window_end: '20:00', calling_days: [1, 2, 3, 4, 5, 6], default_timezone: 'Asia/Kolkata' },
};
const resolved = resolveTemplateSections({
  chosen: { scope: 'account', sections: TEMPLATE_SECTIONS }, basedOn: null, builtin: builtinTemplateSections(), can: { record: true, assignment: true, inbound: true },
});

const CAMPAIGN = {
  ...resolved.config,
  id: 'c-1',
  name: 'Diwali renewals',
  status: 'draft',
  calling_window_start: '11:00:00',
  calling_window_end: '20:00:00',
  caller_ids: ['+912200000001'],
  template_source: {
    template: { id: 'tp-1', name: 'Pune collections', version: 3, scope: 'account' },
    based_on: null,
    sections: Object.fromEntries(Object.keys(resolved.sources).map((k) => [k, 'account'])),
  },
} as unknown as AgencyCampaign;

const SUMMARY: AgencyCampaignTemplateSummary = {
  id: 'tp-1', scope: 'account', account_id: 'a-1', name: 'Pune collections', description: 'For Pune', is_default: true, version: 5,
  based_on: { id: 'org-1', name: 'Standard', version: 2, archived: false }, sections_set: ['hours'], created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-18T16:12:00Z', updated_by: null, archived_at: null, archived_by: null,
};

async function renderIt(campaign: AgencyCampaign = CAMPAIGN) {
  render(
    <MemoryRouter>
      <CampaignTemplateSource campaign={campaign} />
    </MemoryRouter>,
  );
  await act(async () => {});
}

beforeEach(() => {
  mocks.tenant = { tenantId: 't-1', accountId: 'a-1', role: 'account_admin', organisationRole: undefined };
  mocks.flags = { agency_campaign_templates_enabled: true };
  mocks.getCampaignTemplate.mockResolvedValue({ ...SUMMARY, sections: TEMPLATE_SECTIONS, follows: null });
  mocks.getEffectiveCampaignTemplate.mockResolvedValue({
    template: { id: 'tp-1', name: 'Pune collections', version: 5, scope: 'account' }, based_on: null, config: resolved.config, sources: resolved.sources, notes: [],
  });
  mocks.listCampaignTemplates.mockResolvedValue([SUMMARY]);
  mocks.createCampaignTemplate.mockImplementation(async (body: { name: string }) => ({ ...SUMMARY, id: 'tp-9', name: body.name, version: 1 }));
  mocks.replaceCampaignTemplate.mockResolvedValue({ ...SUMMARY, version: 6 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('campaign Settings’ template line', () => {
  it('says which template it started from, and that the template has moved on without it', async () => {
    await renderIt();
    expect(screen.getByTestId('campaign-template-started').textContent).toBe('Started from Pune collections, version 3.');
    expect(mocks.getCampaignTemplate).toHaveBeenCalledWith('tp-1', 't-1', 'a-1');
    expect(screen.getByTestId('campaign-template-moved').textContent).toBe(
      'Pune collections is now on version 5 (this campaign is not affected).',
    );
  });

  it('shows what is different from the template now, per section', async () => {
    await renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'See what’s different from the template now' }));
    await act(async () => {});
    expect(mocks.getEffectiveCampaignTemplate).toHaveBeenCalledWith('tp-1', 't-1', 'a-1');
    const diff = screen.getByTestId('campaign-template-diff');
    // The hours were changed here. The numbers were picked here too, but the template sets none:
    // they are each campaign's own, so they are no difference (U7).
    expect([...diff.querySelectorAll('li')].map((li) => li.getAttribute('data-section'))).toEqual(['hours']);
    const row = within(diff).getByText('Calling hours').closest('li')!;
    expect(row.textContent).toContain('Changed: the start time');
    expect(row.textContent).toContain('11:00 AM–8:00 PM');
  });

  it('compares the numbers when the template sets them (U7)', async () => {
    const numbers = { caller_ids: ['+912200000002'], telephony_provider: 'voicelink', telephony_credential_id: null };
    const withNumbers = resolveTemplateSections({
      chosen: { scope: 'account', sections: { ...TEMPLATE_SECTIONS, numbers } }, basedOn: null, builtin: builtinTemplateSections(), can: { record: true, assignment: true, inbound: true },
    });
    mocks.getEffectiveCampaignTemplate.mockResolvedValue({
      template: { id: 'tp-1', name: 'Pune collections', version: 5, scope: 'account' }, based_on: null, config: withNumbers.config, sources: withNumbers.sources, notes: [],
    });
    await renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'See what’s different from the template now' }));
    await act(async () => {});
    const diff = screen.getByTestId('campaign-template-diff');
    expect([...diff.querySelectorAll('li')].map((li) => li.getAttribute('data-section'))).toEqual(['hours', 'numbers']);
  });

  it('keeps the comparison true to the campaign after it is saved (U7)', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <CampaignTemplateSource campaign={CAMPAIGN} />
      </MemoryRouter>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'See what’s different from the template now' }));
    await act(async () => {});
    expect(screen.getByTestId('campaign-template-diff')).toBeTruthy();
    // The supervisor puts the hours back to the template's and saves: the page hands the saved campaign down.
    rerender(
      <MemoryRouter>
        <CampaignTemplateSource campaign={{ ...CAMPAIGN, calling_window_start: '10:00:00' } as AgencyCampaign} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('campaign-template-diff')).toBeNull();
    expect(screen.getByTestId('campaign-template-diff-empty').textContent).toBe('This campaign has the same settings as Pune collections fills in now.');
  });

  it('saves the campaign’s settings as a new template', async () => {
    await renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Save as template…' }));
    await act(async () => {});
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Diwali renewals');
    // A supervisor makes the account's templates only.
    expect(within(dialog).queryByLabelText('For')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    const [body, tenantId, accountId] = mocks.createCampaignTemplate.mock.calls[0]!;
    expect([tenantId, accountId]).toEqual(['t-1', 'a-1']);
    expect(body.scope).toBe('account');
    expect(body.sections.hours.calling_window_start).toBe('11:00:00');
    expect(body.sections.numbers.caller_ids).toEqual(['+912200000001']);
    // Sections whose feature is off are not saved.
    expect(body.sections).not.toHaveProperty('assignment');
    expect(mocks.showToast).toHaveBeenCalledWith('Template “Diwali renewals” created from this campaign.', 'success');
  });

  it('replaces an existing template’s sections, sending the version the list showed', async () => {
    await renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Save as template…' }));
    await act(async () => {});
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'The settings of an existing template' }));
    fireEvent.change(within(dialog).getByLabelText('Template'), { target: { value: 'tp-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace its settings' }));
    await act(async () => {});
    const [id, scope, body] = mocks.replaceCampaignTemplate.mock.calls[0]!;
    expect([id, scope]).toEqual(['tp-1', 'account']);
    expect(body).toMatchObject({ name: 'Pune collections', description: 'For Pune', based_on_template_id: 'org-1', expected_version: 5 });
    expect(body.sections.hours.calling_window_start).toBe('11:00:00');
  });

  it('offers “Reload the latest version” when the template was saved in between, and replaces with that version (CTC7)', async () => {
    mocks.replaceCampaignTemplate.mockRejectedValueOnce(Object.assign(new Error('Changed'), {
      statusCode: 409,
      details: { code: 'campaign_template_changed', message: 'Changed', current_version: 6 },
    }));
    await renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Save as template…' }));
    await act(async () => {});
    let dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'The settings of an existing template' }));
    fireEvent.change(within(dialog).getByLabelText('Template'), { target: { value: 'tp-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace its settings' }));
    await act(async () => {});
    const stale = screen.getByTestId('save-as-template-stale');
    expect(stale.textContent).toContain('Nothing was replaced.');
    mocks.listCampaignTemplates.mockResolvedValue([{ ...SUMMARY, version: 6 }]);
    fireEvent.click(within(stale).getByRole('button', { name: 'Reload the latest version' }));
    await act(async () => {});
    dialog = screen.getByRole('dialog');
    expect(screen.queryByTestId('save-as-template-stale')).toBeNull();
    expect(dialog.textContent).toContain('as version 7');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace its settings' }));
    await act(async () => {});
    expect(mocks.replaceCampaignTemplate.mock.calls[1]![2].expected_version).toBe(6);
  });

  describe('a campaign whose script uses its card’s facts (U2)', () => {
    const FACTS_CAMPAIGN = {
      ...CAMPAIGN,
      phone_display: 'masked',
      daily_target_calls: 90,
      agent_script: { opening: 'Namaste {name}, your EMI {emi} is due.', steps: [{ text: 'Ask for {branch}' }] },
      context_display: { facts: [{ key: 'emi', column: 'EMI', label: 'EMI' }, { key: 'branch', column: 'Branch', label: 'Branch' }] },
    } as unknown as AgencyCampaign;

    it('saves “What agents see” without the script as a new template, and says so', async () => {
      await renderIt(FACTS_CAMPAIGN);
      fireEvent.click(screen.getByRole('button', { name: 'Save as template…' }));
      await act(async () => {});
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByTestId('save-as-template-script-note').textContent).toBe('This campaign’s script uses facts from its roster card, which a template cannot hold, so the template leaves the script out.');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save template' }));
      await act(async () => {});
      const [body] = mocks.createCampaignTemplate.mock.calls[0]!;
      expect(body.sections.agent_screen).toEqual({ phone_display: 'masked', daily_target_calls: 90 });
      expect(body.sections.hours.calling_window_start).toBe('11:00:00');
    });

    it('replaces an existing template’s sections without the script too', async () => {
      await renderIt(FACTS_CAMPAIGN);
      fireEvent.click(screen.getByRole('button', { name: 'Save as template…' }));
      await act(async () => {});
      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('radio', { name: 'The settings of an existing template' }));
      fireEvent.change(within(dialog).getByLabelText('Template'), { target: { value: 'tp-1' } });
      expect(within(dialog).getByTestId('save-as-template-script-note')).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Replace its settings' }));
      await act(async () => {});
      const [, , body] = mocks.replaceCampaignTemplate.mock.calls[0]!;
      expect(body.sections.agent_screen).toEqual({ phone_display: 'masked', daily_target_calls: 90 });
    });

    it('keeps a script that uses only the keys a template may hold, and says nothing', async () => {
      await renderIt({ ...FACTS_CAMPAIGN, agent_script: { opening: 'Namaste {name}, {amount_due} is due on {due_date}.' } } as AgencyCampaign);
      fireEvent.click(screen.getByRole('button', { name: 'Save as template…' }));
      await act(async () => {});
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).queryByTestId('save-as-template-script-note')).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save template' }));
      await act(async () => {});
      expect(mocks.createCampaignTemplate.mock.calls[0]![0].sections.agent_screen.agent_script).toEqual({
        opening: 'Namaste {name}, {amount_due} is due on {due_date}.',
      });
    });
  });

  it('shows nothing to a role that cannot create campaigns (`agency.campaigns.write`)', async () => {
    mocks.tenant = { ...mocks.tenant, role: 'operator' };
    await renderIt();
    expect(screen.queryByTestId('campaign-template-source')).toBeNull();
    expect(mocks.getCampaignTemplate).not.toHaveBeenCalled();
  });

  it('says nothing with the flag off', async () => {
    mocks.flags = {};
    await renderIt();
    expect(screen.queryByTestId('campaign-template-source')).toBeNull();
    expect(mocks.getCampaignTemplate).not.toHaveBeenCalled();
  });

  it('says nothing of a template for a campaign with no record, and still offers Save as template (CTC12)', async () => {
    await renderIt({ ...CAMPAIGN, template_source: null });
    expect(screen.getByTestId('campaign-template-source').textContent).toBe('Save as template…');
    expect(screen.queryByRole('button', { name: /See what’s different/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save as template…' })).toBeTruthy();
  });

  it('says when the campaign was created, and why a section is not as the template says (its notes)', async () => {
    await renderIt({
      ...CAMPAIGN,
      created_at: '2026-11-02T10:30:00Z',
      template_source: {
        ...CAMPAIGN.template_source!,
        notes: [
          { code: 'recording_not_allowed', section: 'recording' },
          { code: 'numbers_unavailable', section: 'numbers', numbers: ['+912200000009'] },
        ],
      },
    } as AgencyCampaign);
    expect(screen.getByTestId('campaign-template-started').textContent).toBe('Started from Pune collections, version 3 · created 2 Nov.');
    expect([...screen.getByTestId('campaign-template-notes').querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Recording is off for this account, so this campaign starts with recording off.',
      'These numbers of the template can no longer be used by this account, so they are left out: +912200000009.',
    ]);
  });

  it('says an archived template has since been archived, and offers no comparison with it (CTC5)', async () => {
    mocks.getCampaignTemplate.mockResolvedValue({ ...SUMMARY, archived_at: '2026-11-20T10:00:00Z', sections: TEMPLATE_SECTIONS, follows: null });
    await renderIt();
    expect(screen.getByTestId('campaign-template-moved').textContent).toBe(
      'Pune collections has since been archived (this campaign is not affected).',
    );
    expect(screen.queryByRole('button', { name: /See what’s different/ })).toBeNull();
    expect(screen.queryByText(/Restore it first/)).toBeNull();
  });

  it('says the template was archived, not “restore it”, when it is archived between the read and the comparison', async () => {
    mocks.getEffectiveCampaignTemplate.mockRejectedValue(Object.assign(new Error('This template is archived. Restore it first.'), {
      statusCode: 409,
      details: { code: 'campaign_template_archived', message: 'This template is archived. Restore it first.' },
    }));
    await renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'See what’s different from the template now' }));
    await act(async () => {});
    expect(screen.getByText('Pune collections has since been archived, so there is nothing to compare with.')).toBeTruthy();
  });
});
