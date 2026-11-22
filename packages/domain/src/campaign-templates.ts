/**
 * Campaign templates' pure rules (`docs/campaign-templates.md` §5, rulings CT2, CT5, CT9): the
 * built-in settings, how a template fills in a new campaign, a campaign's settings as template
 * sections, the difference between two sets of sections, and where each section of a created
 * campaign came from. The server's routes and create path and the console's New campaign and
 * template editor all call these, so the two sides cannot disagree. A LEAF: it imports only the
 * contract.
 *
 *  - {@link builtinTemplateSections}: every section as a campaign create stores it when the field
 *    is omitted, from the contract's constants (`AGENCY_CAMPAIGN_COLUMN_DEFAULTS` and its
 *    neighbours), except the time zone: New campaign's `AGENCY_NEW_CAMPAIGN_TIMEZONE`, not the
 *    column's `UTC` (CT18). The server and the console pass this one object; neither keeps a copy.
 *  - {@link resolveTemplateSections}: CT2 and CT5. Per section, the chosen template, then (for an
 *    account template) the organisation template it follows, then built-in; the first that sets a
 *    section wins it whole. A flag-gated section whose feature is off is built-in; outcome overrides
 *    without contact assignment are left out; recording asked of an account that cannot record is
 *    off; an organisation template's account-only parts are ignored. Each change is a note.
 *  - {@link sectionsFromCampaign}: "Save as template" and "Copy from a campaign".
 *  - {@link diffSections}: version comparison, "What's different", the apply preview.
 *  - {@link sectionSourcesForCreate}: CT9's per-section source of a created campaign.
 *
 * ── Normalisation: an untouched section never reads as changed ─────────────────
 * Every comparison here is of {@link normaliseSection}'s output, which:
 *  - fills a field absent from a set section with its BUILT-IN value (never the next level's: a
 *    section is won whole, CT2), as a campaign create stores the column default for an omitted
 *    field;
 *  - writes a calling window time as `HH:MM:SS` (`09:00` and Postgres's `09:00:00` are one time)
 *    and calling days sorted, each once;
 *  - orders the fields as the section map does;
 * and compares values by {@link sameTemplateValue}: object keys in any order, and inside an object
 * value (a catalog entry, a retry rule, a break reason, the script) a key that is `undefined`,
 * `null` or `false` is the same as a key that is absent. Every such key in those shapes is off or
 * unset when absent (`suppress`, `terminal`, `is_success`, `requires_*`, `is_paid`, `retry`), so a
 * form that writes them out is not a change. A FIELD's own `false` or `null` is a value
 * (`record_calls: false`, `daily_target_calls: null`), never confused with absence, which
 * normalisation has already filled in. Array order is kept: a catalog's order is the order the station
 * shows the outcomes in, and a caller ID pool's is the rotation.
 */
import {
  AGENCY_CAMPAIGN_COLUMN_DEFAULTS,
  AGENCY_NEW_CAMPAIGN_TIMEZONE,
  AGENCY_CAMPAIGN_TEMPLATE_ACCOUNT_ONLY_SECTIONS,
  AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS,
  AGENCY_CAMPAIGN_TEMPLATE_ORGANISATION_EXCLUDED_FIELDS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS,
  AGENCY_CONTACT_ASSIGNMENT_DEFAULTS,
  AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT,
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  AGENCY_PHONE_DISPLAY_DEFAULT,
  type AgencyCampaignTemplateConfig,
  type AgencyCampaignTemplateField,
  type AgencyCampaignTemplateFilledSource,
  type AgencyCampaignTemplateNote,
  type AgencyCampaignTemplateSectionField,
  type AgencyCampaignTemplateSectionKey,
  type AgencyCampaignTemplateSections,
  type AgencyCampaignTemplateSectionSource,
  type AgencyCampaignTemplateSectionValues,
} from '@magick-agency/contracts/agency';
import type { AgencyCampaign } from '@magick-agency/contracts/api/agency/agency-campaign';
import type { AgencyCampaignTemplateScope } from '@magick-agency/contracts/api/agency/campaign-templates';

type Key = AgencyCampaignTemplateSectionKey;

/** Every section with every field present: the built-in settings, a filled-in template, a normalised section. */
export type CompleteTemplateSections = {
  [K in Key]: Required<AgencyCampaignTemplateSectionValues<K>>;
};

