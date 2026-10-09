/**
 * The console's view of the agency dialer wire contract.
 *
 * The frozen contract in `../../agency` is the wire truth. This file declares the
 * members the console renders, and the unions are declared WHOLE even where a
 * member is not yet reachable (`wrapup`, `break`), because a union that widens
 * later is a breaking change for every exhaustive switch.
 */

export type AgencyAgentState =
  | 'offline'
  | 'available'
  | 'reserved'
  | 'on_call'
  | 'wrapup'
  | 'break';

export type AgencyCampaignStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'completed'
  | 'stopped';

export type AgencyAttemptOutcome =
  | 'connected'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'machine'
  | 'invalid'
  | 'abandoned'
  | 'agent_disconnected'
  | 'orphaned'
  /**
   * A dial we stopped before anyone picked up.
   *
   * Its own fact, not a shade of its two neighbours: `no_answer` is the customer
   * letting it ring out and `abandoned` is the customer picking up and reaching
   * nobody, while this is the phone stopping because WE stopped it — an agent, a
   * supervisor or a lifecycle event ending an attempt mid-ring.
   *
   * Added after the 2026-09-08 pilot, where the dialer runtime labelled a cancelled ring
   * `abandoned` — putting dials no customer ever heard into the
   * compliance-facing bucket and making the pilot's numbers unreadable.
   */
  | 'canceled';

/**
 * Why an attempt released the agent. The console must render copy for each, and
 * an unrecognised value falls back to the frame's own `message` rather than
 * blanking — an agent whose screen clears with no explanation concludes the app
 * is broken, which is a support ticket per unanswered call.
 *
 * ⚠️ **`canceled` is deliberately NOT a member**, even though it is now an
 * `AgencyAttemptOutcome`. The dialer runtime's `releaseReasonFor` maps it onto
 * `agent_hangup` or `completed`, both of which already have copy — under late
 * binding a pre-answer cancel reaches no agent at all (there is nobody to
 * release), and with the flag off the only producer is the agent's own hangup,
 * which the console already explains as "You ended the call." A member here
 * would be a copy string nothing can emit.
 */
export type AgencyReleaseReason =
  | 'completed'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'invalid'
  | 'abandoned'
  | 'agent_disconnected'
  | 'reservation_expired'
  | 'agent_hangup'
  | 'remote_hangup'
  | 'campaign_paused'
  | 'campaign_stopped'
  | 'supervisor_released'
  | 'orphaned';

export type AgencyStationErrorCode =
  | 'unauthorized'
  | 'unknown_attempt'
  | 'not_your_attempt'
  | 'invalid_frame'
  | 'campaign_not_running';

/**
 * Which of a contact's arbitrary CSV columns matter, and in what order.
 *
 * Resolution rules, which BOTH clients must implement identically:
 *  1. `hero` first, pinned, in array order;
 *  2. then any column named in `order`, in array order;
 *  3. then every remaining column, in original CSV header order;
 *  4. minus anything in `hidden`, at every stage.
 * A name in more than one list is resolved by that precedence, so a column in
 * both `hero` and `hidden` is hidden. Empty/absent means "no operator opinion" —
 * render every column in original order.
 */
export interface AgencyContextDisplay {
  hero?: string[];
  order?: string[];
  hidden?: string[];
}

export interface AgencyDisposition {
  code: string;
  label: string;
  is_success?: boolean;
  requires_note?: boolean;
  requires_datetime?: boolean;
  terminal?: boolean;
  suppress?: boolean;
  retry?: { delay_minutes?: number; max_attempts: number };
}

/**
 * One entry in `agency_campaigns.break_reasons` (migration 078).
 *
 * Campaign config is the **sole authority** on accepted break codes — the dialer runtime
 * validates `POST /sessions/:id/break` against this list and answers
 * `unknown_break_reason` with `allowed_codes`. An empty list is meaningful: the
 * workspace has configured none, and the console disables Break with a stated
 * reason rather than rendering an empty menu or guessing a code.
 */
export interface AgencyBreakReason {
  code: string;
  label: string;
  /** Whether the break is paid. Reporting only; the console does not branch on it. */
  is_paid?: boolean;
}

/**
 * Liveness parameters, in milliseconds. **No client constant may duplicate one
 * of these**: the console's countdown and the server's lease would drift the
 * first time either is retuned, and the drift is silent.
 */
