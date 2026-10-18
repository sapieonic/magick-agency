/**
 * The campaign-derived config the agent console needs, and the session bootstrap (`POST
 * /api/v1/agency/sessions`).
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary).
 */

import type { AgencyActionErrorResponse } from './actions';
import type { AgencyAgentState, AgencyCampaignStatus } from './enums';

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
  /** Disposition-driven retry — this is how voicemail retry works without answering-machine detection. */
  retry?: { delay_minutes?: number; max_attempts: number };
}

/**
 * Which of a contact's arbitrary CSV columns matter, and in what order
 * (`agency_campaigns.context_display`).
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
 * This list is campaign config (`agency_campaigns.break_reasons`)
 * and is the *only* authority on which codes `POST /sessions/:id/break` will
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
   * (a restart drops every socket, and sessions are rehydrated rather than
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
  /** the public API layer's user id, echoed back — the dialer runtime never resolves it to a name. */
  agent_user_id: string;

  /**
   * The agent's state as the dialer runtime sees it right now.
   *
   * After a restart of the dialer runtime or the public API layer this is `break`, never `available` — the
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
   * `agency.*` permissions and this feature must not become
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
   * `parent_campaign_id` is `ON DELETE SET NULL`, so a campaign
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
   * disagree. It is the campaign's own fact, like the lifecycle columns.
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
 * campaign in the same tenant. The database permits one live
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
 * The consequence that decided it is `message`. A client that does not know this
 * code (an older console, a generic error handler) has only `message` to show, so
 * a structured-fields-only payload would degrade to no explanation at all.
 * `message` is the FLOOR: a sentence that stands on its own in any generic error
 * handler that has never heard of this code. The structured fields are the ceiling — the console
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
  /** The auto-connect countdown before audio bridges. Design: 3000. */
  countdown_ms: number;
  /**
   * **Required.** How long the dialer runtime holds a live call open after the
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
