import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { redisCache } from '../cache/redis-cache.js';
import { createChildLogger } from '@magick-agency/observability';
import type { TenantRecord } from '@magick-agency/db/models/tenant.model';
import type { AccountRecord } from '@magick-agency/db/models/account.model';

const log = createChildLogger({ component: 'tenant-name-resolver' });

// Full tenant/account records (name + settings) change only on admin edits, and
// every in-app write path invalidates the cache below. This record backs the
// allowed-services *enforcement* decision (which pipelines/providers a tenant
// may use), so the TTL is deliberately short: it bounds the worst-case staleness
// window for a restriction that slips past invalidation (a swallowed Redis del
// or the cache-aside read/write race) to a few minutes rather than half an hour.
const RECORD_CACHE_TTL = 5 * 60; // 5 minutes

const tenantRecordKey = (id: string): string => `cache:tenant:full:${id}`;
const accountRecordKey = (id: string): string => `cache:account:full:${id}`;

export interface TenantAccountNames {
  tenantName?: string;
  accountName?: string;
}

/**
 * Load a full tenant record (incl. `settings`), Redis-cached. This is the hot
 * path read behind allowed-services enforcement on every proxy write request
 * (calls/ivr/announcements/browser-call/metadata) and behind name resolution
 * below — one cached read now serves both, instead of two uncached DB hits.
 *
 * Cache-aside with fail-open reads (a Redis error falls through to the DB) and
 * never caches a miss: returns the record or `null`, like
 * `tenantRepository.findById`.
 *
 * CAVEAT: on a cache *hit* the value is a JSON round-trip, so `Date` columns
 * (`created_at`/`updated_at`) come back as ISO strings rather than `Date`
 * objects. Hot-path callers only read `.settings`/`.name`, so this is safe today
 * (and mirrors the existing `cache:user:*` record cache) — but a caller that
 * needs typed `Date` fields must load from the repository, not from here.
 *
 * NOTE: intended for read-heavy hot paths that tolerate up to `RECORD_CACHE_TTL`
 * of staleness. Admin flows that must read-after-write (e.g. super-admin editing
 * settings then re-reading) should keep calling the repository directly.
 */
export async function getCachedTenantRecord(id: string): Promise<TenantRecord | null> {
  const cached = await redisCache.get<TenantRecord>(tenantRecordKey(id));
  if (cached !== null) return cached;
  const record = await tenantRepository.findById(id);
  if (record) await redisCache.set(tenantRecordKey(id), record, RECORD_CACHE_TTL);
  return record;
}

/** Account counterpart of {@link getCachedTenantRecord}. */
export async function getCachedAccountRecord(id: string): Promise<AccountRecord | null> {
  const cached = await redisCache.get<AccountRecord>(accountRecordKey(id));
  if (cached !== null) return cached;
  const record = await accountRepository.findById(id);
  if (record) await redisCache.set(accountRecordKey(id), record, RECORD_CACHE_TTL);
  return record;
}

/**
 * Invalidate the cached tenant record after any write to the tenants table
 * (settings/name/status update, soft-delete). Also clears the legacy name-only
 * key so a rename can't linger there. Every tenant write path must call this.
 */
export async function invalidateTenantRecordCache(id: string): Promise<void> {
  await redisCache.del(tenantRecordKey(id), `cache:tenant-name:${id}`);
}

/** Account counterpart of {@link invalidateTenantRecordCache}. */
export async function invalidateAccountRecordCache(id: string): Promise<void> {
  await redisCache.del(accountRecordKey(id), `cache:account-name:${id}`);
}

/**
 * Resolve the display names for a tenant and (optionally) an account. The names
 * are used to (a) stamp `x-mgkvc-tenant-name` / `x-mgkvc-account-name` headers on
 * outbound core requests and (b) register PostHog group properties — both so the
 * tenant/account can be attributed/filtered by human-readable name rather than id.
 *
 * Best-effort and cached: a cache/DB error or unknown id simply omits that
 * name. It must never throw — it only decorates a request that succeeds on its
 * own merits.
 */
export async function resolveTenantAccountNames(
  tenantId: string,
  accountId?: string | null,
): Promise<TenantAccountNames> {
  // Resolve both names concurrently — this runs on the request hot path, so the
  // tenant and account lookups (each a Redis GET, plus a DB read on cache miss)
  // should not be serialized.
  const [tenantName, accountName] = await Promise.all([
    resolveName('tenant', tenantId, getCachedTenantRecord),
    accountId
      ? /**
         * The account's name is used ONLY if the account is actually in this
         * tenant.
         *
         * The tenant-context middleware now refuses a foreign `X-Account-Id`
         * before any route runs, so on the HTTP path this is a second lock rather
         * than the first. It is here anyway because this function has other
         * callers — the scheduler, recurring schedules and the bulk-dispatch
         * consumer all resolve names for a (tenant, account) pair they read from
         * their own rows — and because of what the resolved name is used FOR:
         * it is forwarded to core as `x-mgkvc-account-name` and registered as a
         * PostHog group property, so one mismatched pair attributes one tenant's
         * calls and events to another tenant's account, permanently and silently.
         *
         * Returning `undefined` rather than throwing keeps the contract on the
         * docstring above: this decorates a request, it never fails one. A missing
         * name header is already a supported outcome; a wrong one is not.
         */
        resolveName('account', accountId, async (id) => {
          const record = await getCachedAccountRecord(id);
          return record && record.tenant_id === tenantId ? record : null;
        })
      : Promise.resolve(undefined),
  ]);

  const result: TenantAccountNames = {};
  if (tenantName !== undefined) result.tenantName = tenantName;
  if (accountName !== undefined) result.accountName = accountName;

  // PORT NOTE (magick-agency): master registered the names as PostHog group
  // properties here (`identifyGroups`). Agency has no product-analytics module
  // (no PostHog in the shared infrastructure), so the call is removed; the names
  // still decorate the request and its log context.

  return result;
}

/**
 * Resolve one name from its cached full record. Best-effort: a cache/DB error is
 * swallowed and returns `undefined` so it can never fail the request being
 * decorated. The record load is itself Redis-cached, so this shares the same
 * cache entry the proxy hot path uses for settings.
 */
async function resolveName(
  kind: 'tenant' | 'account',
  id: string,
  load: (id: string) => Promise<{ name: string } | null>,
): Promise<string | undefined> {
  try {
    const record = await load(id);
    return record?.name;
  } catch (err) {
    log.warn({ err, kind, id }, 'Failed to resolve tenant/account name');
    return undefined;
  }
}
