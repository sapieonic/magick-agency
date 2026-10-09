// Notes on vocabulary: "the dialer runtime" below means the private handler
// instance reached through `callCore`; "the public API layer" is the main
// Fastify app that validates, authorises and enriches requests. Both live in
// the same application.
/**
 * ─── AGENCY DIALER — FROZEN CONTRACT ────────────────────────────────────────
 *
 * Types only. This module has **no runtime behaviour** — it compiles to nothing —
 * so importing it can never pull the agency engine into a caller's graph.
 *
 * Frozen ahead of Phase 1 because three teams build against it in parallel:
 * the public API layer forwards these shapes, the console renders them, and the
 * tests are written against them. Changing anything here after the freeze is a contract
 * change: announce it, do not just edit it.
 *
 * Authority: the agency dialer design.
 * Where this file and the design disagree, this file is what actually ships;
 * every such divergence is called out in a comment naming the reason.
 *
 * **Phase 2 amendment (the pool).** Everything wrap-up, break, disposition, notes
 * and reconnect needs is frozen in the section at the bottom of this file, plus
 * four *additive* changes to shapes frozen in Phase 1, each marked `P2:` where it
 * appears:
 *   1. `AgencyStationIntervals.deferred_hangup_ms` — new, required. The dialer runtime is the
 *      only producer of this object, so a required field is additive for every
 *      consumer; the console needs it reliably to render a reconnect countdown.
 *   2. `AgencyStationReadyFrame.active_wrapup` / `.missed_release` /
 *      `.pending_state` / `.pending_break_reason` — new, optional. The last two
 *      deliberately reuse the names and types they already carry on
 *      `AgencyStationAgentStateFrame`, so a console that renders a pending-break
 *      badge from one can render it from the other with no new vocabulary.
 *   3. `AgencyStationAgentStateFrame.pending_state` / `.pending_break_reason` — new,
 *      optional. A break requested mid-call is queued, and the console must be able
 *      to say so after a reconnect, not only from the HTTP response that queued it.
 *   4. `AgencyStationServerFrame` gains `AgencyStationWrapupFrame`. The union was
 *      already declared non-exhaustive (the bridge writes its own frames onto this
 *      socket), so a client that ignores an unknown `event` is unaffected.
 * No Phase 1 field changed type, changed meaning, or was removed.
 *
 * Vocabulary note: an **attempt** is one dial. A **session** is one agent's shift
 * on one campaign. A **station socket** is that session's long-lived WebSocket.
 * The station socket outlives every attempt on it — see
 * `WebRtcBridgeManager.createBridgedCall`.
 */

// ─── Shared enumerations ────────────────────────────────────────────────────

/**
 * Agent lifecycle. **Phase 1 implements `offline` / `available` /
 * `reserved` / `on_call` only**; `wrapup` and `break` are declared here so the
 * union never widens later (a widening union is a breaking change for every
 * exhaustive `switch` in the console), and are unreachable until Phase 2.
 */
export type AgencyAgentState =
  | 'offline'
  | 'available'
  | 'reserved'
  | 'on_call'
  | 'wrapup'
  | 'break';

/** Attempt lifecycle. `ended` is the single terminal state. */
export type AgencyAttemptState =
  | 'queued'
  | 'dialing'
  | 'ringing'
  | 'answered'
  | 'bridged'
  | 'ended';

/** Contact lifecycle. */
export type AgencyContactState =
  | 'pending'
  | 'in_flight'
  | 'connected'
  | 'completed'
  | 'exhausted'
  | 'suppressed';

/**
 * How an attempt finished, as classified from carrier events — never from AMD
 * (D1: AMD is out of scope, so the system can never classify an outcome as
 * `machine`; a call answered by voicemail is `connected` and the ONLY signal it
 * was a machine is the agent's disposition).
 *
 * `machine` is nonetheless declared because the schema lists it as a legal column value
 * and a future AMD-enabled version would emit it. Nothing in v1 produces it.
 *
 * ── `canceled`: a dial WE stopped before anyone picked up ───────────────────
 *
 * Three facts that the pilot of 2026-09-08 proved are three, not one:
 *
 *   - `no_answer` — the ring completed and nobody picked up;
 *   - `canceled`  — we stopped the ring ourselves (an agent dismissing a ringing
 *     console, a supervisor stop landing mid-ring), so the customer was never
 *     given the chance to pick up and may not even have finished being rung;
 *   - `abandoned` — the customer DID pick up and reached nobody.
 *
 * Before this member the middle case had nowhere to go and
 * {@link classifyAttemptOutcome}'s `canceled`-status arm sent it to `abandoned`,
 * which is why ~19 of the pilot's abandoned rows are phantoms sitting in the same
 * column as the real ones. It is the *label* that was wrong, not the compliance
 * numerator — that has always been keyed on `isAbandonedAttempt`
 * (`abandonment-predicate.ts`), whose `answeredAt === null` arm already excluded
 * every cancelled ring — so this separates two facts without moving a metric.
 *
 * **No migration is needed for it, and that is a property of the column rather
 * than an oversight.** `agency_call_attempts.outcome` is a bare `VARCHAR(30)`
 * with NO CHECK constraint (`075_agency_attempts.sql:23`); the vocabulary appears
 * there only as a trailing `--` comment, which enforces nothing.
 *
 * ⚠️ **Do not read that comment as the vocabulary.** It says
 * `connected|no_answer|busy|failed|machine|invalid|abandoned` and is wrong in both
 * directions: it lists `machine`, which nothing can produce under D1, and omits
 * `agent_disconnected`, `orphaned` and now `canceled`, all three of which are
 * produced constantly. This union is the vocabulary. Recorded here rather than by
 * amending a shipped migration — a comment-only follow-up migration or a note at
 * the write site is preferred over an in-place edit of an applied migration.
 * Every gate on
 * this string is therefore TypeScript-side, and it is pinned in five places in
 * the server alone — `spine-filters.ts`'s `ATTEMPT_OUTCOMES` (the read surface's
 * inverted `Record` check), `retry-summary.ts`'s `OUTCOME_COPY`,
 * `retry-policy.ts`'s `DEFAULT_RETRY_POLICY`, `campaign-config.ts`'s
 * `RETRY_POLICY_OUTCOMES` and `outcome-classifier.ts` itself — plus the public API layer's
 * `RETRY_POLICY_OUTCOMES` and the console's `src/types/agency.ts`. Adding a member
 * means updating every one of those pins.
 */
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
  | 'canceled';

/**
 * WHY an abandoned attempt reached no agent (migration 119).
 *
 * A companion to {@link AgencyAttemptOutcome}, deliberately NOT a member of it.
 * The outcome vocabulary already says `abandoned` and the retry policy already
 * redials it; what was missing was the cause, and during a staged rollout the
 * causes call for opposite responses — `bind_failed` means roll back the flag,
 * `no_agent_available` means slow the pacing down.
 *
 * ⚠️ **This is diagnosis, never a definition.** The ratified abandonment
 * definition is `ABANDONED_ATTEMPT_PREDICATE_SQL` and its in-process twin, pinned
 * to each other by an agreement test; the compliance numerator keys on that and
 * must not start reading this. `abandon_reason IS NOT NULL` is not a substitute
 * for the predicate — the predicate deliberately catches abandoned attempts that
 * nobody labelled, which is how the gap was found.
 *
 * - `station_lost` — the agent's station was not there at the answer: either gone
 *   before we reached for the socket, or the `reserved` frame was refused. The
 *   two share a value because an operator cannot act on them differently; the
 *   WARN line's `announced` field keeps them apart.
 * - `bind_failed` — the socket was live and the bridge refused the bind. **The
 *   one that means roll the flag back**, as against slow the pacing down.
 * - `bridge_late` — it DID bridge, but outside `ABANDONMENT_BRIDGE_GRACE_MS`. A
 *   conversation happened; it was merely late.
 * - `unattributed` — abandoned by the predicate with no arm having observed a
 *   cause. **The honest residual, and it exists because the alternative caused a
 *   real defect**: the first version fell back to `no_agent_available`, so every
 *   station loss on the default (flag-off) path was reported as a pacing problem.
 *   Asserting a cause we did not observe is worse than admitting we did not.
 * - `no_agent_available` — a pacing controller dialed with nobody free.
 *   ⚠️ **Declared but UNPRODUCIBLE today**, on purpose and in the same spirit as
 *   `machine` in {@link AgencyAttemptOutcome}: pacing is strictly 1:1
 *   (`pacing-engine.ts` reserves agents before claiming contacts and bounds the
 *   target by `reserved.length`), and the dialer refuses to dial at all when the
 *   station has gone (`executeDial`'s pre-dial recheck). So no "we dialed and
 *   nobody was free" event can occur until over-dialing is built. Kept because it
 *   is the name for the thing an operator will need then — but note `machine`'s
 *   lesson: do not build configuration on an unproducible value.
 */
export type AgencyAbandonReason =
  | 'station_lost'
  | 'bind_failed'
  | 'bridge_late'
  | 'unattributed'
  | 'no_agent_available';

/**
 * The reason vocabulary as a value, for the Prometheus label set and any UI that
 * enumerates it.
 *
 * Two-sided exhaustiveness, the house pattern (`AGENCY_ACTION_ERROR_CODES`):
 * `satisfies` stops a member being listed that the union does not have, and
 * {@link MissingAbandonReason} stops a union member being added without landing
 * here. A Prometheus label vocabulary must be bounded by source code.
 */
export const AGENCY_ABANDON_REASONS = [
  'station_lost',
  'bind_failed',
  'bridge_late',
  'unattributed',
  'no_agent_available',
] as const satisfies readonly AgencyAbandonReason[];

type MissingAbandonReason = Exclude<
  AgencyAbandonReason, (typeof AGENCY_ABANDON_REASONS)[number]
>;
const _allAbandonReasonsListed: MissingAbandonReason extends never
  ? true : MissingAbandonReason = true;
void _allAbandonReasonsListed;

/** Campaign lifecycle. */
export type AgencyCampaignStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'completed'
  | 'stopped';

// ─── Campaign-derived config the agent console needs ────────────────────────

/**
 * One entry in `agency_campaigns.disposition_catalog`.
 *
 * Precedence, stated once because it is easy to get backwards: a disposition's
 * `retry` / `terminal` / `suppress` **always** overrides the campaign's
 * outcome-keyed retry policy. The outcome policy applies only when no disposition
 * was recorded.
 *
 * Three codes are built in and cannot be removed from a catalog — `voicemail`,
 * `callback`, `do_not_call` — because the retry engine, the scheduler and the DNC
 * path each depend on one of them existing.
 */
export interface AgencyDisposition {
  code: string;
  label: string;
  /** Counts toward the campaign's success rate. */
  is_success?: boolean;
  /** The console must block submission until `notes` is non-empty. */
  requires_note?: boolean;
  /** The console must collect a datetime; it becomes `callback_at`. */
  requires_datetime?: boolean;
  /** Contact is done — no further attempts regardless of the outcome policy. */
  terminal?: boolean;
  /** Contact is suppressed immediately (the `do_not_call` code's mechanism). */
  suppress?: boolean;
  /** Disposition-driven retry — this is how voicemail retry works under D1. */
  retry?: { delay_minutes?: number; max_attempts: number };
}

/**
 * Which of a contact's arbitrary CSV columns matter, and in what order
 * (`agency_campaigns.context_display`, migration 072).
 *
 * The schema stores every non-phone CSV column unchanged and deliberately schemaless —
 * which is right for ingest and useless for rendering: a 41-column export gives
 * the agent a 41-row table with no signal about which four rows decide the call.
 * This is the operator's answer to that, set at campaign build time.
 *
 * Resolution rules the console must implement, so two clients agree:
 *  1. `hero` renders first, pinned, in array order — these are the columns the
 *     agent reads while the phone is ringing.
 *  2. then any column named in `order`, in array order;
 *  3. then every remaining column, in the CSV's original header order;
 *  4. minus anything in `hidden`, at every stage.
 * A name appearing in more than one list is resolved by that precedence, so a
 * column in both `hero` and `hidden` is hidden.
 * An empty/absent value means "no operator opinion" — render every column in
 * original CSV order.
 */
export interface AgencyContextDisplay {
  /** Pinned above the table, in order. Keep it to ~4; the console may cap it. */
  hero?: string[];
  /** Preferred order for the remaining columns. */
  order?: string[];
  /** Never rendered. PII the agent has no need to see, internal keys, etc. */
  hidden?: string[];
}

/**
 * A break reason offered to the agent. Phase 1 does not implement `break`
 * (it is out of scope), but bootstrap advertises the catalog from day one so the console
 * builds the menu once rather than twice.
 *
 * **P2:** this list is campaign config (`agency_campaigns.break_reasons`, migration
 * 078) and is the *only* authority on which codes `POST /sessions/:id/break` will
 * accept — an unknown code is rejected with `unknown_break_reason` and the valid
 * set echoed back. A campaign that configures none is served a built-in default
 * list rather than an empty menu, because a break control with no reasons is a
 * control the agent cannot use; the built-ins are ordinary rows in this array and
 * carry no special status.
 */
export interface AgencyBreakReason {
  code: string;
  label: string;
  /**
   * **P2, advisory.** Whether time in this break counts as paid/available-adjacent
   * for the operator's own reporting. It is stored and echoed; nothing
   * branches on it. Present so the catalog does not need a second shape later.
   */
  is_paid?: boolean;
}

// ─── POST /api/v1/agency/sessions — session bootstrap ───────────────────────

export interface AgencyCreateSessionRequest {
  campaign_id: string;
  /**
   * **Which agent is joining.** The public API layer's user id, supplied by the public API layer from the
   * authenticated session (`resolveAgencyActor`) — never by the browser, which
   * could otherwise join a campaign as somebody else.
   *
   * Declared here because the handler in `agency.routes.ts` hard-requires it. An
   * interface that named only `campaign_id`/`session_id` would let the public API
   * layer build its schema against the contract, Zod stripped the
   * unknown key, and **every session create 400'd — no agent could join a
   * campaign at all.** The public API layer was right and the dialer runtime's own contract was the thing
   * lying; the fix is to say what the handler means rather than to relax it.
   *
   * ── Why the dialer runtime does not derive it instead ──────────────────────────────────
   * Same objection that settled the DNC path: a supervisor acting for an agent
   * would be recorded as that agent, and on a record that follows a customer a
   * confidently-wrong actor is worse than an absent one.
   *
   * ── Why this is NOT `extends AgencyActorFields` ──────────────────────────
   * That shape carries `on_behalf`, which is meaningful only for an action *on
   * an attempt* — a supervisor can disposition a call another agent took. There
   * is no equivalent for joining: a supervisor cannot go available as somebody
   * else, so an `on_behalf` here would have no rule to feed and no meaning to
   * carry. See `AgencyDncRequest` for the mirror-image case where the field genuinely is
   * owed.
   */
  agent_user_id: string;
  /**
   * Optional resume hint. The dialer runtime rehydrates from `agency_agent_sessions` regardless
   * (D2: a restart drops every socket, and sessions are rehydrated rather than
   * recreated), so this only lets the client assert which session it thinks it had.
   */
  session_id?: string;
}

/**
 * Everything the agent console needs to render itself, in ONE response.
 *
 * This is deliberately fat. The alternative — bootstrap thin, then fetch the
 * catalog / display config / intervals separately — puts HTTP requests on the
 * path between "agent goes available" and "first call arrives", and the context-push ordering
 * guarantee has no tolerance for that. Everything here is campaign config that
 * cannot change mid-session without a new session.
 */
export interface AgencySessionBootstrap {
  session_id: string;
  campaign_id: string;
  campaign_name: string;
  /** the public API layer's user id, echoed back — the dialer runtime never resolves it to a name (D3). */
  agent_user_id: string;

  /**
   * The agent's state as the dialer runtime sees it right now.
   *
   * After a restart of the dialer runtime or the public API layer this is `break`, never `available` (D2) — the
   * engine must not dial into a pool that has not demonstrably re-attached, so the
   * agent clicks once to go available. On a first join it is `offline`.
   * **Phase 1 note:** `break` is not implemented as a transition an agent can
   * request, but it IS the state a rehydrated session lands in.
   */
  state: AgencyAgentState;
  campaign_status: AgencyCampaignStatus;

  /** Absolute wss:// URL for the station socket, token already appended. */
  station_ws_url: string;
  /**
   * ISO-8601 expiry of the token embedded in `station_ws_url`.
   *
   * **The token authenticates the UPGRADE, not the session.** Once the socket is
   * open and bound to this session, the socket itself is the credential — so the
   * token is deliberately short-lived (~2 minutes) and **single-use**, and a
   * leaked URL is worthless almost immediately.
   *
   * This resolves a fork that has no good answer otherwise: a shift-length token
   * is a bearer credential sitting in a query string for eight hours, and a
   * short-lived one would force a full re-bootstrap on every wifi blip. Neither is
   * acceptable. Splitting upgrade auth from session lifetime gives short-lived
   * secrets *and* cheap reconnects — the console re-mints via
   * `POST /agency/sessions/:id/station-token` (an ordinary authenticated HTTP call
   * the browser CAN carry a bearer on) and reconnects, without re-sending this
   * bootstrap. It is also why there is no `reauth` control frame: nothing needs
   * re-authenticating on a socket that is already bound.
   *
   * A browser `WebSocket` cannot set an `Authorization` header, so the public API layer cannot
   * authenticate the upgrade at all — **this token is the only authority on that
   * connection.** Refresh *before* this instant rather than discovering expiry on
   * a failed reconnect.
   */
  station_token_expires_at: string;

  // ── Campaign config the console renders with ──
  disposition_catalog: AgencyDisposition[];
  /** Seconds of wrap-up after a call. `0` = no wrap-up. Phase 2. */
  wrapup_seconds: number;
  /** Whether wrap-up auto-returns the agent to `available` on expiry. Phase 2. */
  wrapup_auto_return: boolean;
  /** Whether calls on this campaign are recorded — the console must disclose it. */
  record_calls: boolean;
  break_reasons: AgencyBreakReason[];
  context_display: AgencyContextDisplay;

  /**
   * Timing the client must obey rather than hardcode. All milliseconds.
   *
   * These are liveness parameters only. **No business timeout appears here and
   * none may be implemented as a Redis TTL**: ring timeout, wrap-up length
   * and max call duration live in the attempt row, because a TTL cannot
   * distinguish "took too long" from "the process died".
   */
  intervals: AgencyStationIntervals;

