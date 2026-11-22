/**
 * Campaign templates (`docs/campaign-templates.md`, rulings CT1–CT21): the console wire shapes of
 * `/proxy/agency/campaign-templates/*` (§6) and what a campaign records of the template it was
 * made from (`template_source`, CT9).
 *
 * Console-side only: the public API layer serves these from its own tables
 * (`agency_campaign_templates`, `agency_campaign_template_versions`, 0067), with no dialer twin.
 * The section map, the section values, the filled-in config, the section sources and the notes
 * are declared once in the dialer contract (`../../agency/campaign-template-sections.ts`), because
 * the domain rules read them too, and are re-exported here, not copied (`CONTRACT-DIFF.md` §4).
 *
 * Who: listing, reading one, its versions and the filled-in form need `agency.campaigns.write`;
 * writing needs `agency.campaign_templates.manage` (an organisation template also an
 * organisation-wide seat, CT3); apply needs both. `effective` and apply need `X-Account-Id`
 * (`400 account_scope_required`: a campaign belongs to one account). Every route answers
 * `403 feature_disabled` while `agency_campaign_templates_enabled` is off (CT17). Refusals:
 * `AgencyCampaignTemplateErrorCode` (`../../errors.ts` §10), re-exported below.
 *
 * Words on screen are "organisation", never "tenant" (AA7); the wire's scope literal says
 * `organisation` for the same reason.
 */

import type { AgencyCampaignActor } from '../../agency';
import type { AllListed } from '../../primitives';
import type {
  AgencyCampaignTemplateConfig,
  AgencyCampaignTemplateFilledSource,
  AgencyCampaignTemplateNote,
  AgencyCampaignTemplateSectionKey,
  AgencyCampaignTemplateSections,
  AgencyCampaignTemplateSectionSource,
} from '../../agency';
import type { AgencyCampaign } from './agency-campaign';

export type {
  AgencyCampaignTemplateConfig,
  AgencyCampaignTemplateField,
  AgencyCampaignTemplateFilledSource,
  AgencyCampaignTemplateNote,
  AgencyCampaignTemplateNoteCode,
  AgencyCampaignTemplateSectionField,
  AgencyCampaignTemplateSectionKey,
  AgencyCampaignTemplateSections,
  AgencyCampaignTemplateSectionSource,
  AgencyCampaignTemplateSectionValues,
} from '../../agency';
export {
  AGENCY_CAMPAIGN_COLUMN_DEFAULTS,
  AGENCY_CAMPAIGN_TEMPLATE_ACCOUNT_ONLY_SECTIONS,
  AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS,
  AGENCY_CAMPAIGN_TEMPLATE_NOTE_CODES,
  AGENCY_CAMPAIGN_TEMPLATE_NULLABLE_FIELDS,
  AGENCY_CAMPAIGN_TEMPLATE_ORGANISATION_EXCLUDED_FIELDS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_SOURCES,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS,
} from '../../agency';
export {
  AGENCY_CAMPAIGN_TEMPLATE_ERROR_CODES,
  AGENCY_CAMPAIGN_TEMPLATE_ERROR_STATUS,
  type AgencyCampaignTemplateErrorCode,
} from '../../errors';

// ── Scope and limits ─────────────────────────────────────────────────────────

/** An organisation template (shared by every account of the tenant) or one account's. */
export type AgencyCampaignTemplateScope = 'organisation' | 'account';

export const AGENCY_CAMPAIGN_TEMPLATE_SCOPES = ['organisation', 'account'] as const satisfies readonly AgencyCampaignTemplateScope[];
const _scopesListed: AllListed<AgencyCampaignTemplateScope, typeof AGENCY_CAMPAIGN_TEMPLATE_SCOPES> = true;
void _scopesListed;

