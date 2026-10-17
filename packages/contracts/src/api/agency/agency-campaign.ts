/**
 * Campaign-builder types — the wire shapes the public API layer serves under
 * `/proxy/agency/{campaigns,ingest}`.
 *
 * They are deliberately NOT re-derived from a design sketch of four counters
 * that sum to the row count: the implementation does not work that way (see
 * `utils/agencyIngestSummary.ts`). Where the two disagree the wire wins, because
 * the wire is what the operator's numbers come from.
 */

import type * as Core from '../../agency';
import type { AgencyAgentState, AgencyContextDisplay, AgencyDisposition } from './agency';
import type { AgencyRetrySelector } from './agency-spine';
// Identical in the dialer contract, so re-exported rather than copied (`CONTRACT-DIFF.md` §3).
import type {
  AgencyAgentLiveState,
  AgencyAgentsByState,
  AgencyCampaignActor,
  AgencyCampaignStatus,
  AgencyRetryPreview,
  AgencyStall,
  AgencyStallCode,
} from '../../agency';

export type {
  AgencyAgentLiveState,
  AgencyAgentsByState,
  AgencyCampaignActor,
  AgencyCampaignStatus,
  AgencyRetryPreview,
  AgencyStall,
  AgencyStallCode,
};
// The campaign config defaults the server applies and the console previews, one
// declaration for both (`../../agency/campaign-defaults.ts`).
export {
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  AGENCY_DEFAULT_DISPOSITION_RETRY,
  AGENCY_DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES,
  AGENCY_OUR_FAULT_REDIAL_BOUND,
  AGENCY_OUR_FAULT_RETRY_DEFAULT,
} from '../../agency';

/** Roster ingest lifecycle. `pending` → `running` → terminal. */
export type AgencyIngestJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Why one row was not ingested.
 *
 * `duplicate_phone` and `dnc_suppressed` are **breakdowns of `rejected`**, not
 * separate outcomes — see `AgencyIngestJob` below.
 */
export type AgencyIngestReasonCode =
  | 'missing_phone_value'
  | 'invalid_phone'
  | 'duplicate_phone'
  | 'ragged_row'
  | 'value_too_large'
  | 'row_too_large'
  | 'dnc_suppressed';

/** Why the whole file was unusable. Nothing is ingested. */
export type AgencyIngestFailureCode =
  | 'malformed_csv'
  | 'phone_column_missing'
  | 'timezone_column_missing'
  | 'too_many_columns'
  | 'too_many_rows'
  | 'unsupported_encoding'
  | 'dnc_unavailable';

/** `GET /proxy/agency/ingest/limits` — served from public API layer's constants. */
export interface AgencyIngestLimits {
  max_rows: number;
  max_columns: number;
  max_cell_bytes: number;
  max_file_bytes: number;
}

/** `POST /proxy/agency/ingest/upload`. */
export interface AgencyUploadResponse {
  s3_key: string;
  file_name: string;
  file_size_bytes: number;
}

/** One column's profile from `POST /proxy/agency/ingest/analyze`. */
export interface AgencyColumnStat {
  /** Header text, de-duplicated exactly as the ingest will write it. */
  name: string;
  index: number;
  /** Up to three non-empty sample values, in file order. */
  samples: string[];
  non_empty: number;
  /** Proportion of NON-EMPTY sampled values that parse to E.164, 0..1. */
  phone_score: number;
}

export interface AgencyColumnAnalysis {
  headers: string[];
  columns: AgencyColumnStat[];
  rows_sampled: number;
  truncated: boolean;
  /** Withheld (null) when two columns are too close to call. Never auto-applied. */
  suggested_phone_column: string | null;
  phone_column_ambiguous: boolean;
  phone_column_candidates: string[];
}

/** `POST /proxy/agency/ingest/jobs` request. */
export interface AgencyIngestRequest {
  s3_key: string;
  file_name: string;
  phone_column: string;
  timezone_column?: string;
  ignore_columns?: string[];
  default_country_code?: string;
  dedupe_phones?: boolean;
  campaign_id?: string;
  dry_run?: boolean;
}

export interface AgencyIngestStartResponse {
  job_id: string;
  status: AgencyIngestJobStatus;
}

