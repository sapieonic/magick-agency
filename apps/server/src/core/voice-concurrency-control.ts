// The `ConcurrencyControl` seam implementation (docs/seams.md,
// `apps/server/src/seams/concurrency-control.ts`). The super-admin concurrency routes
// reach the voice engine's guards only through this seam, so each method is a one-line
// forward to the guard method of the same purpose. No behaviour of its own.
import type { ConcurrencyControl } from '../seams/concurrency-control.js';
import type { TelephonyGuardHost } from './telephony-guard-host.js';

export function createConcurrencyControl(
  host: Pick<TelephonyGuardHost, 'accountConcurrencyGuard' | 'providerConcurrencyGuard'>,
): ConcurrencyControl {
  return {
    invalidateAccountLimit: (tenantId, accountId) =>
      host.accountConcurrencyGuard.invalidateLimit(tenantId, accountId),
    invalidateProviderLimits: (tenantId, accountId) =>
      host.providerConcurrencyGuard.invalidateLimits(tenantId, accountId),
    getAccountProviderCounts: (tenantId, accountId) =>
      host.providerConcurrencyGuard.getAccountProviderCounts(tenantId, accountId),
    getAccountCount: (tenantId, accountId) =>
      host.accountConcurrencyGuard.getAccountCount(tenantId, accountId),
    getDistributedAccountCount: (tenantId, accountId) =>
      host.accountConcurrencyGuard.getDistributedAccountCount(tenantId, accountId),
  };
}
