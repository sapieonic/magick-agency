/**
 * The campaign-derived config the agent console needs, and the session bootstrap (`POST
 * /api/v1/agency/sessions`).
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary).
 */

import type { AgencyActionErrorResponse } from './actions';
import type { AgencyAgentState, AgencyCampaignStatus } from './enums';
import type { AgencyClientKind, AgencyQueueState } from './station';
import type { AgencyAssignmentMode } from './assignment';
import type { AgencyStationDeviceFields } from './station-device';
import type { AgencyTileIcon } from './tile-icons';
import type { AgencyContextFieldType, AgencyContextRoles, AgencyFactField } from './customer-facts';
import type { AgencyAgentScript } from './agent-script';
import type { AllListed } from '../primitives';
import { SOFTPHONE_OVERRIDE_NOTE_MAX, SOFTPHONE_OVERRIDE_NOTE_MIN } from './softphone';

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
  /**
   * Promise to pay (PT1): the agent must enter the date the customer promised to pay
   * (`promise_date`), and may enter an amount (`promise_amount`). See `./promise.ts`.
   *
   * **Recording a promise never makes the dialler call** (PT3). Refused beside
   * `requires_datetime` (a promise books its own follow-up) and `suppress` (a do-not-call
   * outcome cannot record a promise), in the soft phone's own catalogue and an inbound
   * route's (no roster contact to carry it), and as an automatic outcome's mapping.
   */
  requires_promise?: boolean;
  /**
   * PT2: when set (1–`AGENCY_PROMISE_FOLLOW_UP_DAYS_MAX`), recording a promise books a call
   * this many days after the promised date, through the callback path: deferred into the
   * contact's calling window, owned as a callback (CA4), DNC checked at dial time. Absent
   * (the default): the contact goes where the entry's flags and the retry policy send it.
   * Only on a `requires_promise` entry, and never beside `retry` or `terminal`.
   */
  promise_follow_up_days?: number;
  /**
   * What recording this outcome lets the contact's agent override, from then on, for this
   * contact only (contact assignment, phase 2). The latest granting outcome on a contact wins;
   * each part is used up when spent. Absent: the outcome grants nothing (every built-in).
   *
   * **DNC is never overridable.** There is no field for it, a catalog entry with an unknown key
   * here is refused, and so is an override on an entry that `suppress`es or is `terminal`.
   */
  override?: AgencyDispositionOverride;
  /**
   * Agent station (BE-13): the tile's picture, chosen by a supervisor from `AGENCY_TILE_ICONS`
   * (`./tile-icons.ts`). Absent: the station works it out from the flags above. The campaign-config
   * write refuses a value not in the list; every reader (the server's catalog read, the console, the
   * app) treats an unknown value as absent, so an app older than an icon falls back to the flag rule
   * and never fails the bootstrap.
   */
  icon?: AgencyTileIcon;
}

/** The most extra attempts one outcome can grant past `max_attempts`. */
export const AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX = 5;

/**
 * An outcome's override grant ({@link AgencyDisposition.override}). At least one part is set.
 *
 *  - `extra_attempts` (1–{@link AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX}): dials allowed past the
 *    retry policy's `max_attempts`; one is spent per dial past it.
 *  - `retry_delay`: the agent may dial the contact before its next scheduled time (once).
 *  - `calling_hours`: the agent may dial outside the calling hours (once), with a note of
 *    {@link AGENCY_OVERRIDE_NOTE_MIN}–{@link AGENCY_OVERRIDE_NOTE_MAX} characters, as the soft
 *    phone's hours override (SP2).
 */
export interface AgencyDispositionOverride {
  extra_attempts?: number;
  retry_delay?: boolean;
  calling_hours?: boolean;
}

/** The override parts a dial can spend; recorded on the attempt as `override_applied`. */
export const AGENCY_OVERRIDE_KINDS = ['extra_attempts', 'retry_delay', 'calling_hours'] as const;
export type AgencyOverrideKind = (typeof AGENCY_OVERRIDE_KINDS)[number];

/**
 * Bounds of the agent's note on a calling-hours override (trimmed, in code points): the soft
 * phone's override note bounds, one source of truth.
 */