/**
 * `GET /proxy/agency/ingest/jobs/:id`.
 *
 * **The counter contract, restated because it is the whole point of the summary
 * screen:** `accepted + rejected = rows_read`, exactly. `duplicates` — and the
 * `dnc_suppressed` entry in `rejected_by_reason` — are breakdowns *of*
 * `rejected`, never a third or fourth addend. The public API layer's ingest service moves
 * DNC-suppressed rows from accepted to rejected for precisely this reason.
 */
export interface AgencyIngestJob {
  job_id: string;
  campaign_id: string | null;
  status: AgencyIngestJobStatus;
  dry_run: boolean;
  file_name: string;
  /** Byte-based; null when the file size is unknown. 100 only when terminal. */
  progress_pct: number | null;
  rows_read: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  rejected_by_reason: Partial<Record<AgencyIngestReasonCode, number>>;
  /**
   * Rows the dialer runtime's roster **refused on arrival** because it already held them.
   *
   * **Independent of `accepted`/`rejected` above, and deliberately not an
   * addend.** Those two count what the public API layer decided to *send*; this counts what
   * the dialer runtime would not take. They cannot be reconciled against each other, and the
   * summary must not try — the whole value of the number is that it
   * exposes the disagreement.
   *
   * **A floor, not a total.** The public API layer's own report: the dialer runtime's replay path answers
   * `rejected_duplicate_rows: 0` for a chunk whose original response was lost in
   * transit and retried, so this can UNDERCOUNT. It never overcounts, so a
   * non-zero value is always real.
   */
  core_rejected_duplicate_rows: number;
  /**
   * Capped sample (20) of the colliding source row numbers.
   *
   * **Skewed to the earliest chunks, not a spread across the file** — the dialer runtime caps
   * each chunk at 20 and the public API layer stops accepting once the same cap is reached, so
   * on a heavily-colliding re-upload chunk 0 alone typically fills it. Examples,
   * never a representative sample.
   */
  core_duplicate_source_rows: number[];
  chunks_sent: number;
  headers: string[] | null;
  context_columns: string[] | null;
  has_rejected_export: boolean;
  rejected_row_count: number;
  rejected_truncated: boolean;
  error_code: AgencyIngestFailureCode | string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

// ─── Campaign config ──────────────────────────────────────────

/** One entry of the campaign's disposition catalog: the dialer's {@link AgencyDisposition}. */
export type AgencyDispositionEntry = AgencyDisposition;

/** A disposition's retry rule, as the dialer declares it inline on {@link AgencyDisposition}. */
export type AgencyRetryRule = NonNullable<AgencyDisposition['retry']>;

/**
 * Outcomes the retry policy may be keyed by.
 *
 * **Not an identical mirror of the public API layer's validator** (`RETRY_POLICY_OUTCOMES`,
 * in `agency-campaign-config.ts`) — one deliberate asymmetry:
 *
 * `invalid` is listed here and REFUSED by the public API layer
 * (`SUPPRESSED_BEFORE_POLICY_OUTCOMES`). The dialer runtime's `resolveRetryDecision`
 * suppresses that outcome before any policy is ever consulted, so a rule on it
 * can never fire — which is exactly why it stays in the union and in
 * `agencyCampaignConfigForm.FIXED_ZERO_OUTCOMES` rather than being deleted:
 * the row is rendered as a static "Fixed at 0" with a reason, because
 * hiding it invites the operator to assume it retries.
 * `agencyCampaignConfigForm`'s `NEVER_SENT_RETRY_OUTCOMES` strips the key on
 * the way out, so the fixed-zero row this union allows to exist can never
 * actually reach the public API layer.
 *
 * Everything else — including `agent_disconnected` and `orphaned` — matches
 * the public API layer's validator exactly. Both are in the public API layer's `RETRY_POLICY_OUTCOMES` and the dialer runtime's
 * `DEFAULT_RETRY_POLICY` in `retry-policy.ts`, so this union must carry them. Both are genuinely produced — an agent's dropped
 * station socket (`agent_disconnected`) and an attempt whose owning replica died
 * holding it (`orphaned`) — and both are OUR fault, not the customer's, which is
 * why the form labels them that way.
 *
 * `canceled` is the third our-fault key, added after the 2026-09-08 pilot, and
 * it arrived the same way: the dialer runtime classifying it, the dialer runtime's `DEFAULT_RETRY_POLICY`
 * carrying it, the public API layer's `RETRY_POLICY_OUTCOMES` accepting it. A dial we stopped
 * before anyone picked up is emphatically not the customer's failure to answer,
 * so the dialer runtime charges it to the same `our_fault_attempts` ledger as
 * `agent_disconnected`'s pre-bridge half — which is what makes a rule keyed here
 * read (`resolveOurFaultRedial` takes the configured cap and delay) and why the
 * form treats it as an our-fault row.
 */
export type AgencyRetryOutcome =
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'abandoned'
  | 'invalid'
  | 'connected'
  | 'agent_disconnected'
  | 'orphaned'
  | 'canceled';

export type AgencyRetryPolicy = Partial<Record<AgencyRetryOutcome, AgencyRetryRule>>;

/** The campaign as the dialer runtime stores it, as far as the builder is concerned. */

// ─── The health strip's diagnoses ─────────────────────────────────────
//
// The public API layer proxies the stats payload byte-for-byte, so the frozen
// contract in `../../agency` is the authority for every name and type below; a
// rename there and not here is an `undefined` this file vouches for.

/**
 * ─── THE AGENT FLOOR ─────────────────────────────────────────────────
 *
 * The per-agent roster is part of the stats payload. A console that declared only
 * `agents_live` would throw the roster away on every poll — the strip could say
 * "5 on break" and nobody could see WHO.
 */

/**
 * One agent on the supervisor's floor.
 *
 * Three fields carry meaning that is easy to get wrong, and each wrong reading
 * produces a floor that is confidently false about a person a supervisor is
 * about to act on:
 *
 * 1. **`agent_name: null` is "the public API layer could not resolve this person"** — a
 *    deleted user, or an id from outside this tenant. The public API layer deliberately sends
 *    `null` rather than a placeholder so the console can choose. The choice is
 *    a shortened `agent_user_id` (see `agentDisplayName`): never blank, and
 *    never the word "Unknown", which is indistinguishable from a real name.
 *
 * 2. **`connected: null` is "could not determine", NOT "disconnected".** The dialer runtime
 *    resolves it from Redis and degrades to `null` on a fault. Same reasoning
 *    as `concurrency_in_use`, which this page already renders as "No data": a
 *    degraded read must never manufacture "this agent has dropped" on a screen
 *    whose purpose is to decide who to chase.
 *
 * 3. **`session_id` is not `agent_user_id`.** A session is one shift on one
 *    campaign; the user id is the person. Every supervisor control is addressed
 *    to the SESSION; identity resolution uses the USER.
 */
export interface AgencySupervisorAgent extends Core.AgencySupervisorAgent {
  /**
   * The person's name, enriched by the public API layer on the proxy hop.
   *
   * **`null` means unresolvable**, not "no name". See (1) above.
   */
  agent_name: string | null;
}

/**
 * What `GET /campaigns/:id/stats` actually returns today.
 *
 * The counters stay optional. That was originally because the dialer runtime produced neither
 * `abandoned_24h`, `answered_24h` nor `abandonment_rate_24h_pct` —
 * **the dialer runtime produces all three now**, but a required field is a promise about every
 * deployed the dialer runtime AND the public API layer in the chain, and optionality here costs nothing: the
 * page reads every counter through `stats?.x` and renders an absent one as a
 * dash rather than a zero.
 *
 * The five supervisor fields below are typed as the dialer runtime declares them, because they
 * are the ones whose *shape* carries meaning — `stall: null` and
 * `concurrency_in_use: null` are load-bearing values, not absences, and widening
 * them to `| undefined` at the declaration would blur the distinction this whole
 * payload exists to preserve.
 *
 * `contacts_pending` and `retries_pending` are deliberately separate numbers.
 * `next_attempt_at` can be hours out, so "list exhausted" and "campaign
 * complete" are not the same thing and both belong on screen.
 */
export interface AgencyCampaignStats
  extends Partial<Omit<Core.AgencyCampaignStats, AgencyCampaignStatsShapedField | 'agents'>>,
    Pick<Core.AgencyCampaignStats, AgencyCampaignStatsShapedField> {
  /**
   * The floor itself, **unsorted**. Risk ordering is the console's —
   * see `utils/agencyAgentFloor.ts`.
   *
   * `[]` and `undefined` are different facts and both reach the screen
   * differently: `[]` is "nobody is on this campaign right now", `undefined` is
   * "this payload did not carry a roster".
   */
  agents?: AgencySupervisorAgent[];

  /**
   * The most agents ever at a station on this campaign at one time.
   *
   * Read once, on a terminal campaign, where it is the evidence behind "nobody
   * was ever free to take a call" — the question a stopped campaign's numbers
   * exist to answer and the one `agents_live` cannot, because a stopped
   * campaign's live floor is always empty.
   *
   * **`null` means not measured** — an older dialer runtime, or a campaign that predates
   * the agent event log — and must never be read as `0`. Same rule as
   * `abandonment_rate_24h_pct`, and with the same consequence if broken: a
   * campaign reported as having run with nobody on it, when the truth is that
   * nobody was counting.
   */
  agents_peak?: number | null;
}

/**
 * The five supervisor fields of {@link AgencyCampaignStats} that keep the dialer's
 * declaration (required, `null` meaning something) while every counter is optional.
 */
type AgencyCampaignStatsShapedField =
  | 'stall'
  | 'other_stalls'
  | 'concurrency_limit'
  | 'concurrency_in_use'
  | 'abandonment_ceiling_pct';

export interface AgencyCampaign {
  id: string;
  name: string;
  status: string;
  account_id?: string | null;
  /**
   * ⚠️ **There is no `description`, and one must not be added back here.**
   *
   * `agency_campaigns` declares no such column and
   * `agencyCampaignRepository.update`'s `allowed` set does not list it, so the public API layer
   * — a unchanged body forwarder — passed it to a write that silently dropped it.
   * The settings page then re-seeded from the response, which is what made it
   * self-erasing: the same save that reported success cleared the field. Adding
   * the field back to this interface is enough to make that whole loop compile
   * again, which is why the absence is stated rather than merely left blank.
   */
  /**
   * The numbers a campaign dials FROM, rotated round-robin at dial time.
   *
   * **Required on create** — the dialer runtime rejects an empty array, and the pacing engine
   * throws rather than dialing without a pool. Optional here only because this
   * one interface serves reads, creates and patches.
   *
   * Every entry must belong to `telephony_provider` (the `caller_ids`
   * column comment). A mixed pool dials successfully on some rotations and fails on
   * others.
   */
  caller_ids?: string[];
  /**
   * The carrier the campaign dials through.
   *
   * The dialer runtime defaults this to `'vobiz'`, so it must be sent explicitly — agency
   * campaigns are VoiceLink-only, and a campaign left to the default would try
   * to dial a VoiceLink caller-ID pool through vobiz.
   */
  telephony_provider?: string;
  sip_connection_id?: string | null;
  disposition_catalog?: AgencyDispositionEntry[];
  retry_policy?: AgencyRetryPolicy;
  calling_window_start?: string | null;
  calling_window_end?: string | null;
  /** ISO-8601: 1 = Monday … 7 = Sunday. `0` is not a valid day. */
  calling_days?: number[];
  default_timezone?: string | null;
  wrapup_seconds?: number | null;
  /**
   * Whether the wrap-up window returns the agent to the pool on its own.
   *
   * The dialer runtime defaults it to `true` (`wrapup_auto_return`) and reads it in
   * `wrapup-manager.ts`: `false` holds the agent until they click, and the
   * countdown is only started when there is BOTH a window and this flag. So it
   * decides whether an agent's shift is paced by a timer or by them.
   */
  wrapup_auto_return?: boolean | null;
  record_calls?: boolean;
  /**
   * Which of a contact's uploaded CSV columns are rendered, and in what order
   * (`context_display`).
   *
   * The supervisor attempt views are the first surface outside the agent console to
   * render `context`. It is read there for its `hidden` list: the operator
   * marked those columns not-for-screen for the agent floor, and a supervisor
   * view has a WIDER audience than the one that rule was written about — so the
   * campaign's own rules travel with the campaign rather than being re-decided
   * per screen. Optional because this interface serves reads, creates and
   * patches; absent means the campaign expressed no opinion.
   */
  context_display?: AgencyContextDisplay;
  /**
   * The call-analysis profile every connected leg of this campaign is
   * summarised against, or `null` for no summary.
   *
   * The campaign is the SECOND writer of `webrtc_calls.analysis_profile_id` —
   * `agency-dialer` stamps this onto the leg exactly as `POST /webrtc-call`
   * stamps a per-call id — which is why the dialer runtime validates ownership on the campaign
   * write and not only at dial time.
   *
   * Gated by `agency.analytics` on the way IN only: the public API layer refuses a non-null
   * value from a capability-off tenant and allows `null` through, so a tenant
   * that loses the capability can still clear it.
   */
  analysis_profile_id?: string | null;