  /**
   * Present ONLY when this campaign is a retry of another one
   * (`agency_campaigns.retry_generation > 0`). Absent for every ordinary
   * campaign, so nothing changes for the 100% case.
   *
   * ── Why here and not on the `reserved` frame ─────────────────────────────
   *
   * It is campaign-CONSTANT. Putting it on `AgencyStationReservedFrame` would
   * repeat it once per dial for the whole of an agent's shift, on the one payload
   * whose latency the design guards hardest — everything on that frame is
   * gathered synchronously before the dial, and the only thing on it that varies
   * per attempt is the contact. This varies per SESSION, and the bootstrap is the
   * per-session payload.
   *
   * ── What the agent is given, and what they are deliberately not ──────────
   *
   * A one-line banner above the contact panel, plus the lineage-scoped
   * `prior_attempts` they already receive. NOT the parent's stats, connect rate,
   * roster counts or agent roster. The `agent` role is level 5 with exactly four
   * `agency.*` permissions (RBAC decision D6) and this feature must not become
   * the reason someone raises it — every field here is campaign-descriptive copy
   * about the campaign the agent is joined to.
   */
  retry_context?: AgencyRetryContext;
}

/**
 * The agent console's retry banner: *Retry 1 of "Q3 Winback" — these contacts
 * were previously voicemail, callback, no answer*.
 */
export interface AgencyRetryContext {
  /** 1 = the first retry of an ordinary campaign. Never 0 — the field is absent then. */
  generation: number;
  /**
   * The parent campaign's name.
   *
   * `parent_campaign_id` is `ON DELETE SET NULL` (migration 111), so a campaign
   * can legitimately be a retry whose parent no longer exists. The dialer runtime serves a
   * neutral placeholder in that case rather than dropping the banner: "this is a
   * second pass over a selection" stays true and useful even when the campaign it
   * came from is gone.
   */
  parent_campaign_name: string;
  /**
   * Human rendering of the frozen `retry_selector`, built server-side.
   *
   * Built here — not composed by the console from the raw selector — so the copy
   * the agent reads and the query that actually produced the roster cannot
   * disagree. It is the campaign's own fact, exactly as migration 108's header
   * argues for the lifecycle columns.
   *
   * The rendering rules are fixed: the selected
   * `last_disposition` labels (from the PARENT's catalog where a label exists,
   * else the raw code), then the `last_outcome` values in the console's own
   * outcome copy, then `never attempted` — in that order, comma-separated.
   */
  selection_summary: string;
}

/**
 * The `409` alternative to {@link AgencySessionBootstrap} on
 * `POST /api/v1/agency/sessions`.
 *
 * Returned when the agent already holds a LIVE session on a **different**
 * campaign in the same tenant. Since migration 092 the database permits one live
 * session per (tenant, agent) — the reservation CAS key is per session
 * (`agency:agent:{sessionId}:state`) while a human has one pair of ears, so two
 * live sessions mean two pacing engines bridging two customers into one headset.
 *
 * ── The whole payload exists to be RENDERED, not logged ────────────────────
 * The public API layer forwards this unchanged — status and body, no re-shaping, no
 * special-casing (it already sits inside a `reply.code(result.status).send(result.body)`
 * path) — and the console renders it as the only actionable form of this refusal:
 * "You're still joined to <campaign_name> (<state>). Leave that station first."
 * That is why the campaign's NAME is resolved here rather than left as an id:
 * the dialer runtime is the only party that can cheaply resolve it, and an id in a dialog is
 * an error message the agent cannot act on.
 *
 * ── Why this EXTENDS `AgencyActionErrorResponse` rather than standing beside it ──
 * A second error shape on the same agency routes is how the two vocabularies
 * drift apart, and `AgencyActionErrorResponse` already has exactly this pattern:
 * `allowed_codes` is a code-specific extra that only three of its members set.
 * `campaign_id` / `campaign_name` / `state` are the same thing for one member.
 *
 * The consequence that decided it is `message`. The public API layer's error mask is keyed on
 * `AGENCY_ACTION_ERROR_CODES`, and unless this code is listed there the mask
 * rewrites the body into "contact support and quote this request id" — so a
 * structured-fields-only payload degrades to no explanation at all. `message` is
 * the FLOOR: a sentence that stands on its own in any generic error handler that
 * has never heard of this code. The structured fields are the ceiling — the console
 * composes richer copy from them, and should, but nothing depends on it doing so.
 *
 * Reassignment deliberately does NOT resolve itself: the public API layer moves only its own
 * assignment row and never touches a live session, so nobody is yanked off a
 * call. This 409 plus the console's Leave-station control is the escape hatch.
 */
export interface AgencySessionCampaignConflict extends AgencyActionErrorResponse {
  code: 'session_on_other_campaign';
  /** The campaign they are still joined to — NOT the one they asked for. */
  campaign_id: string;
  campaign_name: string;
  /**
   * Their agent state on that campaign, read from Redis rather than the durable
   * mirror (Redis is the authority on agent liveness). It is what makes
   * both `message` and the console's own copy honest about whether leaving is
   * safe right now: `on_call` means finish the call, `break` means one click.
   */
  state: AgencyAgentState;
}

export interface AgencyStationIntervals {
  /** How often the client sends `ping`. Design: 10s. */
  heartbeat_ms: number;
  /**
   * How long the dialer runtime waits before declaring the socket dead. Design: 3 missed pings
   * (30s), against a 45s `available`/`break` lease.
   *
   * Enforced by the silent-station sweep, which closes such a socket with `4408`.
   * `STATION_HEARTBEAT_GRACE_MS` in `agency/timers.ts` is the single source of the
   * value served here, so the advertised number and the enforced one cannot drift.
   */
  heartbeat_grace_ms: number;
  /** The `reserved`→dial lease. Design: 10s. Informational; the dialer runtime enforces it. */
  reservation_lease_ms: number;
  /** D5's auto-connect countdown before audio bridges. Design: 3000. */
  countdown_ms: number;
  /**
   * **P2, new and required.** How long the dialer runtime holds a live call open after the
   * station socket drops, waiting for the same session to reconnect and re-adopt
   * it. Reconnect inside this window resumes the call with audio
   * intact; outside it the call has already been torn down with
   * `outcome='agent_disconnected'`.
   *
   * **This is an in-process timer on the owning replica, never a Redis TTL** — a
   * TTL cannot distinguish "took too long" from "the process died", and if
   * the process died there is no bridge left to resume onto anyway. It is
   * advertised only so the console can render an honest "reconnecting — 12s"
   * countdown instead of retrying blindly into a call that is already gone.
   */
  deferred_hangup_ms: number;
}

// ─── The station socket envelope ────────────────────────────────────────────
//
// One socket carries three multiplexed streams: agency control frames, the
// caller's heartbeat, and raw media relayed by the WebRTC bridge.
//
// **Consumers must not write an exhaustive switch that assumes only agency
// frames.** The bridge borrows this socket per attempt and emits its own
// `status` and `ended` frames onto it from `WebRtcBridgeManager.notifyBrowser` —
// the station handler does not intercept or rewrite them, so they arrive unchanged. This was
// found while implementing Phase 0 and is the single most likely thing to break a
// client written from the design alone, which does not mention it.
//
// Every frame is JSON with an `event` discriminant. Non-JSON frames are ignored.

/**
 * Frames the agent console sends to the station handler.
 *
 * **Only `ping` and `media` are read.** `AgencyStationHangupFrame` is retained in
 * the union deliberately — it is what a client was told to send, so removing it
 * outright would turn a documented no-op into a type error with no explanation
 * attached. It carries its own `@deprecated` and the enumeration that proved it
 * dead.
 */
export type AgencyStationClientFrame =
  | AgencyStationPingFrame
  | AgencyStationMediaFrame
  | AgencyStationHangupFrame;

/** Liveness. Renews the agent's lease; three misses and the agent goes offline. */
export interface AgencyStationPingFrame {
  event: 'ping';
  /** Client clock, epoch ms. Echoed in `pong` for RTT measurement. Optional. */
  ts?: number;
}

/**
 * Outbound audio: base64 PCM16 @ 16kHz, matching the existing browser dialer's
 * frame exactly. The bridge transcodes per provider; the console does not.
 * Frames sent while no attempt is bridged are dropped by the dialer runtime, not an error.
 */
export interface AgencyStationMediaFrame {
  event: 'media';
  media: { payload: string };
}

/**
 * **WITHDRAWN. Do not send this frame; nothing reads it.**
 *
 * Kept as a named type only so the union below can document the gap rather than
 * quietly dropping a shape clients were told to build against.
 *
 * It was never implemented. Enumerated 2026-08-12: the station socket carries
 * exactly two `message` listeners while an attempt is live —
 * `agency.routes.ts`'s own, which acts only on `event === 'ping'`, and the
 * bridge's borrowed-leg listener (in `webrtc-bridge-manager.ts`, `onBrowserMessage`), which acts only on `event === 'media'`. A `hangup` frame
 * fell off the end of both, silently. No HTTP route existed either, so
 * the public API layer's forward 404'd and **an agent could not hang up by any advertised path.**
 *
 * The route is now real, and this stays withdrawn rather than being implemented
 * alongside it. Two surfaces for one action means two ownership checks to keep in
 * step, and this one cannot carry an actor at all: the socket authenticates the
 * *session*, so a supervisor's `on_behalf` hangup has nowhere to live. A control
 * frame also returns no status, which is why the console's HTTP call is the one the
 * console can actually act on.
 *
 * @deprecated Use `POST /api/v1/agency/attempts/:id/hangup`.
 */
export interface AgencyStationHangupFrame {
  event: 'hangup';
  attempt_id: string;
}

/** Frames the dialer runtime sends to the agent console. */
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
 * Sent once, immediately on socket open, after session rehydration.
 *
 * **P2 — this frame is how a reconnect is explained.** A dropped socket that comes
 * back inside `intervals.deferred_hangup_ms` finds its call still live; one that
 * comes back after it finds the call settled. The console must be able to tell
 * those apart without guessing, so both cases are answered here: `active_attempt`
 * present ⇒ resumed, `missed_release` present ⇒ the attempt ended while the socket
 * was away and the agent never saw the `released` frame that said so.
 *
 * **The dialer runtime does NOT re-emit `bridged` after this frame, deliberately.** An earlier
 * draft of this contract said it would, so that a reconnecting console could
 * restore its live panel through the ordinary code path. That was wrong, and the
 * reason is a client concern that turns out to be binding on the dialer runtime: the `bridged`
 * handler schedules the audible connect cue. The cue is deduped per `attempt_id`,
 * but a reconnect that follows a full page load starts with an empty dedupe set —
 * so a re-emitted `bridged` would play a "customer connected" cue in the middle of
 * a conversation already in progress. {@link AgencyActiveAttempt.bridged_at} is the
 * authority for a resumed panel instead. `attempt_id` is present on both this
 * payload and the `reserved` frame's, so the client's dedupe key is stable across
 * the two either way.
 */
export interface AgencyStationReadyFrame {
  event: 'ready';
  session_id: string;
  state: AgencyAgentState;
  /** Set when the socket reconnected onto an attempt that is still live. */
  active_attempt?: AgencyActiveAttempt;
  /**
   * **P2.** Set when the reconnecting socket is in `wrapup` — the console needs the
   * absolute deadline to resume the countdown, and a wrap-up that survived a
   * reconnect is the common case, not an edge one.
   */
  active_wrapup?: AgencyWrapupState;
  /**
   * **P2.** The `released` this session missed while it was disconnected. Without
   * it, an agent who drops mid-call and reconnects sees an empty console and no
   * account of the call they were just on — which reads as data loss.
   */
  missed_release?: AgencyMissedRelease;
  /**
   * **P2.** A transition the agent asked for that is accepted but not yet applied —
   * the same field, with the same meaning and type, as on
   * {@link AgencyStationAgentStateFrame}. `undefined` means nothing is queued.
   *
   * **Why it has to be here too.** A queued break is announced exactly twice: once
   * on the HTTP response that queued it, once on the `agent_state` frame that
   * accompanies it. Both are gone by the time a dropped socket comes back, and the
   * next authoritative `agent_state` for that agent is the one `releaseAgent`
   * emits at the *end* of wrap-up — by which point the break has already been
   * applied. So a socket that reconnects mid-wrap-up used to be told its state and
   * its countdown and nothing about the break waiting behind them, while
   * `releaseAgent` went on to apply it anyway: the agent is pulled out of the pool
   * by a request their console has forgotten making.
   *
   * Carried on `ready` rather than answered with a synthetic `agent_state` after
   * attach, because that frame's `since` is the instant of a transition and a
   * reconnect is not one — nothing records when the break was queued, so the
   * timestamp would have to be invented, and `ready` already reports the state this
   * would repeat.
   */
  pending_state?: AgencyAgentState;
  /** **P2.** Present when `pending_state` is `break`. */
  pending_break_reason?: string;
}

/**
 * An attempt a reconnecting socket was found still holding (P2).
 *
 * A superset of {@link AgencyReservedAttempt} — everything the panel needs, plus
 * the two fields that only mean anything when you are re-joining an attempt in
 * progress rather than being handed a fresh one. They live here instead of on
 * `AgencyReservedAttempt` precisely so the `reserved` frame cannot carry them: on
 * that frame `bridged_at` would be null by construction, and a nullable field that
 * is always null is a field someone eventually reads as meaningful.
 *
 * **`bridged_at` is the ringing-vs-live discriminator, and it has to come from the
 * authoritative side.** Without it a reconnected console can only guess, and both
 * guesses are bad: show "connected" and the agent starts talking to a phone that is
 * still ringing, or show "ringing" and they sit silent through a live customer's
 * hello. This is the same seam the deferred-hangup timer works across.
 */
export interface AgencyActiveAttempt extends AgencyReservedAttempt {
  /**
   * ISO-8601 answer anchor, or `null` while the attempt is still pre-answer.
   * Non-null ⇒ media is live and the customer may already be speaking. Matches the
   * `bridged` frame's `bridged_at` for the same attempt.
   */
  bridged_at: string | null;
  /**
   * The attempt's authoritative state, for finer copy than `bridged_at` alone
   * supports — `dialing` and `ringing` are both pre-answer but read differently to
   * an agent watching a panel appear out of nowhere.
   */
  state: AgencyAttemptState;
}

/**
 * A `released` the agent's socket was not present to receive (P2).
 *
 * Deliberately a subset of {@link AgencyStationReleasedFrame} plus `ended_at`: it
 * is history, not a live transition, and a console that fed it through the same
 * handler as a live `released` would re-run whatever that handler does on arrival
 * (stop timers, clear audio) against an attempt that is already long gone.
 */
export interface AgencyMissedRelease {
  attempt_id: string;
  reason: AgencyReleaseReason;
  requires_disposition: boolean;
  message: string;
  /** ISO-8601. */
  ended_at: string;
}

/**
 * **The context push.** The ordering guarantee lives entirely in this frame.
 *
 * Emitted synchronously at reservation — in the same tick, before the dial is
 * placed and therefore before the carrier can possibly answer. It is not emitted
 * on answer, and not from an async continuation: the decisive test answers the
 * carrier synchronously within the dial tick, which a 3-second ring would
 * otherwise hide. The ordering is structural, not a race we usually win.
 *
 * The console renders the panel immediately in a "connecting" visual state. The
 * agent therefore reads the contact *while it rings* — strictly better than the
 * "before or simultaneously with audio connect" requirement.
 */
export interface AgencyStationReservedFrame {
  event: 'reserved';
  attempt: AgencyReservedAttempt;
}

export interface AgencyReservedAttempt {
  attempt_id: string;
  campaign_id: string;
  campaign_name: string;
  contact_id: string;
  /** E.164, as dialed. */
  phone_e164: string;
  /** The caller ID this attempt dials from, for agent reference. */
  caller_id: string;
  /** 1-based. */
  attempt_number: number;
  /**
   * Every non-phone CSV column unchanged, original headers as keys. Render it with
   * `AgencyContextDisplay`. Values are whatever the CSV held — always treat as
   * untrusted display text, never as markup.
   */
  context: Record<string, unknown>;
  /** Prior attempts on this contact, newest first. Empty on a first dial. */
  prior_attempts: AgencyPriorAttempt[];
}

/**
 * One earlier dial of the same person, as the agent's panel renders it.
 *
 * ── The set this is drawn from is the LINEAGE, not the contact row ──────────
 *
 * Since retry campaigns landed, `prior_attempts` spans every campaign in the
 * contact's chain (`agency_contacts.root_contact_id`, migration 112), newest
 * first, capped at `PRIOR_ATTEMPT_LIMIT`. That is what makes the last three
 * fields necessary rather than decorative:
 *
 *  - `attempt_number` is PER CONTACT ROW and **resets in every retry campaign**
 *    (a retry is a fresh allowance, which is the point of authoring one).
 *    So "attempt 2" means nothing once attempts come from two campaigns, and the
 *    repository orders by `ended_at` rather than by this number for the same
 *    reason. It stays on the payload because it is still the honest answer to
 *    "which dial of this roster row was it".
 *  - `campaign_id` / `campaign_name` are what make the list readable: the console
 *    groups by campaign, this one first, then ancestors.
 *  - `dialed_at` exists because `attempt_number` is no longer a global ordering
 *    and `ended_at` is NULL on an attempt that never ended (reaped, orphaned) —
 *    so without it a row can carry no time at all.
 *
 * ⚠️ `disposition_code` is resolved against the CURRENT campaign's
 * `disposition_catalog`, which a parent's code may not appear in. The console
 * must fall back to the raw code beside the campaign name rather than rendering
 * it unlabelled — and must NOT be shipped the parent's catalog to fix it (see
 * `AgencySessionBootstrap.retry_context`).
 */
export interface AgencyPriorAttempt {
  attempt_number: number;
  outcome: AgencyAttemptOutcome | null;
  disposition_code: string | null;
  notes: string | null;
  /** ISO-8601. */
  ended_at: string | null;
  /** The campaign this attempt was placed on — not necessarily the current one. */
  campaign_id: string;
  /** That campaign's name, resolved dialer-runtime-side; the console has no way to. */
  campaign_name: string;
  /** ISO-8601, or null if the attempt never dialled (refused a pre-dial gate, reaped). */
  dialed_at: string | null;
}

/** D5's 3-2-1 auto-connect countdown. Emitted once per remaining second. */
export interface AgencyStationCountdownFrame {
  event: 'countdown';
  attempt_id: string;
  seconds_remaining: number;
}

/** Audio is live. The console switches the panel to its live state. */
export interface AgencyStationBridgedFrame {
  event: 'bridged';
  attempt_id: string;
  /** ISO-8601 answer anchor — the console's talk timer should count from here. */
  bridged_at: string;
}

/**
 * The attempt is over and the agent is free. **Always carries a `reason`.**
 *
 * Without a
 * reason the console can only blank the panel, and an agent whose screen clears
 * with no explanation concludes the app is broken — which is a support ticket per
 * unanswered call, at volume. Every field below exists so the console can say
 * something true.
 */
export interface AgencyStationReleasedFrame {
  event: 'released';
  attempt_id: string;
  reason: AgencyReleaseReason;
  /**
   * Whether the dialer runtime expects a disposition for this attempt. True only when the call
   * actually reached the agent; a `no_answer` needs no disposition. When true the
   * console must keep the panel up and prompt.
   */
  requires_disposition: boolean;
  /** Human-readable fallback copy. The console should prefer its own per-reason
   *  copy and use this only for a reason it does not recognise. */
  message: string;
}

