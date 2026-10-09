// NEW FILE (magick-agency, lane C): the `ConcurrencyControl` seam implementation
// (docs/seams.md §3.3, `apps/server/src/seams/concurrency-control.ts`). In core, the
// super-admin concurrency routes (`internal.routes.ts`) called the guards directly
// through `callManager.accountConcurrencyGuard` / `callManager.providerConcurrencyGuard`;
// here those routes live in lane A, so each method is a one-line forward to the same
// guard method core called. No behaviour of its own.
import type { ConcurrencyControl } from '../seams/concurrency-control.js';
import type { TelephonyGuardHost } from './telephony-guard-host.js';

export function createConcurrencyControl(
  host: Pick<TelephonyGuardHost, 'accountConcurrencyGuard' | 'providerConcurrencyGuard'>,
): ConcurrencyControl {
  return {
    // core internal.routes.ts: `await callManager.accountConcurrencyGuard.invalidateLimit(t, a)`
    invalidateAccountLimit: (tenantId, accountId) =>
      host.accountConcurrencyGuard.invalidateLimit(tenantId, accountId),
    // core internal.routes.ts: `await callManager.providerConcurrencyGuard.invalidateLimits(t, a)`
    invalidateProviderLimits: (tenantId, accountId) =>
      host.providerConcurrencyGuard.invalidateLimits(tenantId, accountId),
    // core provider-concurrency-guard.ts:573
    getAccountProviderCounts: (tenantId, accountId) =>
      host.providerConcurrencyGuard.getAccountProviderCounts(tenantId, accountId),
    // core account-concurrency-guard.ts:231
    getAccountCount: (tenantId, accountId) =>
      host.accountConcurrencyGuard.getAccountCount(tenantId, accountId),
    // core account-concurrency-guard.ts:247
    getDistributedAccountCount: (tenantId, accountId) =>
      host.accountConcurrencyGuard.getDistributedAccountCount(tenantId, accountId),
  };
}
