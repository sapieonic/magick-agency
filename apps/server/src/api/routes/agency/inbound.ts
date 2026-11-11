/*
 * Inbound calls' internal handlers (docs/inbound.md §7, §8.1), on the internal handler instance
 * under `/api/v1/agency` (decision B16): the account's inbound routes (list, read, create,
 * change, delete), the route editor's choices (numbers, recordings; uploading and deleting a
 * recording is `./inbound-clips.ts`), and the Missed inbound list with
 * Mark handled and Reopen. Part of `agency.routes.ts`, inside its authenticated scope.
 *
 * The public routes (`../proxy-agency-inbound.routes.ts`) own RBAC, the `agency_inbound_enabled`
 * flag, the actor, name enrichment and the audit rows; these handlers own validation, the
 * account-scoped reference checks, the repository writes and the refusal mapping
 * (`./inbound-answer.ts`). Every read and write names the request's tenant and account.
 *
 * ── Validation, in order ───────────────────────────────────────────────────────
 *  1. The body's shape and bounds (`agency/inbound/route-config.ts`; a PATCH is merged onto the
 *     stored route and judged whole, read `FOR UPDATE` in the write's transaction, so two PATCHes
 *     cannot each pass the cross-field rules and together break them).
 *  2. This build's actions (`AGENCY_INBOUND_AVAILABLE_ACTIONS`: the callback and, since P2, the
 *     voicemail): a route left on another is refused at `after_hours_action` / `overflow_action`.
 *  3. References the table cannot check: each clip is one of the ACCOUNT's audio files (the
 *     clips' FK names `audio_files` with no tenant: without this an id from another tenant
 *     would play their recording to our caller, the campaign abandon clip's rule), the analysis
 *     profile is an active profile of the account, and every pool campaign is the account's.
 *     A PATCH checks only the references it sets.
 *  4. Numbers (`phone_number_ids`, the route's whole set), by the repository's attach rule.
 * All of 1–3 answer `inbound_route_invalid` with `{ path, message }` per problem; the writes of
 * one request are one transaction, so a refused number leaves nothing written.
 *
 * The actor arrives on the query (`?actor_user_id=`, and `?supervise=true` on the Missed routes),
 * never the body: the route body is strict and is the configuration alone.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AGENCY_INBOUND_AVAILABLE_ACTIONS,
  AGENCY_INBOUND_CLIP_SLOTS,
  AGENCY_INBOUND_CLIPS_MAX,
  type AgencyInboundClipsResponse,
  type AgencyInboundMissedPage,
  type AgencyInboundNumbersResponse,
  type AgencyInboundRoute,
  type AgencyInboundRouteConfig,
  inboundRouteWarnings,
  type AgencyInboundRouteResponse,
  type AgencyInboundRoutesResponse,
} from '@magick-agency/contracts/api/agency/inbound';
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import { audioFileRepository } from '@magick-agency/db/repositories/audio-file.repository';
import { callAnalysisProfileRepository } from '@magick-agency/db/repositories/call-analysis-profile.repository';
import { getAccountId, getTenantId } from '../../middleware/auth.middleware.js';
import { config } from '../../../config/index.js';
import { isStorageConfigured } from '../../../storage/s3.js';
import {
  agencyCampaignRepository,
  agencyInboundCallRepository,
  agencyInboundClipRepository,
  agencyInboundRouteRepository,
  inboundRouteToWire,
  type AgencyInboundAttachRefusal,
} from '../../../db/repositories/agency.repository.js';
import {
  parseInboundRouteCreate,
  parseInboundRouteUpdate,
  type InboundRouteIssue,
} from '../../../agency/inbound/route-config.js';
import type { SoftphoneActor } from '../../../agency/softphone/types.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { sendRefusal } from '../helpers/refusal.js';
import { readKeysetCursor } from '../helpers/read-cursor.js';
import { replyValidationFailed } from '../helpers/parse-or-400.js';
import { INBOUND_MISSED_DEFAULT_LIMIT, inboundMissedQuerySchema, missedAssigneeScope } from '../helpers/inbound-missed-query.js';
import {
  inboundMissedToWire,
  inboundRouteConfigOf,
  sendInboundAnswer,
  sendInboundRefusal,
  type InboundCallHandledAudit,
  type InboundCallReopenedAudit,
  type InboundVoicemailLocation,
  type InboundRefusal,
  type InboundRouteCreatedAudit,
  type InboundRouteDeletedAudit,
  type InboundRouteUpdatedAudit,
} from './inbound-answer.js';

/**
 * The actor of an inbound internal handler, or the 400 `missing_actor` (unreachable behind the
 * public layer). `supervise`: the caller's role holds `agency.supervise` (derived by the public
 * layer from the role, never from what the caller says).
 */
