/*
 * A campaign's `template_source` (CT9 as amended 2026-11-22, `AgencyCampaignTemplateSource`): its
 * shape, checked by the internal create handler before it stores one, and how it is computed.
 *
 * ── What the record says ────────────────────────────────────────────────────
 * Section k's source is the filled-in source (`account`, `organisation`, `builtin`) when section k
 * of the campaign's stored settings equals the named template version (and its based-on version)
 * as filled in for the campaign's account now, the server's notes' adjustments included (recording
 * off where the account cannot record, numbers no longer usable dropped, …); otherwise `campaign`.
 * The filling-in's `notes` are kept, so the campaign can say why a section is not as the template
 * says. {@link templateSourceFor} is the one computation, run:
 *  - at the create (`create-fill.ts`), on the body as it will be stored;
 *  - at every settings PATCH of a campaign that has a record and whose body names a section
 *    field, inside the PATCH's write (`writeCampaignPatch`, the campaign row locked): New campaign
 *    edits the draft its roster upload made, a supervisor changes the campaign later. Best effort
 *    ({@link templateSourceRecompute}): the record is never read at run time (CT1), so a template
 *    read that fails is logged and the record left as it was, never a failed PATCH (a calling
 *    window fix must land);
 *  - at an apply (CT16), which switches the record to the applied template and recomputes every
 *    section against it, in the PATCH's own transaction ({@link templateSourceApplied}): the
 *    settings and the record are written together or not at all.
 * The versions are read from `agency_campaign_template_versions` (the record names a saved state,
 * never "the template as it is now"). A record whose version row is gone (it should not happen:
 * versions are never deleted) is left as it is.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 * Only the public create path sends one to the internal create (it strips any a client sent and
 * writes its own), so a malformed one is a wiring defect: refused as a 400 rather than stored as a
 * record nothing could read.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  AGENCY_CAMPAIGN_TEMPLATE_NOTE_CODES,
  AGENCY_CAMPAIGN_TEMPLATE_SCOPES,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_SOURCES,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS,
  type AgencyCampaignTemplateSource,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyCampaign } from '@magick-agency/contracts/api/agency/agency-campaign';
import { sectionSourcesForCreate, type ResolvedTemplateSections } from '@magick-agency/domain/campaign-templates';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import { agencyCampaignTemplateRepository } from '../../db/repositories/agency.repository.js';
import { UUID_RE } from '../../utils/uuid.js';
import { fillTemplateSections, type TemplateAccountScope } from './resolve-effective.js';

const log = createChildLogger({ component: 'campaign-templates' });

/** Every campaign field some section holds. */
const SECTION_FIELDS: ReadonlySet<string> = new Set(
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.flatMap((k) => AGENCY_CAMPAIGN_TEMPLATE_SECTIONS[k] as readonly string[]),
);

/** Whether a settings PATCH body names a field of some section: only then can the record change. */
export function patchNamesSectionField(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((field) => SECTION_FIELDS.has(field));
}

/** The templates a record names: what {@link templateSourceFor} fills in. */
export type TemplateSourceRefs = Pick<AgencyCampaignTemplateSource, 'template' | 'based_on'>;

/** The templates a record names, filled in for the account: what each section is judged against. */
export interface TemplateSourceFill extends TemplateSourceRefs {
  resolved: Pick<ResolvedTemplateSections, 'config' | 'sources' | 'notes'>;
}

function sameRef(a: { id: string; version: number } | null, b: { id: string; version: number } | null): boolean {
  return a === null || b === null ? a === b : a.id === b.id && a.version === b.version;
}

/** Whether `fill` was made for the templates `refs` names (the same ids and versions). */
function fillFor(fill: TemplateSourceFill, refs: TemplateSourceRefs): boolean {
  return sameRef(fill.template, refs.template) && sameRef(fill.based_on, refs.based_on);
}

/**
 * The versions `refs` names, read from the version rows and filled in for the account now (module
 * note); null when a version row is gone. No template: the built-in settings.
 */
