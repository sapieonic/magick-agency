/**
 * PORT NOTE (magick-agency): ported from master `src/audit/catalog.ts` (v3.24.0),
 * trimmed to the actions in scope. Removed (PORTING.md lists each): the AI
 * scheduling actions and resource types, and the `api_key` actor type. Master's
 * catalog has no super-admin or notification-preference actions (super-admin
 * writes `super_admin_audit_log`), so nothing was trimmed or added for those.
 *
 * The actions and resource types actually written to `platform_audit_log`.
 *
 * MAG-157. CusUI's Audit Log dropdown used to hardcode `user.invited`,
 * `credits.allocated`, `call.initiated` — none of which this service ever
 * writes. A write that is not in this catalog is a type error on
 * `CreateAuditLogInput.action`.
 *
 * These arrays are no longer mirrored anywhere. CusUI used to duplicate both of
 * them to draw the Audit Log filters, under a "keep them in lockstep"
 * instruction nothing could enforce — master is not a dependency of that repo.
 * `src/audit/vocabulary.ts` labels every value here and `GET /audit-log` SERVES
 * that list on the response it filters, so adding an action or a resource type
 * to this file is the whole change: the vocabulary is exhaustive against these
 * arrays at compile time (and in `test/unit/audit/vocabulary.test.ts`, since
 * vitest does not type-check), and no client has a copy to update.
 */
export const PLATFORM_AUDIT_ACTIONS = [
  'agency_campaign.started',
  'agency_campaign.paused',
  'agency_campaign.resumed',
  'agency_campaign.stopped',
  // A retry campaign authored from a finished (or stopped) campaign's results
  // (DR-1). Master writes this and core does not, which is the whole reason it
  // is in THIS catalog: core records the child's own `agency_campaign.created`,
  // but only master knows the act was a retry, which parent it came from, and
  // which selector the supervisor chose. Without this row the parent's trail
  // says nothing happened on the day someone re-dialled 812 of its contacts.
  'agency_campaign.retry_created',
  'agency_session.joined',
  'agency_session.left',
  'agency_session.break_started',
  'agency_session.break_cancelled',
  'agency_session.force_available',
  'agency_attempt.hung_up',
  'agency_disposition.created',
  // MAG-159. The bulk export of a campaign's attempts or roster is not gated
  // behind a permission of its own — the decision recorded in that PR is that a
  // second gate to keep aligned with `agency.supervise` is a second gate to
  // drift, and that attribution answers the exposure instead. These two actions
  // ARE that attribution: without them the decision has nothing behind it.
  'agency_attempts.exported',
  'agency_contacts.exported',
  'agency_campaign_agent.assigned',
  'agency_campaign_agent.unassigned',
  'dnc_entry.created',
  'dnc_entry.deleted',
  // PORT NOTE (magick-agency): master's `schedule.*` (6) and
  // `recurring_schedule.*` (5) actions are removed — master's scheduler
  // dispatches AI broadcasts, static calls, IVR and messaging, none of which
  // exist here. See PORTING.md.
  // ── Membership invitations (migration 069) ────────────────────────────────
  // Two actions rather than one with a state field, because they are written by
  // two different principals, minutes or days apart, and only one of them is a
  // person acting inside the tenant.
  //
  // `user.invite_sent` is a supervisor's act: a membership was created and a
  // token was mailed. `user.invite_claimed` is written by the PUBLIC,
  // unauthenticated `POST /invites/:token/claim`, on behalf of somebody who had
  // no account here until that request. That second row is the only record
  // anywhere that a particular Firebase identity was bound to a particular
  // membership — and the only place the **address mismatch** is recorded, since
  // the claim deliberately accepts a Firebase address that differs from the
  // invited one (the token is the authority). Neither `memberships` nor `users`
  // retains that fact afterwards, so without this row "who actually walked
  // through this door" is unanswerable.
  'user.invite_sent',
  'user.invite_claimed',
] as const;

export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export const PLATFORM_AUDIT_RESOURCE_TYPES = [
  'agency_campaign',
  'agency_session',
  'agency_attempt',
  'agency_disposition',
  'agency_campaign_agent',
  'dnc_entry',
  // PORT NOTE (magick-agency): `schedule` and `recurring_schedule` removed with
  // their actions (AI scheduling).
  // The INVITATION, not the membership and not the user.
  //
  // `resource_id` is the `membership_invites` row, which is the thing both
  // actions are about and the thing a support question is asked about ("we sent
  // it three times"). Filing these under a `membership` or `user` resource type
  // would be wrong in a way that matters at claim time: the claim's subject is a
  // token, the user it eventually binds is discovered THROUGH that token, and on
  // the refusal paths (expired, revoked, already claimed) there is no user to
  // name at all.
  'membership_invite',
] as const;

export type PlatformAuditResourceType = (typeof PLATFORM_AUDIT_RESOURCE_TYPES)[number];

/**
 * WHAT KIND of principal performed an audited action (86d45t7rm).
 *
 * A third axis alongside the action and the resource type, and the one that
 * makes `user_id` mean what it reads as. Before this existed, every audited
 * write stamped `user_id` and nothing else, and `user_id` answers "which
 * principal did master authenticate" — which for a platform API key is
 * `platform_api_keys.created_by`, the person who minted the credential rather
 * than whoever is holding it now. `sessionMiddleware` loads that user into
 * `request.user`, so a key-authenticated action was indistinguishable from that
 * person acting in a browser. See `src/auth/api-key-caller.ts` for the four
 * separate defects that conflation has caused.
 *
 *  - `human` — a signed-in user. `user_id` is set and is the actor.
 *  - `api_key` — a platform API key. `api_key_id` names the CREDENTIAL;
 *    `user_id` is deliberately NOT set, because the credential's creator did not
 *    perform this action. They remain one join away in
 *    `platform_api_keys.created_by`, which migration 065 made
 *    non-nullable-by-deletion precisely so that provenance survives.
 *  - `system` — a background write with no caller at all: the scheduler firing,
 *    the retry manager finalizing. Distinct from `api_key` and that distinction
 *    is the point — the ticket's complaint about core's `last_transition_by` is
 *    that its NULL conflates "genuinely automatic" with "key-authenticated" with
 *    "predates the field", and this enum exists so master's trail never does.
 *
 * There is no fourth value for "unknown". A row written before migration 067
 * carries a NULL `actor_type`, and NULL is that absence: reading a missing value
 * as a real one is the exact defect above, and adding an `unknown` member would
 * invite a call site to write it deliberately. Nothing in `src/` may stamp NULL
 * — the field is required on `CreateAuditLogInput`.
 */
export const PLATFORM_AUDIT_ACTOR_TYPES = ['human', 'system'] as const;
// PORT NOTE (magick-agency): `'api_key'` removed — decision #5, no API keys.

export type PlatformAuditActorType = (typeof PLATFORM_AUDIT_ACTOR_TYPES)[number];
