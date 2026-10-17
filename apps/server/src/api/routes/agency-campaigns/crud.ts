/*
 * Campaign create, list, the batched summaries read, one campaign, and PATCH. Part of
 * `agency-campaigns.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getTenantId, getAccountId, getOriginator } from '../../middleware/auth.middleware.js';
import { auditLogger } from '../../../audit/audit-logger.js';
import { agencyCampaignRepository } from '../../../db/repositories/agency.repository.js';
import type { AgencyCampaignStatus } from '@magick-agency/contracts/agency';
// The two `last_transition_by_*` columns folded into the one wire object. Every
// route here that serves a campaign row goes through it, so the fold has one
// definition — see its header for why it is derived from the record rather than
// an allow-list.
import { formatAgencyCampaignResponse } from '../../responses/agency-campaign.response.js';
import { CAMPAIGN_CONFIG_COLUMN_DEFAULTS } from '../../../agency/campaign-config.js';
import { replyValidationFailed } from '../helpers/parse-or-400.js';
// How many ids one `GET /summaries` may name; the staffing `my-*` routes split
// longer lists into reads of at most this many.
import { CAMPAIGN_SUMMARIES_MAX_IDS } from '../helpers/core-campaign.js';
import { abandonAnnouncementRejected, analysisProfileRejected, callerIdsIssue, campaignOf, configRejected, gate, ownedCampaign } from './guards.js';


/** Every campaign status, as a record so a status added to the type must be added here. */
const CAMPAIGN_STATUSES: Record<AgencyCampaignStatus, true> = {
  draft: true,
  running: true,
  paused: true,
  stopping: true,
  completed: true,
  stopped: true,
};

/**
 * The list route's `status` filter: `undefined` when absent or blank, the
 * statuses when every one is known, `'invalid'` otherwise.
 */
export function parseStatusFilter(raw: unknown): AgencyCampaignStatus[] | undefined | 'invalid' {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') return 'invalid';
  const parts = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (parts.length === 0) return undefined;
  if (!parts.every((s): s is AgencyCampaignStatus => Object.hasOwn(CAMPAIGN_STATUSES, s))) return 'invalid';
  return parts;
}

