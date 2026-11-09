/*
 * What every inbound public route shares (`../proxy-agency-inbound.routes.ts`): the actor (and
 * its `supervise`, derived from the role), the `agency_inbound_enabled` gate, the internal
 * envelope's unwrap, and the audit row's tenancy.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasPermission } from '@magick-agency/contracts/rbac';
import { createChildLogger } from '@magick-agency/observability';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import type { CoreCallResult } from '../../core-dispatch.js';
import { inboundRefusalBody, isInboundCoreAnswer } from '../agency/inbound-answer.js';

const log = createChildLogger({ component: 'proxy-agency-inbound' });

/**
 * Who is acting, from the authenticated request only. `supervise` is whether the caller's ROLE
 * holds `agency.supervise` (`account_admin` and up): it widens the Missed list from the caller's
 * own rows to the account's, and lets them mark any of the account's rows handled. Never read
 * from a body or a query.
 */
export interface InboundRequestActor {
  userId: string;
  supervise: boolean;
}

/** The actor, or the 400 `missing_actor` (unreachable behind the session middleware). */
export function inboundActorOrRefuse(request: FastifyRequest, reply: FastifyReply): InboundRequestActor | null {
  const userId = request.user?.id;
  if (!userId) {
    void reply.code(400).send({
      error: 'Bad Request', code: 'missing_actor', message: 'This action must be attributed to a user.',
    });
    return null;
  }
  const role = request.membership?.role;
  return { userId, supervise: role ? hasPermission(role, 'agency.supervise') : false };
}

/**
 * The request's account (`X-Account-Id`), or the 400 `account_scope_required`. For a route whose
 * work is one account's and that acts before its internal handler would refuse (an upload stored
 * under the account's key, a stream read from the bucket): refused here, before anything is read
 * or stored.
 */
export function inboundAccountOrRefuse(request: FastifyRequest, reply: FastifyReply): string | null {
  if (request.accountId) return request.accountId;
  void reply.code(400).send({
    error: 'Bad Request', code: 'account_scope_required', message: 'This is one account’s work. Send X-Account-Id.',
  });
  return null;
}

/** The actor on an internal request's query. */
export function actorQuery(actor: InboundRequestActor): Record<string, string> {
  return actor.supervise ? { actor_user_id: actor.userId, supervise: 'true' } : { actor_user_id: actor.userId };
}

/**
 * `agency_inbound_enabled` for the request's tenant and account, else 403 `inbound_disabled`.
 * A route preHandler AFTER its `requirePermission`, so a caller without the permission is told
 * that, and the RBAC refusal stays the one the agent-reach sweep reads. The route editor and the
 * queue tiles take it; the finish routes and the Missed list do not (work already taken stays
 * workable with inbound switched off). With the flag off, linked numbers' callers hear the
 * closed message (docs/inbound.md §8.1). A flag read that throws is a 500: fail closed.
 */
export async function requireInboundEnabled(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const enabled = await getFeatureFlagService().isEnabled(FLAGS.agency_inbound_enabled, {
    tenantId: request.tenantId!,
    ...(request.accountId ? { accountId: request.accountId } : {}),
  });
  if (!enabled) {
    const { status, body } = inboundRefusalBody({ code: 'inbound_disabled' });
    return reply.code(status).send(body) as unknown as void;
  }
}

/**
 * An audited route's success: the envelope's `answer` and `audit`, or null after a 502 when the
 * internal handler answered something that is not the envelope (a contract violation between
 * the two layers; masked on the way out, logged here).
 */
export function unwrapInboundAnswer<TAudit>(
  reply: FastifyReply,
  result: CoreCallResult,
  route: string,
): { answer: unknown; audit: TAudit } | null {
  if (isInboundCoreAnswer(result.body)) return { answer: result.body.answer, audit: result.body.audit as TAudit };
  log.error({ route, status: result.status }, 'inbound: the internal handler answered without its envelope');
  void reply.code(502).send({ error: 'Bad Gateway', code: 'core_response_unrecognised', message: 'Inbound calls could not answer.' });
  return null;
}

/** The tenant and account half of a `platform_audit_log` row; each call site states its actor. */
export function inboundAuditTenancy(request: FastifyRequest): { tenant_id: string; account_id?: string } {
  return { tenant_id: request.tenantId!, ...(request.accountId ? { account_id: request.accountId } : {}) };
}
