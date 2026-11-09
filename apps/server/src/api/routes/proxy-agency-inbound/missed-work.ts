/*
 * Working the Missed inbound list and the inbound summary (docs/inbound.md §7, §8.4, §11), part of
 * `proxy-agency-inbound.routes.ts`:
 *
 *  - `GET  /inbound/missed/count` (`agency.inbound.read`): the nav badge. An agent's own open rows;
 *    with `agency.supervise`, the account's;
 *  - `POST /inbound/missed/:id/assign` (`agency.supervise`): give an open row to a member of the
 *    account, or to the account; audited `agency_inbound_call.reassigned` when it changed;
 *  - `GET  /inbound/summary` (`agency.supervise`): the account's inbound calls over a range, with
 *    each agent's name.
 *
 * None of them is behind `agency_inbound_enabled`: switching inbound off for a tenant stops new
 * calls reaching a queue (the kill switch), not the follow-up of the calls that already came in,
 * so the badge, a reassign and the report of past calls stay available. None starts a call.
 */
import type { FastifyInstance } from 'fastify';
import type { AgencyInboundMissedCall, AgencyInboundSummary } from '@magick-agency/contracts/api/agency/inbound';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { resolvedUserAuditActor } from '../../../audit/platform/audit-actor.js';
import { agentNamesOrNone } from '../../../agency/agency-agent-identity.js';
import { callCore } from '../../core-dispatch.js';
import type { InboundCallReassignedAudit } from '../agency/inbound-answer.js';
import { actorQuery, inboundActorOrRefuse, inboundAuditTenancy, unwrapInboundAnswer } from './shared.js';
import { withNames } from './missed.js';

function isMissedRow(value: unknown): value is AgencyInboundMissedCall {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string';
}

/** The query string `callCore` takes: the validated keys only, as strings. */
function stringQuery(query: unknown, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const q = (query ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof q[key] === 'string') out[key] = q[key] as string;
  }
  return out;
}

export async function registerInboundMissedWorkRoutes(app: FastifyInstance): Promise<void> {
  /** GET /proxy/agency/inbound/missed/count — `{ open, open_capped, has_rows }`. */
  app.get('/inbound/missed/count', { preHandler: [requirePermission('agency.inbound.read')] }, async (request, reply) => {
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'GET',
      path: '/agency/inbound/missed/count',
      query: actorQuery(actor),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    return reply.code(result.status).send(result.body);
  });

  /** POST /proxy/agency/inbound/missed/:id/assign — `{ assignee_user_id }` → `{ call }`. */
  app.post<{ Params: { id: string } }>('/inbound/missed/:id/assign', { preHandler: [requirePermission('agency.supervise')] }, async (request, reply) => {
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST',
      path: `/agency/inbound/missed/${request.params.id}/assign`,
      query: actorQuery(actor),
      body: request.body ?? {},
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status >= 400) return reply.code(result.status).send(result.body);
    const unwrapped = unwrapInboundAnswer<InboundCallReassignedAudit>(reply, result, 'POST /inbound/missed/:id/assign');
    if (!unwrapped) return reply;
    if (unwrapped.audit.changed) {
      platformAuditLogger.log({
        ...inboundAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.userId),
        action: 'agency_inbound_call.reassigned',
        resource_type: 'agency_inbound_call',
        resource_id: unwrapped.audit.call_id,
        details: { from: unwrapped.audit.from, to: unwrapped.audit.to },
      });
    }
    const call = (unwrapped.answer as { call?: unknown } | null)?.call;
    if (!isMissedRow(call)) return reply.send(unwrapped.answer);
    const [named] = await withNames([call], request.tenantId!, request.accountId);
    return reply.send({ call: named });
  });

  /** GET /proxy/agency/inbound/summary?from&to — `AgencyInboundSummary`, agents named. */
  app.get('/inbound/summary', { preHandler: [requirePermission('agency.supervise')] }, async (request, reply) => {
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'GET',
      path: '/agency/inbound/summary',
      query: { ...stringQuery(request.query, ['from', 'to']), ...actorQuery(actor) },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    const body = result.body as AgencyInboundSummary | null;
    if (result.status !== 200 || !body || !Array.isArray(body.agents)) return reply.code(result.status).send(result.body);
    const names = await agentNamesOrNone(body.agents.map((a) => a.user_id), request.tenantId!, 'inbound summary');
    return reply.send({ ...body, agents: body.agents.map((a) => ({ ...a, name: names.get(a.user_id) ?? null })) });
  });
}
