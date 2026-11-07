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
import { counter, gauge, histogram, observableGauge } from '../metric-instruments.js';

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

// ── WebSocket send back-pressure ───────────────────────────────────────
// `socket` is `station` (an agent's station socket, written by the station registry and
// by the bridge's borrowed browser leg) or `carrier` (the carrier's media stream).
// `action` is `media_dropped` (a media frame past the soft backlog limit) or `closed` (a
// station socket closed 4408 `station_send_backlog` past the hard cap). Both closed sets,
// code-owned (`apps/server/src/utils/ws-backpressure.ts`). No session or call ids.
const websocketSendBackpressureTotal = counter<'socket' | 'action'>(meter, 'websocket_send_backpressure_total', {
  description: 'WebSocket frames dropped, and station sockets closed, because the peer stopped reading',
});

/** Record one back-pressure action. Guarded: it runs on the media relay's hot path. */
export function trackWebsocketSendBackpressure(socket: 'station' | 'carrier', action: 'media_dropped' | 'closed'): void {
  safeEmit('websocket-send-backpressure', () => websocketSendBackpressureTotal.inc({ socket, action }));
}

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

// ── Several processes on one host (docs/scaling.md §7) ────────────────────────
// Bounded label sets: `type` is an IPC message type from the protocol's fixed catalogue,
// `outcome` / `reason` / `result` / `role` are code-owned slugs.

const ipcRequestsTotal = counter<'type' | 'outcome'>(meter, 'ipc_requests_total', {
  description: 'IPC requests between the primary and its child processes, by request type and outcome (ok, timeout, gone, refused, error)',
});
const ipcRequestDurationSeconds = histogram<'type'>(meter, 'ipc_request_duration_seconds', {
  description: 'Round trip of an answered IPC request, by request type',
  unit: 's',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 15, 40],
});
const ipcMessagesDroppedTotal = counter<'reason'>(meter, 'ipc_messages_dropped_total', {
  description: 'IPC messages dropped or flagged on receipt: malformed, unsupported, late (answer after its deadline), backlogged (send past Node\'s backlog threshold, still delivered)',
});
const wsHandoffTotal = counter<'route' | 'result'>(meter, 'ws_handoff_total', {
  description: 'WebSocket upgrades the primary handed to a media worker, or refused instead, by route (station, pstn) and result',
});
const clusterChildExitsTotal = counter<'role' | 'expected'>(meter, 'cluster_child_exits_total', {
  description: 'Child process exits seen by the primary, by role (media, analysis) and whether the primary asked for it (a stop) or not (a crash)',
});

export function trackIpcRequest(type: string, outcome: 'ok' | 'timeout' | 'gone' | 'refused' | 'error', seconds?: number): void {
  safeEmit('ipc-request', () => {
    ipcRequestsTotal.inc({ type, outcome });
    if (seconds !== undefined) ipcRequestDurationSeconds.observe({ type }, seconds);
  });
}

export function trackIpcDropped(reason: 'malformed' | 'unsupported' | 'late' | 'backlogged'): void {
  safeEmit('ipc-dropped', () => ipcMessagesDroppedTotal.inc({ reason }));
}

export function trackWsHandoff(route: 'station' | 'pstn' | 'unknown', result: 'handed_off' | 'no_owner' | 'buffered' | 'not_sent' | 'unsupported'): void {
  safeEmit('ws-handoff', () => wsHandoffTotal.inc({ route, result }));
}

/**
 * Record a role's two exit series at zero, once its supervisor exists. A cumulative counter
 * series otherwise appears with its first crash as its first sample, and `increase()` over a
 * series with one sample is empty, so `agy-cluster-child-crash` would miss the first crash
 * of each role for the life of the primary. Exported from the first collection on.
 */
