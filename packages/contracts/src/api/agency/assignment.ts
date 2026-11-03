/**
 * Contact assignment, the agent's own contacts and agent-led retry: console wire types.
 *
 * The public API layer serves every route here itself (repositories, no internal handler), so
 * these shapes have no dialer-contract twin and no `CONTRACT-DIFF.md` entry. Vocabularies that
 * the dialer runtime also reads (the assignment mode, the override kinds, the queue frame) are
 * declared in the dialer contract and re-exported.
 *
 * Routes (all under `/proxy/agency`, all behind the `agency_contact_assignment_enabled` flag,
 * which answers `403 assignment_disabled` when off):
 *
 * Supervisor (`agency.supervise`, campaign in the caller's tenant and account):
 *  - `POST /campaigns/:id/assignments/preview`  {@link AgencyAssignmentOperation} → {@link AgencyAssignmentPreview}
 *  - `POST /campaigns/:id/assignments`          {@link AgencyAssignmentCommitRequest} → {@link AgencyAssignmentResult}
 *  - `GET  /campaigns/:id/assignments/progress` → {@link AgencyAssignmentProgress}
 *  - `GET  /campaigns/:id/contacts/:contactId/assignments` → {@link AgencyAssignmentHistory}
 *
 * Agent (`agency.contacts.own`; the subject is always the caller, never a parameter):
 *  - `GET  /my-contacts/summary?campaign_id=`   → {@link AgencyMyContactsSummary}
 *  - `GET  /my-contacts?campaign_id=&bucket=&phone=&cursor=&limit=` → `AgencyKeysetPage<AgencyMyContact>`
 *  - `POST /my-contacts/retry`                  {@link AgencyAgentRetryRequest} → {@link AgencyAgentRetryResponse}
 *  - `POST /my-contacts/:contactId/call`        {@link AgencyMyContactCallRequest} → {@link AgencyMyContactCallResponse}
 *
 * The agent's contact reads return only contacts assigned to the caller on a campaign they are
 * staffed on, enforced by the server (a contact of another agent is the same 404 as a missing
 * one). A supervisor reads every contact through the roster routes.
 */

import type {
  AgencyAssignmentMode,
  AgencyAssignmentReason,
  AgencyContactState,
  AgencyOverrideKind,
  AgencyQueueState,
} from '../../agency';
import type { AllListed } from '../../primitives';

export type {
  AgencyAssignmentMode,
  AgencyAssignmentReason,
  AgencyCallbackFallback,
  AgencyDispositionOverride,
  AgencyOnUnstaff,
  AgencyOverrideKind,
} from '../../agency';

// ─── Supervisor: assignment operations ──────────────────────────────────────

/**
 * The supervisor's assignment operations. Every one is set-based on the server: the client
 * names a rule, never a million ids (only `range` carries ids, at most
 * {@link AGENCY_ASSIGNMENT_RANGE_MAX}).
 *
 * Common rules, applied to every kind:
 *  - only agents with an active staffing row on the campaign can receive contacts
 *    (`agent_not_staffed`);
 *  - a contact that is `in_flight` or `connected` (on a call, or parked for its write-up) is
 *    never moved: it is counted in `skipped_live`;
 *  - `group_same_number` (default `true`) keeps every contact with the same normalised number
 *    with one agent: a group moves as a whole, to the agent its first contact goes to;
 *  - a contact already with its target is `unchanged`, not moved, and gets no history row.
 */
export type AgencyAssignmentOperation =
  | AgencyAssignmentRandomSplit
  | AgencyAssignmentCount
  | AgencyAssignmentByFilter
  | AgencyAssignmentRange
  | AgencyAssignmentReassign
  | AgencyAssignmentUnassign
  | AgencyAssignmentRebalance;

export type AgencyAssignmentKind = AgencyAssignmentOperation['kind'];
export const AGENCY_ASSIGNMENT_KINDS = [
  'random_split',
  'count',
  'filter',
  'range',
  'reassign',
  'unassign',
  'rebalance',
] as const;

