/*
 * The Missed inbound list (docs/inbound.md §7): the calls that reached nobody, Mark handled, and a
 * row's voicemail (P2, streamed from the bucket, not through `callCore`).
 * `agency.inbound.read` floors at `agent` (§8.1): an agent reads and marks only the rows assigned
 * to them; a caller whose role holds `agency.supervise` reads and marks the account's, assigned
 * or not. The internal handler applies that from the role-derived `supervise` (`shared.ts`).
 * Rows assigned to "the account" (no person) are therefore a supervisor's to work: the design
 * gives an agent "their own Missed rows" only. Part of `proxy-agency-inbound.routes.ts`.
 *
 * Enrichment here: `assignee_name` and `handled_by_name` (`users`, one query; a failed lookup
 * leaves them NULL, never a failed read). Mark handled is audited (`agency_inbound_call.handled`,
 * with the reason) only when this request marked it: a repeat answers the row as it is.
 */
import type { FastifyInstance } from 'fastify';
import type { AgencyInboundMissedCall } from '@magick-agency/contracts/api/agency/inbound';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { resolvedUserAuditActor } from '../../../audit/platform/audit-actor.js';
import { agentNamesOrNone } from '../../../agency/agency-agent-identity.js';
import { callCore } from '../../core-dispatch.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import { inboundMissedQuerySchema, inboundMissedQueryString } from '../helpers/inbound-missed-query.js';
import { createChildLogger } from '@magick-agency/observability';
import { inboundRefusalBody, type InboundCallHandledAudit, type InboundVoicemailLocation } from '../agency/inbound-answer.js';
import { getFileStream, isStorageConfigured } from '../../../storage/s3.js';
import {
  actorQuery,
  inboundActorOrRefuse,
  inboundAuditTenancy,
  requireInboundEnabled,
  unwrapInboundAnswer,
} from './shared.js';

const log = createChildLogger({ component: 'proxy-agency-inbound' });

function isMissedRow(value: unknown): value is AgencyInboundMissedCall {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string';
}

/** The rows with their two names filled from one lookup. */
async function withNames(rows: AgencyInboundMissedCall[], tenantId: string): Promise<AgencyInboundMissedCall[]> {
  const names = await agentNamesOrNone(rows.flatMap((r) => [r.assignee_user_id, r.handled_by_user_id]), tenantId, 'inbound missed list');
  return rows.map((r) => ({
    ...r,
    assignee_name: r.assignee_user_id ? (names.get(r.assignee_user_id) ?? null) : null,
    handled_by_name: r.handled_by_user_id ? (names.get(r.handled_by_user_id) ?? null) : null,
  }));
}

export async function registerInboundMissedRoutes(app: FastifyInstance): Promise<void> {
  const read = [requirePermission('agency.inbound.read'), requireInboundEnabled];

  /** GET /proxy/agency/inbound/missed — a page of Missed rows, newest first. */
  app.get('/inbound/missed', { preHandler: read }, async (request, reply) => {
    const parsed = parseOr400(inboundMissedQuerySchema, request.query ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'GET',
      path: '/agency/inbound/missed',
      query: { ...inboundMissedQueryString(parsed.data), ...actorQuery(actor) },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    const body = result.body as { rows?: unknown } | null;
    if (result.status !== 200 || !body || !Array.isArray(body.rows)) return reply.code(result.status).send(result.body);
    const rows = body.rows.filter(isMissedRow);
    return reply.send({ ...body, rows: await withNames(rows, request.tenantId!) });
  });

  /**
   * GET /proxy/agency/inbound/missed/:id/voicemail — the row's voicemail (`audio/wav`), streamed
   * from the bucket (docs/inbound.md §7). The internal handler applies the list's rules (the
   * account's row; without `agency.supervise`, one assigned to the caller) and says where the
   * object is; the bytes are streamed here, never buffered (`callCore` would). A `Range` request
   * (an `<audio>` element seeking) is passed to the bucket and answered 206 with its
   * `Content-Range`. A row with no voicemail, or one whose object is gone, is
   * `inbound_missed_call_not_found` (the console says it is no longer available).
   */
  app.get<{ Params: { id: string } }>('/inbound/missed/:id/voicemail', { preHandler: read }, async (request, reply) => {
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
      return reply.code(502).send({ error: 'Bad Gateway', code: 'core_response_unrecognised', message: 'The voicemail could not be read.' });
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
      if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') {
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
    reply.header('Cache-Control', 'private, max-age=3600');
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
    if (result.status >= 400) return reply.code(result.status).send(result.body);
    const unwrapped = unwrapInboundAnswer<InboundCallHandledAudit>(reply, result, 'POST /inbound/missed/:id/handled');
    if (!unwrapped) return reply;
    if (unwrapped.audit.changed) {
      platformAuditLogger.log({
        ...inboundAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.userId),
        action: 'agency_inbound_call.handled',
        resource_type: 'agency_inbound_call',
        resource_id: unwrapped.audit.call_id,
        details: { reason: unwrapped.audit.reason },
      });
    }
    const call = (unwrapped.answer as { call?: unknown } | null)?.call;
    if (!isMissedRow(call)) return reply.send(unwrapped.answer);
    const [named] = await withNames([call], request.tenantId!);
    return reply.send({ call: named });
  });
}
