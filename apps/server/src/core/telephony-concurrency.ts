import type { TelephonyAdmissionResult } from './provider-concurrency-guard.js';
// PORT NOTE (magick-agency): ported from core src/core/telephony-concurrency.ts@4850d1d9.
// Changed: the per-broadcast group-concurrency gate is stripped (agency has no
// per-broadcast bulk concurrency). Deleted: `TelephonyGroupAdmission`, the `group`
// parameter of `tryAcquireTelephonyConcurrency`/`acquireTelephonyConcurrency`, the
// `group_full` refusal on the compatibility path, the "forwarded only when there is
// one" branch, `isCapacityRefusal`, `isGroupParkRefusal`, `GroupGateAdmitter`,
// `rollbackGate`, `admitThroughGroupGate`, and the `GroupAcquireRequest`/
// `GroupAdmission` import. In core `isCapacityRefusal` was called only by the
// GroupRefiller and (via `isGroupParkRefusal`) by grouped-row branches of the SQS
// queue coordinator, bulk/static services and IVR routes. With no group the forward
// is core's existing ungrouped call, so its arity is unchanged. Everything else is
// verbatim (this is the pre-gate shape, core d1179938^).

/** Structural contract kept deliberately small so background services and test
 * doubles can share the production admission entry point during rolling deploys. */
export interface TelephonyConcurrencyOwner {
  tryAcquireTelephonyConcurrency?: (
    callId: string,
    tenantId: string,
    accountId: string,
    provider: string,
    ttlSecondsOverride?: number,
  ) => Promise<TelephonyAdmissionResult>;
  concurrencyGuard: {
    tryAcquire(callId: string, ttlSecondsOverride?: number): Promise<boolean>;
    release(callId: string): Promise<void>;
  };
  accountConcurrencyGuard: {
    tryAcquire(callId: string, tenantId: string, accountId: string, ttlSecondsOverride?: number): Promise<boolean>;
    release(callId: string, tenantId: string, accountId: string): Promise<void>;
  };
  providerConcurrencyGuard?: {
    tryAcquire(callId: string, tenantId: string, accountId: string, provider: string, ttlSecondsOverride?: number): Promise<{
      result: 'acquired' | 'provider_full' | 'provider_unallocated' | 'redis_unavailable' | 'allocation_unavailable';
      providerScoped: boolean;
      newlyAcquired?: boolean;
    }>;
  };
}

export async function acquireTelephonyConcurrency(
  owner: TelephonyConcurrencyOwner,
  callId: string,
  tenantId: string,
  accountId: string,
  provider: string,
  ttlSecondsOverride?: number,
): Promise<TelephonyAdmissionResult> {
  if (typeof owner.tryAcquireTelephonyConcurrency === 'function') {
    // An ungrouped call makes exactly the call it always made (arity included —
    // tests pin it).
    return owner.tryAcquireTelephonyConcurrency(callId, tenantId, accountId, provider, ttlSecondsOverride);
  }

  // Compatibility for older embedders/test doubles. Production CallManager
  // always provides the atomic provider-mode method above.
  const globalAcquired = ttlSecondsOverride === undefined
    ? await owner.concurrencyGuard.tryAcquire(callId)
    : await owner.concurrencyGuard.tryAcquire(callId, ttlSecondsOverride);
  if (!globalAcquired) {
    return { result: 'global_full', providerScoped: false };
  }
  try {
    const accountAcquired = ttlSecondsOverride === undefined
      ? await owner.accountConcurrencyGuard.tryAcquire(callId, tenantId, accountId)
      : await owner.accountConcurrencyGuard.tryAcquire(callId, tenantId, accountId, ttlSecondsOverride);
    if (!accountAcquired) {
      await owner.concurrencyGuard.release(callId);
      return { result: 'account_full', providerScoped: false };
    }
    const providerAdmission = owner.providerConcurrencyGuard
      ? ttlSecondsOverride === undefined
        ? await owner.providerConcurrencyGuard.tryAcquire(callId, tenantId, accountId, provider)
        : await owner.providerConcurrencyGuard.tryAcquire(callId, tenantId, accountId, provider, ttlSecondsOverride)
      : { result: 'acquired' as const, providerScoped: false, newlyAcquired: true };
    if (providerAdmission.result !== 'acquired') {
      await Promise.allSettled([
        owner.accountConcurrencyGuard.release(callId, tenantId, accountId),
        owner.concurrencyGuard.release(callId),
      ]);
      switch (providerAdmission.result) {
        case 'provider_full':
          return { result: 'provider_full', providerScoped: true };
        case 'provider_unallocated':
        case 'redis_unavailable':
        case 'allocation_unavailable':
          return { result: providerAdmission.result, providerScoped: true };
      }
    }
    return {
      result: 'acquired',
      providerScoped: providerAdmission.providerScoped,
      newlyAcquired: providerAdmission.newlyAcquired ?? true,
    };
  } catch (err) {
    await Promise.allSettled([
      owner.accountConcurrencyGuard.release(callId, tenantId, accountId),
      owner.concurrencyGuard.release(callId),
    ]);
    throw err;
  }
}