/** What the chain is told about the account (CT5): whether it may record calls, and the flag-gated features. */
export interface TemplateCapabilities {
  record: boolean;
  assignment: boolean;
  inbound: boolean;
}

/** The capability that gates each flag-gated section (`AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS`). */
const GATED_BY: Record<keyof typeof AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS, keyof TemplateCapabilities> = {
  assignment: 'assignment',
  inbound: 'inbound',
};

const ACCOUNT_ONLY: ReadonlySet<Key> = new Set(AGENCY_CAMPAIGN_TEMPLATE_ACCOUNT_ONLY_SECTIONS);
const ORGANISATION_EXCLUDED: ReadonlySet<string> = new Set(AGENCY_CAMPAIGN_TEMPLATE_ORGANISATION_EXCLUDED_FIELDS);

function fieldsOf<K extends Key>(key: K): readonly AgencyCampaignTemplateSectionField<K>[] {
  return AGENCY_CAMPAIGN_TEMPLATE_SECTIONS[key] as readonly AgencyCampaignTemplateSectionField<K>[];
}

/** A deep copy of JSON data (every template value is JSON), so nothing returned shares a constant's objects. */
function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// ── The built-in settings ────────────────────────────────────────────────────

/**
 * Every section as a campaign create with no template stores it: the column DEFAULTs, except the
 * outcome catalog, which the create path seeds with `AGENCY_DEFAULT_DISPOSITION_CATALOG` when none
 * is sent (`withCampaignConfigDefaults`), and the time zone, New campaign's `Asia/Kolkata`
 * (`AGENCY_NEW_CAMPAIGN_TIMEZONE`, CT18), not the column's `UTC`.
 *
 * **`retries` is `{}`, "no rule stored", deliberately.** The server's retry engine applies its own
 * `DEFAULT_RETRY_POLICY` per outcome at run time to every key a campaign leaves out, so an empty
 * policy IS the built-in behaviour; writing that default out here would be a second copy of it, and
 * a campaign made from the built-in settings would stop following a later change to it.
 *
 * Likewise `breaks` is `[]` (the campaign's agents are offered the built-in break reasons,
 * `resolveBreakReasons`), `agent_screen`'s script `{}` (no script) and target `null` (none),
 * `recording`'s profile `null` (no summary), and `numbers` an empty pool on the service's own
 * carrier (a create must still name its caller IDs, and a template that sets the section names at
 * least one).
 */
const BUILTIN: CompleteTemplateSections = deepFreeze({
  outcomes: {
    disposition_catalog: copy([...AGENCY_DEFAULT_DISPOSITION_CATALOG]) as AgencyCampaign['disposition_catalog'] & object,
    outcome_dispositions: {},
  },
  retries: { retry_policy: {} },
  hours: {
    calling_window_start: AGENCY_CAMPAIGN_COLUMN_DEFAULTS.calling_window_start,
    calling_window_end: AGENCY_CAMPAIGN_COLUMN_DEFAULTS.calling_window_end,
    calling_days: [...AGENCY_CAMPAIGN_COLUMN_DEFAULTS.calling_days],
    default_timezone: AGENCY_NEW_CAMPAIGN_TIMEZONE,
  },
  wrapup: {
    wrapup_seconds: AGENCY_CAMPAIGN_COLUMN_DEFAULTS.wrapup_seconds,
    wrapup_auto_return: AGENCY_CAMPAIGN_COLUMN_DEFAULTS.wrapup_auto_return,
    allow_wrapup_redial: AGENCY_CAMPAIGN_COLUMN_DEFAULTS.allow_wrapup_redial,
  },
  breaks: { break_reasons: [] },
  recording: { record_calls: AGENCY_CAMPAIGN_COLUMN_DEFAULTS.record_calls, analysis_profile_id: null },
  agent_screen: { agent_script: {}, phone_display: AGENCY_PHONE_DISPLAY_DEFAULT, daily_target_calls: null },
  safety: { abandonment_ceiling_pct: AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT },
  assignment: { ...AGENCY_CONTACT_ASSIGNMENT_DEFAULTS },
  inbound: { inbound_sticky_enabled: AGENCY_CAMPAIGN_COLUMN_DEFAULTS.inbound_sticky_enabled },
  numbers: {
    caller_ids: [],
    telephony_provider: AGENCY_CAMPAIGN_COLUMN_DEFAULTS.telephony_provider,
    telephony_credential_id: null,
  },
});

