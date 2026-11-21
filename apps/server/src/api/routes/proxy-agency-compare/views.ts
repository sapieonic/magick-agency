/*
 * `GET|POST /compare/views` and `PATCH|DELETE /compare/views/:id`: Compare agents' saved views
 * (contracts `AgencyCompareView` and its requests, docs/compare-agents.md §4). Part of
 * `proxy-agency-compare.routes.ts`. The rules that need a transaction (the per-owner limit, one
 * default per campaign) are the repository's (`compare-view.repository.ts`).
 *
 *  - list: the caller's own views and the account's shared ones; with `campaign_id`, only that
 *    campaign's and those with no campaign (a `campaign_id` not of the account is
 *    `404 compare_campaign_not_found`);
 *  - create: the campaign (when named) is the account's, the content passes `checkCompareView`
 *    against its CURRENT catalog, the owner is under `COMPARE_VIEWS_PER_USER_MAX` (`409
 *    compare_view_limit`); 201;
 *  - edit and delete: the caller's own view only; another supervisor's, a missing one and a
 *    malformed id are the same `404 compare_view_not_found`. An edit is validated as the view it
 *    makes (the stored fields under the ones sent). An edit that does not send
 *    `is_campaign_default` keeps the row's value as the repository reads it under the row's lock,
 *    never the value read here before the transaction: another supervisor's new default, made
 *    meanwhile, is not undone by a rename.
 */
import type { FastifyInstance } from 'fastify';
import {
  COMPARE_VIEWS_PER_USER_MAX,
  type AgencyCompareView,
  type AgencyCompareViewList,
} from '@magick-agency/contracts/api/agency/compare';
import {
  uuidOf,
  checkCompareView,
  compareViewCreateSchema,
  compareViewListQuerySchema,
  compareViewPatchSchema,
  type CompareViewDraft,
} from '../../../agency/compare/validate.js';
import type { CompareViewRecord } from '../../../db/repositories/agency.repository.js';
import { accountOrRefuse } from '../helpers/account-scope.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import {
  compareGuards,
  compareViewToWire,
  resolveCompareCampaign,
  sendCompareRefusal,
  type CompareCampaign,
  type CompareRouteDeps,
} from './shared.js';

export async function registerCompareViewRoutes(app: FastifyInstance, deps: CompareRouteDeps): Promise<void> {
  const supervise = compareGuards(deps);

  const wire = async (rows: readonly CompareViewRecord[], tenantId: string): Promise<AgencyCompareView[]> => {
    const names = await deps.names([...new Set(rows.map((r) => r.owner_user_id))], tenantId);
    return rows.map((r) => compareViewToWire(r, names));
  };

  // ── GET /compare/views ──────────────────────────────────────────────────────
  app.get('/compare/views', supervise, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    const parsed = parseOr400(compareViewListQuerySchema, request.query ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const tenantId = request.tenantId!;
    let campaignId: string | null = null;
    if (parsed.data.campaign_id !== undefined && parsed.data.campaign_id !== '') {
      const campaign = await resolveCompareCampaign(deps, reply, { tenantId, accountId, campaignId: parsed.data.campaign_id });
      if (!campaign) return reply;
      campaignId = campaign.id;
    }
    const rows = await deps.views.list({ tenantId, accountId, userId: request.user!.id, campaignId });
    const body: AgencyCompareViewList = { views: await wire(rows, tenantId) };
    return reply.send(body);
  });

  /** The view's campaign and its catalog (null for a view with none). Undefined once it has replied. */
  const campaignOf = async (
    reply: Parameters<typeof sendCompareRefusal>[0],
    tenantId: string,
    accountId: string,
    campaignId: string | null,
  ): Promise<CompareCampaign | null | undefined> => {
    if (campaignId === null) return null;
    const campaign = await resolveCompareCampaign(deps, reply, { tenantId, accountId, campaignId });
    return campaign ?? undefined;
  };

  // ── POST /compare/views ─────────────────────────────────────────────────────
  app.post('/compare/views', supervise, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    const parsed = parseOr400(compareViewCreateSchema, request.body ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const body = parsed.data;
    const tenantId = request.tenantId!;

    const campaign = await campaignOf(reply, tenantId, accountId, body.campaign_id ?? null);
    if (campaign === undefined) return reply;
    const draft: CompareViewDraft = {
      name: body.name,
      lens: body.lens,
      metrics: body.metrics,
      trend: body.trend ?? null,
      campaign_id: campaign?.id ?? null,
      shared: body.shared ?? false,
      is_campaign_default: body.is_campaign_default ?? false,
    };
    const content = checkCompareView(draft, campaign?.codes ?? null);
    if (content === null) return sendCompareRefusal(reply, 'compare_view_invalid');

    const created = await deps.views.create(
      { tenantId, accountId, ownerUserId: request.user!.id, maxPerOwner: COMPARE_VIEWS_PER_USER_MAX },
      content,
    );
    if (!created.ok) return sendCompareRefusal(reply, 'compare_view_limit');
    const [view] = await wire([created.view], tenantId);
    return reply.code(201).send(view);
  });

  // ── PATCH /compare/views/:id ────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/compare/views/:id', supervise, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    const id = uuidOf(request.params.id);
    if (id === null) return sendCompareRefusal(reply, 'compare_view_not_found');
    const parsed = parseOr400(compareViewPatchSchema, request.body ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const patch = parsed.data;
    const tenantId = request.tenantId!;
    const scope = { tenantId, accountId, userId: request.user!.id };

    const current = await deps.views.findOwned(scope, id);
    if (current === null) return sendCompareRefusal(reply, 'compare_view_not_found');

    const campaign = await campaignOf(reply, tenantId, accountId, patch.campaign_id === undefined ? current.campaign_id : patch.campaign_id);
    if (campaign === undefined) return reply;
    const draft: CompareViewDraft = {
      name: patch.name ?? current.name,
      lens: patch.lens ?? current.lens,
      metrics: patch.metrics ?? current.metrics,
      trend: patch.trend === undefined ? current.trend : patch.trend,
      campaign_id: campaign?.id ?? null,
      shared: patch.shared ?? current.shared,
      is_campaign_default: patch.is_campaign_default ?? current.is_campaign_default,
    };
    const content = checkCompareView(draft, campaign?.codes ?? null);
    if (content === null) return sendCompareRefusal(reply, 'compare_view_invalid');

    // Unsent: keep the row's value as it stands in the update's own transaction (see the module note).
    const updated = await deps.views.update(
      { tenantId, accountId, ownerUserId: request.user!.id },
      id,
      { ...content, is_campaign_default: patch.is_campaign_default ?? null },
    );
    if (updated === null) return sendCompareRefusal(reply, 'compare_view_not_found');
    const [view] = await wire([updated], tenantId);
    return reply.send(view);
  });

  // ── DELETE /compare/views/:id ───────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/compare/views/:id', supervise, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    const id = uuidOf(request.params.id);
    if (id === null) return sendCompareRefusal(reply, 'compare_view_not_found');
    const deleted = await deps.views.delete({ tenantId: request.tenantId!, accountId, ownerUserId: request.user!.id }, id);
    if (!deleted) return sendCompareRefusal(reply, 'compare_view_not_found');
    return reply.code(204).send();
  });
}
