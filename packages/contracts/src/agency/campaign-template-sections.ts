/**
 * Campaign templates (`docs/campaign-templates.md`, rulings CT1–CT18): which campaign fields
 * belong to which section of a template. ONE declaration; nothing else lists them (§3). The
 * server's template routes, the create path's fill-in, the domain rules
 * (`packages/domain/src/campaign-templates.ts`) and the console's editors all read this map.
 *
 * A template sets a section or leaves it unset, and the first level of the chain that sets a
 * section wins it whole (CT2): the chosen template, then (for an account template) the
 * organisation template it is based on, then built-in. Inside a set section a field that is
 * absent means its built-in value, exactly as a campaign create that omits a field stores the
 * column default; it never means "take this one field from the next level".
 *
 * Not in any section: `name`, the roster, `context_display` (it names CSV columns), lifecycle and
 * retry-lineage columns.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel. Plain `as const` declarations so
 * `tooling/contracts-literals.mjs` can read them should the app ever need them.
 */

import type { AllListed } from '../primitives';
import type { AgencyFlagKey } from '../flags';
import type { AgencyCampaign } from '../api/agency/agency-campaign';

/** Section key → the `AgencyCampaign` fields it holds, in the order the editors show them. */
export const AGENCY_CAMPAIGN_TEMPLATE_SECTIONS = {
  // Together: automatic outcomes name catalog codes, so one cannot be taken without the other.
  outcomes: ['disposition_catalog', 'outcome_dispositions'],
  // The our-fault bound stays a platform rule (`AGENCY_OUR_FAULT_REDIAL_BOUND`), never a setting.
  retries: ['retry_policy'],
  // Start and end are checked together (`start !== end`), so they travel together.
  hours: ['calling_window_start', 'calling_window_end', 'calling_days', 'default_timezone'],
  wrapup: ['wrapup_seconds', 'wrapup_auto_return', 'allow_wrapup_redial'],
  breaks: ['break_reasons'],
  // `analysis_profile_id` is an account's thing: an organisation template holds `record_calls` only (CT5).
  recording: ['record_calls', 'analysis_profile_id'],
  agent_screen: ['agent_script', 'phone_display', 'daily_target_calls'],
  safety: ['abandonment_ceiling_pct'],
  // Only where contact assignment is on (`AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS`).
  assignment: [
    'assignment_mode',
    'on_unstaff',
    'callback_owner_grace_minutes',
    'callback_fallback',
    'allow_agent_retry',
    'agent_retry_rounds',
    'agent_retry_cooldown_minutes',
  ],
  // Only where inbound is on.
  inbound: ['inbound_sticky_enabled'],
  // Account templates only (CT15).
  numbers: ['caller_ids', 'telephony_provider', 'telephony_credential_id'],
} as const satisfies Record<string, readonly (keyof AgencyCampaign)[]>;

/** A section of a campaign template. */
export type AgencyCampaignTemplateSectionKey = keyof typeof AGENCY_CAMPAIGN_TEMPLATE_SECTIONS;

/** Every section key, in the order New campaign's Review and the template editor list them. */
export const AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS = [
  'outcomes',
  'retries',
  'hours',
  'wrapup',
  'breaks',
  'recording',
  'agent_screen',
  'safety',
  'assignment',
  'inbound',
  'numbers',
] as const satisfies readonly AgencyCampaignTemplateSectionKey[];

/** The fields of section `K`. */
export type AgencyCampaignTemplateSectionField<K extends AgencyCampaignTemplateSectionKey = AgencyCampaignTemplateSectionKey> =
  (typeof AGENCY_CAMPAIGN_TEMPLATE_SECTIONS)[K][number];

/** Every campaign field some section holds. */
export type AgencyCampaignTemplateField = AgencyCampaignTemplateSectionField;

/**
 * Sections an organisation template never holds (CT5, CT15): an account's caller IDs and carrier
 * account mean nothing in another account.
 */
export const AGENCY_CAMPAIGN_TEMPLATE_ACCOUNT_ONLY_SECTIONS = ['numbers'] as const satisfies readonly AgencyCampaignTemplateSectionKey[];

/**
 * Fields an organisation template never holds inside a section it does hold (CT5): the call
 * summary profile is a row of one account (`call_analysis_profiles`). An organisation template's
 * `recording` is `record_calls` alone; a campaign filled from it gets the built-in `null` here.
 */
export const AGENCY_CAMPAIGN_TEMPLATE_ORGANISATION_EXCLUDED_FIELDS = ['analysis_profile_id'] as const satisfies readonly AgencyCampaignTemplateField[];

/**
 * Sections behind a flag (CT5): where the flag is off for the account, the section fills in as
 * built-in (with a `section_flag_off` note when a template had set it), and the editor hides it.
 */
export const AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS = {
  assignment: 'agency_contact_assignment_enabled',
  inbound: 'agency_inbound_enabled',
} as const satisfies Partial<Record<AgencyCampaignTemplateSectionKey, AgencyFlagKey>>;

/**
 * The section fields where `null` is a setting, each a nullable `agency_campaigns` column:
 * `analysis_profile_id` (no call summary), `daily_target_calls` (no target),
 * `telephony_credential_id` (the service's own carrier account). Every other section field is a
 * NOT NULL column, so a template that sets it to `null` is refused
 * (`campaign_template_section_invalid`, keyed by the field): leaving the field out is how a section
 * takes its built-in value. A server integration test pins this list to the columns'
 * `is_nullable`.
 */
export const AGENCY_CAMPAIGN_TEMPLATE_NULLABLE_FIELDS = [
  'analysis_profile_id',
  'daily_target_calls',
  'telephony_credential_id',
] as const satisfies readonly AgencyCampaignTemplateField[];

