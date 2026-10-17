/*
 * The supervisor's staffing of one campaign: list, assign and unassign under
 * `/campaigns/:id/agents`, each behind `assertCampaignInScope`. Part of
 * `proxy-agency-staffing.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { fetchOwnedCoreCampaign } from '../helpers/core-campaign.js';
import { createChildLogger } from '@magick-agency/observability';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../../audit/platform/audit-actor.js';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { agencyCampaignAgentRepository, StaffingUpgradePendingError } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { enrichAssignedAgents } from '../../../agency/agency-agent-identity.js';
import { parseOr400 } from '../helpers/parse-or-400.js';

const log = createChildLogger({ component: 'proxy-agency-staffing' });

/**
 * Which person to staff. `campaign_id` is deliberately NOT a body field — it is
 * the URL's `:id`, so a body cannot name a campaign the caller did not address
 * and quietly assign into it.
 */
const assignAgentSchema = z.object({
  user_id: z.string().uuid(),
});

/**
 * Path params, validated as strictly as the bodies are.
 *
 * ── Why a raw `:id` is not merely untidy ───────────────────────────────────
 * `campaign_id` and `user_id` are `UUID` columns. Handing Postgres
 * `'not-a-uuid'` raises `22P02 invalid_text_representation` from inside the
 * query, which propagates as a 500 — and `errorMaskHook` masks every 5xx, so the
 * caller gets "contact support and quote this request id" for a typo they could
 * have fixed themselves. Worse, it is noise in the 5xx rate for something that
 * is not a server fault at all.
 *
 * This is the established local pattern, not a new one:
 * `tenant-context.middleware.ts` maps `22P02` to a refusal rather than a 500 for
 * exactly this reason, and `user.repository.ts` filters non-UUID ids out in JS
 * before they reach `ANY($1::uuid[])` — including in `findIdentitiesInTenant`,
 * which this file calls.
 *
 * Two schemas rather than one shared shape, because `DELETE` names two different
 * things and a `details` payload saying "id" for a bad `:userId` sends the caller
 * to the wrong half of their URL.
 */
const campaignParamsSchema = z.object({
  id: z.string().uuid(),
});

const campaignAgentParamsSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});

/**
 * Prove the caller may act on this campaign AT ALL, through the internal
 * handler's `GET /agency-campaigns/:id`, whose `requireOwned` compares
 * `tenant_id` AND `account_id` and answers 404 `campaign_not_found`.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 * Campaign ownership is `(tenant_id, account_id)` on the campaign row.
 * `agency_campaign_agents.tenant_id` scopes a query to the tenant and says
 * nothing about the ACCOUNT, so a tenant-scoped predicate alone lets an
 * `account_admin` of Account A name a campaign belonging to Account B in the
 * same tenant. On `GET` that leaks another account's staffing list *with names
 * and emails*; on `DELETE` it unstaffs their agents — a read/delete weaker than
 * the write it guards, which is backwards. All three routes go through this one
 * function.
 *
 * ── Why `requireOwned`, and not `agency_campaign_agents.account_id` ────────
 * That column is attribution, not authority: it records the account context the
 * assignment was MADE in, which is not the campaign's owning account, and a
 * tenant-level member (`account_id IS NULL`) writes NULL into it. Filtering on it
 * would be a second, weaker ownership mechanism sitting beside `requireOwned` —
 * and two mechanisms for one rule is how they disagree. One handler read keeps
 * exactly one definition of "may this caller act on this campaign".
 *
 * Returns true to proceed. On refusal it has already replied, so the caller must
 * `return` immediately.
 */
