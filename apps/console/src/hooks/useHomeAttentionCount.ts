import { useSyncExternalStore } from 'react';

/**
 * The Home page's needs-attention count, shared with the sidebar badge (one value per tenant
 * and account). Whoever computed the list last publishes it: the Home page on every refresh
 * while it is open, the sidebar's own slower read everywhere else. The sidebar reads it from
 * here so the badge and the page never disagree, and skips its own read while a fresh count is
 * already here.
 */
interface Snapshot {
  key: string | null;
  count: number | null;
  /** `Date.now()` of the publish. */
  at: number;
}

let snapshot: Snapshot = { key: null, count: null, at: 0 };
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function homeAttentionKey(tenantId: string | null | undefined, accountId: string | null | undefined): string | null {
  return tenantId && accountId ? `${tenantId}/${accountId}` : null;
}

export function publishHomeAttentionCount(key: string, count: number): void {
  if (snapshot.key === key && snapshot.count === count) {
    snapshot = { ...snapshot, at: Date.now() };
    return;
  }
  snapshot = { key, count, at: Date.now() };
  for (const listener of listeners) listener();
}

/** How long ago the count for `key` was published, or Infinity when it never was. */
export function homeAttentionAge(key: string): number {
  return snapshot.key === key ? Date.now() - snapshot.at : Number.POSITIVE_INFINITY;
}

/** The last count published for `key`, or null. */
export function useHomeAttentionCount(key: string | null): number | null {
  const current = useSyncExternalStore(subscribe, () => snapshot);
  return key !== null && current.key === key ? current.count : null;
}

/** Tests only: forget the shared count. */
export function resetHomeAttentionCountForTests(): void {
  snapshot = { key: null, count: null, at: 0 };
}
