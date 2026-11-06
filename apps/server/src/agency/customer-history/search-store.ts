/**
 * The customer-history search ids (`docs/customer-history.md` CH6). A search answers a
 * `search_id` (`chs_` + 32 hex); the timeline pages and the export name the search by it, so the
 * number never travels in a URL. Each id is bound to the tenant and the user that searched and
 * lives `searchTtlMinutes` (default 30). An unknown, expired or other user's id reads as missing:
 * the route answers `404 search_expired` for all three alike.
 *
 * Held in Redis under the configured key prefix (`<prefix>chs:<id>`) when the app has a context,
 * else in a bounded in-process map (the routing-only app the route-table tests build).
 *
 * The record holds the E.164 searched, never the raw text typed.
 */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { CustomerSearchBy } from '@magick-agency/contracts/api/agency/customer-history';

export interface CustomerSearchRecord {
  tenant_id: string;
  user_id: string;
  by: CustomerSearchBy;
  /** The E.164 searched. */
  value: string;
  display: string;
  expires_at: string;
}

export interface CustomerSearchStore {
  save(record: Omit<CustomerSearchRecord, 'expires_at'>): Promise<{ id: string; record: CustomerSearchRecord }>;
  /** The search, when it exists, has not expired and belongs to this tenant and user. */
  find(id: string, tenantId: string, userId: string): Promise<CustomerSearchRecord | null>;
}

export const SEARCH_ID_RE = /^chs_[0-9a-f]{32}$/;

export function newSearchId(): string {
  return `chs_${randomBytes(16).toString('hex')}`;
}

function owned(record: CustomerSearchRecord | null, tenantId: string, userId: string, nowMs: number): CustomerSearchRecord | null {
  if (!record || record.tenant_id !== tenantId || record.user_id !== userId) return null;
  return Date.parse(record.expires_at) > nowMs ? record : null;
}

function parseRecord(raw: string | null): CustomerSearchRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CustomerSearchRecord>;
    if (typeof v.tenant_id !== 'string' || typeof v.user_id !== 'string' || typeof v.value !== 'string'
      || typeof v.display !== 'string' || typeof v.expires_at !== 'string' || v.by !== 'phone') return null;
    return v as CustomerSearchRecord;
  } catch {
    return null;
  }
}

export function redisSearchStore(redis: Redis, keyPrefix: string, ttlMinutes: number, now: () => number = Date.now): CustomerSearchStore {
  const key = (id: string) => `${keyPrefix}chs:${id}`;
  return {
    async save(input) {
      const id = newSearchId();
      const record: CustomerSearchRecord = { ...input, expires_at: new Date(now() + ttlMinutes * 60_000).toISOString() };
      await redis.set(key(id), JSON.stringify(record), 'EX', ttlMinutes * 60);
      return { id, record };
    },
    async find(id, tenantId, userId) {
      if (!SEARCH_ID_RE.test(id)) return null;
      return owned(parseRecord(await redis.get(key(id))), tenantId, userId, now());
    },
  };
}

/** The most searches the in-process store keeps; the oldest goes first. */
const MEMORY_MAX = 1000;

export function memorySearchStore(ttlMinutes: number, now: () => number = Date.now): CustomerSearchStore {
  const map = new Map<string, CustomerSearchRecord>();
  return {
    async save(input) {
      const id = newSearchId();
      const record: CustomerSearchRecord = { ...input, expires_at: new Date(now() + ttlMinutes * 60_000).toISOString() };
      map.set(id, record);
      while (map.size > MEMORY_MAX) map.delete(map.keys().next().value as string);
      return { id, record };
    },
    async find(id, tenantId, userId) {
      if (!SEARCH_ID_RE.test(id)) return null;
      const record = map.get(id) ?? null;
      if (record && Date.parse(record.expires_at) <= now()) map.delete(id);
      return owned(record, tenantId, userId, now());
    },
  };
}
