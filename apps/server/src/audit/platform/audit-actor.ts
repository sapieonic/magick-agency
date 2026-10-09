import type { FastifyRequest } from 'fastify';
import type { AuditActorFields as DbAuditActorFields } from '@magick-agency/db/models/platform/audit.model';
import type { PlatformAuditActorType } from './catalog.js';

/*
 * The actor union is declared in the db model (the repository needs it and
 * cannot import the server) and re-exported here.
 *
 * `request.user` is read through a structural cast: the `FastifyRequest`
 * augmentation that declares it belongs to the session middleware.
 */

/**
 * The actor half of an audit row, as a spreadable fragment.
 *
 * ── Why a discriminated union rather than optional fields ──────────────────
 * The shapes are mutually exclusive and a `human` row's identity field is
 * mandatory: a `human` row without a `user_id` names nobody. Optional fields on
 * one interface make that constructible; the union makes it a type error at the
 * call site.
 *
 * `system` carries no `user_id`, and that is the honest shape: a background job
 * has no principal to name.
 *
 * The fragment spreads directly into an `auditLogger.log({...})` literal
 * alongside `tenant_id`, `action` and the rest, so a call site states the actor
 * once and cannot half-state it.
 */
export type AuditActorFields = DbAuditActorFields;

/**
 * The db model's actor kinds and the catalog's `PLATFORM_AUDIT_ACTOR_TYPES` are
 * two statements of one set — held equal at compile time, in both directions.
 */
type _MissingActorKind = Exclude<PlatformAuditActorType, AuditActorFields['actor_type']>;
const _noMissingActorKind: _MissingActorKind extends never ? true : _MissingActorKind = true;
void _noMissingActorKind;
type _UncataloguedActorKind = Exclude<AuditActorFields['actor_type'], PlatformAuditActorType>;
const _noUncataloguedActorKind: _UncataloguedActorKind extends never ? true : _UncataloguedActorKind = true;
void _noUncataloguedActorKind;

/**
 * The actor for a background write — no HTTP caller, no principal to name.
 *
 * A named constant rather than an inline `{ actor_type: 'system' }` so that
 * "this write is genuinely automatic" is a claim a reader can grep for, and so
 * the places entitled to make it stay visible.
 *
 * Do NOT reach for this to paper over a missing actor on a request-scoped write.
 * `system` means "no caller existed", not "I could not work out who the caller
 * was", and the difference is the entire point of the enum: a NULL actor that
 * comes to mean both tells a reader nothing. Use {@link requestAuditActor}
 * wherever a request exists.
 */
export const SYSTEM_AUDIT_ACTOR = { actor_type: 'system' } as const satisfies AuditActorFields;

/**
 * Who is acting on this request, for `platform_audit_log`.
 *
 * A signed-in user is `human`, with their id.
 *
 * ── The no-principal case ──────────────────────────────────────────────────
 * A request with no user cannot reach an audited write: every audited route
 * registers `sessionMiddleware`, which 401s such a request before any handler
 * runs. It is nonetheless handled rather than asserted, and it resolves to
 * `system` — the only remaining honest answer, since there is provably no
 * principal to name. A `!` here would trade a correct row for a crash inside a
 * buffered logger whose flush failure drops OTHER rows too.
 */
export function requestAuditActor(request: FastifyRequest): AuditActorFields {
  const userId = (request as { user?: { id?: string } | null }).user?.id;
  return userId ? { actor_type: 'human', user_id: userId } : SYSTEM_AUDIT_ACTOR;
}

/**
 * The actor for a write whose acting user was resolved by the caller rather than
 * read from `request.user` — the agency attempt-scoped actions, where
 * `resolveAgencyActor` has already established the agent.
 *
 * ── Why this exists instead of just calling {@link requestAuditActor} ───────
 * It would give the same answer today: `resolveAgencyActor` refuses a request
 * with no user (400 `missing_actor`) and otherwise returns `request.user.id`
 * unchanged, so the two agree by construction. Stating the id the handler
 * actually passed to the internal handler instance keeps the `platform_audit_log`
 * row and the `agent_user_id` the dialer runtime records provably the same value,
 * which is the property those rows exist to support — a supervisor reconciling
 * the two trails is comparing exactly one identity, not two that happen to
 * coincide.
 */
export function resolvedUserAuditActor(request: FastifyRequest, userId: string): AuditActorFields {
  return { actor_type: 'human', user_id: userId };
}
