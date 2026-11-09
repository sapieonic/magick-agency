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
 * closes the socket and leaves the server holding the agent's lease for up to 45s with
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

export type AgentSurfaceId = 'campaigns' | 'performance' | 'attempts' | 'phone' | 'customers' | 'reports' | 'missed';

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

/**
 * The soft phone (`docs/softphone.md` §7), the fourth screen — shown only when
 * `agency_softphone_enabled` is on for the account and the caller holds
 * `agency.softphone.dial`, which is every agent once the flag is on (SP4).
 *
 * Kept OUT of {@link AGENT_SURFACES} rather than added to it, for two reasons the
 * three would not survive: it is not always there (the list above is a fixed
 * map, and the station's history links are pinned against it), and it is not a
 * history screen in the first person ("My …") — it is a tool, named as the
 * product names it. Placed second, after the campaigns it sits beside.
 */
export const SOFTPHONE_SURFACE: AgentSurface = { id: 'phone', to: '/dialer/phone', label: 'Soft phone' };

/**
 * Customer history (`docs/customer-history.md`): search one number and see every
 * call to it. Every agent may search (CH1, `agency.customer_history.read` floors at
 * `agent`), and the agency shell's top-bar box is out of an agent's reach, so the
 * page is served here too. Kept out of {@link AGENT_SURFACES} for the soft phone's
 * reasons: it is gated by a permission, and it is a tool, not a "My …" history.
 * Last, after the agent's own screens.
 */
export const CUSTOMERS_SURFACE: AgentSurface = { id: 'customers', to: '/dialer/customers', label: 'Search a number' };

/**
 * "My reports" (`docs/reports.md`): the agent's own exported reviews, behind the
 * `agency_reports_enabled` flag. Kept out of {@link AGENT_SURFACES} because it is
 * flag-gated; after "My calls", beside the agent's other histories, and before the
 * customer search tool.
 */
export const REPORTS_SURFACE: AgentSurface = { id: 'reports', to: '/dialer/reports', label: 'My reports' };

/**
 * "Missed calls" (`docs/inbound.md` §7): the inbound calls that reached nobody and were left
 * to the agent (their sticky customer rang), with Call back and Mark handled. Behind the
 * `agency_inbound_enabled` flag and `agency.inbound.read` (floored at `agent`), so kept out of
 * {@link AGENT_SURFACES}; after the soft phone, which its Call back opens, since it is work to
 * do rather than a history.
 */
export const MISSED_SURFACE: AgentSurface = { id: 'missed', to: '/dialer/missed', label: 'Missed calls' };

/**
 * The agent's screens for this account: the three, plus the soft phone when it is on
 * for them, plus their missed inbound calls when inbound is on, plus their reports when
 * reports are on, plus customer history when they may search.
 */
export function agentSurfacesFor(options: {
  softphone: boolean;
  customers?: boolean;
  reports?: boolean;
  missed?: boolean;
}): readonly AgentSurface[] {
  const tools = [
    ...(options.softphone ? [SOFTPHONE_SURFACE] : []),
    ...(options.missed ? [MISSED_SURFACE] : []),
  ];
  const base = tools.length > 0 ? [AGENT_SURFACES[0]!, ...tools, ...AGENT_SURFACES.slice(1)] : AGENT_SURFACES;
  if (!options.customers && !options.reports) return base;
  return [...base, ...(options.reports ? [REPORTS_SURFACE] : []), ...(options.customers ? [CUSTOMERS_SURFACE] : [])];
}

/** The surface at a path, or `null`. Exact match — none of these has children. */
export function agentSurfaceAt(pathname: string): AgentSurface | null {
  return AGENT_SURFACES.find((surface) => surface.to === pathname) ?? null;
}