export interface AgencyStationIntervals {
  heartbeat_ms: number;
  heartbeat_grace_ms: number;
  reservation_lease_ms: number;
  countdown_ms: number;
  /**
   * How long a live call is held open after the station socket drops, waiting
   * for this session to reconnect. Optional here so a payload that lacks it
   * degrades to the console's default rather than to a wrong number.
   */
  deferred_hangup_ms?: number;
}

export interface AgencySessionBootstrap {
  session_id: string;
  campaign_id: string;
  campaign_name: string;
  agent_user_id: string;
  state: AgencyAgentState;
  campaign_status: AgencyCampaignStatus;
  station_ws_url: string;
  /** ISO-8601. Single-use and short — re-mint before each connect attempt. */
  station_token_expires_at?: string;
  disposition_catalog: AgencyDisposition[];
  wrapup_seconds: number;
  wrapup_auto_return: boolean;
  record_calls: boolean;
  break_reasons: AgencyBreakReason[];
  context_display: AgencyContextDisplay;
  intervals: AgencyStationIntervals;
  /**
   * Set only when this campaign is a retry of another one.
   *
   * **Absent for every non-retry campaign**, which is 100% of them today — so an
   * `undefined` here is the ordinary case and must render as *nothing at all*,
   * not as an empty banner reserving space.
   *
   * ── Why it is on the bootstrap and not on the `reserved` frame ─────────────
   * It is campaign-constant: it is the same three values for the whole shift.
   * `AgencyStationReservedFrame` is the one payload whose latency the dialer
   * design guards hardest — it is written synchronously, before the dial, with
   * no interleaved `await` — and repeating a fixed sentence on it once per call
   * would spend that budget on copy.
   *
   * ── `selection_summary` is BUILT SERVER-SIDE and rendered unchanged ─────────────
   * The dialer runtime composes it from the frozen `retry_selector` on the child campaign row,
   * so the sentence the agent reads and the query that produced their roster
   * cannot disagree. Re-deriving it here from anything this client holds would
   * be a second answer to the same question, and this client does not even have
   * the input — the selector is not on the bootstrap, deliberately.
   */
  retry_context?: AgencyRetryContext;
}

/**
 * "Retry 1 of 'Q3 Winback' — these contacts were previously voicemail,
 * callback, no answer."
 *
 * The whole of what an agent is told about the campaign this one came from.
 */
export interface AgencyRetryContext {
  /** 1 = the first retry. A retry of a retry is 2. */
  generation: number;
  parent_campaign_name: string;
  /**
   * Human-readable rendering of the frozen selector, composed dialer-runtime-side.
   *
   * The server's rule, recorded here because a client that
   * "tidies" this into its own join would silently start disagreeing with the
   * roster: the selected `last_disposition` labels first — from the PARENT's
   * catalog where a label exists, else the raw code — then the `last_outcome`
   * values in the console's own outcome copy, then `never attempted` if set,
   * comma-separated, in that order.
   */
  selection_summary: string;
}

/**
 * `409` from `POST /proxy/agency/sessions` — the agent already holds a live
 * session on a **different** campaign in this tenant.
 *
 * Mirrors `AgencySessionCampaignConflict` in `../../agency`, which is the
 * authority. The public API layer forwards status and body **unchanged**, so what the dialer runtime writes
 * is what lands here.
 *
 * ── Why this error exists at all ──────────────────────────────────────────────
 * Live-uniqueness moved from `(campaign_id, agent_user_id)` to
 * `(tenant_id, agent_user_id)`: one human has one pair of ears, and two pacing
 * engines reserving the same person independently bridged two customers onto
 * them. The comment in migration 074 ("an agent working three clients …
 * three rows here, one per account's campaign") is the stale side of that
 * decision and was superseded deliberately.
 *
 * The console renders this as an **answer**, not a failure: it names the station
 * the agent is still joined to, and Leave station *there* is the way out. A
 * generic "Could not join the campaign." would hand them a refusal with nothing
 * to do about it — and this is the one error the new rule makes reachable for an
 * ordinary agent, so it is the one that must not be generic.
 */
