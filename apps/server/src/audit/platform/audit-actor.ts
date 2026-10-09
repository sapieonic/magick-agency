import type { FastifyRequest } from 'fastify';
import type { AuditActorFields as DbAuditActorFields } from '@magick-agency/db/models/platform/audit.model';
import type { PlatformAuditActorType } from './catalog.js';

/*
 * PORT NOTE (magick-agency): ported from master `src/audit/audit-actor.ts`
 * (v3.24.0). The `api_key` actor is removed (decision #5: no API keys; the
 * baseline dropped `platform_audit_log.api_key_id`), and with it the
 * `isPlatformApiKeyCaller` branch of both resolvers — there is no key branch for
 * a request to arrive on. The union itself is declared in the db model (the
 * repository needs it and cannot import the server) and re-exported here; the
 * rationale below is master's and still applies to the two remaining shapes.
 * Comments that discuss API keys are master's and are kept for the history of
 * why the union exists.
 *
 * `request.user` is read through a structural cast: the `FastifyRequest`
 * augmentation that declares it is the session middleware's (lane A). The
 * exported signatures are master's.
 */

/**
 * The actor half of an audit row, as a spreadable fragment (86d45t7rm).
 *
 * ── Why a discriminated union rather than three optional fields ─────────────
 * The three shapes are mutually exclusive and each one's identity field is
 * mandatory *for that shape*: a `human` row without a `user_id` names nobody, and
 * an `api_key` row carrying a `user_id` is the exact defect this whole change
 * repairs — the credential's creator recorded as though they had acted. Three
 * optional fields on one interface make both of those constructible; the union
 * makes them type errors at the call site.
 *
 * `system` carries neither, and that is the honest shape: a scheduler firing has
 * no principal to name.
 *
 * The fragment spreads directly into an `auditLogger.log({...})` literal
 * alongside `tenant_id`, `action` and the rest, so a call site states the actor
 * once and cannot half-state it.
 */
export type AuditActorFields = DbAuditActorFields;

/**
 * PORT NOTE (magick-agency): the db model's actor kinds and the catalog's
 * `PLATFORM_AUDIT_ACTOR_TYPES` are two statements of one set — pinned equal at
 * compile time, in both directions.
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
 * the small number of places entitled to make it stay visible. Today that is the
 * retry manager finalizing a schedule and the scheduler's own execution tick —
 * both fired by EventBridge, neither reachable from a request.
 *
 * Do NOT reach for this to paper over a missing actor on a request-scoped write.
 * `system` means "no caller existed", not "I could not work out who the caller
 * was", and the difference is the entire point of the enum: the ticket's
 * complaint about core's `last_transition_by` is precisely that its NULL had
 * come to mean both. Use {@link requestAuditActor} wherever a request exists.
 */
export const SYSTEM_AUDIT_ACTOR = { actor_type: 'system' } as const satisfies AuditActorFields;

/**
 * Who is acting on this request, for `platform_audit_log`.
 *
 * ── The discriminator is the KEY, not the absence of a user ─────────────────
 * `isPlatformApiKeyCaller` checks `request.apiKeyTenantId`, which
 * `sessionMiddleware` sets on the API-key branch and on no other. The obvious
 * spelling — `request.user ? 'human' : 'api_key'` — is wrong, and wrong in the
 * direction that produced this ticket: the key branch loads
 * `platform_api_keys.created_by` into `request.user`, so a key minted by a real
 * person authenticates CARRYING that person. Under a `!request.user` check every
 * creator-backed key would still be recorded as its creator, which is the
 * misattribution rather than the fix. Only a NULL-`created_by` system key would
 * have been caught — the one shape the tests happened to model, which is how
 * `resolveAgencyActor` and the agency `my-*` surfaces each shipped the same
 * defect before it.
 *
 * So the key is checked FIRST and independently of `request.user`: the two are
 * not alternatives, and a creator-backed key has both.
 *
 * ── An `api_key` row does not name the creator, and loses nothing ───────────
 * `user_id` is omitted for a key — that is the behaviour change this ticket
 * asked for, and it is only safe because `api_key_id` now carries the
 * credential. The creator is still reachable, as
 * `platform_api_keys.created_by`, which migration 065 made
 * non-nullable-by-deletion so it would survive exactly this kind of lookup. One
 * join, deliberately: the creator is a fact about the CREDENTIAL, and copying it
 * into an action's actor field is what made the two trails contradict each other.
 *
 * ── `api_key_id` is spread, not defaulted ──────────────────────────────────
 * `request.apiKey` is assigned on the same branch as `apiKeyTenantId` and in the
 * same statement sequence, so in production a key caller always has one. It is
 * still spread conditionally rather than asserted, because the honest fallback
 * for "a key acted and we cannot name it" is an `api_key` row with no id — which
 * still says the true and useful thing (no human did this) — and never a `human`
 * row, which would say a false one. A `!` here would trade a correct row for a
 * crash inside a buffered logger whose flush failure drops OTHER rows too.
 *
 * ── The no-principal case ──────────────────────────────────────────────────
 * A request with neither a key nor a user cannot reach an audited write: every
 * audited route registers `sessionMiddleware`, which 401s such a request before
 * any handler runs. It is nonetheless typed rather than asserted, and it resolves
 * to `system` — the only remaining honest answer, since there is provably no
 * principal to name.
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
 * It would give the same answer today: `resolveAgencyActor` refuses every API key
 * outright (400 `missing_actor`) and otherwise returns `request.user.id`
 * verbatim, so the two agree by construction. Stating the id the handler actually
 * SENT CORE keeps master's audit row and core's `agent_user_id` provably the same
 * value, which is the property those rows exist to support — a supervisor
 * reconciling the two trails is comparing exactly one identity, not two that
 * happen to coincide.
 *
 * It still routes through the key check rather than trusting the caller, so that
 * if `resolveAgencyActor` ever stopped refusing keys this would degrade to an
 * honest `api_key` row instead of silently stamping a creator as a human.
 */
export function resolvedUserAuditActor(request: FastifyRequest, userId: string): AuditActorFields {
  return { actor_type: 'human', user_id: userId };
}
