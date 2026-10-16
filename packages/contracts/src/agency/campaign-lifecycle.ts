/**
 * Campaign lifecycle timestamps and actor, and retry campaigns (selector, preview,
 * create, lineage).
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary).
 */

import type { AgencyAttemptOutcome, AgencyCampaignStatus, AgencyContactState } from './enums';

// ─── Campaign lifecycle timestamps ─────────────────────────────────
//
// `started_at`, `ended_at` and `last_transition_by` are COLUMNS on
// `agency_campaigns`, written by the two statements that move a
// campaign's status and by nothing else. They are deliberately NOT derived from
// `GET /agency/campaigns/:id/activity`:
//
//   * that is a second request per page view, for two fields;
//   * it is gated on `audit.read` in the public API layer — a DIFFERENT permission from
//     `agency.supervise`, so a supervisor who may start a campaign may not be
//     able to see when they started it;
//   * and `audit_logs` has a retention horizon (`retention-purge.ts` drops whole
//     monthly partitions), so a campaign older than that horizon would lose its
//     own start time while the row it belongs to is still live.
//
// A campaign's own history has to outlive the audit trail's retention, which means
// it has to be on the campaign row.

/**
 * Who caused a campaign's CURRENT status.
 *
 * `user_id` is the public API layer's user id — opaque to the dialer runtime, the same kind of value as
 * `agency_call_attempts.dispositioned_by_user_id` and
 * `agency_agent_sessions.agent_user_id`.
 *
 * `name` is `string | null` rather than `string`, and the null is not laziness.
 * **The dialer runtime has no user table**: there is nothing here to resolve an id to a
 * name against, so the only name the dialer runtime can serve is the one public API layer sent AT THE
 * MOMENT OF THE TRANSITION. A stored id with no name is therefore a real state —
 * a caller that sent an id and no display name —
 * and it is a different fact from "nobody caused this". The console renders the id
 * in that case; inventing a name from the id, or dropping the actor entirely
 * because half of it is missing, would both lose information the row is holding.
 *
 * ⚠️ The name is a SNAPSHOT and is never refreshed. A user who is later renamed in
 * the public API layer keeps their old name on transitions that already happened, which is the
 * correct reading for a historical record (it says who pressed the button as they
 * were known then) and the wrong one for a directory. Same choice, same reason, as
 * `dispositioned_on_behalf` being stored rather than re-derived.
 */
export interface AgencyCampaignActor {
  user_id: string;
  name: string | null;
}

/**
 * Optional body on `POST /agency-campaigns/:id/{start,pause,resume,stop}`.
 *
 * ── Why this is OPTIONAL, when `AgencyActorFields` refuses an anonymous write ─
 *
 * `checkActor` 400s a disposition with no actor, because a disposition IS the
 * record of who said what about a customer and an unattributed one is worth less
 * than none. A lifecycle transition is not that: the transition itself is the
 * fact, and the actor is attribution ON it. Refusing the transition for want of
 * attribution would put a 400 in front of `/stop` — **the off button** — for
 * every caller that has not been upgraded yet, which is the same class of mistake
 * as gating `/stop` behind the dialer flag (see `gate` in
 * `agency-campaigns.routes.ts`).
 *
 * So an absent or blank `actor_user_id` stores NULL, and the campaign's
 * `last_transition_by` reads `null`.
 *
 * ⚠️ **The cost, stated because it is real:** `null` therefore has TWO causes —
 * the transition was genuinely automatic (the abandonment auto-pause, the pacing
 * leader's finalization), or a caller that could have attributed it did not. The
 * payload cannot separate them. It is the honest shape anyway: the alternative is
 * a third state on the wire that no consumer would render differently, and
 * fabricating an actor for an unattributed transition is the one thing that must
 * not happen — `null` has to keep meaning "we do not know who".
 */
export interface AgencyCampaignTransitionRequest {
  /** the public API layer's user id for the human pressing the control. */
  actor_user_id?: string;
  /** Their display name, as the public API layer knows it now. Absent ⇒ the actor is id-only. */
  actor_name?: string;
}

// ─── Retry campaigns ────────────────────────────────────────────────────────
//
// A supervisor narrows a
// finished campaign's Contacts tab until it shows the rows they mean, presses
// "Retry these contacts", and the filter they were already looking at becomes the
// selector for a NEW campaign seeded from those rows.
//
// The single highest-leverage decision in the design is that this reuses
// the contacts-list filter language rather than inventing a second one: the
// selectable facts live only in the dialer runtime's `agency_contacts`, the dialer runtime already has a
// filter vocabulary over them that is exhaustively pinned against the type unions
// (`spine-filters.ts`), and "full flexibility" is answered by that vocabulary
// rather than by a parallel one that will drift from it.