export interface AgencySessionConflict {
  error: string;
  code: 'session_on_other_campaign';
  campaign_id: string;
  campaign_name: string;
  /** Their state on that other campaign, so the copy can say whether they are mid-call. */
  state: AgencyAgentState;
  /**
   * The dialer runtime's own sentence.
   *
   * The console does **not** render it on the ordinary path: it composes better
   * copy from the structured fields — a remedy that branches on `state`, and a
   * link to the station they are still joined to — neither of which a server
   * sentence can carry. This is the *degraded* fallback, for a body whose
   * structured fields do not read. The dialer runtime's sentence beats "something went wrong",
   * and when there is no campaign id to point at it is the only thing left to
   * say.
   */
  message?: string;
}

/**
 * Answer to every session-state transition (`/available`, `/break`,
 * `/break/cancel`, `/leave`).
 *
 * `pending_state` is the queued-break signal, and this body is the **fastest** of
 * its three sources rather than the only one: the field also rides on
 * `agent_state` and on `ready`, and those are what a console that did not issue
 * the request has. This one exists — it lands before any frame does, and a pill
 * that waited for the next transition would look like the agent's click did
 * nothing. Everything else here is reconciliation only: `agent_state` frames remain
 * the sole authority for the rail.
 */
export interface AgencySessionStateResponse {
  session_id: string;
  state: AgencyAgentState;
  /** ISO-8601. */
  since: string;
  /** Set when a break was requested mid-call and is queued until wrap-up ends. */
  pending_state?: AgencyAgentState | null;
  /**
   * The break's reason code — **`break_reason`, not `pending_break_reason`.**
   *
   * The HTTP body never carries `pending_break_reason` (`agency.routes.ts`
   * builds `AgencySessionStateResponse` with `break_reason`, and the public API
   * layer proxies it byte-for-byte). Reading the wrong name yields `undefined`,
   * and a silent `?? fallback` is the only thing standing between that and a
   * queued break with no label.
   *
   * Note the deliberate asymmetry with the socket: the FRAME
   * (`AgencyStationAgentStateFrame`) does carry `pending_break_reason`, because
   * there it sits beside `break_reason` and the two mean different things. On the
   * response there is one field, and the dialer runtime sets it for both "on break" and "break
   * queued" — `pending_state` is what tells them apart.
   */
  break_reason?: string | null;
}

/**
 * Why an agent action was refused — the dialer runtime's closed `AgencyActionErrorCode` union
 * (the public API layer allow-lists the same set through its error mask so these arrive
 * intact rather than as "contact support and quote this request id").
 *
 * **The console keys its copy off `code`**; `message` is only the fallback for a
 * code it does not recognise. That is the whole reason the union is closed.
 *
 * `AGENCY_ACTION_ERROR_CODES` below is the mechanical pin — a code added to
 * the union and forgotten in the list is a compile error, not a rediscovery of
 * this same drift.
 *
 * The pin only catches forgetting the list after editing the union; the
 * authority for the codes is the union itself.
 */
export type AgencyActionErrorCode =
  | 'missing_actor'
  | 'not_your_attempt'
  | 'unknown_disposition_code'
  | 'invalid_dnc_scope'
  | 'note_required'
  | 'datetime_required'
  | 'invalid_callback_at'
  | 'attempt_not_dispositionable'
  | 'already_dispositioned'
  | 'unknown_break_reason'
  | 'break_already_applied'
  | 'session_ended'
  /**
   * `POST /sessions` refused: the agent already holds a live session on a
   * DIFFERENT campaign in this tenant (one live session per (tenant, agent)
   * since the dialer runtime's migration 092). The only member that also sets `campaign_id` /
   * `campaign_name` / `state` — {@link AgencySessionConflict} narrows this shape
   * for it, which is why that interface pins the code as a literal discriminant
   * rather than using this union.
   */
  | 'session_on_other_campaign'
  /**
   * `POST /sessions/:id/leave` refused: the replica is still driving an attempt
   * for this session. Leaving would clear the lease and set `left_at`, dropping
   * the row out of `uq_agency_agent_live_tenant` — so an `on_call` agent who
   * left could join a second campaign and be bridged a second customer while the
   * first call is still up.
   *
   * **The console has no copy for this one**, and that is a real if narrow gap
   * rather than an oversight worth hiding: `agencyStationExit.ts` blocks Leave
   * client-side for `reserved` / `on_call` / `wrapup`, so the dialer runtime's refusal is the
   * backstop for the race where state changes between render and click. It is
   * listed here because the union is the full contract, not a list of what this
   * console happens to render — the drift below is exactly what listing only the
   * handled ones produces.
   */
  | 'agent_on_live_call'
  | 'no_station'
  | 'attempt_not_live'
  | 'campaign_not_running'
  | 'feature_disabled';

