import type { AgencyAgentState } from '../types/agency';

/**
 * The two ways out of the station — and why they are two.
 *
 * Until now there was **no** way out: the console is full-viewport with no nav
 * by design (an escape route beside a live call is a misclick that hangs up on a
 * customer), and the two controls the spec named were never built. So an agent
 * closed the tab, which is the one exit that tells the server nothing until the
 * heartbeat grace expires.
 *
 * ── They are different acts, so they are different controls ──────────────────
 * **Leave station** ends the *session*: `POST /sessions/:id/leave`, the agent
 * stops being in the pool, and the row is closed (`left_at`). It is the only
 * thing that frees the one-live-session-per-agent-per-tenant slot, which makes
 * it the escape hatch for a reassigned agent who is refused at another campaign
 * with `session_on_other_campaign`.
 *
 * **Exit station** is navigation and nothing else — back to the campaign the
 * supervisor came from, session untouched. It exists for the supervisor who
 * joined to listen or to cover ten minutes of a shift and wants their screen
 * back without telling the dialer they have gone home. That "session untouched"
 * is also its one hazard, and it is why the two block on different states — see
 * the predicates below.
 *
 * Sharing a label would be the worst of both: an agent pressing the one that
 * reads like "get me out of here" and keeping a live session, or a supervisor
 * pressing it and silently ending one. The design says the same thing, and this
 * module is where the copy lives so the two can be asserted side by side.
 */

/**
 * The states where **a customer is on the line, about to be, or has just been**.
 *
 * `reserved` counts: the call is already dialling and the bridge is coming, so
 * leaving there abandons a connected stranger onto dead air just as surely as
 * `on_call` does. `wrapup` counts because the disposition is still outstanding
 * and leaving discards it.
 */
const LIVE_AGENT_STATES: ReadonlySet<AgencyAgentState> = new Set<AgencyAgentState>([
  'reserved',
  'on_call',
  'wrapup',
]);

/**
 * ── `available` blocks EXIT and not LEAVE. Do not tidy this into symmetry ────
 *
 * Exit closes the station socket (the hook's unmount cleanup) and deliberately
 * leaves the **session** live. The server's `AGENT_LEASE_MS.available` is **45
 * seconds** and is renewed *only* by that socket's heartbeat — a 10s ping with
 * three misses tolerated — and the pacing engine reserves off Redis, never off
 * the DB mirror. So for up to 45 seconds after an Exit the agent is still in the
 * dialable pool **with no console attached**; a reservation landing in that
 * window bridges a customer to nobody.
 *
 * That is exactly the "answered call with no agent" the design rules out, which
 * is meant to be unreachable except by an agent physically disappearing — and a
 * button that manufactures it is worse than no button at all.
 *
 * Leave is the opposite: ending the session is what actually takes the agent out
 * of that pool, so it is the *correct* action in `available` and it is the
 * remedy Exit's refusal names. Blocking both here would leave a supervisor in
 * `available` with no way out of the console whatsoever.
 */
const EXIT_ONLY_BLOCKED_STATES: ReadonlySet<AgencyAgentState> = new Set<AgencyAgentState>([
  'available',
]);

/** Whether **Leave station** must refuse right now. */
export function stationLeaveBlocked(agentState: AgencyAgentState): boolean {
  return LIVE_AGENT_STATES.has(agentState);
}

/** Whether **Exit station** must refuse right now — see the asymmetry note above. */
export function stationExitBlocked(agentState: AgencyAgentState): boolean {
  return LIVE_AGENT_STATES.has(agentState) || EXIT_ONLY_BLOCKED_STATES.has(agentState);
}

/**
 * The disabled reasons.
 *
 * A disabled control on this screen always carries a **visible** stated reason
 * (the house rule `BreakMenu` and `DispositionPad` already follow) — a bare
 * greyed control reads as an outage or a permission the agent has lost, which is
 * a support ticket with no resolution.
 *
 * The two mid-call reasons open with the same instruction because the remedy
 * genuinely is the same one, and then diverge on what is being refused: leaving
 * would drop the person on the line, while exiting would only take the screen
 * away from the agent who still owes them a disposition.
 *
 * The `available` reason is the one that must carry a **remedy** rather than a
 * refusal: nothing is happening on screen, so "not now" alone reads as a broken
 * control. It names both ways out of the pool because they suit different
 * intentions — Leave for someone finishing, Break for someone coming back — and
 * it says what is at stake, since "you are in a pool" is not self-evidently a
 * reason to anyone who has not read the pacing engine.
 */
export const LEAVE_BLOCKED_COPY = 'Finish this call first — leaving now would cut the customer off.';
export const EXIT_BLOCKED_COPY = 'Finish this call first — this call is still on your screen.';
export const EXIT_AVAILABLE_BLOCKED_COPY =
  'You’re still in the dialing pool — leave the station or go on break first, or a call could be sent to an empty screen.';

/** The reason Leave is refused, or `null` when it is not. */
export function leaveBlockedReason(agentState: AgencyAgentState): string | null {
  return stationLeaveBlocked(agentState) ? LEAVE_BLOCKED_COPY : null;
}

/**
 * The reason Exit is refused, or `null` when it is not.
 *
 * Two different refusals, never interchangeable: one is about the call on the
 * screen, the other about the call that has not been dialled yet.
 */
export function exitBlockedReason(agentState: AgencyAgentState): string | null {
  if (LIVE_AGENT_STATES.has(agentState)) return EXIT_BLOCKED_COPY;
  if (EXIT_ONLY_BLOCKED_STATES.has(agentState)) return EXIT_AVAILABLE_BLOCKED_COPY;
  return null;
}