async function assertCampaignInScope(
  request: FastifyRequest,
  reply: FastifyReply,
  campaignId: string,
): Promise<boolean> {
  // The internal handler's `GET /agency-campaigns/:id`, in-process. What it can answer, and
  // where each lands below: 200 (owned) → proceed; 404 `campaign_not_found` (unknown, or
  // `requireOwned`'s tenant/account mismatch) → this route's 404; 403 `feature_disabled`
  // (`agency_dialer_enabled` off) and 400 (no `x-mgkvc-account`: a tenant-level caller
  // with no `X-Account-Id`) → passed through as-is; a handler fault → its 500, passed through.
  const campaign = await fetchOwnedCoreCampaign(request, campaignId);
  if (campaign.ok) return true;

  if (campaign.status === 404) {
    // `code` is carried explicitly and it is not decoration: a bare
    // `{ error, message }` gives the console nothing to branch on for a campaign
    // that simply does not exist. Same reason the roster-clear route carries it.
    //
    // A campaign in another account and one that does not exist answer
    // identically, which is the non-oracle property RBAC refusals must keep —
    // and it is `requireOwned`'s 404, so this route does not even learn which it
    // was.
    reply.code(404).send({
      error: 'Not Found',
      code: 'campaign_not_found',
      message: 'Campaign not found.',
    });
    return false;
  }
  // Anything else — the handler refusing or faulting — is passed through as-is
  // rather than collapsed into a 404. This route could not PROVE the campaign
  // is missing, and answering "not found" for "we could not ask" is the
  // confident-wrong answer this codebase keeps having to un-learn.
  reply.code(campaign.status).send(campaign.body);
  return false;
}

/**
 * Registered by `proxyAgencyStaffingRoutes` on its own instance, after its session and
 * tenant-context hooks.
 */