function actorOr400(request: FastifyRequest, reply: FastifyReply, userId: unknown, supervise: boolean): SoftphoneActor | null {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    void sendRefusal(reply, 400, 'missing_actor', 'This action must be attributed to a user.');
    return null;
  }
  return { tenantId: getTenantId(request), accountId: getAccountId(request), userId, supervise };
}

/** The query's actor (`?actor_user_id=`, `?supervise=true`). */
export function queryActor(request: FastifyRequest, reply: FastifyReply): SoftphoneActor | null {
  const query = (request.query ?? {}) as { actor_user_id?: unknown; supervise?: unknown };
  return actorOr400(request, reply, query.actor_user_id, query.supervise === 'true');
}

/** The body's actor (`agent_user_id`, `on_behalf`), as the soft phone's calls carry it. */
export function bodyActor(request: FastifyRequest, reply: FastifyReply): SoftphoneActor | null {
  const body = (request.body ?? {}) as { agent_user_id?: unknown; on_behalf?: unknown };
  return actorOr400(request, reply, body.agent_user_id, body.on_behalf === true);
}

/** A route `:id`: a malformed one is the same 404 as an unknown one (never a `22P02`). */
function routeIdOr404(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): string | null {
  const id = request.params.id;
  if (UUID_RE.test(id)) return id.toLowerCase();
  sendInboundRefusal(reply, { code: 'inbound_route_not_found' });
  return null;
}

/**
 * Whether this deployment puts inbound callers through to agents: one process (IB8), the router's
 * own test (`mayConnect`: with media workers on, every open route's caller is told everyone is
 * busy). The route editor's `connect_unavailable` warning.
 */
function connectsAgents(): boolean {
  return config.processes.mediaWorkers === 0;
}

/**
 * A route as every route read and write answers it, with its warnings (`inboundRouteWarnings`):
 * no opening hours, a deployment that cannot put callers through, a call recorded unannounced.
 * Advisory only.
 */
function routeWithWarnings(route: Parameters<typeof inboundRouteToWire>[0]): AgencyInboundRoute {
  const wire = inboundRouteToWire(route);
  return { ...wire, warnings: inboundRouteWarnings(wire, { connectsAgents: connectsAgents() }) };
}

// ─── Validation past the shape ──────────────────────────────────────────────

const ACTION_FIELDS = ['after_hours_action', 'overflow_action'] as const;

/** Step 2 of the module note: an action this build cannot carry out is refused (`AGENCY_INBOUND_AVAILABLE_ACTIONS`). */
export function unavailableActionIssues(config: Pick<AgencyInboundRouteConfig, 'after_hours_action' | 'overflow_action'>): InboundRouteIssue[] {
  return ACTION_FIELDS
    .filter((field) => !AGENCY_INBOUND_AVAILABLE_ACTIONS.includes(config[field]))
    .map((field) => ({
      path: field,
      message: `${field} cannot be ${config[field]} in this build: a call that reaches nobody gets a callback follow-up.`,
    }));
}

/** Step 3 of the module note, for the references `fields` names (a create: all of them). */
async function referenceIssues(
  fields: { clips?: Partial<AgencyInboundRouteConfig['clips']>; analysis_profile_id?: string | null; pool_campaign_ids?: string[] },
  tenantId: string,
  accountId: string,
): Promise<InboundRouteIssue[]> {
  const issues: InboundRouteIssue[] = [];
  for (const slot of AGENCY_INBOUND_CLIP_SLOTS) {
    const id = fields.clips?.[slot];
    if (!id) continue;
    if (!await audioFileRepository.findByIdScoped(id, tenantId, accountId)) {
      issues.push({ path: `clips.${slot}`, message: `clips.${slot} must be one of this account's audio files.` });
    }
  }
  if (fields.analysis_profile_id) {
    if (!await callAnalysisProfileRepository.findByIdScoped(fields.analysis_profile_id, tenantId, accountId)) {
      issues.push({ path: 'analysis_profile_id', message: 'analysis_profile_id must be an active profile of this account.' });
    }
  }
  const pool = fields.pool_campaign_ids ?? [];
  if (pool.length > 0) {
    const owned = new Set((await agencyCampaignRepository.findOwnedSummaries(pool, tenantId, accountId)).map((c) => c.id));
    pool.forEach((id, i) => {
      if (!owned.has(id)) issues.push({ path: `pool_campaign_ids[${i}]`, message: 'Each pool campaign must be one of this account\'s campaigns.' });
    });
  }
  return issues;
}