/**
 * The retry selector, in the ONE encoding used identically as a preview query
 * string and as a create body.
 *
 * **Algebra: AND across keys, OR within one key. An absent key constrains
 * nothing.** That is exactly `AgencyContactRepository.listForCampaign`'s existing
 * behaviour, and it is implemented by extending that builder rather than by a
 * second one — `retrySelectionConditions` in `agency.repository.ts`.
 *
 * Every field is snake_case because this shape is BOTH the wire shape and the
 * value frozen into `agency_campaigns.retry_selector`. The camelCase
 * `AgencyContactFilters` it is translated into is an internal SQL-builder shape
 * and deliberately not this.
 *
 * ── What is deliberately NOT a dimension ────────────────────────────────────
 *
 * `phone`, `from` and `to`, all of which the contacts list DOES filter on. A
 * phone filter is a lookup, not a cohort — one number is not a selection anybody
 * authors a campaign for. `created_at` is when the row was INGESTED, which reads
 * as "dialled between" and is not; a supervisor selecting a date range would get
 * a set bounded by when the CSV landed. They are refused by name rather than
 * ignored, because a selector that silently drops a dimension the console showed
 * as a chip is a wider answer presented as a narrower one.
 *
 * ── `suppressed_reason` is narrower here than on the contacts list ──────────
 *
 * `max_attempts` and `manual` only. `dnc` and `invalid` are refused with their
 * own message: a DNC suppression is a customer's recorded request, not an
 * operator choice, and "a bad number does not become good" is the settled rule
 * that `resolveRetryDecision` already routes `invalid` to `suppressed` for. Both
 * are ALSO excluded unconditionally from the seeding predicate whatever the
 * selector says — refusing the key is the message, the predicate is the
 * enforcement.
 */
/**
 * The `last_outcome` selector member meaning "this contact has no outcome at
 * all" — nobody ever dialled it.
 *
 * Declared HERE, in the import-free contracts leaf, because three places need
 * the same literal and it is vocabulary rather than parsing: `spine-filters.ts`
 * validates against it, the repository translates it to `IS NULL`, and the
 * preview payload already uses the identical key for its NULL bucket
 * (`by_last_outcome`), so a supervisor selects the value they just read.
 */
export const RETRY_NO_OUTCOME = '__none__';

export interface AgencyRetrySelector {
  /** `agency_contacts.state`. Vocabulary: `CONTACT_STATES`. */
  state?: AgencyContactState[];
  /**
   * `agency_contacts.last_outcome`. Vocabulary: `RETRY_OUTCOME_SELECTABLES` —
   * the nine real outcomes **plus** `'__none__'` (`RETRY_NO_OUTCOME`) for a
   * contact that has no outcome at all.
   *
   * Wider than `ATTEMPT_OUTCOMES` on purpose, and wider than the contacts
   * list's own `last_outcome` filter: "we did not reach them" is a union of
   * "rang out" and "never dialled", and the selector ANDs across dimensions, so
   * naming those as two keys yields the empty set. See
   * `RETRY_OUTCOME_SELECTABLES` in `spine-filters.ts` for the full argument and
   * what it cost.
   */
  last_outcome?: (AgencyAttemptOutcome | typeof RETRY_NO_OUTCOME)[];
  /**
   * `agency_contacts.last_disposition`. NOT a closed union — disposition codes
   * are operator-authored per campaign — so it is validated against the PARENT
   * campaign's `disposition_catalog` ∪ the built-in codes, and the 400 echoes
   * that catalog the way `AgencyActionErrorResponse.allowed_codes` does.
   */
  last_disposition?: string[];
  /** `max_attempts` | `manual` only. See the note above. */
  suppressed_reason?: string[];
  /**
   * `true` ⇒ `attempt_count = 0`; `false` ⇒ `attempt_count > 0`.
   *
   * The `true` case is the single most obvious retry there is and no combination
   * of the other dimensions expresses it: a campaign stopped mid-run leaves
   * `pending` contacts nobody ever dialled.
   *
   * `false` is read as its symmetric opposite rather than as "no constraint",
   * and that is a decision. A present key that constrains NOTHING would let
   * `{ never_attempted: false }` alone satisfy the "name at least one dimension"
   * rule and return the whole roster under a chip saying otherwise — the wider
   * answer presented as a narrower one this whole surface exists to avoid. The
   * opposite mistake (a naive client posting an unchecked box and narrowing more
   * than it meant) is shown to the human in the preview count before anything is
   * created, which is what the preview is for.
   */
  never_attempted?: boolean;
  /** `attempt_count >= n`, n ≥ 0. Refused alongside `never_attempted: true` when n ≥ 1. */
  attempt_count_gte?: number;
  /** `attempt_count <= n`, n ≥ 0. */
  attempt_count_lte?: number;
}

