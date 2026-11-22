import { describe, expect, it } from 'vitest';
import {
  AGENCY_CAMPAIGN_COLUMN_DEFAULTS,
  AGENCY_NEW_CAMPAIGN_TIMEZONE,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS,
  AGENCY_CONTACT_ASSIGNMENT_DEFAULTS,
  AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT,
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  AGENCY_PHONE_DISPLAY_DEFAULT,
  type AgencyCampaignTemplateSectionKey as Key,
  type AgencyCampaignTemplateSections,
} from '@magick-agency/contracts/agency';
import type { AgencyCampaign } from '@magick-agency/contracts/api/agency/agency-campaign';
import {
  accountOnlyPartsIn,
  builtinTemplateSections,
  diffSections,
  normaliseSection,
  resolveTemplateSections,
  sameTemplateValue,
  sectionKeysSet,
  sectionSourcesForCreate,
  sectionsFromCampaign,
  type TemplateCapabilities,
} from '../../../src/campaign-templates';

/**
 * Campaign templates' pure rules (docs/campaign-templates.md §5): the built-in settings, the
 * chain (CT2), the account's limits (CT5), a campaign as sections, the differences and a created
 * campaign's sources (CT9).
 */

const BUILTIN = builtinTemplateSections();
const ALL: TemplateCapabilities = { record: true, assignment: true, inbound: true };
const KEYS = [...AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS];

/** A value for every section, each differing from built-in in every field. */
const ORG_VALUES: Required<AgencyCampaignTemplateSections> = {
  outcomes: {
    disposition_catalog: [{ code: 'paid', label: 'Paid', is_success: true }],
    outcome_dispositions: {},
  },
  retries: { retry_policy: { no_answer: { delay_minutes: 60, max_attempts: 2 } } },
  hours: { calling_window_start: '10:00:00', calling_window_end: '18:00:00', calling_days: [1, 2, 3], default_timezone: 'Asia/Kolkata' },
  wrapup: { wrapup_seconds: 45, wrapup_auto_return: false, allow_wrapup_redial: true },
  breaks: { break_reasons: [{ code: 'lunch', label: 'Lunch', limit_minutes: 30 }] },
  recording: { record_calls: true, analysis_profile_id: '11111111-1111-4111-8111-111111111111' },
  agent_screen: { agent_script: { opening: 'Hello' }, phone_display: 'masked', daily_target_calls: 40 },
  safety: { abandonment_ceiling_pct: 2 },
  assignment: {
    assignment_mode: 'strict', on_unstaff: 'keep', callback_owner_grace_minutes: 60, callback_fallback: 'wait',
    allow_agent_retry: true, agent_retry_rounds: 2, agent_retry_cooldown_minutes: 10,
  },
  inbound: { inbound_sticky_enabled: false },
  numbers: { caller_ids: ['+918000000001'], telephony_provider: 'plivo', telephony_credential_id: '22222222-2222-4222-8222-222222222222' },
};

/** Another value for every section, differing from both built-in and {@link ORG_VALUES}. */
const ACCOUNT_VALUES: Required<AgencyCampaignTemplateSections> = {
  outcomes: {
    disposition_catalog: [{ code: 'will_pay', label: 'Will pay' }, { code: 'refused', label: 'Refused' }],
    outcome_dispositions: { busy: 'refused' },
  },
  retries: { retry_policy: { busy: { delay_minutes: 15, max_attempts: 1 } } },
  hours: { calling_window_start: '08:00:00', calling_window_end: '21:00:00', calling_days: [1, 2, 3, 4, 5, 6], default_timezone: 'Asia/Dubai' },
  wrapup: { wrapup_seconds: 20, wrapup_auto_return: true, allow_wrapup_redial: false },
  breaks: { break_reasons: [{ code: 'tea', label: 'Tea' }] },
  recording: { record_calls: false, analysis_profile_id: '33333333-3333-4333-8333-333333333333' },
  agent_screen: { agent_script: { steps: [{ text: 'Ask' }] }, phone_display: 'full', daily_target_calls: 25 },
  safety: { abandonment_ceiling_pct: 2.5 },
  assignment: {
    assignment_mode: 'preferred', on_unstaff: 'return_to_pool', callback_owner_grace_minutes: 15, callback_fallback: 'pool',
    allow_agent_retry: false, agent_retry_rounds: 3, agent_retry_cooldown_minutes: 5,
  },
  inbound: { inbound_sticky_enabled: false },
  numbers: { caller_ids: ['+918000000002', '+918000000003'], telephony_provider: 'voicelink', telephony_credential_id: null },
};