export function primeChildExits(role: 'media' | 'analysis'): void {
  safeEmit('child-exit', () => {
    clusterChildExitsTotal.inc({ role, expected: 'false' }, 0);
    clusterChildExitsTotal.inc({ role, expected: 'true' }, 0);
  });
}

export function trackChildExit(role: 'media' | 'analysis', expected: boolean): void {
  safeEmit('child-exit', () => clusterChildExitsTotal.inc({ role, expected: expected ? 'true' : 'false' }));
}

// ── Tenant carrier credentials (decisions B19–B20) ─────────────────────────────
// Written by the voice bootstrap's credential housekeeping (`apps/server/src/bootstrap/voice.ts`),
// which runs in the main process only: a keyring check and a sweep at boot, then hourly. No
// credential, tenant or key ids as labels: the logs name them; these say how many, and whether.

// Absent until the first keyring check has answered (no `initial`): a check that throws leaves
// the last value standing rather than reporting a healthy 0 it never read.
const telephonyCredentialMissingKeyIds = gauge(meter, 'telephony_credential_missing_key_ids', {
  description: 'Master key ids that stored carrier credential secrets are sealed under and the keyring (TELEPHONY_CREDENTIAL_KEYS) does not hold, at the last keyring check (0 = healthy)',
});
const telephonyCredentialSweepsTotal = counter<'result'>(meter, 'telephony_credential_sweeps_total', {
  description: 'Carrier credential sweeps (shred revoked credentials whose calls have ended, drop secret versions past the rotation grace), by result (ok, failed)',
});
const telephonyCredentialsShreddedTotal = counter(meter, 'telephony_credentials_shredded_total', {
  description: 'Revoked carrier credentials whose secrets a sweep shredded',
});

/** Publish one keyring check: how many stored key ids the keyring cannot open. */
export function trackTelephonyCredentialMissingKeyIds(count: number): void {
  safeEmit('telephony-credential-keyring', () => telephonyCredentialMissingKeyIds.set(count));
}

/**
 * Record both sweep result series at zero, once the housekeeping starts. A counter series
 * otherwise appears with its first failure as its first sample, which `increase()` cannot see.
 */
export function primeTelephonyCredentialSweeps(): void {
  safeEmit('telephony-credential-sweep', () => {
    telephonyCredentialSweepsTotal.inc({ result: 'ok' }, 0);
    telephonyCredentialSweepsTotal.inc({ result: 'failed' }, 0);
  });
}

/** Record one credential sweep: `ok` with how many credentials it shredded, or `failed`. */
export function trackTelephonyCredentialSweep(result: 'ok' | 'failed', shredded = 0): void {
  safeEmit('telephony-credential-sweep', () => {
    telephonyCredentialSweepsTotal.inc({ result });
    if (shredded > 0) telephonyCredentialsShreddedTotal.inc(shredded);
  });
}

// ── Carrier dial refusals ─────────────────────────────────────────────────────
// A dial the carrier adapter gave up on once its own pre-send checks had passed:
// `auth_rejected` (the carrier refused the credential, 401), `rate_limited` (the account's
// calls-per-second gate gave no slot in time, or the carrier answered 429), `outcome_unknown`
// (a timeout, or a 2xx with no readable call id: the call may be placed), `refused` (any other
// non-2xx). `provider` and `kind` are closed, code-owned sets; no tenant, credential or call ids.
const carrierDialRefusalsTotal = counter<'provider' | 'kind'>(meter, 'carrier_dial_refusals_total', {
  description: 'Carrier dials refused or left with an unknown outcome, by provider and kind (auth_rejected, rate_limited, outcome_unknown, refused)',
});

/** Record one carrier dial refusal. Guarded: it runs on the dial path. */
export function trackCarrierDialRefusal(
  provider: string,
  kind: 'auth_rejected' | 'rate_limited' | 'outcome_unknown' | 'refused',
): void {
  safeEmit('carrier-dial-refusal', () => carrierDialRefusalsTotal.inc({ provider, kind }));
}
