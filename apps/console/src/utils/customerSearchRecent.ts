/**
 * The customer-history box's recent searches: the last five numbers searched on
 * THIS device (`docs/customer-history.md` §5).
 *
 * Per browser, not per user, and cleared by the box's "Clear recent searches" and on sign-out
 * (`AuthContext`): a phone number is personal data, and a shared machine must not
 * hand the next person the last one's customers. Only the E.164 the server
 * searched and the picked country are kept; never the raw text typed.
 *
 * Injected storage and a try/catch round every access, as `agencyCuePrefs.ts`
 * does: `localStorage` throws in a browser with site data blocked, and a search
 * box that will not open because its history could not be read is worse than one
 * with no history.
 */

export interface RecentCustomerSearch {
  /** The number searched, E.164 (`+919876543210`). */
  e164: string;
  /** ISO of the country picked when it was searched; empty for the platform default the picker does not list. */
  country: string;
}

export const RECENT_CUSTOMER_SEARCHES_KEY = 'magick-agency.customerSearch.recent.v1';
export const RECENT_CUSTOMER_SEARCHES_MAX = 5;

const E164 = /^\+\d{8,15}$/;

/**
 * Every mounted box shows the same list: the page's own box stays mounted while a
 * search runs from the top bar's panel, and "Clear recent searches" in one box
 * must empty the other. Writes and clears here tell each subscriber to re-read;
 * another tab's writes arrive as a `storage` event (`useRecentCustomerSearches`).
 */
const listeners = new Set<() => void>();

function notifyRecentCustomerSearches(): void {
  for (const listener of [...listeners]) listener();
}

/** Called after every remember or clear; returns the unsubscribe. */
export function subscribeRecentCustomerSearches(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const ISO = /^(?:[A-Z]{2})?$/;

function normalize(value: unknown): RecentCustomerSearch[] {
  if (!Array.isArray(value)) return [];
  const out: RecentCustomerSearch[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const e164 = record['e164'];
    const country = record['country'];
    if (typeof e164 !== 'string' || !E164.test(e164)) continue;
    if (typeof country !== 'string' || !ISO.test(country)) continue;
    if (out.some((r) => r.e164 === e164)) continue;
    out.push({ e164, country });
    if (out.length === RECENT_CUSTOMER_SEARCHES_MAX) break;
  }
  return out;
}

/** The stored list, newest first; empty on anything unreadable. Never throws. */
export function readRecentCustomerSearches(storage: Pick<Storage, 'getItem'> | undefined): RecentCustomerSearch[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_CUSTOMER_SEARCHES_KEY);
    if (raw === null) return [];
    return normalize(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Put a search at the front (moving it if already listed), keep five, and store. Returns the new list. */
export function rememberCustomerSearch(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  entry: RecentCustomerSearch,
): RecentCustomerSearch[] {
  const next = normalize([entry, ...readRecentCustomerSearches(storage).filter((r) => r.e164 !== entry.e164)]);
  if (!storage) return next;
  try {
    storage.setItem(RECENT_CUSTOMER_SEARCHES_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked store: the list lasts for this page only.
  }
  notifyRecentCustomerSearches();
  return next;
}

/** "Clear recent searches", and sign-out. Never throws. */
export function clearRecentCustomerSearches(storage: Pick<Storage, 'removeItem'> | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(RECENT_CUSTOMER_SEARCHES_KEY);
  } catch {
    // Blocked storage held nothing to clear.
  }
  notifyRecentCustomerSearches();
}

