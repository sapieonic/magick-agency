import type { SearchCampaign } from './consoleSearch';
import { browserStorage } from './browserStorage';

/**
 * The campaigns this browser opened most recently, per tenant and account: what ⌘K lists under
 * the pages before anything is typed (`GlobalSearch`). Remembered when a campaign screen names
 * its campaign (`useCampaignCrumbs`), newest first, five per account.
 *
 * Per browser, and cleared on sign-out (`AuthContext`), as customer history's recent searches
 * are, so the next person on a shared machine starts with none. A convenience only: every
 * access is wrapped, and blocked or full storage just means no list.
 */

export const RECENT_CAMPAIGNS_KEY = 'magick-agency.search.recentCampaigns.v1';
export const RECENT_CAMPAIGNS_MAX = 5;
/** Accounts kept; the one least recently used goes first. */
const MAX_SCOPES = 20;

type Stored = Record<string, SearchCampaign[]>;

function scopeKey(tenantId: string | null, accountId: string): string {
  return `${tenantId ?? ''}/${accountId}`;
}

function readAll(storage: Pick<Storage, 'getItem'> | undefined): Stored {
  if (!storage) return {};
  try {
    const raw = storage.getItem(RECENT_CAMPAIGNS_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

function normalise(value: unknown): SearchCampaign[] {
  if (!Array.isArray(value)) return [];
  const out: SearchCampaign[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, name } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '') continue;
    if (out.some((c) => c.id === id)) continue;
    out.push({ id, name });
    if (out.length === RECENT_CAMPAIGNS_MAX) break;
  }
  return out;
}

/** The account's recent campaigns, newest first; empty on anything unreadable. Never throws. */
export function readRecentCampaigns(
  tenantId: string | null,
  accountId: string | null,
  storage: Pick<Storage, 'getItem'> | undefined = browserStorage(),
): SearchCampaign[] {
  if (!accountId) return [];
  return normalise(readAll(storage)[scopeKey(tenantId, accountId)]);
}

/** Put a campaign at the front of its account's list (moving it, under its current name). Never throws. */
export function rememberCampaignVisit(
  tenantId: string | null,
  accountId: string | null,
  id: string,
  name: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = browserStorage(),
): void {
  if (!storage || !accountId || !id || !name) return;
  const all = readAll(storage);
  const key = scopeKey(tenantId, accountId);
  const list = normalise([{ id, name }, ...normalise(all[key]).filter((c) => c.id !== id)]);
  // Re-added last: the account used most recently is the last one dropped.
  delete all[key];
  all[key] = list;
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(keys.length - MAX_SCOPES, 0))) delete all[old];
  try {
    storage.setItem(RECENT_CAMPAIGNS_KEY, JSON.stringify(all));
  } catch {
    // A full or blocked store: no list this time.
  }
}

/** Sign-out. Never throws. */
export function clearRecentCampaigns(storage: Pick<Storage, 'removeItem'> | undefined = browserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(RECENT_CAMPAIGNS_KEY);
  } catch {
    // Blocked storage held nothing to clear.
  }
}