  // ── Lifecycle timestamps ─────────────────────────────────────────
  //
  // ── Why these are on the campaign row rather than derived ────────────────
  // `GET /agency/campaigns/:id/activity` carries status transitions with an
  // actor and a timestamp, so these three look derivable from a page this
  // workspace already has. They are not, for three reasons, and each one alone
  // would be enough:
  //
  // 1. It is a SECOND request on every campaign page view, for three values in
  //    a header.
  // 2. It is gated on `audit.read`, a different permission from
  //    `agency.supervise` — so a supervisor without it would read a campaign
  //    with no start date, which looks like a campaign that never started.
  // 3. The trail has a server-side RETENTION HORIZON (the dialer runtime's retention Lambda,
  //    not even the dialer runtime's config). A campaign older than it loses its own start
  //    time, so the summary would read "Ran for —" on exactly the historical
  //    campaigns it exists to describe.
  //
  // Optional and nullable for the reason every field on the stats payload is:
  // `undefined` is "this public API layer did not carry it", `null` is "the dialer runtime carried it
  // and there is genuinely nothing" — and the two render differently.

  /**
   * ISO-8601 instant of the first transition into `running`.
   *
   * `null` is a real answer: a campaign that was created and stopped without
   * ever dialing never started. Renders as "Not started", never as a blank.
   */
  started_at?: string | null;