/** At most this many ids in one `range` operation (a few visible pages). */
export const AGENCY_ASSIGNMENT_RANGE_MAX = 500;

interface AgencyAssignmentGrouping {
  /** Keep contacts with the same normalised number with one agent. Default `true`. */
  group_same_number?: boolean;
}

/**
 * Split contacts evenly at random across `agent_user_ids`. The order is a hash of each contact
 * (or number group) with `seed`, so a preview and its commit with the same seed pick the same
 * split. `seed` absent on a preview: the server picks one and returns it; the commit sends it back.
 */
export interface AgencyAssignmentRandomSplit extends AgencyAssignmentGrouping {
  kind: 'random_split';
  agent_user_ids: string[];
  /** Only contacts in the pool (default `true`); `false` re-splits owned open contacts too. */
  only_unassigned?: boolean;
  seed?: string;
}

/** The next `count` unassigned contacts, in roster order (upload order), to one agent. */
export interface AgencyAssignmentCount extends AgencyAssignmentGrouping {
  kind: 'count';
  agent_user_id: string;
  count: number;
}

/**
 * The contacts matching `filter` to one agent, or split evenly at random across several
 * (as {@link AgencyAssignmentRandomSplit}, with `seed`).
 */
export interface AgencyAssignmentByFilter extends AgencyAssignmentGrouping {
  kind: 'filter';
  agent_user_ids: string[];
  filter: AgencyAssignmentContactFilter;
  /** Only contacts in the pool (default `true`). */
  only_unassigned?: boolean;
  seed?: string;
}

/** What a `filter` operation selects. Every given part must match (AND); at least one part is set. */
export interface AgencyAssignmentContactFilter {
  states?: AgencyContactState[];
  last_dispositions?: string[];
  /**
   * A roster column (an uploaded CSV header, as stored in the contact's context) and the values
   * it must equal, exactly, after trimming. E.g. `{ name: 'Region', values: ['North', 'East'] }`.
   */
  column?: { name: string; values: string[] };
}

/** Selected rows (the visible page or pages) to one agent. */
export interface AgencyAssignmentRange extends AgencyAssignmentGrouping {
  kind: 'range';
  agent_user_id: string;
  /** 1..{@link AGENCY_ASSIGNMENT_RANGE_MAX} contact ids of this campaign. */
  contact_ids: string[];
}

/** One agent's open contacts (all, or the first `count` in roster order) to another agent. */
export interface AgencyAssignmentReassign extends AgencyAssignmentGrouping {
  kind: 'reassign';
  from_user_id: string;
  to_user_id: string;
  count?: number;
}

/**
 * Back to the pool: one agent's open contacts (`from_user_id`, optionally the first `count`), or
 * the given contacts (`contact_ids`). Exactly one of `from_user_id` / `contact_ids`.
 */
export interface AgencyAssignmentUnassign extends AgencyAssignmentGrouping {
  kind: 'unassign';
  from_user_id?: string;
  count?: number;
  contact_ids?: string[];
}

/**
 * Even out the backlog across `agent_user_ids`: open, never-attempted contacts move from the
 * agents holding more than the average to those holding less, until every backlog is within one
 * of the average. Contacts already attempted (and callbacks) stay with their agent.
 */
export interface AgencyAssignmentRebalance extends AgencyAssignmentGrouping {
  kind: 'rebalance';
  agent_user_ids: string[];
}

/** One agent's line in a preview or a result. */
export interface AgencyAssignmentAgentDelta {
  agent_user_id: string;
  /** Contacts this agent receives. */
  receiving: number;
  /** Contacts this agent gives up (to another agent or the pool). */
  giving: number;
}

/**
 * What an operation would do, computed on the server against the roster as it is now. Nothing
 * is written.
 */