/**
 * Why an attempt released the agent. Exhaustive by construction: the console
 * must render copy for each, and an unrecognised value must fall back to
 * `message` rather than blanking.
 */
export type AgencyReleaseReason =
  /** Conversation happened and ended normally. Disposition expected. */
  | 'completed'
  /** Rang out. No disposition expected. */
  | 'no_answer'
  /** Carrier reported busy. */
  | 'busy'
  /** Carrier rejected or the dial errored. */
  | 'failed'
  /** Number is not dialable — the contact is suppressed, not retried. */
  | 'invalid'
  /** Answered with no agent to bridge to. Near-unreachable under D1. */
  | 'abandoned'
  /** The agent's own socket dropped mid-call and the carrier leg was torn down. */
  | 'agent_disconnected'
  /** The 10s reserve→dial lease lapsed before the dial went out. */
  | 'reservation_expired'
  /** The agent hung up. */
  | 'agent_hangup'
  /** The customer hung up. */
  | 'remote_hangup'
  /** A supervisor or the campaign lifecycle took the attempt away. */
  | 'campaign_paused'
  | 'campaign_stopped'
  | 'supervisor_released'
  /** The reaper found the attempt stranded by a crash. */
  | 'orphaned';

/** Authoritative agent-state transition. The console must not infer state. */
export interface AgencyStationAgentStateFrame {
  event: 'agent_state';
  state: AgencyAgentState;
  /** Present when `state` is `break`. */
  break_reason?: string;
  /** ISO-8601. */
  since: string;
  /**
   * **P2.** A transition the agent asked for that has been accepted but not yet
   * applied — a break requested while `on_call` takes effect at the end of wrap-up
   *, never mid-conversation.
   *
   * This exists on the *frame* and not only on the HTTP response that queued it
   * because the queue outlives the request: an agent who queues a break and then
   * loses their socket must still see "break pending" when they come back, and a
   * supervisor action could queue one console never issued. `undefined` means
   * nothing is queued — a console that only ever reads the HTTP response will show
   * a stale badge after any reconnect.
   */
  pending_state?: AgencyAgentState;
  /** **P2.** Present when `pending_state` is `break`. */
  pending_break_reason?: string;
}

/**
 * The campaign this agent is working changed state.
 *
 * **Why this is a push frame and not just a field on bootstrap.** `campaign_status`
 * in {@link AgencySessionBootstrap} is delivered once, at join. An agent sitting
 * `available` with no attempt is outside every other frame's reach: `released`
 * only reaches an agent who *had* an attempt taken away. Without this frame, the
 * moment a campaign drains, every idle agent keeps staring at a screen that will
 * never produce another call, believing the engine is still dialing for them.
 *
 * That is not an edge case — **list exhaustion is the normal end of every run**,
 * including a 50-row test list, and it happens with or without a supervisor UI.
 *
 * Emitted by the pacing leader, which is the only thing that knows a campaign has
 * drained, and broadcast to every agent on that campaign.
 */
export interface AgencyStationCampaignStateFrame {
  event: 'campaign_state';
  campaign_id: string;
  status: AgencyCampaignStatus;
  reason: AgencyCampaignChangeReason;
  /**
   * Whether the engine will produce further calls for this agent. The single
   * boolean the console should drive its idle state from — `status` alone forces
   * every client to re-derive the same predicate, and they will disagree.
   */
  dialing: boolean;
  /** Fallback copy for a reason the console does not recognise. */
  message: string;
}

/**
 * Why the campaign changed state. `status` alone is not enough: `paused` by a
 * supervisor and `paused` by the Phase 4 abandonment guardrail are the same status
 * and very different messages to a human, and they will coexist.
 */
export type AgencyCampaignChangeReason =
  /** Every contact is done. The normal end of a run. */
  | 'list_exhausted'
  | 'paused_by_supervisor'
  | 'stopped_by_supervisor'
  /** Phase 4: the rolling abandonment ceiling tripped. */
  | 'auto_paused'
  | 'resumed'
  | 'started';

export interface AgencyStationPongFrame {
  event: 'pong';
  /** Echoed from `ping.ts` when the client sent one. */
  ts?: number;
  /**
   * Server clock at the instant the `ping` ARRIVED, epoch ms — not when the pong
   * was sent. The console derives its clock offset as `server_ts - (ts + rtt/2)`
   * with `rtt` measured entirely client-side, so anything stamped later than
   * arrival over-states the offset by however long the server took to answer. That
   * is a primary-key read plus a Redis read on the ordinary path, and the whole
   * station setup for the ping a console fires the moment its socket opens.
   */
  server_ts: number;
}

/** A control frame was rejected. Never fatal on its own; the socket stays open. */
export interface AgencyStationErrorFrame {
  event: 'error';
  code: AgencyStationErrorCode;
  message: string;
}

export type AgencyStationErrorCode =
  | 'unauthorized'
  | 'unknown_attempt'
  /** The caller is not the reserved agent for that attempt. */
  | 'not_your_attempt'
  | 'invalid_frame'
  | 'campaign_not_running';

/**
 * ── Bridge-originated. NOT generated by the agency layer. ──
 *
 * `WebRtcBridgeManager` emits these onto the borrowed station socket for the
 * duration of an attempt (`notifyBrowser`). They are relayed unchanged. Treat them
 * as diagnostic: `bridged` / `released` above are the authoritative agency
 * signals, and a console that drives its UI from `status`/`ended` will be subtly
 * wrong, because they describe the *media leg*, not the *attempt*.
 */
export interface AgencyStationBridgeStatusFrame {
  event: 'status';
  status:
    | 'initiating' | 'ringing' | 'in_progress' | 'completed'
    | 'failed' | 'no_answer' | 'busy' | 'canceled'
    | 'answered' | 'ending';
}

/** Bridge-originated media teardown. See the note on the status frame. */
export interface AgencyStationBridgeEndedFrame {
  event: 'ended';
  reason: string;
}

/**
 * `POST /api/v1/agency/sessions/:id/station-token` — mint a fresh upgrade token.
 *
 * Deliberately cheap and separate from bootstrap: a reconnect needs a new token,
 * not the whole campaign config again. Safe to call before every connect attempt.
 */
export interface AgencyStationTokenResponse {
  session_id: string;
  station_ws_url: string;
  /** ISO-8601. Single-use, and short — see `station_token_expires_at`. */
  expires_at: string;
}

/**
 * Close codes the dialer runtime uses on the station socket, in the private-use range.
 *
 * The distinction that matters to the console is **re-mint and retry** versus
 * **re-bootstrap**: retrying a dead session forever looks identical to a network
 * problem from the agent's side, and gives them nothing to act on.
 */
export type AgencyStationCloseCode =
  /** Token missing, expired, already used, or wrong. Re-mint and retry. */
  | 4401
  /** Session unknown or already left. Re-bootstrap; do not retry this session. */
  | 4404
  /**
   * No client `ping` for `heartbeat_grace_ms`. Re-mint and retry.
   *
   * Mirrors HTTP 408 as the neighbours mirror 401/404/409. It is the enforcement
   * of a field this contract has always advertised, and it exists so that an
   * orphaned socket has a recovery path: a console whose heartbeat timer died
   * while its socket stayed open is, from the station handler's side, indistinguishable from an
   * agent who walked away — and until something closed it, nothing made the
   * console notice. A client that does not recognise the code must fall through to
   * its ordinary retry, which is what makes this safe to ship ahead of any console
   * change.
   */
  | 4408
  /** Superseded by a newer socket for the same session. Do not retry. */
  | 4409;

// ─── Agent-native action routes ─────────────────────────────────────────────
//
// `POST /api/v1/agency/attempts/:id/{hangup,disposition,dnc}`, forwarded by the public API layer
// at `/proxy/agency/attempts/:id/…` and gated at `agency.attempts.handle` /
// `agency.attempts.dispose` / `agency.dnc.write`.
//
// These exist rather than reusing the generic call routes because D6 puts `agent`
// at level 5, below every pre-existing permission floor — and because the dialer runtime can
// verify the caller **is the reserved agent for that attempt**, an ownership check
// `/webrtc-call/:id/end` has no way to express. A caller who is not the reserved
// agent gets 403 `not_your_attempt`, not 404.

/**
 * `POST /api/v1/agency/attempts/:id/hangup`.
 *
 * The request carries an actor (a body-less hangup would contradict
 * the ownership paragraph directly above it) — "the dialer runtime can verify the caller **is the
 * reserved agent for that attempt**" is not checkable without an actor. Without
 * one the check could never run and any tenant member holding
 * `agency.attempts.handle` could hang up any other agent's live call.
 *
 * Same shape as disposition and notes, for the same split-enforcement reason:
 * "is the reserved agent" is the dialer runtime's fact, "supervises" is the public API layer's.
 */
export type AgencyHangupRequest = AgencyActorFields;

/**
 * The public API layer denormalises this onto `platform_audit_log.campaign_id`.
 * Hang-up, disposition, DNC and session-state responses all carry it so the audit
 * trail can filter without treating `resource_id` as the campaign.
 */
export interface AgencyCampaignScoped {
  campaign_id: string;
}

export interface AgencyHangupResponse extends AgencyCampaignScoped {
  attempt_id: string;
  /**
   * The attempt row **as read immediately after the hangup was issued**, which may
   * still say `bridged`: the terminal write happens on the bridge's `ended`
   * lifecycle event, and `emitLifecycle` does not await its listeners.
   *
   * That is deliberate rather than a rough edge to tidy later. **The authority for
   * "the call is over" is the station socket's `released` / `bridge_ended` frame**,
   * not this response — the console has to handle a remote hangup arriving with no
   * HTTP request at all, so it cannot be reading terminal state from here anyway.
   * This response answers "was the hangup accepted", and a client that renders
   * `state` as the final word will be wrong on the ordinary path.
   */
  state: AgencyAttemptState;
  /** Present once classified; null if the attempt had not been dialed yet. */
  outcome: AgencyAttemptOutcome | null;
}

/**
 * `POST /api/v1/agency/attempts/:id/disposition`.
 *
 * **P2 SUBMIT SEMANTICS — SETTLED. Safe to freeze a submit path against.**
 * The field list was frozen in Phase 1; what follows is the behaviour a client has
 * to code against, which was not.
 *
 * **Re-submitting the SAME code is an idempotent 200, not a 409.** This is the rule
 * that matters most to a submit path and it is not the obvious one. An agent
 * presses Submit, the network blips, the console retries — and a strict
 * "already dispositioned" would show the agent an error for an action that
 * succeeded, on the one interaction whose whole purpose is recording what was said
 * to a customer. So: same `disposition_code` ⇒ success, with `notes` and
 * `callback_at` taking last-write-wins (which also makes an honest correction
 * work). A **different** `disposition_code` ⇒ 409 `already_dispositioned`, because
 * silently rewriting the record of a customer conversation is not a retry.
 *
 * A replay is deliberately **not** flagged in the response: it is a success from
 * the agent's side, and a client that renders it differently is telling them about
 * a network detail they cannot act on.
 *
 * Accepted **outside wrap-up too** — an agent whose wrap-up already ended, or a
 * supervisor writing one up later, must not be refused. The wrap-up is only
 * released when the submitted attempt is the one that agent is actually in wrap-up
 * for, so dispositioning an old attempt cannot pull a live agent off a new call.
 */
export interface AgencyDispositionRequest extends AgencyActorFields {
  /** Must be a `code` present in the campaign's `disposition_catalog`. */
  disposition_code: string;
  /** Required when the catalog entry sets `requires_note`. */
  notes?: string;
  /** ISO-8601. Required when the catalog entry sets `requires_datetime`.
   *  Per D11 a callback re-enters the roster as an ordinary `pending` contact —
   *  whichever agent is available takes it. There is deliberately no
   *  `preferred_agent_user_id`: agent-facing copy must say "we'll call you back",
   *  never "I'll call you back". */
  callback_at?: string;
}

export interface AgencyDispositionResponse extends AgencyCampaignScoped {
  attempt_id: string;
  contact_id: string;
  disposition_code: string;
  /**
   * Where the disposition left the contact.
   *
   * **In Phase 2 this is `completed`, or `pending` when a `callback_at` was
   * supplied — never anything else.** The `retry`/`terminal`/`suppress` precedence
   * that can also produce `exhausted` or `suppressed` is the retry policy. A console
   * must therefore not build a branch for outcomes only the retry policy can reach, and must not
   * infer "this contact is finished" from `completed` — under P3 the same
   * submission may return `pending`.
   */
  contact_state: AgencyContactState;
  /**
   * ISO-8601, or null.
   *
   * **This is the instant the dialer will place the call — NOT an echo of
   * `callback_at`.** What the agent asked for is echoed separately as
   * {@link AgencyDispositionResponse.callback_requested_at}, and the two differ
   * whenever the requested time falls outside the contact's calling window: the
   * pre-dial gate would refuse that dial anyway, so the response
   * carries the window-adjusted time rather than a promise nothing will keep.
   *
   * Non-null for a `callback_at`; under the retry policy it also starts carrying
   * policy-derived retry times. Honouring the datetime at all was Phase 2's one
   * piece of disposition semantics, and deliberately so: `requires_datetime` is
   * operator config that was already reachable, so capturing it and not acting on
   * it would mean an agent tells a customer "we'll call you back Tuesday" (D11's
   * copy rule) and nothing ever does.
   *
   * One residual, recorded rather than solved: if the campaign's calling window
   * changes AFTER a callback is booked, the instant is recomputed correctly at dial
   * time — the gate, not this value, is the authority — so the only stale thing is
   * the number the console showed the agent.
   */
  next_attempt_at: string | null;
  /**
   * ISO-8601, or null. What the agent ASKED for, echoed back unchanged.
   *
   * **Additive, and it exists so `next_attempt_at` can stop being an echo.**
   * `next_attempt_at` is now the instant the dialer will actually place the call —
   * a `callback_at` outside the contact's calling window is deferred to the next
   * window open, because the pre-dial gate would refuse it anyway
   * and the operator's window is the compliance boundary.
   *
   * Returning the raw request as `next_attempt_at` would have the console promise a
   * time we will not honour, out loud, through the agent's mouth — "we'll call you
   * back Saturday at ten" on a Mon–Fri campaign. So the two are separate fields and
   * only this one is an echo. When they differ, the console should say what will
   * happen rather than what was asked; when `callback_at` was not supplied both are
   * null.
   *
   * **Deliberately NOT a rename of `next_attempt_at`.** the console is compiled against
   * this contract and a rename is a coordinated cross-app change for a field whose
   * meaning is being made *more* correct, not different.
   */
  callback_requested_at?: string | null;
  /**
   * The agent's state after release.
   *
   * **ADVISORY — a point-in-time snapshot, and NOT the authority.** The station
   * socket's `agent_state` frame is (see {@link AgencyStationAgentStateFrame}: "the
   * console must not infer state"). These two race by design: submitting a
   * disposition returns the agent to the pool, and the pacing tick runs every
   * 250ms, so a new call can be reserved and the `reserved` frame delivered
   * *before* this HTTP response arrives. A console that assigns from this field
   * unconditionally will overwrite `reserved` with a stale `available` and drop a
   * live call's panel. Use it only to confirm the submission landed; drive state
   * from the socket.
   */
  agent_state: AgencyAgentState;
}

/**
 * How far a mark-DNC reaches. The **only** thing a client asserts about scope.
 *
 *   * `campaign` — the campaign the marked attempt belongs to, and nothing else.
 *     The public API layer writes a campaign-scoped `dnc_entries` row, which by design does NOT
 *     enter the dialer runtime's flat `dnc:{tenantId}` set, so the in-campaign
 *     enforcement is the dialer runtime's Postgres suppression of every roster row carrying the
 *     number. A customer asking one campaign to stop is not asking to be removed
 *     from campaigns they have never heard from.
 *   * `tenant` — every campaign the tenant runs, and every campaign it will run.
 *     The public API layer writes an entry with no campaign, which is the kind that reaches the
 *     flat set and blocks the number at dial time everywhere. This is the
 *     ESCALATION: the console gates it behind a permission and labels it in those
 *     words, and an agent may read that promise out to a customer, so it has to be
 *     the thing that actually happens.
 *
 * Both scopes suppress the roster rows in front of the agent identically — that
 * write is not conditional on scope, because the contact on the line leaves the
 * campaign either way and immediately.
 */
export type AgencyDncScope = 'campaign' | 'tenant';

/**
 * Mark the contact on the line as Do Not Call.
 *
 * The dialer runtime suppresses every roster row in the campaign carrying the number
 * immediately, and forwards the compliance record to the public API layer, which owns
 * `dnc_entries`. How far that record reaches is {@link scope}.
 */
export interface AgencyDncRequest extends AgencyActorFields {
  /**
   * How far this mark reaches. **Absent means `campaign`** — see
   * {@link AgencyDncScope}.
   *
   * The default is the NARROWER scope deliberately: a caller that knows nothing
   * about scope — an older console, a script, the public API layer before its passthrough
   * shipped — must fail safe rather than escalate. The reverse default would have
   * every ignorant caller silently suppressing numbers across campaigns the
   * customer never mentioned, which is precisely the behaviour campaign-scoping
   * exists to remove.
   *
   * ⚠️ The client asserts the SCOPE and **never a campaign id**, which is why
   * there is no `campaign_id` field on this body and must not become one. The
   * route has already resolved the attempt's campaign before it reads this, so a
   * client-supplied id would be both redundant and a caller asserting a fact the dialer runtime
   * owns — the same argument the public API layer's `createSessionSchema` makes for deriving
   * `agent_user_id` from the session rather than trusting the body.
   *
   * An unrecognised value is `400 invalid_dnc_scope`, not a quiet fall back to
   * `campaign`. A console that misspells `tenant` is telling a customer their
   * number is suppressed workspace-wide and permanently; writing the
   * campaign-scoped row instead would make that statement false with a 200 and a
   * green dashboard behind it.
   */
  scope?: AgencyDncScope;
  /** Free text; stored on the public-API-side entry. */
  reason?: string;
  /**
   * Also disposition the attempt in the same call. Must be a catalog code.
   *
   * **Supplying this REQUIRES an actor** (`agent_user_id`), and the route answers
   * `400 missing_actor` without one — a disposition is the record of who said what
   * about a customer, and the rest of this file already refuses to write an
   * unattributed one ({@link AgencyActorFields}, `checkActor`).
   *
   * A plain mark-DNC needs no actor, so the compliance path works with exactly
   * what the public API layer sends today. ⚠️ **The public API layer currently injects no actor on
   * this route** — unlike its disposition/notes routes — so `added_by` lands NULL
   * on the entry and this field is unreachable from the browser until that
   * injection is added. The dialer runtime deliberately does not substitute the attempt's reserved agent:
   * a supervisor marking someone else's attempt would be recorded as that agent,
   * and a confidently-wrong actor on an audit record is worse than a missing one.
   */
  disposition_code?: string;
}

