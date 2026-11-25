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
    credentialId?: string | null,
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
    /** Hands a provider lease back when a later scope refuses (the credential's, CR13). */
    release?(callId: string, tenantId: string, accountId: string, provider: string): Promise<void>;
  };
  /** A tenant carrier account's own cap (CR13). Absent: no credential scope is taken. */
  credentialConcurrencyGuard?: {
    resolveCap(credentialId: string): Promise<number | null>;
    tryAcquire(
      callId: string, credentialId: string, cap: number, provider: string, ttlSecondsOverride?: number,
    ): Promise<'acquired' | 'already_owned' | 'credential_full' | 'redis_unavailable'>;
  };
}

/**
 * Take every telephony scope for one call, or none. `credentialId` names the tenant carrier
 * account the call is placed on (null or absent: the service's own account), whose cap of its
 * own, when it has one, is a further scope (CR13).
 */
export async function acquireTelephonyConcurrency(
  owner: TelephonyConcurrencyOwner,
  callId: string,
  tenantId: string,
  accountId: string,
  provider: string,
  ttlSecondsOverride?: number,
  credentialId?: string | null,
): Promise<TelephonyAdmissionResult> {
  if (typeof owner.tryAcquireTelephonyConcurrency === 'function') {
    // Forwarded with exactly these five arguments (arity included — tests pin it), and the
    // credential as a sixth only when the call is on a tenant carrier account.
    return credentialId
      ? owner.tryAcquireTelephonyConcurrency(callId, tenantId, accountId, provider, ttlSecondsOverride, credentialId)
      : owner.tryAcquireTelephonyConcurrency(callId, tenantId, accountId, provider, ttlSecondsOverride);
  }

  // Compatibility for test doubles. The production `TelephonyGuardHost` always
  // provides the atomic provider-mode method above. The credential's cap is read before
  // anything is taken, so an unreadable cap holds nothing (fail closed).
  let credentialCap: number | null = null;
  if (credentialId && owner.credentialConcurrencyGuard) {
    try {
      credentialCap = await owner.credentialConcurrencyGuard.resolveCap(credentialId);
    } catch {
      return { result: 'allocation_unavailable', providerScoped: true };
    }
  }
  const globalAcquired = ttlSecondsOverride === undefined
    ? await owner.concurrencyGuard.tryAcquire(callId)
    : await owner.concurrencyGuard.tryAcquire(callId, ttlSecondsOverride);
  if (!globalAcquired) {
    return { result: 'global_full', providerScoped: false };
  }
  let providerTaken = false;
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
          return { result: 'provider_unallocated', providerScoped: true };
        case 'redis_unavailable':
        case 'allocation_unavailable':
          return { result: providerAdmission.result, providerScoped: true };
      }
    }
    providerTaken = providerAdmission.providerScoped;
    if (credentialId && credentialCap !== null && owner.credentialConcurrencyGuard) {
      const taken = ttlSecondsOverride === undefined
        ? await owner.credentialConcurrencyGuard.tryAcquire(callId, credentialId, credentialCap, provider)
        : await owner.credentialConcurrencyGuard.tryAcquire(callId, credentialId, credentialCap, provider, ttlSecondsOverride);
      if (taken === 'credential_full' || taken === 'redis_unavailable') {
        await Promise.allSettled([
          ...(providerTaken && owner.providerConcurrencyGuard?.release
            ? [owner.providerConcurrencyGuard.release(callId, tenantId, accountId, provider)]
            : []),
          owner.accountConcurrencyGuard.release(callId, tenantId, accountId),
          owner.concurrencyGuard.release(callId),
        ]);
        return { result: taken, providerScoped: providerAdmission.providerScoped };
      }
    }
    return {
      result: 'acquired',
      providerScoped: providerAdmission.providerScoped,
      newlyAcquired: providerAdmission.newlyAcquired ?? true,
    };
  } catch (err) {
    await Promise.allSettled([
      ...(providerTaken && owner.providerConcurrencyGuard?.release
        ? [owner.providerConcurrencyGuard.release(callId, tenantId, accountId, provider)]
        : []),
      owner.accountConcurrencyGuard.release(callId, tenantId, accountId),
      owner.concurrencyGuard.release(callId),
    ]);
    throw err;
  }
}