/** A number the repository refused, as the contract's refusal. The holder is named only when it is this account's route. */
async function numberRefusal(refusal: AgencyInboundAttachRefusal, tenantId: string, accountId: string): Promise<InboundRefusal> {
  switch (refusal.reason) {
    case 'route_not_found':
      return { code: 'inbound_route_not_found' };
    case 'number_not_found':
      return { code: 'inbound_number_not_found', phone_number_id: refusal.phoneNumberId };
    case 'number_not_linked':
      return { code: 'inbound_number_not_linked', phone_number_id: refusal.phoneNumberId };
    case 'number_in_use': {
      const ours = refusal.routeId && await agencyInboundRouteRepository.findById(tenantId, accountId, refusal.routeId);
      return { code: 'inbound_number_in_use', phone_number_id: refusal.phoneNumberId, ...(ours ? { route_id: refusal.routeId } : {}) };
    }
  }
}

type WriteOutcome<T> = { ok: true; value: T } | { ok: false; refusal: InboundRefusal };

// ─── The routes ─────────────────────────────────────────────────────────────

export async function registerInboundRoutes(sub: FastifyInstance): Promise<void> {
  // ── GET /inbound/routes — the account's live routes, oldest first ─────────
  sub.get('/inbound/routes', async (request, reply) => {
    const routes = await agencyInboundRouteRepository.listForAccount(getTenantId(request), getAccountId(request));
    const body: AgencyInboundRoutesResponse = { routes: routes.map(routeWithWarnings) };
    return reply.send(body);
  });

  // ── GET /inbound/routes/:id ───────────────────────────────────────────────
  sub.get<{ Params: { id: string } }>('/inbound/routes/:id', async (request, reply) => {
    const id = routeIdOr404(request, reply);
    if (!id) return reply;
    const route = await agencyInboundRouteRepository.findById(getTenantId(request), getAccountId(request), id);
    if (!route) return sendInboundRefusal(reply, { code: 'inbound_route_not_found' });
    const body: AgencyInboundRouteResponse = { route: routeWithWarnings(route) };
    return reply.send(body);
  });

  // ── POST /inbound/routes — create, with its numbers, in one transaction ───
  sub.post('/inbound/routes', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    const parsed = parseInboundRouteCreate(request.body);
    if (!parsed.ok) return sendInboundRefusal(reply, { code: 'inbound_route_invalid', details: parsed.issues });
    const issues = [
      ...unavailableActionIssues(parsed.config),
      ...await referenceIssues(parsed.config, actor.tenantId, actor.accountId),
    ];
    if (issues.length > 0) return sendInboundRefusal(reply, { code: 'inbound_route_invalid', details: issues });

    const out = await withTransaction<WriteOutcome<{ routeId: string; added: string[] }>>(async (client, tx) => {
      const created = await agencyInboundRouteRepository.create(
        { tenantId: actor.tenantId, accountId: actor.accountId, createdBy: actor.userId, config: parsed.config },
        { client },
      );
      if (!created.ok) {
        await tx.rollback();
        return { ok: false, refusal: { code: 'inbound_route_name_taken' } };
      }
      let added: string[] = [];
      if (parsed.phoneNumberIds && parsed.phoneNumberIds.length > 0) {
        const set = await agencyInboundRouteRepository.setNumbers({
          tenantId: actor.tenantId, accountId: actor.accountId, routeId: created.route.id,
          phoneNumberIds: parsed.phoneNumberIds, userId: actor.userId,
        }, { client });
        if (!set.ok) {
          await tx.rollback();
          return { ok: false, refusal: await numberRefusal(set, actor.tenantId, actor.accountId) };
        }
        added = set.added;
      }
      return { ok: true, value: { routeId: created.route.id, added } };
    }, { pool: getPool() });
    if (!out.ok) return sendInboundRefusal(reply, out.refusal);

    const route = await agencyInboundRouteRepository.findById(actor.tenantId, actor.accountId, out.value.routeId);
    if (!route) return sendInboundRefusal(reply, { code: 'inbound_route_not_found' });
    const audit: InboundRouteCreatedAudit = { route_id: route.id, numbers_added: out.value.added };
    return sendInboundAnswer<AgencyInboundRouteResponse, InboundRouteCreatedAudit>(reply, 201, { route: routeWithWarnings(route) }, audit);
  });

  // ── PATCH /inbound/routes/:id — judged as the route it makes ──────────────
  sub.patch<{ Params: { id: string } }>('/inbound/routes/:id', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    const id = routeIdOr404(request, reply);
    if (!id) return reply;

    const out = await withTransaction<WriteOutcome<InboundRouteUpdatedAudit>>(async (client, tx) => {
      const refuse = async (refusal: InboundRefusal): Promise<WriteOutcome<InboundRouteUpdatedAudit>> => {
        await tx.rollback();
        return { ok: false, refusal };
      };
      const current = await agencyInboundRouteRepository.findById(actor.tenantId, actor.accountId, id, { client, lock: true });
      if (!current) return refuse({ code: 'inbound_route_not_found' });
      const parsed = parseInboundRouteUpdate(request.body, inboundRouteConfigOf(inboundRouteToWire(current)));
      if (!parsed.ok) return refuse({ code: 'inbound_route_invalid', details: parsed.issues });
      const issues = [
        ...unavailableActionIssues(parsed.config),
        ...await referenceIssues(parsed.patch, actor.tenantId, actor.accountId),
      ];
      if (issues.length > 0) return refuse({ code: 'inbound_route_invalid', details: issues });

      let added: string[] = [];
      let removed: string[] = [];
      if (parsed.phoneNumberIds !== undefined) {
        const set = await agencyInboundRouteRepository.setNumbers({
          tenantId: actor.tenantId, accountId: actor.accountId, routeId: id,
          phoneNumberIds: parsed.phoneNumberIds, userId: actor.userId,
        }, { client });
        if (!set.ok) return refuse(await numberRefusal(set, actor.tenantId, actor.accountId));
        added = set.added;
        removed = set.removed;
      }
      // Last of the writes: a rename onto a taken name is a 23505 that aborts the transaction
      // (the repository answers it `name_taken`), after which only the rollback may run.
      if (parsed.changed.length > 0) {
        const updated = await agencyInboundRouteRepository.update(actor.tenantId, actor.accountId, id, parsed.patch, actor.userId, { client });
        if (!updated.ok) return refuse({ code: updated.reason === 'name_taken' ? 'inbound_route_name_taken' : 'inbound_route_not_found' });
      }
      return { ok: true, value: { route_id: id, fields: parsed.changed, numbers_added: added, numbers_removed: removed } };
    }, { pool: getPool() });
    if (!out.ok) return sendInboundRefusal(reply, out.refusal);

    const route = await agencyInboundRouteRepository.findById(actor.tenantId, actor.accountId, id);
    if (!route) return sendInboundRefusal(reply, { code: 'inbound_route_not_found' });
    return sendInboundAnswer<AgencyInboundRouteResponse, InboundRouteUpdatedAudit>(reply, 200, { route: routeWithWarnings(route) }, out.value);
  });

  // ── DELETE /inbound/routes/:id — soft delete; its numbers are detached ────
  sub.delete<{ Params: { id: string } }>('/inbound/routes/:id', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    const id = routeIdOr404(request, reply);
    if (!id) return reply;
    const deleted = await agencyInboundRouteRepository.softDelete(actor.tenantId, actor.accountId, id, actor.userId);
    if (!deleted) return sendInboundRefusal(reply, { code: 'inbound_route_not_found' });
    const audit: InboundRouteDeletedAudit = { route_id: id, numbers_removed: deleted.detachedPhoneNumberIds };
    return sendInboundAnswer(reply, 200, null, audit);
  });

  // ── GET /inbound/numbers — the route editor's number choices ──────────────
  sub.get('/inbound/numbers', async (request, reply) => {
    const numbers = await agencyInboundRouteRepository.listNumberOptions(getTenantId(request), getAccountId(request));
    const body: AgencyInboundNumbersResponse = { numbers };
    return reply.send(body);
  });

  // ── GET /inbound/clips — the account's recordings, and what this deployment can do with them ──
  sub.get('/inbound/clips', async (request, reply) => {
    const clips = await agencyInboundClipRepository.listForAccount(getTenantId(request), getAccountId(request), AGENCY_INBOUND_CLIPS_MAX);
    const body: AgencyInboundClipsResponse = {
      clips,
      upload_available: isStorageConfigured(),
      connects_agents: connectsAgents(),
    };
    return reply.send(body);
  });

  // ── GET /inbound/missed — the Missed inbound list ─────────────────────────
  sub.get('/inbound/missed', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    const parsed = inboundMissedQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return replyValidationFailed(reply, parsed.error.flatten());
    const after = readKeysetCursor(request, reply);
    if (after === null) return reply;
    const q = parsed.data;
    // Without `agency.supervise` the list is the caller's own, whatever was asked (§8.1), except
    // `unassigned`: the account's rows nobody has, which any caller with the list reads (IQ49).
    const assignee = missedAssigneeScope(actor, q.assignee);
    const limit = q.limit ?? INBOUND_MISSED_DEFAULT_LIMIT;
    const page = await agencyInboundCallRepository.listMissed({
      tenantId: actor.tenantId,
      accountId: actor.accountId,
      status: q.status ?? 'open',
      ...(assignee ? { assignee } : {}),
      ...(q.reason ? { reason: q.reason } : {}),
      ...(q.from ? { from: new Date(q.from) } : {}),
      ...(q.to ? { to: new Date(q.to) } : {}),
      ...(after ? { after } : {}),
      limit,
    });
    const body: AgencyInboundMissedPage = { rows: page.rows.map((row) => inboundMissedToWire(row)), next_cursor: page.next_cursor, limit: page.limit };
    return reply.send(body);
  });

  // ── GET /inbound/missed/:id/voicemail — where a Missed row's voicemail is ──
  // The object's key and length, for the public route to stream from the bucket (bytes do not
  // travel through `callCore`, which buffers). The list's rules: the account's row, and without
  // `agency.supervise` only one assigned to the caller or (IQ49) to nobody, an open row of the Team
  // view the agent may claim; a row with no voicemail (none left, or aged out) is the same 404 as
  // a row that is not there.
  sub.get<{ Params: { id: string } }>('/inbound/missed/:id/voicemail', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    if (!UUID_RE.test(request.params.id)) return sendInboundRefusal(reply, { code: 'inbound_missed_call_not_found' });
    const row = await agencyInboundCallRepository.findMissed(actor.tenantId, actor.accountId, request.params.id);
    const agentMayRead = row !== null && (row.follow_up_assignee_user_id === actor.userId
      || (row.follow_up_assignee_user_id === null && row.follow_up_status === 'open'));
    if (!row || !row.voicemail_key || (!actor.supervise && !agentMayRead)) {
      return sendInboundRefusal(reply, { code: 'inbound_missed_call_not_found' });
    }
    const body: InboundVoicemailLocation = { call_id: row.id, voicemail_key: row.voicemail_key, voicemail_seconds: row.voicemail_seconds };
    return reply.send(body);
  });

  // ── POST /inbound/missed/:id/handled — idempotent ─────────────────────────
  sub.post<{ Params: { id: string } }>('/inbound/missed/:id/handled', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    if (!UUID_RE.test(request.params.id)) return sendInboundRefusal(reply, { code: 'inbound_missed_call_not_found' });
    const marked = await agencyInboundCallRepository.markHandled({
      tenantId: actor.tenantId,
      accountId: actor.accountId,
      id: request.params.id,
      userId: actor.userId,
      // An agent marks only the rows assigned to them; another's answers as missing.
      ...(actor.supervise ? {} : { onlyAssignee: actor.userId }),
    });
    if (!marked) return sendInboundRefusal(reply, { code: 'inbound_missed_call_not_found' });
    const audit: InboundCallHandledAudit = { call_id: marked.call.id, changed: marked.changed, reason: marked.call.follow_up_reason! };
    return sendInboundAnswer(reply, 200, { call: inboundMissedToWire(marked.call) }, audit);
  });

  // ── POST /inbound/missed/:id/reopen — idempotent ──────────────────────────
  // Mark handled's rules: the account's row, and without `agency.supervise` only one assigned to
  // the caller (another's answers as missing).
  sub.post<{ Params: { id: string } }>('/inbound/missed/:id/reopen', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    if (!UUID_RE.test(request.params.id)) return sendInboundRefusal(reply, { code: 'inbound_missed_call_not_found' });
    const reopened = await agencyInboundCallRepository.reopenMissed({
      tenantId: actor.tenantId,
      accountId: actor.accountId,
      id: request.params.id,
      ...(actor.supervise ? {} : { onlyAssignee: actor.userId }),
    });
    if (!reopened) return sendInboundRefusal(reply, { code: 'inbound_missed_call_not_found' });
    const audit: InboundCallReopenedAudit = {
      call_id: reopened.call.id,
      changed: reopened.changed,
      // A row handled before 0028 has no reason: a person marked it.
      handled_reason: reopened.previous ? (reopened.previous.reason ?? 'marked') : null,
      handled_by_user_id: reopened.previous?.handledByUserId ?? null,
    };
    return sendInboundAnswer(reply, 200, { call: inboundMissedToWire(reopened.call) }, audit);
  });
}
