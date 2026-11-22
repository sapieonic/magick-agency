import { describe, expect, it, vi } from 'vitest';

/**
 * Campaign templates' pure server helpers (docs/campaign-templates.md CT4, CT8, CT9, CT16): the
 * create's fill-in (`create-fill.ts`), the `template_source` shape the internal create checks
 * (`template-source.ts`), the routes' body checks (`proxy-agency-campaign-templates/validate.ts`)
 * and the apply's patch body and record (`apply.ts`). The routes that use them run on real
 * Postgres in `test/integration/api/campaign-templates-*.test.ts`.
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/config/index.js', () => ({ config: { agency: {}, redis: { keyPrefix: '' }, telephony: {} } }));

import {
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  type AgencyCampaignTemplateEffective,
  type AgencyCampaignTemplateSource,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { AGENCY_DEFAULT_DISPOSITION_CATALOG } from '@magick-agency/contracts/agency';
import { builtinTemplateSections, resolveTemplateSections } from '@magick-agency/domain/campaign-templates';
import { filledCreateBody, withoutTemplateKeys } from '../../../src/agency/campaign-templates/create-fill.js';
import { templateSourceFor, templateSourceIssue } from '../../../src/agency/campaign-templates/template-source.js';
import {
  sectionConfigIssues,
  sectionOfPath,
  sectionsAsCampaignBody,
  sectionsShapeIssues,
} from '../../../src/api/routes/proxy-agency-campaign-templates/validate.js';
import { applyPatchBody } from '../../../src/api/routes/proxy-agency-campaign-templates/apply.js';

const builtin = builtinTemplateSections();
const all = (source: string) => Object.fromEntries(AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.map((k) => [k, source]));
const filled = (sections: Record<string, unknown>) => resolveTemplateSections({
  chosen: { scope: 'account', sections },
  basedOn: null,
  builtin,
  can: { record: true, assignment: true, inbound: true },
});

describe('filledCreateBody (CT8)', () => {
  const config = filled({ wrapup: { wrapup_seconds: 90, allow_wrapup_redial: true }, hours: { calling_window_start: '10:00' } }).config;

  it('a section the body leaves out is the filled-in section, whole', () => {
    const body = filledCreateBody({ name: 'C' }, config);
    expect(body).toMatchObject({ name: 'C', wrapup_seconds: 90, allow_wrapup_redial: true, wrapup_auto_return: true });
    expect(body).toMatchObject({ calling_window_start: '10:00:00', default_timezone: 'Asia/Kolkata' });
    expect(body.disposition_catalog).toEqual([...AGENCY_DEFAULT_DISPOSITION_CATALOG]);
  });

  it('a section the body sends is kept as sent, its absent fields built-in, never the template\'s', () => {
    const body = filledCreateBody({ wrapup_seconds: 15, calling_window_end: '18:00' }, config);
    expect(body).toMatchObject({ wrapup_seconds: 15, allow_wrapup_redial: false, wrapup_auto_return: true });
    expect(body).toMatchObject({ calling_window_end: '18:00', calling_window_start: '09:00:00' });
  });

  it('a null sent is sent (a field\'s null is a value); an empty list is kept', () => {
    const body = filledCreateBody({ daily_target_calls: null, disposition_catalog: [] }, filled({ agent_screen: { daily_target_calls: 40 } }).config);
    expect(body).toMatchObject({ daily_target_calls: null, phone_display: 'full', disposition_catalog: [], outcome_dispositions: {} });
  });

  it('never mutates the body, and shares no object with the config', () => {
    const sent = { name: 'C' };
    const body = filledCreateBody(sent, config);
    expect(sent).toEqual({ name: 'C' });
    expect(body.disposition_catalog).not.toBe(config.disposition_catalog);
  });
});

describe('withoutTemplateKeys', () => {
  it('takes out template_id and template_source; the same object when neither is there', () => {
    const plain = { name: 'C' };
    expect(withoutTemplateKeys(plain)).toBe(plain);
    expect(withoutTemplateKeys({ name: 'C', template_id: 'x', template_source: {} })).toEqual({ name: 'C' });
    expect(withoutTemplateKeys(null)).toBeNull();
    expect(withoutTemplateKeys(['x'])).toEqual(['x']);
  });
});

describe('templateSourceIssue (CT9)', () => {
  const good: AgencyCampaignTemplateSource = {
    template: { id: '11111111-2222-4333-8444-555555555555', name: 'T', version: 2, scope: 'account' },
    based_on: { id: '11111111-2222-4333-8444-666666666666', name: 'O', version: 1 },
    sections: all('builtin') as AgencyCampaignTemplateSource['sections'],
  };

  it('accepts a whole record, and one made from no template', () => {
    expect(templateSourceIssue(good)).toBeNull();
    expect(templateSourceIssue({ template: null, based_on: null, sections: all('campaign') })).toBeNull();
  });

  it.each([
    ['not an object', 'x'],
    ['a template without a scope', { ...good, template: { id: good.template!.id, name: 'T', version: 1 } }],
    ['a template id that is not one', { ...good, template: { ...good.template!, id: 'x' } }],
    ['a version below 1', { ...good, based_on: { ...good.based_on!, version: 0 } }],
    ['a section missing', { ...good, sections: { ...all('builtin'), numbers: undefined } }],
    ['an unknown source', { ...good, sections: { ...all('builtin'), hours: 'template' } }],
    ['an extra section', { ...good, sections: { ...all('builtin'), lunch: 'builtin' } }],
  ])('refuses %s', (_name, value) => {
    expect(templateSourceIssue(value)).toEqual(expect.any(String));
  });
});

describe('the template routes\' body checks (CT4)', () => {
  it('sectionsShapeIssues: only the map\'s sections, each with only its own fields', () => {
    expect(sectionsShapeIssues({ hours: { calling_window_start: '10:00' }, numbers: {} })).toEqual({});
    expect(sectionsShapeIssues({ lunch: {}, hours: { wrapup_seconds: 3 } })).toEqual({
      'sections.lunch': expect.any(String),
      'sections.hours.wrapup_seconds': expect.any(String),
    });
  });

  it('sectionOfPath: a campaign field path to its section', () => {
    expect(sectionOfPath('calling_window_end')).toBe('hours');
    expect(sectionOfPath('disposition_catalog[2].code')).toBe('outcomes');
    expect(sectionOfPath('retry_policy.no_answer.max_attempts')).toBe('retries');
    expect(sectionOfPath('name')).toBeNull();
  });

  it('sectionsAsCampaignBody: the set sections only, absent fields built-in', () => {
    expect(sectionsAsCampaignBody({ wrapup: { wrapup_seconds: 5 } })).toEqual({
      wrapup_seconds: 5, wrapup_auto_return: builtin.wrapup.wrapup_auto_return, allow_wrapup_redial: builtin.wrapup.allow_wrapup_redial,
    });
  });

  it('sectionConfigIssues: none for valid sections, the create\'s keys and the sections for invalid ones', () => {
    expect(sectionConfigIssues({ hours: { calling_window_start: '10:00', calling_window_end: '18:00' }, safety: { abandonment_ceiling_pct: 2 } })).toBeNull();
    expect(sectionConfigIssues({})).toBeNull();
    const issues = sectionConfigIssues({ safety: { abandonment_ceiling_pct: 0 }, hours: { calling_window_start: '20:00:00' } });
    expect(issues?.sections).toEqual(['hours', 'safety']);
    expect(Object.keys(issues!.details).sort()).toEqual(['abandonment_ceiling_pct', 'calling_window_end']);
  });
});

describe('the apply\'s body and record (CT16)', () => {
  it('applyPatchBody: every field of the chosen sections, as filled in', () => {
    const config = filled({ wrapup: { wrapup_seconds: 90 } }).config;
    expect(applyPatchBody(config, ['wrapup', 'safety'])).toEqual({
      wrapup_seconds: 90, wrapup_auto_return: true, allow_wrapup_redial: false, abandonment_ceiling_pct: 3,
    });
  });

});

describe('templateSourceFor (CT9 as amended): the record of stored settings', () => {
  const refs = { template: { id: '11111111-2222-4333-8444-555555555555', name: 'T', version: 3, scope: 'account' as const }, based_on: null };
  const fill = { ...refs, resolved: filled({ wrapup: { wrapup_seconds: 90 } }) };
  const scope = { tenantId: 't', accountId: 'a' };

  it('each section of the stored settings against the fill-in: its source where equal, else campaign; the notes kept', async () => {
    const stored = { ...fill.resolved.config, wrapup_seconds: 90, calling_window_start: '11:00:00' };
    const record = await templateSourceFor(scope, stored, refs, { ...fill, resolved: { ...fill.resolved, notes: [{ code: 'recording_not_allowed', section: 'recording' }] } });
    expect(record).toEqual({
      ...refs,
      sections: { ...all('builtin'), wrapup: 'account', hours: 'campaign' },
      notes: [{ code: 'recording_not_allowed', section: 'recording' }],
    });
    // Back to the template's value: its source again.
    expect((await templateSourceFor(scope, fill.resolved.config, refs, fill))!.sections.hours).toBe('builtin');
  });
});