const only = <K extends Key>(values: Required<AgencyCampaignTemplateSections>, ...keys: K[]): AgencyCampaignTemplateSections =>
  Object.fromEntries(keys.map((k) => [k, values[k]])) as AgencyCampaignTemplateSections;

const account = (sections: AgencyCampaignTemplateSections) => ({ scope: 'account' as const, sections });
const organisation = (sections: AgencyCampaignTemplateSections) => ({ scope: 'organisation' as const, sections });

const resolve = (
  chosen: Parameters<typeof resolveTemplateSections>[0]['chosen'],
  basedOn: AgencyCampaignTemplateSections | null = null,
  can: TemplateCapabilities = ALL,
) => resolveTemplateSections({ chosen, basedOn: basedOn ? { sections: basedOn } : null, builtin: BUILTIN, can });

const flatten = (sections: Record<string, object>) => Object.assign({}, ...KEYS.map((k) => sections[k]));

describe('builtinTemplateSections', () => {
  it('is every section with every field, from the contract\'s constants', () => {
    expect(BUILTIN).toEqual({
      outcomes: { disposition_catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG], outcome_dispositions: {} },
      retries: { retry_policy: {} },
      hours: {
        calling_window_start: AGENCY_CAMPAIGN_COLUMN_DEFAULTS.calling_window_start,
        calling_window_end: AGENCY_CAMPAIGN_COLUMN_DEFAULTS.calling_window_end,
        calling_days: [...AGENCY_CAMPAIGN_COLUMN_DEFAULTS.calling_days],
        default_timezone: AGENCY_NEW_CAMPAIGN_TIMEZONE,
      },
      wrapup: { wrapup_seconds: 30, wrapup_auto_return: true, allow_wrapup_redial: false },
      breaks: { break_reasons: [] },
      recording: { record_calls: false, analysis_profile_id: null },
      agent_screen: { agent_script: {}, phone_display: AGENCY_PHONE_DISPLAY_DEFAULT, daily_target_calls: null },
      safety: { abandonment_ceiling_pct: AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT },
      assignment: { ...AGENCY_CONTACT_ASSIGNMENT_DEFAULTS },
      inbound: { inbound_sticky_enabled: true },
      numbers: { caller_ids: [], telephony_provider: 'voicelink', telephony_credential_id: null },
    });
    for (const key of KEYS) expect(Object.keys(BUILTIN[key])).toEqual([...AGENCY_CAMPAIGN_TEMPLATE_SECTIONS[key]]);
  });

  it('retries is "no rule stored": the retry engine applies its own default per outcome at run time', () => {
    expect(BUILTIN.retries.retry_policy).toEqual({});
  });

  it('is one deeply frozen object, sharing nothing with the contract\'s catalog', () => {
    expect(builtinTemplateSections()).toBe(BUILTIN);
    expect(Object.isFrozen(BUILTIN.outcomes.disposition_catalog[0])).toBe(true);
    expect(Object.isFrozen(BUILTIN.hours.calling_days)).toBe(true);
    expect(BUILTIN.outcomes.disposition_catalog[0]).not.toBe(AGENCY_DEFAULT_DISPOSITION_CATALOG[0]);
  });
});

