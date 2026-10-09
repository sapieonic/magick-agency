/**
 * The attempt spine — what the campaign did, and to whom (MAG-159).
 *
 * Deliberately NOT the audit trail (`agency-activity.ts`). That one answers
 * *who did what to the campaign*: Manas stopped it at 14:22. This one answers
 * *what the campaign did to whom*: we dialled this number four times and Ravi
 * marked it Not Interested. A compliance request asks the second question, and
 * until now the product had no surface for it at all.
 *
 * ── Where the numbers come from, and what is deliberately absent ────────────
 *
 * `context` — the contact's uploaded CSV columns — appears on
 * {@link AgencyContactDetail} and nowhere else. Master serves it only on the
 * single-contact route, so a list and an export cannot carry it by
 * construction. When rendering it, apply `AgencyContextDisplay.hidden` exactly
 * as the agent console does (`resolveContextFields`): the operator marked those
 * columns not-for-screen, and this screen has a wider audience than the one
 * that rule was written for.
 */

import type { AgencyAttemptOutcome, AgencyAttemptState } from './agency';

/**
 * Contact lifecycle, mirrored from core's `AgencyContactState` (migration 073).
 *
 * Declared here rather than in `types/agency.ts` because this is the first
 * surface that renders it: the station socket deals in attempts, not roster
 * rows, so the console never needed the contact's own state until the roster
 * became something a supervisor can read.
 */
export type AgencyContactState =
  | 'pending'
  | 'in_flight'
  | 'connected'
  | 'completed'
  | 'exhausted'
  | 'suppressed';

export interface AgencyAttempt {
  id: string;
  contact_id: string;
  /**
   * Which campaign this dial belonged to.
   *
   * Served on every attempt row, campaign-scoped reads included, and required
   * rather than optional — a row without it is unattributable on the one surface
   * that needs it most. `GET /proxy/agency/my-attempts` is CROSS-campaign by
   * design (it is the agent's whole dial history, which
   * `/campaigns/:id/attempts` structurally cannot be), so on that list the
   * campaign is not implied by the URL and has to travel with the row.
   *
   * Redundant on a campaign-scoped read, and kept there anyway: one row shape for
   * both readers beats a conditional field whose absence a consumer has to know
   * to expect.
   */
  campaign_id: string;
  /** 1-based, per contact. */
  attempt_number: number;
  phone_e164: string;
  caller_id: string;
  /**
   * The agent who held this attempt, as a user id.
   *
   * **`null` is ordinary and is not missing data**: an attempt that was
   * abandoned, failed or never answered had no agent on it. Render it as
   * "no agent", never as a gap.
   */
  agent_user_id: string | null;
  /**
   * The agent's display name, resolved by MASTER — core has no user table, so
   * it can only ever serve the id, and a column of UUIDs is not one a
   * supervisor can read.
   *
   * `null` means either "no agent was on this attempt" or "master could not
   * identify that id in this tenant". `agent_user_id` separates the two, which
   * is why both keys are always present. Optional here only because a master
   * older than this build does not send it.
   */
  agent_name?: string | null;
  reserved_agent_id: string | null;
  state: AgencyAttemptState;
  /** `null` means the attempt ended before it was ever classified. Not `failed`. */
  outcome: AgencyAttemptOutcome | null;
  disposition_code: string | null;
  /**
   * Agent-typed free text. Shown deliberately — see the MAG-159 PR — because it
   * is frequently the answer to "why was this number called four times". Always
   * rendered as TEXT, never as markup.
   */
  notes: string | null;
  callback_at: string | null;
  /** Who filed the write-up, which is not always who took the call. */
  dispositioned_by_user_id: string | null;
  dispositioned_at: string | null;
  dispositioned_on_behalf: boolean;
  /**
   * The media leg, for the recording.
   *
   * **A non-null id is NOT a promise the recording still exists.** Core keeps
   * this un-FK'd on purpose so an attempt outlives a purged call, so the link
   * must degrade to "recording no longer available" rather than 404.
   */
  webrtc_call_id: string | null;
  dialed_at: string | null;
  answered_at: string | null;
  bridged_at: string | null;
  ended_at: string | null;
  talk_seconds: number | null;
  wrapup_seconds: number | null;
  created_at: string;
}

export interface AgencyRosterContact {
  id: string;
  phone_e164: string;
  state: AgencyContactState;
  /** The customer's retry budget. Never spent on our own faults. */
  attempt_count: number;
  /** Redials caused by our faults, bounded independently of the budget. */
  our_fault_attempts: number;
  last_outcome: string | null;
  last_disposition: string | null;
  next_attempt_at: string;
  /** `dnc` | `invalid` | `max_attempts` | `manual`, or `null`. */
  suppressed_reason: string | null;
  timezone: string | null;
  /** The row's line in the uploaded CSV. `null` on older rows. */
  csv_line_number: number | null;
  created_at: string;
  updated_at: string;
}