/** A template's name: trimmed, 1 to this many characters (CT13; the column is `VARCHAR(80)`). */
export const AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX = 80;
/** A template's description: at most this many characters (the column is `VARCHAR(280)`). */
export const AGENCY_CAMPAIGN_TEMPLATE_DESCRIPTION_MAX = 280;
/** The most draft campaigns one apply names (CT16). */
export const AGENCY_CAMPAIGN_TEMPLATE_APPLY_MAX_CAMPAIGNS = 50;
/**
 * A template's `sections`, serialised as JSON, are at most this many bytes (UTF-8); a larger save
 * is refused `400 campaign_template_invalid` with `details.sections`. Every save keeps a copy in
 * the template's history, so the cap bounds each one.
 */
export const AGENCY_CAMPAIGN_TEMPLATE_SECTIONS_MAX_BYTES = 256 * 1024;
/**
 * The most LIVE templates one scope keeps (the organisation's, or one account's): a create or a
 * restore past it is refused `400 campaign_template_invalid` with `details.templates`. Archived
 * templates do not count.
 */
export const AGENCY_CAMPAIGN_TEMPLATE_LIVE_MAX = 200;
/** How many versions `GET …/versions` answers when no `limit` is sent: the newest ones. */
export const AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE = 50;
/** The largest `limit` `GET …/versions` takes. */
export const AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE_MAX = 100;

// ── Templates ────────────────────────────────────────────────────────────────

/** A template named by id, name and version (a version is a saved state, CT6). */
export interface AgencyCampaignTemplateRef {
  id: string;
  name: string;
  version: number;
}

/**
 * The organisation template an account template follows (CT10): the one it is based on
 * (`via: 'based_on'`), else the organisation's default template as it is now
 * (`via: 'organisation_default'`), with that template's sections, so the editor can show what
 * "Use <name>" gives. `archived` is true only for a `based_on` the organisation has archived since
 * (archiving refuses while a live account template is based on it, so it is a race's leftover).
 */
export interface AgencyCampaignTemplateFollows extends AgencyCampaignTemplateRef {
  via: 'based_on' | 'organisation_default';
  archived: boolean;
  sections: AgencyCampaignTemplateSections;
}

/** One row of `GET /proxy/agency/campaign-templates`. */
export interface AgencyCampaignTemplateSummary {
  id: string;
  scope: AgencyCampaignTemplateScope;
  /** The account's id for an account template; `null` for an organisation template. */
  account_id: string | null;
  name: string;
  description: string | null;
  /** The scope's default template (at most one live default per scope). */
  is_default: boolean;
  version: number;
  /**
   * An account template's `based_on_template_id` with the organisation template's name and
   * version as they are now; `null` when it is not based on one (it then follows the
   * organisation's default) and always on an organisation template.
   */
  based_on: (AgencyCampaignTemplateRef & { archived: boolean }) | null;
  /** The section keys it sets, in `AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS` order. */
  sections_set: AgencyCampaignTemplateSectionKey[];
  created_at: string;
  /** When its content was last saved (a new version); a default or archive change does not move it. */
  updated_at: string;
  /** Who saved the current version, the name resolved at read; `null` when nobody can be named. */
  updated_by: AgencyCampaignActor | null;
  archived_at: string | null;
  archived_by: AgencyCampaignActor | null;
}

/**
 * `GET /proxy/agency/campaign-templates[?archived=true]`: the context account's templates and the
 * organisation's, live ones by default, archived ones with `archived=true`. Ordered: the
 * account's before the organisation's, each scope's default first, then by name.
 */
export interface AgencyCampaignTemplateListResponse {
  templates: AgencyCampaignTemplateSummary[];
}

/** `GET /proxy/agency/campaign-templates/:id`: one template with its sections. */
export interface AgencyCampaignTemplate extends AgencyCampaignTemplateSummary {
  /** As stored. An organisation template never holds `numbers` or `recording.analysis_profile_id` (CT5). */
  sections: AgencyCampaignTemplateSections;
  /** The organisation template an account template follows (CT10), or `null` (none; always on an organisation template). */
  follows: AgencyCampaignTemplateFollows | null;
}

