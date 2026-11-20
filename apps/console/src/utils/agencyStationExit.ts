/**
 * The ways out of the station that are not "Finish work for today": the agent's own numbers in a
 * new tab, and the landing screen that does not send the agent straight back in. Finish work
 * itself is `pages/agency/station/useStationExit.ts`; its words are the station's (`stationCopy.ts`).
 */

/**
 * ── The agent's own numbers, reachable from inside the station ─────────────
 *
 * `/dialer/performance` and `/dialer/attempts` are linked from `AgentHomePage`,
 * and for most agents that page is a screen they never see: `AgentHomePage`
 * redirects anyone with exactly one enterable assignment straight into the
 * station, and its own comment calls that "the overwhelmingly common shift". So
 * the only way to reach your own figures was to leave the station — which ends the
 * session and takes you out of the dialable pool. Checking your numbers between
 * calls cost you your place in the queue.
 *
 * ── Why these are the ONE exception to "no links out of the console" ───────
 * The rule above is not softened. Navigating away closes the station socket, and
 * for up to 45 seconds the server still has the agent in the dialable pool with no
 * screen attached, so a reservation landing in that window bridges a customer to
 * nobody.
 *
 * **A new tab is not a navigation.** `target="_blank"` opens a second document;
 * this one keeps rendering, the socket stays open, the heartbeat keeps renewing
 * the lease, and a reservation arriving mid-read lands on a console that is still
 * there. That is the whole of the argument, and it is why these are declared here
 * beside the exit predicates rather than as loose JSX: anything that changed them
 * to same-tab links would be re-introducing that defect, and it should have to
 * come through this file to do it.
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
 *  - `station` — they finished work for today. The assignment is untouched, so without
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