export interface AgencyDncResponse extends AgencyCampaignScoped {
  attempt_id: string;
  contact_id: string;
  phone_e164: string;
  /** Always `suppressed` on success. */
  contact_state: AgencyContactState;
  /** False when the public API layer accepted the suppression but the DNC list write is still
   *  in flight — the contact is suppressed locally either way. */
  dnc_recorded: boolean;
}

// ─── Session state routes ───────────────────────────────────────────────────
//
// `POST /api/v1/agency/sessions/:id/{available,break,break/cancel,leave}`.
// Phase 1 implements `available` and `leave`; `break` and `break/cancel` are Phase
// 2 and their shapes are frozen here so the public API layer can proxy all four at once.
//
// P2 adds a fifth, `force-available` — see {@link AgencyForceReturnRequest}. It is
// listed separately because it is the only one an `agent` may not call.

export interface AgencySessionBreakRequest {
  /** Must match a `code` from bootstrap's `break_reasons`. */
  reason: string;
}

/**
 * `POST /api/v1/agency/sessions/:id/break/cancel` — take back a **queued** break
 * (P2).
 *
 * A break requested while `on_call` is queued and applied at the end of wrap-up, so
 * there is a window — the rest of the conversation plus the wrap-up — during which
 * the agent has asked for a break and has not got one yet. Changing your mind in
 * that window is the obvious thing to want, and without this route it is impossible:
 * `/available` operates on the current state and leaves `pending_state` untouched,
 * so the break would still land the moment wrap-up ended.
 *
 * No body. Responds {@link AgencySessionStateResponse} with `pending_state` cleared.
 *
 * **409 `break_already_applied` when the break is already in effect**, rather than a
 * no-op 200. An agent who clicks "cancel break" and is silently left on break has
 * been told nothing, which is the failure mode this contract keeps rejecting
 * elsewhere; the 409 lets the console say "your break already started — go
 * available when you're ready" and offer the right control. Cancelling when nothing
 * is queued and no break is in effect is an idempotent 200 (double-click safety).
 */
export type AgencySessionBreakCancelRequest = Record<string, never>;

export interface AgencySessionStateResponse extends AgencyCampaignScoped {
  session_id: string;
  state: AgencyAgentState;
  /** ISO-8601. */
  since: string;
  /**
   * Set when the transition was accepted but deferred — an agent who requests a
   * break while `on_call` goes to break at wrap-up end, not immediately.
   */
  pending_state?: AgencyAgentState;
  /** **P2.** Present when `pending_state` is `break`, or when `state` is `break`. */
  break_reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — THE POOL
// ═══════════════════════════════════════════════════════════════════════════
//
// Frozen ahead of implementation for the same reason Phase 1's block was: the public API layer
// forwards these and the console renders them, and both are structurally blocked behind
// the dialer runtime for the whole phase.
//
// Everything below serves four surfaces — wrap-up, break, disposition + notes, and
// reconnect — and one rule runs through all of them: **no business timer is ever a
// Redis TTL**. Wrap-up length, the deferred-hangup window and the countdown
// all live in the attempt row and in process. The leases stay flat liveness
// numbers, and `wrapup`'s lease is the same 15s heartbeat lease `available` holds.
// If a future field here is expressed in seconds and a lease is derived from it,
// that is the mistake this comment exists to prevent.

// ─── Wrap-up ───────────────────────────────────────────────────

/**
 * Why an expired wrap-up did **not** return the agent to the pool.
 *
 * `null` (on {@link AgencyWrapupState}) means the wrap-up is simply running.
 */
export type AgencyWrapupHoldReason =
  /**
   * The call reached the agent, so a disposition is expected, and none has been
   * submitted (`wrapup → available` is conditional on it). The timer has
   * lapsed and the agent stays in `wrapup` until they submit or a supervisor
   * forces the return. **The console must say why** — an agent whose countdown
   * hits zero and whose screen does not change concludes the app has hung.
   */
  | 'disposition_required'
  /** A supervisor is holding this agent out of the pool deliberately. */
  | 'supervisor_hold';

/**
 * The whole of a wrap-up, as one value.
 *
 * **The deadline is absolute (`ends_at`), never a per-second countdown frame.**
 * Two reasons, both load-bearing: the console's countdown must to
 * match the server within a second *and not drift over a shift*, which a client
 * ticking down from a delivered duration cannot promise; and a per-second frame
 * per agent is a frame storm on a socket that also carries live audio. The console
 * renders `ends_at - now` locally and re-syncs whenever a new `wrapup` frame
 * arrives. (Contrast {@link AgencyStationCountdownFrame}, which *is* per-second —
 * that one is three frames total, is a D5 auto-connect cue rather than a timer,
 * and is the agent's warning that they are about to be on a live call.)
 */
export interface AgencyWrapupState {
  attempt_id: string;
  /**
   * ISO-8601 instant the wrap-up returns the agent to the pool.
   *
   * `null` when nothing is going to end it on its own: `wrapup_auto_return` is
   * false, or the timer already lapsed and `held_reason` is set. A console that
   * treats `null` as "expired" will show a stuck countdown; treat it as "no
   * deadline — this ends when the agent acts".
   */
  ends_at: string | null;
  /** The campaign's configured `wrapup_seconds` for this attempt. */
  seconds_total: number;
  auto_return: boolean;
  /** Whether the dialer runtime expects a disposition before this agent returns to the pool. */
  requires_disposition: boolean;
  disposition_submitted: boolean;
  held_reason: AgencyWrapupHoldReason | null;
}

/**
 * The agent entered wrap-up, or their wrap-up materially changed.
 *
 * **Deliberately one frame, re-emitted, rather than an entry/extend/end trio.** It
 * is emitted on entry, when the timer lapses into a hold, and when a disposition
 * lands — and it is idempotent: the console replaces its wrap-up state with the
 * payload and re-derives everything. A trio would force clients to reconstruct
 * state from an event ordering that a reconnect can shuffle.
 *
 * Wrap-up **ending** is not signalled here. It is an agent-state transition and
 * arrives as {@link AgencyStationAgentStateFrame} with `state: 'available'` (or
 * `break`, when one was queued) — there is exactly one authority on agent state
 * and it is that frame.
 *
 * A campaign with `wrapup_seconds = 0` **and no disposition required** produces no
 * `wrapup` frame at all: the agent goes `on_call → available` directly, and
 * a console that waits for a wrap-up frame before re-enabling its idle UI would
 * hang on such a campaign.
 *
 * **But `wrapup_seconds = 0` does NOT mean "no wrap-up" — it means "no timer".**
 * When a disposition is required, a zero-length campaign still opens a *timerless*
 * wrap-up: `ends_at: null`, `auto_return: false`, and `held_reason:
 * 'disposition_required'` set from the very first frame rather than appearing later
 * when a countdown lapses. The console must therefore not treat `seconds_total: 0`
 * as "nothing to render" — that configuration is the one where the agent most needs
 * the prompt, because nothing else will ever end the wrap-up for them.
 *
 * The alternative — honouring `0` literally — is not a race a fast agent loses, it
 * is structural data loss: the attempt ends, the agent is `available`, the tick
 * reserves them within 250ms, and the record of what was said to a customer is
 * never captured on any call of that campaign.
 */
export interface AgencyStationWrapupFrame {
  event: 'wrapup';
  wrapup: AgencyWrapupState;
}

/**
 * `POST /api/v1/agency/sessions/:id/force-available` — supervisor override.
 *
 * Ends a wrap-up that is held (typically `disposition_required`) and returns the
 * agent to the pool. Distinct from `POST /sessions/:id/available`, which is the
 * agent's own control and refuses while a disposition is outstanding: collapsing
 * the two would let an agent skip every disposition by clicking "available".
 *
 * Forwarded at `/proxy/agency/sessions/:id/force-available` and gated at
 * `agency.supervise` (account_admin floor) — **not** reachable by an `agent` (D6).
 * The attempt is left `no_disposition` when one was outstanding, exactly as the
 * reaper's sweep would have, so forced and swept returns produce
 * one shape of data rather than two.
 */
export interface AgencyForceReturnRequest {
  /** Free text, recorded on the audit event. */
  reason?: string;
}

// ─── Agent-attributed actions ───────────────────────────────────────────────

/**
 * Who is performing an attempt-scoped action, on every such request body.
 *
 * **The dialer runtime cannot evaluate the public API layer's RBAC**, so the public API layer asserts both facts and the dialer runtime
 * enforces the ownership rule against them. That trust boundary already exists
 * (every `/proxy/*` call is the public API layer vouching for a caller); what is new is that
 * "the reserved agent" is a *dialer-runtime-side* fact the public API layer cannot check, and "holds a
 * supervisory capability" is a *public-API-side* fact the dialer runtime cannot check. Neither
 * layer can enforce the rule alone, which is why these two fields exist
 * rather than a single opaque actor id.
 *
 * Rules the dialer runtime applies, in order:
 *  1. no `agent_user_id` ⇒ 400 `missing_actor`. There is no anonymous disposition;
 *     the disposition is the record of who said what about a customer.
 *  2. `agent_user_id` matches the attempt's reserved agent ⇒ allowed.
 *  3. mismatch **and** `on_behalf` true ⇒ allowed, and the attempt records the
 *     acting user separately from the reserved agent.
 *  4. mismatch and `on_behalf` absent/false ⇒ 403 `not_your_attempt`.
 */
export interface AgencyActorFields {
  /** the public API layer's user id for the human performing the action (D3 — opaque to the dialer runtime). */
  agent_user_id?: string;
  /**
   * the public API layer sets this **only** when the caller holds `agency.supervise` and is not
   * the reserved agent. An `agent` (level 5) can never cause it to be set.
   */
  on_behalf?: boolean;
}

/**
 * `POST /api/v1/agency/attempts/:id/notes` — save notes without dispositioning.
 *
 * Separate from the disposition submit because the two happen at different times:
 * agents type while the customer is talking, and a call that ends before they
 * choose a code must not discard what they wrote. Safe to call repeatedly — last
 * write wins, and it is accepted while the attempt is live *and* through wrap-up,
 * so an autosave does not need to know which phase it is in.
 *
 * It does **not** end wrap-up and does **not** satisfy `requires_disposition`.
 */
export interface AgencyNotesRequest extends AgencyActorFields {
  /** Replaces the attempt's notes wholesale. Empty string clears them. */
  notes: string;
}

export interface AgencyNotesResponse {
  attempt_id: string;
  notes: string;
  /** ISO-8601. */
  updated_at: string;
}

// ─── Action-route errors ────────────────────────────────────────────────────

/**
 * Why an agent action was refused.
 *
 * These exist as a closed union because the public API layer must to surface
 * the dialer runtime's validation errors **intact**, and "intact" is not a property a free-text
 * message has: a proxy that re-words or flattens them leaves the console unable to
 * do anything but show a red box. The console keys its copy off `code`; `message`
 * is the fallback for a code it does not recognise.
 */
export type AgencyActionErrorCode =
  /** No `agent_user_id` on the request. the public API layer must always attribute the action. */
  | 'missing_actor'
  /** The caller is not the reserved agent and did not assert `on_behalf`. */
  | 'not_your_attempt'
  /** `disposition_code` is not in the campaign's catalog. `allowed_codes` is set. */
  | 'unknown_disposition_code'
  /**
   * `scope` on a mark-DNC is neither `campaign` nor `tenant`. `allowed_codes` is
   * set to both. Refused rather than defaulted on purpose: the two scopes are
   * different promises to a customer, and guessing which one a misspelling meant
   * would make one of those promises false silently.
   */
  | 'invalid_dnc_scope'
  /** The catalog entry sets `requires_note` and `notes` was empty. */
  | 'note_required'
  /** The catalog entry sets `requires_datetime` and `callback_at` was absent. */
  | 'datetime_required'
  /** `callback_at` is unparseable or in the past. */
  | 'invalid_callback_at'
  /**
   * The attempt is not in a state that can be dispositioned — it never reached the
   * agent, or its wrap-up is long over and the reaper already wrote
   * `no_disposition`. Distinct from `already_dispositioned` so the console can
   * offer "this call was auto-closed" rather than "you already did this".
   */
  | 'attempt_not_dispositionable'
  /** A disposition is already recorded. Deliberately not an overwrite (see below). */
  | 'already_dispositioned'
  /** `reason` is not in the campaign's `break_reasons`. `allowed_codes` is set. */
  | 'unknown_break_reason'
  /**
   * `break/cancel` on a break that is already in effect. There is nothing queued
   * left to cancel; the agent wants `/available` instead.
   */
  | 'break_already_applied'
  /** The session has left; re-bootstrap rather than retrying. */
  | 'session_ended'
  /**
   * `POST /sessions` refused: the agent already holds a LIVE session on a
   * DIFFERENT campaign in the same tenant. Since migration 092 there is one live
   * session per (tenant, agent), because the reservation CAS key is per SESSION
   * (`agency:agent:{sessionId}:state`) while a human has one pair of ears — two
   * live sessions are two independently reservable agents and two customers
   * bridged into one headset.
   *
   * The only member of this union that sets `campaign_id` / `campaign_name` /
   * `state`; see {@link AgencySessionCampaignConflict}, which narrows this shape
   * for it. Those fields are read against this code exactly as `allowed_codes` is
   * read against its three producers — nothing else sets them.
   *
   * Carries the same OPEN obligation on the public API layer that `invalid_dnc_scope` carries:
   * it must be added to `AGENCY_ACTION_ERROR_CODES` there, or the error mask
   * rewrites it into "contact support and quote this request id" and the agent is
   * told to raise a ticket instead of to leave their other station. The
   * degradation is bounded and loud — the join is still refused with a 409 — which
   * is why the dialer runtime ships the code rather than waiting.
   */
  | 'session_on_other_campaign'
  /**
   * `POST /sessions/:id/leave` refused: this replica is still driving an attempt
   * for the session.
   *
   * Not a politeness. Leaving clears the lease and sets `left_at`, and a left row
   * no longer participates in `uq_agency_agent_live_tenant` — so an `on_call`
   * agent who left could join a second campaign and be bridged a second customer
   * while the first call is still up. That is the double-bridge migration 092
   * exists to prevent, reachable in one click, and the constraint cannot see it
   * because both rows satisfy the index once the first has left.
   *
   * `releaseStationOnClose` has carried the same guard for socket close since
   * the socket-close fix; this is the deliberate-leave half of the same rule. The remedy
   * is `POST /attempts/:id/hangup`, or finishing the call — the dialer runtime will not end a
   * live conversation as a side effect of an agent tidying up.
   *
   * Same obligation as the code above: list it in
   * `AGENCY_ACTION_ERROR_CODES` or the public API layer's mask replaces this explanation with
   * "contact support and quote this request id".
   */
  | 'agent_on_live_call'
  /** The agent has no attached station socket, so they cannot go available. */
  | 'no_station'
  /**
   * Hangup was asked for on an attempt this replica is not bridging, and whose row
   * is not terminal either. Distinct from a terminal attempt, which is
   * an idempotent success — an agent's hangup routinely races the customer's, and
   * erroring on that would show a failure for the thing that just happened.
   *
   * Reachable in exactly one situation today: the bridging replica restarted while
   * the row was live. The bridge session is in-process memory and there is
   * no cross-replica hangup channel, so the dialer runtime says so instead of returning a
   * success that hangs up nothing.
   */
  | 'attempt_not_live'
  | 'campaign_not_running'
  /** The agency dialer flag is off for this tenant/account. */
  | 'feature_disabled';

/**
 * The body of every 4xx from an agency action route.
 *
 * Shape matches the platform's existing error convention (`error` + `message`)
 * with `code` added, so the public API layer's proxy passes it through unchanged and existing
 * client error handling still finds the fields it expects.
 */
export interface AgencyActionErrorResponse {
  /** Short human title, e.g. `Validation failed`. */
  error: string;
  code: AgencyActionErrorCode;
  message: string;
  /**
   * The values that *are* accepted for whatever the request got wrong, so a
   * console holding a stale catalog can recover in one round trip instead of
   * making the agent re-bootstrap mid-shift.
   *
   * ⚠️ **Not a disposition catalog.** It is set by THREE codes and they name
   * different vocabularies, which is why this field must be read against its
   * `code` and never rendered generically:
   *
   *   * `unknown_disposition_code` ⇒ the campaign's disposition codes;
   *   * `unknown_break_reason` ⇒ the campaign's break reasons;
   *   * `invalid_dnc_scope` ⇒ `['campaign', 'tenant']` — the two DNC SCOPES, not
   *     codes of any kind. A console that pushed these into a disposition picker
   *     would offer an agent "campaign" and "tenant" as things to have said to a
   *     customer.
   *
   * The name is now wrong for the third producer and is kept anyway: it is
   * frozen contract surface that public API layer forwards unchanged and the console
   * compiles against, so renaming it is a cross-app change that buys accuracy in
   * a doc comment. Recorded here instead.
   */
  allowed_codes?: string[];
}

// ─── Campaign stats (including the rolling abandonment rate) ────────────────

/**
 * `GET /api/v1/agency-campaigns/:id/stats`.
 *
 * Frozen now because Phase 2 adds the abandonment numbers to it and the public API layer's
 * supervisor payload reads them. Counts are point-in-time; the rate is not.
 *
 * `contacts_pending` and `retries_pending` are genuinely different questions and
 * both are shown — `next_attempt_at` can be hours out, so "list exhausted"
 * and "campaign complete" are not the same thing.
 */
/**
 * The states an agent session can hold — an ALIAS, not a second union.
 *
 * It was briefly re-declared here with the same six members, which is the drift it
 * claimed to prevent: `agencyAgentSessionRepository.setState` is typed against
 * {@link AgencyAgentState}, so the payload and the writer would have depended on two
 * unions nothing kept in sync. An alias cannot diverge from its source.
 *
 * The name is kept because "live state" is what the supervisor payload means by it —
 * the state of a session that has not left — and reads better at the use sites.
 */
export type AgencyAgentLiveState = AgencyAgentState;

/** Live agents on a campaign, counted by state. Every state present, zeros included. */
export type AgencyAgentsByState = Record<AgencyAgentLiveState, number>;

/**
 * One agent on the supervisor's floor.
 *
 * The floor is sorted by RISK, not alphabetically, and the risk rules need
 * `state_since` rather than a pre-computed duration: the tile ticks live, so a
 * server-rendered "8m 41s" is wrong the moment it arrives.
 */
export interface AgencySupervisorAgent {
  /**
   * The agent's SESSION id — what every supervisor control is addressed to.
   *
   * `POST /agency/sessions/:id/force-available` takes this, not `agent_user_id`,
   * and the console's agent drawer offers exactly that control for the stuck-in-wrap-up case. Without it the floor renders and none of its controls can be
   * wired: the query already `GROUP BY s.id`, so the id was one projection away
   * from being on the wire and the omission would only have surfaced in the console.
   *
   * Distinct from `agent_user_id`, and the difference matters — a session is one
   * shift on one campaign, while the user id is the person. Controls act on the
   * session; identity resolution acts on the user.
   */
  session_id: string;
  /**
   * The public API layer's user id for the person. **The dialer runtime never resolves it to a name** (D3) —
   * there is no user table here. Rendering an agent's display name needs the public API layer to
   * enrich this on the proxy hop; it is the only service that knows identity.
   */
  agent_user_id: string;
  state: AgencyAgentLiveState;
  /** ISO instant of the last state transition. The console derives time-in-state. */
  state_since: string;
  /**
   * Whether this agent's station socket is currently held — the console's risk rank 4,
   * "disconnected / heartbeat lost".
   *
   *   * `true`  — the ownership key `agency:station:{session_id}` is present, so a
   *     station ping landed within `OWNERSHIP_TTL_MS` (30s).
   *   * `false` — no key. The agent's browser is gone; the tile is stale and the
   *     supervisor should be told.
   *   * `null`  — **could not determine**, i.e. the Redis read failed. Deliberately
   *     NOT a synonym for `false`: a degraded dependency must never manufacture
   *     "this agent is disconnected" on a floor a supervisor is about to act on.
   *     Same rule, and the same shape, as `concurrency_in_use`.
   *
   * ── Why this is a boolean and NOT a `last_heartbeat` timestamp ──────────────────
   *
   * Because there is no such timestamp to give. The obvious source,
   * `agency_agent_sessions.last_heartbeat`, is **never renewed** — the only writer,
   * `AgencyAgentSessionRepository.heartbeat()`, has no callers; the station ping
   * renews the Redis key and never touches the row. Migration 074 states the rule
   * outright ("Liveness does NOT come from this table. The authority is the Redis
   * ownership key") and `reaper.ts` already declines to use the column for exactly
   * this reason.
   *
   * So serving it would have shipped well-formed ISO data meaning "when this shift
   * began", under a name promising liveness — marking every agent disconnected
   * minutes after they join, most confidently the ones working longest. That is the
   * missing-producer defect wearing a disguise: not an absent field, but a plausible
   * one. Redis holds a TTL, not an instant, so a boolean is the whole truth
   * available and the contract says only what the dialer runtime can produce.
   *
   * **Composed by the ROUTE, not the repository** — see
   * {@link AGENCY_AGENT_ROUTE_FIELDS}. It is a Redis read, and `stats()` is SQL.
   */
  connected: boolean | null;
  /** Present only while `state === 'break'`. */
  break_reason: string | null;
  /** Attempts this agent has handled on this campaign this session. */
  calls_handled: number;
}

/**
 * The agent fields the ROUTE composes, not the repository.
 *
 * The same split `AGENCY_STATS_ROUTE_FIELDS` states one level up, and stated the
 * same way — as a runtime value rather than a comment, so
 * {@link AgencySupervisorAgentRow} is derived from it and a field moving between
 * producers is a compile error rather than a doc comment that quietly went stale.
 *
 * `connected` is here because liveness lives in Redis (`StationRegistry`) while the
 * floor is a SQL roster. Merging them in the repository would put a Redis
 * dependency behind `stats()`, where every other field is a query.
 */
export const AGENCY_AGENT_ROUTE_FIELDS =
  ['connected'] as const satisfies readonly (keyof AgencySupervisorAgent)[];

/**
 * One floor row **as the database can answer it** — everything except the fields
 * the route adds.
 *
 * Derived rather than hand-written: the repository returning this and the route
 * annotating the full {@link AgencySupervisorAgent} means a field with no producer
 * cannot compile, which is the no-producerless-field guarantee applied to the nested row.
 */
export type AgencySupervisorAgentRow =
  Omit<AgencySupervisorAgent, (typeof AGENCY_AGENT_ROUTE_FIELDS)[number]>;

/**
 * ─── THE HEALTH STRIP'S DIAGNOSES ────────────────────────────────────
 *
 * The health strip ranks eight conditions and shows the first that matches. The
 * ranking is by **what a supervisor should do about it**, not by severity: a
 * compliance stop outranks a staffing problem, which outranks a capacity one,
 * because acting on the wrong one wastes the minutes the strip exists to save.
 *
 * The order is load-bearing and is asserted, not just written here — see
 * `AGENCY_STALL_PRIORITY`.
 */
export type AgencyStallCode =
  /** 1. Auto-paused by the abandonment guardrail. */
  | 'auto_paused_abandonment'
  /** 2. The DNC check is unavailable, so dialing fails CLOSED (DNC is tenant-wide). */
  | 'dnc_unavailable'
  /** 3. Nobody is available to take a call. */
  | 'no_agents_available'
  /** 4. At the account concurrency ceiling (set by super-admins only). */
  | 'concurrency_saturated'
  /** 5. Everything left is outside its calling window. */
  | 'outside_calling_hours'
  /** 6. Nothing dialable now, but retries are scheduled. */
  | 'list_exhausted_retries_pending'
  // Priority 7 (`credits_low`) is intentionally absent: v1 has no credits, and a
  // code that is declared but never produced is a trap for exhaustive consumers.
  // The remaining codes keep their relative order and the ordinals in these
  // comments.
  /** 8. An unusual share of recent dials failed — possibly a carrier problem. */
  | 'elevated_failure_rate';

/**
 * Priority order, first match wins. Exported because the console renders
 * "2 more issues" from `other_stalls` and must sort it the same way, and because
 * a reordering should break a test rather than silently change which single
 * diagnosis a supervisor sees.
 */
export const AGENCY_STALL_PRIORITY: readonly AgencyStallCode[] = [
  'auto_paused_abandonment',
  'dnc_unavailable',
  'no_agents_available',
  'concurrency_saturated',
  'outside_calling_hours',
  'list_exhausted_retries_pending',
  'elevated_failure_rate',
] as const;

/**
 * **{@link AGENCY_STALL_PRIORITY} is the single list** of stall codes: one
 * application produces every code itself, so there is no separate "producible
 * subset". A test that checks the assembler emits only known codes should assert
 * against it. `credits_low` is absent (no billing in v1); it would return with
 * metering, if at all, as an additive member with a real producer.
 */

/**
 * A diagnosis together with the evidence for it.
 *
 * A discriminated union rather than `{ code, detail: Record<string, unknown> }`
 * because each message must to name its own numbers ("abandonment 3.4%
 * is over your 3% limit", "6 agents on shift, 0 available"), and an untyped bag
 * would let the console read a field the producer never set — rendering "NaN% is
 * over your undefined% limit" at exactly the moment a supervisor needs the truth.
 *
 * No arm carries a pre-formatted sentence. Copy is the console's, and a
 * server-rendered string cannot be localised, pluralised, or shortened for the
 * <1024px layout.
 */
export type AgencyStall =
  | {
      code: 'auto_paused_abandonment';
      /** The rate AS MEASURED when the guardrail fired — frozen, see migration 089. */
      measured_pct: number;
      ceiling_pct: number;
      paused_at: string;
    }
  | {
      code: 'dnc_unavailable';
      /**
       * Per-tenant, not per-campaign: the DNC set is tenant-flat, so
       * every campaign in the tenant is stopped by the same fault.
       */
      tenant_wide: true;
    }
  | {
      code: 'no_agents_available';
      agents_on_shift: number;
      /** Break codes to counts, so the console can render "5 on break (Lunch)". */
      on_break_by_reason: Record<string, number>;
      on_call: number;
      /** ISO-8601, or null when this campaign has never dialed. */
      last_dial_at: string | null;
    }
  | {
      code: 'concurrency_saturated';
      limit: number;
      in_use: number;
    }
  | {
      code: 'outside_calling_hours';
      contacts_waiting: number;
      /** ISO-8601 of the next window opening, or null if none resolves. */
      next_window_opens_at: string | null;
    }
  | {
      code: 'list_exhausted_retries_pending';
      retries_pending: number;
      next_retry_at: string | null;
    }
  // There is no `credits_low` arm: the code itself is absent — see
  // `AgencyStallCode`.
  | {
      code: 'elevated_failure_rate';
      failed_pct: number;
      attempts: number;
      window_minutes: number;
    };

export interface AgencyCampaignStats {
  campaign_id: string;
  status: AgencyCampaignStatus;
  contacts_total: number;
  contacts_pending: number;
  contacts_in_flight: number;
  contacts_completed: number;
  contacts_suppressed: number;
  /**
   * Contacts retired by running out of retry budget.
   *
   * A separate bucket rather than folded into `contacts_completed`, because
   * exhaustion is its own STATE precisely so a supervisor can tell "we worked
   * this list to its cap" from "this outcome was never retryable". Without it
   * `contacts_total` does not equal the sum of the buckets and the missing
   * contacts are invisible — the one direction nobody checks, since the number
   * looks plausible either way.
   */
  contacts_exhausted: number;
  /** Pending contacts whose `next_attempt_at` is still in the future. */
  retries_pending: number;
  attempts_live: number;
  attempts_total: number;
  attempts_connected: number;
  /**
   * Attempts that were a REDIAL of a contact and were actually DIALLED —
   * `attempt_number > 1 AND dialed_at IS NOT NULL`.
   *
   * The `dialed_at` gate is what makes "dials PLACED" true rather than
   * aspirational: attempts are created in `state = 'queued'` with `dialed_at`
   * NULL, so un-placed retry rows exist by construction, and a campaign paused
   * with 50 reserved-but-undialled second attempts would otherwise report
   * `attempts_retried: 50` having redialled nobody. Same gate, for the same
   * reason, as the `attempts` counter on {@link AgencyCampaignStatsSeries}.
   *
   * ⚠️ **This is a different question from {@link retries_pending}, and the two
   * are the most likely pair on this payload to be read as one.**
   * `retries_pending` counts contacts whose `next_attempt_at` is still in the
   * future — work QUEUED. This counts dials already PLACED that were not the
   * contact's first. A campaign can have `retries_pending: 0` and
   * `attempts_retried: 4_000`: it worked its whole retry budget and has nothing
   * left scheduled. Reporting only the queued number makes a campaign that spent
   * most of its dials on redials look like one that reached everybody first time.
   *
   * `attempt_number` is derived at insert from `MAX(attempt_number)` over the
   * contact's attempts, NOT from `agency_contacts.attempt_count` —
   * so an our-fault redial (a dropped station socket, a reaper requeue) is counted
   * here even though it never spent the customer's retry allowance. That is the
   * honest reading of "dials that were not the first": the number was called
   * again, whoever's fault it was.
   *
   * **Optional on the wire**, and it is the only counter here that is. The dialer runtime always
   * produces it; the `?` is for the public API layer and the console, which may be talking to a
   * the dialer runtime that predates it. Absent means "this dialer runtime does not report it", never zero.
   */
  attempts_retried?: number;
  agents_live: number;
  /**
   * **P2.** Attempts that answered with no agent to bridge to, over a rolling 24
   * hours — **not** over the campaign, and not over a session.
   *
   * 24h is the window regulators measure abandonment over, so a campaign-lifetime
   * figure is the wrong number even when it is easier to compute: a campaign that
   * abandoned badly this morning and has been clean since would keep showing a bad
   * rate, and one that has been running an hour would show a rate built from
   * almost no calls. The window is anchored on wall-clock, so it spans restarts and
   * spans campaigns.
   */
  abandoned_24h: number;
  /** Answered attempts over the same rolling 24h window — the rate's denominator. */
  answered_24h: number;
  /**
   * `abandoned_24h / answered_24h`, as a percentage, or `null` when the denominator
   * is zero. **Null, never 0** — "no calls answered yet" and "no calls abandoned"
   * are different facts, and rendering the first as a reassuring 0.0% is how a
   * guardrail gets trusted before it has measured anything.
   */
  abandonment_rate_24h_pct: number | null;

