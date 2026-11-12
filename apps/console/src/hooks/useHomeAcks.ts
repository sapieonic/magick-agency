import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import type { HomeAttentionItem } from '../utils/agency/home';
import { ackOf, homeAckDay, todaysAcks, type HomeAck, type HomeAckRecord } from '../utils/agency/homeAcks';

/**
 * The signed-in reader's Home acknowledgements ("Got it", `utils/agency/homeAcks.ts`) for one
 * tenant and account, kept in this browser's storage under their user id and shared by every
 * reader in the tab (the Home page, the sidebar badge, the menu button's dot), so a "Got it" takes
 * the row off the badge at once. Sign-out is in place, so it forgets the in-tab copies
 * ({@link resetHomeAcks}, from `AuthContext`); another person's are under another key.
 *
 * Storage is a convenience: every access is guarded, and without it (a private window, blocked
 * site data) acknowledgements simply last until the page is reloaded or the reader signs out.
 */

const PREFIX = 'magick.home.acks.v1';

/** The storage key for a user, tenant and account. */
export function homeAcksKey(userId: string, tenantId: string, accountId: string): string {
  return `${PREFIX}:${userId}:${tenantId}:${accountId}`;
}

const NONE: Readonly<Record<string, HomeAck>> = Object.freeze({});

/** In-tab copy per key, the source of truth when storage fails. */
const memory = new Map<string, HomeAckRecord>();
/** The snapshot handed to React per key, rebuilt only when the record or the day changes. */
const snapshots = new Map<string, { record: HomeAckRecord | undefined; day: string; acks: Record<string, HomeAck> }>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function readStored(key: string): HomeAckRecord | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as HomeAckRecord;
      memory.set(key, parsed);
      return parsed;
    }
  } catch {
    // Unreadable or blocked storage: the in-tab copy stands.
  }
  return memory.get(key);
}

function write(key: string, record: HomeAckRecord): void {
  memory.set(key, record);
  try {
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Full or blocked storage: kept for this tab only.
  }
  notify();
}

function snapshot(key: string | null): Readonly<Record<string, HomeAck>> {
  if (!key) return NONE;
  const record = memory.get(key) ?? readStored(key);
  const day = homeAckDay(new Date());
  const kept = snapshots.get(key);
  if (kept && kept.record === record && kept.day === day) return kept.acks;
  const acks = todaysAcks(record, day);
  snapshots.set(key, { record, day, acks });
  return acks;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forget the in-tab copies (sign-out: the next person in this tab must not inherit them). */
export function resetHomeAcks(): void {
  memory.clear();
  snapshots.clear();
  notify();
}

/** The name the tests know it by. */
export const resetHomeAcksForTests = resetHomeAcks;

export interface HomeAcks {
  /** Today's acknowledgements, by row id. */
  acks: Readonly<Record<string, HomeAck>>;
  /** Put a row aside until it gets worse or tomorrow. */
  acknowledge: (item: HomeAttentionItem) => void;
}

export function useHomeAcks(tenantId: string | null | undefined, accountId: string | null | undefined): HomeAcks {
  const userId = useAuth().user?.id;
  const key = userId && tenantId && accountId ? homeAcksKey(userId, tenantId, accountId) : null;
  const acks = useSyncExternalStore(subscribe, () => snapshot(key));

  // Another tab's "Got it" (or its new day) reaches this one.
  useEffect(() => {
    if (!key) return undefined;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      memory.delete(key);
      notify();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  const acknowledge = useCallback((item: HomeAttentionItem) => {
    if (!key) return;
    const day = homeAckDay(new Date());
    write(key, { day, acks: { ...todaysAcks(memory.get(key) ?? readStored(key), day), [item.id]: ackOf(item) } });
  }, [key]);

  return { acks, acknowledge };
}
