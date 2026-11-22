/*
 * What the campaign template routes check of a body (docs/campaign-templates.md §6, CT4, CT5,
 * CT13, CT15). Part of `proxy-agency-campaign-templates.routes.ts`.
 *
 *  - The body's shape (zod), the name and description (CT13: the account name's rule, AA2,
 *    `visibleNameSchema`): `400 campaign_template_invalid` with `details`.
 *  - The sections' shape: only the section map's keys, each an object holding only its own
 *    fields (`AGENCY_CAMPAIGN_TEMPLATE_SECTIONS`): `400 campaign_template_invalid`.
 *  - CT4, each section as a campaign create checks it ({@link sectionConfigIssues}): a body made of
 *    the sections it sets, a field a section leaves out at its built-in value (what the fill-in
 *    gives, §5), run through both of the create's validators: the public layer's
 *    (`agency/agency-campaign-config.ts`) and the internal handler's over the column defaults
 *    (`configRejected`'s `validateAgencyCampaignConfig(body, CAMPAIGN_CONFIG_COLUMN_DEFAULTS)`).
 *    The details are keyed by the campaign's own field paths, with the create's messages, so an
 *    editor marks the field where campaign Settings does: `400 campaign_template_section_invalid`.
 *  - The account checks a campaign create reads the database for ({@link sectionAccountIssues}),
 *    on an account template: the call summary profile (`preflightAnalysisProfile`, as
 *    `analysisProfileRejected`) and the numbers (`callerIdsIssue`: a set numbers section names at
 *    least one, and `campaignCarrierRefusal`, as `carrierRejected`). Same refusal, same keying.
 *  - `null` only where a campaign column may hold it (`AGENCY_CAMPAIGN_TEMPLATE_NULLABLE_FIELDS`,
 *    {@link sectionNullIssues}): `400 campaign_template_section_invalid`, keyed by the field.
 *  - The sections are stored as a campaign stores them ({@link storedTemplateSections}), and judged so.
 *  - CT5, scope: an organisation template holds no account-only part (`accountOnlyPartsIn`):
 *    `400 campaign_template_scope_invalid`.
 */
import { z } from 'zod';
import {
  AGENCY_CAMPAIGN_TEMPLATE_APPLY_MAX_CAMPAIGNS,
  AGENCY_CAMPAIGN_TEMPLATE_DESCRIPTION_MAX,
  AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX,
  AGENCY_CAMPAIGN_TEMPLATE_NULLABLE_FIELDS,
  AGENCY_CAMPAIGN_TEMPLATE_SCOPES,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS_MAX_BYTES,
  type AgencyCampaignTemplateSectionKey,
  type AgencyCampaignTemplateSections,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { builtinTemplateSections } from '@magick-agency/domain/campaign-templates';
import { visibleNameSchema } from '../../validators/account.validator.js';
import { validateAgencyCampaignConfig as validatePublicConfig, issuesToDetails } from '../../../agency/agency-campaign-config.js';
import { CAMPAIGN_CONFIG_COLUMN_DEFAULTS, validateAgencyCampaignConfig as validateStoredConfig } from '../../../agency/campaign-config.js';
import { preflightAnalysisProfile } from '../../../analysis/profile-preflight.js';
import { campaignCarrierRefusal } from '../../../agency/campaign-carrier.js';
import { callerIdsIssue } from '../agency-campaigns/guards.js';
import { storedSettingValues } from '../../../agency/campaign-stored-values.js';
import { UUID_RE } from '../../../utils/uuid.js';

const SECTION_KEYS: ReadonlySet<string> = new Set(AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS);

/** Each campaign field a section holds → that section. */
const SECTION_OF_FIELD: ReadonlyMap<string, AgencyCampaignTemplateSectionKey> = new Map(
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.flatMap((key) =>
    (AGENCY_CAMPAIGN_TEMPLATE_SECTIONS[key] as readonly string[]).map((field) => [field, key] as const)),
);

const uuid = z.string().regex(UUID_RE, 'must be an id');

/** CT13: the name (AA2's rule) and an optional description, at most 280 characters, blank read as none. */
const nameSchema = visibleNameSchema(AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX, 'Template name');
const descriptionSchema = z
  .string()
  .trim()
  .max(AGENCY_CAMPAIGN_TEMPLATE_DESCRIPTION_MAX)
  .nullable()
  .transform((d) => (d === null || d === '' ? null : d));

/**
 * The sections as JSON objects, at most `AGENCY_CAMPAIGN_TEMPLATE_SECTIONS_MAX_BYTES` serialised
 * (each save keeps a copy in the history), checked with the body before anything is read; which
 * keys and fields they may hold is {@link sectionsShapeIssues}'s.
 */
const sectionsSchema = z.record(z.string(), z.record(z.string(), z.unknown()))
  .refine((sections) => Buffer.byteLength(JSON.stringify(sections), 'utf8') <= AGENCY_CAMPAIGN_TEMPLATE_SECTIONS_MAX_BYTES, {
    message: `The template's settings are too large: at most ${AGENCY_CAMPAIGN_TEMPLATE_SECTIONS_MAX_BYTES / 1024} KB.`,
  });

/** `POST /campaign-templates` (`AgencyCreateCampaignTemplateRequest`). */
export const createTemplateSchema = z.object({
  scope: z.enum(AGENCY_CAMPAIGN_TEMPLATE_SCOPES),
  name: nameSchema,
  description: descriptionSchema.optional(),
  based_on_template_id: uuid.nullable().optional(),
  sections: sectionsSchema,
  make_default: z.boolean().optional(),
}).strict();

/** `PUT /campaign-templates/:id` (`AgencyReplaceCampaignTemplateRequest`): the whole content. */
export const replaceTemplateSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  based_on_template_id: uuid.nullable(),
  sections: sectionsSchema,
  expected_version: z.number().int().min(1),
}).strict();

