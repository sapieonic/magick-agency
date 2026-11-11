/*
 * The Missed inbound list (docs/inbound.md §7): the calls that reached nobody, Mark handled, and a
 * row's voicemail (P2, streamed from the bucket, not through `callCore`).
 * `agency.inbound.read` floors at `agent` (§8.1): an agent reads and marks only the rows assigned
 * to them; a caller whose role holds `agency.supervise` reads and marks the account's, assigned
 * or not. The internal handler applies that from the role-derived `supervise` (`shared.ts`).
 * Rows assigned to "the account" (no person) an agent reads with `assignee=unassigned` (IQ49, the
 * "Team" view, with their voicemails) and claims one (`missed-work.ts`) to work it as their own.
 * Part of `proxy-agency-inbound.routes.ts`. Never
 * behind `agency_inbound_enabled`: switching inbound off leaves its follow-ups to be worked.
 *
 * Enrichment here: `assignee_name` and `handled_by_name` (`users`, one query; a failed lookup
 * leaves them NULL, never a failed read), and `assignee_departed` (the assignees who can no longer
 * work the account's rows, one query; a failed lookup reads nobody as departed). Mark handled is audited (`agency_inbound_call.handled`,
 * with the reason) only when this request marked it: a repeat answers the row as it is. Reopen
 * (a handled row back on the list, Mark handled's rules) is audited `agency_inbound_call.reopened`,
 * with how and by whom the row had been handled, only when this request reopened it.
 */
import type { FastifyInstance } from 'fastify';
import type { AgencyInboundMissedCall } from '@magick-agency/contracts/api/agency/inbound';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { resolvedUserAuditActor } from '../../../audit/platform/audit-actor.js';
import { agentNamesOrNone } from '../../../agency/agency-agent-identity.js';
import { agencyInboundAnswerRepository } from '../../../db/repositories/agency.repository.js';
import { callCore } from '../../core-dispatch.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import { sendRefusal } from '../helpers/refusal.js';
import { inboundMissedQuerySchema } from '../helpers/inbound-missed-query.js';
import { definedQueryString } from '../helpers/query-string.js';
import { createChildLogger } from '@magick-agency/observability';
import {
  inboundRefusalBody,
  type InboundCallHandledAudit,
  type InboundCallReopenedAudit,
  type InboundVoicemailLocation,
} from '../agency/inbound-answer.js';
import { getFileStream, isS3NotFound, isStorageConfigured } from '../../../storage/s3.js';
import {
  actorQuery,
  inboundActorOrRefuse,
  inboundAuditTenancy,
  sendAudited,
} from './shared.js';

const log = createChildLogger({ component: 'proxy-agency-inbound' });

function isMissedRow(value: unknown): value is AgencyInboundMissedCall {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string';
}

/**
 * Of the rows' assignees, those who are no longer an active member able to work the account's
 * rows (the answer webhook's assignee rule, `filterAccountMembers`). A failed lookup is logged and
 * reads nobody as departed: the flag only adds a prompt, never hides a row.
 */
async function departedAssignees(rows: AgencyInboundMissedCall[], tenantId: string, accountId: string | undefined): Promise<Set<string>> {
  const assignees = [...new Set(rows.flatMap((r) => (r.assignee_user_id ? [r.assignee_user_id] : [])))];
  if (assignees.length === 0 || !accountId) return new Set();
  try {
    const members = await agencyInboundAnswerRepository.filterAccountMembers(tenantId, accountId, assignees);
    return new Set(assignees.filter((id) => !members.has(id)));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'inbound missed list: membership lookup failed; no assignee flagged as departed');
    return new Set();
  }
}

/** The rows with their two names and `assignee_departed` filled (two lookups for the page). */
export async function withNames(rows: AgencyInboundMissedCall[], tenantId: string, accountId: string | undefined): Promise<AgencyInboundMissedCall[]> {
  const [names, departed] = await Promise.all([
    agentNamesOrNone(rows.flatMap((r) => [r.assignee_user_id, r.handled_by_user_id]), tenantId, 'inbound missed list'),
    departedAssignees(rows, tenantId, accountId),
  ]);
  return rows.map((r) => ({
    ...r,
    assignee_name: r.assignee_user_id ? (names.get(r.assignee_user_id) ?? null) : null,
    assignee_departed: r.assignee_user_id !== null && departed.has(r.assignee_user_id),
    handled_by_name: r.handled_by_user_id ? (names.get(r.handled_by_user_id) ?? null) : null,
  }));
}

