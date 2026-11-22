import {
  AGENCY_CAMPAIGN_TEMPLATE_ACCOUNT_ONLY_SECTIONS,
  AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  type AgencyCampaignTemplateConfig,
  type AgencyCampaignTemplateScope,
  type AgencyCampaignTemplateSectionKey,
  type AgencyCampaignTemplateSections,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import type { AgencyPhoneDisplay } from '@magick-agency/contracts/agency';
import {
  builtinTemplateSections,
  diffSections,
  resolveTemplateSections,
  sectionsFromCampaign,
} from '@magick-agency/domain/campaign-templates';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import {
  buildConfigPayload,
  configFromCampaign,
  validateConfig,
  type CampaignConfigState,
} from '../../agencyCampaignConfigForm';
import {
  NO_ANALYSIS_PROFILE,
  recordingStateFromCampaign,
  resolveProfileId,
  type CampaignRecordingState,
} from '../../agencyCampaignRecording';
import {
  breakReasonsErrors,
  breakReasonsFormOf,
  breakReasonsPayload,
  sameBreakLimits,
  type BreakReasonsForm,
} from '../breakLimits';
import { scriptPlaceholdersFor } from '@magick-agency/domain/fact-fields';
import {
  dailyTargetError,
  listed,
  dailyTargetPayload,
  scriptErrors,
  scriptPayload,
  stationSettingsOf,
  type FactsForm,
  type ScriptForm,
} from '../stationSettings';
import { carrierOfCampaign, type CarrierChoice } from '../../agencyCarriers';

/**
 * Campaign templates' one wire ↔ form mapping (`docs/campaign-templates.md` §7). A template's
 * sections, a filled-in config (`/campaign-templates/effective`) and a campaign all hold the same
 * campaign fields (`AGENCY_CAMPAIGN_TEMPLATE_SECTIONS`), so the editors campaign Settings and New
 * campaign compose are fed by the console's existing campaign → form readers
 * (`configFromCampaign`, `recordingStateFromCampaign`, `breakReasonsFormOf`, `stationSettingsOf`,
 * `carrierOfCampaign`), and read back by their payload builders (`buildConfigPayload`,
 * `breakReasonsPayload`, `scriptPayload`, …). Normalising and comparing sections is the domain's
 * (`@magick-agency/domain/campaign-templates`), never done here.
 */

/** Every section's editors' state: what the template editor, New campaign's chips and Reset read. */
export interface TemplateForm {
  /** Outcomes, retries, hours, wrap-up, the abandonment limit, assignment and inbound. */
  config: CampaignConfigState;
  recording: CampaignRecordingState;
  breakReasons: BreakReasonsForm;
  /** The agent screen section: the target, the number display and the script (no card: a template holds none). */
  station: { dailyTarget: string; phoneDisplay: AgencyPhoneDisplay; script: ScriptForm };
  callerIds: string[];
  carrier: CarrierChoice;
}

/** What every section is named on screen, in `AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS` order. */
export const SECTION_LABELS: Readonly<Record<AgencyCampaignTemplateSectionKey, string>> = {
  outcomes: 'Outcomes',
  retries: 'Retries',
  hours: 'Calling hours',
  wrapup: 'Wrap-up',
  breaks: 'Breaks',
  recording: 'Recording',
  agent_screen: 'What agents see',
  safety: 'Abandonment limit',
  assignment: 'Contact assignment',
  inbound: 'Customers who ring in',
  numbers: 'Numbers to call from',
};

/**
 * The sections a template of `scope` can show and hold here: without the account-only ones on an
 * organisation template (CT5, CT15), and without those whose feature is off (`on`, by the gated
 * section's key; CT5). What the editor shows, and all that a copy of a campaign or of another
 * template may set (C6), so nothing is set that the editor cannot show or unset.
 */
export function templateSectionKeys(
  scope: AgencyCampaignTemplateScope,
  on: Readonly<Record<keyof typeof AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS, boolean>>,
): AgencyCampaignTemplateSectionKey[] {
  const accountOnly: readonly AgencyCampaignTemplateSectionKey[] = AGENCY_CAMPAIGN_TEMPLATE_ACCOUNT_ONLY_SECTIONS;
  return AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.filter(
    (key) => !(scope === 'organisation' && accountOnly.includes(key)) && !(key in on && !on[key as keyof typeof on]),
  );
}

/** Each field's name in a comparison, in plain words. */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  disposition_catalog: 'the outcomes',
  outcome_dispositions: 'what unanswered calls are filed as',
  retry_policy: 'the retry rules',
  calling_window_start: 'the start time',
  calling_window_end: 'the end time',
  calling_days: 'the days',
  default_timezone: 'the time zone',
  wrapup_seconds: 'the wrap-up time',
  wrapup_auto_return: 'what agents do after wrap-up',
  allow_wrapup_redial: 'redial from wrap-up',
  break_reasons: 'the break limits',
  record_calls: 'recording',
  analysis_profile_id: 'the call summary',
  agent_script: 'the script',
  phone_display: 'how the number is shown',
  daily_target_calls: 'the daily target',
  abandonment_ceiling_pct: 'the abandonment limit',
  assignment_mode: 'the assignment mode',
  on_unstaff: 'what happens when an agent is taken off',
  callback_owner_grace_minutes: 'how long a callback waits for its agent',
  callback_fallback: 'who takes a callback after that',
  allow_agent_retry: 'agent retry',
  agent_retry_rounds: 'agent retry rounds',
  agent_retry_cooldown_minutes: 'the wait between agent retries',
  inbound_sticky_enabled: 'putting callers through to their agent',
  caller_ids: 'the numbers',
  telephony_provider: 'the carrier',
  telephony_credential_id: 'the carrier account',
};

