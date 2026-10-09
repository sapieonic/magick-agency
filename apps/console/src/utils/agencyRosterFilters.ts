import type { AgencyContactFilters } from '../types/agency-spine';

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
 * 3. **Retry design DR-3 is literally true.** The selector *is* the filter set
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
const LIST_KEYS = ['state', 'suppressed_reason', 'last_disposition'] as const;

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
  return params;
}

/** How many independent filter GROUPS are applied — the badge on the filter card. */
export function rosterFilterGroupCount(filters: AgencyContactFilters): number {
  let count = 0;
  for (const key of LIST_KEYS) if (filters[key]?.length) count += 1;
  if (filters.phone) count += 1;
  return count;
}

export function isRosterFiltered(filters: AgencyContactFilters): boolean {
  return rosterFilterGroupCount(filters) > 0;
}