/**
 * Section `K`'s values as a template stores them: every field optional (absent = its built-in
 * value; see the module note), never `undefined`. `null` is a value only on
 * {@link AGENCY_CAMPAIGN_TEMPLATE_NULLABLE_FIELDS}.
 */
export type AgencyCampaignTemplateSectionValues<K extends AgencyCampaignTemplateSectionKey> = {
  [F in AgencyCampaignTemplateSectionField<K>]?: Exclude<AgencyCampaign[F], undefined>;
};

/**
 * A template's sections (`agency_campaign_templates.sections`): a key present is a section the
 * template sets; a key absent follows the next level of the chain (CT2).
 */
export type AgencyCampaignTemplateSections = {
  [K in AgencyCampaignTemplateSectionKey]?: AgencyCampaignTemplateSectionValues<K>;
};

/**
 * A complete campaign configuration over every section's fields: what a template fills in for
 * New campaign (`GET /proxy/agency/campaign-templates/effective`, `config`), each field present.
 */
export type AgencyCampaignTemplateConfig = {
  [F in AgencyCampaignTemplateField]: Exclude<AgencyCampaign[F], undefined>;
};

/**
 * Where a section of a campaign's settings came from (CT9): the account template, the
 * organisation template, the built-in settings, or `campaign` (changed in New campaign, or sent
 * differently by an API create).
 */
export type AgencyCampaignTemplateSectionSource = 'account' | 'organisation' | 'builtin' | 'campaign';

export const AGENCY_CAMPAIGN_TEMPLATE_SECTION_SOURCES = [
  'account',
  'organisation',
  'builtin',
  'campaign',
] as const satisfies readonly AgencyCampaignTemplateSectionSource[];

/** Where each section of a filled-in template came from: never `campaign` (nothing was changed yet). */
export type AgencyCampaignTemplateFilledSource = Exclude<AgencyCampaignTemplateSectionSource, 'campaign'>;

/**
 * Why a filled-in section is not what the template says (CT5, CT15), shown beside the section in
 * New campaign:
 *
 *  - `recording_not_allowed`: the template records calls; this account cannot, so it is off.
 *  - `analysis_profile_unavailable`: the template's call summary profile is gone or this account
 *    has no analytics, so it is none (the server's judgement; the domain rules never raise it).
 *  - `numbers_unavailable`: some of the template's caller IDs are no longer usable by the account
 *    or its carrier and were dropped (`numbers` lists them; the server's judgement).
 *  - `carrier_unavailable`: the template's carrier account is no longer active for the account,
 *    so the numbers section is built-in (the server's judgement).
 *  - `section_flag_off`: a template set a section whose feature is off for the account
 *    (`AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS`), so it is built-in.
 *  - `outcome_overrides_off`: the template's outcomes carry agent overrides, which need contact
 *    assignment; it is off for the account, so the overrides were left out (the outcomes stay).
 */
export type AgencyCampaignTemplateNoteCode =
  | 'recording_not_allowed'
  | 'analysis_profile_unavailable'
  | 'numbers_unavailable'
  | 'carrier_unavailable'
  | 'section_flag_off'
  | 'outcome_overrides_off';

export const AGENCY_CAMPAIGN_TEMPLATE_NOTE_CODES = [
  'recording_not_allowed',
  'analysis_profile_unavailable',
  'numbers_unavailable',
  'carrier_unavailable',
  'section_flag_off',
  'outcome_overrides_off',
] as const satisfies readonly AgencyCampaignTemplateNoteCode[];

/** One note on a filled-in template: its code, the section it is about, and the numbers dropped (`numbers_unavailable` only). */
export interface AgencyCampaignTemplateNote {
  code: AgencyCampaignTemplateNoteCode;
  section: AgencyCampaignTemplateSectionKey;
  numbers?: string[];
}

// ── Guards (type level; `pnpm lint`) ─────────────────────────────────────────

const _sectionKeysListed: AllListed<AgencyCampaignTemplateSectionKey, typeof AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS> = true;
const _sourcesListed: AllListed<AgencyCampaignTemplateSectionSource, typeof AGENCY_CAMPAIGN_TEMPLATE_SECTION_SOURCES> = true;
const _notesListed: AllListed<AgencyCampaignTemplateNoteCode, typeof AGENCY_CAMPAIGN_TEMPLATE_NOTE_CODES> = true;

/** The fields section `K` shares with any other section: `never` for every `K` when no field is in two sections. */
type SharedFields = {
  [K in AgencyCampaignTemplateSectionKey]:
    AgencyCampaignTemplateSectionField<K> & AgencyCampaignTemplateSectionField<Exclude<AgencyCampaignTemplateSectionKey, K>>;
}[AgencyCampaignTemplateSectionKey];
const _noFieldInTwoSections: [SharedFields] extends [never] ? true : false = true;

/** The excluded fields sit in a section an organisation template may hold, or excluding them would say nothing. */
type ExcludedInAccountOnly = Extract<
  (typeof AGENCY_CAMPAIGN_TEMPLATE_ORGANISATION_EXCLUDED_FIELDS)[number],
  AgencyCampaignTemplateSectionField<(typeof AGENCY_CAMPAIGN_TEMPLATE_ACCOUNT_ONLY_SECTIONS)[number]>
>;
const _excludedFieldsOutsideAccountOnly: [ExcludedInAccountOnly] extends [never] ? true : false = true;

void [_sectionKeysListed, _sourcesListed, _notesListed, _noFieldInTwoSections, _excludedFieldsOutsideAccountOnly];
