import { useEffect, useState } from 'react';
import { listAgencyCampaignsPage } from '../api/agencyCampaigns';
import type { SearchCampaign } from '../utils/consoleSearch';

/**
 * The account's campaigns as search (`GlobalSearch`) finds them: ids and names, read through
 * the full campaign list (every status, every page: the first, then the rest a few at a time,
 * {@link readAllCampaigns}), so it is read as rarely as it can be.
 *
 * Kept for the session per tenant and account, stale-while-revalidate: an open shows the list
 * it has at once, and reads it again in the background only when that list is older than
 * {@link SEARCH_CAMPAIGNS_FRESH_MS}, so opening search twice in a minute asks for nothing. A
 * read already in flight is shared rather than repeated. Moving to another tenant or account
 * (a full page load today, B26) drops every other scope's list. A failed refresh keeps the list
 * there was; a failed first read is not kept, so the next open tries again.
 */
export const SEARCH_CAMPAIGNS_FRESH_MS = 60_000;

export type SearchCampaignsState =
  | { status: 'idle' | 'loading' | 'error'; campaigns: null }
  | { status: 'ready'; campaigns: SearchCampaign[] };

interface CacheEntry {
  campaigns: SearchCampaign[] | null;
  readAt: number;
  inflight: Promise<SearchCampaign[]> | null;
}

const cache = new Map<string, CacheEntry>();

/** Forget every list (tests; a sign-out is a full page load). */
export function resetSearchCampaignsCache(): void {
  cache.clear();
}

function scopeKey(tenantId: string | null, accountId: string): string {
  return `${tenantId ?? ''}\u0000${accountId}`;
}

const PAGE_SIZE = 100;
/** Bounds the read at 5,000 campaigns, as the full list's own walk is. */
const MAX_PAGES = 50;
/** Pages read at once after the first. */
const PARALLEL_PAGES = 4;

/**
 * Every campaign's id and name, newest first: the first page says how many there are, and the
 * rest are read {@link PARALLEL_PAGES} at a time. Only the id and name of each row are kept. An
 * empty page ends the read (a server whose `total` overstates what it returns).
 *
 * The first page that fails fails the whole read, and no worker starts another page after it
 * (a request already on its way is left to finish; nothing reads its answer). Offset pages of a
 * newest-first list shift while campaigns are created, so a campaign can come back on two
 * pages: each id is kept once, where it was first seen.
 */
export async function readAllCampaigns(tenantId: string | null, accountId: string): Promise<SearchCampaign[]> {
  const readPage = async (page: number) => {
    const { campaigns, total } = await listAgencyCampaignsPage(tenantId ?? undefined, accountId, page * PAGE_SIZE, PAGE_SIZE);
    return { names: campaigns.map((c) => ({ id: c.id, name: c.name })), total };
  };
  const first = await readPage(0);
  const pageCount = Math.min(Math.ceil(first.total / PAGE_SIZE), MAX_PAGES);
  const pages: SearchCampaign[][] = [first.names];
  let next = 1;
  let ended = first.names.length === 0;
  const stop = new AbortController();
  const worker = async () => {
    while (!ended && !stop.signal.aborted && next < pageCount) {
      const page = next++;
      try {
        const { names } = await readPage(page);
        if (names.length === 0) ended = true;
        pages[page] = names;
      } catch (err) {
        stop.abort(err);
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PAGES, Math.max(pageCount - 1, 0)) }, worker));
  const seen = new Set<string>();
  return pages.flat().filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

function read(key: string, tenantId: string | null, accountId: string): Promise<SearchCampaign[]> {
  const entry = cache.get(key) ?? { campaigns: null, readAt: 0, inflight: null };
  if (entry.inflight) return entry.inflight;
  const inflight = readAllCampaigns(tenantId, accountId).then(
    (campaigns) => {
      // Only if the scope is still the one asked for: a switch dropped it meanwhile.
      if (cache.get(key) === entry) Object.assign(entry, { campaigns, readAt: Date.now(), inflight: null });
      return campaigns;
    },
    (err: unknown) => {
      entry.inflight = null;
      throw err;
    },
  );
  entry.inflight = inflight;
  cache.set(key, entry);
  return inflight;
}

/**
 * The campaigns for search while it is open. Nothing is read for a reader the Campaigns page is
 * not offered to (`allowed`) or without an account.
 */
export function useSearchCampaigns(allowed: boolean, tenantId: string | null, accountId: string | null): SearchCampaignsState {
  const key = allowed && accountId ? scopeKey(tenantId, accountId) : null;
  const [state, setState] = useState<SearchCampaignsState>(() => fromCache(key));

  useEffect(() => {
    if (!key || !accountId) {
      setState({ status: 'idle', campaigns: null });
      return undefined;
    }
    for (const other of [...cache.keys()]) if (other !== key) cache.delete(other);

    const cached = cache.get(key)?.campaigns ?? null;
    setState(fromCache(key));
    const entry = cache.get(key);
    if (cached && entry && Date.now() - entry.readAt < SEARCH_CAMPAIGNS_FRESH_MS) return undefined;

    let live = true;
    read(key, tenantId, accountId).then(
      (campaigns) => {
        if (live) setState({ status: 'ready', campaigns });
      },
      () => {
        if (live && !cached) setState({ status: 'error', campaigns: null });
      },
    );
    return () => {
      live = false;
    };
  }, [key, tenantId, accountId]);

  return state;
}

function fromCache(key: string | null): SearchCampaignsState {
  const campaigns = key ? cache.get(key)?.campaigns ?? null : null;
  if (campaigns) return { status: 'ready', campaigns };
  return key ? { status: 'loading', campaigns: null } : { status: 'idle', campaigns: null };
}
