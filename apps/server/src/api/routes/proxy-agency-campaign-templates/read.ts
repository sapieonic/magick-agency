/*
 * The campaign template reads (docs/campaign-templates.md §6, CT3): the list, one template, its
 * history and one saved state, and the filled-in form New campaign opens on. Part of
 * `proxy-agency-campaign-templates.routes.ts`. All need `agency.campaigns.write` (whoever creates
 * campaigns starts from templates) and the flag.
 *
 * A reader sees its context account's templates and the organisation's; with no account context,
 * the organisation's alone (`CampaignTemplateReader`). Another account's or tenant's template, a
 * malformed id and a missing one are the same `404 campaign_template_not_found`.
 */
import type { FastifyInstance } from 'fastify';
import type {
  AgencyCampaignTemplateListResponse,
  AgencyCampaignTemplateVersionsResponse,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { agencyCampaignTemplateRepository } from '../../../db/repositories/agency.repository.js';
import { resolveEffectiveTemplate } from '../../../agency/campaign-templates/resolve-effective.js';
import { accountOrRefuse } from '../helpers/account-scope.js';
import {
  basedOnFor,
  namesFor,
  readerOf,
  sendTemplateRefusal,
  templateGuards,
  templateIdOf,
  templateOf,
  templateSummaryToWire,
  versionSummaryToWire,
  versionToWire,
} from './shared.js';
import { effectiveQuerySchema, listQuerySchema, zodDetails } from './validate.js';

export async function registerCampaignTemplateReadRoutes(app: FastifyInstance): Promise<void> {
  const read = templateGuards('agency.campaigns.write');

  // ── GET /campaign-templates[?archived=true] ─────────────────────────────────
  app.get('/campaign-templates', read, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return sendTemplateRefusal(reply, 'campaign_template_invalid', { details: zodDetails(parsed.error) });
    const reader = readerOf(request);
    const rows = await agencyCampaignTemplateRepository.list(reader, { archived: parsed.data.archived === 'true' });
    const [names, templates] = await Promise.all([namesFor(rows, reader.tenantId), basedOnFor(reader, rows)]);
    const body: AgencyCampaignTemplateListResponse = { templates: rows.map((r) => templateSummaryToWire(r, names, templates)) };
    return reply.send(body);
  });

  // ── GET /campaign-templates/effective[?template_id=] ────────────────────────
  // A static segment: the router never hands it to `/:id`. One account's form (a campaign always
  // belongs to one): without `X-Account-Id`, `400 account_scope_required`.
  app.get('/campaign-templates/effective', read, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    const parsed = effectiveQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return sendTemplateRefusal(reply, 'campaign_template_invalid', { details: zodDetails(parsed.error) });
    // Absent (or blank): the default chain. A query cannot say `null`; the built-in settings are
    // the domain's `builtinTemplateSections()`, which the console reads itself.
    let templateId: string | undefined;
    if (parsed.data.template_id !== undefined && parsed.data.template_id !== '') {
      const id = templateIdOf(parsed.data.template_id);
      if (id === null) return sendTemplateRefusal(reply, 'campaign_template_not_found');
      templateId = id;
    }
    const found = await resolveEffectiveTemplate({ tenantId: request.tenantId!, accountId }, templateId);
    if (!found.ok) {
      return sendTemplateRefusal(reply, found.reason === 'archived' ? 'campaign_template_archived' : 'campaign_template_not_found');
    }
    return reply.send(found.effective.wire);
  });

  // ── GET /campaign-templates/:id ─────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/campaign-templates/:id', read, async (request, reply) => {
    const id = templateIdOf(request.params.id);
    const row = id === null ? null : await agencyCampaignTemplateRepository.findVisible(readerOf(request), id);
    if (!row) return sendTemplateRefusal(reply, 'campaign_template_not_found');
    return reply.send(await templateOf(request, row));
  });

  // ── GET /campaign-templates/:id/versions ────────────────────────────────────
  app.get<{ Params: { id: string } }>('/campaign-templates/:id/versions', read, async (request, reply) => {
    const id = templateIdOf(request.params.id);
    const reader = readerOf(request);
    const rows = id === null ? null : await agencyCampaignTemplateRepository.listVersions(reader, id);
    if (rows === null) return sendTemplateRefusal(reply, 'campaign_template_not_found');
    const names = await namesFor(rows, reader.tenantId);
    const body: AgencyCampaignTemplateVersionsResponse = {
      template_id: id!,
      versions: rows.map((r) => versionSummaryToWire(r, names)),
    };
    return reply.send(body);
  });

  // ── GET /campaign-templates/:id/versions/:n ─────────────────────────────────
  app.get<{ Params: { id: string; n: string } }>('/campaign-templates/:id/versions/:n', read, async (request, reply) => {
    const id = templateIdOf(request.params.id);
    const n = /^[1-9]\d{0,8}$/.test(request.params.n) ? Number(request.params.n) : null;
    const reader = readerOf(request);
    const row = id === null || n === null ? null : await agencyCampaignTemplateRepository.findVersion(reader, id, n);
    if (!row) return sendTemplateRefusal(reply, 'campaign_template_not_found', { message: 'That version of the template was not found.' });
    const names = await namesFor([row], reader.tenantId);
    return reply.send(versionToWire(row, names));
  });
}