export const AGENCY_OVERRIDE_NOTE_MIN = SOFTPHONE_OVERRIDE_NOTE_MIN;
export const AGENCY_OVERRIDE_NOTE_MAX = SOFTPHONE_OVERRIDE_NOTE_MAX;

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
  /**
   * Agent station (BE-6, `./customer-facts.ts`): which column plays each role (the customer's name,
   * place, amount due, due date). Read by the server to build `AgencyReservedAttempt.facts`, and by
   * the name lookups (callbacks list, floor, inbound) before their guesses. Absent: the server
   * guesses as before. A `hidden` column is never a role.
   */
  roles?: AgencyContextRoles;
  /**
   * Agent station (BE-6): how to read a column, by its header name. A column not named here is
   * `text`. The `amount_due` and `due_date` roles are read as `money` and `date` whatever this says
   * (on the BE-6 path; with `facts`, every tile is read by this alone).
   */
  types?: Record<string, AgencyContextFieldType>;
  /**
   * AS19 (`./customer-facts.ts`): the card's facts, in order, at most `AGENCY_FACT_FIELDS_MAX`.
   * PRESENT (even `[]`) means the campaign uses the new model: the tiles are exactly these (minus
   * hidden or missing columns), and `hero` and `roles.amount_due` / `roles.due_date` are no longer
   * read for tiles; the configured heroes (the contact panel, customer history, the own-contacts
   * list) are `roles.name` then these columns. The script's placeholders are then the fixed ones
   * plus these keys (`./agent-script.ts`). ABSENT: today's rule (BE-6), and the legacy six
   * placeholders.
   */
  facts?: AgencyFactField[];
}

/**
 * Agent station (AS9): how the station shows the customer's number, a campaign setting
 * (`agency_campaigns.phone_display`, 0056; default `full`, today's behaviour). `masked` shows
 * `98••• ••321` on every station screen, console and app. **A display choice, not a privacy
 * control:** the server still sends `phone_e164` in full (the soft phone and customer history need
 * it); hiding it on the server is later work (BE-7 step 2).
 */
export type AgencyPhoneDisplay = 'full' | 'masked';

export const AGENCY_PHONE_DISPLAYS = ['full', 'masked'] as const satisfies readonly AgencyPhoneDisplay[];

const _allPhoneDisplaysListed: AllListed<AgencyPhoneDisplay, typeof AGENCY_PHONE_DISPLAYS> = true;
void _allPhoneDisplaysListed;

/** The campaign's `phone_display` when it sets none, and the station's reading of an absent or unknown one. */
export const AGENCY_PHONE_DISPLAY_DEFAULT: AgencyPhoneDisplay = 'full';

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
  /**
   * LF6, LF20: how long a break for this reason may last, in whole minutes,
   * {@link AGENCY_BREAK_LIMIT_MIN_MINUTES} to {@link AGENCY_BREAK_LIMIT_MAX_MINUTES} (`isAgencyBreakLimitMinutes`).
   * Absent: no limit of its own, and the floor's {@link AGENCY_BREAK_DEFAULT_LIMIT_MINUTES}-minute
   * rule applies. The campaign-config write refuses a limit out of range or not a whole number; a
   * reserved code (`RESERVED_BREAK_REASONS`) is refused from the catalog altogether, so it never has
   * one. A stored limit the rule refuses is dropped when the catalog is read (`resolveBreakReasons`).
   *
   * **The agent's countdown.** The bootstrap's `break_reasons` carry it, so a station or the app
   * finds the limit of the break it is on by the code it is told (`agent_state.break_reason`,
   * `ready.break_reason`, the bootstrap's `break_reason`), as it finds the label, and counts down
   * from `agent_state.since`, the anchor it already counts a break's time from.
   */
  limit_minutes?: number;
  /**
   * Agent station (BE-13): the break tile's picture, from `AGENCY_TILE_ICONS` (`./tile-icons.ts`),
   * as {@link AgencyDisposition.icon}: refused at the write when not in the list, read as absent
   * when unknown. Absent: the station guesses from the code and label (a cup as the fallback).
   */
  icon?: AgencyTileIcon;
}

// ─── POST /api/v1/agency/sessions — session bootstrap ───────────────────────

/**
 * `device_id` / `take_over` (OS3, `./station-device`): which device is joining, and whether the
 * agent chose to take the station here. A join from another device than the one holding the
 * session's station, without `take_over`, is refused `station_on_other_device`.
 */