/**
 * `POST /proxy/agency/campaign-templates` → 201 {@link AgencyCampaignTemplate}. `scope:
 * 'organisation'` is sent without `X-Account-Id`; `account` with it. Each section is checked as a
 * campaign create checks it (CT4); `make_default` makes it the scope's default in the same
 * transaction.
 */
export interface AgencyCreateCampaignTemplateRequest {
  scope: AgencyCampaignTemplateScope;
  name: string;
  description?: string | null;
  /** Account templates only: an organisation template to follow (CT10). */
  based_on_template_id?: string | null;
  sections: AgencyCampaignTemplateSections;
  make_default?: boolean;
}

/**
 * `PUT /proxy/agency/campaign-templates/:id` → {@link AgencyCampaignTemplate}: replaces the
 * content whole and bumps the version (CT6). `expected_version` is the version the editor
 * opened; another save in between is refused `409 campaign_template_changed`. The scope, the
 * default and the archive state are not changed here.
 */
export interface AgencyReplaceCampaignTemplateRequest {
  name: string;
  description: string | null;
  based_on_template_id: string | null;
  sections: AgencyCampaignTemplateSections;
  expected_version: number;
}

/**
 * `POST /proxy/agency/campaign-templates/:id/default` (make it the scope's default, clearing the
 * old one in the same transaction) and `DELETE …/default` (the scope has no default). `replaced`
 * is the default it took over from, `null` when there was none (always on `DELETE`).
 */
export interface AgencyCampaignTemplateDefaultResponse {
  template: AgencyCampaignTemplateSummary;
  replaced: AgencyCampaignTemplateRef | null;
}

/** `POST /proxy/agency/campaign-templates/:id/archive` (CT14). `default_cleared`: it was the scope's default, and now the scope has none. */
export interface AgencyCampaignTemplateArchiveResponse {
  template: AgencyCampaignTemplateSummary;
  default_cleared: boolean;
}

/** `POST /proxy/agency/campaign-templates/:id/restore`: live again, not a default; its name is checked again (CT13). */
export interface AgencyCampaignTemplateRestoreResponse {
  template: AgencyCampaignTemplateSummary;
}

// ── Versions (CT6) ───────────────────────────────────────────────────────────

/** One row of the history: a saved state. */
export interface AgencyCampaignTemplateVersionSummary {
  version: number;
  name: string;
  based_on_template_id: string | null;
  sections_set: AgencyCampaignTemplateSectionKey[];
  saved_at: string;
  saved_by: AgencyCampaignActor | null;
}

/**
 * `GET /proxy/agency/campaign-templates/:id/versions` query: one page of the history, newest first.
 * `limit` (1 to `AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE_MAX`, default
 * `AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE`) versions older than `before` (a version number; absent:
 * from the newest). A malformed value is `400 campaign_template_invalid`.
 */
export interface AgencyCampaignTemplateVersionsQuery {
  before?: number;
  limit?: number;
}

/**
 * `GET /proxy/agency/campaign-templates/:id/versions`: newest first, one page
 * ({@link AgencyCampaignTemplateVersionsQuery}). Versions are numbered from 1 with no gaps and never
 * deleted, so older ones exist while the last row's `version` is above 1: the next page is
 * `before` that version.
 */
export interface AgencyCampaignTemplateVersionsResponse {
  template_id: string;
  versions: AgencyCampaignTemplateVersionSummary[];
}

/** `GET /proxy/agency/campaign-templates/:id/versions/:n`: one saved state with its sections. */
export interface AgencyCampaignTemplateVersion extends AgencyCampaignTemplateVersionSummary {
  template_id: string;
  sections: AgencyCampaignTemplateSections;
}

// ── The filled-in form New campaign opens on ─────────────────────────────────

/** `GET /proxy/agency/campaign-templates/effective` query: a template, else the account's default chain. */
export interface AgencyCampaignTemplateEffectiveQuery {
  template_id?: string;
}