export async function registerCampaignAgentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /proxy/agency/campaigns/:id/agents — the campaign's roster of PEOPLE.
   *
   * Note the word: `roster` already means CONTACTS everywhere else in this
   * codebase (`src/agency/agency-roster.client.ts`, the ingest pipeline), so it
   * is not used for this surface anywhere it could be read as the other thing.
   * This is *staffing*, and it is also not `AgentFloor` — that is live session
   * state polled from the dialer's stats, and the two must stay visibly distinct.
   *
   * ── The campaign is proved before anything is read ────────────────────────
   * This route returns NAMES AND EMAILS, so it is the most sensitive of the
   * three: a tenant-only predicate would let an `account_admin` read another
   * account's staffing. `assertCampaignInScope` runs first — see its docstring
   * for why ownership cannot be decided from `agency_campaign_agents`' own
   * columns. An unknown campaign and one in another account are
   * indistinguishable (both 404), which keeps the non-oracle property while
   * enforcing the boundary.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/agents', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const params = parseOr400(campaignParamsSchema, request.params, reply, 'agency');
    if (!params) return reply;
    if (!(await assertCampaignInScope(request, reply, params.data.id))) return reply;

    const assignments = await agencyCampaignAgentRepository.listActiveForCampaign(
      params.data.id,
      request.tenantId!,
    );
    const agents = await enrichAssignedAgents(assignments, request.tenantId!);
    return reply.code(200).send({ agents });
  });

  /**
   * POST /proxy/agency/campaigns/:id/agents — staff someone onto this campaign.
   *
   * ── Assigning someone already staffed elsewhere ADDS; it does not MOVE ─────
   * One active assignment per person per CAMPAIGN, enforced by the partial unique
   * index `uq_agency_campaign_agent_active_campaign` and by
   * `agencyCampaignAgentRepository.assign`, never by a check-then-write here: a
   * read and a write that can disagree is not a rule.
   *
   * Staffing someone onto an afternoon campaign must not silently close their
   * morning row — an ordinary handover would destroy a supervisor's earlier
   * decision with nothing said. Staffing is not occupancy: an agent may be SENT
   * to several campaigns and can only WORK one, and the second half is the dialer
   * runtime's business, not this table's.
   *
   * ── One LIVE campaign at a time is the dialer runtime's to enforce ─────────
   * The live-session index is `(tenant_id, agent_user_id)`
   * (`uq_agency_agent_live_tenant`), so a second concurrent join is refused with
   * a typed 409 naming the campaign they are on, and the console tells them to
   * leave that station first. Nothing here touches a live session: yanking
   * somebody off a call to satisfy a staffing edit is worse than the 409.
   *
   * Read the other way, this is why per-campaign staffing is safe: a row in this
   * table grants nothing, so it cannot put anybody on a second call.
   *
   * ── Two 404s, and neither is a 403 ─────────────────────────────────────────
   * A `user_id` with no membership in this tenant, and a campaign the caller does
   * not own, both answer 404. A 403 on the first would confirm the user id exists
   * somewhere, which is exactly the existence oracle RBAC refusals must not be.
   */
  app.post<{ Params: { id: string } }>('/campaigns/:id/agents', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const params = parseOr400(campaignParamsSchema, request.params, reply, 'agency');
    if (!params) return reply;
    const parsed = parseOr400(assignAgentSchema, request.body, reply, 'agency');
    if (!parsed) return reply;

    // Membership first: it is a local read, and `requirePermission` proves the
    // CALLER's role and never looks at the target row — so the tenant predicate
    // on the target has to be made explicitly, here.
    const memberships = await membershipRepository.findByUserAndTenant(
      parsed.data.user_id,
      request.tenantId!,
    );
    if (memberships.length === 0) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'That user is not a member of this workspace.',
      });
    }

    // Then the campaign — the same gate the other two routes use, so ownership
    // has one definition. An assignment pointing at a campaign this caller may
    // not act on is a row nobody should be able to create.
    if (!(await assertCampaignInScope(request, reply, params.data.id))) return reply;

    let assignment;
    try {
      assignment = await agencyCampaignAgentRepository.assign({
        tenant_id: request.tenantId!,
        account_id: request.accountId ?? null,
        campaign_id: params.data.id,
        user_id: parsed.data.user_id,
        assigned_by: request.user?.id ?? null,
      });
    } catch (err) {
      /**
       * The database still enforces one active assignment per person per
       * TENANT rather than per campaign (`StaffingUpgradePendingError`; not
       * expected on a database built from the baseline). A 409 rather than a 500: the request is
       * well-formed and the conflict is a real, temporary state of the deployment,
       * so the supervisor gets a sentence they can act on instead of "contact
       * support and quote this request id".
       *
       * `409` also matches how the rest of this feature reports a state conflict —
       * the join answers 409 `session_on_other_campaign` for the sibling case — so the
       * console's existing conflict handling shape applies.
       */
      if (err instanceof StaffingUpgradePendingError) {
        log.error(
          {
            tenantId: request.tenantId,
            userId: parsed.data.user_id,
            currentCampaignId: err.currentCampaignId,
            requestedCampaignId: err.requestedCampaignId,
          },
          'Staffing refused: this database does not have the per-campaign staffing index yet',
        );
        return reply.code(409).send({
          error: 'Conflict',
          code: err.code,
          message:
            'That agent is already assigned to another campaign, and this workspace has not ' +
            'finished upgrading to multiple assignments yet. Unassign them from the other ' +
            'campaign, or try again after the next deployment.',
        });
      }
      throw err;
    }

    log.info(
      {
        tenantId: request.tenantId,
        campaignId: params.data.id,
        userId: parsed.data.user_id,
        actingUserId: request.user?.id,
      },
      'Agent assigned to agency campaign',
    );

    // Audited through the SAME path the campaign lifecycle actions use
    // (`platformAuditLogger.log`, buffered) — staffing decides who talks to customers, so
    // "who put them there" is the same class of fact as "who started the
    // campaign". No PII in `details`: ids only, never the name or email the read
    // path resolves.
    platformAuditLogger.log({
      tenant_id: request.tenantId!,
      ...(request.accountId ? { account_id: request.accountId } : {}),
      ...requestAuditActor(request),
      action: 'agency_campaign_agent.assigned',
      resource_type: 'agency_campaign_agent',
      resource_id: assignment.id,
      campaign_id: params.data.id,
      details: { campaign_id: params.data.id, user_id: parsed.data.user_id },
    });

    return reply.code(201).send({
      // The assignment row's own id, additive to the contract's three fields.
      // It is what the audit row above references (`resource_id`), so without it
      // on the wire there is no way to get from a supervisor's report of a bad
      // assignment to the audit entry that recorded it — the client would be
      // holding the only two facts (`campaign_id`, `user_id`) that the audit row
      // relegates to `details`.
      //
      // A fresh assignment and a no-op re-assign return different ids for the same
      // request shape (the first mints a row, the second returns the existing one),
      // which is the honest reading: they are different rows because they are
      // different events.
      id: assignment.id,
      user_id: assignment.user_id,
      campaign_id: assignment.campaign_id,
      assigned_at: assignment.assigned_at,
    });
  });

  /**
   * DELETE /proxy/agency/campaigns/:id/agents/:userId — unstaff someone.
   *
   * ── 204 whether or not a row was closed — DO NOT "fix" this into a 404 ─────
   * Idempotent on purpose, and this is the paragraph that exists to stop the
   * obvious-looking correction. The contract specifies `204` and lists 404 only
   * for an unknown campaign or a non-member user; the tempting extra 404 is "no
   * active assignment to remove", and it is wrong on both of the grounds that
   * decide it:
   *
   *  - **It is not an error.** The requested state is "this person is not staffed
   *    on this campaign", and after a no-op that state HOLDS. Reporting failure
   *    for a request whose goal is satisfied is a lie the supervisor has to go
   *    and investigate.
   *  - **It is reachable without anyone doing anything wrong.** A double-click, a
   *    retry after a lost response, or two supervisors tidying the same list all
   *    produce a second DELETE. A 404 there turns ordinary concurrency into an
   *    incident.
   *
   * It also does not leak: 204 for "nothing to remove" and 204 for "removed" are
   * indistinguishable, which is the same non-oracle property the 404s on the
   * sibling POST route are chosen for.
   *
   * The AUDIT row is the thing that stays conditional — written only when a row
   * actually closed — so the trail records acts rather than requests. That is
   * where the distinction belongs: in the record, not in the status code.
   *
   * ── It DOES prove the campaign first ──────────────────────────────────────
   * Skipping `assertCampaignInScope` so the way OUT of a staffing decision never
   * depends on the ownership read would be an availability argument, and it
   * loses to a security one: without the gate, the UPDATE's
   * `(tenant_id, campaign_id, user_id)` predicate scopes to the TENANT and not
   * the ACCOUNT, so an `account_admin` of one account could unstaff another
   * account's agents. A delete surface weaker than the write surface guarding the
   * same rows is backwards, and the availability cost is bounded and honest: if
   * the ownership read refuses or faults, the unassign answers with that status
   * rather than being silently applied to a campaign the caller may not touch.
   */
  app.delete<{ Params: { id: string; userId: string } }>('/campaigns/:id/agents/:userId', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const params = parseOr400(campaignAgentParamsSchema, request.params, reply, 'agency');
    if (!params) return reply;
    if (!(await assertCampaignInScope(request, reply, params.data.id))) return reply;

    const removedId = await agencyCampaignAgentRepository.unassign(
      request.tenantId!,
      params.data.id,
      params.data.userId,
    );

    if (removedId) {
      log.info(
        {
          tenantId: request.tenantId,
          campaignId: params.data.id,
          userId: params.data.userId,
          actingUserId: request.user?.id,
        },
        'Agent unassigned from agency campaign',
      );
      platformAuditLogger.log({
        tenant_id: request.tenantId!,
        ...(request.accountId ? { account_id: request.accountId } : {}),
        ...requestAuditActor(request),
        action: 'agency_campaign_agent.unassigned',
        resource_type: 'agency_campaign_agent',
        resource_id: removedId,
        campaign_id: params.data.id,
        details: { campaign_id: params.data.id, user_id: params.data.userId },
      });
    }

    return reply.code(204).send();
  });
}
