/*
 * The Missed inbound list (docs/inbound.md §7): the calls that reached nobody, and Mark handled.
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
import type { InboundCallHandledAudit } from '../agency/inbound-answer.js';
import {
  actorQuery,
  inboundActorOrRefuse,
  inboundAuditTenancy,
  requireInboundEnabled,
  unwrapInboundAnswer,
} from './shared.js';

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