/** One contact with its CSV columns — the drill-down, and the only shape with `context`. */
export interface AgencyContactDetail extends AgencyRosterContact {
  context: Record<string, unknown>;
}

/**
 * A keyset page.
 *
 * `next_cursor` is **opaque** — never parse it. There is deliberately no
 * `total`: counting a filtered set of up to a million rows costs a second scan
 * per page, for a number that is stale before it renders on a live campaign. So
 * the UI says "showing N" and offers "Load more", never "N of M".
 */
export interface AgencyKeysetPage<TRow> {
  rows: TRow[];
  next_cursor: string | null;
  limit: number;
}

export interface AgencyAttemptFilters {
  outcome?: string[];
  state?: string[];
  disposition_code?: string[];
  agent_user_id?: string;
  contact_id?: string;
  phone?: string;
  from?: string;
  to?: string;
}

export interface AgencyContactFilters {
  state?: string[];
  suppressed_reason?: string[];
  last_outcome?: string[];
  /**
   * The disposition an agent last filed against the contact (retry design §4.2).
   * The Contacts tab's third chip group ("How the agent wrote it up").
   *
   * Not a closed union: disposition codes are operator-authored per campaign
   * (`agency_campaigns.disposition_catalog`), so the vocabulary is that
   * campaign's catalog ∪ the three built-in codes, and it is validated
   * server-side against the campaign — not here.
   *
   * Master's contacts allow-list forwards this key on the JSON roster and
   * the CSV export (`CONTACT_QUERY_PARAMS`). An unlisted key is a 400
   * `unknown_query_params`, not a silent drop — Apply on this group 400'd
   * and left the table on the previous page until the key was listed.
   * Do not rename it to `disposition`: core's parser reads
   * `last_disposition` only. Attempts use `disposition_code`.
   */
  last_disposition?: string[];
  phone?: string;
  from?: string;
  to?: string;
}

/**
 * The retry-campaign selector — wire contract §1, one encoding used identically
 * as a preview query string and as a create body.
 *
 * ── It is deliberately a NEAR-COPY of {@link AgencyContactFilters} ───────────
 * Retry design DR-3: the selectable facts already have a filter language, in
 * core's `spine-filters.ts`, with the algebra a selector needs (AND across
 * keys, OR within one, an absent key constraining nothing). The supervisor
 * narrows the Contacts tab until it shows the rows they mean and the filters
 * they were already looking at *become* the selector. Inventing a second
 * vocabulary is the thing that drifts.
 *
 * ── Where it differs, and why each difference is load-bearing ───────────────
 * `phone`, `from` and `to` are **not** selector dimensions and are stripped by
 * `selectorFromContactFilters` before any call. A phone filter is a lookup, not
 * a cohort; `from`/`to` filter `created_at`, which is when the row was
 * *ingested* and reads as "dialled between", which it is not. Core answers
 * `400 <key> is not a retry selector dimension` for any of them, so sending one
 * fails the whole request rather than quietly widening the cohort.
 *
 * `never_attempted` and the two `attempt_count_*` bounds are additions that no
 * combination of contact filters expresses — a campaign stopped mid-run leaves
 * `pending` contacts nobody dialled, and retrying exactly those is the most
 * obvious case there is.
 *
 * `suppressed_reason` accepts only `max_attempts` and `manual` here. `dnc` and
 * `invalid` are refused with a 400 and excluded from the seed unconditionally
 * (DR-4) — a customer's recorded request not to be contacted is not an operator
 * choice, and a bad number does not become good.
 */
/**
 * Core's `RETRY_NO_OUTCOME` — the `last_outcome` member meaning "this contact
 * has no outcome at all", i.e. nobody ever dialled it.
 *
 * Declared here rather than imported from the selector util because the type
 * that uses it lives in this module and `agencyRetrySelector.ts` imports *from*
 * here; the other direction is a cycle.
 */
export const RETRY_NO_OUTCOME = '__none__';

