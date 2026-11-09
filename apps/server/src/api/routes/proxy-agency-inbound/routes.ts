/*
 * The account's inbound routes and the route editor's choices (docs/inbound.md §8.1): list, read,
 * create, change and delete a route; the numbers and the audio files it may use. Every route is
 * `agency.inbound.write` (account admin) and the flag. Part of `proxy-agency-inbound.routes.ts`.
 *
 * The body is passed to the internal handler as given: it validates the whole route
 * (`agency/inbound/route-config.ts`) and answers every problem as `inbound_route_invalid` with
 * `{ path, message }` per field, which a zod 400 here would answer in another shape with other
 * paths. Writes are audited here (`agency_inbound_route.created|updated|deleted`, ids only).
 */
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { resolvedUserAuditActor } from '../../../audit/platform/audit-actor.js';
import { callCore } from '../../core-dispatch.js';
import type {
  InboundRouteCreatedAudit,
  InboundRouteDeletedAudit,
  InboundRouteUpdatedAudit,
} from '../agency/inbound-answer.js';
import {
  actorQuery,
  inboundActorOrRefuse,
  inboundAuditTenancy,
  requireInboundEnabled,
  unwrapInboundAnswer,
} from './shared.js';

export async function registerInboundRouteRoutes(app: FastifyInstance): Promise<void> {
  const write = [requirePermission('agency.inbound.write'), requireInboundEnabled];

  /** GET /proxy/agency/inbound/routes — `{ routes }`, oldest first. */
  app.get('/inbound/routes', { preHandler: write }, async (request, reply) => {
    const result = await callCore({ method: 'GET', path: '/agency/inbound/routes', tenantId: request.tenantId!, accountId: request.accountId });
    return reply.code(result.status).send(result.body);
  });

  /** GET /proxy/agency/inbound/routes/:id — `{ route }`. */
  app.get<{ Params: { id: string } }>('/inbound/routes/:id', { preHandler: write }, async (request, reply) => {
    const result = await callCore({
      method: 'GET', path: `/agency/inbound/routes/${request.params.id}`, tenantId: request.tenantId!, accountId: request.accountId,
    });
    return reply.code(result.status).send(result.body);
  });

  /** POST /proxy/agency/inbound/routes — 201 `{ route }`, numbers attached in the same write. */
  app.post('/inbound/routes', { preHandler: write }, async (request, reply) => {
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'POST', path: '/agency/inbound/routes', query: actorQuery(actor), body: request.body ?? {},
      tenantId: request.tenantId!, accountId: request.accountId,
    });
    if (result.status >= 400) return reply.code(result.status).send(result.body);
    const unwrapped = unwrapInboundAnswer<InboundRouteCreatedAudit>(reply, result, 'POST /inbound/routes');
    if (!unwrapped) return reply;
    platformAuditLogger.log({
      ...inboundAuditTenancy(request),
      ...resolvedUserAuditActor(request, actor.userId),
      action: 'agency_inbound_route.created',
      resource_type: 'agency_inbound_route',
      resource_id: unwrapped.audit.route_id,
      details: { numbers_added: unwrapped.audit.numbers_added },
    });
    return reply.code(201).send(unwrapped.answer);
  });

  /** PATCH /proxy/agency/inbound/routes/:id — `{ route }`; audited only when something changed. */
  app.patch<{ Params: { id: string } }>('/inbound/routes/:id', { preHandler: write }, async (request, reply) => {
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'PATCH', path: `/agency/inbound/routes/${request.params.id}`, query: actorQuery(actor), body: request.body ?? {},
      tenantId: request.tenantId!, accountId: request.accountId,
    });
    if (result.status >= 400) return reply.code(result.status).send(result.body);
    const unwrapped = unwrapInboundAnswer<InboundRouteUpdatedAudit>(reply, result, 'PATCH /inbound/routes/:id');
    if (!unwrapped) return reply;
    const { fields, numbers_added, numbers_removed } = unwrapped.audit;
    if (fields.length > 0 || numbers_added.length > 0 || numbers_removed.length > 0) {
      platformAuditLogger.log({
        ...inboundAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.userId),
        action: 'agency_inbound_route.updated',
        resource_type: 'agency_inbound_route',
        resource_id: unwrapped.audit.route_id,
        details: { fields, numbers_added, numbers_removed },
      });
    }
    return reply.send(unwrapped.answer);
  });

  /** DELETE /proxy/agency/inbound/routes/:id — 204; the route's numbers are detached. */
  app.delete<{ Params: { id: string } }>('/inbound/routes/:id', { preHandler: write }, async (request, reply) => {
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'DELETE', path: `/agency/inbound/routes/${request.params.id}`, query: actorQuery(actor),
      tenantId: request.tenantId!, accountId: request.accountId,
    });
    if (result.status >= 400) return reply.code(result.status).send(result.body);
    const unwrapped = unwrapInboundAnswer<InboundRouteDeletedAudit>(reply, result, 'DELETE /inbound/routes/:id');
    if (!unwrapped) return reply;
    platformAuditLogger.log({
      ...inboundAuditTenancy(request),
      ...resolvedUserAuditActor(request, actor.userId),
      action: 'agency_inbound_route.deleted',
      resource_type: 'agency_inbound_route',
      resource_id: unwrapped.audit.route_id,
      details: { numbers_removed: unwrapped.audit.numbers_removed },
    });
    return reply.code(204).send();
  });

  /** GET /proxy/agency/inbound/numbers — the numbers a route may answer, with why one cannot. */
  app.get('/inbound/numbers', { preHandler: write }, async (request, reply) => {
    const result = await callCore({ method: 'GET', path: '/agency/inbound/numbers', tenantId: request.tenantId!, accountId: request.accountId });
    return reply.code(result.status).send(result.body);
  });

  /** GET /proxy/agency/inbound/clips — the account's audio files, for the clip slots. */
  app.get('/inbound/clips', { preHandler: write }, async (request, reply) => {
    const result = await callCore({ method: 'GET', path: '/agency/inbound/clips', tenantId: request.tenantId!, accountId: request.accountId });
    return reply.code(result.status).send(result.body);
  });
}
