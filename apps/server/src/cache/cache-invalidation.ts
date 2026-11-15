/**
 * In-process caches told that an entry is stale, from whichever process on this host made the
 * write. A plain channel of `{ cache, key }`: the cache's owner listens for its own name, the
 * writer publishes the name and the key, and neither knows the other.
 *
 * ── Why its own channel ─────────────────────────────────────────────────────
 * Some caches live on the primary only (the supervisors' shared campaign stats read,
 * `agency/campaign-stats-reads.ts`), while a write that makes them stale may run in a media
 * worker (`MEDIA_WORKERS`, `docs/scaling.md`): a supervisor's force-available, served where the
 * agent's session lives. The pacing invalidation bus also crosses that gap, but its events are
 * the things a pacing tick reads, and a cache's staleness is not one of them; this channel
 * carries those instead, so no pacing consumer has to know about a cache.
 *
 * ── Across processes ────────────────────────────────────────────────────────
 * A publish is delivered to this process's listeners, synchronously, and, in a media worker, also
 * sent to the primary (`cache.invalidate` over IPC: `media-child.ts` installs the forwarder,
 * `media-cluster.ts` delivers what arrives with {@link deliverCacheInvalidation}). Worker to
 * primary only: no cache a worker holds is listed here. An event is a hint like the pacing bus's:
 * delivery may be late or lost (a worker that dies between its write and its send), so every
 * cache listed keeps its own TTL as the backstop.
 *
 * ── The caches ──────────────────────────────────────────────────────────────
 * | Cache                   | Key           | Held by | Published by |
 * |-------------------------|---------------|---------|--------------|
 * | `agency-campaign-stats` | a campaign id | the stats route (`campaign-stats-reads.ts`) | `POST /sessions/:id/force-available`, the roster ingest once a roster is complete |
 *
 * A name not listed decodes to null and is dropped, as an unknown IPC type is.
 */
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'cache-invalidation' });

/** Every cache this channel may name. Add a cache here, and to the table above. */
export const CACHE_INVALIDATION_NAMES = ['agency-campaign-stats'] as const;
export type CacheInvalidationName = (typeof CACHE_INVALIDATION_NAMES)[number];

export interface CacheInvalidation {
  cache: CacheInvalidationName;
  key: string;
}

type Handler = (key: string) => void;

const isKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const isName = (v: unknown): v is CacheInvalidationName =>
  typeof v === 'string' && (CACHE_INVALIDATION_NAMES as readonly string[]).includes(v);

/** Decode one event from the wire, or null for anything malformed or a cache not listed. */
export function parseCacheInvalidation(raw: unknown): CacheInvalidation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  return isName(e['cache']) && isKey(e['key']) ? { cache: e['cache'], key: e['key'] } : null;
}

const listeners = new Map<CacheInvalidationName, Set<Handler>>();
let forwarder: ((event: CacheInvalidation) => void) | null = null;

/**
 * Listen for one cache's invalidations in this process (a worker's are forwarded here when this is
 * the primary). Returns the unsubscribe.
 */
export function onCacheInvalidation(cache: CacheInvalidationName, handler: Handler): () => void {
  let set = listeners.get(cache);
  if (!set) {
    set = new Set();
    listeners.set(cache, set);
  }
  set.add(handler);
  return () => { listeners.get(cache)?.delete(handler); };
}

/**
 * This process's listeners only, each in turn: one that throws is logged and the rest still run.
 * The primary's relay of a worker's event calls this, so an event never goes back the way it came.
 */
export function deliverCacheInvalidation(event: CacheInvalidation): void {
  for (const handler of [...(listeners.get(event.cache) ?? [])]) {
    try {
      handler(event.key);
    } catch (err) {
      log.error({ err, cache: event.cache }, 'Cache invalidation handler threw');
    }
  }
}

/**
 * Publish from a write path: this process's listeners, then the primary's when this is a media
 * worker. Total: a fault is logged and swallowed, because the write has already happened and the
 * cache's TTL covers a lost event.
 */
export function publishCacheInvalidation(event: CacheInvalidation): void {
  deliverCacheInvalidation(event);
  try {
    forwarder?.(event);
  } catch (err) {
    log.warn({ err, cache: event.cache }, 'Cache invalidation could not be forwarded — the cache falls back to its TTL');
  }
}

/** A media worker sends its publishes to the primary (`media-child.ts`); null stops it. */
export function setCacheInvalidationForwarder(next: ((event: CacheInvalidation) => void) | null): void {
  forwarder = next;
}

/** Listeners right now, for one cache (tests). */
export function cacheInvalidationListenerCount(cache: CacheInvalidationName): number {
  return listeners.get(cache)?.size ?? 0;
}
