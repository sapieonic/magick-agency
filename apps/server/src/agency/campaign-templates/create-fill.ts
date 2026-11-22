/*
 * A campaign create filled in from a template (docs/campaign-templates.md CT8, CT9, CT18), with
 * `agency_campaign_templates_enabled` on for the account. The public create route
 * (`POST /proxy/agency/campaigns`) runs it before its checks, so they judge the body the
 * campaign is stored with; with the flag off it is never called and the create is what it was.
 *
 *  - The settings come from {@link resolveEffectiveTemplate}: the template `template_id` names,
 *    else the account's default chain (the account's default, the organisation's, built-in).
 *  - A section the body leaves out (none of its fields sent) is the filled-in section, whole.
 *  - A section the body sends is kept as sent, an empty outcome list included; a field of it the
 *    body leaves out is that field's BUILT-IN value (the domain's rule: a section is won whole, and
 *    absent means built-in), so the stored row is what `template_source` says. The built-in hours
 *    are New campaign's `Asia/Kolkata` (CT18), not the column's `UTC`.
 *  - `template_source` (CT9) is computed by the domain's `sectionSourcesForCreate`: per section the
 *    filled-in source, or `campaign` when what was sent differs from it.
 *
 * The body is the caller's; it is never mutated (a new object is returned).
 */
import { builtinTemplateSections, sectionSourcesForCreate, type CompleteTemplateSections } from '@magick-agency/domain/campaign-templates';
import {
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS,
  type AgencyCampaignTemplateConfig,
  type AgencyCampaignTemplateSource,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import type { AgencyCampaign } from '@magick-agency/contracts/api/agency/agency-campaign';
import { resolveEffectiveTemplate, type TemplateAccountScope } from './resolve-effective.js';
import { UUID_RE } from '../../utils/uuid.js';

/** The fields the server writes or reads for the fill-in, never stored as sent. */
export const CREATE_TEMPLATE_KEYS = ['template_id', 'template_source'] as const;

/**
 * The create body with `template_id` and `template_source` taken out: the first is read here,
 * the second is the server's to write (CT9). Anything but a plain object is returned as it is (the
 * create's own checks answer it). A body with neither is returned as the same object.
 */
export function withoutTemplateKeys(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  if (!CREATE_TEMPLATE_KEYS.some((k) => Object.hasOwn(body, k))) return body;
  const out = { ...(body as Record<string, unknown>) };
  for (const k of CREATE_TEMPLATE_KEYS) delete out[k];
  return out;
}

/** The create body's sections filled in (module note). Pure; `sent` is not mutated. */
export function filledCreateBody(
  sent: Record<string, unknown>,
  config: AgencyCampaignTemplateConfig,
  builtin: CompleteTemplateSections = builtinTemplateSections(),
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...sent };
  const filled = config as Record<string, unknown>;
  for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) {
    const fields = AGENCY_CAMPAIGN_TEMPLATE_SECTIONS[key] as readonly string[];
    const base = builtin[key] as Record<string, unknown>;
    const sentSection = fields.some((f) => sent[f] !== undefined);
    for (const f of fields) {
      if (sentSection) {
        if (sent[f] === undefined) out[f] = structuredClone(base[f]);
      } else {
        out[f] = structuredClone(filled[f]);
      }
    }
  }
  return out;
}

export type TemplateCreateFill =
  | { ok: true; body: Record<string, unknown>; template_source: AgencyCampaignTemplateSource }
  | { ok: false; reason: 'invalid' | 'not_found' | 'archived' };

/**
 * The create body filled in from a template for the account (module note), with its
 * `template_source` set on it. `raw` is the request body as sent (its `template_id` is read here);
 * `template_id` that is not a string or null is `invalid`, one that is not a UUID or not a template
 * the account can see `not_found`, an archived one `archived`.
 */
export async function fillCreateFromTemplate(scope: TemplateAccountScope, raw: unknown): Promise<TemplateCreateFill> {
  const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const templateId = record['template_id'];
  if (templateId !== undefined && templateId !== null && typeof templateId !== 'string') return { ok: false, reason: 'invalid' };
  const id = typeof templateId === 'string' && templateId !== '' ? templateId : null;
  if (id !== null && !UUID_RE.test(id)) return { ok: false, reason: 'not_found' };

  const found = await resolveEffectiveTemplate(scope, id?.toLowerCase() ?? null);
  if (!found.ok) return found;
  const { wire, resolved } = found.effective;
  const sent = withoutTemplateKeys(record) as Record<string, unknown>;
  const template_source: AgencyCampaignTemplateSource = {
    template: wire.template,
    based_on: wire.based_on,
    sections: sectionSourcesForCreate(sent as Partial<AgencyCampaign>, resolved),
  };
  return { ok: true, body: { ...filledCreateBody(sent, resolved.config), template_source }, template_source };
}
