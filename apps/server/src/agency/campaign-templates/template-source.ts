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
 *  - at every settings PATCH of a campaign that has a record, inside the PATCH's write
 *    (`writeCampaignPatch`, the campaign row locked), so the record and the settings cannot
 *    disagree: New campaign edits the draft its roster upload made, a supervisor changes the
 *    campaign later;
 *  - at an apply (CT16), which switches the record to the applied template and recomputes every
 *    section against it.
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
  type AgencyCampaignTemplateSource,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import type { AgencyCampaign } from '@magick-agency/contracts/api/agency/agency-campaign';
import { sectionSourcesForCreate, type ResolvedTemplateSections } from '@magick-agency/domain/campaign-templates';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import { agencyCampaignTemplateRepository } from '../../db/repositories/agency.repository.js';
import { UUID_RE } from '../../utils/uuid.js';
import { fillTemplateSections, type TemplateAccountScope } from './resolve-effective.js';

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
  if (!fill) return null;
  return {
    template: refs.template,
    based_on: refs.based_on,
    sections: sectionSourcesForCreate(config as Partial<AgencyCampaign>, fill.resolved),
    notes: fill.resolved.notes,
  };
}

/**
 * For the campaign PATCH's write: the recompute of the record of `campaign` (as read before the
 * write), to run inside the write's transaction on the row as written. Its templates are filled
 * in here, before the transaction, so the row is held only for the comparison. Null when the
 * campaign has no record (it was made before templates, or is a retry, CT7): nothing to recompute.
 */
export async function templateSourceRecompute(
  campaign: Pick<AgencyCampaignRecord, 'tenant_id' | 'account_id' | 'template_source'>,
): Promise<((row: AgencyCampaignRecord) => Promise<AgencyCampaignTemplateSource | null>) | null> {
  const record = campaign.template_source;
  if (!record) return null;
  const scope = { tenantId: campaign.tenant_id, accountId: campaign.account_id };
  const fill = await templateSourceFill(scope, record);
  return async (row) => {
    if (!row.template_source) return null;
    const next = await templateSourceFor(scope, row, row.template_source, fill);
    return next && !isDeepStrictEqual(next, row.template_source) ? next : null;
  };
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