export interface AgencyAssignmentPreview {
  kind: AgencyAssignmentKind;
  /**
   * Pass back on the commit. The commit recomputes the operation and refuses `409
   * preview_stale` (with the fresh preview in `preview`) when the result would differ from
   * this one, so a supervisor never commits a split they did not see.
   */
  preview_token: string;
  /** The seed the random order used (`random_split`, multi-agent `filter`); null otherwise. */
  seed: string | null;
  /** Contacts the operation selected. */
  matched: number;
  /** Contacts that would change owner. */
  moving: number;
  /** Selected contacts on a call or awaiting a write-up: never moved. */
  skipped_live: number;
  /** Selected contacts already with their target. */
  unchanged: number;
  /** Contacts that would go to the pool. */
  to_pool: number;
  per_agent: AgencyAssignmentAgentDelta[];
  /** Numbers held by more than one selected contact, kept with one agent. */
  same_number_groups: number;
}

export interface AgencyAssignmentCommitRequest {
  operation: AgencyAssignmentOperation;
  preview_token: string;
}

/** A committed operation: one audit row (with `batch_id`) and one history row per moved contact. */
export interface AgencyAssignmentResult {
  kind: AgencyAssignmentKind;
  batch_id: string;
  moved: number;
  skipped_live: number;
  unchanged: number;
  to_pool: number;
  per_agent: AgencyAssignmentAgentDelta[];
}

/** `409 preview_stale`: the roster changed since the preview; here is the fresh one. */
export interface AgencyAssignmentStaleRefusal extends AgencyAssignmentErrorResponse {
  code: 'preview_stale';
  preview: AgencyAssignmentPreview;
}

// ─── Supervisor: progress per agent ─────────────────────────────────────────

/**
 * Where a contact stands from its owner's point of view. One definition, used by the agent's
 * list and counts and by the supervisor's progress, so the two always agree:
 *
 *  - `pending`: open, never attempted, not a callback;
 *  - `callback`: open, its last outcome booked a callback (an outcome with `requires_datetime`);
 *  - `not_reached`: open, attempted, scheduled for another try (no answer, busy, failed, a
 *    voicemail outcome that retries, ...);
 *  - `in_progress`: on a call or awaiting its write-up (`in_flight`, `connected`);
 *  - `reached`: done (`completed`);
 *  - `exhausted`: the retry policy's attempts are spent;
 *  - `suppressed`: DNC or otherwise suppressed; never dialled again.
 */
export type AgencyMyContactBucket =
  | 'pending'
  | 'callback'
  | 'not_reached'
  | 'in_progress'
  | 'reached'
  | 'exhausted'
  | 'suppressed';
export const AGENCY_MY_CONTACT_BUCKETS = [
  'pending',
  'callback',
  'not_reached',
  'in_progress',
  'reached',
  'exhausted',
  'suppressed',
] as const;

export type AgencyContactBucketCounts = Record<AgencyMyContactBucket, number>;

/** One agent's progress on a campaign. */
export interface AgencyAssignmentProgressRow {
  agent_user_id: string;
  /** Display name, or null for a user who no longer exists (a former member). */
  agent_name: string | null;
  /** Has an active staffing row on the campaign. */
  staffed: boolean;
  /** Has a live session on the campaign now. */
  live: boolean;
  /** ISO-8601: when the agent was last seen on the campaign (heartbeat or leave); null if never. */
  last_seen_at: string | null;
  /** Contacts assigned to this agent. */
  assigned: number;
  counts: AgencyContactBucketCounts;
  /** Assigned contacts attempted at least once. */
  attempted: number;
  /** Open contacts due now. */
  due_now: number;
  /** ISO-8601 of the latest attempt on one of this agent's contacts; null if none. */
  last_activity_at: string | null;
  /**
   * Contacts due now while this agent has been away (no live session) for more than
   * `absent_after_minutes`: the supervisor's cue to reassign them. 0 when present.
   */
  due_while_absent: number;
}

