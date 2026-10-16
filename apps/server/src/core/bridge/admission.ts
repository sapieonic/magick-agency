/**
 * Admission for one bridge call: take the shared concurrency slots (global,
 * account, provider) through the guard host, or refuse with the
 * {@link WebRtcCallError} whose code and HTTP status the caller surfaces. Split out
 * of `WebRtcBridgeManager.placeOutboundLeg`. No metrics are imported here; a
 * refusal is reported to product analytics, as before.
 */
import { acquireTelephonyConcurrency } from '../telephony-concurrency.js';
import type { TelephonyGuardHost } from '../telephony-guard-host.js';
import { trackWebrtcCallRejected } from '../../analytics/posthog.js';
import { WebRtcCallError } from './bridge-types.js';

/**
 * Acquire every scope's slot under `concurrencyKey` (held for `slotTtlSeconds`), or
 * throw. Resolves only when the call is admitted.
 */
export async function admitBridgeCall(
  guardHost: TelephonyGuardHost,
  call: { concurrencyKey: string; tenantId: string; accountId: string; provider: string; slotTtlSeconds: number },
): Promise<void> {
  const { concurrencyKey, tenantId, accountId, provider, slotTtlSeconds } = call;
  const admission = await acquireTelephonyConcurrency(guardHost,
    concurrencyKey, tenantId, accountId, provider, slotTtlSeconds,
  );
  if (admission.result === 'global_full') {
    trackWebrtcCallRejected({ tenantId, accountId, reason: 'global_concurrency_limit', provider });
    throw new WebRtcCallError('Global concurrency limit reached', 'global_concurrency_limit', 429);
  }
  if (admission.result === 'account_full') {
    trackWebrtcCallRejected({ tenantId, accountId, reason: 'account_concurrency_limit', provider });
    throw new WebRtcCallError('Account concurrency limit reached', 'account_concurrency_limit', 429);
  }
  if (admission.result !== 'acquired') {
    const unavailable = admission.result === 'redis_unavailable' || admission.result === 'allocation_unavailable';
    const unallocated = admission.result === 'provider_unallocated';
    trackWebrtcCallRejected({
      tenantId,
      accountId,
      reason: unavailable ? 'provider_concurrency_unavailable' : 'provider_concurrency_limit',
      provider,
    });
    throw new WebRtcCallError(
      unavailable
        ? 'Provider concurrency admission is temporarily unavailable'
        : unallocated
          ? `No concurrency is allocated to telephony provider '${provider}'`
          : `Concurrency limit reached for telephony provider '${provider}'`,
      unavailable ? 'provider_concurrency_unavailable' : 'provider_concurrency_limit',
      unavailable ? 503 : unallocated ? 422 : 429,
    );
  }
}