describe('resolveTemplateSections: the chain (CT2)', () => {
  it('no template: every section built-in, no notes, the config the sections flattened', () => {
    const r = resolve(null);
    expect(r.sections).toEqual(BUILTIN);
    expect(Object.values(r.sources)).toEqual(KEYS.map(() => 'builtin'));
    expect(r.notes).toEqual([]);
    expect(r.config).toEqual(flatten(BUILTIN));
  });

  it.each(KEYS)('an account template alone sets %s for the account, and nothing else', (key) => {
    const r = resolve(account(only(ACCOUNT_VALUES, key)));
    for (const k of KEYS) {
      expect(r.sources[k], k).toBe(k === key ? 'account' : 'builtin');
      expect(r.sections[k], k).toEqual(k === key ? ACCOUNT_VALUES[k] : BUILTIN[k]);
    }
  });

  it.each(KEYS.filter((k) => k !== 'numbers'))('an organisation template alone sets %s for the organisation', (key) => {
    const r = resolve(organisation(only(ORG_VALUES, key)));
    expect(r.sources[key]).toBe('organisation');
    const expected = key === 'recording' ? { ...ORG_VALUES.recording, analysis_profile_id: null } : ORG_VALUES[key];
    expect(r.sections[key]).toEqual(expected);
  });

  it.each(KEYS.filter((k) => k !== 'numbers'))('an account template that leaves %s unset follows its organisation template there', (key) => {
    const r = resolve(account({}), only(ORG_VALUES, key));
    expect(r.sources[key]).toBe('organisation');
    for (const k of KEYS.filter((x) => x !== key)) expect(r.sources[k], k).toBe('builtin');
  });

  it.each(KEYS)('both set %s: the account template wins it, the organisation keeps the rest (sections independent)', (key) => {
    const r = resolve(account(only(ACCOUNT_VALUES, key)), ORG_VALUES);
    expect(r.sources[key]).toBe('account');
    expect(r.sections[key]).toEqual(ACCOUNT_VALUES[key]);
    for (const k of KEYS.filter((x) => x !== key && x !== 'numbers')) expect(r.sources[k], k).toBe('organisation');
    // The organisation template's numbers are never read (CT5).
    if (key !== 'numbers') expect(r.sources.numbers).toBe('builtin');
  });

  it('a section is won whole: a field the winner leaves out is built-in, never the organisation\'s', () => {
    const r = resolve(account({ hours: { calling_window_start: '07:00' } }), ORG_VALUES);
    expect(r.sources.hours).toBe('account');
    expect(r.sections.hours).toEqual({ ...BUILTIN.hours, calling_window_start: '07:00:00' });
  });

  it('an organisation template is never based on another: basedOn is ignored for it', () => {
    const r = resolve(organisation({}), ORG_VALUES);
    expect(Object.values(r.sources)).toEqual(KEYS.map(() => 'builtin'));
  });

  it('the config is the sections flattened', () => {
    const r = resolve(account(ACCOUNT_VALUES), ORG_VALUES);
    expect(r.config).toEqual(flatten(ACCOUNT_VALUES));
  });
});

describe('resolveTemplateSections: the account\'s limits (CT5, CT15)', () => {
  it('an organisation template\'s numbers and summary profile are never read', () => {
    const chosen = resolve(organisation(ORG_VALUES));
    expect(chosen.sources.numbers).toBe('builtin');
    expect(chosen.sections.numbers).toEqual(BUILTIN.numbers);
    expect(chosen.sections.recording).toEqual({ record_calls: true, analysis_profile_id: null });
    const followed = resolve(account({}), ORG_VALUES);
    expect(followed.sections.numbers).toEqual(BUILTIN.numbers);
    expect(followed.sections.recording.analysis_profile_id).toBeNull();
  });

  it('numbers come from an account template only', () => {
    const r = resolve(account(only(ACCOUNT_VALUES, 'numbers')), ORG_VALUES);
    expect(r.sources.numbers).toBe('account');
    expect(r.config.caller_ids).toEqual(ACCOUNT_VALUES.numbers.caller_ids);
  });

  it.each([
    { from: 'account', chosen: account({ recording: { record_calls: true } }), basedOn: null },
    { from: 'organisation', chosen: account({}), basedOn: { recording: { record_calls: true } } },
  ] as const)('record_calls from the $from template is off where the account cannot record, with a note', ({ chosen, basedOn }) => {
    const r = resolve(chosen, basedOn, { ...ALL, record: false });
    expect(r.config.record_calls).toBe(false);
    expect(r.notes).toEqual([{ code: 'recording_not_allowed', section: 'recording' }]);
    expect(resolve(chosen, basedOn).config.record_calls).toBe(true);
    expect(resolve(chosen, basedOn).notes).toEqual([]);
  });

  it('recording off asks nothing of an account that cannot record: no note', () => {
    const r = resolve(account({ recording: { record_calls: false } }), null, { ...ALL, record: false });
    expect(r.notes).toEqual([]);
  });

  it.each([
    { section: 'assignment', can: { ...ALL, assignment: false } },
    { section: 'inbound', can: { ...ALL, inbound: false } },
  ] as const)('$section with its flag off is built-in, with a note, from either level', ({ section, can }) => {
    for (const [chosen, basedOn] of [[account(ACCOUNT_VALUES), null], [account({}), ORG_VALUES]] as const) {
      const r = resolve(chosen, basedOn, can);
      expect(r.sources[section]).toBe('builtin');
      expect(r.sections[section]).toEqual(BUILTIN[section]);
      expect(r.notes).toEqual([{ code: 'section_flag_off', section }]);
    }
    // Nobody set it: built-in anyway, nothing to say.
    expect(resolve(account({}), null, can).notes).toEqual([]);
  });

  it('every limit at once: each note once, flags in section order, then recording', () => {
    const chosen = account({ ...ACCOUNT_VALUES, recording: { record_calls: true } });
    const r = resolve(chosen, ORG_VALUES, { record: false, assignment: false, inbound: false });
    expect(r.notes.map((n) => `${n.code}:${n.section}`)).toEqual([
      'section_flag_off:assignment', 'section_flag_off:inbound', 'recording_not_allowed:recording',
    ]);
  });
});

