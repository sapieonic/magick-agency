import type { CustomerSearchResponse } from '@magick-agency/contracts/api/agency/customer-history';

/**
 * The answers to this tab's recent customer searches, in memory, keyed by search id.
 *
 * The page's URL is `/agency/customers` (or `/dialer/customers`) with ONLY the
 * search id in the history state (CH6): the number never reaches the address bar,
 * the browser's history list or an analytics pageview. So the answer lives here,
 * in memory, and nowhere that outlives the tab. A reload empties this module and
 * the page shows the empty search box, which is the decided behaviour (the server
 * keeps the id for 30 minutes, but the page has no number to show until it is
 * searched again).
 *
 * Bounded, so a long shift of searches does not keep every answer alive.
 */

const MAX_KEPT = 10;
const answers = new Map<string, CustomerSearchResponse>();
/**
 * The page's filter form carried onto a fresh search id ("Search again" after an
 * expiry keeps the filters). Memory only, like the answers, and never in the
 * history state, which holds the search id alone. Opaque here: the page owns its shape.
 */
const carriedFilters = new Map<string, unknown>();

export function rememberCustomerSearchAnswer(answer: CustomerSearchResponse): void {
  answers.delete(answer.search_id);
  answers.set(answer.search_id, answer);
  while (answers.size > MAX_KEPT) {
    const oldest = answers.keys().next().value;
    if (oldest === undefined) break;
    answers.delete(oldest);
    carriedFilters.delete(oldest);
  }
}

/** Open `searchId` with these filters rather than none. */
export function carryCustomerHistoryFilters(searchId: string, filters: unknown): void {
  carriedFilters.set(searchId, filters);
}

export function carriedCustomerHistoryFilters(searchId: string): unknown {
  return carriedFilters.get(searchId);
}

export function customerSearchAnswer(searchId: string | null | undefined): CustomerSearchResponse | null {
  if (!searchId) return null;
  return answers.get(searchId) ?? null;
}

/** Sign-out: nothing searched by one person stays for the next. */
export function clearCustomerSearchAnswers(): void {
  answers.clear();
  carriedFilters.clear();
}

/** The history state the page reads; nothing else may go in it. */
export interface CustomerHistoryLocationState {
  searchId: string;
}

export function searchIdFromLocationState(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const id = (state as Record<string, unknown>)['searchId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}