export interface AgencyRetrySelector {
  state?: AgencyContactState[];
  /**
   * The ten real outcomes, plus `'__none__'` for a contact that has no outcome
   * at all — core's `RETRY_NO_OUTCOME`, and the same bucket key the preview's
   * `by_last_outcome` breakdown uses for a NULL.
   *
   * It is a MEMBER of this dimension rather than a dimension of its own because
   * "we did not reach them" is a union of "rang out" and "never dialled", and
   * the selector algebra ANDs across dimensions — expressed as two keys those
   * are mutually exclusive and match nothing. See core's
   * `RETRY_OUTCOME_SELECTABLES` for the full argument.
   */
  last_outcome?: (AgencyAttemptOutcome | typeof RETRY_NO_OUTCOME)[];
  last_disposition?: string[];
  /** `max_attempts` | `manual`. `dnc` and `invalid` are refused — see above. */
  suppressed_reason?: string[];
  /** `attempt_count = 0`. Cannot be combined with `attempt_count_gte >= 1`. */
  never_attempted?: boolean;
  attempt_count_gte?: number;
  attempt_count_lte?: number;
}

// ─── Vocabularies ───────────────────────────────────────────────────────────
//
// Transcribed from core's contract, unlike the activity page's action list —
// which master serves precisely because it is the only service that knows BOTH
// stores' vocabularies. There is one store here and one authority, and these
// are frozen enumerations in a frozen cross-service contract rather than a
// catalog that grows: `AgencyAttemptOutcome` and `AgencyContactState` are
// already transcribed in `types/agency.ts` for the station socket, so serving
// them over the wire would be a second copy, not a first.
//
// The compile-time `satisfies` below is the guard: an outcome added to
// `types/agency.ts` and forgotten here is a type error, not a filter that
// silently matches nothing.

export const ATTEMPT_OUTCOME_LABELS = {
  connected: 'Connected',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Failed',
  machine: 'Answering machine',
  invalid: 'Invalid number',
  abandoned: 'Abandoned (no agent free)',
  agent_disconnected: 'Agent disconnected',
  orphaned: 'Interrupted by a system fault',
  /*
    Says WHEN it was cancelled, not merely that it was, because that is the whole
    distinction from the two neighbours a supervisor is choosing between in this
    same filter: "No answer" is the customer letting it ring out, "Abandoned (no
    agent free)" is the customer picking up and reaching nobody, and this is the
    phone stopping because we stopped it. A bare "Cancelled" leaves someone
    building a retry list unable to tell the first from the third — which is the
    thing those two have in common (nothing was learned about the number) and
    why both are worth dialling again.

    Mirrored word-for-word from core's `retry-summary.ts` `OUTCOME_COPY`, like
    every other entry here.
  */
  canceled: 'Stopped by us before answer',
} satisfies Record<AgencyAttemptOutcome, string>;

export const ATTEMPT_STATE_LABELS = {
  queued: 'Queued',
  dialing: 'Dialing',
  ringing: 'Ringing',
  answered: 'Answered',
  bridged: 'On the call',
  ended: 'Ended',
} satisfies Record<AgencyAttemptState, string>;

export const CONTACT_STATE_LABELS = {
  pending: 'Waiting',
  in_flight: 'Being dialed',
  connected: 'On a call',
  completed: 'Completed',
  exhausted: 'Exhausted',
  suppressed: 'Suppressed',
} satisfies Record<AgencyContactState, string>;

/**
 * Why a contact was taken off the roster.
 *
 * Spelled out rather than shown as a code, because these are the rows a
 * compliance question is usually about and `max_attempts` is not self-evident
 * to whoever is reading the answer.
 */
export const SUPPRESSED_REASON_LABELS: Record<string, string> = {
  dnc: 'On the Do Not Call list',
  invalid: 'Not a dialable number',
  max_attempts: 'Every permitted retry was used',
  manual: 'Removed by a supervisor',
};

export function attemptOutcomeLabel(outcome: string | null): string {
  if (outcome === null) return 'Not classified';
  return ATTEMPT_OUTCOME_LABELS[outcome as AgencyAttemptOutcome] ?? outcome;
}

/**
 * The attempt's own lifecycle, in words.
 *
 * A sibling of {@link attemptOutcomeLabel} rather than a bare map lookup, and for
 * the same reason: `AgencyAttemptState` is a closed union in a cross-service
 * contract that CORE owns, so a state core adds arrives here before this file
 * knows the word. Printing it verbatim is what lets that happen without a client
 * release — the property `AgencyCampaignStatusBadge` keeps for campaign status.
 */
export function attemptStateLabel(state: string): string {
  return ATTEMPT_STATE_LABELS[state as AgencyAttemptState] ?? state;
}

export function contactStateLabel(state: string): string {
  return CONTACT_STATE_LABELS[state as AgencyContactState] ?? state;
}

export function suppressedReasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  return SUPPRESSED_REASON_LABELS[reason] ?? reason;
}