/** The built-in settings: one frozen object, the same on every call. Copy before editing. */
export function builtinTemplateSections(): CompleteTemplateSections {
  return BUILTIN;
}

// ── Normalisation and comparison ─────────────────────────────────────────────

/** `HH:MM` → `HH:MM:SS`, as Postgres renders a `TIME`; anything else as it is (the validators judge it). */
function normaliseTime(value: unknown): unknown {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
}

function normaliseField(field: AgencyCampaignTemplateField, value: unknown): unknown {
  if (field === 'calling_window_start' || field === 'calling_window_end') return normaliseTime(value);
  if (field === 'calling_days' && Array.isArray(value) && value.every((d) => typeof d === 'number')) {
    return [...new Set(value as number[])].sort((a, b) => a - b);
  }
  return copy(value);
}

/**
 * Section `key` with every field present, in the map's order: a field absent (or `undefined`)
 * takes the built-in value; times are `HH:MM:SS`, days sorted (module note). `undefined` (an unset
 * section) gives the built-in section.
 */
export function normaliseSection<K extends Key>(
  key: K,
  values: AgencyCampaignTemplateSectionValues<K> | Partial<Record<string, unknown>> | undefined,
  builtin: CompleteTemplateSections = BUILTIN,
): Required<AgencyCampaignTemplateSectionValues<K>> {
  const out: Record<string, unknown> = {};
  const given = (values ?? {}) as Record<string, unknown>;
  const base = builtin[key] as Record<string, unknown>;
  for (const field of fieldsOf(key)) {
    const v = given[field];
    out[field] = normaliseField(field, v === undefined ? base[field] : v);
  }
  return out as Required<AgencyCampaignTemplateSectionValues<K>>;
}

/** A value's canonical text: object keys sorted, an object's `undefined`, `null` and `false` keys dropped (module note). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null && v !== false)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/** Whether two field values are the same setting (module note). */
export function sameTemplateValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** The fields of section `key` whose normalised values differ. */
function changedFields<K extends Key>(key: K, a: unknown, b: unknown): AgencyCampaignTemplateSectionField<K>[] {
  const na = normaliseSection(key, a as AgencyCampaignTemplateSectionValues<K>) as Record<string, unknown>;
  const nb = normaliseSection(key, b as AgencyCampaignTemplateSectionValues<K>) as Record<string, unknown>;
  return fieldsOf(key).filter((f) => !sameTemplateValue(na[f], nb[f]));
}

// ── Filling in a template (CT2, CT5) ─────────────────────────────────────────

/** A catalog entry that carries an `override` (CA9), whatever its value: the create's gate counts any. */
function isOverrideEntry(entry: unknown): boolean {
  return entry !== null && typeof entry === 'object' && (entry as Record<string, unknown>)['override'] !== undefined;
}

/** A template as the chain reads it: its scope and its stored sections. */
export interface TemplateSectionsInput {
  scope: AgencyCampaignTemplateScope;
  sections: AgencyCampaignTemplateSections;
}

/** {@link resolveTemplateSections}'s answer: the filled-in config and sections, where each section came from, and the notes. */
export interface ResolvedTemplateSections {
  config: AgencyCampaignTemplateConfig;
  sections: CompleteTemplateSections;
  sources: Record<Key, AgencyCampaignTemplateFilledSource>;
  notes: AgencyCampaignTemplateNote[];
}

/**
 * The sections an organisation template may hold: without the account-only sections and fields
 * (CT5). The routes refuse a write that carries them ({@link accountOnlyPartsIn}); this keeps a
 * hand-edited row from leaking an account's numbers into another account.
 */
function organisationSafe(sections: AgencyCampaignTemplateSections): AgencyCampaignTemplateSections {
  const out: Record<string, unknown> = {};
  for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) {
    const values = sections[key] as Record<string, unknown> | undefined;
    if (values === undefined || ACCOUNT_ONLY.has(key)) continue;
    out[key] = Object.fromEntries(Object.entries(values).filter(([f]) => !ORGANISATION_EXCLUDED.has(f)));
  }
  return out as AgencyCampaignTemplateSections;
}