  // ── the supervisor dashboard ──────────────────────────────────

  /** Live agents by state. Replaces nothing — `agents_live` stays as the total. */
  agents_by_state: AgencyAgentsByState;
  /** The floor, unsorted. Risk ordering is the console's. */
  agents: AgencySupervisorAgent[];

  /**
   * Connects split by whether a HUMAN answered, derived from dispositions.
   *
   * D1's stated consequence, and it is not cosmetic: AMD is out of scope, so agents
   * hear answering machines and disposition them by hand. Without the split, every
   * voicemail an agent sat through is counted as a connect and its duration inflates
   * AHT — the dashboard would report agents handling more calls, more slowly, and
   * both numbers would be wrong in the direction that looks like a coaching problem.
   */
  human_connects: number;
  machine_connects: number;
  /**
   * Bridged calls nobody classified — no disposition, or the reaper's
   * `no_disposition` auto-stamp on a lapsed wrap-up.
   *
   * A third bucket, because a two-way split forces the unknowns somewhere and
   * `disposition_code IS DISTINCT FROM 'voicemail'` is true of NULL — so they all
   * landed in `human_connects` at full duration. That population skews toward
   * exactly the voicemails an agent walked away from rather than label, which is
   * the case the split exists to separate.
   *
   * The three sum to every bridged attempt. Deliberately not folded into either
   * neighbour: "we don't know what this call was" is a different fact from both,
   * and it is also the honest denominator caveat for `connect_rate_pct`.
   */
  unclassified_connects: number;
  /**
   * Whether this campaign's disposition catalog actually contains `voicemail`.
   *
   * **`false` means `machine_connects` is not measuring anything**, and the console
   * must say so rather than render a confident `0`. The public API layer injects a default catalog
   * containing the code when the field is absent (`DEFAULT_DISPOSITION_CATALOG`), but
   * a campaign created before that shipped — or created directly against the dialer runtime,
   * bypassing the public API layer — can still have `[]`, and an agent cannot submit a code the
   * catalog does not offer. Same lesson as `abandonment_rate_24h_pct`: "no evidence"
   * and "zero" are different facts, and only one of them is reassuring.
   */
  machine_connects_available: boolean;
  /** Human connects over attempts, as a percentage. `null` before any attempt. */
  connect_rate_pct: number | null;

  /**
   * Bridged attempts whose disposition maps to a catalog entry flagged
   * `is_success` — the campaign's conversions.
   *
   * **This is the first thing that has ever counted `is_success`.** The flag has
   * been on {@link AgencyDisposition} since migration 072, is settable in the
   * campaign builder and is styled on the agent's disposition pad; until now its
   * only other reference in the dialer runtime was a type check in the config validator, i.e.
   * the platform confirmed the operator's answer was a boolean and then discarded
   * it. An operator could mark `Sale` a success, watch agents submit it all day,
   * and find no number anywhere that had noticed.
   *
   * Gated on `bridged_at IS NOT NULL`, the same gate as every other flow metric
   * here and the same one `disposition.ts` uses to decide whether there was a
   * conversation to write up — never `outcome = 'connected'`, which is a
   * classification that can be absent, late, or say connected about a call no
   * agent ever heard.
   */
  attempts_success: number;
  /**
   * `attempts_success` over BRIDGED attempts, as a percentage, or `null` when
   * nothing has bridged.
   *
   * **Null, never 0** — the same rule as {@link abandonment_rate_24h_pct}, from
   * the same shared helper. "Nothing has converted yet" and "nothing has been
   * dispositioned yet" are different facts, and rendering the second as a
   * confident 0.0% is how a metric gets trusted before it has measured anything.
   *
   * The denominator is bridged attempts, **not** `attempts_total`: a dial that
   * rang out had no conversation to convert, so counting it against the script
   * would make the rate a function of list quality. Note this makes the
   * denominator `human_connects + machine_connects + unclassified_connects`
   * (which sum to every bridged attempt) rather than any single one of them.
   */
  success_rate_pct: number | null;

  /**
   * Average handle time, in seconds, **excluding voicemail-dispositioned attempts**
   *.
   *
   * Measured `ended_at − bridged_at` — the AGENT's leg. Deliberately not the
   * persisted `talk_seconds`, which is anchored on `answered_at` (the carrier's
   * answer) and is nonzero even when no agent ever bridged: an abandoned attempt
   * settles `completed` carrying the apology clip's talk time. Averaging
   * that column would fold ring-to-bridge latency and abandoned calls into a number
   * whose whole purpose is to describe agent work.
   */
  aht_seconds: number | null;
  /** The same average with voicemail included — the console's "raw figure on hover". */
  aht_seconds_including_machine: number | null;

  /**
   * Average wrap-up, in seconds — the supervisor's tuning input for
   * `wrapup_seconds`.
   *
   * Averages `disposition_submitted`, `auto_return` and `agent_returned`; see 088 for
   * why `forced`, `agent_left` and `campaign_stopped` are excluded. `null` until
   * enough wrap-ups have concluded to say anything.
   */
  avg_wrapup_seconds: number | null;

  /** The configured ceiling the rate is drawn against. */
  abandonment_ceiling_pct: number;

  /**
   * The health strip: the single highest-priority reason this campaign is not
   * dialing, or `null` for "running normally".
   *
   * One diagnosis, not a list, because the strip shows one — a supervisor reading
   * five simultaneous problems acts on none of them. Everything else that also
   * matched is in {@link other_stalls} behind "2 more issues".
   */
  stall: AgencyStall | null;

  /**
   * The codes that also matched, in the same priority order, excluding the one in
   * {@link stall}. Codes only — the console renders a count and a list of names,
   * and carrying full evidence for problems it is not showing would triple the
   * payload for a disclosure most supervisors never open.
   */
  other_stalls: AgencyStallCode[];

  /**
   * The account's configured concurrency ceiling.
   *
   * A READ-OUT, never a control. There is no tenant-facing setter, and
   * grouping this with start/pause/stop would itself be an affordance claim. A tenant-facing
   * setter is out of scope.
   */
  concurrency_limit: number;

  /**
   * Live utilisation against that ceiling, or `null` when it cannot be read.
   *
   * **Account-wide, not campaign-wide** — the same Redis counter AI calls use, so
   * a supervisor seeing "4 of 5" is seeing their real headroom including traffic
   * this campaign knows nothing about. `null` rather than a substituted local
   * count when Redis is degraded: "4 of 5" and "we don't know" are different
   * answers, and the strip's concurrency diagnosis must not fire on a guess.
   */
  concurrency_in_use: number | null;