/**
 * Runtime list of the union above.
 *
 * `satisfies` pins it to the type in one direction (every listed value is a
 * valid code); {@link MissingAgencyActionErrorCode} below pins the other
 * (every code in the union is listed) — the same two-sided check
 * `AGENCY_ACTION_ERROR_CODES` uses, so this union cannot silently drift.
 */
export const AGENCY_ACTION_ERROR_CODES = [
  'missing_actor',
  'not_your_attempt',
  'unknown_disposition_code',
  'invalid_dnc_scope',
  'note_required',
  'datetime_required',
  'invalid_callback_at',
  'attempt_not_dispositionable',
  'already_dispositioned',
  'unknown_break_reason',
  'break_already_applied',
  'session_ended',
  'session_on_other_campaign',
  'agent_on_live_call',
  'no_station',
  'attempt_not_live',
  'campaign_not_running',
  'feature_disabled',
] as const satisfies readonly AgencyActionErrorCode[];

/**
 * Exhaustiveness in the other direction: every member of the union appears in
 * {@link AGENCY_ACTION_ERROR_CODES}. `satisfies` alone only proves the list
 * holds *valid* codes, not *all* of them, and a code present in the union but
 * missing from the list is exactly the failure mode — a code
 * that compiles, is a real value of the type, and is simply never listed
 * anywhere that would have caught it.
 */
type MissingAgencyActionErrorCode = Exclude<
  AgencyActionErrorCode,
  (typeof AGENCY_ACTION_ERROR_CODES)[number]
>;
const _allAgencyActionErrorCodesListed: MissingAgencyActionErrorCode extends never
  ? true
  : MissingAgencyActionErrorCode = true;
void _allAgencyActionErrorCodesListed;

/** The body of every 4xx from an agency action route. */
export interface AgencyActionErrorResponse {
  error: string;
  code: AgencyActionErrorCode;
  message: string;
  /**
   * Set on `unknown_disposition_code` and `unknown_break_reason`: the codes that
   * *are* valid, so a console holding a stale catalog recovers in one round trip
   * instead of making the agent re-bootstrap mid-shift.
   */
  allowed_codes?: string[];
}

export interface AgencyDispositionResponse {
  attempt_id: string;
  contact_id: string;
  disposition_code: string;
  contact_state: string;
  /** ISO-8601; set when the disposition scheduled a retry or a callback. */
  next_attempt_at: string | null;
  /**
   * What the agent ASKED for, echoed unchanged. `next_attempt_at` is the window-adjusted
   * instant the dialer will actually call; when the two differ the console says what will
   * happen (`confirmationCopy`).
   */
  callback_requested_at?: string | null;
  /**
   * The agent's state after release. **ADVISORY, NOT AUTHORITATIVE.**
   *
   * ⚠️ **This field races the socket by design, and assigning from it
   * unconditionally drops a live call.** Submitting releases the agent; the pacing
   * tick runs every 250ms; so a new call can be reserved and its `reserved` frame
   * delivered **before this HTTP response lands**. A console that writes this
   * value into its agent state then overwrites a fresh `reserved` with a stale
   * `available` — and the panel for a customer who is already on the line
   * disappears.
   *
   * The socket is the authority. This is a hint, usable **only** to reconcile when
   * no `agent_state` frame has arrived within 3s, and only through
   * `advisoryAgentState()` in `utils/agencyStaleResponse.ts`, which will not hand
   * it over once the attempt has moved on. Do not read this property directly.
   *
   * It also must not be hard-coded around: after a submit with a queued break the
   * correct state is `break`, not `available`.
   */
  agent_state: AgencyAgentState;
}

export interface AgencyNotesResponse {
  attempt_id: string;
  notes: string;
  updated_at: string;
}

/**
 * Answer to `POST /agency/attempts/:id/dnc`.
 *
 * `dnc_recorded` is the field that decides what the console may claim.
 * `contact_state: 'suppressed'` means **this campaign** will not dial the
 * contact again; `dnc_recorded: true` additionally means the tenant-wide
 * `dnc_entries` row landed, which is what makes "no campaign in this workspace"
 * true. The dialer runtime populates it from the public API layer's answer and can only know it by asking —
 * so `false` is a real, reachable state, not a defensive default.
 */