describe('sectionsFromCampaign', () => {
  const campaign = { id: 'c1', name: 'Book 1', status: 'draft', context_display: { hidden: ['pan'] }, ...flatten(ACCOUNT_VALUES) };

  it('an account template takes every section as the campaign holds it, and nothing outside a section', () => {
    expect(sectionsFromCampaign(campaign, 'account')).toEqual(ACCOUNT_VALUES);
  });

  it('an organisation template leaves out the numbers and the summary profile (CT5)', () => {
    const s = sectionsFromCampaign(campaign, 'organisation');
    expect(s.numbers).toBeUndefined();
    expect(s.recording).toEqual({ record_calls: false });
    expect(accountOnlyPartsIn(s)).toEqual([]);
  });

  it('normalises: HH:MM to HH:MM:SS, days sorted once, an absent field built-in', () => {
    const s = sectionsFromCampaign({ calling_window_start: '08:30', calling_days: [5, 1, 1, 3] }, 'account', ['hours']);
    expect(s).toEqual({ hours: { ...BUILTIN.hours, calling_window_start: '08:30:00', calling_days: [1, 3, 5] } });
  });

  it('reads a filled-in config, and a template made from it fills in the same config', () => {
    const r = resolve(account(ACCOUNT_VALUES));
    const again = resolve(account(sectionsFromCampaign(r.config, 'account')));
    expect(again.config).toEqual(r.config);
  });
});

describe('diffSections', () => {
  it('nothing differs between a set of sections and itself', () => {
    expect(diffSections(ACCOUNT_VALUES, ACCOUNT_VALUES)).toEqual([]);
  });

  it('an untouched section never reads as changed: key order, HH:MM, day order, written-out false and null', () => {
    const a: AgencyCampaignTemplateSections = {
      hours: { calling_window_start: '09:00', calling_days: [5, 4, 3, 2, 1] },
      outcomes: { disposition_catalog: [{ code: 'x', label: 'X', retry: { max_attempts: 2, delay_minutes: 5 } }] },
      recording: {},
    };
    const b: AgencyCampaignTemplateSections = {
      recording: { analysis_profile_id: null, record_calls: false },
      outcomes: {
        outcome_dispositions: {},
        disposition_catalog: [{ label: 'X', code: 'x', suppress: false, terminal: undefined, retry: { delay_minutes: 5, max_attempts: 2 } }],
      },
      hours: { ...BUILTIN.hours },
    };
    expect(diffSections(a, b)).toEqual([]);
  });

  it('names each changed section once, in section order, with exactly its changed fields', () => {
    const b = {
      ...ACCOUNT_VALUES,
      hours: { ...ACCOUNT_VALUES.hours, default_timezone: 'UTC', calling_days: [1] },
      safety: { abandonment_ceiling_pct: 3 },
    };
    expect(diffSections(ACCOUNT_VALUES, b)).toEqual([
      { section: 'hours', change: 'changed', fields: ['calling_days', 'default_timezone'] },
      { section: 'safety', change: 'changed', fields: ['abandonment_ceiling_pct'] },
    ]);
  });

  it('a section one side sets and the other leaves to the next level is set or unset, every field listed', () => {
    expect(diffSections({}, { wrapup: { wrapup_seconds: 30 } })).toEqual([
      { section: 'wrapup', change: 'set', fields: ['wrapup_seconds', 'wrapup_auto_return', 'allow_wrapup_redial'] },
    ]);
    expect(diffSections({ breaks: { break_reasons: [] } }, {})).toEqual([
      { section: 'breaks', change: 'unset', fields: ['break_reasons'] },
    ]);
  });

  it('array order is a change: a catalog\'s order is the station\'s', () => {
    const [first, second] = ACCOUNT_VALUES.outcomes.disposition_catalog!;
    const swapped = { outcomes: { ...ACCOUNT_VALUES.outcomes, disposition_catalog: [second!, first!] } };
    expect(diffSections(only(ACCOUNT_VALUES, 'outcomes'), swapped)).toEqual([
      { section: 'outcomes', change: 'changed', fields: ['disposition_catalog'] },
    ]);
  });

  it('a top-level false or null is a value, not an absence', () => {
    expect(sameTemplateValue(false, undefined)).toBe(false);
    expect(sameTemplateValue(null, undefined)).toBe(false);
    expect(sameTemplateValue({ a: false, b: null }, {})).toBe(true);
    expect(sameTemplateValue([{ a: false }], [{}])).toBe(true);
  });
});

