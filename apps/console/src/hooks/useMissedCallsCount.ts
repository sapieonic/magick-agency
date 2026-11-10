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
 * A reader's poll tick is skipped while another reader's poll read of the same count started inside
 * this window, so the tab polls once a minute however many readers are mounted. Under the poll
 * period, so a reader's own next tick always reads.
 */
const MISSED_COUNT_POLL_FRESH_MS = MISSED_COUNT_POLL_MS - 5_000;

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
/** When the last poll read that answered started, and for which count. */
let lastPoll: { key: string; at: number } | null = null;
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

/** `mount`: shares a read under {@link MISSED_COUNT_FRESH_MS}; `poll`: one per minute for the tab; `force`: always reads. */
function read(tenantId: string, accountId: string, mode: 'mount' | 'poll' | 'force'): Promise<void> {
  const key = `${tenantId}/${accountId}`;
  if (inFlight?.key === key) return inFlight.promise;
  if (mode === 'mount' && snapshot.key === key && snapshot.value && Date.now() - readAt < MISSED_COUNT_FRESH_MS) return Promise.resolve();
  if (mode === 'poll' && lastPoll?.key === key && Date.now() - lastPoll.at < MISSED_COUNT_POLL_FRESH_MS) return Promise.resolve();
  const startedAt = Date.now();
  const promise = getMissedInboundCount(tenantId, accountId)
    .then((value) => {
      readAt = Date.now();
      if (mode === 'poll') lastPoll = { key, at: startedAt };
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
  void read(tenantId, accountId, 'force');
}

/** Tests only: forget the shared answer. */
export function resetMissedCallsCountForTests(): void {
  snapshot = { key: null, value: null, failed: false };
  readAt = 0;
  lastPoll = null;
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
    return read(tenantId, accountId, 'mount');
  }, [active, tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(() => (active && tenantId && accountId ? read(tenantId, accountId, 'poll') : undefined), MISSED_COUNT_POLL_MS, active && poll);
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