  // The per-tile hour-over-hour delta is NOT here, and this is the second
  // deliberate omission rather than an oversight.
  //
  // A `previous_hour` block was built and removed before shipping. It carried the
  // flow metrics over `[now()-2h, now()-1h)`, which is a sound window — but every
  // field it would have been compared AGAINST is a campaign-LIFETIME aggregate:
  // `human_connects`, `aht_seconds` and the rest have no time filter, and
  // `abandonment_rate_24h_pct` is a 24h window. So the console would have rendered
  // a lifetime figure beside one hour of it: a campaign on day three with 5,000
  // lifetime connects and 30 in that hour reads as a permanent 99% collapse, and
  // the damped lifetime averages make every rate delta understate the real move
  // with an unreliable sign.
  //
  // The honest shape needs BOTH windows — last hour and the hour before it — so the
  // comparison is like-for-like, which is the same amount of SQL again. It lands
  // with the health strip, where the console gets a coherent trend surface at once.
  // A delta that is confidently wrong in a fixed direction is worse than no delta,
  // and this tile's whole purpose is the sentence "66%, down from 74%".
}

/**
 * Every field of {@link AgencyCampaignStats}, as runtime-enumerable data.
 *
 * The one runtime export in an otherwise types-only module, and it earns the
 * exception. Three required fields shipped with no producer at all,
 * through two separate holes — and only one of them is reachable by a type:
 *
 *  1. **The producer not writing a declared field.** `stats()` returned
 *     `Record<string, number>`; an index signature satisfies every field name, so
 *     the compiler agreed the contract was met. It now returns
 *     `Omit<AgencyCampaignStats, 'campaign_id' | 'status'>`, which makes this arm a
 *     compile error and needs nothing from this roster.
 *  2. **The producer reading its own SQL by string key.** The mapper pulls
 *     `row['answered_24h']` out of an untyped `Record<string, string>`, so renaming
 *     or dropping that column yields a confident `0` that satisfies every type in
 *     the chain and reports a perfectly compliant campaign. No annotation can see
 *     across that boundary; only executing the query can.
 *
 * This roster is what lets a test walk arm 2 exhaustively instead of spot-checking
 * the three fields someone remembered. It is typed `Record<keyof …, true>`, so a
 * field added to the interface and not here fails `npm run lint` — which is the
 * whole reason it lives in `src/` rather than beside the test that consumes it:
 * the dialer runtime's `tsconfig.json` excludes `test/`, so the identical guard written there
 * would be type-checked by nothing and would rot without ever going red.
 */
/**
 * The fields the ROUTE composes rather than the repository.
 *
 * The supervisor dashboard's health strip needs DNC health, the account concurrency guard's
 * live counter and calling-hours evaluation — none of which a repository can
 * see. So the payload now has two producers, and `stats()` returns an `Omit` of
 * exactly this set.
 *
 * The no-producerless-field guarantee is unchanged and still enforced in one place: the
 * route annotates its literal `const payload: AgencyCampaignStats`, so a new
 * required field is a compile error at whichever producer fails to supply it.
 * This constant exists so a test can assert the SPLIT is what it claims, rather
 * than a comment claiming it.
 */
export const AGENCY_STATS_ROUTE_FIELDS = [
  'campaign_id', 'status', 'stall', 'other_stalls',
  'concurrency_limit', 'concurrency_in_use',
] as const satisfies readonly (keyof AgencyCampaignStats)[];

export const AGENCY_CAMPAIGN_STATS_FIELDS: Record<keyof AgencyCampaignStats, true> = {
  campaign_id: true,
  status: true,
  // Composed by the ROUTE, not the repository — see `AGENCY_STATS_ROUTE_FIELDS`.
  stall: true,
  other_stalls: true,
  concurrency_limit: true,
  concurrency_in_use: true,
  contacts_total: true,
  contacts_pending: true,
  contacts_in_flight: true,
  contacts_completed: true,
  contacts_suppressed: true,
  contacts_exhausted: true,
  retries_pending: true,
  attempts_live: true,
  attempts_total: true,
  attempts_connected: true,
  attempts_retried: true,
  agents_live: true,
  abandoned_24h: true,
  answered_24h: true,
  abandonment_rate_24h_pct: true,
  agents_by_state: true,
  agents: true,
  human_connects: true,
  machine_connects: true,
  unclassified_connects: true,
  machine_connects_available: true,
  connect_rate_pct: true,
  attempts_success: true,
  success_rate_pct: true,
  aht_seconds: true,
  aht_seconds_including_machine: true,
  avg_wrapup_seconds: true,
  abandonment_ceiling_pct: true,
};

// ─── Campaign lifecycle timestamps ─────────────────────────────────
//
// `started_at`, `ended_at` and `last_transition_by` are COLUMNS on
// `agency_campaigns` (migration 108), written by the two statements that move a
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
 * `user_id` is the public API layer's user id — opaque to the dialer runtime (D3), the same kind of value as
 * `agency_call_attempts.dispositioned_by_user_id` (migration 079) and
 * `agency_agent_sessions.agent_user_id`.
 *
 * `name` is `string | null` rather than `string`, and the null is not laziness.
 * **The dialer runtime has no user table** (D3): there is nothing here to resolve an id to a
 * name against, so the only name the dialer runtime can serve is the one public API layer sent AT THE
 * MOMENT OF THE TRANSITION. A stored id with no name is therefore a real state —
 * an older public API layer, or a direct S2S caller that sent an id and no display name —
 * and it is a different fact from "nobody caused this". The console renders the id
 * in that case; inventing a name from the id, or dropping the actor entirely
 * because half of it is missing, would both lose information the row is holding.
 *
 * ⚠️ The name is a SNAPSHOT and is never refreshed. A user who is later renamed in
 * the public API layer keeps their old name on transitions that already happened, which is the
 * correct reading for a historical record (it says who pressed the button as they
 * were known then) and the wrong one for a directory. Same choice, same reason, as
 * migration 079 storing `dispositioned_on_behalf` rather than re-deriving it.
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

// ─── The campaign stats TIME SERIES (`GET /agency-campaigns/:id/stats/series`) ─
//
// `GET /:id/stats` is a campaign's numbers RIGHT NOW: lifetime counters, a live
// floor, a health strip. It cannot answer "is this campaign getting better or
// worse", because every counter on it is a single lifetime total — the same
// reason the `previous_hour` block was cut from that payload (see the note at the
// end of `AgencyCampaignStats`). This is the shape that can: one row per calendar
// bucket, over a caller-chosen window.

/**
 * One bucket of a campaign's series — {@link AgencyAgentStatsBucket} minus
 * `occupancy`.
 *
 * ── Derived from that type, never re-declared ─────────────────────────
 *
 * The console already has bucket helpers written against the agent record's
 * buckets — sparkline, delta, tooltip — and the whole point of this shape is that
 * they are reused rather than forked. An `Omit` is what makes that a compile-time
 * property instead of a claim: a sixth counter added to the agent's bucket appears
 * here automatically, and a RENAMED one is a build error at the repository that
 * fills this in. Two hand-maintained copies of five field names is exactly how the
 * client ends up with two nearly-identical helpers, one of which is wrong.
 *
 * (`AgencyAgentStatsBucket` is declared further down this file. Deliberate: this
 * section is about the campaign, and a type alias is hoisted, so placing the
 * campaign's contract with the campaign's other contracts costs nothing.)
 *
 * ── `occupancy` is the one field that is NOT carried, and it cannot be ──────
 *
 * `AgencyAgentOccupancy` is where ONE PERSON's time went, differenced from that
 * person's transition log. A campaign has a floor, not a person: summing six
 * agents' `shift_seconds` gives a number whose unit is agent-seconds and whose
 * only honest denominator is headcount × window — neither of which is on this
 * payload. Serving the sum under the same key the agent record uses would put a
 * number on the wire that the console's existing occupancy helper would render as
 * a percentage of the wrong thing. Omitted rather than zero-filled: an
 * all-zeros occupancy block is indistinguishable from "this floor never worked".
 */
export type AgencyCampaignStatsBucket = Omit<AgencyAgentStatsBucket, 'occupancy'>;

/**
 * `GET /api/v1/agency-campaigns/:id/stats/series?from=&to=&bucket=day|week|month`.
 * The public API layer proxies it at `/proxy/agency/campaigns/:campaignId/stats/series`.
 *
 * ── The window is HALF-OPEN `[from, to)` ────────────────────────────
 *
 * Same convention as {@link AgencyAgentStats}, and NOT the attempt spine's
 * inclusive `to`. A half-open window is the only shape that tiles: `[Mon, Tue)`
 * and `[Tue, Wed)` cover Tuesday exactly once, so two consecutive requests can be
 * concatenated without a day being counted twice. The spine's `to` is inclusive
 * because it is a "show me up to here" FILTER; this is an aggregate somebody will
 * add up. The difference is invisible in a URL, which is why it is written down on
 * both.
 *
 * Buckets are cut on `dialed_at`, so an attempt that was created and never placed
 * is in no bucket at all. That is deliberate: a dial that never happened is not a
 * dial, and the alternative (`created_at`) buckets an attempt into a day nothing
 * was dialled in.
 *
 * ── EVERY bucket in the range is present, zeros included ────────────────
 *
 * A weekend arrives as `attempts: 0`, never as an absent key. "We dialled nobody
 * that day" and "that day was not in the response" are different facts and only
 * the first one can be drawn: a chart fed a gappy series either draws a straight
 * line through the hole (inventing dials that did not happen) or shifts every
 * later point one column left. The calendar spine is generated in SQL and the
 * aggregate is LEFT JOINed onto it, so the zero-fill is a property of the
 * statement rather than something a consumer has to reconstruct.
 *
 * This is the one place this payload deliberately DIFFERS from
 * {@link AgencyAgentStats}, whose `buckets[]` carries only the labels that had
 * something in them. That read is a person's own record, where an empty day is
 * usually a day they did not work; this one is a campaign's trend line, where an
 * empty day is a data point.
 *
 * ── NO RATES ON THE WIRE ────────────────────────────────────
 *
 * There is no `connect_rate_pct` and no `success_rate_pct` on a bucket, and that
 * is a decision rather than an omission. Both numerator and denominator are on
 * every bucket, so the client derives whichever rate it is drawing — and it has
 * to, because a chart aggregating several buckets into one column needs
 * `Σnum / Σden`, not the average of the per-bucket rates, which is a different
 * (and wrong) number. Shipping the rate invites exactly that mistake. The
 * `null`-not-zero rule that governs every rate on this surface then lives in one
 * place — the client's own divide — instead of being re-decided per bucket here.
 */
export interface AgencyCampaignStatsSeries {
  /** Echoed from the path. */
  campaign_id: string;
  /** Echoed so a consumer never infers the grouping from the labels. */
  bucket: AgencyStatsBucketUnit;
  /**
   * The IANA zone the buckets were actually cut in — the campaign's own
   * `default_timezone`, RESOLVED.
   *
   * **Resolved, not the stored column.** `default_timezone` is `VARCHAR(64)` with
   * no constraint and comes from customer-facing config, and the query resolves it
   * through `pg_timezone_names` with a UTC fallback precisely so an unparseable
   * value cannot raise `22023` and 500 the read. The two differ exactly when the
   * stored value is garbage — i.e. echoing the column would hand the console
   * `Asia/Kolkata_typo` to print over columns that are in fact UTC, on the one
   * campaign whose zone is broken. Same rule, same reason, as
   * `AgencyGroupPage.resolved_timezone`.
   */
  timezone: string;
  /**
   * Ascending by `bucket_start`, gap-free, and NEVER empty: the parser refuses
   * `from >= to`, so every accepted window contains at least one bucket.
   *
   * ⚠️ The FIRST and LAST buckets can be partial, and this is the payload's one
   * real sharp edge. The window bounds are instants and the buckets are calendar
   * days in the campaign's zone, so `from=2026-08-11` (which parses as
   * `2026-08-11T00:00:00Z`) on an `Asia/Kolkata` campaign starts the series at
   * 05:30 local — the `2026-08-11` bucket then holds 18.5 hours of that day, not
   * 24. Reinterpreting a date-only bound as local midnight was the alternative and
   * is worse: it would make the same URL mean a different window per campaign, and
   * it needs a second date-parsing rule beside `parseFilterDate`'s. A caller who
   * needs whole local days sends zone-aware instants
   * (`from=2026-08-10T18:30:00Z`).
   *
   * ⚠️ At `bucket=week` and `bucket=month` the SAME truncation makes the partial
   * edges much larger, and the label does not say so. A bucket is labelled with
   * its truncated START — `date_trunc('month', …)`, formatted `YYYY-MM-DD` — so a
   * bound anywhere inside a period is labelled with the period's first day while
   * holding only the part of it inside the window: `from=2026-05-11&bucket=month`
   * emits a bucket labelled `2026-05-01` containing 21 days of May (verified by
   * execution), and `bucket=week` does the same to a week from its ISO Monday. A
   * consumer reading `2026-05-01` as "May" therefore reads a two-thirds month as a
   * whole one, and comparing it against the next bucket (a full June) reads as a
   * jump in volume that is really a jump in bucket width.
   *
   * Not clipped, not relabelled and not dropped, for the reason above plus one
   * more: the label is `bucketStartSql`, the single expression the spine and the
   * aggregate both label with, and a "clipped" label would have to be a second
   * spelling of it. So the rule for a caller drawing week or month columns is the
   * same as for days, only it matters more: align `from`/`to` with period
   * boundaries in the campaign's zone, or expect the first and last columns to be
   * short.
   */
  buckets: AgencyCampaignStatsBucket[];
}

// ─── The agent's own record (`GET /agency-agents/:agentUserId/stats`) ────────
//
// A per-PERSON, cross-campaign read. Everything above is per campaign: the
// supervisor dashboard answers "how is this campaign doing", and the attempt
// spine answers "what happened to this contact". Neither can answer "what did I
// do this week" — the attempt row points at a SESSION (`reserved_agent_id`), and
// a session is per shift per campaign, so the person is two joins away from
// their own work. That two-hop join is the whole reason this is its own surface
// rather than a filter on an existing one.

/** How the record's buckets are cut. There is deliberately no `hour` and no `year`. */
export type AgencyStatsBucketUnit = 'day' | 'week' | 'month';

/**
 * Where an agent's time went, in seconds, derived from
 * `agency_agent_session_events` (migration 105).
 *
 * **Only meaningful from that migration forward.** Sessions that predate it have
 * no events, and the honest answer for them is every field at zero — never a
 * duration reconstructed from `agency_agent_sessions.state_since`, which is a
 * snapshot every transition overwrites and would therefore attribute an agent's
 * entire history to whatever state they happen to be in now.
 *
 * ⚠️ **`by_state.reserved` is structurally 0 today, and that is not a bug in this
 * payload.** `reserved` is the only agent state deliberately NOT mirrored to
 * `agency_agent_sessions` (see `pacing-engine.ts`'s `dialUpTo`: a mirror there is
 * write-only, restamps the risk-ordering anchor, and costs a round trip per
 * reserved agent per 250ms tick) — so no transition into it is logged and its
 * time is folded into the preceding `available` interval. The key is present
 * because the state is part of {@link AgencyAgentState} and a consumer's
 * exhaustive switch needs it; treat a non-zero value as evidence that mirroring
 * changed, not as a rounding artefact. The state is sub-second-to-15s transient,
 * so the fold costs `available` a small over-count and nothing else.
 */
export interface AgencyAgentOccupancy {
  /**
   * Every second the agent was logged in — i.e. the sum of `by_state` EXCLUDING
   * `offline`.
   *
   * The denominator for occupancy (`by_state.on_call / shift_seconds`), left
   * undivided on purpose: contact centres disagree about whether break time
   * belongs in it, and both readings are computable from this payload
   * (`shift_seconds - by_state.break` is the other one). Picking one silently is
   * how two screens come to disagree about "occupancy".
   */
  shift_seconds: number;
  /**
   * All six states, always present. Zero and absent are indistinguishable to a
   * consumer.
   *
   * ⚠️ The consequence, recorded because it is the shape's one real cost: every
   * value at zero has THREE causes and this payload cannot separate them — the
   * agent has no events (a session predating migration 105), the agent has events
   * but none inside the window, or the occupancy read itself failed and the record
   * was served without it (see `AgencyAgentStatsRepository.stats`, which warns).
   * Separating them needs a fourth state on the wire — a nullable block, or an
   * explicit "not measured" — which is a contract change every consumer would have
   * to render, not something a caller can infer. Until one is made, the log line
   * is where the third case lives.
   */
  by_state: Record<AgencyAgentState, number>;
}

/** One bucket of the agent's record. */
export interface AgencyAgentStatsBucket {
  /**
   * `YYYY-MM-DD`, the bucket's first day **in the campaign's own timezone**.
   *
   * A date rather than an instant, and formatted in SQL rather than serialised
   * from a `Date` — see `bucketStartSql`. For `week` it is the Monday (Postgres
   * `date_trunc('week', …)`, which matches the ISO-8601 reading `calling_days`
   * already pins); for `month`, the 1st.
   */
  bucket_start: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  occupancy: AgencyAgentOccupancy;
}

/** The agent's work on one campaign over the whole window. */
export interface AgencyAgentCampaignRow {
  campaign_id: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
}

/** The window totals. Every counter here is the exact sum of the buckets. */
export interface AgencyAgentStatsTotals {
  /**
   * Every attempt the agent was reserved for, dialled inside the window.
   *
   * Reported beside {@link connected} rather than instead of it — that is a
   * product decision, not a redundancy. An agent's dial count and their connect
   * count answer different questions (how hard did the dialer work them, versus
   * how many conversations did they get), the gap between them is the list's
   * quality rather than the agent's, and collapsing them would make a bad roster
   * read as a bad agent.
   */
  attempts: number;
  /** `bridged_at IS NOT NULL` — media actually joined the agent to a person. */
  connected: number;
  /** `connected / attempts`, or `null` when nothing was dialled. */
  connect_rate_pct: number | null;
  /** Connected attempts whose disposition maps to an `is_success` catalog entry. */
  successes: number;
  /**
   * `successes / connected`, or `null` when nothing connected.
   *
   * **The denominator is `connected`, NOT `attempts`.** A call that never bridged
   * had no conversation to convert, so charging it against the agent would make
   * their conversion rate a function of the roster's answer rate. Same rule, and
   * the same shared helper, as every other rate here: `null` on a zero
   * denominator, never `0`.
   */
  success_rate_pct: number | null;
  /**
   * Summed `ended_at - bridged_at` over connected attempts — the AGENT's leg.
   *
   * Deliberately not the persisted `talk_seconds` column, which is anchored on
   * the carrier's answer and is nonzero even when no agent ever bridged (an
   * abandoned attempt settles carrying the apology clip's talk time). Attempts
   * with `outcome = 'orphaned'` are excluded: the reaper stamps `ended_at` at
   * SWEEP time, so a conversation whose replica died would contribute its whole
   * time-until-sweep — minutes, or hours — to one agent's day.
   */
  talk_seconds: number;
  /**
   * Summed measured wrap-up (`wrapup_ended_at - wrapup_started_at`), over the
   * three resolutions that are evidence of how long wrap-up TAKES.
   *
   * Never the `wrapup_seconds` column, which is the allotment copied from the
   * campaign at wrap-up entry — averaging that hands the operator their own
   * setting back as if it were measurement (migration 088).
   */
  wrapup_seconds: number;
  /**
   * `(talk_seconds + wrapup_seconds) / connected`, or `null` when nothing
   * connected.
   *
   * ⚠️ **This is NOT the same definition as {@link AgencyCampaignStats.aht_seconds},
   * which is talk only and excludes voicemail-dispositioned attempts.** The
   * difference is deliberate and it is the one number on this payload most likely
   * to be assumed identical: on an agent's own record the wrap-up is part of the
   * handle (it is time they cannot take another call in), and a talk-only average
   * is already derivable as `talk_seconds / connected` from the two fields beside
   * it. The denominator is `connected` — the field on this payload — so a reader
   * can always reproduce the number; the numerators exclude orphans and unmeasured
   * wrap-ups, so this runs slightly LOW where those exist, which is the safer
   * direction than an AHT inflated by a reaper sweep interval.
   */
  aht_seconds: number | null;
  /** Distinct campaigns the agent was reserved on inside the window. */
  campaigns: number;
  occupancy: AgencyAgentOccupancy;
}

/**
 * `GET /api/v1/agency-agents/:agentUserId/stats`.
 *
 * ── The bucketing rule, because a reader's first thought will be "bug" ──────
 *
 * Buckets are cut in **each campaign's own `default_timezone`, derived per
 * attempt** — not per query, not in UTC, and there is deliberately no `tz`
 * parameter. So an attempt dialled at 23:30 IST on a campaign configured
 * `Asia/Kolkata` lands in that day's bucket even though it is 18:00 UTC, and an
 * attempt on a `America/New_York` campaign an hour later lands in the PREVIOUS
 * day's bucket.
 *
 * The consequence that looks wrong: a "day" is not one contiguous 24-hour window
 * when an agent works campaigns in different zones — two buckets labelled the
 * same date can cover overlapping wall-clock instants. That is accepted, because
 * the alternative is worse in the direction that actually matters. Cutting in one
 * chosen zone makes every attempt's bucket depend on a parameter the reader
 * supplied, so the same call appears in different days depending on who is
 * looking; and for an agent's own record "the day it was for that call" is the
 * right reading — it is the day the customer was in, the day the campaign's
 * calling window was drawn against, and the day the agent's shift was rostered
 * to.
 *
 * The property it buys is exact summation: because the zone comes off the
 * attempt's own campaign, **every attempt lands in exactly one bucket**, so
 * `totals`, `buckets[]` and `by_campaign[]` are three foldings of one row set
 * with no double-counting and no gaps. `totals` is computed BY summing the
 * buckets rather than by a second aggregate, so that property is structural
 * rather than something two queries have to agree about.
 *
 * Buckets are cut on `dialed_at` — never `created_at` (which precedes the dial by
 * a dispatch hop, so it can bucket an attempt into a day nothing was dialled in)
 * and never `ended_at` (which pushes a call straddling midnight into the later
 * day and leaves a still-live one in no day at all). Same choice, same reasons,
 * as `hourlyBuckets`.
 *
 * A bucket with occupancy but no attempts is emitted, and is one of the more
 * useful rows here: it is an agent who was on the floor and never dialled.
 */
export interface AgencyAgentStats {
  /** Echoed back — the public API layer's user id, opaque to the dialer runtime (D3). */
  agent_user_id: string;
  /** Echoed so a consumer never has to infer the grouping from the labels. */
  bucket: AgencyStatsBucketUnit;
  /** The window as requested: `from` inclusive, `to` EXCLUSIVE, both ISO-8601 UTC. */
  from: string;
  to: string;
  totals: AgencyAgentStatsTotals;
  /** Ascending by `bucket_start`. Empty when the agent did nothing in the window. */
  buckets: AgencyAgentStatsBucket[];
  /** Unsorted; the console orders these. Sums to `totals` on every counter. */
  by_campaign: AgencyAgentCampaignRow[];
}

// ─── The supervisor's ROSTER (`GET /agency-agents/stats`) ────────────────────
//
// FROZEN AT PHASE 01, and frozen harder than the shapes above it, because the
// product decision behind it is "live query now, nightly rollup in phase 02":
// phase 02 swaps the data source underneath a console already built against this
// payload, so the payload IS the contract from the moment phase 01 ships.
// Anything wanted later must be shaped now or arrive as an additive optional
// field.
//
// ── Why this is a route and not a loop over the per-agent record ─────────────
//
// `AgencyAgentStats` answers "what did THIS person do", and a supervisor's first
// question is never that — it is "who is my floor and how do they compare".
// Fanning the per-agent read out over thirty agents costs sixty statements, and
// worse, it cannot produce the one thing that makes any single number readable:
// the cohort it sits in. A median has to be computed over the whole floor at
// once, so it has to be one read.
//
// ── What is deliberately NOT here ───────────────────────────────────────────
//
//   * **No composite "agent score".** Deferred past phase 02 by explicit
//     decision. A single ranked number invites exactly the reading the
//     `rates_reportable` flag below exists to prevent.
//   * **No `agent_user_id` filter.** The subject of this route is the WHOLE
//     roster; narrowing to named agents is phase 02's compare surface. A filter
//     here would make `benchmark` mean something different per request under the
//     same name.
//   * **No date buckets.** This is one window, one row per agent. The per-agent
//     record is where a trend lives, and its per-campaign-timezone bucketing
//     rule (see `AgencyAgentStats`) therefore does not apply to anything here —
//     there is no bucket to cut, so there is no zone to resolve.
//   * **No polling / wallboard semantics.** A windowed historical read.
//
// ── `account_id` is a PREDICATE, and a tenant-wide roster is not reachable ───
//
// The dialer runtime scopes every statement on `agency_agent_sessions.tenant_id` AND
// `.account_id`. A tenant-wide roster is a separate future mode with its own
// route; it must be impossible to obtain one by omitting a parameter, which is
// why neither is a filter with a default.

/** Minimum denominator before a rate is reportable. See AgencyRosterAgentRow
 * and AgencyGroupRow — the two rows that gate on it, from this one value, and each
 * on BOTH denominators: `attempts` for `rates_reportable`, `connected` for
 * `success_rate_reportable`. One number, four comparisons, no second threshold. */
export const AGENCY_ROSTER_MIN_RATE_DENOMINATOR = 20;

/**
 * What the roster may be ordered by, server-side.
 *
 * Every member except `agent_user_id` is a metric on {@link AgencyRosterAgentRow},
 * and four of them (`connect_rate_pct`, `success_rate_pct`, `aht_seconds`,
 * `occupancy_pct`) are NULLABLE — which is the whole reason the ordering rule has
 * to be stated rather than left to the database's default:
 *
 * **Nulls sort LAST in both directions.** A row with no measurable rate is not
 * the best row and it is not the worst row; it is not ranked. Postgres would
 * otherwise put NULLs first under `DESC` and hand a supervisor a page of agents
 * who dialled nobody at the top of "best connect rate".
 *
 * `agent_user_id` is the tiebreaker on EVERY sort — including the sorts where
 * ties are common (`successes` is a small integer, and a floor of thirty agents
 * will have several on 4). Without it two reads of the same window can return the
 * same rows in a different order, which reads as data changing under the reader.
 */
export type AgencyRosterSort =
  | 'attempts' | 'connected' | 'connect_rate_pct'
  | 'successes' | 'success_rate_pct' | 'aht_seconds'
  | 'talk_seconds' | 'occupancy_pct' | 'agent_user_id';

/**
 * One agent's line on the roster.
 *
 * Every rate on this row travels with its own denominator, and that is a rule
 * rather than a convenience: a rate whose denominator is not on the same object
 * cannot be checked, and an uncheckable rate is the one a supervisor acts on.
 */
export interface AgencyRosterAgentRow {
  /** the public API layer's user id, opaque to the dialer runtime (D3). The dialer runtime has no user table and can only ever serve a UUID; the public API layer adds the name. */
  agent_user_id: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;