export interface AgencyAssignmentProgress {
  campaign_id: string;
  assignment_mode: AgencyAssignmentMode;
  /** One row per agent who is staffed or holds at least one contact. */
  agents: AgencyAssignmentProgressRow[];
  /** The shared pool (no owner). In strict mode its open contacts are never dialled. */
  pool: { total: number; counts: AgencyContactBucketCounts; due_now: number };
  /** In strict mode: open pool contacts, which block completion until they are assigned. */
  unassigned_open: number;
  /** The absence threshold behind `due_while_absent`, in minutes. */
  absent_after_minutes: number;
  generated_at: string;
}

/** The absence threshold the progress read uses unless `?absent_after_minutes=` says otherwise. */
export const AGENCY_ASSIGNMENT_ABSENT_AFTER_MINUTES = 15;

/** One owner change of a contact. */
export interface AgencyAssignmentEvent {
  id: string;
  from_user_id: string | null;
  to_user_id: string | null;
  /** Null: the system (an unstaff, a callback fallback, ...). */
  actor_user_id: string | null;
  reason: AgencyAssignmentReason;
  batch_id: string;
  created_at: string;
}

/** Who held a contact and when, newest first (at most 200 rows). */
export interface AgencyAssignmentHistory {
  contact_id: string;
  events: AgencyAssignmentEvent[];
}

// ─── Agent: my contacts ─────────────────────────────────────────────────────

/** The override an outcome granted on a contact and what is left of it. */
export interface AgencyContactOverride {
  /** The outcome code that granted it. */
  disposition: string;
  extra_attempts: number;
  retry_delay: boolean;
  calling_hours: boolean;
  granted_at: string;
}

/**
 * Why a contact cannot be retried by its agent now:
 *  - `retry_disabled`: the campaign does not allow agent retry;
 *  - `not_retryable`: not a contact that was not reached (it is pending, reached, on a call, ...);
 *  - `rounds_used`: the agent already reopened it `agent_retry_rounds` times;
 *  - `cooldown`: its last attempt is more recent than `agent_retry_cooldown_minutes`
 *    (`available_at` says when);
 *  - `suppressed`: DNC or suppressed; never.
 */
export type AgencyAgentRetryBlock = 'retry_disabled' | 'not_retryable' | 'rounds_used' | 'cooldown' | 'suppressed';
export const AGENCY_AGENT_RETRY_BLOCKS = [
  'retry_disabled',
  'not_retryable',
  'rounds_used',
  'cooldown',
  'suppressed',
] as const;

/** One of the caller's contacts. */
export interface AgencyMyContact {
  id: string;
  campaign_id: string;
  phone_e164: string;
  bucket: AgencyMyContactBucket;
  state: AgencyContactState;
  attempt_count: number;
  last_outcome: string | null;
  last_disposition: string | null;
  /** ISO-8601: when it falls due (for a callback, the booked time). */
  next_attempt_at: string;
  /** ISO-8601: the latest attempt on it, or null if never attempted. */
  last_attempt_at: string | null;
  /**
   * The campaign's hero columns (`context_display.hero`) for this contact, in order, minus
   * hidden ones: what the agent recognises a customer by.
   */
  hero: Array<{ name: string; value: string }>;
  retry: {
    /** Can be retried now, through pacing or by calling it. */
    eligible: boolean;
    /** Why not, when not eligible. */
    blocked: AgencyAgentRetryBlock | null;
    rounds_used: number;
    /** ISO-8601: when the cooldown ends (`blocked: 'cooldown'`); null otherwise. */
    available_at: string | null;
  };
  /** An override granted by an outcome and not yet spent, or null. */
  override: AgencyContactOverride | null;
}

