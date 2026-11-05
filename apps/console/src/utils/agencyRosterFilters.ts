import type { AgencyContactFilters, AgencyContactWaiting } from '../types/agency-spine';
import { AGENCY_CONTACT_WAITING } from '../types/agency-spine';

/**
 * The contacts tab's filters, in the URL.
 *
 * ── Why they moved out of component state ───────────────────────────────────
 * They were local `useState` and could not leave the tab. Three things follow
 * from putting them in the query string, and the third is the reason this file
 * exists at all:
 *
 * 1. A narrowed roster survives a refresh and can be sent to a colleague — the
 *    same property the campaign workspace's SECTIONS already have, and the same
 *    argument (`agencyCampaignTabs.ts`: "sections are URLs, not component
 *    state").
 * 2. The browser's back button answers a filter change.
 * 3. **"The filters on screen become the selector" is literally true.** The selector *is* the filter set
 *    the supervisor is already looking at: "the supervisor narrows the Contacts
 *    tab until it shows the rows they mean, presses Retry these contacts, and
 *    the query string they were already looking at becomes the selector." With
 *    the filters trapped in a component, that sentence describes a coincidence
 *    of two representations; with them in the URL it describes one.
 *
 * ── Repeated params, never comma-joined ────────────────────────────────────
 * Matching what this client sends to the API on every agency filter. A
 * comma-joined value would additionally be unable to carry a disposition code
 * containing a comma — which the server's `forwardAllowedQuery` and the dialer runtime's
 * `multiParam` already cannot, but there is no reason for the URL to lose it a
 * second time before the request is even built.
 *
 * ── An unrecognised key is ignored, not preserved ──────────────────────────
 * Reading is an allow-list. A hand-edited or stale link degrades to the filters
 * this build knows rather than forwarding an unknown key to a route that would
 * 400 `unknown_query_params` — the API's contacts (and attempts) lists refuse
 * anything not on their allow-list, they no longer drop it. Forwarding a typo
 * would fail the whole page load instead of showing the filters this build
 * understands.
 */

/** The array-valued filters that round-trip. Order fixes the query string's. */
const LIST_KEYS = ['state', 'suppressed_reason', 'last_disposition', 'assigned_to'] as const;

type ListKey = (typeof LIST_KEYS)[number];

/**
 * Compile-time proof that every listed key really is an array filter. Left
 * untyped, a scalar added to this list would be read as `string[]` and sent as
 * a repeated param the server has no branch for.
 */
type ListKeysAreArrays = {
  [K in ListKey]: AgencyContactFilters[K] extends string[] | undefined ? true : never;
};
const _listKeysAreArrays: ListKeysAreArrays = {
  state: true,
  suppressed_reason: true,
  last_disposition: true,
  // Contact assignment: agent user ids and/or `unassigned` (the pool). Read from
  // a link whether or not the flag is on; the roster only offers the chip, and
  // sends it, while the flag is on (see the page).
  assigned_to: true,
};
void _listKeysAreArrays;

/**
 * URL → filters.
 *
 * Empty strings are dropped rather than kept: `?phone=` is what a cleared search
 * box would write, and an empty value sent as a filter makes an empty box look
 * like a filter that matches nothing.
 */
export function rosterFiltersFromParams(params: URLSearchParams): AgencyContactFilters {
  const filters: AgencyContactFilters = {};
  for (const key of LIST_KEYS) {
    const values = params.getAll(key).filter((value) => value !== '');
    if (values.length > 0) filters[key] = values;
  }
  const phone = params.get('phone')?.trim();
  if (phone) filters.phone = phone;
  // The insights roster's buckets (Insights tab links). Allow-listed like every key here: a
  // value this build does not know is dropped rather than sent to a route that would 400 it.
  const waiting = params.get('waiting');
  if (waiting && (AGENCY_CONTACT_WAITING as readonly string[]).includes(waiting)) {
    filters.waiting = waiting as AgencyContactWaiting;
  }
  const attempted = params.get('attempted');
  if (attempted === '1' || attempted === '0') filters.attempted = attempted;
  return filters;
}

/**
 * Filters → URL.
 *
 * Deliberately builds a FRESH `URLSearchParams` rather than mutating the one
 * the router handed over: a filter that has been cleared has to disappear from
 * the query string, and a merge cannot express a removal. Nothing else on this
 * route carries state in the query today, and anything that later does should
 * be merged here explicitly rather than by accident.
 */
export function rosterFiltersToParams(filters: AgencyContactFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of LIST_KEYS) {
    for (const value of filters[key] ?? []) params.append(key, value);
  }
  if (filters.phone) params.set('phone', filters.phone);
  if (filters.waiting) params.set('waiting', filters.waiting);
  if (filters.attempted) params.set('attempted', filters.attempted);
  return params;
}

/** How many independent filter GROUPS are applied — the badge on the filter card. */
export function rosterFilterGroupCount(filters: AgencyContactFilters): number {
  let count = 0;
  for (const key of LIST_KEYS) if (filters[key]?.length) count += 1;
  if (filters.phone) count += 1;
  if (filters.waiting) count += 1;
  if (filters.attempted) count += 1;
  return count;
}

/** How each waiting bucket reads: the Insights tab's own row labels (`RosterSection`). */
export const WAITING_LABELS: Record<AgencyContactWaiting, string> = {
  due_now: 'Due now',
  retry: 'Waiting for retry time',
  callback: 'Callback scheduled',
};

/**
 * The two filters only a link sets (no control on the form), as removable chips: without a
 * chip a supervisor would be looking at a narrowed list with nothing on screen saying so.
 */
export function rosterLinkFilterChips(
  filters: AgencyContactFilters,
): Array<{ id: string; label: string; without: AgencyContactFilters }> {
  const chips: Array<{ id: string; label: string; without: AgencyContactFilters }> = [];
  if (filters.waiting) {
    const { waiting: _w, ...rest } = filters;
    void _w;
    chips.push({ id: 'waiting', label: `Waiting: ${WAITING_LABELS[filters.waiting]}`, without: rest });
  }
  if (filters.attempted) {
    const { attempted: _a, ...rest } = filters;
    void _a;
    chips.push({
      id: 'attempted',
      label: filters.attempted === '1' ? 'Attempted at least once' : 'Never attempted',
      without: rest,
    });
  }
  return chips;
}

export function isRosterFiltered(filters: AgencyContactFilters): boolean {
  return rosterFilterGroupCount(filters) > 0;
}
