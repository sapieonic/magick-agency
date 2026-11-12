import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { rejectPathEscapingParams } from './helpers/path-params.js';
import { callCore } from '../core-dispatch.js';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../audit/platform/audit-actor.js';
import { sendCoreRefusal } from './proxy-agency-softphone/shared.js';
import { isPushDeviceId, takePushDeviceAudit, type PushDeviceAudit } from './agency/push-devices.js';

/*
 * The agent app's push devices (Mode B, IQ58–IQ74; `@magick-agency/contracts/agency`
 * `push-devices.ts`), served at `/proxy/agency/push-devices/:deviceId` (decision B16):
 *
 *  - `GET`: the device's status; `PUT`: register or refresh it; `PATCH`: opt in or out ("Stop
 *    ringing" ends this device's `away_ring`); `DELETE`: revoke it (204; also ends its `away_ring`);
 *  - `POST /:deviceId/test-ring`: a `test_ring` push (202), one per 10 s per agent and device.
 *
 * Guards, in this order: the Firebase session and the tenant context (the hooks below),
 * `agency.station.connect` (the agent floor: the app's own devices), the device id's shape (OS3's
 * station device id pattern, else the same 404 as an unknown device). The actor is ALWAYS the
 * signed-in user: own devices only, a supervisor included, and no body field can name another
 * user. Each runs the internal handler (`agency/push-devices.ts`) in-process through `callCore`;
 * this layer writes the audit rows (`agency_push_device.ring_opt_in_changed`,
 * `agency_push_device.revoked`), never with a token.
 */

/** The test ring's limit: one per 10 s, per agent and device (the plan's "1/10 s"). */
export const TEST_RING_RATE_LIMIT = { max: 1, timeWindow: 10_000 } as const;

function deviceIdOr404(request: FastifyRequest<{ Params: { deviceId: string } }>, reply: FastifyReply): string | null {
  if (isPushDeviceId(request.params.deviceId)) return request.params.deviceId;
  void reply.code(404).send({ error: 'Not Found', message: 'No such device.' });
  return null;
}

function actorId(request: FastifyRequest, reply: FastifyReply): string | null {
  const id = request.user?.id;
  if (id) return id;
  void reply.code(400).send({ error: 'Bad Request', code: 'missing_actor', message: 'Sign in as the agent whose phone this is.' });
  return null;
}

function audit(request: FastifyRequest, entry: PushDeviceAudit | null): void {
  if (!entry) return;
  const scope = {
    tenant_id: request.tenantId!,
    ...(request.accountId ? { account_id: request.accountId } : {}),
    resource_type: 'agency_push_device' as const,
    resource_id: entry.id,
  };
  if (entry.revoked) {
    platformAuditLogger.log({
      ...requestAuditActor(request),
      ...scope,
      action: 'agency_push_device.revoked',
      details: { device_id: entry.device_id },
    });
  }
  if (entry.ring_enabled_changed !== undefined) {
    platformAuditLogger.log({
      ...requestAuditActor(request),
      ...scope,
      action: 'agency_push_device.ring_opt_in_changed',
      details: { device_id: entry.device_id, ring_enabled: entry.ring_enabled_changed },
    });
  }
}

export async function proxyAgencyPushDeviceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  app.addHook('preHandler', rejectPathEscapingParams());

  app.get<{ Params: { deviceId: string } }>('/push-devices/:deviceId', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const deviceId = deviceIdOr404(request, reply);
    if (!deviceId) return reply;
    const userId = actorId(request, reply);
    if (!userId) return reply;
    const result = await callCore({
      method: 'GET', path: `/agency/push-devices/${deviceId}`, query: { actor_user_id: userId },
      tenantId: request.tenantId!, accountId: request.accountId,
    });
    return sendCoreRefusal(request, reply, result);
  });

  app.put<{ Params: { deviceId: string } }>('/push-devices/:deviceId', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const deviceId = deviceIdOr404(request, reply);
    if (!deviceId) return reply;
    const userId = actorId(request, reply);
    if (!userId) return reply;
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
    const result = await callCore({
      method: 'PUT', path: `/agency/push-devices/${deviceId}`, body: { ...body, agent_user_id: userId },
      tenantId: request.tenantId!, accountId: request.accountId,
    });
    const entry = takePushDeviceAudit(result.body);
    if (result.status < 400) audit(request, entry);
    return sendCoreRefusal(request, reply, result);
  });

  app.patch<{ Params: { deviceId: string } }>('/push-devices/:deviceId', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const deviceId = deviceIdOr404(request, reply);
    if (!deviceId) return reply;
    const userId = actorId(request, reply);
    if (!userId) return reply;
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
    const result = await callCore({
      method: 'PATCH', path: `/agency/push-devices/${deviceId}`, body: { ring_enabled: body.ring_enabled, agent_user_id: userId },
      tenantId: request.tenantId!, accountId: request.accountId,
    });
    const entry = takePushDeviceAudit(result.body);
    if (result.status < 400) audit(request, entry);
    return sendCoreRefusal(request, reply, result);
  });

  app.delete<{ Params: { deviceId: string } }>('/push-devices/:deviceId', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    const deviceId = deviceIdOr404(request, reply);
    if (!deviceId) return reply;
    const userId = actorId(request, reply);
    if (!userId) return reply;
    const result = await callCore({
      method: 'DELETE', path: `/agency/push-devices/${deviceId}`, query: { actor_user_id: userId },
      tenantId: request.tenantId!, accountId: request.accountId,
    });
    const entry = takePushDeviceAudit(result.body);
    if (result.status >= 400) return sendCoreRefusal(request, reply, result);
    audit(request, entry);
    return reply.code(204).send();
  });

  app.post<{ Params: { deviceId: string } }>('/push-devices/:deviceId/test-ring', {
    preHandler: requirePermission('agency.station.connect'),
    config: {
      rateLimit: {
        ...TEST_RING_RATE_LIMIT,
        // After the session and the RBAC floor (a `preHandler`, not the limiter's default
        // `onRequest`), so an unauthenticated caller is a 401, never a spent bucket, and the bucket
        // is the signed-in agent's own: one per (agent, device), in its own namespace.
        hook: 'preHandler',
        keyGenerator: (request: FastifyRequest) =>
          `ptr:${request.user?.id ?? request.ip}:${(request.params as { deviceId?: string } | undefined)?.deviceId ?? ''}`,
      },
    },
  }, async (request, reply) => {
    const deviceId = deviceIdOr404(request, reply);
    if (!deviceId) return reply;
    const userId = actorId(request, reply);
    if (!userId) return reply;
    const result = await callCore({
      method: 'POST', path: `/agency/push-devices/${deviceId}/test-ring`, body: { agent_user_id: userId },
      tenantId: request.tenantId!, accountId: request.accountId,
    });
    return sendCoreRefusal(request, reply, result);
  });
}
