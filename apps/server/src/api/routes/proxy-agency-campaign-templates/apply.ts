/*
 * `POST /campaign-templates/:id/apply` (docs/campaign-templates.md CT16; the wire is
 * `AgencyCampaignTemplateApplyRequest` / `…Response`): write chosen sections of a template, as
 * filled in for the context account, to chosen DRAFT campaigns of that account, on purpose. Part of
 * `proxy-agency-campaign-templates.routes.ts`.
 *
 *  - Who: `agency.campaign_templates.manage` and `agency.campaigns.write`, in an account context
 *    (`400 account_scope_required`). The template must be visible to the account (its own or the
 *    organisation's: else `404`), live (`409 campaign_template_archived`), and at
 *    `expected_version` when one is sent (`409 campaign_template_changed`, before any campaign is
 *    touched). The template and the organisation template it follows are read ONCE: the version
 *    checked is the version applied, and both are pinned for every campaign of the request.
 *  - What is written: the chosen sections' fields as that pinned chain fills them in for this
 *    account (`effectiveOfChain`), the same fill-in New campaign shows and a create stores (CT2,
 *    CT5, CT15: the chain, what the account may have, numbers no longer usable dropped).
 *  - How: each campaign through the campaign PATCH path (`patchCampaignConfig`), its validation,
 *    its capability and assignment gates, the internal handler's own checks (caller IDs, carrier,
 *    profile, the script against the card) and its `agency_campaign.config_changed` audit, never
 *    a second copy of them. A campaign is checked first: of the context account (else
 *    `campaign_not_found`: a malformed id, another account's, a missing one), not archived
 *    (`campaign_archived`), a draft (`campaign_not_draft`: a running campaign is never changed by a
 *    template). The status is read just before the write; a campaign started in between is
 *    written as its PATCH would be (an accepted race: starting takes a supervisor's own press).
 *  - Then its `template_source` (CT9 as amended) names this template and its based-on, and every
 *    section is recomputed against them (`templateSourceFor`), the row locked: a section the apply
 *    did not choose reads the template's source only where it already equals it, else `campaign`.
 *    The answer carries the record as stored.
 *  - Refusals are per campaign, in the order sent; the others still apply. One
 *    `campaign_template.applied` row for the request, filed under the request's account (an
 *    organisation template's too: the drafts it changed are that account's), naming the campaigns
 *    applied and refused.
 */