  /** null on a zero denominator — nothing dialled is NOT a 0% connect rate. */
  connect_rate_pct: number | null;
  /** Denominator is `connected`, not `attempts`. */
  success_rate_pct: number | null;
  /** (talk + wrapup) / connected. Same definition as AgencyAgentStatsTotals. */
  aht_seconds: number | null;

  /** Distinct campaigns this agent dialled inside the window. */
  campaigns: number;

  /**
   * Sum of by_state EXCLUDING offline, same definition as
   * AgencyAgentOccupancy.shift_seconds. 0 when occupancy is unmeasured.
   */
  shift_seconds: number;
  /** Break seconds, so the other occupancy reading stays derivable. */
  break_seconds: number;
  /**
   * (talk + wrapup) / shift_seconds, as a percentage.
   *
   * This route PICKS a denominator where AgencyAgentOccupancy deliberately does
   * not, because a roster column has to be one number. Break time is INCLUDED in
   * the denominator; `shift_seconds - break_seconds` gives the other reading and
   * both parts are on this row so it stays computable.
   *
   * null — never 0 — when shift_seconds is 0, which is also what an unmeasured
   * occupancy read produces. Zero and unmeasured are indistinguishable here for
   * the same reason they are on AgencyAgentOccupancy.
   *
   * ⚠️ There are THREE ways to arrive at `shift_seconds: 0` and this payload
   * separates none of them, exactly as `AgencyAgentOccupancy.by_state` does not:
   * the agent's sessions predate migration 105 and have no transition events; the
   * agent has events but none inside the window; or **the occupancy read itself
   * failed and the roster was served without it** (the repository catches and
   * warns rather than 500ing the attempt totals — see
   * `AgencyAgentStatsRepository.roster`). The log line is the only place the third
   * case exists. Separating them needs a fourth state on the wire, which is a
   * contract change every consumer has to render.
   */
  occupancy_pct: number | null;

  /** Most recent dial inside the window, ISO instant. null if none. */
  last_dialed_at: string | null;

  /**
   * True when this row's rates cleared AGENCY_ROSTER_MIN_RATE_DENOMINATOR and
   * therefore contributed to `benchmark`'s percentiles.
   *
   * The rates are STILL SERVED when this is false — the caller gets the number
   * and the denominator and decides. What this flag exists for is so every
   * consumer applies ONE threshold rather than three, and so the console can
   * render "not enough calls" instead of a flattering number computed from
   * eleven calls.
   *
   * ── Which denominator, stated because the flag is one bool over three rates ─
   *
   * `attempts` — the row's headline denominator, the count of dials the whole
   * line is built from. A row that fails it contributes to NO percentile pool,
   * which is what makes the flag usable as the single gate its name promises.
   *
   * Two refinements sit on top of it inside `benchmark`, and only ONE of them is
   * expressible as a flag:
   *
   *   * The `success_rate` and `aht` pools additionally require `connected >=` the
   *     same threshold, because those metrics' own denominator is `connected`. An
   *     agent with 400 dials and three connects is reportable — 400 dials is a real
   *     day — and their 33% conversion is still three calls of evidence, which is
   *     precisely the noise the threshold exists to keep out of a median. That
   *     refinement IS on the wire, as `success_rate_reportable` below.
   *   * The `occupancy_pct` pool takes every reportable row with a measurable
   *     occupancy. Its denominator is a DURATION, so the same integer cannot gate
   *     it — "20" means twenty calls, not twenty seconds — and the exclusion that
   *     actually matters there is the null on `shift_seconds: 0`. There is
   *     deliberately no flag for it: a second threshold in SECONDS would be a
   *     number nobody has argued for, and the `null` already says "unmeasured".
   */
  rates_reportable: boolean;

  /**
   * True when this row cleared AGENCY_ROSTER_MIN_RATE_DENOMINATOR on **`connected`**
   * — the floor under the two metrics that divide by it, `success_rate_pct` and
   * `aht_seconds`.
   *
   * ── Why one flag was not enough ─────────────────────────────────────────────
   *
   * `rates_reportable` floors `attempts`. `success_rate_pct` divides by `connected`.
   * So 20 dials, ONE connect and one conversion is a reportable row carrying
   * `success_rate_pct: 100` — a 100% conversion built from a single conversation,
   * printed beside a named person, which is the exact reading the first flag was
   * added to prevent. The house rule is a minimum volume PER METRIC, and one
   * threshold on one denominator cannot express two denominators.
   *
   * ── It IMPLIES `rates_reportable`, so gating on it alone is correct ─────────
   *
   * `connected <= attempts` always — a connect is an attempt that bridged — and
   * `rates_reportable` IS `attempts >= 20`, so `connected >= 20` is strictly
   * stronger and can never be true where `rates_reportable` is false. A consumer
   * rendering `success_rate_pct` or `aht_seconds` therefore needs to read only this
   * flag; it does not have to AND the two. The converse does not hold, which is why
   * both are served: `connect_rate_pct` is gated by `rates_reportable` alone and
   * must stay quotable on a row that connected almost nobody, because that row's
   * connect rate is precisely the finding.
   *
   * Same constant, same comparison, and the same predicate the `success_rate` and
   * `aht` percentile pools admit rows by — so a console that withholds on this flag
   * withholds exactly the rows the benchmark refused to rank.
   */
  success_rate_reportable: boolean;
}

/**
 * p25 / median / p75 for one metric across the cohort.
 *
 * Linear-interpolated between the two neighbouring rows (the `percentile_cont`
 * reading, not `percentile_disc`), so a floor of four agents still produces a
 * median rather than snapping to one agent's number. All three are null together
 * when no row qualified — never 0, for the same reason no rate is ever 0 on an
 * empty denominator.
 */
export interface AgencyRosterPercentiles {
  p25: number | null;
  median: number | null;
  p75: number | null;
}

/**
 * The cohort the rows were drawn from — what makes a single agent's number
 * readable.
 *
 * ── Which agents are in it ────────────────────────────────────────────────
 * Every agent who dialled in the window and scope, INCLUDING one whose
 * membership was later revoked: the cohort is "the floor that week", and a
 * supervisor comparing against it wants the floor as it actually was. This is
 * deliberately NOT affected by the public API layer's `include_inactive`, which controls which
 * ROWS are returned, not what they are measured against. A benchmark that moved
 * when you toggled a row filter would be a different number under the same name.
 *
 * "Who DIALLED" is also what decides whether an agent gets a row at all, and the
 * consequence is worth naming: an agent who was on the floor all day and never
 * dialled has NO line here, though the per-agent record deliberately does emit
 * their empty bucket. Two reasons, and the second is the load-bearing one — the
 * cohort is defined above as the agents who dialled, so a row for someone who did
 * not would not belong to the benchmark it is displayed against; and the roster's
 * row set must not change shape when the occupancy read degrades. If occupancy
 * could ADD rows, a failed events-table read would silently delete agents from
 * the page, which is a far worse failure than serving their occupancy as zero.
 *
 * ── Percentiles exclude thin rows ─────────────────────────────────────────
 * Only rows with `rates_reportable: true` contribute. A new joiner's 11-call
 * rate is noise and would drag the median. `agents_rated` is that count;
 * `agents` is the total. When `agents_rated` is 0 every percentile is null.
 *
 * ── Pooled rates are NOT the median ───────────────────────────────────────
 * `connect_rate_pct` here is total connected / total attempts across the whole
 * cohort — the floor's actual rate. The median is in `connect_rate.median`.
 * They answer different questions and both are on the payload so neither has to
 * be recomputed by a consumer.
 *
 * The pooled rates are computed over EVERY row, thin ones included, and that is
 * not an inconsistency with the paragraph above. A pooled rate is a ratio of two
 * sums, so a thin row contributes proportionally to its own size — eleven calls
 * move it by eleven calls' worth. A median is a ratio of ratios, where the same
 * eleven calls count as one full vote. That asymmetry is the entire reason both
 * numbers are on this payload.
 */
export interface AgencyRosterBenchmark {
  agents: number;
  agents_rated: number;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  connect_rate_pct: number | null;
  success_rate_pct: number | null;
  aht_seconds: number | null;
  connect_rate: AgencyRosterPercentiles;
  success_rate: AgencyRosterPercentiles;
  occupancy_pct: AgencyRosterPercentiles;

  /**
   * Pooled shift and break seconds across the cohort — the two terms that make a
   * REAL team-row utilisation rate derivable, rather than a median labelled as one.
   *
   * ── The hole these close ────────────────────────────────────────────────────
   *
   * This object already carried pooled `talk_seconds` and `wrapup_seconds` — the
   * NUMERATOR of occupancy — and no pooled denominator, so the only cohort-wide
   * occupancy figure expressible was `occupancy_pct.median`. The console renders it
   * in the team row, honestly labelled as the median, because a pooled rate was not
   * derivable from the payload. With these two it is: pooled occupancy is
   * `(talk_seconds + wrapup_seconds) / shift_seconds`, and the break-excluding
   * reading is `… / (shift_seconds - break_seconds)` — the same two readings, and
   * the same refusal to pre-divide, as {@link AgencyAgentOccupancy}.
   *
   * ── Why they are POOLED here and must not be derived from `rows` ───────────
   *
   * A consumer summing the visible rows would get a number that MOVES when
   * the public API layer's `include_inactive` toggle moves, because that toggle removes rows.
   * This object's own contract (above) forbids exactly that: the benchmark is the
   * floor as it actually was, and a benchmark that changed when you flipped a row
   * filter would be a different number under the same name.
   *
   * Pooled over the SAME agent set as `attempts` / `connected` / `talk_seconds` —
   * every row, thin ones included — so these cannot disagree with the fields
   * beside them.
   *
   * ⚠️ `shift_seconds: 0` inherits every ambiguity the per-row field has: no
   * transition events, none in the window, or a FAILED occupancy read served
   * degraded. When it is 0 the derived pooled occupancy is `null` by the same
   * null-not-zero rule, not `0`.
   */
  shift_seconds: number;
  break_seconds: number;

