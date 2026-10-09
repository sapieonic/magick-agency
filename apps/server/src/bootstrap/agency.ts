import type Redis from 'ioredis';
import { logger } from '@magick-agency/observability';
import type { AppContext } from '../app-context.js';
import { AgencyRuntime } from '../agency/runtime.js';
import { ensureVoiceEngine } from './voice.js';
import { agencyIngestJobRepository } from '../agency/agency-ingest-job.repository.js';
import { startAgencyIngestReaper } from '../agency/agency-ingest.service.js';

/**
 * Lane B's background work, and the agency runtime's process-wide singleton (Phase 6).
 *
 * Core's wiring (`magic-voice-core/src/index.ts@4850d1d9`):
 *   - `:404`  `new AgencyRuntime(webrtcBridge, redis, config.redis.keyPrefix)`, constructed
 *     before the routes so `agencyRoutes(a, agencyRuntime)` can close over it;
 *   - `:977-981` `await agencyRuntime.start()` — the startup reaper runs BEFORE the pacing
 *     supervisor (`AgencyRuntime.start` does the ordering itself);
 *   - `:856` `agencyRuntime.stop()` on shutdown, BEFORE `webrtcBridge.gracefulShutdown()`.
 *
 * Like the voice engine (`bootstrap/voice.ts`), the runtime is created on first use by
 * {@link ensureAgencyRuntime}: `agencyPlugin` registers the station socket before
 * `startAgency` runs (`buildApp` then the bootstraps) and needs the runtime to hand it.
 * The bridge comes from lane C's {@link ensureVoiceEngine} — the same instance the voice
 * plugin and `startVoice` use.
 *
 * Also master's agency ingest reaper (`magick-master/src/index.ts:677,720,741-770`
 * @a1f0756a, lane B2's carry-forward): the immediate boot-time `reapStaleJobs()` plus the
 * periodic `startAgencyIngestReaper()`, whose handle is kept and cleared on shutdown.
 */

let runtime: AgencyRuntime | null = null;
/** The stop {@link startAgency} returned while it has not yet run; null otherwise. */
let activeStop: (() => Promise<void>) | null = null;

export function ensureAgencyRuntime(redis: Redis | null, keyPrefix: string): AgencyRuntime {
  if (runtime) return runtime;
  const { bridge } = ensureVoiceEngine(redis);
  runtime = new AgencyRuntime(bridge, redis, keyPrefix);
  return runtime;
}

/** The agency runtime, or null before `ensureAgencyRuntime` / `startAgency`. Phase 8's routes read it. */
export function getAgencyRuntime(): AgencyRuntime | null {
  return runtime;
}

/**
 * Tests only. Stops a runtime `startAgency` started and nobody stopped (its timers — the
 * pacing supervisor and ticks, the reaper, the ingest reaper — would otherwise outlive
 * the singleton and fire into the next file's torn-down pool), then forgets it.
 */
export async function resetAgencyRuntimeForTests(): Promise<void> {
  if (activeStop) await activeStop();
  runtime = null;
}

/**
 * Returns a stop function the process awaits on shutdown.
 */
export async function startAgency(ctx: AppContext): Promise<() => Promise<void>> {
  const agencyRuntime = ensureAgencyRuntime(ctx.redis, ctx.config.redis.keyPrefix);

  // master `src/index.ts:741-770`: fail every agency ingest actually orphaned by a restart,
  // BEFORE accepting new ones — plus keep sweeping for the same thing periodically. The
  // two are complementary: the boot reap catches jobs orphaned by a PRIOR outage, the
  // interval catches jobs orphaned AFTER this process booted. Non-fatal: a reaper that
  // cannot run is not a reason to refuse to boot.
  let agencyIngestReapInterval: ReturnType<typeof setInterval> | null = null;
  try {
    const reaped = await agencyIngestJobRepository.reapStaleJobs();
    if (reaped > 0) logger.warn({ reaped }, 'Failed agency ingest jobs orphaned by a restart');
  } catch (err) {
    logger.error({ err }, 'Could not reap stale agency ingest jobs');
  }
  agencyIngestReapInterval = startAgencyIngestReaper();

  // core `src/index.ts:977-981`: the startup reaper runs BEFORE the pacing supervisor
  // (§6.2). A crash leaves attempts non-terminal and contacts `in_flight`, and those count
  // against the tick's occupancy — a supervisor started first would compute a fabricated
  // occupancy from dead rows and quietly dial nothing forever.
  await agencyRuntime.start();

  const stop = async (): Promise<void> => {
    if (activeStop === stop) activeStop = null;
    // master `src/index.ts:720`.
    if (agencyIngestReapInterval) clearInterval(agencyIngestReapInterval);
    // core `src/index.ts:856`: stops pacing first, then the reaper, sweeps, dialer and
    // wrap-up timers. Agents are NOT returned to the pool (D2: they rehydrate into
    // `break`).
    await agencyRuntime.stop();
  };
  activeStop = stop;
  return stop;
}
