/**
 * SEAM: platform / super-admin routes → the voice engine's concurrency guards
 * (decision B11: seams are fixed files).
 *
 * A super-admin allocation write goes through `providerConcurrencyRepository`, then
 * invalidates three caches IN ORDER:
 *
 *   accountSettingsRepository.invalidate(t, a)
 *   await getConcurrencyControl().invalidateAccountLimit(t, a)
 *   await getConcurrencyControl().invalidateProviderLimits(t, a)
 *
 * and reads live counts from the guards: the account guard for the utilization read and
 * the provider-mode migration's drain check, and the provider guard for per-provider live
 * leases. The repositories are shared (packages/db); the guard calls go through this seam.
 *
 * `bootstrap/voice.ts` registers the implementation at boot (`setConcurrencyControl`). The
 * default throws, so a super-admin write before the voice engine is wired fails loudly
 * instead of leaving a stale cross-replica limit cached in Redis.
 */

export type AccountProviderCounts =
  | { status: 'available'; counts: Map<string, number> }
  | { status: 'unavailable'; counts: Map<string, number> };

export interface ConcurrencyControl {
  /** `accountConcurrencyGuard.invalidateLimit(tenantId, accountId)` */
  invalidateAccountLimit(tenantId: string, accountId: string): Promise<void>;
  /** `providerConcurrencyGuard.invalidateLimits(tenantId, accountId)` */
  invalidateProviderLimits(tenantId: string, accountId: string): Promise<void>;
  /**
   * `providerConcurrencyGuard.getAccountProviderCounts(tenantId, accountId)` — live
   * leases per provider. `unavailable` is a Redis fault, never "zero calls".
   */
  getAccountProviderCounts(tenantId: string, accountId: string): Promise<AccountProviderCounts>;
  /**
   * `accountConcurrencyGuard.getAccountCount(tenantId, accountId)` — the runtime
   * accessor; falls back to a process-local lease count when Redis is degraded. The
   * utilization read takes `total.in_use` from it.
   */
  getAccountCount(tenantId: string, accountId: string): Promise<number>;
  /**
   * `accountConcurrencyGuard.getDistributedAccountCount(tenantId, accountId)` — the
   * control-plane read, which NEVER substitutes a local value. The provider-mode
   * migration's drain check reads this, not the provider guard.
   */
  getDistributedAccountCount(tenantId: string, accountId: string): Promise<DistributedAccountCount>;
}

export type DistributedAccountCount =
  | { status: 'available'; count: number }
  | { status: 'unavailable' };

const UNWIRED: ConcurrencyControl = {
  async invalidateAccountLimit() {
    throw new Error('ConcurrencyControl not wired: lane C must call setConcurrencyControl at boot');
  },
  async invalidateProviderLimits() {
    throw new Error('ConcurrencyControl not wired: lane C must call setConcurrencyControl at boot');
  },
  async getAccountProviderCounts() {
    throw new Error('ConcurrencyControl not wired: lane C must call setConcurrencyControl at boot');
  },
  async getAccountCount() {
    throw new Error('ConcurrencyControl not wired: lane C must call setConcurrencyControl at boot');
  },
  async getDistributedAccountCount() {
    throw new Error('ConcurrencyControl not wired: lane C must call setConcurrencyControl at boot');
  },
};

let control: ConcurrencyControl = UNWIRED;

export function setConcurrencyControl(next: ConcurrencyControl): void {
  control = next;
}

export function getConcurrencyControl(): ConcurrencyControl {
  return control;
}

/** Tests only. */
export function resetConcurrencyControl(): void {
  control = UNWIRED;
}