export async function registerInboundMissedRoutes(app: FastifyInstance): Promise<void> {
  // Not behind `agency_inbound_enabled` (the kill switch, docs/inbound.md §8.1): the Missed list,
  // its voicemails and Mark handled stay readable and workable with inbound switched off, as the
  // finish routes do; calling a customer back goes through the soft phone, which has its own gate.
  const read = [requirePermission('agency.inbound.read')];

  /** GET /proxy/agency/inbound/missed — a page of Missed rows, newest first. */
  app.get('/inbound/missed', { preHandler: read }, async (request, reply) => {
    const parsed = parseOr400(inboundMissedQuerySchema, request.query ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'GET',
      path: '/agency/inbound/missed',
      query: { ...definedQueryString(parsed.data), ...actorQuery(actor) },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    const body = result.body as { rows?: unknown } | null;
    if (result.status !== 200 || !body || !Array.isArray(body.rows)) return reply.code(result.status).send(result.body);
    const rows = body.rows.filter(isMissedRow);
    return reply.send({ ...body, rows: await withNames(rows, request.tenantId!, request.accountId) });
  });

  /**
   * GET /proxy/agency/inbound/missed/:id/voicemail — the row's voicemail (`audio/wav`), streamed
   * from the bucket (docs/inbound.md §7). The internal handler applies the list's rules (the
   * account's row; without `agency.supervise`, one assigned to the caller) and says where the
   * object is; the bytes are streamed here, never buffered (`callCore` would). A `Range` request
   * (an `<audio>` element seeking) is passed to the bucket and answered 206 with its
   * `Content-Range`. A row with no voicemail, or one whose object is gone, is
   * `inbound_missed_call_not_found` (the console says it is no longer available).
   *
   * No automatic HEAD route: Fastify's runs this handler and drops the body, so a HEAD would open
   * a bucket stream for nothing. An `<audio>` element asks with GET.
   *
   * `Cache-Control: private, no-store`: a customer's voice is never kept by a browser or a proxy,
   * so no copy outlives the retention purge (the console fetches it into a blob URL each time it
   * is played).
   */
  app.get<{ Params: { id: string } }>('/inbound/missed/:id/voicemail', { preHandler: read, exposeHeadRoute: false }, async (request, reply) => {
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'GET',
      path: `/agency/inbound/missed/${request.params.id}/voicemail`,
      query: actorQuery(actor),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status !== 200) return reply.code(result.status).send(result.body);
    const where = result.body as Partial<InboundVoicemailLocation> | null;
    if (!where || typeof where.voicemail_key !== 'string') {
      log.error({ route: 'GET /inbound/missed/:id/voicemail' }, 'inbound: the internal handler answered without the voicemail\'s location');
      return sendRefusal(reply, 502, 'core_response_unrecognised', 'The voicemail could not be read.');
    }
    if (!isStorageConfigured()) {
      log.error({ callId: where.call_id }, 'A voicemail was asked for with no object storage configured');
      return reply.code(503).send({ error: 'Service Unavailable', message: 'Voicemails cannot be played right now.' });
    }
    const range = typeof request.headers.range === 'string' && request.headers.range.trim() !== '' ? request.headers.range : undefined;
    let object: Awaited<ReturnType<typeof getFileStream>>;
    try {
      object = await getFileStream(where.voicemail_key, range ? { range } : {});
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (err as { name?: string }).name;
      if (isS3NotFound(err)) {
        const refusal = inboundRefusalBody({ code: 'inbound_missed_call_not_found' });
        return reply.code(refusal.status).send(refusal.body);
      }
      if (status === 416 || name === 'InvalidRange') {
        return reply.code(416).send({ error: 'Range Not Satisfiable', message: 'That part of the voicemail does not exist.' });
      }
      log.error({ err, callId: where.call_id }, 'Could not read a voicemail from storage');
      return reply.code(502).send({ error: 'Bad Gateway', message: 'The voicemail could not be read.' });
    }
    reply.header('Content-Type', 'audio/wav');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, no-store');
    if (object.contentLength !== undefined) reply.header('Content-Length', String(object.contentLength));
    if (object.contentRange) {
      reply.header('Content-Range', object.contentRange);
      reply.code(206);
    }
    return reply.send(object.body);
  });

  /** POST /proxy/agency/inbound/missed/:id/handled — `{ call }`; idempotent. */
  app.post<{ Params: { id: string } }>('/inbound/missed/:id/handled', { preHandler: read }, async (request, reply) => {
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: `/agency/inbound/missed/${request.params.id}/handled`,
      query: actorQuery(actor),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    return sendAudited<InboundCallHandledAudit>(reply, result, 'POST /inbound/missed/:id/handled', (audit) => {
      if (!audit.changed) return;
      platformAuditLogger.log({
        ...inboundAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.agent_user_id),
        action: 'agency_inbound_call.handled',
        resource_type: 'agency_inbound_call',
        resource_id: audit.call_id,
        details: { reason: audit.reason },
      });
    }, async (answer) => {
      const call = (answer as { call?: unknown } | null)?.call;
      if (!isMissedRow(call)) return reply.send(answer);
      const [named] = await withNames([call], request.tenantId!, request.accountId);
      return reply.send({ call: named });
    });
  });

  /** POST /proxy/agency/inbound/missed/:id/reopen — `{ call }`; idempotent. */
  app.post<{ Params: { id: string } }>('/inbound/missed/:id/reopen', { preHandler: read }, async (request, reply) => {
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: `/agency/inbound/missed/${request.params.id}/reopen`,
      query: actorQuery(actor),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    return sendAudited<InboundCallReopenedAudit>(reply, result, 'POST /inbound/missed/:id/reopen', (audit) => {
      if (!audit.changed) return;
      platformAuditLogger.log({
        ...inboundAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.agent_user_id),
        action: 'agency_inbound_call.reopened',
        resource_type: 'agency_inbound_call',
        resource_id: audit.call_id,
        details: { handled_reason: audit.handled_reason, handled_by_user_id: audit.handled_by_user_id },
      });
    }, async (answer) => {
      const call = (answer as { call?: unknown } | null)?.call;
      if (!isMissedRow(call)) return reply.send(answer);
      const [named] = await withNames([call], request.tenantId!, request.accountId);
      return reply.send({ call: named });
    });
  });
}