/**
 * `GET /proxy/agency/campaign-templates/effective`: the settings a new campaign starts from, for
 * the context account (without `X-Account-Id`, `400 account_scope_required`).
 * `template` is the template it starts from (the one named, else the account's default, else the
 * organisation's default), `null` for the built-in settings; `based_on` the organisation template
 * that account template follows, if any. `config` holds every section's fields, `sources` where
 * each section came from, `notes` what was changed on the way (CT5, CT15).
 */
export interface AgencyCampaignTemplateEffective {
  template: (AgencyCampaignTemplateRef & { scope: AgencyCampaignTemplateScope }) | null;
  based_on: AgencyCampaignTemplateRef | null;
  config: AgencyCampaignTemplateConfig;
  sources: Record<AgencyCampaignTemplateSectionKey, AgencyCampaignTemplateFilledSource>;
  notes: AgencyCampaignTemplateNote[];
}

// ── What a campaign records (CT9) ────────────────────────────────────────────

/**
 * `AgencyCampaign.template_source`: the template a campaign was made from, as it was then, and
 * where each section came from. `null` (the column's NULL) on a campaign made without the
 * feature, and on a retry campaign, which copies its parent's settings (CT7). A record, never
 * read at run time (CT1): the template may since have changed or been archived, which is why the
 * name and version are copied in rather than joined.
 *
 * `template` is `null` when the campaign was made from the built-in settings with the feature on.
 * After an apply (CT16) it names the template applied.
 *
 * ── What a section's source means (CT9 as amended 2026-11-22) ─────────────────
 * Each section is compared with the named template version (and its based-on version) as filled in
 * for the campaign's account, the notes' adjustments included: equal, it carries that filled-in
 * source (`account`, `organisation` or `builtin`); different, it is `campaign`. The server
 * recomputes every source at the create, at each settings PATCH and at an apply, so the record
 * stays true when New campaign edits the draft after a roster upload made it, when a supervisor
 * changes the campaign later, and for the sections an apply did not touch.
 *
 * `notes` are the notes of that filling-in (recording off because the account cannot record,
 * numbers dropped, …), kept so the campaign can say why a section is not as the template says.
 */
export interface AgencyCampaignTemplateSource {
  template: (AgencyCampaignTemplateRef & { scope: AgencyCampaignTemplateScope }) | null;
  based_on: AgencyCampaignTemplateRef | null;
  sections: Record<AgencyCampaignTemplateSectionKey, AgencyCampaignTemplateSectionSource>;
  /** Absent on a record written before notes were kept. */
  notes?: AgencyCampaignTemplateNote[];
}

/**
 * `POST /proxy/agency/campaigns`'s body: the campaign's settings, and with the flag on the
 * template to fill the sections it leaves out from (CT8):
 *  - `template_id` a template's id: that template (one the account can see, live; else
 *    `404 campaign_template_not_found` / `409 campaign_template_archived`);
 *  - `template_id: null`: no template, the built-in settings alone (New campaign's "Built-in
 *    settings"); `template_source.template` is `null`, each section `builtin` or `campaign`;
 *  - the key absent: the account's default chain (the account's default, else the organisation's,
 *    else built-in), for a caller that names nothing (an API create).
 * A section sent is kept as sent, an empty outcome list included; a field it leaves out is
 * built-in. `template_source` is the server's to write, never sent (one sent is ignored). With the
 * flag off `template_id` is ignored and the create is as before.
 */
export interface AgencyCampaignCreateRequest extends Omit<Partial<AgencyCampaign>, 'template_source'> {
  template_id?: string | null;
}

// ── Apply to draft campaigns (CT16) ──────────────────────────────────────────

/**
 * `POST /proxy/agency/campaign-templates/:id/apply`: write `sections` of the template, as filled
 * in for the account, to each of `campaign_ids` (drafts of the context account) through the
 * campaign PATCH path, its checks and audit included. Needs `X-Account-Id` (without it,
 * `400 account_scope_required`). `expected_version`, when sent, is the
 * version the preview showed: a template saved since is refused `409 campaign_template_changed`
 * before any campaign is touched.
 */