  /**
   * ISO-8601 instant of the entry into a terminal status (`stopped` /
   * `completed`).
   *
   * `null` means the campaign is still live — which is why the duration derived
   * from the pair is "running for" against `now` rather than "ran for", and why
   * that distinction is made in the derivation and not in a component.
   */
  ended_at?: string | null;

  /**
   * Who caused the CURRENT status.
   *
   * **`null` means the transition was automatic** — the abandonment auto-pause
   * is the case that matters, and it is the one a supervisor most needs named,
   * because "nobody did this, the dialer did" is the answer to the question they
   * opened the page with. So `null` renders as "Automatically", never as a
   * blank and never as an unattributed dash.
   */
  last_transition_by?: AgencyCampaignActor | null;

  // ── Retry campaigns ────────────────────────────────────
  //
  // `formatAgencyCampaignResponse` spreads the row, so these appear on every
  // campaign payload the moment the dialer runtime's columns exist — a retry campaign is an
  // ORDINARY campaign in every other respect (its own roster, its own pacing
  // leader, its own settlement, its own lifecycle), and these four columns plus
  // where its contacts came from are the entire difference.
  //
  // Optional for the reason every field on this interface is: `undefined` is
  // "this public API layer did not carry it", and a build that predates the feature reads
  // every campaign as a non-retry, which is what it was.

