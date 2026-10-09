/**
 * The three screens a dedicated agent has, named in one place.
 *
 * ── Why this list exists ───────────────────────────────────────────────────
 * An `agent` is hierarchy level 5 and inherits NO navigation: `AppLayout`'s nav
 * floors at `viewer` and `AgencyLayout`'s entries floor higher still, so all four
 * agent routes are full-viewport and outside both shells. That is right — a
 * sidebar rendered around nothing is noise, and an escape hatch beside a live
 * call is a misclick that hangs up on a customer.
 *
 * The cost was that an agent had no map. Each surface knew about one or two of
 * its neighbours through hand-written `back` and `sibling` props, so what an
 * agent could reach depended on where they happened to be standing, and the
 * product never said "these are your screens" anywhere. This list is that
 * sentence, and `AgentNav` renders it identically on all three.
 *
 * ── `/station` is deliberately NOT here ────────────────────────────────────
 * It is a fourth agent route and it is not a destination on a nav bar. A station
 * is an agent joined to one campaign's dialable pool, so there is no
 * campaign-less station to link to — `/station` alone lands on the console's "No
 * campaign selected" refusal. Entering one is a decision made against a specific
 * campaign, which is what the rows on `/dialer` are for.
 *
 * The reverse — a link from inside the console back to these — is a different
 * problem with a different answer, because navigating away from a live station
 * closes the socket and leaves core holding the agent's lease for up to 45s with
 * no screen attached. `STATION_HISTORY_LINKS` in `agencyStationExit.ts` solves it
 * with `target="_blank"`, and `agencyAgentSurfaces.test.ts` pins those two
 * destinations against this list so a renamed route cannot fix one and break the
 * other.
 *
 * Note the station menu carries only the two HISTORY surfaces, not `/dialer`.
 * That is not an oversight and must not be "completed": `/dialer` redirects an
 * agent with one enterable assignment straight into `/station`, so a link to it
 * from inside a live console is a link that opens a SECOND station tab for the
 * same agent. Reaching the chooser is what Leave is for.
 */

export type AgentSurfaceId = 'campaigns' | 'performance' | 'attempts';

export interface AgentSurface {
  id: AgentSurfaceId;
  to: string;
  /**
   * First person, and consistently so.
   *
   * These sit beside a supervisor's vocabulary elsewhere in the product
   * ("Everyone who dialled", "Who drove this campaign"), and the difference is
   * the point: this nav belongs to the person whose calls they are.
   */
  label: string;
}

export const AGENT_SURFACES: readonly AgentSurface[] = [
  /*
    Campaigns first, because it is the only one that answers "what am I supposed
    to be doing" — the other two are about what already happened. It is also the
    surface the other two treat as home, so it leads for the same reason a
    breadcrumb's root does.
  */
  { id: 'campaigns', to: '/dialer', label: 'My campaigns' },
  { id: 'performance', to: '/dialer/performance', label: 'My performance' },
  { id: 'attempts', to: '/dialer/attempts', label: 'My calls' },
];

/** The surface at a path, or `null`. Exact match — none of these has children. */
export function agentSurfaceAt(pathname: string): AgentSurface | null {
  return AGENT_SURFACES.find((surface) => surface.to === pathname) ?? null;
}
