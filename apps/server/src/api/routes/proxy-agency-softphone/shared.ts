/*
 * What every soft-phone public route shares (`../proxy-agency-softphone.routes.ts`): the
 * actor (and its `supervise`, derived from the role), the `agency_softphone_enabled` gate,
 * the internal envelope's unwrap, the 5xx pass-through of `dnc_unavailable`, the audit
 * row's base, name enrichment, and the account's media grants.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasPermission } from '@magick-agency/contracts/rbac';
import type { AgencyManualCall } from '@magick-agency/contracts/agency';
import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { createChildLogger } from '@magick-agency/observability';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import { DEFAULT_ALLOW_RECORDING, DEFAULT_ANALYZE_CALLS } from '../../../settings/agency-account-settings.js';
import type { CoreCallResult } from '../../core-dispatch.js';
import { isSoftphoneCoreAnswer, softphoneRefusalBody } from '../agency/softphone-answer.js';

const log = createChildLogger({ component: 'proxy-agency-softphone' });

// ─── The actor ──────────────────────────────────────────────────────────────

/**
 * Who is acting, from the authenticated request only. `supervise` is whether the
 * caller's ROLE holds `agency.supervise` (`account_admin` and up): it lets them read the
 * account's calls, act on another agent's call (`on_behalf`) and tag any campaign of the
 * account. It is never read from a body or a query — the schemas strip any client copy,
 * and the internal handler sees only what this function decided.
 */
export interface SoftphoneRequestActor {
  agent_user_id: string;
  supervise: boolean;
}

export function resolveSoftphoneActor(request: FastifyRequest): SoftphoneRequestActor | null {
  const userId = request.user?.id;
  if (!userId) return null;
  const role = request.membership?.role;
  // No membership means RBAC already refused; absent a role, no supervision.
  return { agent_user_id: userId, supervise: role ? hasPermission(role, 'agency.supervise') : false };
}

/** The actor or the 400 `missing_actor` (unreachable behind the session middleware). */
export function softphoneActorOrRefuse(request: FastifyRequest, reply: FastifyReply): SoftphoneRequestActor | null {
  const actor = resolveSoftphoneActor(request);
  if (!actor) {
    void reply.code(400).send({
      error: 'Bad Request', code: 'missing_actor',
      message: 'This action must be attributed to a user. Sign in as the agent or a supervisor.',
    });
    return null;
  }
  return actor;
}

/** The actor on an internal BODY: the session routes' pair (`agent_user_id`, `on_behalf` only when supervising). */
export function actorBody(actor: SoftphoneRequestActor): { agent_user_id: string; on_behalf?: true } {
  return actor.supervise ? { agent_user_id: actor.agent_user_id, on_behalf: true } : { agent_user_id: actor.agent_user_id };
}

/** The actor on an internal GET's query. */
export function actorQuery(actor: SoftphoneRequestActor): Record<string, string> {
  return actor.supervise ? { actor_user_id: actor.agent_user_id, supervise: 'true' } : { actor_user_id: actor.agent_user_id };
}

// ─── The flag ───────────────────────────────────────────────────────────────

/** `agency_softphone_enabled` for the request's tenant and account. Throws when the read fails. */
export function softphoneEnabled(request: FastifyRequest): Promise<boolean> {
  return getFeatureFlagService().isEnabled(FLAGS.agency_softphone_enabled, {
    tenantId: request.tenantId!,
    ...(request.accountId ? { accountId: request.accountId } : {}),
  });
}

/**
 * `agency_softphone_enabled` for the request's tenant and account, else 403
 * `softphone_disabled` (SP4). A route preHandler AFTER its `requirePermission`, so a caller
 * without the permission is told that, and the RBAC refusal stays the one the agent-reach
 * sweep reads. A flag read that throws is a 500: fail closed.
 *
 * **Only on the routes that START work**: opening a soft-phone session, placing a call,
 * switching a campaign session to the soft phone, plus the recording and the settings.
 * The routes that FINISH work already started — hang up, details, the outcome, Mark DNC,
 * the call reads, the return to the campaign, and bootstrap (which reports the flag as
 * `softphone_enabled`) — stay open while it is off, so an agent the flag is switched off
 * under mid-call is never stranded holding a call they cannot end, write up or leave
 * (docs/softphone.md §6). Each of those acts only on the caller's existing session or
 * calls, so the flag gates nothing new by being absent there.
 */
export async function requireSoftphoneEnabled(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const enabled = await softphoneEnabled(request);
  if (!enabled) {
    const { status, body } = softphoneRefusalBody({ code: 'softphone_disabled' });
    return reply.code(status).send(body) as unknown as void;
  }
}

// ─── The internal answer ────────────────────────────────────────────────────

