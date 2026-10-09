import { API_BASE } from '../config';
import { apiFetch } from './client';
import {
  mayAutosave,
  detectForeignWrite,
  type AutosaveGuardInput,
  type AutosaveRefusal,
} from '../utils/agencyNotes';
import type { DncScope } from '../utils/agencyDncCopy';
import type {
  AgencySessionBootstrap,
  AgencyStationTokenResponse,
  AgencySessionStateResponse,
  AgencyDispositionResponse,
  AgencyNotesResponse,
  AgencyDncResponse,
} from '../types/agency';
import type {
  AgencyAgentAssignment,
  AgencyAssignedAgent,
  AgencyAssignment,
  AgencyMyAssignment,
  AgencyMyAssignments,
} from '../types/agency-campaign';

/**
 * Agent-native routes. These exist rather than reusing the generic call API
 * because the `agent` role sits at hierarchy level 5, below every permission
 * floor that predates the Agency Dialer — and because the server can verify the
 * caller IS the reserved agent for an attempt, an ownership check the generic
 * routes cannot express.
 */

const AGENCY_BASE = `${API_BASE}/proxy/agency`;

/** Join a campaign. Returns everything the console renders with, in one call. */
export async function createAgencySession(
  campaignId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencySessionBootstrap> {
  return apiFetch<AgencySessionBootstrap>(
    `${AGENCY_BASE}/sessions`,
    { method: 'POST', body: JSON.stringify({ campaign_id: campaignId }) },
    tenantId,
    accountId,
  );
}

/**
 * Mint a fresh station-socket upgrade token.
 *
 * The token authenticates the UPGRADE, not the session: it is single-use and
 * short-lived, so every reconnect needs a new one. Deliberately separate from
 * bootstrap — a reconnect needs a token, not the whole campaign config again —
 * and cheap enough to call before every connect attempt.
 */
export async function mintStationToken(
  sessionId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyStationTokenResponse> {
  return apiFetch<AgencyStationTokenResponse>(
    `${AGENCY_BASE}/sessions/${sessionId}/station-token`,
    { method: 'POST' },
    tenantId,
    accountId,
  );
}

/** Go available. The agent's own signal that they are ready to take calls. */
export async function setAgentAvailable(
  sessionId: string,
  tenantId?: string,
  accountId?: string,
): Promise<void> {
  await apiFetch(
    `${AGENCY_BASE}/sessions/${sessionId}/available`,
    { method: 'POST' },
    tenantId,
    accountId,
  );
}

/** Leave the station. Distinct from a dropped socket. */
export async function leaveAgencySession(
  sessionId: string,
  tenantId?: string,
  accountId?: string,
): Promise<void> {
  await apiFetch(
    `${AGENCY_BASE}/sessions/${sessionId}/leave`,
    { method: 'POST' },
    tenantId,
    accountId,
  );
}

/**
 * HTTP hang-up, for when a caller would rather not race the socket. The station
 * socket carries an equivalent control frame; this one returns a status the
 * caller can act on.
 */
export async function hangupAttempt(
  attemptId: string,
  tenantId?: string,
  accountId?: string,
): Promise<void> {
  await apiFetch(
    `${AGENCY_BASE}/attempts/${attemptId}/hangup`,
    { method: 'POST' },
    tenantId,
    accountId,
  );
}

/**
 * Go on break with a reason.
 *
 * `reason` must be a `code` from `bootstrap.break_reasons` — campaign config is
 * the sole authority and the server rejects anything else with `unknown_break_reason`
 * plus the `allowed_codes` that *are* valid, so a console holding a stale
 * bootstrap can recover in one round trip instead of making the agent
 * re-bootstrap mid-shift.
 *
 * Requested while `on_call`, the transition is **queued** and applied at the end
 * of wrap-up; the response's `pending_state` is what tells the console to render
 * the queued-break pill. There is no socket frame for a pending break, which is
 * why this response — uniquely among Phase 2 surfaces — drives a pixel.
 */
export async function setAgentBreak(
  sessionId: string,
  reason: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencySessionStateResponse> {
  return apiFetch<AgencySessionStateResponse>(
    `${AGENCY_BASE}/sessions/${sessionId}/break`,
    { method: 'POST', body: JSON.stringify({ reason }) },
    tenantId,
    accountId,
  );
}

/**
 * Take back a **queued** break.
 *
 * A dedicated route rather than a semantic on `/available`, and the distinction
 * is the point: overloading `/available` would make one route mean "change my
 * state" in one context and "explicitly don't change my state" in another, with
 * the client having to know which by inspecting local state first.
 *
 * 409 `break_already_applied` when the break is already in effect — there is
 * nothing queued left to cancel and the agent wants `/available` instead.
 * Cancelling with nothing queued is an idempotent 200 (double-click safety).
 */
export async function cancelQueuedBreak(
  sessionId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencySessionStateResponse> {
  return apiFetch<AgencySessionStateResponse>(
    `${AGENCY_BASE}/sessions/${sessionId}/break/cancel`,
    { method: 'POST' },
    tenantId,
    accountId,
  );
}

/**
 * Supervisor override — end a held wrap-up and return the agent to the pool
 * ('s control).
 *
 * ── Why this is not `/available` ────────────────────────────────────────────
 * `POST /sessions/:id/available` **refuses while a disposition is outstanding**,
 * and that refusal is the only thing making a required disposition required. So
 * the one route that CAN end a held wrap-up is a separate route with a higher
 * floor: the server gates it on `agency.supervise`, which under the role hierarchy an `agent` cannot
 * reach. The person who benefits from skipping a disposition cannot call the
 * route that skips it.
 *
 * **The caller must gate the affordance on `hasPermission(role,
 * 'agency.supervise')`.** Any looser check renders a button that 403s on click.
 *
 * `:id` is the **session** id, never `agent_user_id`. `reason` is optional free
 * text recorded on the audit event, capped at 1000 chars by the server's schema
 * (`FORCE_AVAILABLE_REASON_MAX`); an empty one is omitted rather than sent as
 * `''`, which would record a reason that was never given.
 *
 * The attempt is left `no_disposition`, identical to what the reaper's sweep
 * would have written — forced and swept returns produce one shape of data.
 */
export async function forceAgentAvailable(
  sessionId: string,
  reason: string | undefined,
  tenantId?: string,
  accountId?: string,
): Promise<void> {
  const trimmed = reason?.trim();
  await apiFetch(
    `${AGENCY_BASE}/sessions/${sessionId}/force-available`,
    { method: 'POST', body: JSON.stringify(trimmed ? { reason: trimmed } : {}) },
    tenantId,
    accountId,
  );
}

/**
 * Submit the disposition for an attempt.
 *
 * `requires_note` / `requires_datetime` are enforced by **the server** against the
 * campaign catalog; the console's own guard exists so an agent is never left
 * pressing a button that will fail, not as the enforcement. On a 400 the error
 * carries a `code` from the closed `AgencyActionErrorCode` union — and
 * `allowed_codes` for `unknown_disposition_code` — which the server allow-lists
 * through its error mask so the pad can key its copy off the code rather than
 * showing a support message.
 *
 * The server attributes the action to the signed-in user server-side; the console
 * neither sends nor can influence `agent_user_id`.
 */
export async function submitDisposition(
  attemptId: string,
  payload: { disposition_code: string; notes?: string; callback_at?: string },
  tenantId?: string,
  accountId?: string,
): Promise<AgencyDispositionResponse> {
  return apiFetch<AgencyDispositionResponse>(
    `${AGENCY_BASE}/attempts/${attemptId}/disposition`,
    { method: 'POST', body: JSON.stringify(payload) },
    tenantId,
    accountId,
  );
}

/**
 * Mark the contact on the line as Do Not Call.
 *
 * **Not a disposition.** keeps this as its own action because of the case
 * that actually happens: the customer says "take me off your list" in the first
 * three seconds and hangs up, before there is anything to disposition. The server
 * suppresses the contact immediately and forwards to the server, which owns
 * `dnc_entries`.
 *
 * **This path never writes an ACCOUNT-scoped row** — the server's internal route
 * refuses an `account_id` outright, because an account-scoped row never enters
 * the server's flat `dnc:{tenantId}` Redis set and so would never suppress a dial at
 * dial time. That leaves exactly two scopes reachable from here, and only one of
 * them is workspace-wide: `scope: 'tenant'` writes the unscoped row that reaches
 * the flat set, while the default `scope: 'campaign'` writes a campaign-scoped
 * row that does not. So the confirmation may state a workspace-wide scope only
 * for the escalation, never for the default.
 *
 * `dnc_recorded: false` is a success with a smaller promise **on either scope**:
 * the roster rows are suppressed locally, but the list write is still in flight
 * and may never land. The console must not claim the list write in that case —
 * see `agencyDncCopy.ts`.
 *
 * The request asserts `scope`, never `campaign_id`: the server already knows the
 * campaign from the attempt it is looking at, so naming one here would be the
 * client asserting a fact the server owns (the same reasoning the server's own
 * `createSessionSchema` applies to `agent_user_id`). Absent `scope` is defined,
 * server-side, as `'campaign'` — the narrower, fail-safe reading — and that is
 * exactly what the console's default sends explicitly rather than by omission,
 * so the request stays self-describing in a log or a test. The tenant-wide
 * escalation sends `scope: 'tenant'` on purpose, and the server additionally floors
 * that path at `agency.dnc.manage`.
 */
export async function markContactDnc(
  attemptId: string,
  payload: { reason?: string; disposition_code?: string; scope?: DncScope } = {},
  tenantId?: string,
  accountId?: string,
): Promise<AgencyDncResponse> {
  return apiFetch<AgencyDncResponse>(
    `${AGENCY_BASE}/attempts/${attemptId}/dnc`,
    { method: 'POST', body: JSON.stringify(payload) },
    tenantId,
    accountId,
  );
}

/**
 * The result of an attempted notes save.
 *
 * `saved: false` is **not an error** — it is the guard declining to send a request
 * that would have destroyed data. The caller logs the diagnostic and carries on.
 * A genuine transport or server failure still throws, as everywhere else in this
 * client.
 */
export type SaveNotesOutcome =
  | {
      saved: true;
      response: AgencyNotesResponse;
      /** Exactly what went on the wire. */
      sentNotes: string;
      /**
       * True when the response's echo differs from what we sent — another writer
       * won between our request and its handling.
       *
       * Computed **here**, against the payload, because the comparison the caller
       * would reach for is against the live field, and that reports a foreign
       * write on every save that overlapped a keystroke — which is most of them
       * during active typing. The notice would then fire constantly for a
       * condition that had not occurred. Handing back the answer means the caller
       * never has the opportunity to compare the wrong two things.
       */
      foreignWrite: boolean;
    }
  | { saved: false; refusal: AutosaveRefusal; diagnostic: string };

/**
 * Save notes **without** dispositioning.
 *
 * Separate from the submit because the two happen at different times: agents type
 * while the customer is still talking, and a call that ends before they pick a
 * code must not discard what they wrote. Last-write-wins and accepted while the
 * attempt is live *and* through wrap-up, so an autosave can fire on a timer
 * without knowing which phase it is in. It does **not** end wrap-up and does
 * **not** satisfy `requires_disposition`.
 *
 * ── Why the guard is INSIDE the client rather than at the call site ───────────
 * **`notes: ''` clears the attempt's notes wholesale** — the request replaces
 * rather than merges. So an autosave that fires while the field is momentarily
 * empty destroys server-side notes the agent already had, and they then watch
 * their notes vanish from a field they were reading.
 *
 * `mayAutosave()` has existed since Phase 1 and the rule was "call it before every
 * send". Nothing enforced that. A debounce that fires one render early, a new
 * effect added six months from now, a retry path that re-sends the last value —
 * any of those reaches the wire without passing the guard, and the failure is
 * silent and unrecoverable. So the guard moved in here, and the function takes the
 * guard's own input type: **there is no argument shape that sends an unchecked
 * empty string.**
 *
 * It takes ONE object rather than `(attemptId, notes, guard)` for the same reason.
 * With the payload and the checked value as separate parameters they can disagree
 * — check one string, send another — and that call site would look perfectly
 * correct. Here `request.notes` *is* the payload.
 *
 * The asymmetry inside `mayAutosave` is load-bearing and is not softened here:
 * hydration gates *all* saves, provenance gates *only* the destructive one. A
 * blanket "require provenance for every save" reads as safer and would block the
 * legitimate case of flushing hydrated local text up to a server that never
 * received it — which is the entire reason the local buffer exists.
 */
export async function saveAttemptNotes(
  request: AutosaveGuardInput,
  tenantId?: string,
  accountId?: string,
): Promise<SaveNotesOutcome> {
  const decision = mayAutosave(request);
  if (!decision.allowed) {
    return { saved: false, refusal: decision.refusal, diagnostic: decision.diagnostic };
  }

  const sentNotes = request.notes;
  const response = await apiFetch<AgencyNotesResponse>(
    `${AGENCY_BASE}/attempts/${request.attemptId}/notes`,
    { method: 'POST', body: JSON.stringify({ notes: sentNotes }) },
    tenantId,
    accountId,
  );

  return {
    saved: true,
    response,
    sentNotes,
    foreignWrite: detectForeignWrite(sentNotes, response.notes),
  };
}

/* ── Agent ↔ campaign assignment ─────────────────────────────────────
 *
 * Routes under the same `/proxy/agency` prefix that are served by the public API
 * layer itself, not forwarded to the dialer runtime: it has no
 * identity model, so the mapping of a *person* to a campaign can only live in
 * the server. They are staffing, never authorization — see
 * `AgencyMyAssignment`.
 */

/**
 * Where this agent is sent by default. `null` ⇒ **nobody has staffed them yet**.
 *
 * The server answers `204` with no body for the unassigned case, which `apiFetch`
 * resolves as `undefined`; it is normalised to `null` here so every caller
 * branches on a value rather than having to know that a status code was the
 * answer. Floored at `agency.station.connect` (level `agent`) — deliberately NOT
 * at `agency.campaigns.read`, which is what a campaign read would normally
 * need and which an `agent` does not hold.
 */
export async function getMyAssignment(
  tenantId?: string,
  accountId?: string,
): Promise<AgencyMyAssignment | null> {
  const assignment = await apiFetch<AgencyMyAssignment | undefined>(
    `${AGENCY_BASE}/my-assignment`,
    {},
    tenantId,
    accountId,
  );
  return assignment ?? null;
}

/**
 * Every campaign this agent is staffed on. An EMPTY ARRAY ⇒ nobody has staffed
 * them yet — a steady state, not a failure.
 *
 * Replaces {@link getMyAssignment}. The singular route could only ever name one
 * campaign, which was not a simplification but a data loss: the server's staffing
 * table allowed one active assignment per tenant, so putting somebody on an
 * afternoon campaign silently unstaffed them from the morning one and the wire
 * shape had no way to reveal it.
 *
 * Note the contract difference and do not "tidy" it: this route answers `200`
 * with `{ assignments: [] }` where the singular one answered `204`. For a
 * collection the empty array IS the absence, so there is one code path here
 * instead of the field test a 204 forces on every client.
 *
 * Floored at `agency.station.connect` (level `agent`) — deliberately NOT at
 * `agency.campaigns.read`, which is what a campaign read would normally need
 * and which an `agent` does not hold.
 */
export async function getMyAssignments(
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAssignment[]> {
  const response = await apiFetch<AgencyMyAssignments | undefined>(
    `${AGENCY_BASE}/my-assignments`,
    {},
    tenantId,
    accountId,
  );
  /**
   * `?? []` guards a body-less 200, which `apiFetch` resolves as `undefined`.
   *
   * The previous version of this comment claimed it covered "a 204 from an older
   * server that predates this route". It does not: an older server has no such
   * route and answers **404**, which `apiFetch` throws on — and that throw is the
   * behaviour we want, since "we could not ask" is a different screen from "nobody
   * has staffed you".
   *
   * So this guards a shape nothing currently sends. It is kept anyway because the
   * alternative failure is `.map` of undefined inside a render, and degrading to
   * the unstaffed screen is the better of the two.
   */
  return response?.assignments ?? [];
}

/**
 * The campaign's assigned people. Floored at `agency.supervise` — the same
 * permission the server gates the route on, so the UI gate and the API gate are one
 * check and a control can never render for someone it will 403 for.
 *
 * Distinct from the *agent floor*, which is live session state read off the
 * stats payload: this is who is staffed here, whether or not they are logged in.
 */
export async function listCampaignAgents(
  campaignId: string,
  tenantId?: string,
  accountId?: string,
): Promise<{ agents: AgencyAssignedAgent[] }> {
  return apiFetch<{ agents: AgencyAssignedAgent[] }>(
    `${AGENCY_BASE}/campaigns/${campaignId}/agents`,
    {},
    tenantId,
    accountId,
  );
}

/**
 * Assign a tenant member to this campaign.
 *
 * **Assigning someone who is already assigned elsewhere MOVES them** — one
 * active assignment per user per tenant, enforced by a partial unique index in
 * the server rather than by a check-then-write, so two supervisors assigning the
 * same person at once cannot both win.
 *
 * It does not touch a live session. If the agent is still joined to the old
 * campaign, their next join is refused by the server with `session_on_other_campaign`
 * and the console tells them to leave that station first — nobody is yanked off
 * a call by a staffing change.
 */
export async function assignAgent(
  campaignId: string,
  userId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAgentAssignment> {
  return apiFetch<AgencyAgentAssignment>(
    `${AGENCY_BASE}/campaigns/${campaignId}/agents`,
    { method: 'POST', body: JSON.stringify({ user_id: userId }) },
    tenantId,
    accountId,
  );
}

/** Unassign. `204`. The agent keeps any live session — this is staffing only. */
export async function unassignAgent(
  campaignId: string,
  userId: string,
  tenantId?: string,
  accountId?: string,
): Promise<void> {
  await apiFetch(
    `${AGENCY_BASE}/campaigns/${campaignId}/agents/${userId}`,
    { method: 'DELETE' },
    tenantId,
    accountId,
  );
}