export interface AgencyCampaignTemplateApplyRequest {
  campaign_ids: string[];
  sections: AgencyCampaignTemplateSectionKey[];
  expected_version?: number;
}

/**
 * Why one campaign of an apply was not changed; the others still are (CT16):
 *  - `campaign_not_found`: not a campaign of the context account;
 *  - `campaign_not_draft`: it has been started (a running campaign is never changed by a template);
 *  - `campaign_archived`: it is archived;
 *  - `campaign_rejected`: the campaign PATCH path refused the change (`status`, `code` and
 *    `details` are that refusal's).
 */
export type AgencyCampaignTemplateApplyRefusalCode =
  | 'campaign_not_found'
  | 'campaign_not_draft'
  | 'campaign_archived'
  | 'campaign_rejected';

export const AGENCY_CAMPAIGN_TEMPLATE_APPLY_REFUSAL_CODES = [
  'campaign_not_found',
  'campaign_not_draft',
  'campaign_archived',
  'campaign_rejected',
] as const satisfies readonly AgencyCampaignTemplateApplyRefusalCode[];
const _applyRefusalsListed: AllListed<AgencyCampaignTemplateApplyRefusalCode, typeof AGENCY_CAMPAIGN_TEMPLATE_APPLY_REFUSAL_CODES> = true;
void _applyRefusalsListed;

/** One campaign's result of an apply. */
export type AgencyCampaignTemplateApplyResult =
  | {
      campaign_id: string;
      result: 'applied';
      /** The sections whose values changed (the others were already the template's). */
      changed_sections: AgencyCampaignTemplateSectionKey[];
      template_source: AgencyCampaignTemplateSource;
    }
  | {
      campaign_id: string;
      result: 'refused';
      code: AgencyCampaignTemplateApplyRefusalCode;
      message: string;
      /** `campaign_rejected` only: the PATCH path's HTTP status, code and field details. */
      status?: number;
      rejection_code?: string;
      details?: Record<string, unknown>;
    };

/** The apply's answer: 200 with a result per campaign, in the order sent. */
export interface AgencyCampaignTemplateApplyResponse {
  template: AgencyCampaignTemplateRef;
  results: AgencyCampaignTemplateApplyResult[];
}

// ── Refusal bodies that carry more than `{ error, code, message }` ───────────

/** `409 campaign_template_changed`. */
export interface AgencyCampaignTemplateChangedError {
  error: string;
  code: 'campaign_template_changed';
  message: string;
  current_version: number;
}

/** `409 campaign_template_name_taken`: the live template of the scope that has the name. */
export interface AgencyCampaignTemplateNameTakenError {
  error: string;
  code: 'campaign_template_name_taken';
  message: string;
  template: { id: string; name: string };
}

/**
 * `400 campaign_template_section_invalid` (CT4): the sections that failed and `details` keyed by
 * the campaign's own field paths (`calling_window_end`, `disposition_catalog[2].code`), with the
 * messages a campaign create gives, so an editor marks the field where campaign Settings does.
 * Field names are unique across sections, so the keys never collide.
 */
export interface AgencyCampaignTemplateSectionInvalidError {
  error: string;
  code: 'campaign_template_section_invalid';
  message: string;
  sections: AgencyCampaignTemplateSectionKey[];
  details: Record<string, string>;
}

/** One live account template based on the organisation template being archived. */
export interface AgencyCampaignTemplateInUseRef {
  id: string;
  name: string;
  account_id: string;
  /** The account's name, resolved at read; `null` when it cannot be. */
  account_name: string | null;
}

/** `409 campaign_template_in_use` (CT14). */
export interface AgencyCampaignTemplateInUseError {
  error: string;
  code: 'campaign_template_in_use';
  message: string;
  templates: AgencyCampaignTemplateInUseRef[];
}