  /** The campaign this one was seeded from, or `null` on an original. */
  parent_campaign_id?: string | null;
  /**
   * The first campaign in the chain.
   *
   * Denormalised one level up from `agency_contacts.root_contact_id` and for the
   * same reason: "show me every pass of this campaign" is one indexed read
   * rather than a recursive walk. The header strip is its consumer.
   */
  root_campaign_id?: string | null;
  /**
   * **`0` means this is not a retry**, and it is the column default — so every
   * campaign that existed before the feature is correct without being touched.
   * A retry of a retry is `2`, and the dialer runtime refuses past `RETRY_MAX_GENERATION`.
   */
  retry_generation?: number;
  /**
   * The selector that produced this campaign's roster, **as sent**.
   *
   * A RECORD, never re-executed. Re-running it later would answer
   * differently — the parent keeps moving if it is resumed — and the child's
   * roster would stop being reproducible from its own row. Typed `unknown`
   * rather than `AgencyRetrySelector` deliberately: it is whatever the operator
   * sent at the time, including keys a later build may have retired, and
   * narrowing it here would invite a consumer to trust the shape.
   */
  retry_selector?: unknown | null;
}

// ── Retry campaigns — the three routes' wire shapes ───────────

/** `POST /proxy/agency/campaigns/:id/retry`. */
export interface AgencyRetryCreateRequest {
  selector: AgencyRetrySelector;
  /** Optional; the dialer runtime defaults to `<parent name> — Retry <n>`. */
  name?: string;
  /**
   * Any create-route config key. Applied ON TOP of the parent's config, which
   * the child inherits wholesale.
   *
   * ⚠️ `agent_user_id` and `actor_name` are **not** here and must never be sent:
   * the public API layer fills the actor from the authenticated session, exactly as it does
   * everywhere else. An actor the client controls is an actor the client can
   * forge.
   */
  config_overrides?: Partial<AgencyCampaign>;
  /**
   * At-most-once, minted HERE — once per opening of the retry dialog — and
   * forwarded unchanged by the public API layer.
   *
   * The browser is the only layer that can mint it, and that is the whole point:
   * a key generated per REQUEST, anywhere downstream, is a different value on the
   * second attempt and protects nothing. This one has to be stable across "the
   * response never arrived, so I pressed the button again", because there is no
   * campaign delete route — a duplicate retry is a cohort of
   * real customers dialled twice, and nothing in the product can undo it.
   */
  idempotency_key?: string;
}

export interface AgencyRetryCreateResponse {
  /** The CHILD, in full. It starts `draft` — creating and starting stay separate verbs. */
  campaign: AgencyCampaign;
  /**
   * `true` when this exact `idempotency_key` had ALREADY created the campaign
   * above — the dialer runtime answers 200 rather than 201 and nothing was created now.
   *
   * A success, not an error: the campaign is the one this supervisor already
   * made, and the console's job is to take them to it.
   *
   * Optional because a dialer runtime that predates the field sends none, and its absence
   * means "this was a create" — which is what it was.
   */
  idempotent_replay?: boolean;
  /**
   * What THIS request seeded and excluded — **`null` on a replay**, because this
   * request seeded nothing. Reporting the child's roster size in a field named
   * "seeded" would be a fabricated fact about a transaction that never ran, so
   * the dialer runtime sends null and the console reads the campaign instead.
   */
  contacts_seeded: number | null;
  /**
   * How many matched rows the seed COLLAPSED rather than copied — normally 0,
   * and `null` on a replay for the same reason as `contacts_seeded`.
   *
   * The preview's `matched` is a promise about the create, and the one way the
   * create legitimately delivers fewer is a parent holding byte-identical roster
   * rows, which the child collapses to one. Reported so a supervisor shown 812
   * and handed 809 is not left to decide for themselves whether that is a
   * collapse or rows lost to a bug.
   *
   * Optional: a dialer runtime that predates the field sends none, and an absence is not a
   * zero — it is "this build cannot tell you", which is why the toast says
   * nothing rather than claiming nothing was collapsed.
   */
  duplicates_collapsed?: number | null;
  excluded: { dnc: number; invalid: number } | null;
}

/**
 * The three `409` refusals `POST .../retry` can answer with.
 *
 * They carry only a `code`, and they are campaign refusals — **not** members of
 * `AGENCY_ACTION_ERROR_CODES`, which is attempt-action codes only and is pinned
 * in several places. Widening that union is the mistake the
 * agency build made three times.
 */
export const AGENCY_RETRY_REFUSAL_CODES = [
  /** The selector matched zero seedable contacts. **Nothing was created.** */
  'retry_selection_empty',
  /** More than `RETRY_MAX_SEED_ROWS` matched. */
  'retry_selection_too_large',
  /** The parent is already at `RETRY_MAX_GENERATION`. */
  'retry_generation_exceeded',
] as const;

export type AgencyRetryRefusalCode = (typeof AGENCY_RETRY_REFUSAL_CODES)[number];

/**
 * One campaign in a retry chain — `GET /proxy/agency/campaigns/:id/lineage`.
 *
 * A deliberately thin projection. It is navigation: enough to name each pass,
 * say how it went and link to it. Anything more would make the strip a second,
 * unauthorised campaign list.
 */
export interface AgencyCampaignLineageEntry extends Omit<Core.AgencyLineageCampaign, 'status'> {
  /** Read as a string: a status this console does not know still names the pass. */
  status: string;
}

/**
 * The whole chain, root first, ordered by `retry_generation` then `created_at`.
 *
 * **A campaign in no chain answers with itself as the only entry — not a 404.**
 * So "is this campaign part of a chain?" is `campaigns.length > 1`, and the
 * strip renders nothing for the single-entry answer rather than announcing that
 * a campaign is its own ancestor.
 */
export interface AgencyCampaignLineage extends Omit<Core.AgencyCampaignLineage, 'campaigns'> {
  campaigns: AgencyCampaignLineageEntry[];
}

// ── Agent ↔ campaign assignment (the public API layer-native) ──────────────────
//
// Staffing, **not authorization**. Joining a station stays gated on
// `agency.station.connect` alone, so a supervisor covering a shift can still
// join a campaign nobody assigned them to. An assignment only decides where an
// `agent`-role user — who inherits no navigation at level 5 — is sent by
// default when they open the app.
//
// The rows live in the public API layer (`agency_campaign_agents`), never the dialer runtime: the dialer runtime has no
// identity model at all (no user table, no FK, `agent_user_id` is an opaque
// string), which is also why the public API layer is the side that can enrich a name onto one.

/**
 * `GET /proxy/agency/my-assignment`.
 *
 * **`204` — no body — is the unassigned answer**, and it is a legitimate steady
 * state rather than an error: a new agent exists before anyone staffs them. The
 * API layer turns that into `null` so callers branch on a value instead of on a
 * status code.
 */
export interface AgencyMyAssignment {
  campaign_id: string;
  /**
   * **Nullable — and this type used to deny it.**
   *
   * The public API layer resolves the name through a best-effort call to the dialer runtime and documents
   * `null` for a dialer runtime outage, a campaign deleted since the assignment was made,
   * or a changed response shape; it has a test named for exactly that case.
   * Declared non-null here, `tsc` could not flag either render site, so a
   * thirty-second dialer runtime blip showed an agent a sentence with a hole in it and a
   * link reading "Go back to ".
   *
   * The id is what the redirect needs and is never null. The name is
   * presentation, so guard it at every render site — this is the hand-mirrored
   * contract's characteristic failure and the mirror is the only thing that can
   * catch it.
   */
  campaign_name: string | null;
}

/**
 * One row of `GET /proxy/agency/my-assignments` — a campaign this agent may work.
 *
 * The plural route replaces the singular `/my-assignment` (see
 * {@link AgencyMyAssignment}), because the public API layer's staffing table now allows an
 * agent to be staffed on several campaigns. Being LIVE on one at a time is
 * unchanged and is enforced by the dialer runtime's session index, not by this list: these are
 * the campaigns an agent may CHOOSE from, not the one they are on.
 */
export interface AgencyAssignment {
  campaign_id: string;
  /**
   * **Nullable, and every render site must guard it.** The public API layer resolves this
   * through a best-effort call to the dialer runtime and documents `null` for a dialer runtime outage, a
   * campaign deleted since the assignment was made, or a changed response shape.
   * The id is what every link needs and is never null; the name is presentation.
   * See {@link AgencyMyAssignment} for the bug this nullability records.
   */
  campaign_name: string | null;
  /**
   * The campaign's lifecycle state, or `null` when the same best-effort lookup
   * could not resolve it. Typed as a plain `string` rather than
   * `AgencyCampaignStatus` on purpose: the public API layer forwards whatever the dialer runtime says
   * unchanged, so a status the dialer runtime adds arrives here before this mirror knows about
   * it. Render it through `AgencyCampaignStatusBadge`, which shows an
   * unrecognised status as itself instead of mapping it to a default.
   *
   * This is what lets the agent home say "this one isn't taking calls right now"
   * BEFORE the agent clicks into a station that would refuse them.
   */
  campaign_status: string | null;
  /** When the supervisor staffed them. Drives the list's stable order. */
  assigned_at: string;
}

/** `GET /proxy/agency/my-assignments`. Empty array ⇒ nobody has staffed them. */
export interface AgencyMyAssignments {
  assignments: AgencyAssignment[];
}

/** One row of `GET /proxy/agency/campaigns/:id/agents` — the campaign's people. */
export interface AgencyAssignedAgent {
  user_id: string;
  /**
   * Enriched by the public API layer from its own user table on the read.
   *
   * Enrichment failure must never turn a 200 into a 500 (the public API layer's
   * `agency-stats-enrichment.ts` states that rule and this route follows it), so
   * an unresolvable person still arrives — with whatever the public API layer could resolve.
   */
  name: string | null;
  email: string | null;
  role: string | null;
  /** ISO-8601. */
  assigned_at: string;
}

/** `POST /proxy/agency/campaigns/:id/agents` — 201. */
export interface AgencyAgentAssignment {
  user_id: string;
  campaign_id: string;
  assigned_at: string;
}