/** The caller's contacts on one campaign, in counts. */
export interface AgencyMyContactsSummary {
  campaign_id: string;
  assignment_mode: AgencyAssignmentMode;
  /** Contacts assigned to the caller. */
  total: number;
  counts: AgencyContactBucketCounts;
  /** Open contacts due now. */
  due_now: number;
  /** The caller's queue: due now, or nothing due and why. */
  queue: AgencyQueueState;
  /** In strict mode, open contacts nobody owns (never dialled until a supervisor assigns them). */
  unassigned_open: number;
  retry: {
    allowed: boolean;
    rounds: number;
    cooldown_minutes: number;
    /** Contacts the caller can retry now ("Retry not reached (N)"). */
    eligible: number;
  };
}

/** `GET /my-contacts` query. `campaign_id` is required. */
export interface AgencyMyContactsQuery {
  campaign_id: string;
  bucket?: AgencyMyContactBucket[];
  /** Digits anywhere in the number, as the roster's phone search. */
  phone?: string;
  /** Text in any hero column. */
  q?: string;
  cursor?: string;
  limit?: number;
}

// ─── Agent: retry not reached ───────────────────────────────────────────────

/**
 * Reopen contacts the caller did not reach into their own queue, `pending` and due now; pacing
 * then dials them. `contact_ids` (at most {@link AGENCY_ASSIGNMENT_RANGE_MAX}) or `all: true`
 * (every eligible one). Each reopened contact spends one of its `agent_retry_rounds`. Audited.
 */
export interface AgencyAgentRetryRequest {
  campaign_id: string;
  contact_ids?: string[];
  all?: boolean;
}

export interface AgencyAgentRetryResponse {
  reopened: number;
  /** Contacts not reopened, and why (at most 50 listed; `skipped_total` counts them all). */
  skipped: Array<{ contact_id: string; blocked: AgencyAgentRetryBlock }>;
  skipped_total: number;
}

/**
 * Dial one of the caller's contacts now, on the campaign's normal path (an attempt row, the
 * campaign's caller IDs, recording, the outcome pad, wrap-up redial), from the caller's station
 * session, which must be `available` on that campaign. Allowed for a contact that is due (the
 * agent picks the order), and for a not-reached one the agent may retry (spending a round).
 * Calling-hours and DNC checks always apply: `override_note` is required only to spend a
 * `calling_hours` override outside the window. Audited.
 */
export interface AgencyMyContactCallRequest {
  campaign_id: string;
  session_id: string;
  /** {@link AGENCY_OVERRIDE_NOTE_MIN}–`MAX` characters; spends a calling-hours override. */
  override_note?: string;
}

export interface AgencyMyContactCallResponse {
  attempt_id: string;
  contact_id: string;
  /** Overrides this dial spent. */
  override_applied: AgencyOverrideKind[];
  /** Whether the dial spent one of the contact's agent retry rounds. */
  retry_round_spent: boolean;
}

// ─── Refusals ───────────────────────────────────────────────────────────────

/** Refusals of the supervisor's assignment routes ({@link AgencyAssignmentErrorResponse}). */
export type AgencyAssignmentErrorCode =
  /** 403. The `agency_contact_assignment_enabled` flag is off for this tenant / account. */
  | 'assignment_disabled'
  /** 400. The operation is malformed (`details` per field). */
  | 'assignment_invalid'
  /** 400. A target agent has no active staffing row on the campaign (`details.agent_user_ids`). */
  | 'agent_not_staffed'
  /** 409. The roster changed since the preview; the body carries the fresh preview. */
  | 'preview_stale'
  /** 409. `assignment_mode` changes only while the campaign is draft or paused. */
  | 'mode_change_requires_pause'
  /** 404. No such contact on this campaign (history read). */
  | 'contact_not_found';
export const AGENCY_ASSIGNMENT_ERROR_CODES = [
  'assignment_disabled',
  'assignment_invalid',
  'agent_not_staffed',
  'preview_stale',
  'mode_change_requires_pause',
  'contact_not_found',
] as const;