export interface AgencyDncResponse {
  attempt_id: string;
  contact_id: string;
  phone_e164: string;
  /** Always `suppressed` on success. */
  contact_state: string;
  /** False when the suppression landed locally but the list write is in flight. */
  dnc_recorded: boolean;
}

export interface AgencyStationTokenResponse {
  session_id: string;
  station_ws_url: string;
  expires_at: string;
}

export interface AgencyPriorAttempt {
  /**
   * 1-based, **per contact row and therefore per campaign**.
   *
   * ⚠️ It RESETS to 1 in a retry campaign (the child gets its
   * own `agency_contacts` row with `attempt_count = 0`). So once this list spans
   * a lineage it is no longer a global ordering and must never be rendered as
   * one — "attempt 2" means nothing to an agent when two campaigns each have
   * one. The dialer runtime's own read stopped ordering by it for exactly this reason.
   */
  attempt_number: number;
  outcome: AgencyAttemptOutcome | null;
  disposition_code: string | null;
  notes: string | null;
  ended_at: string | null;

  // ── Lineage (retry campaigns) ────────────────────────────
  //
  // Declared REQUIRED because the contract declares them required. What is NOT assumed anywhere is that
  // they are populated — `groupPriorAttempts` treats a blank `campaign_id` as
  // "this campaign", which is the only thing an older server could have meant,
  // and is why a stale payload degrades to today's flat list rather than to a
  // group headed by nothing.

  /** The campaign the dial belonged to. Not necessarily the one the agent is on. */
  campaign_id: string;
  /**
   * That campaign's name, resolved by the dialer runtime from its own row.
   *
   * The agent gets the NAME and nothing else about an ancestor campaign — no
   * stats, no connect rate, no roster counts, no agent roster. `agent` is
   * level 5 and holds exactly four `agency.*` permissions; a supervisor-gated
   * read reached from this screen would be the reason someone raises it.
   */
  campaign_name: string;
  /** ISO-8601, or `null` if the attempt never dialled. */
  dialed_at: string | null;
}

export interface AgencyReservedAttempt {
  attempt_id: string;
  campaign_id: string;
  campaign_name: string;
  contact_id: string;
  phone_e164: string;
  caller_id: string;
  attempt_number: number;
  /**
   * Every non-phone CSV column unchanged. **Always treat as untrusted display
   * text, never as markup** — it is operator-uploaded file content.
   */
  context: Record<string, unknown>;
  prior_attempts: AgencyPriorAttempt[];
}

// ─── Station socket frames ──────────────────────────────────────────────────

export interface AgencyStationReadyFrame {
  event: 'ready';
  session_id: string;
  state: AgencyAgentState;
  /**
   * Set when the socket reconnected onto an attempt that is still live.
   *
   * **`AgencyActiveAttempt`, not `AgencyReservedAttempt`** — the difference is
   * `bridged_at`, and it is the whole reconnect story. Typing it as
   * the base type would drop `bridged_at`, and a reconnect onto a live call would
   * render as ringing for the rest of the conversation.
   */
  active_attempt?: AgencyActiveAttempt;
  /**
   * Set when the reconnecting socket is in `wrapup`.
   *
   * The wrap-up countdown is an in-process timer on the dialer runtime's replica, so it survived
   * the socket drop — but the `wrapup` frame that opened it did not, and the dialer runtime does
   * **not** re-emit one. Without reading this, a reconnect mid-wrap-up leaves the
   * console with no anchor: no deadline, no held-reason, and — because the pad's
   * other unlock path keys off a retained attempt this socket never saw — no way
   * to submit the disposition the dialer runtime is about to refuse `/available` over.
   */
  active_wrapup?: AgencyWrapupState;
  /**
   * The `released` this session missed while it was disconnected.
   *
   * **Consumed-on-read in the dialer runtime.** `takeMissedRelease` clears as it reads
   * (`agency.routes.ts`, "read it here, not inline in the frame, because … a
   * second call would return null"), so this frame is the *only* time it is ever
   * offered. A console that drops it does not merely delay the information — it
   * destroys it, and the agent who dropped mid-call comes back to an empty
   * station with no account of the call they were on, which reads as data loss.
   */
  missed_release?: AgencyMissedRelease;
  /**
   * A break the agent asked for that dialer runtime has accepted and not yet applied — the
   * same name, type and meaning as on `AgencyStationAgentStateFrame`, chosen that
   * way deliberately so one badge renders from either frame with no new
   * vocabulary.
   *
   * A
   * queued break is announced exactly twice — on the HTTP response that queued it,
   * and on the `agent_state` beside it — and both die with the socket. The next
   * `agent_state` the agent gets is the one `releaseAgent` sends at the *end* of
   * wrap-up, by which time the break has been applied. So a console that
   * reconnected mid-wrap-up was told its state and its countdown and nothing about
   * the break waiting behind them.
   *
   * **The dialer runtime reads the queue with `peek`, not `take`** (`agency.routes.ts`,
   * `runtime.breaks.peek(sessionId)`), so reporting it here does not consume it:
   * `releaseAgent` still `take`s it when wrap-up ends and the agent still leaves
   * the pool. This is notice of something about to happen, not a receipt for a
   * request.
   *
   * **Not gated on `active_wrapup`.** A break can also be queued from `reserved`
   * or `on_call`, and those reconnects arrive carrying `active_attempt` instead.
   *
   * `undefined` means nothing is queued — the same load-bearing absence as on
   * `agent_state`, so it must CLEAR a badge rather than leave one standing.
   */
  pending_state?: AgencyAgentState;
  /** Present when `pending_state` is `break`. */
  pending_break_reason?: string;
}

