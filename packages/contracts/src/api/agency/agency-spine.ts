/**
 * The attempt spine — what the campaign did, and to whom.
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
 * {@link AgencyContactDetail} and nowhere else. The public API layer serves it only on the
 * single-contact route, so a list and an export cannot carry it by
 * construction. When rendering it, apply `AgencyContextDisplay.hidden` exactly
 * as the agent console does (`resolveContextFields`): the operator marked those
 * columns not-for-screen, and this screen has a wider audience than the one
 * that rule was written for.
 */

import type * as Core from '../../agency';
import type { AgencyAttemptOutcome, AgencyAttemptState } from './agency';
// Identical in the dialer contract, so re-exported rather than copied (`CONTRACT-DIFF.md` §3).
import type {
  AgencyContactDetail,
  AgencyContactRow,
  AgencyContactState,
  AgencyKeysetPage,
  AgencyRetrySelector,
} from '../../agency';
import {
  RETRY_NO_OUTCOME,
} from '../../agency';

export type {
  AgencyContactDetail,
  AgencyContactState,
  AgencyKeysetPage,
  AgencyRetrySelector,
};
export {
  RETRY_NO_OUTCOME,
};

/** One roster row, without `context`: the console's name for the dialer contract's `AgencyContactRow`. */
export type AgencyRosterContact = AgencyContactRow;

export interface AgencyAttempt extends Core.AgencyAttemptRow {
  /**
   * The agent's display name, resolved by the public API layer — the dialer runtime has no user table, so
   * it can only ever serve the id, and a column of UUIDs is not one a
   * supervisor can read.
   *
   * `null` means either "no agent was on this attempt" or "the public API layer could not
   * identify that id in this tenant". `agent_user_id` separates the two, which
   * is why both keys are always present. Optional here only because a public API layer
   * older than this build does not send it.
   */
  agent_name?: string | null;
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
   * The disposition an agent last filed against the contact.
   * The Contacts tab's third chip group ("How the agent wrote it up").
   *
   * Not a closed union: disposition codes are operator-authored per campaign
   * (`agency_campaigns.disposition_catalog`), so the vocabulary is that
   * campaign's catalog ∪ the three built-in codes, and it is validated
   * server-side against the campaign — not here.
   *
   * The public API layer's contacts allow-list forwards this key on the JSON roster and
   * the CSV export (`CONTACT_QUERY_PARAMS`). An unlisted key is a 400
   * `unknown_query_params`, not a silent drop — Apply on this group 400'd
   * and left the table on the previous page until the key was listed.
   * Do not rename it to `disposition`: the dialer runtime's parser reads
   * `last_disposition` only. Attempts use `disposition_code`.
   */
  last_disposition?: string[];
  phone?: string;
  from?: string;
  to?: string;
}

/**
 * The retry-campaign selector — one encoding used identically
 * as a preview query string and as a create body.
 *
 * ── It is deliberately a NEAR-COPY of {@link AgencyContactFilters} ───────────
 * The selectable facts already have a filter language, in
 * the dialer runtime's `spine-filters.ts`, with the algebra a selector needs (AND across
 * keys, OR within one, an absent key constraining nothing). The supervisor
 * narrows the Contacts tab until it shows the rows they mean and the filters
 * they were already looking at *become* the selector. Inventing a second
 * vocabulary is the thing that drifts.
 *
 * ── Where it differs, and why each difference is load-bearing ───────────────
 * `phone`, `from` and `to` are **not** selector dimensions and are stripped by
 * `selectorFromContactFilters` before any call. A phone filter is a lookup, not
 * a cohort; `from`/`to` filter `created_at`, which is when the row was
 * *ingested* and reads as "dialled between", which it is not. The dialer runtime answers
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
 * — a customer's recorded request not to be contacted is not an operator
 * choice, and a bad number does not become good.
 */

// ─── Vocabularies ───────────────────────────────────────────────────────────
//
// Transcribed from dialer runtime's contract, unlike the activity page's action list —
// which the public API layer serves precisely because it is the only service that knows BOTH
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

    Worded to match `OUTCOME_COPY` in `retry-summary.ts`, like
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
 * contract that the dialer runtime owns, so a state the dialer runtime adds arrives here before this file
 * knows the word. Printing it unchanged is what lets that happen without a client
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