/** `POST /campaign-templates/:id/apply` (`AgencyCampaignTemplateApplyRequest`, CT16). */
export const applyTemplateSchema = z.object({
  // Lower-cased first, so one campaign named in two cases is named twice.
  campaign_ids: z.array(z.string().transform((id) => id.toLowerCase())).min(1).max(AGENCY_CAMPAIGN_TEMPLATE_APPLY_MAX_CAMPAIGNS)
    .refine((ids) => new Set(ids).size === ids.length, 'each campaign once'),
  sections: z.array(z.enum(AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS)).min(1)
    .refine((keys) => new Set(keys).size === keys.length, 'each section once'),
  expected_version: z.number().int().min(1).optional(),
}).strict();

/** `GET /campaign-templates?archived=true`. */
export const listQuerySchema = z.object({
  archived: z.enum(['true', 'false']).optional(),
}).strip();

/** `GET /campaign-templates/effective?template_id=`. */
export const effectiveQuerySchema = z.object({
  template_id: z.string().optional(),
}).strip();

/** A zod error as `{ path: message }` (the first message per path), the template refusals' `details`. */
export function zodDetails(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'body';
    if (!(path in details)) details[path] = issue.message;
  }
  return details;
}

/** The sections' keys and fields (module note): `{ 'sections.<key>[.<field>]': message }`, empty when well-formed. */
export function sectionsShapeIssues(sections: Record<string, Record<string, unknown>>): Record<string, string> {
  const details: Record<string, string> = {};
  for (const [key, values] of Object.entries(sections)) {
    if (!SECTION_KEYS.has(key)) {
      details[`sections.${key}`] = `is not a section; the sections are ${AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.join(', ')}`;
      continue;
    }
    const fields = AGENCY_CAMPAIGN_TEMPLATE_SECTIONS[key as AgencyCampaignTemplateSectionKey] as readonly string[];
    for (const field of Object.keys(values)) {
      if (!fields.includes(field)) details[`sections.${key}.${field}`] = `is not a setting of the ${key} section`;
    }
  }
  return details;
}

/** A failed section check: the sections that failed and `details` keyed by the campaign's field paths. */
export interface SectionIssues {
  sections: AgencyCampaignTemplateSectionKey[];
  details: Record<string, string>;
}

/** The section a campaign field path (`calling_window_end`, `disposition_catalog[2].code`) belongs to. */
export function sectionOfPath(path: string): AgencyCampaignTemplateSectionKey | null {
  return SECTION_OF_FIELD.get(path.split(/[.[]/)[0]!) ?? null;
}

function issuesOf(details: Record<string, string>): SectionIssues | null {
  const keys = Object.keys(details);
  if (keys.length === 0) return null;
  const set = new Set(keys.map(sectionOfPath).filter((k): k is AgencyCampaignTemplateSectionKey => k !== null));
  return { sections: AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.filter((k) => set.has(k)), details };
}

/**
 * The campaign body the sections stand for: each section's fields as set, a field it leaves out
 * at its built-in value (the fill-in's rule, so what is checked is what a campaign gets). Sections
 * it does not set are absent, so they are not judged.
 */
export function sectionsAsCampaignBody(sections: AgencyCampaignTemplateSections): Record<string, unknown> {
  const builtin = builtinTemplateSections();
  const body: Record<string, unknown> = {};
  for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) {
    const values = sections[key] as Record<string, unknown> | undefined;
    if (values === undefined) continue;
    const base = builtin[key] as Record<string, unknown>;
    for (const field of AGENCY_CAMPAIGN_TEMPLATE_SECTIONS[key] as readonly string[]) {
      body[field] = values[field] !== undefined ? values[field] : structuredClone(base[field]);
    }
  }
  return body;
}