/**
 * A `released` the agent's socket was not present to receive.
 *
 * Deliberately **not** an `AgencyStationReleasedFrame`: it is history, not a live
 * transition, and it must not go through the `released` handler. That handler
 * fires the disconnect cue, clears `live` and hands the attempt to wrap-up — all
 * correct for a call ending now, all wrong for one that ended while the socket was
 * away. The missing `event` discriminator is what makes the mistake a compile
 * error rather than a judgement call.
 */
export interface AgencyMissedRelease {
  attempt_id: string;
  reason: AgencyReleaseReason;
  requires_disposition: boolean;
  message: string;
  /** ISO-8601. When the attempt actually ended — which is not now. */
  ended_at: string;
}

/** Attempt lifecycle (`AgencyAttemptState`). */
export type AgencyAttemptState =
  | 'queued'
  | 'dialing'
  | 'ringing'
  | 'answered'
  | 'bridged'
  | 'ended';

/**
 * An attempt a reconnecting socket was found still holding.
 *
 * A superset of `AgencyReservedAttempt`, and the two extra fields live here rather
 * than on the base type **precisely so the `reserved` frame cannot carry them**: on
 * that frame `bridged_at` would be null by construction, and a nullable field that
 * is always null is one someone eventually reads as meaningful.
 *
 * **`bridged_at` is the ringing-vs-live discriminator and there is no client-side
 * substitute.** The dialer runtime does not re-emit `bridged` on reconnect — deliberately, because
 * the connect cue lives in that handler and dedupes per `attempt_id`, and a
 * reconnect after a full page load starts with an empty dedupe set, so a re-emitted
 * frame would play "customer connected" into a conversation nine minutes old
 * Anything waiting for a second `bridged` waits forever.
 */
export interface AgencyActiveAttempt extends AgencyReservedAttempt {
  /**
   * ISO-8601 answer anchor, or `null` while still pre-answer. Non-null ⇒ media is
   * live and the customer may already be speaking.
   */
  bridged_at: string | null;
  /**
   * The attempt's authoritative state, for finer copy than `bridged_at` alone
   * supports — `dialing` and `ringing` are both pre-answer but read differently to
   * an agent watching a panel appear out of nowhere.
   */
  state: AgencyAttemptState;
}

export interface AgencyStationReservedFrame {
  event: 'reserved';
  attempt: AgencyReservedAttempt;
}

/**
 * D5's 3-2-1 auto-connect countdown — **declared by the dialer runtime and emitted by nothing.**
 *
 * Kept in the union on purpose, with no console handler. The contract declares
 * this frame and there is **no `send` of it anywhere in the dialer runtime**:
 * `grep "'countdown'" src/` finds the type, `intervals.countdown_ms`, and
 * prose. Nothing produces one, so a console handler for it would be code that
 * could never run, writing fields nothing read.
 *
 * **Do not re-add a handler from this type.** The auto-connect countdown is a
 * feature that does not exist on either side; building the client half first
 * would make the console look like it works and leave the agent watching a
 * counter that never ticks. If the dialer runtime ever emits this, the handler comes back in
 * the same PR as the emitter.
 *
 * The declaration stays so that the union still describes the wire faithfully and
 * an `event: 'countdown'` on the socket is typed traffic rather than a surprise —
 * `useAgencyStation`'s default arm routes it to diagnostics like any other frame
 * the console does not act on.
 */
