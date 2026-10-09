/**
 * SEAM: platform / super-admin (lane A) → voice engine concurrency guard (lane C).
 * Lead-owned; lanes do not edit.
 *
 * In core, `PUT /internal/account-concurrency` (magic-voice-core/src/api/routes/
 * internal.routes.ts@4850d1d9 ~:340-450) wrote the allocation through
 * `providerConcurrencyRepository`, then invalidated three caches IN ORDER:
 *
 *   accountSettingsRepository.invalidate(t, a)
 *   await callManager.accountConcurrencyGuard.invalidateLimit(t, a)
 *   await callManager.providerConcurrencyGuard.invalidateLimits(t, a)
 *
 * and read live counts from the guards: `accountConcurrencyGuard` for the
 * utilization read and the provider-mode migration's drain check, and
 * `providerConcurrencyGuard` for per-provider live leases.
 * Here the super-admin route lives in lane A and the guards in lane C. The
 * repositories are shared (packages/db); the guard calls go through this seam.
 * `callManager.triggerDequeue()` has no counterpart: it drains core's AI-call
 * SQS queue, which agency does not have.
 *
 * Lane C registers the implementation at boot (`setConcurrencyControl`). The
 * default throws, so a super-admin write before lane C is wired fails loudly
 * instead of leaving a stale cross-replica limit cached in Redis.
 */

export type AccountProviderCounts =
  | { status: 'available'; counts: Map<string, number> }
  | { status: 'unavailable'; counts: Map<string, number> };

export interface ConcurrencyControl {
  /** core: `accountConcurrencyGuard.invalidateLimit(tenantId, accountId)` */
  invalidateAccountLimit(tenantId: string, accountId: string): Promise<void>;
  /** core: `providerConcurrencyGuard.invalidateLimits(tenantId, accountId)` */
  invalidateProviderLimits(tenantId: string, accountId: string): Promise<void>;
  /**
   * core: `providerConcurrencyGuard.getAccountProviderCounts(tenantId, accountId)`
   * (provider-concurrency-guard.ts:573) — live leases per provider. Same return
   * shape as core: `unavailable` is a Redis fault, never "zero calls".
   */
  getAccountProviderCounts(tenantId: string, accountId: string): Promise<AccountProviderCounts>;
  /**
   * core: `accountConcurrencyGuard.getAccountCount(tenantId, accountId)`
   * (account-concurrency-guard.ts:231) — the runtime accessor; falls back to a
   * process-local lease count when Redis is degraded. Core's
   * `GET /internal/account-concurrency/utilization` (internal.routes.ts:325-364)
   * reads `total.in_use` from it.
   */
  getAccountCount(tenantId: string, accountId: string): Promise<number>;
  /**
   * core: `accountConcurrencyGuard.getDistributedAccountCount(tenantId, accountId)`
   * (account-concurrency-guard.ts:247) — the control-plane read, which NEVER
   * substitutes a local value. Core's provider_breakdown migration drain check
   * (internal.routes.ts:384-404) reads this, not the provider guard.
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
