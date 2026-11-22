import { describe, it, expect } from 'vitest';
import { AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS } from '@magick-agency/contracts/api/agency/campaign-templates';
import { builtinTemplateSections, diffSections, sectionsFromCampaign } from '@magick-agency/domain/campaign-templates';
import {
  campaignFieldsOfForm,
  filledConfig,
  formOfConfig,
  sameSection,
  sectionOfPath,
  sectionsOfForm,
  templateFormErrors,
  withSectionFrom,
} from '../../utils/agency/campaignTemplates/templateForm';
import { clockTime, formatStamp, noteSentence, sectionSummary } from '../../utils/agency/campaignTemplates/templateCopy';

/**
 * Campaign templates' one wire ↔ form mapping (`utils/agency/campaignTemplates/templateForm.ts`):
 * a config read into the editors and read back out is the same setting by the domain's rule, so
 * an untouched section never reads as changed (New campaign's chips, the editor's Save); a section
 * is taken from another form whole; and the summaries say a section in plain words.
 */

describe('the form round trip', () => {
  it('reads the built-in settings into the editors and back without a change in any section', () => {
    const config = filledConfig('account', {}, null);
    const back = sectionsOfForm(formOfConfig(config), 'account', AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS);
    const builtin = sectionsFromCampaign(config, 'account');
    expect(diffSections(builtin, back)).toEqual([]);
    for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) {
      expect(sameSection(key, campaignFieldsOfForm(formOfConfig(config)), config), key).toBe(true);
    }
  });

  it('round-trips a template’s own values, and finds the one field changed', () => {
    const sections = {
      hours: { calling_window_start: '10:00:00', calling_window_end: '19:30:00', calling_days: [6, 1, 2], default_timezone: 'Asia/Kolkata' },
      wrapup: { wrapup_seconds: 0, wrapup_auto_return: false, allow_wrapup_redial: true },
      breaks: { break_reasons: [{ code: 'tea', label: 'Tea', limit_minutes: 15 }] },
      agent_screen: { daily_target_calls: 120, phone_display: 'masked' as const, agent_script: { opening: 'Namaste' } },
    };
    const form = formOfConfig(filledConfig('account', sections, null));
    const back = sectionsOfForm(form, 'account', ['hours', 'wrapup', 'breaks', 'agent_screen']);
    expect(diffSections(sections, back)).toEqual([]);
    const edited = { ...form, config: { ...form.config, wrapupSeconds: 30 } };
    expect(diffSections(sections, sectionsOfForm(edited, 'account', ['hours', 'wrapup', 'breaks', 'agent_screen'])))
      .toEqual([{ section: 'wrapup', change: 'changed', fields: ['wrapup_seconds'] }]);
  });

  it('takes a section whole from another form, and nothing else', () => {
    const mine = formOfConfig(filledConfig('account', { wrapup: { wrapup_seconds: 90 } }, null));
    const theirs = formOfConfig(filledConfig('account', { hours: { calling_window_start: '11:00' }, wrapup: { wrapup_seconds: 10 } }, null));
    const next = withSectionFrom(mine, theirs, 'hours');
    expect(next.config.window.start).toBe('11:00');
    expect(next.config.wrapupSeconds).toBe(90);
  });

  it('leaves an organisation template without the account’s numbers and summary profile', () => {
    const form = formOfConfig({ ...builtinTemplateSections().numbers, caller_ids: ['+912200000001'], analysis_profile_id: 'p-1' });
    const sections = sectionsOfForm(form, 'organisation', AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS);
    expect(sections.numbers).toBeUndefined();
    expect(sections.recording).toEqual({ record_calls: false });
  });

  it('checks only the sections the template sets, and keys each finding by its field', () => {
    const form = formOfConfig(filledConfig('account', {}, null));
    const broken = { ...form, config: { ...form.config, window: { ...form.config.window, end: form.config.window.start } }, callerIds: [] };
    expect(Object.keys(templateFormErrors(broken, ['wrapup']))).toEqual([]);
    const found = templateFormErrors(broken, ['hours', 'numbers']);
    expect(Object.keys(found).map(sectionOfPath)).toEqual(expect.arrayContaining(['hours', 'numbers']));
    expect(sectionOfPath('disposition_catalog[2].code')).toBe('outcomes');
    expect(sectionOfPath('name')).toBeNull();
  });
});

describe('the words', () => {
  it('says each section in one line', () => {
    const config = filledConfig('account', {
      hours: { calling_window_start: '10:00', calling_window_end: '20:00', calling_days: [1, 2, 3, 4, 5, 6], default_timezone: 'Asia/Kolkata' },
      agent_screen: { daily_target_calls: 80, agent_script: { steps: [{ text: 'Greet' }, { text: 'Ask' }] } },
    }, null);
    expect(sectionSummary('hours', config)).toBe('10:00 AM–8:00 PM · Mon to Sat · Asia/Kolkata');
    expect(sectionSummary('agent_screen', config)).toBe('Full number · Target 80 calls a day · Script with 2 steps');
    expect(sectionSummary('retries', config)).toBe('The built-in retry rules');
    expect(sectionSummary('breaks', config)).toBe('The built-in break reasons, no limits');
    expect(sectionSummary('recording', config)).toBe('Off');
    expect(sectionSummary('numbers', config)).toMatch(/^No numbers · /);
    expect(sectionSummary('outcomes', config)).toMatch(/^\d+ outcomes: Voicemail, /);
  });

  it('writes times and stamps as Indian English does', () => {
    expect(clockTime('00:05:00')).toBe('12:05 AM');
    expect(clockTime('12:00')).toBe('12:00 PM');
    expect(formatStamp('2026-11-18T16:12:00Z')).toBe('18 Nov, 4:12 PM');
  });

  it('says every note as a sentence', () => {
    expect(noteSentence({ code: 'recording_not_allowed', section: 'recording' }))
      .toBe('Recording is off for this account, so this campaign starts with recording off.');
    expect(noteSentence({ code: 'numbers_unavailable', section: 'numbers', numbers: ['+912200000001'] })).toContain('+912200000001');
    expect(noteSentence({ code: 'section_flag_off', section: 'assignment' })).toBe(
      'Contact assignment is not turned on for this account, so it starts with the built-in settings.',
    );
  });
});
