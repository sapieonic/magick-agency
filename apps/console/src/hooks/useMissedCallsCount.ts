import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getMissedInboundCount } from '../api/inbound';
import { useVisibleInterval } from './useVisibleInterval';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import type { AgencyInboundMissedCountResponse } from '../types/inbound';
import { badgeText } from '../utils/badgeText';

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
 * tab, keyed by tenant, account and the count's `assignee` (IQ57: the badge counts what the
 * caller's list shows), so a second reader reuses the first one's answer rather than reading
 * again, and {@link refreshMissedCallsCount} (after a Mark handled, a claim or a reassign) moves
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
function read(tenantId: string, accountId: string, assignee: string | undefined, mode: 'mount' | 'poll' | 'force'): Promise<void> {
  const key = countKey(tenantId, accountId, assignee);
  if (inFlight?.key === key) return inFlight.promise;
  if (mode === 'mount' && snapshot.key === key && snapshot.value && Date.now() - readAt < MISSED_COUNT_FRESH_MS) return Promise.resolve();
  if (mode === 'poll' && lastPoll?.key === key && Date.now() - lastPoll.at < MISSED_COUNT_POLL_FRESH_MS) return Promise.resolve();
  const startedAt = Date.now();
  const promise = getMissedInboundCount(tenantId, accountId, assignee ? { assignee } : {})
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

/** The store's key: one count per tenant, account and `assignee` (none: the caller's default scope). */
function countKey(tenantId: string, accountId: string, assignee: string | undefined): string {
  return `${tenantId}/${accountId}/${assignee ?? ''}`;
}

/** Re-read the count now (after the list changed): every badge on the page follows. */
export function refreshMissedCallsCount(): void {
  const key = snapshot.key;
  if (!key) return;
  const [tenantId, accountId, assignee] = key.split('/') as [string, string, string];
  void read(tenantId, accountId, assignee || undefined, 'force');
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
 * answer, and while `enabled` is false). `assignee`: the count's scope (IQ57), the list's own
 * (`me` for an agent's badge; absent, the caller's default scope). `poll`: re-read every
 * {@link MISSED_COUNT_POLL_MS} while the page is visible (inbound on); without it, read once and
 * again when the reader comes back (inbound off: the badge only decides whether the list is still
 * worth showing).
 */
export function useMissedCallsCount({
  tenantId,
  accountId,
  assignee,
  enabled,
  poll,
}: {
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
  assignee?: string;
  enabled: boolean;
  poll: boolean;
}): MissedCallsCountState {
  const current = useSyncExternalStore(subscribe, () => snapshot);
  const key = tenantId && accountId ? countKey(tenantId, accountId, assignee) : null;
  const active = enabled && key !== null;

  const load = useCallback(() => {
    if (!active || !tenantId || !accountId) return undefined;
    return read(tenantId, accountId, assignee, 'mount');
  }, [active, tenantId, accountId, assignee]);

  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(
    () => (active && tenantId && accountId ? read(tenantId, accountId, assignee, 'poll') : undefined),
    MISSED_COUNT_POLL_MS,
    active && poll,
  );
  useRefetchOnReturn(() => load());

  if (!active || current.key !== key) return { count: null, settled: !active };
  return { count: current.value, settled: current.value !== null || current.failed };
}

/** The badge's text: the number, "99+" past the cap, nothing for none. */
export function missedBadgeText(count: AgencyInboundMissedCountResponse | null): string | null {
  return badgeText(count?.open, count?.open_capped);
}

/** What a screen reader hears beside the nav entry. */
export function missedBadgeLabel(count: AgencyInboundMissedCountResponse | null): string | null {
  const text = missedBadgeText(count);
  if (!text) return null;
  return text === '99+' ? 'more than 99 to follow up' : `${text} to follow up`;
}