export async function templateSourceFill(scope: TemplateAccountScope, refs: TemplateSourceRefs): Promise<TemplateSourceFill | null> {
  const { template, based_on } = refs;
  if (template === null) {
    return { template: null, based_on: null, resolved: await fillTemplateSections(scope, null, null) };
  }
  const reader = { tenantId: scope.tenantId, accountId: scope.accountId };
  const [chosen, basedOn] = await Promise.all([
    agencyCampaignTemplateRepository.findVersion(reader, template.id, template.version),
    based_on ? agencyCampaignTemplateRepository.findVersion(reader, based_on.id, based_on.version) : null,
  ]);
  if (!chosen || (based_on !== null && !basedOn)) return null;
  const resolved = await fillTemplateSections(
    scope,
    { scope: template.scope, sections: chosen.sections },
    basedOn ? { sections: basedOn.sections } : null,
  );
  return { template, based_on, resolved };
}

/**
 * THE record of a campaign's settings `config` (CT9 as amended, module note): the templates `refs`
 * names, each section's source against them as filled in for the account, and the filling-in's
 * notes. `known` is a fill already made (the create's, the apply's); used only when it is of the
 * same versions, else the versions are read. Null when a version row is gone: the caller leaves
 * the record as it is. `config` holds every section field as the campaign stores it.
 */
export async function templateSourceFor(
  scope: TemplateAccountScope,
  config: Partial<AgencyCampaign> | AgencyCampaignRecord,
  refs: TemplateSourceRefs,
  known?: TemplateSourceFill | null,
): Promise<AgencyCampaignTemplateSource | null> {
  const fill = known && fillFor(known, refs) ? known : await templateSourceFill(scope, refs);
  return fill ? recordOf(config, refs, fill) : null;
}

/** The record of `config` against a fill already made of the templates `refs` names: pure, no read. */
function recordOf(
  config: Partial<AgencyCampaign> | AgencyCampaignRecord,
  refs: TemplateSourceRefs,
  fill: TemplateSourceFill,
): AgencyCampaignTemplateSource {
  return {
    template: refs.template,
    based_on: refs.based_on,
    sections: sectionSourcesForCreate(config as Partial<AgencyCampaign>, fill.resolved),
    notes: fill.resolved.notes,
  };
}

/** What the PATCH's write asks with the row as written, under its lock: the record to store, or null to leave it. */
export type TemplateSourceAfterWrite = (row: AgencyCampaignRecord) => Promise<AgencyCampaignTemplateSource | null>;

/**
 * For a settings PATCH (module note): the recompute of the record of `campaign` (as read before the
 * write), to run inside the write's transaction on the row as written. Null when there is nothing
 * to recompute: the campaign has no record (made before templates, or a retry, CT7), or the
 * versions it names cannot be read. BEST EFFORT, and no read under the row lock:
 *  - the templates are filled in here, before the transaction; a read that throws is logged and
 *    the record left as it is (null), so the PATCH still lands;
 *  - under the lock the comparison is pure: a record that names other versions by then (an apply
 *    landed between the read and the lock) is left as that write made it, never re-read there;
 *  - a comparison that throws is logged and leaves the record, rather than rolling the PATCH back.
 */
export async function templateSourceRecompute(
  campaign: Pick<AgencyCampaignRecord, 'id' | 'tenant_id' | 'account_id' | 'template_source'>,
): Promise<TemplateSourceAfterWrite | null> {
  const record = campaign.template_source;
  if (!record) return null;
  const scope = { tenantId: campaign.tenant_id, accountId: campaign.account_id };
  let fill: TemplateSourceFill | null;
  try {
    fill = await templateSourceFill(scope, record);
  } catch (err) {
    log.warn({ err, campaignId: campaign.id }, 'Campaign template record not recomputed: its templates could not be read; the record is left as it was');
    return null;
  }
  if (!fill) return null;
  const known = fill;
  return async (row) => {
    if (!row.template_source || !fillFor(known, row.template_source)) return null;
    try {
      const next = recordOf(row, row.template_source, known);
      return isDeepStrictEqual(next, row.template_source) ? null : next;
    } catch (err) {
      log.warn({ err, campaignId: row.id }, 'Campaign template record not recomputed; the record is left as it was');
      return null;
    }
  };
}

