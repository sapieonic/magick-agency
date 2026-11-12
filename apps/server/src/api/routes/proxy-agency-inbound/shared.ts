/*
 * What every inbound public route shares (`../proxy-agency-inbound.routes.ts`): the actor (and
 * its `supervise`, derived from the role, as the soft phone's), the `agency_inbound_enabled`
 * gate, the internal envelope's unwrap and the audited pass-through, and the audit row's tenancy.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import type { CoreCallResult } from '../../core-dispatch.js';
import { inboundRefusalBody, isInboundCoreAnswer } from '../agency/inbound-answer.js';
import { accountOrRefuse } from '../helpers/account-scope.js';
import { sendRefusal } from '../helpers/refusal.js';
import { resolveSoftphoneActor, type SoftphoneRequestActor } from '../proxy-agency-softphone/shared.js';

/** The actor on an internal request: the soft phone's pair (`actorBody`, `actorQuery`). */
export { actorBody, actorQuery } from '../proxy-agency-softphone/shared.js';

const log = createChildLogger({ component: 'proxy-agency-inbound' });

/**
 * The actor (the soft phone's, `resolveSoftphoneActor`), or the 400 `missing_actor` (unreachable
 * behind the session middleware). Here `supervise` (the caller's ROLE holds `agency.supervise`)
 * widens the Missed list from the caller's own rows to the account's, and lets them mark any of
 * the account's rows handled. Never read from a body or a query.
 */
export function inboundActorOrRefuse(request: FastifyRequest, reply: FastifyReply): SoftphoneRequestActor | null {
  const actor = resolveSoftphoneActor(request);
  if (!actor) void sendRefusal(reply, 400, 'missing_actor', 'This action must be attributed to a user.');
  return actor;
}

/**
 * The request's account (`X-Account-Id`), or the 400 `account_scope_required`. For a route whose
 * work is one account's and that acts before its internal handler would refuse (an upload stored
 * under the account's key, a stream read from the bucket): refused here, before anything is read
 * or stored.
 */
export function inboundAccountOrRefuse(request: FastifyRequest, reply: FastifyReply): string | null {
  return accountOrRefuse(request.accountId, reply, 'This is one account’s work. Send X-Account-Id.');
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
  void sendRefusal(reply, 502, 'core_response_unrecognised', 'Inbound calls could not answer.');
  return null;
}

/**
 * An audited route's answer: the internal handler's refusal as it came; else `audit` runs on the
 * envelope's audit, then `send` answers with the envelope's answer (by default a 200 with it as
 * it came). A body that is not the envelope is {@link unwrapInboundAnswer}'s 502, nothing audited.
 */
export async function sendAudited<TAudit>(
  reply: FastifyReply,
  result: CoreCallResult,
  route: string,
  audit: (audit: TAudit) => void | Promise<void>,
  send: (answer: unknown) => FastifyReply | Promise<FastifyReply> = (answer) => reply.code(200).send(answer),
): Promise<FastifyReply> {
  if (result.status >= 400) return reply.code(result.status).send(result.body);
  const unwrapped = unwrapInboundAnswer<TAudit>(reply, result, route);
  if (!unwrapped) return reply;
  await audit(unwrapped.audit);
  return send(unwrapped.answer);
}

/** The tenant and account half of a `platform_audit_log` row; each call site states its actor. */
export function inboundAuditTenancy(request: FastifyRequest): { tenant_id: string; account_id?: string } {
  return { tenant_id: request.tenantId!, ...(request.accountId ? { account_id: request.accountId } : {}) };
}