const NULLABLE: ReadonlySet<string> = new Set(AGENCY_CAMPAIGN_TEMPLATE_NULLABLE_FIELDS);

/**
 * `null` on a section field whose campaign column is NOT NULL (every field but
 * `AGENCY_CAMPAIGN_TEMPLATE_NULLABLE_FIELDS`), keyed by the field: a campaign cannot store it, and
 * leaving the field out is how a section takes the built-in value.
 */
export function sectionNullIssues(sections: AgencyCampaignTemplateSections): Record<string, string> {
  const details: Record<string, string> = {};
  for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) {
    const values = sections[key] as Record<string, unknown> | undefined;
    if (values === undefined) continue;
    for (const [field, value] of Object.entries(values)) {
      if (value === null && !NULLABLE.has(field)) details[field] = 'cannot be empty. Leave it out to use the built-in setting.';
    }
  }
  return details;
}

/**
 * The sections as a campaign write stores them (`storedSettingValues`: caller IDs and script texts
 * trimmed), so a campaign made from the template compares equal to it (CT9). Pure; `sections` is
 * not changed.
 */
export function storedTemplateSections(sections: AgencyCampaignTemplateSections): AgencyCampaignTemplateSections {
  const out: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(sections)) out[key] = storedSettingValues(values as Record<string, unknown>);
  return out as AgencyCampaignTemplateSections;
}

/**
 * CT4 (module note): the issues a campaign create would raise for these sections, else null. A
 * `null` on a NOT NULL field ({@link sectionNullIssues}) is refused first: both validators let it
 * through, and a campaign's write would store it or fail on it. Pure: the checks that read the
 * database are {@link sectionAccountIssues}.
 */
export function sectionConfigIssues(sections: AgencyCampaignTemplateSections): SectionIssues | null {
  const nulls = issuesOf(sectionNullIssues(sections));
  if (nulls) return nulls;
  const body = sectionsAsCampaignBody(sections);
  // The public layer's first (the console's wording), then the internal handler's; first per field wins.
  return issuesOf(issuesToDetails([
    ...validatePublicConfig(body),
    ...validateStoredConfig(body, CAMPAIGN_CONFIG_COLUMN_DEFAULTS),
  ]));
}

/**
 * The checks a campaign create reads the database for, on an account template's sections
 * (module note), else null. `body` is {@link sectionsAsCampaignBody}'s.
 */
export async function sectionAccountIssues(
  scope: { tenantId: string; accountId: string },
  sections: AgencyCampaignTemplateSections,
): Promise<SectionIssues | null> {
  const body = sectionsAsCampaignBody(sections);
  const details: Record<string, string> = {};

  if (sections.recording !== undefined && body['analysis_profile_id'] != null) {
    const value = body['analysis_profile_id'];
    if (typeof value !== 'string' || value.trim() === '') {
      details['analysis_profile_id'] = 'must be a call-analysis profile id, or null to clear it';
    } else {
      const err = await preflightAnalysisProfile(value, scope.tenantId, scope.accountId, 'agency');
      if (err) details['analysis_profile_id'] = err.message;
    }
  }

  if (sections.numbers !== undefined) {
    const callerIds = body['caller_ids'];
    // A set numbers section names at least one number, as a campaign does (CT15).
    const shape = callerIdsIssue(callerIds);
    if (shape) {
      details['caller_ids'] = shape;
    } else {
      const pool = callerIds as string[];
      const refusal = await campaignCarrierRefusal(
        scope,
        { telephony_provider: body['telephony_provider'], telephony_credential_id: body['telephony_credential_id'], caller_ids: pool },
        { provider: true, credential: true, callerIds: true },
      );
      if (refusal?.kind === 'validation') Object.assign(details, refusal.details);
      else if (refusal) details['telephony_credential_id'] = refusal.message;
    }
  }
  return issuesOf(details);
}
