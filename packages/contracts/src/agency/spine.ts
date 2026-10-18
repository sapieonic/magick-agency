/**
 * The supervisor read surface over the attempt spine (attempt and contact rows, keyset
 * pages), and the note on the billing shapes that are intentionally absent.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary).
 */

import type { AgencyAttemptOutcome, AgencyAttemptState, AgencyContactState } from './enums';

// ─── Billing wire shapes — intentionally absent ─────────────────────────────
//
// v1 has no credits, billing, settlement or attempt batching, so no such wire
// shapes are declared. Usage facts stay on the rows agency owns
// (`agency_call_attempts`, `agency_calls`,
// `dialer_analysis_jobs.analysis_audio_seconds`) for metering later.

// ─── Supervisor read surface — the attempt spine ────────────────────────────
//
// `agency_call_attempts` is the audit spine, one row per
// dial, and without these pages nothing reads it: the campaign page served aggregate
// counters, `/agency/campaigns/:id/contacts` was an upload form despite the
// name, and `/app/calls/dialer/history` — a CALL list — structurally cannot show
// an attempt that never connected, a suppressed contact, or a disposition.
//
// These two pages are the operational record: what the campaign did to whom.
// They are deliberately NOT the control-plane trail (the
// `audit_logs`), which answers who pressed which button.
//
// ── Three privacy decisions are frozen into these shapes, not left to render ─
//
// 1. **`context` appears on ONE shape only** — `AgencyContactDetail`, the
//    single-contact drill-down — and never on a list row. Columns the operator
//    marked `Ignore` at ingest are already absent from the stored JSONB
//    (the public API layer's `agency-csv-ingest.ts` drops them before the row is written, so
//    the exclusion is enforced at ingest and not merely at render), but
//    `context_display.hidden` is a *render* rule, and this surface has a wider
//    audience than the agent screen it was written for. A client rendering
//    `context` MUST apply `AgencyContextDisplay.hidden` exactly as the agent
//    console does. Putting it on the drill-down alone also keeps it out of the
//    list and out of the CSV export by construction.
//
// 2. **Phone numbers are served in full, to `agency.supervise` holders only.**
//    No masking rule exists yet and inventing a second
//    masking rule here — one that the agent floor would then not share — is how
//    two rules drift. The supervisor floor is `account_admin`, which is also the
//    floor for the DNC list and the roster upload: the number is not new
//    information to this reader. What IS new is bulk: the public API layer audits the CSV
//    export (`agency_export.attempts` / `agency_export.contacts`) with the
//    filters and row count, so a mass extraction leaves a trail even though it
//    needs no extra permission.
//
// 3. **`notes` are included, deliberately.** They are agent-typed free text and
//    are excluded from the AUDIT trail on purpose (the public API layer's
//    `proxy-agency-agent.routes.ts` — an audit row records the catalog code, not
//    customer content). This is not the audit trail: notes are operational
//    content on the contact record, and "we dialled this number four times and
//    Ravi marked it Not Interested — *because the customer asked us to call
//    after 6pm*" is the answer a compliance question actually wants. Recorded as
//    a decision rather than inherited from spreading the row.

/**
 * One dial, as a supervisor reads it.
 *
 * Timestamps are ISO-8601 strings on the wire. `agent_user_id` is resolved
 * through `agency_agent_sessions` so the row names a PERSON (the public API layer's user id),
 * never the session UUID that `reserved_agent_id` holds — a session id is
 * meaningless to everyone who would open this page.
 */
export interface AgencyAttemptRow {
  id: string;
  /**
   * The campaign this attempt belongs to.
   *
   * Added for the agent-scoped spine (`GET /agency-agents/:id/attempts`), which
   * is CROSS-campaign: without it, a row from an agent who works three campaigns
   * is unattributable, and the reader cannot tell two calls to the same number on
   * two campaigns apart. Redundant on the campaign-scoped route, where it equals
   * the path parameter — and served there anyway rather than conditionally, since
   * one row shape that is sometimes missing a field is how a consumer learns to
   * guess.
   */
  campaign_id: string;
  contact_id: string;
  attempt_number: number;
  /** E.164, as dialed. Denormalised from the contact so a row is self-contained. */
  phone_e164: string;
  caller_id: string;
  /**
   * The agent who held this attempt, as the public API layer's user id — resolved from
   * `reserved_agent_id`'s session row. NULL when the attempt was never reserved
   * (it failed before an agent was on it) or the session row is gone.
   */
  agent_user_id: string | null;
  /** The session itself, kept for correlation with the live floor. */
  reserved_agent_id: string | null;
  state: AgencyAttemptState;
  /** NULL is possible and is NOT `failed` — the attempt ended unclassified. */
  outcome: AgencyAttemptOutcome | null;
  disposition_code: string | null;
  /** See privacy decision 3 above. */
  notes: string | null;
  callback_at: string | null;
  /** Who filed the write-up, which is not always who took the call. */
  dispositioned_by_user_id: string | null;
  dispositioned_at: string | null;
  dispositioned_on_behalf: boolean;
  /**
   * The media leg, for the recording and the analysis.
   *
   * **Deliberately not an FK** (the attempt row must outlive a
   * purged call row), so a non-null id here is NOT a promise the call still
   * exists. A client must degrade to "recording no longer available" rather than
   * rendering a broken link or a 404.
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

/** One roster row, without `context`. See privacy decision 1. */
export interface AgencyContactRow {
  id: string;
  phone_e164: string;
  state: AgencyContactState;
  /** The CUSTOMER's retry budget — never spent on our own faults. */
  attempt_count: number;
  /** Redials caused by OUR faults, bounded independently of the budget. */
  our_fault_attempts: number;
  last_outcome: string | null;
  last_disposition: string | null;
  next_attempt_at: string;
  /** `dnc` | `invalid` | `max_attempts` | `manual`, or NULL. */
  suppressed_reason: string | null;
  timezone: string | null;
  /** Provenance: the row's line in the uploaded CSV. NULL when the row was not uploaded from a CSV. */
  csv_line_number: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * One contact with its CSV columns — the drill-down, and the only shape that
 * carries `context`.
 */
export interface AgencyContactDetail extends AgencyContactRow {
  /**
   * Every non-phone CSV column the operator did not mark `Ignore`, unchanged.
   * Render through `AgencyContextDisplay` and honour `hidden`; treat every value
   * as untrusted display text, never as markup.
   */
  context: Record<string, unknown>;
}

/**
 * A keyset page.
 *
 * **Keyset, not offset, and the difference is correctness rather than speed.**
 * The target is 1M contacts across 50 agents, and new attempts land while a supervisor
 * pages. An OFFSET counts from the top of a result set that is still growing, so
 * a row inserted during pagination shifts every later page by one and the
 * failure looks like rows randomly missing. A keyset asks for "the rows after
 * this exact one" and is unaffected by anything written since.
 *
 * `next_cursor` is **opaque** — base64url, and its contents are the dialer runtime's business.
 * The public API layer passes it through untouched; a client that parses it is coupling to an
 * encoding that carries no compatibility promise.
 *
 * There is deliberately **no `total`**. Counting the filtered set is a second
 * scan of up to a million rows on every page, for a number that is stale before
 * it renders on a live campaign.
 */
export interface AgencyKeysetPage<TRow> {
  rows: TRow[];
  /** NULL when this is the last page. */
  next_cursor: string | null;
  /** The page size actually applied, after clamping. */
  limit: number;
}

export type AgencyAttemptsPage = AgencyKeysetPage<AgencyAttemptRow>;
export type AgencyContactsPage = AgencyKeysetPage<AgencyContactRow>;
