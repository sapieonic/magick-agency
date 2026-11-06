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
  // Contact assignment (CA10): the campaign's `assignment_mode` changed (only while draft
  // or paused). Written by the public PATCH route on success only; `details` carry
  // `{ campaign_id, from, to }`. Sending the stored mode again is not a change.
  'agency_campaign.assignment_mode_changed',
  // A campaign's configuration changed (IN8). Written by the public PATCH route on
  // success, one row per PATCH that changed anything; `details` carry `{ campaign_id,
  // fields, changes }`: every changed field's name, and `{ from, to }` for the small
  // ones (scalars, short lists). JSON fields (retry policy, catalog) are names only.
  'agency_campaign.config_changed',
  // The roster upload (IN8, `agency/agency-ingest-audit.ts`): a committed upload job was
  // created (the uploader; details: job, file name, mode, duplicate rule), and it ended
  // (the system actor; details: status, rows read, accepted, rejected, duplicates, error
  // code). `_failed` covers a cancelled job too (`details.status`). A dry run writes none.
  'agency_campaign.roster_upload_started',
  'agency_campaign.roster_upload_completed',
  'agency_campaign.roster_upload_failed',
  // The roster-clear route retired the roster, or could not confirm whether it had
  // (`details.roster_state`). Only reachable with `AGENCY_ROSTER_REPLACE_ENABLED` (B15).
  'agency_campaign.roster_cleared',
  'agency_session.joined',
  'agency_session.left',
  'agency_session.break_started',
  'agency_session.break_cancelled',
  'agency_session.force_available',
  // The soft phone's switch from a campaign session and back (docs/softphone.md §4.2,
  // SP7). Their own actions rather than `break_started` / `left`: the switch is entered
  // only through the soft-phone routes, and a supervisor reading the campaign's trail is
  // asking "when was this agent off the campaign, dialling by hand" — `details` carries
  // the from-state and whether the start was queued behind a call or wrap-up.
  'agency_session.softphone_started',
  'agency_session.softphone_ended',
  'agency_attempt.hung_up',
  // Wrap-up redial: the agent redialled the customer from wrap-up (`wrapup-redial.ts`).
  'agency_attempt.redialed',
  'agency_disposition.created',
  // The bulk export of a campaign's attempts or roster is not gated behind a
  // permission of its own — the decision is that a second gate to keep aligned with `agency.supervise` is a second gate to
  // drift, and that attribution answers the exposure instead. These two actions
  // ARE that attribution: without them the decision has nothing behind it.
  'agency_attempts.exported',
  'agency_contacts.exported',
  // Contact assignment (CA5): due callbacks whose owner stayed away past the campaign's grace
  // went to the pool. One row per sweep batch (the system actor); the per-contact moves are in
  // `agency_contact_assignment_events` under the same `batch_id`.
  'agency_contacts.callback_fallback',
  'agency_campaign_agent.assigned',
  'agency_campaign_agent.unassigned',
  // ── Contact assignment ─────────────────────────────────────────────────────
  // One row per committed operation (details: batch_id, kind, moved, skipped_live, to_pool,
  // per_agent; the per-contact history rows carry the same batch_id), and one per campaign
  // where an unstaffed agent held contacts (moved to the pool, or `kept: true`).
  'agency_contacts.assigned',
  'agency_contacts.unassigned_on_unstaff',
  // ── Dedicated caller IDs (decision DN10) ──────────────────────────────────────────
  // A supervisor dedicated one of the campaign's caller IDs to an agent (`details`:
  // campaign_id, user_id, caller_id, previous_caller_id), or the dedication was released
  // (`details`: campaign_id, user_id, caller_id, cause: `supervisor` | `unstaff`). Ids and the
  // number only.
  'agency_campaign.agent_caller_id_set',
  'agency_campaign.agent_caller_id_cleared',
  // ── Contact assignment: the agent's own contacts (decision CA12) ─────────────────────
  // An agent reopened their not-reached contacts into their queue (one row per request that
  // reopened any; `details`: campaign, counts). And an agent dialled one of their contacts
  // themselves (one row per dial; `details`: the attempt, the session, what it spent).
  'agency_contacts.agent_retry_reopened',
  'agency_contact.agent_dialed',
  // ── The soft phone (docs/softphone.md §6) ─────────────────────────────────
  // One row per soft-phone dial and per act on it. The two overrides are rows of
  // their own beside `placed` (SP1, SP2): a dial placed THROUGH a DNC hit or a closed
  // calling window is the compliance question, and its `details` carry the agent's
  // note (and, for DNC, the `dnc_entries` id it overrode), so the answer does not
  // depend on the call row outliving its retention.
  'agency_manual_call.placed',
  'agency_manual_call.dnc_overridden',
  'agency_manual_call.hours_overridden',
  'agency_manual_call.hung_up',
  'agency_manual_call.dispositioned',
  'agency_manual_call.dnc_marked',
  // The account's soft-phone settings (`PUT /softphone/settings`): the untagged
  // outcome catalog, the call fields, recording, the summary profile, the default
  // caller ID. Account-wide, never campaign-scoped.
  'agency_softphone_settings.updated',
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
  // A tenant admin added an account to the tenant (`POST /accounts`). Filed under
  // the NEW account (`account_id`, `resource_id`), so its own trail opens with its
  // creation; `details` carry `{ name, slug }`. An account a super admin creates is
  // recorded in `super_admin_audit_log` (`create_account`), not here.
  'account.created',
] as const;

export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export const PLATFORM_AUDIT_RESOURCE_TYPES = [
  'agency_campaign',
  'agency_session',
  'agency_attempt',
  'agency_disposition',
  'agency_campaign_agent',
  // One roster contact (`agency_contacts.id`): an agent's dial of one of their own contacts.
  'agency_contact',
  // One soft-phone dial (`agency_manual_calls.id`), and the account's soft-phone
  // settings row (`resource_id` is absent: one row per account, named by it).
  'agency_manual_call',
  'agency_softphone_settings',
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
  // An account of the tenant (`accounts.id`).
  'account',
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
