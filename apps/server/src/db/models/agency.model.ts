// ─── Agency dialer — execution-side row shapes ──────────────────────────────
//
// Persisted shapes for the agency tables. The wire shapes live in
// src/agency/contracts.ts and are frozen; these are internal and may change.
// State vocabularies are imported from the contract rather than re-declared, so
// a DB state and a wire state can never drift apart.

import type {
  AgencyAbandonReason,
  AgencyAgentState,
  AgencyAttemptOutcome,
  AgencyAttemptState,
  AgencyCampaignStatus,
  AgencyContactState,
  AgencyBreakReason,
  AgencyContextDisplay,
  AgencyDisposition,
} from '@magick-agency/contracts/agency';

/**
 * Retry policy keyed by outcome. No `machine` key — AMD is out.
 *
 * ── READ THIS BEFORE CHANGING HOW REAPED ATTEMPTS ARE RETRIED ────────────────
 *
 * **1. `orphaned` is not uniformly "never happened", and the distinction is a
 * customer-facing one.** The reaper sweeps attempts in `ringing`, `answered` and
 * `bridged` as well as `queued`/`dialing`, so a contact carrying
 * `last_outcome: 'orphaned'` may have had their phone ring — or may have held a
 * conversation — before our process died. Reaping overwrites `state`, but
 * `dialed_at`, `answered_at` and `bridged_at` **survive on the attempt row**. Use
 * them: charging a contact an attempt for a dial that never left the building is
 * unfair, and *sparing* one whose phone actually rang means calling a real person
 * more often than `max_attempts` permits.
 *
 * **2. `agency_contacts.attempt_count` is the retry budget and NOTHING else.** It
 * is deliberately **not** bumped by the reaper, because our crash must not consume
 * a customer's retry allowance — with `max_attempts: 3`, three restarts would
 * otherwise exhaust a contact and mark them `exhausted` having never been spoken
 * to. It is also no longer the source of `attempt_number`: that is derived from
 * `MAX(attempt_number)` over the attempts table (see `AgencyAttemptRepository.create`).
 * Conflating those two jobs made every reaper-recovered contact permanently
 * undialable while looking healthy. If a numbering problem ever
 * tempts you to bump this on recovery, that is the bug coming back.
 *
 * **3. A `null` outcome is possible** and is not the same as `failed`: an attempt
 * can end before it was ever classified. Key the policy defensively.
 */
export type AgencyRetryPolicy = Partial<
  Record<AgencyAttemptOutcome, { delay_minutes?: number; max_attempts: number }>
>;