describe('sectionSourcesForCreate (CT9)', () => {
  const resolved = resolve(account(only(ACCOUNT_VALUES, 'hours', 'outcomes')), only(ORG_VALUES, 'wrapup'));

  it('a section left out keeps the filled-in source', () => {
    const sources = sectionSourcesForCreate({ name: 'Book 1' }, resolved);
    expect(sources).toEqual(resolved.sources);
    expect(sources.hours).toBe('account');
    expect(sources.wrapup).toBe('organisation');
    expect(sources.safety).toBe('builtin');
  });

  it('a section sent as filled in, field order and HH:MM aside, keeps its source', () => {
    const sent = { ...resolved.config, calling_window_start: '08:00', calling_window_end: '21:00' };
    expect(sectionSourcesForCreate(sent, resolved)).toEqual(resolved.sources);
  });

  it.each([
    { section: 'hours', sent: { calling_window_end: '19:00' } },
    { section: 'wrapup', sent: { wrapup_seconds: 10 } },
    { section: 'safety', sent: { abandonment_ceiling_pct: 1 } },
    // An empty outcome list is an opinion, kept as sent (CT8).
    { section: 'outcomes', sent: { disposition_catalog: [], outcome_dispositions: {} } },
  ] as Array<{ section: Key; sent: Partial<AgencyCampaign> }>)('a $section changed in New campaign is the campaign\'s', ({ section, sent }) => {
    const sources = sectionSourcesForCreate({ ...resolved.config, ...sent }, resolved);
    for (const k of KEYS) expect(sources[k], k).toBe(k === section ? 'campaign' : resolved.sources[k]);
  });

  it('a section sent in part is the campaign\'s when its other fields differ from the filled-in ones: absent is built-in, as stored', () => {
    // The account template's hours start at 08:00; a body sending only the same start stores
    // the built-in end, days and zone (CT8), which is not the template's hours.
    expect(sectionSourcesForCreate({ calling_window_start: '08:00:00' }, resolved).hours).toBe('campaign');
    // Built-in safety sent in part as built-in: unchanged.
    expect(sectionSourcesForCreate({ abandonment_ceiling_pct: AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT }, resolved).safety).toBe('builtin');
  });
});

describe('the small helpers', () => {
  it('accountOnlyPartsIn names the numbers section and the summary profile, nothing else', () => {
    expect(accountOnlyPartsIn(ACCOUNT_VALUES)).toEqual(['analysis_profile_id', 'numbers']);
    expect(accountOnlyPartsIn({ recording: { record_calls: true } })).toEqual([]);
    expect(accountOnlyPartsIn({})).toEqual([]);
  });

  it('sectionKeysSet lists the sections set, in section order', () => {
    expect(sectionKeysSet({ numbers: {}, hours: {} })).toEqual(['hours', 'numbers']);
  });

  it('normaliseSection of an unset section is the built-in section, a copy', () => {
    const s = normaliseSection('outcomes', undefined);
    expect(s).toEqual(BUILTIN.outcomes);
    expect(s.disposition_catalog).not.toBe(BUILTIN.outcomes.disposition_catalog);
  });
});