  /**
   * Handling-time percentiles, which this object previously had only as the pooled
   * scalar `aht_seconds`.
   *
   * The pooled scalar is seconds-per-connected-call across the whole floor, so it
   * is dominated by the highest-volume agent; `aht.median` is the middle AGENT's
   * handling time. Exactly the same asymmetry as `connect_rate_pct` versus
   * `connect_rate.median`, and it is the reason both are served rather than one.
   *
   * ── The pool gate is `success_rate`'s, not `connect_rate`'s ────────────────
   *
   * `aht_seconds` divides by `connected`, the same denominator `success_rate_pct`
   * divides by — so it takes the same two-part gate: `rates_reportable` (the row's
   * headline `attempts` floor) AND `connected >=`
   * AGENCY_ROSTER_MIN_RATE_DENOMINATOR. A row with 400 dials and three connects is
   * a reportable row whose average handling time is three calls of evidence, which
   * is precisely the noise a median must not carry. Rows whose `aht_seconds` is
   * `null` (nothing connected) are excluded on top, as in every other pool — a null
   * ranked as 0 would put "no calls" at the fastest end of the distribution.
   *
   * That two-part gate is what `AgencyRosterAgentRow.success_rate_reportable` puts
   * on the wire, from the same predicate — so the rows a console withholds are the
   * rows this pool refused, rather than a set that agrees with it by coincidence.
   */
  aht: AgencyRosterPercentiles;
}

/**
 * The roster read's whole response — `GET /api/v1/agency-agents/stats`.
 *
 * ── Every request parameter is echoed, on purpose ───────────────────────────
 *
 * `from`, `to`, `campaign_id`, `sort`, `order` and `limit` all come back. The
 * window is echoed for the same reason the per-agent record echoes it: a caller
 * must never have to infer which window they were served. `sort`/`order`/`limit`
 * are echoed because they are applied SERVER-side — a console that sorted
 * locally would be sorting one page of a ranked list, which is a different and
 * wrong answer — so the response is the only place the applied ordering exists.
 *
 * ── `total_agents` is pre-`limit` and post-scope ────────────────────────────
 *
 * So the console can say "showing 100 of 137" rather than implying the floor is
 * whatever fitted on the page. `benchmark.agents` is the same number by
 * construction; it is repeated inside `benchmark` because a consumer rendering a
 * comparison should not have to reach outside the object it is comparing against.
 */
export interface AgencyRosterPage {
  from: string;
  to: string;
  campaign_id: string | null;
  sort: AgencyRosterSort;
  order: 'asc' | 'desc';
  limit: number;
  /** Agents matching scope+window before `limit`. */
  total_agents: number;
  rows: AgencyRosterAgentRow[];
  benchmark: AgencyRosterBenchmark;
}

// ─── THE GROUPED READ (`GET /api/v1/agency-agents/grouped-stats`, phase 02a) ──
//
// One general aggregate over agency dial attempts, so the console can answer "who
// drove this campaign", "which hours connect" and "how does this agent's week
// trend" without a route per question.
//
// ── Why it is a NEW route and not `group_by` on the roster ───────────────────
//
// The roster payload is frozen (phase 02c swaps its data source under a console
// already built against it). Adding `group_by` there would make `rows`
// polymorphic: `AgencyRosterAgentRow` is keyed on `agent_user_id`, and a
// campaign-grouped or hour-grouped row is not that shape. A polymorphic frozen
// payload is the worst of both — a consumer can neither rely on the shape nor be
// told when it changes.
//
// ── What this read deliberately does NOT carry ──────────────────────────────
//
//   * **No occupancy.** It comes from `agency_agent_session_events` in a second
//     statement over a table whose `session_id` is indexed by nothing; the roster
//     gets away with that only because its row count is bounded by HEADCOUNT,
//     while this read's cardinality is a PRODUCT of its dimensions'. There is a
//     second, independent reason that would stand even if the cost were free:
//     occupancy cannot be attributed to a `disposition` or an `hour_of_day`
//     without inventing an apportionment rule. Occupancy stays on the roster and
//     the per-agent record.
//   * **No benchmark.** {@link AgencyRosterBenchmark} is a statement about a
//     cohort of PEOPLE — "the middle half of the floor". A cohort of dispositions
//     or of hours is not a peer group, and a median over them would be a number
//     with no meaning that a console would nonetheless render. Comparison stays on
//     the roster.
//   * **No `agent_user_id` filter**, on either service. Same reason as the roster:
//     the dialer runtime has no user table, `agent_user_id` is an opaque string to it (D3), so
//     the dialer runtime cannot validate tenancy on a caller-supplied id — the public API layer's `memberships`
//     is the only place that boundary can exist. Filtering to a person is the
//     per-agent record's job.

/**
 * What a grouped row may be keyed by.
 *
 * `group_by` takes ONE or TWO of these, comma-separated, no duplicates. Three or
 * more is a 400 (`too_many_dimensions`), and that cap is a bound rather than a
 * preference: the row count is the PRODUCT of the dimensions' cardinalities, so a
 * third dimension turns a bounded read into an unbounded one — and every screen in
 * scope needs at most two (`agent`+`campaign` for contribution,
 * `day_of_week`+`hour_of_day` for best hours, `agent`+`day` for a trend).
 *
 * **Order does not matter and is canonicalised** to the declaration order here, so
 * `agent,campaign` and `campaign,agent` are the same read, echo the same
 * `group_by`, and cache the same. ROW order is set by `sort`, never by the
 * request's spelling of `group_by`.
 */
export type AgencyGroupDimension =
  | 'agent' | 'campaign' | 'disposition'
  | 'day' | 'day_of_week' | 'hour_of_day';

/**
 * The row's key — one object, never a union.
 *
 * A member is present if and only if its dimension is in `group_by`, and
 * {@link AgencyGroupPage.group_by} is what says which. One shape rather than a
 * discriminated union because the discriminant already exists at the top level,
 * and a union of 21 combinations is a shape no consumer would narrow correctly.
 */
export interface AgencyGroupKey {
  /** the public API layer's user id, opaque to the dialer runtime (D3). the public API layer adds `agent_name` beside it. */
  agent_user_id?: string;
  campaign_id?: string;
  /**
   * The attempt's submitted disposition — **and `null` is a REAL key value here,
   * not a gap.**
   *
   * `agency_call_attempts.disposition_code` is `VARCHAR(50)` NULL, and an attempt
   * with no disposition submitted is precisely the number a supervisor came to this
   * screen for. Folding null into an "other" bucket, or dropping the group, hides
   * un-dispositioned work — so it is emitted as `null` and the console names it.
   *
   * Present (possibly `null`) if and only if `disposition` is grouped, which is
   * what keeps "absent because not grouped" distinguishable from "grouped, and this
   * group is the un-dispositioned one".
   */
  disposition_code?: string | null;
  /** `YYYY-MM-DD` in the resolved zone. Same format, same spelling, as `bucket_start`. */
  day?: string;
  /**
   * 0 = Sunday … 6 = Saturday, matching Postgres `EXTRACT(DOW …)`.
   *
   * A NUMBER, not a name: a locale-dependent day name in a payload is a formatting
   * decision that belongs in the console, and 0=Sunday is the value the SQL already
   * produces — restating it as a string invites an off-by-one against ISO's
   * 1=Monday.
   */
  day_of_week?: number;
  /** 0–23 in the resolved zone. */
  hour_of_day?: number;
}

/**
 * One grouped cell: the same EIGHT metrics as a roster row, the flag that says
 * whether they may be quoted as numbers, and nothing else.
 *
 * The five counters come from the one shared metric-expression builder every
 * agency attempts aggregate selects, so a grouped cell, a roster line and an
 * agent's own scorecard report the same numbers for the same attempts — which is
 * what lets a supervisor subtract one from another and get zero.
 *
 * **Rates are `null`, never `0`, on a zero denominator.** House rule, unchanged: a
 * `0` means measured-and-zero and a `null` means there was no denominator. A single
 * read that breaks it is how a supervisor comes to read "0% conversion" off a group
 * that connected nobody.
 *
 * ⚠️ `attempts` is ALWAYS >= 1 on a served row, and `connect_rate_pct` therefore
 * never `null`. It is derived rather than asserted: `attempts` is `COUNT(*)` over a
 * `GROUP BY` whose joins are all INNER and whose WHERE requires
 * `dialed_at IS NOT NULL`, with no `HAVING`, no `ROLLUP`/`GROUPING SETS` and no
 * outer join that could manufacture a null-extended row — so a group exists only
 * because at least one attempt satisfied the predicate. The type keeps the `null`
 * because the shared helper produces it and because this row must stay shaped like
 * a roster row; no consumer should carry a branch for it.
 * `success_rate_pct` and `aht_seconds` DO reach `null`, whenever the group
 * connected nobody.
 */
export interface AgencyGroupRow {
  key: AgencyGroupKey;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  /** connected / attempts. */
  connect_rate_pct: number | null;
  /** successes / CONNECTED — a call that never bridged had no conversation to convert. */
  success_rate_pct: number | null;
  /** (talk + wrapup) / connected. Same definition as AgencyRosterAgentRow.aht_seconds. */
  aht_seconds: number | null;
  /**
   * `attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR` — enough volume to quote this
   * row's rates as NUMBERS.
   *
   * The rates are served either way; what this gates is how they read. The house
   * rule is that a rate under the minimum denominator renders as WORDS, because a
   * greyed-out number still gets read as a number — and without a flag on the wire
   * a 100% conversion over a single connect prints beside a named person on the
   * contribution screen. It is the SERVER's threshold on purpose: a consumer
   * recomputing it from the exported constant would disagree the moment the
   * threshold is tuned, which is why that constant exists to EXPLAIN this flag
   * ("fewer than 20 dials") and never to derive it.
   *
   * ── It means the same thing on every grouping ────────────────────────────────
   *
   * The roster's flag is a statement about a PERSON; this one is a statement about
   * a ROW, and the row is whatever was grouped — one agent on one campaign, a whole
   * campaign, a disposition, or one weekday-hour cell. "Enough dials behind this
   * cell to quote a rate for it" holds for all of them, so no per-dimension reading
   * has to be carried. It matters most where the cells are smallest: a best-hours
   * heatmap cell with three dials must not show 33%.
   *
   * The same constant as the roster, deliberately not a second threshold with the
   * same value — one number tuned in one place, or the two reads disagree about
   * which rows are quotable while both claim to be honouring "the" minimum.
   *
   * ⚠️ The denominator is `attempts`, the row's HEADLINE count, which floors
   * `connect_rate_pct` and nothing else. `success_rate_pct` and `aht_seconds` divide
   * by `connected`, which can be far smaller, and their floor is
   * `success_rate_reportable` below — a SECOND flag rather than a footnote, because
   * a row of 20 dials and one converted connect is reportable on this one and still
   * carries `success_rate_pct: 100`.
   */
  rates_reportable: boolean;

  /**
   * `connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR` — enough CONNECTS to quote
   * this row's `success_rate_pct` and `aht_seconds` as numbers.
   *
   * The per-metric half of the same house rule. `rates_reportable` floors
   * `attempts`, which is the right denominator for `connect_rate_pct` and the wrong
   * one for the other two: 20 dials with one connect and one conversion clears it
   * while carrying a 100% conversion rate off a single conversation — the exact
   * number, beside a named person on the contribution screen, that the first flag
   * exists to keep out of a console. It earns even more on 02b's heatmap, where a
   * cell holding twenty dials and two connects is common.
   *
   * ── It IMPLIES `rates_reportable`, so a consumer may gate on it ALONE ───────
   *
   * `connected <= attempts` always — a connect is an attempt that bridged — and
   * `rates_reportable` IS `attempts >= 20`, so this predicate is strictly stronger
   * and is never true where that flag is false. Rendering `success_rate_pct` or
   * `aht_seconds` therefore needs this flag and not the conjunction. The converse is
   * false, which is why both ride: a row that dialled 400 and connected nobody is
   * quotable on its connect rate and has no conversion rate at all.
   *
   * Same constant and same predicate as the roster's `success_rate_reportable` and
   * as the `success_rate`/`aht` percentile pools it gates there, deliberately not a
   * third threshold holding the same value.
   */
  success_rate_reportable: boolean;
}

/**
 * What a grouped read may be ordered by.
 *
 * `key` is the DEFAULT, and that is a product decision rather than an arbitrary
 * one: a grouped read is most often a series or a matrix, and key order is the only
 * order in which either reads correctly — an hour-of-day series sorted by
 * `successes` is not a series. A metric sort is for the contribution question ("who
 * drove it": `sort=successes&order=desc`).
 *
 * `key` orders by the grouped dimensions in canonical order
 * ({@link AgencyGroupDimension}), with `disposition_code: null` LAST in both
 * directions. A metric sort puts `null` last in both directions too, tie-broken by
 * the key ascending — the same rule the roster uses, so the two reads order
 * identically and a null row is never on the first page of a ranked question.
 *
 * Because the full key is always in the ORDER BY, the ordering is TOTAL: `limit`
 * therefore selects a reproducible set of rows rather than whichever ones the
 * executor reached first.
 */
export type AgencyGroupSort =
  | 'key' | 'attempts' | 'connected' | 'successes'
  | 'connect_rate_pct' | 'success_rate_pct' | 'aht_seconds';

/**
 * The grouped read's whole response — `GET /api/v1/agency-agents/grouped-stats`.
 *
 * ── `total_groups`, `rows.length` and `inactive_omitted` are THREE independent
 * facts, and no "showing X of Y" fraction is derivable from them ─────────────
 *
 * The roster's R1 ruling applies here unchanged, because the mechanism is the
 * same: the dialer runtime applies `limit`, and only then does the public API layer drop rows whose agent has
 * no active membership. The public API layer therefore cannot produce a post-filter population
 * count — that would need the filter applied before the limit, i.e. the public API layer shipping
 * every active agent id to the dialer runtime on a GET. So a default read can legitimately return
 * 190 rows with `total_groups: 400` and `inactive_omitted: 10`. They are rendered
 * as separate true statements: a population readout, a truncation notice only when
 * `total_groups > rows.length + inactive_omitted`, and a hidden-members notice only
 * when `inactive_omitted > 0`.
 *
 * ── A time dimension REQUIRES an unambiguous zone, or the read is refused ────
 *
 * Buckets are cut in the CAMPAIGN's own `default_timezone` (resolved through
 * `pg_timezone_names`, falling back to UTC — see
 * `AgencyAgentStatsRepository.attemptBuckets` for why that LEFT JOIN exists at
 * all). So across campaigns in different zones, "the 18:00 column" is not one
 * thing. `day`, `day_of_week` and `hour_of_day` are therefore accepted only when
 * `campaign` is also grouped (each row then carries its own campaign's zone) or
 * exactly one `campaign_id` is filtered (one zone for the whole read); otherwise
 * **400 `timezone_ambiguous`**, naming both remedies.
 *
 * There is deliberately no implicit UTC fallback and no `tz` parameter in this
 * phase. Silently bucketing an account whose campaigns run in `Asia/Kolkata` as UTC
 * puts the real 18:00 connect peak in the 12:00 column, and the only visible
 * symptom is a rostering decision that is quietly wrong — exactly the failure a
 * best-hours screen exists to prevent. A `tz` parameter stays additive for later,
 * if a cross-campaign single-zone view is ever asked for.
 *
 * Which zone a page's buckets ended up in is reported by {@link
 * AgencyGroupPage.resolved_timezone} — but only when it is ONE zone, which is the
 * `campaign_id` remedy and not the `group_by=campaign` one. Read that field's note
 * before labelling anything with it.
 *
 * ⚠️ **The reconciliation asymmetry the public API layer's layer creates, which a console must
 * not present without saying so.** A campaign-grouped total INCLUDES a departed
 * agent's attempts, because the row is an aggregate over everyone who dialled and
 * there is nothing to drop. An agent-grouped view of the same campaign EXCLUDES
 * them by default. The two therefore do not reconcile, and the difference is
 * exactly the departed agents' work. Neither number is wrong; showing them adjacent
 * without a note is.
 */
export interface AgencyGroupPage {
  from: string;
  to: string;
  campaign_id: string | null;
  /** Canonical order, echoed — never the order the request spelled it in. */
  group_by: AgencyGroupDimension[];
  /**
   * The ONE zone this page's time buckets were ACTUALLY cut in, or `null` when the
   * page has no single zone.
   *
   * A `string` if and only if **both** a zoned dimension is grouped (`day`,
   * `day_of_week`, `hour_of_day`) **and** `campaign_id` filtered exactly one
   * campaign. `null` otherwise — and that `null` carries ONE meaning, *this page
   * has no single zone*. Whether nothing zoned was grouped, or the read spans
   * campaigns whose zones may differ, the answer to "which one zone is this page
   * in" is the same, and both causes want the identical client behaviour: **do not
   * label an axis with a single zone.**
   *
   * The second half of that condition is the half that is easy to get wrong. A
   * time dimension is legal on EITHER of D5's two remedies, and only one of them
   * narrows the read to one zone: `group_by=campaign,hour_of_day` with no
   * `campaign_id` is a legal 200 spanning every campaign in the account, each row
   * correctly cut in its own campaign's zone. That page has N zones and no single
   * label, so it reports `null`.
   *
   * ── Why a consumer cannot derive this, and must not try ────────────────────
   *
   * The value is `COALESCE(z.name, 'UTC')` — what the SQL actually used — read back
   * out of the same `pg_timezone_names` join the buckets were cut with, and NOT
   * `agency_campaigns.default_timezone`. That column is `VARCHAR(64)` with no
   * constraint, and the join is LEFT precisely so an unresolvable zone cannot raise
   * `22023 invalid_parameter_value` and take out every other campaign's numbers in
   * the same statement. So the STORED value and the zone the buckets were cut in
   * differ **exactly when the stored value is garbage** — which is the whole reason
   * this field exists. A console labelling its hour axis from the campaign record
   * would print `Asia/Calcutta_typo` over columns that are in fact UTC, on
   * precisely the campaign whose zone is broken, and confidently wrong beats blank.
   *
   * ⚠️ **Never substituted.** Not UTC, not the stored `default_timezone`, and not
   * the reader's own zone — `Intl.DateTimeFormat().resolvedOptions().timeZone` is
   * the correct zone for a window-bounds caption, whose bounds ARE cut from a local
   * `Date`, and the wrong one for this axis. Two zones on one screen, and mixing
   * them is the defect this field exists to prevent. `null` or absent means the
   * axis goes unlabelled and says so.
   *
   * Row-level zones are deliberately NOT served. The cross-campaign
   * `campaign,hour_of_day` read genuinely has one zone per row and no page-level
   * label, but no named surface renders it; when one is specified, the field
   * belongs on the row beside `campaign_id`. This paragraph is the record of why
   * the gap is a decision rather than an oversight.
   */
  resolved_timezone: string | null;
  sort: AgencyGroupSort;
  order: 'asc' | 'desc';
  limit: number;
  /** Groups matching scope+window BEFORE `limit`. */
  total_groups: number;
  rows: AgencyGroupRow[];
}

// ─── Billing wire shapes — intentionally absent ─────────────────────────────
//
// v1 has no credits, billing, settlement or attempt batching, so no such wire
// shapes are declared. Usage facts stay on the rows agency owns
// (`agency_call_attempts`, `agency_calls`,
// `dialer_analysis_jobs.analysis_audio_seconds`) for metering later.

// ─── Supervisor read surface — the attempt spine ────────────────────────────
//
// `agency_call_attempts` opens migration 075 with "the audit spine. One row per
// dial", and without these pages nothing reads it: the campaign page served aggregate
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
   * **Deliberately not an FK** (migration 075: the attempt row "must outlive a
   * purged call row"), so a non-null id here is NOT a promise the call still
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
  /** Provenance: the row's line in the uploaded CSV. NULL on pre-085 rows. */
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
 * Q-D is 1M contacts across 50 agents and new attempts land while a supervisor
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