export interface AgencyCampaignRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  name: string;
  caller_ids: string[];
  telephony_provider: string;
  calling_window_start: string;
  calling_window_end: string;
  calling_days: number[];
  default_timezone: string;
  wrapup_seconds: number;
  /**
   * Announcement played to an abandoned call before hangup.
   * NULL = hang up without a clip; the attempt is still recorded
   * `abandoned` and still counted against the rate either way.
   *
   * No FK, so a deleted announcement leaves a dangling id — the resolver treats
   * "not found" exactly as it treats NULL rather than failing the call.
   */
  abandon_announcement_id: string | null;
  wrapup_auto_return: boolean;
  retry_policy: AgencyRetryPolicy;
  disposition_catalog: AgencyDisposition[];
  /** Operator-configured break codes. Empty ⇒ `DEFAULT_BREAK_REASONS`. */
  break_reasons: AgencyBreakReason[];
  context_display: AgencyContextDisplay;
  record_calls: boolean;
  analysis_profile_id: string | null;
  status: AgencyCampaignStatus;
  /**
   * Rolling-24h abandonment rate at which this campaign auto-pauses, as a
   * percentage. Defaults to
   * `DEFAULT_ABANDONMENT_CEILING_PCT`, which is the column's DEFAULT.
   *
   * `double precision`, not `numeric`, so this is genuinely a `number` — the driver
   * would otherwise hand back a string.
   */
  abandonment_ceiling_pct: number;
  /**
   * Why the campaign is currently paused, or NULL when it is not paused.
   *
   * Only two values are writable (CHECK-constrained): `supervisor` and
   * `abandonment_ceiling`. The WS enum's `auto_paused` is deliberately absent —
   * its two emit sites are transient broadcasts that write no row.
   */
  pause_reason: 'supervisor' | 'abandonment_ceiling' | null;
  /** When the current pause began. Cleared on resume/start. */
  paused_at: Date | null;
  /**
   * The abandonment rate as measured at the instant of an auto-pause, frozen.
   * NULL for a supervisor pause.
   *
   * Never recomputed: the campaign stays paused while its 24h
   * window keeps sliding, so a live re-read would eventually render "2.1% is
   * over your 3% limit". The evidence is frozen with the decision that used it.
   */
  pause_abandonment_rate_pct: number | null;
  contacts_total: number;
  created_by: string | null;
  /**
   * The FIRST transition into `running`, ever. NULL = never started.
   *
   * **First-write-wins, enforced in SQL** (`transitionStatus` writes
   * `COALESCE(started_at, now())`), which is the point: were the routes to pass `new Date()` on
   * both `/start` AND `/resume` with `COALESCE($n, started_at)` — new value first —
   * every resume would overwrite it. A campaign paused for lunch
   * and resumed would then report a start time of 14:05 on a run that began at
   * 09:00, and the elapsed-time reading the console draws from it would be short by
   * however long the campaign had been running.
   *
   * The invariant now lives in the one statement that moves a status rather than
   * in what four call sites remember to pass, so a fifth transition route cannot
   * reintroduce it.
   */
  started_at: Date | null;
  /**
   * Entry into a TERMINAL status (`completed` or `stopped`). NULL = still live.
   *
   * It supersedes {@link completed_at} — same instant, honest
   * name. Both are written by the same CASE in the same UPDATE so they cannot
   * drift; `completed_at` is retained only because it is already on the wire.
   */
  ended_at: Date | null;
  /**
   * LEGACY spelling of {@link ended_at}. Same value, always.
   *
   * Kept rather than dropped for the reason `agency_contacts.source_row_number`
   * is kept: it is served on a payload the console already read
   * before `ended_at` existed, and removing a field from a shipped response is a
   * breaking change.
   * It is also MISNAMED — it is stamped for `stopped` as well as `completed`, so
   * it says "completed" about a campaign a supervisor stopped, which is the defect
   * `ended_at` fixes. Read `ended_at`; this exists so nothing breaks on the way
   * there.
   */
  completed_at: Date | null;
  /**
   * The `users.id` of whoever caused the CURRENT status, or NULL. No FK: opaque
   * to the dialer tables.
   *
   * Written UNCONDITIONALLY by every transition — never COALESCE'd — because the
   * question is about the current status and "leave whatever was there" is wrong
   * for all of them: a campaign auto-paused by the abandonment guardrail must not
   * keep reporting the supervisor who started it as the cause. Same rule, same
   * reasoning, as the `pause_reason`/`paused_at` pair beside it.
   *
   * NULL means "we do not know who" — see
   * {@link AgencyCampaignTransitionRequest} for the two ways that happens and why
   * they are not separated.
   */
  last_transition_by_user_id: string | null;
  /**
   * Their display name AS THE PUBLIC API LAYER KNEW IT at the transition, or NULL.
   *
   * A snapshot, never refreshed. NULL beside a non-null
   * `last_transition_by_user_id` is a real state — an id-only actor — not a
   * missing row. Both columns are folded into the wire's
   * `last_transition_by` object by `formatAgencyCampaignResponse`.
   */
  last_transition_by_name: string | null;
  /**
   * The campaign this one was retried FROM, or NULL when it is
   * not a retry.
   *
   * `ON DELETE SET NULL`, so a retry can outlive its parent — which is why
   * `retry_generation > 0` with a NULL here is a real state and the bootstrap's
   * `retry_context` has a placeholder name for it.
   */
  parent_campaign_id: string | null;
  /**
   * The FIRST campaign in this retry chain — a denormalised grouping key so the
   * lineage strip is one indexed read rather than a recursive walk.
   *
   * ⚠️ **NULL on every generation-0 campaign**, deliberately (stamping it would need a trigger or a backfill that restamps
   * `updated_at` on every row). Every reader must spell it
   * `COALESCE(root_campaign_id, id)`; reading it bare gives a chain of one for
   * every parent.
   */
  root_campaign_id: string | null;
  /** 0 = not a retry. Bounded at the route by `RETRY_MAX_GENERATION`, not by a CHECK. */
  retry_generation: number;
  /**
   * The contact filter that produced this campaign's roster, frozen as sent:
   * a RECORD, never re-executed. NULL when `retry_generation = 0`.
   *
   * Typed `unknown` rather than `AgencyRetrySelector` on purpose: the column is
   * JSONB and holds whatever a past release wrote, so a reader must narrow it
   * rather than being handed a promise the database cannot keep.
   */
  retry_selector: unknown | null;
  /**
   * The client-minted key that made this retry's creation at-most-once.
   * NULL on every ordinary campaign and on an unkeyed retry.
   *
   * **Internal. Never served.** It is declared here because the row genuinely
   * carries it — `SELECT *` and `RETURNING *` bring it back whether or not this
   * type admits it — and leaving it off the type does not keep it off the wire,
   * it only keeps the leak invisible to the compiler.
   * `formatAgencyCampaignResponse` strips it, and `AgencyCampaignResponse`
   * `Omit`s it so removing that strip is a build error rather than a quiet
   * disclosure. See that file for why an opaque replay token is not a campaign
   * field a client should be able to read back off `GET /:id`.
   */
  retry_idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The campaign columns that describe HOW it dials, as opposed to how its run went.
 *
 * Derived from {@link AgencyCampaignRecord} with a `Pick` rather than written out,
 * so a renamed column is a build error here instead of a field that silently stops
 * being inherited. It exists for the retry create, which copies exactly
 * this set from the parent and then applies `config_overrides` on top.
 *
 * **What is NOT in it is the whole point.** `status`, `started_at`, `ended_at`,
 * `completed_at`, `contacts_total`, `last_transition_by_*`, `pause_reason`,
 * `paused_at` and `pause_abandonment_rate_pct` all describe the PARENT'S RUN.
 * "Copy the config columns" applied naively would carry a stale auto-pause record
 * onto a campaign that has never dialled.
 */