export const LEAVE_LABEL = 'Leave station';
export const EXIT_LABEL = 'Exit station';

export const LEAVE_CONFIRM_TITLE = 'Leave this station?';
/** States both consequences, because they are both news. */
export const LEAVE_CONFIRM_MESSAGE =
  'You’ll stop receiving calls and your station will close.';
export const LEAVE_CONFIRM_ACTION = 'Leave station';

/**
 * What `Exit station` promises, stated on the menu item itself.
 *
 * Without it the difference between the two is a verb, and "exit" and "leave"
 * are synonyms in ordinary English. The distinction that matters — the session
 * stays open — is not inferable from either word.
 */
export const EXIT_HINT = 'Go back to the campaign. Your station stays open.';
/** The same disclosure for Leave, so the pair reads as a choice rather than a duplicate. */
export const LEAVE_HINT = 'End your session and stop taking calls.';

/**
 * Exit is refused while a leave is in flight, too.
 *
 * Two exits racing each other leave the agent on the campaign page believing
 * they are out of the pool, with a `POST /leave` that may still fail behind
 * them — the same outcome the leave dialog's failure handling exists to prevent,
 * reached through a different door.
 */
export const EXIT_WHILE_LEAVING_COPY = 'Wait for your leave request to finish.';

/**
 * ── The agent's own numbers, reachable from inside the station ─────────────
 *
 * `/dialer/performance` and `/dialer/attempts` are linked from `AgentHomePage`,
 * and for most agents that page is a screen they never see: `AgentHomePage`
 * redirects anyone with exactly one enterable assignment straight into the
 * station, and its own comment calls that "the overwhelmingly common shift". So
 * the only way to reach your own figures was to press **Leave** — which ends the
 * session and takes you out of the dialable pool. Checking your numbers between
 * calls cost you your place in the queue.
 *
 * ── Why these are the ONE exception to "no links out of the console" ───────
 * The rule above is not softened. Navigating away closes the station socket, and
 * for up to 45 seconds the server still has the agent in the dialable pool with no
 * screen attached, so a reservation landing in that window bridges a customer to
 * nobody — which is why `Exit station` refuses while `available` at all.
 *
 * **A new tab is not a navigation.** `target="_blank"` opens a second document;
 * this one keeps rendering, the socket stays open, the heartbeat keeps renewing
 * the lease, and a reservation arriving mid-read lands on a console that is still
 * there. That is the whole of the argument, and it is why these are declared here
 * beside the exit predicates rather than as loose JSX: anything that changed them
 * to same-tab links would be re-introducing the defect `Exit station`'s refusal
 * exists to prevent, and it should have to come through this file to do it.
 *
 * `rel="noopener noreferrer"` is not boilerplate here either. Without `noopener`
 * the opened tab gets a live `window.opener` handle on the console — the document
 * holding a live call — and can navigate it.
 *
 * Both destinations are gated identically to the console itself (`RequireAuth` +
 * the `agency` capability + `agency_dialer_enabled`), so a tab that opens is a
 * tab that renders; there is no new refusal for the agent to land on.
 */
export interface StationHistoryLink {
  to: string;
  label: string;
  /** What the tab will show, and the promise that this one stays open. */
  hint: string;
}

export const STATION_HISTORY_LINKS: readonly StationHistoryLink[] = [
  {
    to: '/dialer/performance',
    label: 'My performance',
    hint: 'Opens in a new tab. Your station stays open and you keep your place in the queue.',
  },
  {
    to: '/dialer/attempts',
    label: 'My calls',
    hint: 'Opens in a new tab. Your station stays open and you keep your place in the queue.',
  },
];

/**
 * ── The agent-landing arrival ───────────────────────────────────────────────
 *
 * `/dialer` normally resolves an agent's assignments and, when there is exactly
 * one they can enter, redirects them into that station. This param says **do
 * not** — and names why, because the two arrivals are different news:
 *
 *  - `station` — they pressed Leave. The assignment is untouched, so without
 *    this the redirect fires again and puts them back in the station they just
 *    left.
 *  - `refused` — the station would not open (a stopped or completed campaign, or
 *    any other join failure). The same loop, and worse: the console's error
 *    screen is full-viewport with no navigation on it, and every route back —
 *    `/dialer`, `/app`, `/`, the catch-all — resolves the assignments and returns
 *    them to that same dead end. The only escape was typing this param, which
 *    nobody can be expected to know.
 *
 * It lives here rather than on the landing component so the console can link to
 * the landing screen without importing a component for one string.
 */
export const AGENT_LANDING_PARAM = 'left';

export type AgentLandingArrival = 'station' | 'refused';

/** The arrival, or `null` for an ordinary visit — and for junk in the URL. */
export function agentLandingArrival(raw: string | null | undefined): AgentLandingArrival | null {
  return raw === 'station' || raw === 'refused' ? raw : null;
}

/**
 * The URL that lands an agent WITHOUT bouncing them into a station.
 *
 * Points at `/dialer` directly. It used to return `/app`, which worked only
 * because `AgentLanding` forwards the param — an extra hop through the one
 * component whose whole job is to redirect agents away from `/app`, and one more
 * place for the param to be dropped. `/dialer` is where the arrival is honoured
 * (`AgentHomePage`), so that is where the link goes.
 */
export function agentLandingPath(arrival: AgentLandingArrival): string {
  return `/dialer?${AGENT_LANDING_PARAM}=${arrival}`;
}
