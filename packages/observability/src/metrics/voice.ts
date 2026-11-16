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
// by the bridge's borrowed browser leg), `carrier` (the carrier's media stream) or
// `listener` (a supervisor's listener socket, docs/listening.md). `action` is
// `media_dropped` (a media frame past the soft backlog limit) or `closed` (a station socket
// closed 4408 `station_send_backlog`, or a listener closed 4408 `send_backlog`, past the hard
// cap). Both closed sets, code-owned (`apps/server/src/utils/ws-backpressure.ts`). No session,
// call or listen ids.
const websocketSendBackpressureTotal = counter<'socket' | 'action'>(meter, 'websocket_send_backpressure_total', {
  description: 'WebSocket frames dropped, and station and listener sockets closed, because the peer stopped reading, by socket (station, carrier, listener) and action (media_dropped, closed)',
});

/** Record one back-pressure action. Guarded: it runs on the media relay's hot path. */
export function trackWebsocketSendBackpressure(socket: 'station' | 'carrier' | 'listener', action: 'media_dropped' | 'closed'): void {
  safeEmit('websocket-send-backpressure', () => websocketSendBackpressureTotal.inc({ socket, action }));
}

// ── Media relay dwell (docs/listening.md, LS8) ───────────────────────────
// How long one relayed frame spent in the bridge, from its arrival on one leg to the write to the
// other (the same span as each call's `maxRelayDwellMicros`, which logs only the worst). Sampled:
// one frame in {@link RELAY_DWELL_SAMPLE_EVERY} per call and direction, so the relay pays a counter
// increment per frame and a histogram record per second of a call. It is the guard that the
// listener tap, fed after the relay write, adds nothing to the agent's or the customer's audio:
// the `agy-listen-relay-dwell-regressed` rule reads its p99. `direction` is `b2p` (the agent's
// browser to the carrier: the agent's voice) or `p2b` (the carrier to the browser: the customer's).
const webrtcRelayDwellSeconds = histogram<'direction'>(meter, 'webrtc_relay_dwell_seconds', {
  description: 'Seconds one relayed media frame spent in the bridge, from its arrival to the write to the other leg, sampled one frame in 50 per call and direction, by direction (b2p: the agent to the customer, p2b: the customer to the agent)',
  unit: 's',
  buckets: [0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05],
});

/** One frame in this many, per call and direction, is recorded in `webrtc_relay_dwell_seconds`. */
export const RELAY_DWELL_SAMPLE_EVERY = 50;

/** Record one sampled frame's dwell. Guarded: it runs on the media relay's hot path. */
export function trackRelayDwell(direction: 'b2p' | 'p2b', seconds: number): void {
  safeEmit('relay-dwell', () => webrtcRelayDwellSeconds.observe({ direction }, Math.max(0, seconds)));
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
  description: 'WebSocket upgrades the primary handed to a media worker, or refused instead, by route (station, pstn, listen) and result',
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

/**
 * `route` is the upgraded socket: `station`, `pstn` (the carrier's media stream), `listen` (a
 * supervisor's listener socket, handed to the worker that owns the agent's session, as the
 * station is: docs/listening.md) or `unknown`.
 */
export function trackWsHandoff(route: 'station' | 'pstn' | 'listen' | 'unknown', result: 'handed_off' | 'no_owner' | 'buffered' | 'not_sent' | 'unsupported'): void {
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
// A dial the carrier adapter did not place: `not_sent` (refused before anything was sent:
// no webhook base, a callback URL off it, a malformed number, the API unreachable), `auth_rejected` (the carrier refused the credential, 401), `rate_limited` (the account's
// calls-per-second gate gave no slot in time, or the carrier answered 429), `outcome_unknown`
// (a timeout, a reset after the request may have been sent, or a 2xx with no readable call
// id: the call may be placed), `refused` (any other
// non-2xx). `provider` and `kind` are closed, code-owned sets; no tenant, credential or call ids.
const carrierDialRefusalsTotal = counter<'provider' | 'kind'>(meter, 'carrier_dial_refusals_total', {
  description: 'Carrier dials refused or left with an unknown outcome, by provider and kind (auth_rejected, rate_limited, outcome_unknown, refused, not_sent)',
});

/** Record one carrier dial refusal. Guarded: it runs on the dial path. */
export function trackCarrierDialRefusal(
  provider: string,
  kind: 'auth_rejected' | 'rate_limited' | 'outcome_unknown' | 'refused' | 'not_sent',
): void {
  safeEmit('carrier-dial-refusal', () => carrierDialRefusalsTotal.inc({ provider, kind }));
}

// ── Recordings a call did not ask for (RC1) ───────────────────────────────────
// A carrier delivered a recording URL for a call whose `recording_requested` is false (recording
// off for its campaign, soft phone, route or account), and the bridge discarded it: counted once
// per call. A rising count names a carrier recording on its own default (VoiceLink is never told
// whether to record). `provider` is a closed, code-owned set; no tenant, account or call ids (the
// warn log names the call).
const recordingDiscardedUnrequestedTotal = counter<'provider'>(meter, 'recording_discarded_unrequested_total', {
  description: 'Recordings a carrier delivered for a call that did not ask for one, discarded (once per call), by provider',
});

/** Record one discarded recording (once per call). Guarded: it runs on the call teardown path. */
export function trackRecordingDiscardedUnrequested(provider: string): void {
  safeEmit('recording-discarded-unrequested', () => recordingDiscardedUnrequestedTotal.inc({ provider }));
}

/** Why a recording fetch did not return the audio (RC3; `recording_fetch_failures_total`'s `reason`). */
export type RecordingFetchFailureReason =
  | 'access_refused' | 'access_error' | 'host_not_allowed' | 'redirect_refused' | 'too_many_redirects'
  | 'upstream_unauthorized' | 'upstream_not_found' | 'upstream_status' | 'timeout' | 'network';

// ── Recording fetch failures (RC3) ────────────────────────────────────────────
// A recording fetch that did not return the audio: the playback proxy (`surface="playback"`; the
// console reads every reason but `access_refused` as "We could not reach the service that stores
// this recording") or the analysis worker's fetch (`surface="analysis"`). `reason`:
// `access_refused` (the call's credential cannot serve recordings: a 404), `access_error`
// (resolving the access threw), `host_not_allowed` (the stored URL's host is off the carrier's
// recording hosts), `redirect_refused` (a redirect hop's host is off them; the log names the
// host, never the URL), `too_many_redirects`, `upstream_unauthorized` (401 or 403 from the
// carrier), `upstream_not_found` (404 or 410), `upstream_status` (any other non-2xx), `timeout`,
// `network`. `provider` is the call's carrier. No tenant, account or call ids.
const recordingFetchFailuresTotal = counter<'provider' | 'surface' | 'reason'>(meter, 'recording_fetch_failures_total', {
  description: 'Recording fetches that did not return the audio, by provider, surface (playback, analysis) and reason',
});

/** Record one failed recording fetch. Guarded: it runs on a request path. */
export function trackRecordingFetchFailure(
  provider: string,
  surface: 'playback' | 'analysis',
  reason: RecordingFetchFailureReason,
): void {
  safeEmit('recording-fetch-failure', () => recordingFetchFailuresTotal.inc({ provider, surface, reason }));
}