/**
 * The settings a new campaign starts from (CT2, CT5).
 *
 * `chosen` is the template it starts from, `null` for the built-in settings. `basedOn` is the
 * organisation template an account template follows (its `based_on_template_id`, else the
 * organisation's default); it is read only when `chosen` is an account template. `builtin` is
 * {@link builtinTemplateSections}'s object. `can` says what the account may have.
 *
 * Per section: the first of `chosen`, `basedOn`, built-in that sets it wins it whole (fields it
 * leaves out are built-in, never the next level's). Then: a flag-gated section whose feature is off
 * is built-in (`section_flag_off`, when a template had set it); without contact assignment the
 * outcomes lose their agent overrides (`outcome_overrides_off`, when one had any); `record_calls` is
 * off where the account cannot record (`recording_not_allowed`, when it was on). An organisation template's
 * `numbers` and `analysis_profile_id` are never read (CT5). The server adds its own notes after
 * this (numbers and carrier no longer usable, a profile gone).
 */
export function resolveTemplateSections(input: {
  chosen: TemplateSectionsInput | null;
  basedOn: { sections: AgencyCampaignTemplateSections } | null;
  builtin: CompleteTemplateSections;
  can: TemplateCapabilities;
}): ResolvedTemplateSections {
  const { chosen, basedOn, builtin, can } = input;
  const chain: Array<{ source: AgencyCampaignTemplateFilledSource; sections: AgencyCampaignTemplateSections }> = [];
  if (chosen) {
    chain.push({
      source: chosen.scope,
      sections: chosen.scope === 'organisation' ? organisationSafe(chosen.sections) : chosen.sections,
    });
    if (chosen.scope === 'account' && basedOn) chain.push({ source: 'organisation', sections: organisationSafe(basedOn.sections) });
  }

  const sections: Record<string, Record<string, unknown>> = {};
  const sources = {} as Record<Key, AgencyCampaignTemplateFilledSource>;
  const notes: AgencyCampaignTemplateNote[] = [];
  for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) {
    const level = chain.find((l) => l.sections[key] !== undefined);
    const gate = (GATED_BY as Partial<Record<Key, keyof TemplateCapabilities>>)[key];
    if (level && gate !== undefined && !can[gate]) {
      notes.push({ code: 'section_flag_off', section: key });
      sections[key] = normaliseSection(key, undefined, builtin);
      sources[key] = 'builtin';
    } else if (level) {
      sections[key] = normaliseSection(key, level.sections[key] as Partial<Record<string, unknown>>, builtin);
      sources[key] = level.source;
    } else {
      sections[key] = normaliseSection(key, undefined, builtin);
      sources[key] = 'builtin';
    }
  }
  if (!can.assignment) {
    // CA9: an outcome's `override` grants a contact more than the campaign's rules, which needs
    // contact assignment; the outcomes themselves stay.
    const catalog = sections.outcomes!.disposition_catalog;
    if (Array.isArray(catalog) && catalog.some((e) => isOverrideEntry(e))) {
      sections.outcomes!.disposition_catalog = catalog.map((e) => {
        if (!isOverrideEntry(e)) return e;
        const { override: _override, ...rest } = e as Record<string, unknown>;
        return rest;
      });
      notes.push({ code: 'outcome_overrides_off', section: 'outcomes' });
    }
  }
  if (sections.recording!.record_calls === true && !can.record) {
    sections.recording!.record_calls = false;
    notes.push({ code: 'recording_not_allowed', section: 'recording' });
  }

  const config = Object.assign({}, ...AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.map((k) => sections[k])) as AgencyCampaignTemplateConfig;
  return { config, sections: sections as CompleteTemplateSections, sources, notes };
}

// ── From a campaign ──────────────────────────────────────────────────────────

/**
 * A campaign's settings as template sections, normalised, for "Save as template" and "Copy from a
 * campaign": every section (or those of `keys`), each field as the campaign holds it (absent:
 * built-in). For an organisation template the account-only sections and fields are left out (CT5).
 * Also reads a filled-in config (`AgencyCampaignTemplateConfig`), which has the same fields.
 */
export function sectionsFromCampaign(
  campaign: Partial<AgencyCampaign> | AgencyCampaignTemplateConfig,
  scope: AgencyCampaignTemplateScope,
  keys: readonly Key[] = AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
): AgencyCampaignTemplateSections {
  const source = campaign as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) {
    if (!keys.includes(key)) continue;
    if (scope === 'organisation' && ACCOUNT_ONLY.has(key)) continue;
    const values = Object.fromEntries(fieldsOf(key).map((f) => [f, source[f]]));
    const section = normaliseSection(key, values) as Record<string, unknown>;
    if (scope === 'organisation') for (const f of ORGANISATION_EXCLUDED) delete section[f];
    out[key] = section;
  }
  return out as AgencyCampaignTemplateSections;
}