/** Refusals of the agent's own-contact routes ({@link AgencyAgentRetryErrorResponse}). */
export type AgencyAgentRetryErrorCode =
  /** 403. The flag is off. */
  | 'assignment_disabled'
  /** 403. The caller is not staffed on the campaign. */
  | 'not_staffed'
  /** 403. The campaign does not allow agent retry (`allow_agent_retry` off). */
  | 'agent_retry_disabled'
  /** 404. No such contact assigned to the caller on this campaign. */
  | 'contact_not_found'
  /** 409. The contact cannot be dialled or retried now (`details.blocked`: an {@link AgencyAgentRetryBlock}). */
  | 'contact_not_retryable'
  /** 409. The contact, or another contact on its number, is on a call. */
  | 'contact_in_flight'
  /** 409. The campaign is not running. */
  | 'campaign_not_running'
  /** 409. The session is not the caller's live `available` session on this campaign. */
  | 'agent_not_available'
  /** 409. The calling window is closed and no calling-hours override applies (`details.next_open_at`). */
  | 'outside_calling_hours'
  /** 400. The override note is missing or not 10–500 characters. */
  | 'override_note_invalid'
  /** 409. The number is on the DNC list. Never overridable. */
  | 'dnc_listed'
  /** 503. The DNC registry could not answer; nothing was dialled. */
  | 'dnc_unavailable'
  /** 409. The campaign has no usable caller ID. */
  | 'no_caller_id'
  /** 503. The caller's station is not connected on this server. */
  | 'no_station'
  /** 502. The dial could not be placed; the contact and the agent were returned. */
  | 'dial_failed';
export const AGENCY_AGENT_RETRY_ERROR_CODES = [
  'assignment_disabled',
  'not_staffed',
  'agent_retry_disabled',
  'contact_not_found',
  'contact_not_retryable',
  'contact_in_flight',
  'campaign_not_running',
  'agent_not_available',
  'outside_calling_hours',
  'override_note_invalid',
  'dnc_listed',
  'dnc_unavailable',
  'no_caller_id',
  'no_station',
  'dial_failed',
] as const;

/** A refusal body, as every agency refusal: a short title, the code, readable copy, details. */
export interface AgencyAssignmentErrorResponse {
  /** Short human title, e.g. `Conflict`. */
  error: string;
  code: AgencyAssignmentErrorCode;
  message: string;
  /** Per-field problems (`assignment_invalid`) or the offending ids (`agent_not_staffed`). */
  details?: Record<string, unknown>;
}

/** A refusal of the agent's own-contact routes. */
export interface AgencyAgentRetryErrorResponse {
  error: string;
  code: AgencyAgentRetryErrorCode;
  message: string;
  /**
   * `contact_not_retryable`: `{ blocked, available_at? }`. `outside_calling_hours`:
   * `{ next_open_at }`. `override_note_invalid`: `{ min, max }`.
   */
  details?: Record<string, unknown>;
}

// Each runtime list names its union exactly (two-sided; `test/assignment.test.ts` pins the order).
const _kindsListed: AllListed<AgencyAssignmentKind, typeof AGENCY_ASSIGNMENT_KINDS> = true;
const _bucketsListed: AllListed<AgencyMyContactBucket, typeof AGENCY_MY_CONTACT_BUCKETS> = true;
const _blocksListed: AllListed<AgencyAgentRetryBlock, typeof AGENCY_AGENT_RETRY_BLOCKS> = true;
const _assignmentCodesListed: AllListed<AgencyAssignmentErrorCode, typeof AGENCY_ASSIGNMENT_ERROR_CODES> = true;
const _retryCodesListed: AllListed<AgencyAgentRetryErrorCode, typeof AGENCY_AGENT_RETRY_ERROR_CODES> = true;
void [_kindsListed, _bucketsListed, _blocksListed, _assignmentCodesListed, _retryCodesListed];
