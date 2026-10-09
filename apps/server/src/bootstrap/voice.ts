import type Redis from 'ioredis';
import { logger } from '@magick-agency/observability';
import {
  setDecodeGateStatsProvider,
  trackTelephonyLeaseRelease,
  trackTtsClipCacheSweep,
} from '@magick-agency/observability/metrics/voice';
import type { AppContext } from '../app-context.js';
import { TelephonyGuardHost } from '../core/telephony-guard-host.js';
import { WebRtcBridgeManager } from '../core/webrtc-bridge-manager.js';
import { createConcurrencyControl } from '../core/voice-concurrency-control.js';
import { setTelephonyReleaseObserver } from '../core/telephony-release.js';
import { setConcurrencyControl } from '../seams/concurrency-control.js';
import { initS3Client } from '../storage/s3.js';
import { initTtsFileCache, sweepTtsCache, setTtsCacheSweepObserver } from '../tts/tts-file-cache.js';
import { reapDecodeScratchDirs } from '../audio/decode.js';
import { getDecodeGateStats } from '../utils/decode-gate.js';
import { shutdownAnalytics } from '../analytics/posthog.js';

/**
 * Lane C's background work and the voice engine's process-wide singletons.
 *
 * The order and every step below are core's (`magic-voice-core/src/index.ts@4850d1d9`
 * :143-244, :353-354, :389-391, :857, :906), restricted to the voice engine:
 * S3 → clip cache (+ sweeper) → decode scratch reap → decode-gate gauges → PostHog →
 * lease-release metric seam → guard host + bridge → startup self-heal → arm the poll.
 *
 * The engine is created on first use by {@link ensureVoiceEngine}, because the HTTP
 * plugin registers before `startVoice` runs (`src/index.ts`: `buildApp` then the
 * bootstraps) and its routes need the bridge. Phase 6's agency runtime takes the bridge
 * from {@link getVoiceEngine} (core: `new AgencyRuntime(webrtcBridge, …)`).
 */
export interface VoiceEngine {
  guardHost: TelephonyGuardHost;
  bridge: WebRtcBridgeManager;
}

let engine: VoiceEngine | null = null;

export function ensureVoiceEngine(redis: Redis | null): VoiceEngine {
  if (engine) return engine;
  const guardHost = new TelephonyGuardHost(redis);
  const bridge = new WebRtcBridgeManager(guardHost, redis);
  // core index.ts:391 — the stale sweep must never fail a call this replica is bridging.
  guardHost.registerWebrtcActiveIdsProvider(() => bridge.getActiveCallIds());
  // docs/seams.md §3.3 — lane A's super-admin concurrency writes reach the guards here.
  setConcurrencyControl(createConcurrencyControl(guardHost));
  engine = { guardHost, bridge };
  return engine;
}

/** The running voice engine, or null before `ensureVoiceEngine` / `startVoice`. */
export function getVoiceEngine(): VoiceEngine | null {
  return engine;
}

/** Tests only. */
export function resetVoiceEngineForTests(): void {
  engine = null;
}

/**
 * Returns a stop function the process awaits on shutdown.
 */
export async function startVoice(ctx: AppContext): Promise<() => Promise<void>> {
  const { config } = ctx;

  // Initialize S3 client (optional — only if S3 config provided)
  if (config.s3) {
    initS3Client(config.s3);
    logger.info('S3 client initialized');
  }

  // Initialize TTS file cache directory
  initTtsFileCache();

  // PORT NOTE: core registered `setEvictableClipFilter(staticCallRepository
  // .filterDeletableTtsHashes)` here — the reference-count guard keyed on static
  // calls. Agency has no static calls; abandon clips are re-materialised by
  // `ensurePcmClip` from the uploaded file when missing, so the sweeper runs
  // unguarded (its documented behaviour with no filter registered).
  setTtsCacheSweepObserver(trackTtsClipCacheSweep);

  const sweepTts = (): Promise<void> =>
    sweepTtsCache({
      maxAgeMs: config.staticCallTts.cacheTtlMs,
      maxBytes: config.staticCallTts.cacheMaxBytes,
    }).then(
      () => undefined,
      (err: unknown) => {
        // Belt-and-braces: sweepTtsCache is contractually infallible.
        logger.warn({ err }, 'TTS cache sweep failed');
      },
    );
  const startupSweep = sweepTts();
  let ttsCacheSweepTimer: NodeJS.Timeout | null = null;
  if (config.staticCallTts.cacheSweepIntervalMs > 0) {
    ttsCacheSweepTimer = setInterval(() => void sweepTts(), config.staticCallTts.cacheSweepIntervalMs);
    ttsCacheSweepTimer.unref();
  }

  // Reap audio-decode scratch dirs orphaned by a crash mid-decode. Fire-and-forget.
  void reapDecodeScratchDirs().catch((err) => {
    logger.warn({ err }, 'Audio decode scratch reap failed');
  });

  // Expose decode-gate occupancy on the metrics surface.
  setDecodeGateStatsProvider(getDecodeGateStats);

  // PostHog is initialised in `index.ts`, before `app.listen` (Phase 8 hoist: core initialised
  // it before listening). Shutdown stays here, in this lane's stop function.

  // core index.ts:310 — `telephony_lease_release_total` through the release seam.
  setTelephonyReleaseObserver(trackTelephonyLeaseRelease);

  const { guardHost, bridge } = ensureVoiceEngine(ctx.redis);

  // Settle the startup clip sweep before admitting work (core awaited it before
  // `drainQueue()`; here the first dial is the next thing that can read a clip).
  await startupSweep;

  // Self-heal first: reconcile concurrency counters drifted by any prior crash
  // and fail calls left dangling in a non-terminal state, so we boot with an
  // accurate capacity picture before admitting new work. Then arm the demand-
  // driven self-heal poll (disarms itself when idle, re-arms on call activity).
  await guardHost.runSelfHealSweep('startup');
  guardHost.wakeSelfHeal();

  return async () => {
    if (ttsCacheSweepTimer) clearInterval(ttsCacheSweepTimer);
    // End active WebRTC bridge calls (hang up carrier leg, release slots) before
    // tearing down shared infra — they live in their own session map.
    await bridge.gracefulShutdown().catch((err) => logger.error({ err }, 'webrtc-bridge shutdown failed'));
    await guardHost.gracefulShutdown().catch((err) => logger.error({ err }, 'guard host shutdown failed'));
    await shutdownAnalytics().catch((err) => logger.error({ err }, 'analytics flush failed'));
  };
}
