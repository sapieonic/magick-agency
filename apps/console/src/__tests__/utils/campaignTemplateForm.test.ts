import { describe, it, expect } from 'vitest';
import { AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS } from '@magick-agency/contracts/api/agency/campaign-templates';
import { builtinTemplateSections, diffSections, sectionOfPath, sectionsFromCampaign } from '@magick-agency/domain/campaign-templates';
import {
  campaignFieldsOfForm,
  filledConfig,
  formOfConfig,
  sameSection,
  sectionsOfForm,
  templateFormErrors,
  templateScriptKeys,
  withSectionFrom,
} from '../../utils/agency/campaignTemplates/templateForm';
import { AGENCY_SCRIPT_PLACEHOLDERS } from '@magick-agency/contracts/agency';
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

  it('round-trips every one of the 11 sections set to values other than the built-in ones', () => {
    const sections = {
      outcomes: {
        disposition_catalog: [
          { code: 'voicemail', label: 'Voicemail', retry: { delay_minutes: 90, max_attempts: 2 } },
          { code: 'callback', label: 'Call back', requires_datetime: true },
          { code: 'do_not_call', label: 'Do not call', suppress: true },
          { code: 'will_pay', label: 'Will pay', is_success: true, requires_promise: true, promise_follow_up_days: 3, icon: 'rupee' },
          { code: 'dispute', label: 'Dispute', requires_note: true, override: { extra_attempts: 2, calling_hours: true } },
        ],
        outcome_dispositions: { no_answer: 'voicemail' },
      },
      retries: { retry_policy: { no_answer: { delay_minutes: 45, max_attempts: 4 }, busy: { delay_minutes: 10, max_attempts: 2 } } },
      hours: { calling_window_start: '08:30:00', calling_window_end: '21:00:00', calling_days: [7, 1, 3], default_timezone: 'Asia/Dubai' },
      wrapup: { wrapup_seconds: 75, wrapup_auto_return: false, allow_wrapup_redial: true },
      breaks: { break_reasons: [{ code: 'lunch', label: 'Lunch', limit_minutes: 40 }, { code: 'tea', label: 'Tea' }] },
      recording: { record_calls: true, analysis_profile_id: 'profile-7' },
      agent_screen: { agent_script: { opening: 'Hello {name}', steps: [{ text: 'Ask about {amount_due}' }] }, phone_display: 'masked' as const, daily_target_calls: null },
      // A ceiling the form shows rounded keeps its stored value (`abandonmentCeilingStoredPct`).
      safety: { abandonment_ceiling_pct: 7.25 },
      assignment: {
        assignment_mode: 'strict', on_unstaff: 'keep', callback_owner_grace_minutes: 120, callback_fallback: 'wait',
        allow_agent_retry: true, agent_retry_rounds: 3, agent_retry_cooldown_minutes: 15,
      },
      inbound: { inbound_sticky_enabled: false },
      // Several numbers, in their order, on a carrier account of the tenant's own.
      numbers: { caller_ids: ['+912200000003', '+912200000001', '+912200000002'], telephony_provider: 'plivo', telephony_credential_id: 'cred-9' },
    } as const;
    const keys = AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS;
    expect(Object.keys(sections).sort()).toEqual([...keys].sort());
    const form = formOfConfig(filledConfig('account', sections as never, null));
    const back = sectionsOfForm(form, 'account', keys);
    expect(diffSections(sections as never, back)).toEqual([]);
    // Each one really differs from the built-in settings, so the round trip proves something.
    expect(diffSections(builtinTemplateSections(), back).map((d) => d.section).sort()).toEqual([...keys].sort());
    expect((back.safety as { abandonment_ceiling_pct: number }).abandonment_ceiling_pct).toBe(7.25);
    expect((back.numbers as { caller_ids: string[] }).caller_ids).toEqual(['+912200000003', '+912200000001', '+912200000002']);
    expect((back.agent_screen as { daily_target_calls: number | null }).daily_target_calls).toBeNull();
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
  });
});

describe('a template’s script (U1)', () => {
  const withScript = (opening: string) => {
    const form = formOfConfig(filledConfig('account', { agent_screen: { agent_script: { opening } } }, null));
    return templateFormErrors(form, ['agent_screen']);
  };

  it('may use every key the server lets a template’s script use: the legacy six', () => {
    expect(templateScriptKeys()).toEqual([...AGENCY_SCRIPT_PLACEHOLDERS]);
    expect(withScript('Your EMI of {amount_due} is due on {due_date}, {name}. I am {agent_name} from {campaign_name}, {place}.')).toEqual({});
  });

  it('refuses any other key, without sending the operator to a card a template does not have', () => {
    const errors = withScript('Your EMI {emi} is due');
    expect(Object.keys(errors)).toEqual(['agent_script.opening']);
    expect(errors['agent_script.opening']).toBe(
      'The script uses {emi}, which a template cannot fill in. Use only {name}, {place}, {amount_due}, {due_date}, {agent_name} and {campaign_name}.',
    );
    expect(errors['agent_script.opening']).not.toMatch(/card|fact/i);
  });
});

describe('the words', () => {
  it('says each section in one line', () => {
    const config = filledConfig('account', {
      hours: { calling_window_start: '10:00', calling_window_end: '20:00', calling_days: [1, 2, 3, 4, 5, 6], default_timezone: 'Asia/Kolkata' },
      agent_screen: { daily_target_calls: 80, agent_script: { steps: [{ text: 'Greet' }, { text: 'Ask' }] } },
    }, null);
    expect(sectionSummary('hours', config)).toBe('10:00 AM–8:00 PM · Mon to Sat · India time (IST)');
    expect(sectionSummary('agent_screen', config)).toBe('Full number · Target 80 calls a day · Script with 2 steps');
    expect(sectionSummary('retries', config)).toBe('The built-in retry rules');
    expect(sectionSummary('breaks', config)).toBe('The built-in break reasons, no limits');
    expect(sectionSummary('recording', config)).toBe('Off');
    expect(sectionSummary('numbers', config)).toMatch(/^No numbers · /);
    expect(sectionSummary('outcomes', config)).toMatch(/^\d+ outcomes: Voicemail, /);
    // The limit and the grace, the safety section's two settings (AG4).
    expect(sectionSummary('safety', config)).toBe('Pauses above 3% · Abandoned after 3 seconds');
    expect(sectionSummary('safety', { abandonment_ceiling_pct: 2.5, abandonment_grace_ms: 5000 })).toBe('Pauses above 2.5% · Abandoned after 5 seconds');
  });

  it('writes times and stamps as Indian English does', () => {
    expect(clockTime('00:05:00')).toBe('12:05 AM');
    expect(clockTime('12:00')).toBe('12:00 PM');
    const now = new Date('2026-11-22T10:00:00Z');
    expect(formatStamp('2026-11-18T16:12:00Z', now)).toBe('18 Nov, 4:12 PM');
    // Another year says which (N1).
    expect(formatStamp('2025-11-18T16:12:00Z', now)).toBe('18 Nov 2025, 4:12 PM');
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