export interface AgencyStationCountdownFrame {
  event: 'countdown';
  attempt_id: string;
  seconds_remaining: number;
}

export interface AgencyStationBridgedFrame {
  event: 'bridged';
  attempt_id: string;
  bridged_at: string;
}

export interface AgencyStationReleasedFrame {
  event: 'released';
  attempt_id: string;
  reason: AgencyReleaseReason;
  requires_disposition: boolean;
  message: string;
}

export interface AgencyStationAgentStateFrame {
  event: 'agent_state';
  state: AgencyAgentState;
  /** Present when `state` is `break` — the break in EFFECT, not a queued one. */
  break_reason?: string;
  since: string;
  /**
   * A transition the agent asked for that is accepted but not yet applied — a
   * break requested while `on_call` or `reserved` lands at the end of wrap-up,
   * never mid-conversation.
   *
   * **`undefined` means nothing is queued, and that is load-bearing rather than
   * merely absent.** The dialer runtime's `/break/cancel` emits an `agent_state` with these
   * fields omitted precisely to say the queue is empty (`agency.routes.ts`, "if
   * (cancelled) … send agent_state"), so a console that reads absence as "no
   * change" leaves a pill up for a break the agent already took back.
   *
   * The frame carries this and not just the HTTP response that queued it because
   * **the queue outlives the request**: a supervisor can queue one console
   * never issued, and an agent who queues a break and then loses their socket must
   * still be told about it when the next transition frame lands.
   */
  pending_state?: AgencyAgentState;
  /** Present when `pending_state` is `break`. */
  pending_break_reason?: string;
}

export type AgencyCampaignChangeReason =
  | 'list_exhausted'
  | 'paused_by_supervisor'
  | 'stopped_by_supervisor'
  | 'auto_paused'
  | 'resumed'
  | 'started';

export interface AgencyStationCampaignStateFrame {
  event: 'campaign_state';
  campaign_id: string;
  status: AgencyCampaignStatus;
  reason: AgencyCampaignChangeReason;
  /**
   * Whether the engine will produce further calls for this agent. **Drive the
   * idle copy from this, not from `status`** — deriving the predicate from
   * `status` forces every client to re-derive it and they will disagree.
   */
  dialing: boolean;
  /** Fallback copy for a reason the console does not recognise. */
  message: string;
}

export interface AgencyStationPongFrame {
  event: 'pong';
  ts?: number;
  server_ts: number;
}

export interface AgencyStationErrorFrame {
  event: 'error';
  code: AgencyStationErrorCode;
  message: string;
}

/**
 * Bridge-originated. **Diagnostic only.**
 *
 * `WebRtcBridgeManager` emits these onto the borrowed station socket and the dialer runtime
 * relays them unchanged. They describe the MEDIA LEG, not the attempt — a
 * console that drives UI from them is subtly wrong. In particular
 * `status: 'answered'` means the far end went off-hook, which is NOT the same
 * as audio reaching this agent.
 */
export interface AgencyStationBridgeStatusFrame {
  event: 'status';
  status: string;
}

export interface AgencyStationBridgeEndedFrame {
  event: 'ended';
  reason: string;
}

/**
 * Bridge-originated **audio**, relayed onto the borrowed station socket.
 *
 * This shares an origin with the two frames above and is emphatically NOT
 * diagnostic: it is the customer's voice. `payload` is base64 **PCM16, mono,
 * 16 kHz, little-endian** — the voice engine normalises both carriers to that before it
 * writes to this socket, transcoding VoiceLink's A-law 8 kHz and passing VoBiz's
 * L16 16 kHz through unchanged.
 *
 * The uplink frame is the **same envelope in the same encoding**
 * — the asymmetry is entirely on the voice engine's far
 * side, where it transcodes per carrier. The console therefore has one format to
 * produce and one to consume, and neither depends on which carrier is dialling.
 */
export interface AgencyStationMediaFrame {
  event: 'media';
  media: { payload: string };
}

/**
 * Why wrap-up is being held open rather than counting down. `null` when it is
 * simply running against a deadline.
 */
// `supervisor_hold` means "a supervisor is holding this agent out of the pool
// deliberately"; the console's `WrapupTimer` names it. Nothing produces it yet: no
// code path sets `held_reason: 'supervisor_hold'`.
export type AgencyWrapupHold = 'disposition_required' | 'supervisor_hold';