export interface AgencyCreateSessionRequest extends AgencyStationDeviceFields {
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
   * Whether the joining user's ROLE holds `agency.supervise`, derived by the public API
   * layer from the authenticated membership (never from the browser, whose schema
   * strips it). `true` skips the staffing check: a supervisor covering a shift joins a
   * campaign nobody staffed them on. Absent means `false`, so an internal caller that
   * forgets it gets the check, not a bypass (`not_staffed`).
   */
  supervise?: boolean;
  /**
   * Optional resume hint. The dialer runtime rehydrates from `agency_agent_sessions` regardless
   * (a restart drops every socket, and sessions are rehydrated rather than
   * recreated), so this only lets the client assert which session it thinks it had.
   */
  session_id?: string;
  /**
   * Which app is joining, parsed by the public API layer from the request's
   * `X-Client` header (absent: `web`). It picks the `intervals` served, nothing else:
   * a `mobile` join is told `heartbeat_grace_ms` = `MOBILE_STATION_HEARTBEAT_GRACE_MS`.
   * Client-declared, so never an input to anything security-relevant.
   */
  client_kind?: AgencyClientKind;
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
  /**
   * The break's code when `state` is `break`, as on {@link AgencyStationAgentStateFrame}:
   * a campaign's `break_reasons` code or a reserved one (`device_away`, `phone_call`, `soft_phone`).
   * Absent when not on break, or on a break that has no recorded reason (a rehydrate
   * after a restart). It is what lets a client that was killed while paused (the mobile
   * app, backgrounded: `device_away`) say why when it comes back.
   */
  break_reason?: string;
  campaign_status: AgencyCampaignStatus;

  /**
   * The station socket's path, RELATIVE to the API origin, token already appended:
   * `/proxy/agency/station/<session id>?token=<token>`. A client builds the `wss://` URL
   * from the origin it called (the console uses its own page origin; the mobile app its
   * configured API origin). Never absolute: the server does not know which public origin
   * the client reached it through.
   */
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
  /**
   * Whether the agent may redial the same customer from the wrap-up screen while the
   * outcome is still owed (`POST /sessions/:id/redial`, at most
   * {@link AGENCY_WRAPUP_REDIAL_LIMIT} redials per call). The campaign's setting at join;
   * the wrap-up frame's `redial_remaining` is the live answer for one wrap-up. Optional
   * so a client built against an older server reads its absence as `false`.
   */
  allow_wrapup_redial?: boolean;
  /**
   * How pacing pairs this campaign's contacts with agents (contact assignment). `pool` (or
   * absent, from an older server): one shared queue. `strict`: this agent is dialled only
   * their own contacts. `preferred`: their own first, then unassigned ones.
   */
  assignment_mode?: AgencyAssignmentMode;
  /**
   * Whether the agent may retry the contacts they did not reach (`POST
   * /proxy/agency/my-contacts/retry`, and the per-contact call). Absent reads as `false`.
   */
  allow_agent_retry?: boolean;
  /**
   * This agent's queue at join, in `strict` and `preferred` mode. Absent in `pool` mode: the
   * bootstrap is read before the station socket declares what it can show, so a `pool` campaign's
   * shared queue (agent station BE-5) comes on `ready.queue` and the `queue` frame, to a station
   * that declared `caps=queue_pool` only (AS18). The `queue` station frame carries every later change.
   */
  queue?: AgencyQueueState;
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

  /**
   * Agent station (BE-8, `./agent-script.ts`): the campaign's script, campaign-constant like
   * `retry_context`. **Absent when the campaign has none** (no opening and no steps), and from a
   * server older than the field: the station then shows the last calls and a note (`04c`). A
   * supervisor's edit reaches an agent on their next join. Never carries an empty script.
   */
  script?: AgencyAgentScript;
  /**
   * Agent station (AS9): how the station shows the customer's number on this campaign. Absent (an
   * older server) or a value the client does not know reads as `full`
   * ({@link AGENCY_PHONE_DISPLAY_DEFAULT}). The number itself is still sent in full.
   */
  phone_display?: AgencyPhoneDisplay;
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
 * session per agent (per tenant until 0035, across tenants since, OS1) — the reservation CAS key is per session
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
  /**
   * The live session itself, so the client can leave it (`POST /sessions/:id/leave`)
   * without a second read. Always the CALLER's own session: the join names the agent
   * from the authenticated user, and the session that refused it is that agent's one live
   * session (across tenants since OS1; one in another tenant is `session_in_other_tenant`).
   */
  session_id: string;
  /**
   * The account that session is in. Often a SIBLING of the one the join was made in
   * (the one-live-session rule spans the tenant, and since OS1 every tenant), and `leave` is scoped to the session's
   * account, so the client sends this as its account scope to leave it. As on
   * `session_on_softphone`.
   */
  account_id: string;
  /** That account's name, for copy. Best effort: NULL when the read failed. */
  account_name: string | null;
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
   *
   * **Per client kind.** A `mobile` session is served
   * `MOBILE_STATION_HEARTBEAT_GRACE_MS` (10s): the server probes a mobile station with
   * RFC 6455 pings every `MOBILE_STATION_PROBE_MS` (3s), and any protocol pong or
   * ping counts as liveness, so a suspended phone is closed within about 10–15s
   * rather than holding a live lease for 30–40s. The app-level `ping` at
   * `heartbeat_ms` is still owed: it alone renews the Redis ownership key and the lease.
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
