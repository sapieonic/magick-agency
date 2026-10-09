/**
 * Metric declarations owned by the voice engine.
 *
 * Several `track*` parameters are typed `string` rather than with the unions
 * declared in the modules that call them (`TelephonyReleaseOutcome`,
 * `RateLimitRouteClass`, …), because this package cannot import the server; the closed sets are still
 * enforced at every call site, which passes the server's union. Label KEYS stay a compile-time contract via
 * the facade.
 */
import { createChildLogger } from '../logger.js';
import { meter } from '../meter.js';
import { counter, gauge, observableGauge } from '../metric-instruments.js';

// ── safeEmit (private to this file) ──────────────────────────────────────────
const safeEmitLog = createChildLogger({ component: 'safe-emit' });
const safeEmitLogged = new Set<string>();
/**
 * Runs an observability side effect so it can never fail the thing it observes.
 * Emission points sit on hot paths — call setup, teardown — where a throw from
 * the metrics layer would fail the real work. That is strictly worse than losing
 * a counter.
 */
function safeEmit(component: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (!safeEmitLogged.has(component)) {
      safeEmitLogged.add(component);
      safeEmitLog.error({ err, component }, 'Metric emission failed — continuing without it');
    }
  }
}

// ── Provider-mode telephony admissions ─────────────────────────────────
// Tenant/account ids are deliberately excluded: this counter is on the call hot
// path and those unbounded labels would create a series per customer.
const providerConcurrencyAdmissionTotal = counter<
  'provider' | 'result'
>(meter, 'provider_concurrency_admission_total', {
  description: 'Provider-mode telephony admissions by outcome',
});

/** Record one provider-mode admission outcome. */
export function trackProviderConcurrencyAdmission(provider: string, result: string): void {
  safeEmit('provider-concurrency-admission', () => providerConcurrencyAdmissionTotal.inc({ provider, result }));
}

// ── Provider counter reconciliation ────────────────────────────────────
const providerConcurrencyReconciliationTotal = counter<
  'result'
>(meter, 'provider_concurrency_reconciliation_total', {
  description: 'Provider counter reconciliation attempts by outcome',
});

/** Record one provider-counter reconciliation pass (`clean` | `repaired` | `failed`). */
export function trackProviderConcurrencyReconciliation(result: 'clean' | 'repaired' | 'failed'): void {
  safeEmit('provider-concurrency-reconciliation', () => providerConcurrencyReconciliationTotal.inc({ result }));
}

// ── Telephony concurrency lease release ────────────────────────────────
// `composite` is the healthy path; `partial`/`failure` mean a lease is parked
// until the self-heal sweep; `noop` arms the sweep but does not page. No
// tenant/account/call ids; `source` is a fixed, code-owned set of call sites.
const telephonyLeaseReleaseTotal = counter<'outcome' | 'source'>(meter, 'telephony_lease_release_total', {
  description: 'Telephony concurrency lease releases by outcome and teardown call site',
});

/**
 * Record one telephony lease release. Guarded: teardown must never throw
 * (`releaseTelephonyLease` promises it).
 */
export function trackTelephonyLeaseRelease(outcome: string, source: string): void {
  safeEmit('telephony-lease-release', () => telephonyLeaseReleaseTotal.inc({ outcome, source }));
}

// ── WebSocket connections ──────────────────────────────────────────────
// Counted per type, so connect/disconnect is a delta and the gauge reads the
// running total. The single entry point for both directions.
const _wsConnectionsByType = new Map<string, number>();
export function trackWebsocketConnection(type: string, delta: 1 | -1): void {
  _wsConnectionsByType.set(type, (_wsConnectionsByType.get(type) ?? 0) + delta);
}
observableGauge<'type'>(meter, 'websocket_connections_active', {
  description: 'Current active WebSocket connections',
}, (observe) => {
  for (const [type, count] of _wsConnectionsByType) observe(count, { type });
});

// ── Rate limiter rejections ────────────────────────────────────────────
// `bucket_kind` comes from the same `budgetFor()` that charged the bucket;
// `route_class` is a bounded, code-owned slug, never a URL (the 429'd routes
// carry `:callId` and a `?token=`).
const rateLimitRejectedTotal = counter<'bucket_kind' | 'route_class'>(meter, 'rate_limit_rejected_total', {
  description: 'Requests rejected with HTTP 429 by the rate limiter, by bucket kind and route class',
});

/**
 * Record one 429, from `@fastify/rate-limit`'s `onExceeded` hook. Guarded: the
 * plugin awaits it inside the request path, so a throw would serve a 500.
 */
export function trackRateLimitRejected(bucketKind: string, routeClass: string): void {
  safeEmit('rate-limit-rejected', () => rateLimitRejectedTotal.inc({ bucket_kind: bucketKind, route_class: routeClass }));
}

// ── Audio decode concurrency gate ─────────────────────────────────────
let _decodeGateStatsProvider: (() => { active: number; queued: number; limit: number }) | null = null;
/** Wired at startup from `decode-gate.ts`'s `getDecodeGateStats`. */
export function setDecodeGateStatsProvider(fn: () => { active: number; queued: number; limit: number }): void {
  _decodeGateStatsProvider = fn;
}

observableGauge(meter, 'audio_decode_gate_queued', {
  description: 'Audio decodes waiting for a permit',
}, (observe) => {
  if (_decodeGateStatsProvider) observe(_decodeGateStatsProvider().queued);
});
observableGauge(meter, 'audio_decode_gate_active', {
  description: 'Audio decodes currently holding a permit',
}, (observe) => {
  if (_decodeGateStatsProvider) observe(_decodeGateStatsProvider().active);
});
observableGauge(meter, 'audio_decode_gate_limit', {
  description: 'Configured audio decode concurrency limit (AUDIO_DECODE_CONCURRENCY)',
}, (observe) => {
  if (_decodeGateStatsProvider) observe(_decodeGateStatsProvider().limit);
});

// ── On-disk clip cache (the sweeper's view) ───────────────────────────
// All three are UNLABELLED: the cache is node-scoped.
const ttsClipCacheRetainedTotal = counter(meter, 'tts_clip_cache_retained_total', {
  description: 'Clips the liveness guard withheld from eviction',
});
const ttsClipCacheLivenessFailuresTotal = counter(meter, 'tts_clip_cache_liveness_failures_total', {
  description: 'Clip-liveness lookups that failed or timed out, skipping eviction for that sweep',
});
// Deliberately absent until a sweep has completed (no `initial`).
const ttsClipCacheBytes = gauge(meter, 'tts_clip_cache_bytes', {
  description: 'On-disk TTS/audio clip bytes after the most recent cache sweep',
});

/** Publish one completed sweep's measurements (wired through the cache's observer seam). */
export function trackTtsClipCacheSweep(stats: {
  cacheBytes: number;
  retained: number;
  livenessFailed: boolean;
}): void {
  ttsClipCacheBytes.set(stats.cacheBytes);
  if (stats.livenessFailed) safeEmit('tts-clip-cache-liveness', () => ttsClipCacheLivenessFailuresTotal.inc());
  if (stats.retained > 0) safeEmit('tts-clip-cache-retained', () => ttsClipCacheRetainedTotal.inc(stats.retained));
}
