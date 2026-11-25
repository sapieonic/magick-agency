/**
 * The account-limit half of the pacing invalidation bus.
 *
 * Every write of an account's concurrency allocation (the super-admin concurrency
 * routes, the per-account settings route) already ends by calling the
 * `ConcurrencyControl` seam's `invalidateAccountLimit` and, for a provider
 * breakdown, `invalidateProviderLimits`, after the write committed — that is how the
 * voice engine's guards drop their cached limit. The pacing engine caches the same
 * limit, so it hears about the change at the same point: `startAgency` wraps the
 * seam's implementation with {@link withPacingInvalidation}, and each invalidation
 * also publishes `account_limit_changed`. The seam's interface (a fixed file) does
 * not change, and a future limit writer that invalidates the guards — which it must
 * — invalidates pacing with it.
 *
 * A carrier account's own cap (CR13) is cached by pacing too (`pacing/dial-scopes.ts`): the
 * seam's `invalidateCredentialLimit`, which the super-admin credential routes call after a cap
 * write, also publishes `credential_limit_changed`, so the next tick reads the new cap with
 * admission rather than a TTL later.
 *
 * The event is published even when the guard invalidation throws: the database
 * write has happened either way, and a pacing cache must not outlive it because
 * Redis was down.
 */
import type { ConcurrencyControl } from '../../seams/concurrency-control.js';
import { publishPacingInvalidation, type PacingInvalidationEvent } from './invalidation-bus.js';

export function withPacingInvalidation(
  inner: ConcurrencyControl,
  publish: (event: PacingInvalidationEvent) => void = publishPacingInvalidation,
): ConcurrencyControl {
  const announce = (tenantId: string, accountId: string): void =>
    publish({ type: 'account_limit_changed', tenantId, accountId });
  return {
    async invalidateAccountLimit(tenantId, accountId) {
      try {
        await inner.invalidateAccountLimit(tenantId, accountId);
      } finally {
        announce(tenantId, accountId);
      }
    },
    async invalidateProviderLimits(tenantId, accountId) {
      try {
        await inner.invalidateProviderLimits(tenantId, accountId);
      } finally {
        announce(tenantId, accountId);
      }
    },
    getAccountProviderCounts: (tenantId, accountId) => inner.getAccountProviderCounts(tenantId, accountId),
    getProviderCount: (tenantId, accountId, provider) => inner.getProviderCount(tenantId, accountId, provider),
    getAccountCount: (tenantId, accountId) => inner.getAccountCount(tenantId, accountId),
    getDistributedAccountCount: (tenantId, accountId) => inner.getDistributedAccountCount(tenantId, accountId),
    async invalidateCredentialLimit(credentialId) {
      try {
        await inner.invalidateCredentialLimit(credentialId);
      } finally {
        publish({ type: 'credential_limit_changed', credentialId });
      }
    },
    getCredentialCounts: (credentialIds) => inner.getCredentialCounts(credentialIds),
  };
}