import type { FastifyInstance } from 'fastify';
import {
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS,
  type AgencyCampaignTemplateApplyResponse,
  type AgencyCampaignTemplateApplyResult,
  type AgencyCampaignTemplateSectionKey,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { diffSections, sectionsFromCampaign } from '@magick-agency/domain/campaign-templates';
import type { AgencyCampaign } from '@magick-agency/contracts/api/agency/agency-campaign';
import { agencyCampaignRepository, agencyCampaignTemplateRepository } from '../../../db/repositories/agency.repository.js';
import {
  effectiveOfChain,
  followedTemplate,
  plainTemplateRefOf,
  type EffectiveTemplate,
} from '../../../agency/campaign-templates/resolve-effective.js';
import { templateSourceFor } from '../../../agency/campaign-templates/template-source.js';
import { accountOrRefuse } from '../helpers/account-scope.js';
import { fetchOwnedCoreCampaign } from '../helpers/core-campaign.js';
import { patchCampaignConfig } from '../helpers/campaign-patch.js';
import { UUID_RE } from '../../../utils/uuid.js';
import {
  auditTemplate,
  readerOf,
  sendTemplateRefusal,
  templateGuards,
  templateIdOf,
} from './shared.js';
import { applyTemplateSchema, zodDetails } from './validate.js';

type Refused = Extract<AgencyCampaignTemplateApplyResult, { result: 'refused' }>;

const REFUSAL_MESSAGES: Record<Refused['code'], string> = {
  campaign_not_found: 'Campaign not found.',
  campaign_not_draft: 'This campaign has been started. A template is applied to draft campaigns only.',
  campaign_archived: 'This campaign is archived.',
  campaign_rejected: 'The campaign’s settings refused this change.',
};

function refused(campaignId: string, code: Refused['code'], extra: Partial<Refused> = {}): Refused {
  return { campaign_id: campaignId, result: 'refused', code, message: REFUSAL_MESSAGES[code], ...extra };
}

/** The PATCH body: each chosen section's fields as filled in. */
export function applyPatchBody(
  config: EffectiveTemplate['resolved']['config'],
  sections: readonly AgencyCampaignTemplateSectionKey[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of sections) {
    for (const field of AGENCY_CAMPAIGN_TEMPLATE_SECTIONS[key] as readonly string[]) {
      body[field] = structuredClone((config as Record<string, unknown>)[field]);
    }
  }
  return body;
}

export async function registerCampaignTemplateApplyRoutes(app: FastifyInstance): Promise<void> {
  const guards = templateGuards('agency.campaign_templates.manage', 'agency.campaigns.write');

  app.post<{ Params: { id: string } }>('/campaign-templates/:id/apply', guards, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply, 'A template is applied to the campaigns of one account. Send X-Account-Id.');
    if (!accountId) return reply;
    const id = templateIdOf(request.params.id);
    const row = id === null ? null : await agencyCampaignTemplateRepository.findVisible(readerOf(request), id);
    if (!row) return sendTemplateRefusal(reply, 'campaign_template_not_found');
    const parsed = applyTemplateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendTemplateRefusal(reply, 'campaign_template_invalid', { details: zodDetails(parsed.error) });
    const body = parsed.data;
    if (row.archived_at !== null) return sendTemplateRefusal(reply, 'campaign_template_archived');
    if (body.expected_version !== undefined && body.expected_version !== row.version) {
      return sendTemplateRefusal(reply, 'campaign_template_changed', { extra: { current_version: row.version } });
    }

    const tenantId = request.tenantId!;
    const scope = { tenantId, accountId };
    // The template (read above) and the organisation template it follows, each read once and
    // pinned for every campaign: the version checked is the version applied (module note).
    const effective = await effectiveOfChain(scope, { chosen: row, basedOn: await followedTemplate(readerOf(request), row) });
    const refs = { template: effective.wire.template, based_on: effective.wire.based_on };
    const fill = { ...refs, resolved: effective.resolved };
    // The map's order, whatever order they were sent in.
    const sections = AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.filter((k) => body.sections.includes(k));
    const patch = applyPatchBody(effective.resolved.config, sections);

    const results: AgencyCampaignTemplateApplyResult[] = [];
    for (const raw of body.campaign_ids) {
      if (!UUID_RE.test(raw)) {
        results.push(refused(raw, 'campaign_not_found'));
        continue;
      }
      const campaignId = raw;
      // The internal handler's own read: its ownership rule (tenant AND account) and its gate.
      const probe = await fetchOwnedCoreCampaign(request, campaignId, accountId);
      if (!probe.ok) {
        results.push(probe.status === 404
          ? refused(campaignId, 'campaign_not_found')
          : refused(campaignId, 'campaign_rejected', rejection(probe.status, probe.body)));
        continue;
      }
      const before = probe.body as AgencyCampaign;
      if (before.archived_at) {
        results.push(refused(campaignId, 'campaign_archived'));
        continue;
      }
      if (before.status !== 'draft') {
        results.push(refused(campaignId, 'campaign_not_draft'));
        continue;
      }
      // A fresh copy per campaign: the PATCH path may normalise what it is handed.
      const answer = await patchCampaignConfig(request, campaignId, structuredClone(patch));
      if (answer.status >= 400) {
        results.push(refused(campaignId, 'campaign_rejected', rejection(answer.status, answer.body)));
        continue;
      }
      const after = answer.body as AgencyCampaign;
      const recorded = await agencyCampaignRepository.rewriteTemplateSource(
        campaignId, scope, (current) => templateSourceFor(scope, current, refs, fill),
      );
      if (!recorded?.template_source) {
        // The row went between the PATCH and here (a campaign is never deleted; not expected).
        results.push(refused(campaignId, 'campaign_not_found'));
        continue;
      }
      results.push({
        campaign_id: campaignId,
        result: 'applied',
        changed_sections: diffSections(
          sectionsFromCampaign(before, 'account', sections),
          sectionsFromCampaign(after, 'account', sections),
        ).map((d) => d.section),
        template_source: recorded.template_source,
      });
    }

    auditTemplate(request, 'campaign_template.applied', row, {
      sections,
      applied: results.filter((r) => r.result === 'applied').map((r) => r.campaign_id),
      refused: results.filter((r): r is Refused => r.result === 'refused').map((r) => ({ campaign_id: r.campaign_id, code: r.code })),
    }, { accountId });
    const response: AgencyCampaignTemplateApplyResponse = { template: plainTemplateRefOf(row), results };
    return reply.send(response);
  });
}

/** A PATCH path refusal as an apply result's `status`, `rejection_code`, `message` and `details`. */
function rejection(status: number, body: unknown): Partial<Refused> {
  const b = (body ?? {}) as { code?: unknown; error?: unknown; message?: unknown; details?: unknown };
  // A capability refusal names itself in `error` (`capability_disabled`), the others in `code`;
  // a validation 400 carries neither, only `details`.
  const code = typeof b.code === 'string' ? b.code : b.error === 'capability_disabled' ? b.error : undefined;
  return {
    status,
    ...(code !== undefined ? { rejection_code: code } : {}),
    ...(typeof b.message === 'string' ? { message: b.message } : {}),
    ...(b.details !== null && typeof b.details === 'object' && !Array.isArray(b.details)
      ? { details: b.details as Record<string, unknown> }
      : {}),
  };
}
