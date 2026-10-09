import type { TelephonyAdmissionResult } from './provider-concurrency-guard.js';

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
    // Forwarded with exactly these five arguments (arity included — tests pin it).
    return owner.tryAcquireTelephonyConcurrency(callId, tenantId, accountId, provider, ttlSecondsOverride);
  }

  // Compatibility for test doubles. The production `TelephonyGuardHost` always
  // provides the atomic provider-mode method above.
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
