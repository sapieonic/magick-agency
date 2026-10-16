/**
 * The agent-native action routes, the session state routes, the Phase 2 pool (wrap-up,
 * break, notes, force-return), agent-attributed actions and the action-route error body.
 * The action error union itself is declared in `../errors.ts`.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary).
 */

import type { AgencyActionErrorCode } from '../errors';
import type { AgencyAgentState, AgencyAttemptOutcome, AgencyAttemptState, AgencyContactState } from './enums';

// ─── Agent-native action routes ─────────────────────────────────────────────
//
// `POST /api/v1/agency/attempts/:id/{hangup,disposition,dnc}`, forwarded by the public API layer
// at `/proxy/agency/attempts/:id/…` and gated at `agency.attempts.handle` /
// `agency.attempts.dispose` / `agency.dnc.write`.
//
// These exist rather than reusing the generic call routes because `agent`
// sits at level 5, below every pre-existing permission floor — and because the dialer runtime can
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
   *  A callback re-enters the roster as an ordinary `pending` contact —
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
   * it would mean an agent tells a customer "we'll call you back Tuesday" (the
   * agent-facing copy rule) and nothing ever does.
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
 * that one is three frames total, is an auto-connect cue rather than a timer,
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
 * `agency.supervise` (account_admin floor) — **not** reachable by an `agent`.
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
  /** the public API layer's user id for the human performing the action (opaque to the dialer runtime). */
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