/**
 * The account-only parts a set of sections holds (CT5): `numbers` when set, and
 * `analysis_profile_id` when the recording section carries it. Empty for a valid organisation
 * template; the routes refuse the rest `400 campaign_template_scope_invalid`.
 */
export function accountOnlyPartsIn(sections: AgencyCampaignTemplateSections): Array<Key | AgencyCampaignTemplateField> {
  const parts: Array<Key | AgencyCampaignTemplateField> = [];
  for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) {
    const values = sections[key] as Record<string, unknown> | undefined;
    if (values === undefined) continue;
    if (ACCOUNT_ONLY.has(key)) {
      parts.push(key);
      continue;
    }
    for (const f of fieldsOf(key)) if (ORGANISATION_EXCLUDED.has(f) && values[f] !== undefined) parts.push(f);
  }
  return parts;
}

/** The section keys a template sets, in the map's order (the list's `sections_set`). */
export function sectionKeysSet(sections: AgencyCampaignTemplateSections): Key[] {
  return AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.filter((k) => sections[k] !== undefined);
}

// ── Differences ──────────────────────────────────────────────────────────────

/**
 * One section that differs between two sets of sections. `set`: only the second sets it; `unset`:
 * only the first does (the other follows the next level, so every field is listed); `changed`: both
 * set it and `fields` differ.
 */
export type TemplateSectionDiff = {
  [K in Key]: { section: K; change: 'set' | 'unset' | 'changed'; fields: AgencyCampaignTemplateSectionField<K>[] };
}[Key];

/**
 * The sections that differ from `a` to `b`, in the map's order, each with its changed fields,
 * after normalisation (module note). For version comparison (`a` the older), "What's different
 * from the template now" (the campaign's sections against the filled-in config's, both complete,
 * so only `changed` occurs) and the apply preview.
 */
export function diffSections(a: AgencyCampaignTemplateSections, b: AgencyCampaignTemplateSections): TemplateSectionDiff[] {
  const out: TemplateSectionDiff[] = [];
  for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) {
    const inA = a[key] !== undefined;
    const inB = b[key] !== undefined;
    if (!inA && !inB) continue;
    if (inA !== inB) {
      out.push({ section: key, change: inB ? 'set' : 'unset', fields: [...fieldsOf(key)] } as TemplateSectionDiff);
      continue;
    }
    const fields = changedFields(key, a[key], b[key]);
    if (fields.length > 0) out.push({ section: key, change: 'changed', fields } as TemplateSectionDiff);
  }
  return out;
}

// ── A created campaign's sources (CT9) ───────────────────────────────────────

/**
 * Where each section of a created campaign came from (CT9). A section the create body `sent` (any
 * of its fields present) is `campaign` when it differs from the filled-in section, else the filled-in
 * section's source; a section it left out is the filled-in source. A sent section's absent fields
 * are built-in, as the create stores them (CT8: a section sent is kept as sent), so sending a
 * section exactly as filled in, field order and `HH:MM` aside, is not a change. Given a stored
 * campaign (every field present), it judges every section: the server's record recomputes with it
 * at each settings PATCH and at an apply (CT9 as amended).
 */
export function sectionSourcesForCreate(
  sent: Partial<AgencyCampaign>,
  resolved: Pick<ResolvedTemplateSections, 'config' | 'sources'>,
): Record<Key, AgencyCampaignTemplateSectionSource> {
  const body = sent as Record<string, unknown>;
  const out = {} as Record<Key, AgencyCampaignTemplateSectionSource>;
  for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) {
    const fields = fieldsOf(key);
    if (!fields.some((f) => body[f] !== undefined)) {
      out[key] = resolved.sources[key];
      continue;
    }
    const sentSection = Object.fromEntries(fields.map((f) => [f, body[f]]));
    const filled = Object.fromEntries(fields.map((f) => [f, (resolved.config as Record<string, unknown>)[f]]));
    out[key] = changedFields(key, sentSection, filled).length === 0 ? resolved.sources[key] : 'campaign';
  }
  return out;
}