/**
 * `GET /api/v1/agency-campaigns/:id/retry/preview`. Writes nothing.
 *
 * The preview and the commit share ONE selector parser and ONE predicate builder,
 * or the preview will eventually promise a count the commit does not deliver —
 * the same class of defect the `ABANDONED_ATTEMPT_PREDICATE_SQL` single-definition
 * rule exists to prevent.
 */
export interface AgencyRetryPreview {
  /** Contacts the selector matched AND that the DNC exclusion did not remove — what would be seeded. */
  matched: number;
  /**
   * `matched`, bucketed. Both maps sum to `matched`.
   *
   * `__none__` is the literal bucket key for a NULL value — a contact that was
   * never dialled has no `last_outcome`, and one that was dialled without a
   * write-up has no `last_disposition`. A map that silently dropped those rows
   * would not sum to `matched`, and a supervisor reading a breakdown that does
   * not add up cannot tell which of the two numbers is wrong.
   */
  by_last_outcome: Record<string, number>;
  by_last_disposition: Record<string, number>;
  /**
   * Rows the selector matched that the DNC exclusion removed anyway.
   *
   * Not decoration. A supervisor who selects "everything suppressed" and gets 40
   * instead of 300 must be told the other 260 were DNC and invalid, or they will
   * report it as a bug.
   */
  excluded: { dnc: number; invalid: number };
  /** The parent's whole roster, for the "812 of 4,000" reading. */
  parent_contacts_total: number;
  /** The generation the CHILD would be — parent's + 1. */
  retry_generation: number;
  /** `RETRY_MAX_SEED_ROWS`, echoed so the console does not hardcode it. */
  max_seed_rows: number;
}

/**
 * `POST /api/v1/agency-campaigns/:id/retry` — **both** success shapes.
 *
 * A discriminated union on `idempotent_replay`, not on the status code, so a
 * client reads one field instead of inferring intent from `201` vs `200`. Every
 * consumer must handle both arms: the public API layer compiles against this file and the
 * console renders from it, and a type that admitted only the `201` made
 * `contacts_seeded` look like a `number` on the one path this whole mechanism
 * exists to make safe — the replay after a lost response, where it is `null`.
 */
export type AgencyRetryCreateResponse<TCampaign> =
  | AgencyRetryCreated<TCampaign>
  | AgencyRetryReplayed<TCampaign>;

/** `201` — this request created the campaign and seeded its roster. */
export interface AgencyRetryCreated<TCampaign> {
  /** The CHILD, in the same shape every other campaign route serves. */
  campaign: TCampaign;
  idempotent_replay: false;
  /**
   * Rows actually inserted. Can be lower than the number of roster rows the
   * selector matched when the parent legitimately holds two byte-identical rows
   * — the seeding INSERT infers `uq_agency_contacts_row_fingerprint`, so the
   * copy is deduplicated the same way a second CSV upload would be. The
   * preview's `matched` and the create's cap both count distinct fingerprints,
   * so this equals what was promised; `duplicates_collapsed` reports the
   * difference from the raw row count.
   */
  contacts_seeded: number;
  /**
   * Matched rows the fingerprint dedup merged, so a roster shorter than the
   * parent's matching rows has a stated cause rather than looking like loss.
   * `0` on an ordinary create.
   */
  duplicates_collapsed: number;
  excluded: { dnc: number; invalid: number };
}

/**
 * `200` — this key was already spent, and `campaign` is the ORIGINAL.
 *
 * Nothing was created by this request, which is exactly what the two `null`s
 * say. They are NOT the child's `contacts_total`: those fields describe what
 * THIS request seeded and excluded, and reporting a roster size in a field named
 * "seeded" would be a fabricated fact about a transaction that never ran.
 *
 * `duplicates_collapsed` is absent rather than `0` for the same reason — no
 * seeding statement ran, so there is no collapse to report.
 */
export interface AgencyRetryReplayed<TCampaign> {
  campaign: TCampaign;
  idempotent_replay: true;
  contacts_seeded: null;
  excluded: null;
}

/** One campaign in a lineage chain — `GET /api/v1/agency-campaigns/:id/lineage`. */
export interface AgencyLineageCampaign {
  id: string;
  name: string;
  status: AgencyCampaignStatus;
  retry_generation: number;
  parent_campaign_id: string | null;
  contacts_total: number;
  /** ISO-8601. */
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

/**
 * The whole chain, root first, ordered by `retry_generation` then `created_at`.
 *
 * A campaign that is not part of any chain answers with ITSELF as the only entry
 * — not a 404. The supervisor's header renders this strip unconditionally, and a
 * 404 would make it branch on a distinction ("is this campaign in a chain") that
 * the payload already carries in its length.
 */
export interface AgencyCampaignLineage {
  root_campaign_id: string;
  campaigns: AgencyLineageCampaign[];
}