/**
 * The wrap-up window.
 *
 * **`ends_at` is an ABSOLUTE instant, and the console reads it rather than
 * reconstructing it.** Reconstructing (`since + wrapup_seconds × 1000`) means
 * agreeing with the server about two values *and* the client's own arithmetic;
 * any disagreement between the three shows up as drift. Reading one absolute
 * instant means agreeing about one number, which is what makes "within a second
 * and no drift over a shift" achievable rather than merely likely.
 *
 * **`ends_at: null` is legitimate and means "no deadline — ends when the agent
 * acts". It never means expired.** It occurs when auto-return is off, and when
 * the timer has lapsed into a hold. Rendering it as an elapsed or zero countdown
 * tells the agent they are out of time when they are not.
 */
export interface AgencyWrapupState {
  attempt_id: string;
  /** ISO-8601, absolute. Null ⇒ no deadline; see above. */
  ends_at: string | null;
  requires_disposition: boolean;
  disposition_submitted: boolean;
  /**
   * Why the window is held rather than counting down. Set **at entry** for a
   * timerless wrap-up, not only on a later expiry — there is no countdown that
   * could lapse, so without it the agent would face a panel with no deadline and
   * no reason and nothing to act on.
   */
  held_reason?: AgencyWrapupHold | null;
  /**
   * Whether the window will return the agent to the pool on its own.
   *
   * **Trust this, not the campaign config.** For a timerless wrap-up the dialer runtime reports
   * `false` even when the campaign sets `wrapup_auto_return: true`, because with
   * no window it cannot mean what it says. Echoing the config would pair
   * `auto_return: true` with `ends_at: null`, which is indistinguishable from
   * "the countdown frame failed to arrive" — and the console would render a
   * spinner on a wrap-up that is actually waiting for the agent.
   */
  auto_return: boolean;
}

/**
 * Emitted once, idempotently, when wrap-up opens.
 *
 * **`wrapup_seconds = 0` means "no timer", NOT "no wrap-up"**, and the two cases
 * split on whether a disposition is required:
 *
 * - **Disposition required ⇒ a timerless frame IS emitted**, held from the very
 *   first frame with `ends_at: null` and `held_reason` set, ended only by the
 *   agent submitting or a supervisor forcing return. Panel, no countdown.
 * - **No disposition required ⇒ no frame at all.** This is the case the console
 *   must not hang on: never render a pending wrap-up state off a `released` that
 *   will never be followed by a wrap-up frame.
 *
 * (An earlier reading had zero emitting nothing in both cases. That left a
 * campaign with a required disposition handing the agent straight back to the
 * pool while `released` still said `requires_disposition: true` — no window, no
 * protection, and every attempt sweeping to `no_disposition`.)
 *
 * **Wrap-up *ending* is delivered on `agent_state`, never here.** This frame
 * opens the window and carries its deadline; `agent_state` closes it. One
 * authority for agent state means there is no second frame to race.
 */
export interface AgencyStationWrapupFrame {
  event: 'wrapup';
  wrapup: AgencyWrapupState;
}

export type AgencyStationServerFrame =
  | AgencyStationReadyFrame
  | AgencyStationReservedFrame
  | AgencyStationCountdownFrame
  | AgencyStationBridgedFrame
  | AgencyStationReleasedFrame
  | AgencyStationWrapupFrame
  | AgencyStationAgentStateFrame
  | AgencyStationCampaignStateFrame
  | AgencyStationPongFrame
  | AgencyStationErrorFrame
  | AgencyStationBridgeStatusFrame
  | AgencyStationBridgeEndedFrame
  | AgencyStationMediaFrame;

/**
 * Close codes the dialer runtime uses. The distinction that matters is **re-mint and retry**
 * versus **re-bootstrap**: retrying a dead session forever is indistinguishable
 * from a network problem to the agent, and gives them nothing to act on.
 */
export const AGENCY_STATION_CLOSE = {
  /** Token missing, expired, already used or wrong. Re-mint and retry. */
  TOKEN_REJECTED: 4401,
  /** Session unknown or already left. Re-bootstrap; do not retry this session. */
  SESSION_GONE: 4404,
  /** Superseded by a newer socket for this session. Do not retry. */
  SUPERSEDED: 4409,
} as const;
