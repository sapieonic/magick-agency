import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getMissedInboundCount } from '../api/inbound';
import { useVisibleInterval } from './useVisibleInterval';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import type { AgencyInboundMissedCountResponse } from '../types/inbound';

/** How often the badge re-reads while inbound is on (a follow-up list, not a live queue). */
export const MISSED_COUNT_POLL_MS = 60_000;
/** Two readers inside this window share one read (the sidebar and the page mount together). */
export const MISSED_COUNT_FRESH_MS = 10_000;

/**
 * The open Missed calls of the caller's scope (`GET /inbound/missed/count`), shared by every
 * reader on the page: the agency sidebar, the agent's nav and the Missed list. One store for the
 * tab, keyed by tenant and account, so a second reader reuses the first one's answer rather than
 * reading again, and {@link refreshMissedCallsCount} (after a Mark handled or a reassign) moves
 * every badge at once.
 */
interface Snapshot {
  key: string | null;
  value: AgencyInboundMissedCountResponse | null;
  /** The last read for `key` failed (the value, if any, is the one before it). */
  failed: boolean;
}

let snapshot: Snapshot = { key: null, value: null, failed: false };
let readAt = 0;
let inFlight: { key: string; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();

function publish(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read(tenantId: string, accountId: string, force: boolean): Promise<void> {
  const key = `${tenantId}/${accountId}`;
  if (inFlight?.key === key) return inFlight.promise;
  if (!force && snapshot.key === key && snapshot.value && Date.now() - readAt < MISSED_COUNT_FRESH_MS) return Promise.resolve();
  const promise = getMissedInboundCount(tenantId, accountId)
    .then((value) => {
      readAt = Date.now();
      publish({ key, value, failed: false });
    })
    // A failed read keeps the last answer: a badge that vanishes on a blip says nothing true.
    .catch(() => publish({ key, value: snapshot.key === key ? snapshot.value : null, failed: true }))
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { key, promise };
  return promise;
}

/** Re-read the count now (after the list changed): every badge on the page follows. */
export function refreshMissedCallsCount(): void {
  const key = snapshot.key;
  if (!key) return;
  const [tenantId, accountId] = key.split('/') as [string, string];
  void read(tenantId, accountId, true);
}

/** Tests only: forget the shared answer. */
export function resetMissedCallsCountForTests(): void {
  snapshot = { key: null, value: null, failed: false };
  readAt = 0;
  inFlight = null;
}

export interface MissedCallsCountState {
  /** The caller's open Missed calls and whether they have any row; null until an answer. */
  count: AgencyInboundMissedCountResponse | null;
  /** An answer came, or the read failed: a page waiting on it can stop waiting. */
  settled: boolean;
}

/**
 * The caller's open Missed calls and whether they have any row at all (null until the first
 * answer, and while `enabled` is false). `poll`: re-read every {@link MISSED_COUNT_POLL_MS} while
 * the page is visible (inbound on); without it, read once and again when the reader comes back
 * (inbound off: the badge only decides whether the list is still worth showing).
 */
export function useMissedCallsCount({
  tenantId,
  accountId,
  enabled,
  poll,
}: {
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
  enabled: boolean;
  poll: boolean;
}): MissedCallsCountState {
  const current = useSyncExternalStore(subscribe, () => snapshot);
  const key = tenantId && accountId ? `${tenantId}/${accountId}` : null;
  const active = enabled && key !== null;

  const load = useCallback(() => {
    if (!active || !tenantId || !accountId) return undefined;
    return read(tenantId, accountId, false);
  }, [active, tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(() => (active && tenantId && accountId ? read(tenantId, accountId, true) : undefined), MISSED_COUNT_POLL_MS, active && poll);
  useRefetchOnReturn(() => load());

  if (!active || current.key !== key) return { count: null, settled: !active };
  return { count: current.value, settled: current.value !== null || current.failed };
}

/** The badge's text: the number, "99+" past the cap, nothing for none. */
export function missedBadgeText(count: AgencyInboundMissedCountResponse | null): string | null {
  if (!count || count.open <= 0) return null;
  if (count.open_capped || count.open > 99) return '99+';
  return String(count.open);
}

/** What a screen reader hears beside the nav entry. */
export function missedBadgeLabel(count: AgencyInboundMissedCountResponse | null): string | null {
  const text = missedBadgeText(count);
  if (!text) return null;
  return text === '99+' ? 'more than 99 to follow up' : `${text} to follow up`;
}