/** A template's script editor has no customer card (no facts to name a key by). */
export const TEMPLATE_FACTS: FactsForm = Object.freeze({ name: '', place: null, list: [], types: {} }) as FactsForm;

/**
 * The keys a template's script may use: the server's rule for a script with no card
 * (`scriptPlaceholdersFor(null)`, the legacy six, `AGENCY_SCRIPT_PLACEHOLDERS`), so the editor
 * takes what a save takes (CT4). New campaign fits it to the roster's card later (C10).
 */
export function templateScriptKeys(): string[] {
  return scriptPlaceholdersFor(null);
}

/** What a template's script is told of a key it may not use: the keys it may, never a card. */
export function templateUnknownKeysMessage(tokens: readonly string[]): string {
  const keys = listed(templateScriptKeys().map((key) => `{${key}}`));
  return `The script uses ${listed(tokens)}, which a template cannot fill in. Use only ${keys}.`;
}

/** What would stop a template's script saving, keyed by its field path. */
export function templateScriptErrors(script: ScriptForm): Record<string, string> {
  return scriptErrors(script, templateScriptKeys(), templateUnknownKeysMessage);
}

/** The campaign field `path` names (`disposition_catalog[2].code` → `disposition_catalog`). */
export function fieldOfPath(path: string): string {
  return path.split(/[.[]/)[0] ?? path;
}

const SECTION_OF_FIELD: ReadonlyMap<string, AgencyCampaignTemplateSectionKey> = new Map(
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.flatMap((key) =>
    (AGENCY_CAMPAIGN_TEMPLATE_SECTIONS[key] as readonly string[]).map((field) => [field, key] as const),
  ),
);

/** The section a campaign field path belongs to, or null (a field no section holds). */
export function sectionOfPath(path: string): AgencyCampaignTemplateSectionKey | null {
  return SECTION_OF_FIELD.get(fieldOfPath(path)) ?? null;
}

/** The editors' state for a complete config: the filled-in form, or any campaign's settings. */
export function formOfConfig(config: AgencyCampaignTemplateConfig | Partial<AgencyCampaign>): TemplateForm {
  // A config holds the campaign fields every section has; the readers default anything absent.
  const campaign = config as AgencyCampaign;
  const station = stationSettingsOf(campaign);
  return {
    config: configFromCampaign(campaign),
    recording: recordingStateFromCampaign(campaign),
    breakReasons: breakReasonsFormOf(campaign.break_reasons),
    station: { dailyTarget: station.dailyTarget, phoneDisplay: station.phoneDisplay, script: station.script },
    callerIds: [...(campaign.caller_ids ?? [])],
    carrier: carrierOfCampaign(campaign),
  };
}

/** The editors' state for a template's sections, each unset section from `inherited` (CT2). */
export function formOfSections(
  scope: AgencyCampaignTemplateScope,
  sections: AgencyCampaignTemplateSections,
  inherited: AgencyCampaignTemplateSections | null,
): TemplateForm {
  return formOfConfig(filledConfig(scope, sections, inherited));
}

/**
 * The config a template's sections fill in, before any account's limits (every capability on):
 * the template's own sections, then (for an account template) the organisation template it
 * follows, then built-in (CT2).
 */
export function filledConfig(
  scope: AgencyCampaignTemplateScope,
  sections: AgencyCampaignTemplateSections,
  inherited: AgencyCampaignTemplateSections | null,
): AgencyCampaignTemplateConfig {
  return resolveTemplateSections({
    chosen: { scope, sections },
    basedOn: inherited ? { sections: inherited } : null,
    builtin: builtinTemplateSections(),
    can: { record: true, assignment: true, inbound: true },
  }).config;
}

/**
 * The break reasons as a section holds them: `[]` while the form is the built-ins untouched (the
 * built-in value, served at read time), else the list as campaign Settings would save it.
 */
function breakReasonsValue(form: BreakReasonsForm): AgencyCampaign['break_reasons'] {
  return form.builtIn && sameBreakLimits(form, breakReasonsFormOf([])) ? [] : breakReasonsPayload(form);
}

/** The form as campaign fields: every section's, as campaign Settings would save them. */
export function campaignFieldsOfForm(form: TemplateForm): Partial<AgencyCampaign> {
  return {
    ...buildConfigPayload(form.config, 'all'),
    record_calls: form.recording.record,
    analysis_profile_id: resolveProfileId(form.recording.profileId),
    break_reasons: breakReasonsValue(form.breakReasons),
    agent_script: scriptPayload(form.station.script),
    phone_display: form.station.phoneDisplay,
    daily_target_calls: dailyTargetPayload(form.station.dailyTarget),
    caller_ids: [...form.callerIds],
    telephony_provider: form.carrier.telephony_provider,
    telephony_credential_id: form.carrier.telephony_credential_id,
  };
}

/** Sections `keys` of the form, normalised by the domain, as a template in `scope` stores them. */
export function sectionsOfForm(
  form: TemplateForm,
  scope: AgencyCampaignTemplateScope,
  keys: readonly AgencyCampaignTemplateSectionKey[],
): AgencyCampaignTemplateSections {
  return sectionsFromCampaign(campaignFieldsOfForm(form), scope, keys);
}

/** Whether section `key` of two forms (or a form and a config) is the same setting, by the domain's rule. */
export function sameSection(
  key: AgencyCampaignTemplateSectionKey,
  a: Partial<AgencyCampaign> | AgencyCampaignTemplateConfig,
  b: Partial<AgencyCampaign> | AgencyCampaignTemplateConfig,
): boolean {
  return diffSections(sectionsFromCampaign(a, 'account', [key]), sectionsFromCampaign(b, 'account', [key])).length === 0;
}

/** `target` with section `key` taken from `source`: Reset, and "Use <template>" in the editor. */
export function withSectionFrom(target: TemplateForm, source: TemplateForm, key: AgencyCampaignTemplateSectionKey): TemplateForm {
  const c = source.config;
  switch (key) {
    case 'outcomes':
      return {
        ...target,
        config: { ...target.config, dispositions: c.dispositions.map((d) => ({ ...d })), outcomeDispositions: { ...c.outcomeDispositions } },
      };
    case 'retries':
      return { ...target, config: { ...target.config, retryPolicy: { ...c.retryPolicy } } };
    case 'hours':
      return { ...target, config: { ...target.config, window: { ...c.window, days: [...c.window.days] } } };
    case 'wrapup':
      return {
        ...target,
        config: { ...target.config, wrapupSeconds: c.wrapupSeconds, autoReturn: c.autoReturn, allowWrapupRedial: c.allowWrapupRedial },
      };
    case 'safety':
      return {
        ...target,
        config: { ...target.config, abandonmentCeilingPct: c.abandonmentCeilingPct, abandonmentCeilingStoredPct: c.abandonmentCeilingStoredPct },
      };
    case 'assignment':
      return { ...target, config: { ...target.config, assignment: { ...c.assignment } } };
    case 'inbound':
      return { ...target, config: { ...target.config, inboundSticky: c.inboundSticky } };
    case 'breaks':
      return { ...target, breakReasons: source.breakReasons };
    case 'recording':
      return { ...target, recording: { ...source.recording } };
    case 'agent_screen':
      return { ...target, station: { ...source.station, script: { ...source.station.script, steps: [...source.station.script.steps] } } };
    case 'numbers':
      return { ...target, callerIds: [...source.callerIds], carrier: { ...source.carrier } };
  }
}

/** The recording an organisation template may hold: `record_calls` only (CT5). */
export function organisationRecording(recording: CampaignRecordingState): CampaignRecordingState {
  return { record: recording.record, profileId: NO_ANALYSIS_PROFILE };
}

/**
 * What would stop the template saving, keyed by campaign field path, for the sections it sets:
 * the checks campaign Settings makes as a field is typed (the server repeats them, CT4).
 */
export function templateFormErrors(
  form: TemplateForm,
  setKeys: readonly AgencyCampaignTemplateSectionKey[],
): Record<string, string> {
  const set = new Set(setKeys);
  const errors: Record<string, string> = {};
  for (const [path, message] of Object.entries(validateConfig(form.config))) {
    const key = sectionOfPath(path);
    if (key !== null && set.has(key)) errors[path] = message;
  }
  if (set.has('breaks')) {
    for (const [code, message] of Object.entries(breakReasonsErrors(form.breakReasons))) errors[`break_reasons.${code}`] = message;
  }
  if (set.has('agent_screen')) {
    const target = dailyTargetError(form.station.dailyTarget);
    if (target) errors['daily_target_calls'] = target;
    Object.assign(errors, templateScriptErrors(form.station.script));
  }
  if (set.has('numbers') && form.callerIds.length === 0) errors['caller_ids'] = 'Pick at least one number, or use the inherited numbers.';
  return errors;
}
