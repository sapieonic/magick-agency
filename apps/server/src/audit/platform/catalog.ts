/**
 * The actions and resource types actually written to `platform_audit_log`.
 *
 * There are no super-admin or notification-preference actions here: super-admin
 * writes `super_admin_audit_log`.
 *
 * A write that is not in this catalog is a type error on
 * `CreateAuditLogInput.action`, so a filter offering an action this service
 * never writes cannot arise from this list.
 *
 * These arrays are not mirrored anywhere. `audit/platform/vocabulary.ts` labels
 * every value here and `GET /audit-log` SERVES that list on the response it
 * filters, so adding an action or a resource type to this file is the whole
 * change: the vocabulary is exhaustive against these arrays at compile time (and
 * in `test/unit/audit/platform/vocabulary.test.ts`, since vitest does not
 * type-check), and no client has a copy to update.
 */
export const PLATFORM_AUDIT_ACTIONS = [
  'agency_campaign.started',
  'agency_campaign.paused',
  'agency_campaign.resumed',
  'agency_campaign.stopped',
  // A retry campaign authored from a finished (or stopped) campaign's results;
  // the retry is a new campaign row, never a mutation of the parent. The
  // internal handler records the child's own `agency_campaign.created` in
  // `audit_logs`, but only the retry route knows the act was a retry, which
  // parent it came from, and which selector the supervisor chose. Without this row the parent's trail
  // says nothing happened on the day someone re-dialled 812 of its contacts.
  'agency_campaign.retry_created',
  'agency_session.joined',
  'agency_session.left',
  'agency_session.break_started',
  'agency_session.break_cancelled',
  'agency_session.force_available',
  'agency_attempt.hung_up',
  'agency_disposition.created',
  // The bulk export of a campaign's attempts or roster is not gated behind a
  // permission of its own — the decision is that a second gate to keep aligned with `agency.supervise` is a second gate to
  // drift, and that attribution answers the exposure instead. These two actions
  // ARE that attribution: without them the decision has nothing behind it.
  'agency_attempts.exported',
  'agency_contacts.exported',
  'agency_campaign_agent.assigned',
  'agency_campaign_agent.unassigned',
  'dnc_entry.created',
  'dnc_entry.deleted',
  // ── Membership invitations ─────────────────────────────────────────────────
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
 * WHAT KIND of principal performed an audited action.
 *
 * A third axis alongside the action and the resource type, and the one that
 * makes `user_id` mean what it reads as: `user_id` is written only when a person
 * performed the action.
 *
 *  - `human` — a signed-in user. `user_id` is set and is the actor.
 *  - `system` — a background write with no caller at all. Distinct from a
 *    person, and a NULL actor must not stand in for it: a NULL would conflate
 *    "genuinely automatic" with "attribution lost".
 *
 * There is no value for "unknown". A NULL `actor_type` is that absence: reading
 * a missing value as a real one is the defect above, and adding an `unknown`
 * member would invite a call site to write it deliberately. Nothing in `src/` may stamp NULL
 * — the field is required on `CreateAuditLogInput`.
 */
export const PLATFORM_AUDIT_ACTOR_TYPES = ['human', 'system'] as const;

export type PlatformAuditActorType = (typeof PLATFORM_AUDIT_ACTOR_TYPES)[number];