/**
 * Send a refusal from the internal handler as it came. A 4xx passes the error mask
 * untouched; the two 5xx a soft-phone route authors on purpose, `503 dnc_unavailable`
 * (SP1: the DNC lookup failed, fail closed, retry) and `503 dial_failed` (the agent state
 * store or the bridge could not place the dial; nothing was dialled, retry), are reviewed
 * fixed-shape bodies the console reads by code, so they are let through the mask like the
 * revocation cache's 503. Any other 5xx is masked.
 */
const REVIEWED_503_CODES: ReadonlySet<unknown> = new Set(['dnc_unavailable', 'dial_failed']);

export function sendCoreRefusal(request: FastifyRequest, reply: FastifyReply, result: CoreCallResult): FastifyReply {
  const code = result.body && typeof result.body === 'object' ? (result.body as { code?: unknown }).code : undefined;
  if (result.status === 503 && REVIEWED_503_CODES.has(code)) request.preserveReviewedUpstreamError = true;
  return reply.code(result.status).send(result.body);
}

/**
 * An audited route's success: the envelope's `answer` and `audit`, or null after a 502
 * when the internal handler answered something that is not the envelope (a contract
 * violation between the two layers; masked on the way out, logged here).
 */
export function unwrapCoreAnswer<TAudit>(
  reply: FastifyReply,
  result: CoreCallResult,
  route: string,
): { answer: unknown; audit: TAudit } | null {
  if (isSoftphoneCoreAnswer(result.body)) {
    return { answer: result.body.answer, audit: result.body.audit as TAudit };
  }
  log.error({ route, status: result.status }, 'soft-phone: the internal handler answered without its envelope');
  void reply.code(502).send({
    error: 'Bad Gateway', code: 'core_response_unrecognised', message: 'The soft phone could not answer.',
  });
  return null;
}

// ─── Audit ──────────────────────────────────────────────────────────────────

/**
 * The tenant and account half of a `platform_audit_log` row. Each call site states its
 * actor itself (`...resolvedUserAuditActor(request, actor.agent_user_id)`), as every
 * audited write does (`audit-actor-call-sites.test.ts`).
 */
export function softphoneAuditTenancy(request: FastifyRequest): { tenant_id: string; account_id?: string } {
  return {
    tenant_id: request.tenantId!,
    ...(request.accountId ? { account_id: request.accountId } : {}),
  };
}

// ─── Enrichment ─────────────────────────────────────────────────────────────

/**
 * Display names for these user ids in this tenant, in one query. Enrichment never turns
 * a 200 into a 500 (`agency-agent-identity.ts`'s rule): a failed read is an empty map,
 * and every name reads NULL.
 */
export async function namesInTenant(ids: ReadonlyArray<string | null>, tenantId: string): Promise<Map<string, string | null>> {
  const wanted = ids.filter((id): id is string => typeof id === 'string');
  if (wanted.length === 0) return new Map();
  try {
    return await userRepository.findDisplayNamesInTenant(wanted, tenantId);
  } catch (err) {
    log.warn({ err, tenantId }, 'soft-phone: agent names could not be resolved — answering without them');
    return new Map();
  }
}

/** The call with `agent_name` filled from `names` (NULL when unresolved). */
export function withAgentName<T extends AgencyManualCall>(call: T, names: Map<string, string | null>): T {
  return { ...call, agent_name: names.get(call.agent_user_id) ?? null };
}

/** Is this a wire row (enough of one to enrich)? */
export function isManualCallRow(value: unknown): value is AgencyManualCall {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { agent_user_id?: unknown }).agent_user_id === 'string';
}

// ─── The account's media grants ─────────────────────────────────────────────

/**
 * `allow_recording` (`agency.recording`) and `analyze_calls` (`agency.analytics`) of the
 * request's account — a manual call is always the request account's (every read is
 * tenant- and account-scoped). NULL / no row = the documented default; any failure =
 * nothing granted (fail closed), as the attempt read's `resolveOwningAccountGrants`.
 */
export async function accountMediaGrants(request: FastifyRequest): Promise<{ recording: boolean; analytics: boolean }> {
  const tenantId = request.tenantId;
  const accountId = request.accountId;
  if (!tenantId || !accountId) return { recording: false, analytics: false };
  try {
    const row = await accountSettingsRepository.findByTenantAndAccount(tenantId, accountId);
    return {
      recording: (row?.allow_recording ?? DEFAULT_ALLOW_RECORDING) === true,
      analytics: (row?.analyze_calls ?? DEFAULT_ANALYZE_CALLS) === true,
    };
  } catch (err) {
    log.error({ err, tenantId }, 'soft-phone: account settings resolve failed — failing closed');
    return { recording: false, analytics: false };
  }
}