/**
 * For an apply's PATCH (CT16): the record of the row as written against the templates `refs`
 * names, stored in the PATCH's transaction, so a campaign's settings and its record are written
 * together or not at all. The versions are read and filled in before the transaction; unlike the
 * plain PATCH's recompute this is NOT best effort: a read that fails, or a version row that is gone,
 * throws, and the PATCH writes nothing (the apply reports that campaign as not changed).
 */
export async function templateSourceApplied(
  campaign: Pick<AgencyCampaignRecord, 'tenant_id' | 'account_id'>,
  refs: TemplateSourceRefs,
): Promise<TemplateSourceAfterWrite> {
  const fill = await templateSourceFill({ tenantId: campaign.tenant_id, accountId: campaign.account_id }, refs);
  if (!fill) throw new Error('the template version applied could not be read');
  return async (row) => {
    const next = recordOf(row, refs, fill);
    return isDeepStrictEqual(next, row.template_source) ? null : next;
  };
}

/**
 * The templates an apply names to the internal PATCH handler (`TEMPLATE_APPLY_HEADER`, written by
 * `templateApplyHeaderValue` in `callCore` from its typed `templateApply`, never forwarded from a
 * client): `null` when absent,
 * `'invalid'` when it is not one (a wiring defect, refused rather than guessed at).
 */
export function templateApplyRefsOf(header: unknown): TemplateSourceRefs | null | 'invalid' {
  if (header === undefined) return null;
  if (typeof header !== 'string') return 'invalid';
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    return 'invalid';
  }
  if (!plain(value) || refIssue(value['template'], true) || value['template'] === null || refIssue(value['based_on'], false)) return 'invalid';
  return { template: value['template'] as TemplateSourceRefs['template'], based_on: value['based_on'] as TemplateSourceRefs['based_on'] };
}

// ── The shape ────────────────────────────────────────────────────────────────

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refIssue(value: unknown, withScope: boolean): boolean {
  if (value === null) return false;
  if (!plain(value)) return true;
  return typeof value['id'] !== 'string' || !UUID_RE.test(value['id'])
    || typeof value['name'] !== 'string'
    || typeof value['version'] !== 'number' || !Number.isInteger(value['version']) || value['version'] < 1
    || (withScope && !(AGENCY_CAMPAIGN_TEMPLATE_SCOPES as readonly unknown[]).includes(value['scope']));
}

function noteIssue(value: unknown): boolean {
  return !plain(value)
    || !(AGENCY_CAMPAIGN_TEMPLATE_NOTE_CODES as readonly unknown[]).includes(value['code'])
    || !(AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS as readonly unknown[]).includes(value['section'])
    || (value['numbers'] !== undefined
      && !(Array.isArray(value['numbers']) && value['numbers'].every((n) => typeof n === 'string')));
}

/** Why `value` is not an `AgencyCampaignTemplateSource`, or null when it is one. */
export function templateSourceIssue(value: unknown): string | null {
  if (!plain(value)) return 'template_source must be an object';
  if (refIssue(value['template'], true)) return 'template_source.template must be null or a template (id, name, version, scope)';
  if (refIssue(value['based_on'], false)) return 'template_source.based_on must be null or a template (id, name, version)';
  const sections = value['sections'];
  if (!plain(sections)) return 'template_source.sections must be an object';
  const keys = Object.keys(sections);
  if (keys.length !== AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.length
    || !AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.every((k) =>
      (AGENCY_CAMPAIGN_TEMPLATE_SECTION_SOURCES as readonly unknown[]).includes(sections[k]))) {
    return 'template_source.sections must give every section its source';
  }
  const notes = value['notes'];
  if (notes !== undefined && (!Array.isArray(notes) || notes.some(noteIssue))) {
    return 'template_source.notes must be a list of notes (code, section, numbers)';
  }
  return null;
}