/** Registered by `agencyCampaignRoutes` on its own instance, after its `authMiddleware`. */
export async function registerCampaignCrudRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/v1/agency-campaigns ────────────────────────────────────────
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await gate(request, reply))) return reply;
    const body = request.body as Record<string, unknown> | undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const callerIdsError = callerIdsIssue(body?.caller_ids);

    if (!name || callerIdsError) {
      return replyValidationFailed(reply, {
        ...(name ? {} : { name: 'name is required' }),
        ...(callerIdsError ? { caller_ids: callerIdsError } : {}),
      });
    }
    const callerIds = (body!.caller_ids as string[]).map((id) => id.trim());

    // Before the announcement lookup: this is pure and costs no round trip, and a
    // body that is going to be refused should not spend a DB read first.
    //
    // The base is the schema's COLUMN DEFAULTS, not `{}` — an omitted window
    // side becomes the default rather than nothing, so `{ calling_window_start:
    // '20:00' }` alone stores 20:00–20:00 and never dials. Validating the body in
    // isolation cannot see that, and the default path is the ordinary one.
    if (configRejected(reply, body, CAMPAIGN_CONFIG_COLUMN_DEFAULTS)) return reply;

    if (await abandonAnnouncementRejected(request, reply, body?.abandon_announcement_id)) return reply;

    if (await analysisProfileRejected(request, reply, body?.analysis_profile_id)) return reply;

    const campaign = await agencyCampaignRepository.create({
      tenant_id: getTenantId(request),
      account_id: getAccountId(request),
      name,
      caller_ids: callerIds,
      telephony_provider: body?.telephony_provider as string | undefined,
      calling_window_start: body?.calling_window_start as string | undefined,
      calling_window_end: body?.calling_window_end as string | undefined,
      calling_days: body?.calling_days as number[] | undefined,
      default_timezone: body?.default_timezone as string | undefined,
      wrapup_seconds: body?.wrapup_seconds as number | undefined,
      wrapup_auto_return: body?.wrapup_auto_return as boolean | undefined,
      retry_policy: body?.retry_policy,
      disposition_catalog: body?.disposition_catalog,
      context_display: body?.context_display,
      record_calls: body?.record_calls as boolean | undefined,
      analysis_profile_id: (body?.analysis_profile_id as string | null) ?? null,
      abandon_announcement_id: (body?.abandon_announcement_id as string | null) ?? null,
      // Omitted ⇒ the repository applies
      // `DEFAULT_ABANDONMENT_CEILING_PCT`, which is also the column's DEFAULT.
      abandonment_ceiling_pct: body?.abandonment_ceiling_pct as number | undefined,
      created_by: getOriginator(request) ?? null,
    });

    auditLogger.log({
      tenantId: campaign.tenant_id, accountId: campaign.account_id,
      eventType: 'agency_campaign.created', eventCategory: 'call', severity: 'info',
      actor: getOriginator(request) ?? 'system:api',
      eventData: { campaign_id: campaign.id, name: campaign.name },
    });
    return reply.code(201).send(formatAgencyCampaignResponse(campaign));
  });

  // ── GET /api/v1/agency-campaigns ─────────────────────────────────────────
  //
  // `status` is an optional comma-separated filter (`?status=running,paused`).
  // It narrows `total` too, so a caller can page through just those. An unknown
  // value is a 400 rather than an empty list: a typo must not read as "nothing
  // is running".
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await gate(request, reply))) return reply;
    const q = request.query as { limit?: string; offset?: string; status?: string };
    const limit = Math.min(Math.max(Number(q?.limit ?? 50) || 50, 1), 100);
    const offset = Math.max(Number(q?.offset ?? 0) || 0, 0);
    const statuses = parseStatusFilter(q?.status);
    if (statuses === 'invalid') {
      return replyValidationFailed(reply, { status: `must be a comma-separated list of: ${Object.keys(CAMPAIGN_STATUSES).join(', ')}` });
    }
    const { rows, total } = await agencyCampaignRepository.list(
      getTenantId(request), getAccountId(request), limit, offset, statuses,
    );
    return reply.send({
      campaigns: rows.map(formatAgencyCampaignResponse),
      total, limit, offset,
    });
  });

  // ── GET /api/v1/agency-campaigns/summaries?ids=<id>,<id> ─────────────────
  //
  // `{ campaigns: [{ id, name, status }] }` for the named campaigns this tenant AND
  // account own — `requireOwned`'s rule over a set, in one statement
  // (`findOwnedSummaries`). An id that is unknown or owned elsewhere is absent, so a
  // foreign id and a missing one stay indistinguishable. Gated like every read.
  // The staffing plugin's `my-*` routes label an agent's assignments with it in one
  // round trip instead of one campaign read per assignment. A static segment, so the
  // router never hands it to `/:id`.
  app.get('/summaries', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await gate(request, reply))) return reply;
    const raw = (request.query as { ids?: unknown } | undefined)?.ids;
    const ids = typeof raw === 'string'
      ? raw.split(',').map((id) => id.trim()).filter((id) => id.length > 0)
      : [];
    if (ids.length > CAMPAIGN_SUMMARIES_MAX_IDS) {
      return replyValidationFailed(reply, { ids: `at most ${CAMPAIGN_SUMMARIES_MAX_IDS} campaign ids per request` });
    }
    const campaigns = await agencyCampaignRepository.findOwnedSummaries(
      ids, getTenantId(request), getAccountId(request),
    );
    return reply.send({ campaigns });
  });

  // ── GET /api/v1/agency-campaigns/:id ─────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: ownedCampaign({ gated: true }),
  }, async (request, reply) => {
    const campaign = campaignOf(request);
    return reply.send(formatAgencyCampaignResponse(campaign));
  });

  /**
   * Partial update of campaign configuration.
   *
   * PATCH only. Every field is optional and this is a partial update, which PUT
   * misdescribes, so there is deliberately no PUT alias: an alias the proxy layer
   * calls would be the real interface, not a transition, and would reach
   * customer-facing docs as one.
   *
   * `status` is deliberately NOT patchable: lifecycle goes through the four
   * transition routes, so a config edit can never race the pacing leader's
   * `running → completed` / `stopping → stopped` writes.
   */
  const patchHandler = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const campaign = campaignOf(request);

    const body = { ...(request.body as Record<string, unknown> | undefined) };
    if ('status' in body) {
      return replyValidationFailed(reply, { status: 'status is not editable — use /start, /pause, /resume or /stop' });
    }
    // Checked on the PATCH too, not just create — for the same reason as the
    // apology below: config is the thing an operator edits *after* the campaign
    // exists, so a create-only validator guards the least likely path.
    //
    // The base is the STORED campaign, so the cross-field window rule is evaluated
    // on the effective result, which is why the enforcement belongs here, beside
    // the row, rather than at the proxy route.
    // `caller_ids` is checked on PATCH as well as create, so a campaign cannot be
    // broken after the fact — and `caller_ids` is not part of
    // `validateAgencyCampaignConfig`'s remit (that validator owns the retry/window/
    // disposition invariants), so nothing else catches it. The pacing engine
    // halts on an unusable pool instead of throwing mid-tick, but a campaign that
    // silently stops dialing on a config edit is still the wrong answer: the
    // operator finds out from a dial counter that stopped moving, and the refusal
    // belongs at the edit. Same helper as create, so the two cannot drift.
    if ('caller_ids' in body) {
      const issue = callerIdsIssue(body.caller_ids);
      if (issue) {
        return replyValidationFailed(reply, { caller_ids: issue });
      }
      body.caller_ids = (body.caller_ids as string[]).map((id) => id.trim());
    }

    if (configRejected(reply, body, campaign)) return reply;

    if ('abandon_announcement_id' in body
      && await abandonAnnouncementRejected(request, reply, body.abandon_announcement_id)) return reply;
    // Guarded on presence, like the apology above: a PATCH that does not mention
    // the profile must not 403 merely because `agency_call_analysis` is off.
    if ('analysis_profile_id' in body
      && await analysisProfileRejected(request, reply, body.analysis_profile_id)) return reply;
    const updated = await agencyCampaignRepository.update(campaign.id, body);
    // `update` can only return null if the row vanished between the ownership
    // check and the write — a delete racing an edit. 404 rather than serving
    // `null` as a campaign.
    if (!updated) {
      return reply.code(404).send({
        error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found',
      });
    }
    return reply.send(formatAgencyCampaignResponse(updated));
  };
  app.patch<{ Params: { id: string } }>('/:id', { preHandler: ownedCampaign({ gated: true }) }, patchHandler);
}