export type AgencyCampaignConfigColumns = Pick<
  AgencyCampaignRecord,
  | 'caller_ids'
  | 'telephony_provider'
  | 'calling_window_start'
  | 'calling_window_end'
  | 'calling_days'
  | 'default_timezone'
  | 'wrapup_seconds'
  | 'wrapup_auto_return'
  | 'retry_policy'
  | 'disposition_catalog'
  | 'context_display'
  | 'break_reasons'
  | 'record_calls'
  | 'analysis_profile_id'
  | 'abandon_announcement_id'
  | 'abandonment_ceiling_pct'
>;

export interface AgencyContactRecord {
  id: string;
  campaign_id: string;
  tenant_id: string;
  account_id: string;
  phone_e164: string;
  context: Record<string, unknown>;
  /**
   * LEGACY — **no longer written**, NULL on every ingested row. Provenance is
   * `csv_line_number` because the unique index on
   * `(campaign_id, source_row_number)` (`uq_agency_contacts_source_row`) is
   * partial on NOT NULL and is still in the schema — so new rows leave it NULL
   * to sit outside it, which is what lets a second CSV top up a live campaign.
   * Do not reinstate a write.
   */
  source_row_number: number | null;
  /**
   * The row's line number in the uploaded CSV (`startLine` in `agency-csv-ingest.ts`) —
   * provenance for an operator tracing a contact back to its file line, and
   * nothing else. Never indexed and never an identity: that is `row_fingerprint`.
   * NULL when no file line is known.
   */
  csv_line_number: number | null;
  /**
   * Content identity of the row — md5 of phone + context +
   * timezone, computed in SQL at ingest. This, not `source_row_number`, is the
   * ingest-replay guard: the row number is a position in ONE file, so keying on
   * it made a second CSV's lines collide with the first's and silently discarded
   * every top-up. NULL on rows with no fingerprint and on legacy rows whose
   * content was already ambiguous — those sit outside the unique index.
   */
  row_fingerprint: string | null;
  timezone: string | null;
  state: AgencyContactState;
  /** The CUSTOMER's retry allowance. Never spent on our own faults — see below. */
  attempt_count: number;
  /**
   * Redials caused by OUR faults: an agent's
   * station socket dropping before the call bridged, or the reaper requeueing an
   * attempt whose replica died. Bounded independently of `attempt_count` by
   * `OUR_FAULT_REDIAL_BOUND`, so our failures can neither retire a customer nor
   * redial one without limit.
   */
  our_fault_attempts: number;
  last_outcome: string | null;
  last_disposition: string | null;
  next_attempt_at: Date;
  suppressed_reason: string | null;
  /**
   * The parent campaign's roster row this one was copied from when a retry
   * campaign was created, or NULL for an ordinary ingested row.
   *
   * Provenance, one hop, `ON DELETE SET NULL`. **Do not walk it to build
   * history** — that read is on the dial hot path, which is what
   * {@link root_contact_id} exists to keep cheap.
   */
  source_contact_id: string | null;
  /**
   * The FIRST roster row in this contact's retry chain — its own id for every
   * ordinary contact, stamped by `trg_agency_contacts_root`.
   *
   * The agent panel's prior attempts are read as `WHERE root_contact_id = $1`
   * across the whole lineage. Carries no foreign key on purpose.
   */
  root_contact_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgencyAgentSessionRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  campaign_id: string;
  agent_user_id: string;
  state: AgencyAgentState;
  break_reason: string | null;
  state_since: Date;
  owner_replica: string | null;
  last_heartbeat: Date;
  joined_at: Date;
  left_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgencyCallAttemptRecord {
  id: string;
  campaign_id: string;
  contact_id: string;
  tenant_id: string;
  account_id: string;
  attempt_number: number;
  webrtc_call_id: string | null;
  caller_id: string;
  reserved_agent_id: string | null;
  state: AgencyAttemptState;
  outcome: AgencyAttemptOutcome | null;
  disposition_code: string | null;
  notes: string | null;
  callback_at: Date | null;
  /**
   * The `users.id` of whoever recorded the disposition.
   *
   * Deliberately not the same fact as `reserved_agent_id`, which is a *session*
   * id for whoever was on the call. A supervisor writing up an agent's call sets
   * this and leaves that alone, so the conversation stays attributed to the agent
   * who had it while the write-up is attributed to whoever made it.
   */
  dispositioned_by_user_id: string | null;
  dispositioned_at: Date | null;
  /** True when the public API layer asserted `on_behalf` — step 3 of `checkActor`'s ownership rule. */
  dispositioned_on_behalf: boolean;
  dialed_at: Date | null;
  answered_at: Date | null;
  bridged_at: Date | null;
  ended_at: Date | null;
  talk_seconds: number | null;
  /** The wrap-up window OWED, copied from campaign config at wrap-up entry. */
  wrapup_seconds: number | null;
  /** When wrap-up actually began — never inferred from `ended_at`. */
  wrapup_started_at: Date | null;
  /** When it actually ended; NULL = never concluded on a seen path. */
  wrapup_ended_at: Date | null;
  /** A `WrapupResolution`; only three of the six feed the average. */
  wrapup_resolution: string | null;
  /**
   * Why an abandoned attempt reached no agent.
   *
   * NULL means **not an abandoned attempt**, not "cause unknown" — so this is
   * never a substitute for `ABANDONED_ATTEMPT_PREDICATE_SQL`, which is the
   * ratified definition and deliberately catches attempts nobody labelled.
   */
  abandon_reason: AgencyAbandonReason | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * An attempt whose wrap-up lapsed with no disposition, joined to the two pieces
 * of campaign config the sweep must consult.
 *
 * The catalog and the policy are carried on the row rather than re-fetched per
 * attempt because both decisions — *was* a disposition owed, and what happens to
 * the contact now — belong to the campaign as it is configured, and one join is
 * cheaper than N lookups on a sweep that may see hundreds of rows.
 */
export interface AgencyLapsedWrapupRow extends AgencyCallAttemptRecord {
  campaign_disposition_catalog: AgencyDisposition[] | null;
  campaign_retry_policy: AgencyRetryPolicy | null;
  /**
   * The CONTACT's retry budget (`agency_contacts.attempt_count`), which is what the
   * outcome policy is evaluated against — never the attempt's own `attempt_number`.
   * The two are decoupled on purpose: `attempt_number` is derived from the
   * attempts table, so `attempt_count` is purely the budget.
   */
  contact_attempt_count: number;
}

/** One accepted row of a roster-ingest chunk. */
export interface AgencyContactInput {
  phone_e164: string;
  context?: Record<string, unknown>;
  source_row_number?: number | null;
  timezone?: string | null;
}

/** Non-terminal attempt states — what the reaper and the tick both key off. */
export const AGENCY_ATTEMPT_LIVE_STATES: readonly AgencyAttemptState[] = [
  'queued',
  'dialing',
  'ringing',
  'answered',
  'bridged',
];

/**
 * Campaign statuses from which nothing further will ever be dialed.
 *
 * Read off the transition graph in `agency-campaigns.routes.ts`, not off a
 * feeling about the words: `start` accepts `draft`/`paused`, `resume` accepts
 * `paused`, `stop` accepts `running`/`paused` — and NOTHING accepts `completed`
 * or `stopped`. Those two are one-way doors, so whatever config they still point
 * at is a record of how their calls were run, not a dependency on anything.
 *
 * ── Why the TERMINAL set and not the live one ──────────────────────────────
 *
 * The only consumer is a guard (`findLiveDependentsOnAnalysisProfile`), and a
 * guard should fail closed. Written as `NOT (status = ANY(terminal))`, a status
 * added to `AgencyCampaignStatus` tomorrow counts as live and the guard keeps
 * covering it until someone deliberately declares it terminal here. Written as
 * the live list, the same addition would silently fall out of coverage — the
 * quiet direction, and the wrong one for a check whose whole purpose is to stop
 * something breaking quietly.
 *
 * `draft` is deliberately live. Its reference has not been used yet, which makes
 * breaking it worse rather than better: the campaign fails the first time
 * somebody presses start, long after the edit that caused it.
 */
export const AGENCY_CAMPAIGN_TERMINAL_STATUSES: readonly AgencyCampaignStatus[] = [
  'completed',
  'stopped',
];

/**
 * A campaign that depends on some shared primitive.
 *
 * **Deliberately id + status and NOT `name`.** This shape crosses into the
 * `profile_in_use_by_agency_campaign` refusal body on the analysis-profile
 * routes, and campaign names are operator-authored text that discloses the
 * agency's clients and offers. The console resolves names through the campaign
 * routes.
 *
 * Status is included because it carries the severity — "it is running" and "it is
 * still a draft" call for different responses — and is a closed enum rather than
 * operator-authored text.
 *
 * **What crosses, stated exactly.** The id crosses: the refusal hands its
 * reader a UUID per dependent campaign. The judgement is that this is
 * acceptable and worth it: an opaque id discloses
 * that N campaigns exist and nothing about them, which the refusal's own count has
 * already disclosed; a name discloses the agency's clients and offers. And without
 * the ids the refusal has no remedy for a console that IS entitled to resolve
 * them. If a future reader needs the boundary tighter than that, the field to drop
 * is `id`, and the cost is that "which campaigns" becomes unanswerable from the
 * error.
 */
export interface AgencyCampaignDependent {
  id: string;
  status: AgencyCampaignStatus;
}
