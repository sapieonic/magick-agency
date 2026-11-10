import type Redis from 'ioredis';
import { logger } from '@magick-agency/observability';
import type { AppContext } from '../app-context.js';
import { AgencyRuntime, type AgencyRuntimeOptions } from '../agency/runtime.js';
import { ensureVoiceEngine } from './voice.js';
import { agencyIngestJobRepository } from '../agency/agency-ingest-job.repository.js';
import { startAgencyIngestReaper } from '../agency/agency-ingest.service.js';
import { getConcurrencyControl, setConcurrencyControl } from '../seams/concurrency-control.js';
import { withPacingInvalidation } from '../agency/pacing/limit-invalidation.js';
import { startInsightsRollupJob } from '../agency/insights-rollup-job.js';
import { startReportPipeline, type ReportPipeline } from '../agency/reports/pipeline.js';
import { startInboundCalls } from '../agency/inbound/start.js';
import { DncRegistry } from '../agency/dnc-registry.js';
import { FLAGS, getFeatureFlagService } from '../feature-flags/index.js';

/**
 * The agency background work, and the agency runtime's process-wide singleton.
 *
 * Ordering:
 *   - the runtime (`new AgencyRuntime(bridge, redis, keyPrefix)`) exists before the routes,
 *     so `agencyRoutes(a, agencyRuntime)` can close over it;
 *   - `await agencyRuntime.start()` — the startup reaper runs BEFORE the pacing supervisor
 *     (`AgencyRuntime.start` does the ordering itself);
 *   - `agencyRuntime.stop()` on shutdown, BEFORE the bridge's graceful shutdown (stops run
 *     in reverse start order, and voice starts before agency).
 *
 * Like the voice engine (`bootstrap/voice.ts`), the runtime is created on first use by
 * {@link ensureAgencyRuntime}: `agencyPlugin` registers the station socket before
 * `startAgency` runs (`buildApp` then the bootstraps) and needs the runtime to hand it.
 * The bridge comes from {@link ensureVoiceEngine} — the same instance the voice plugin and
 * `startVoice` use.
 *
 * Also the agency ingest reaper: the immediate boot-time `reapStaleJobs()` plus the
 * periodic `startAgencyIngestReaper()`, whose handle is kept and cleared on shutdown; and
 * the insights rollup job (`agency/insights-rollup-job.ts`, migration 0012), started after
 * the runtime (the startup reap settles attempts first, and those writes mark their buckets)
 * and stopped first; and the report pipeline (`agency/reports/pipeline.ts`: the assembler and the
 * reports tick, docs/reports.md RP10), started last. Its stop is bounded as a whole (20 s) and
 * overlaps the completion-notice drain wherever that runs: with media workers the shutdown plan
 * runs it among the concurrent drains ({@link getReportPipeline}, `index.ts`); in one process this
 * stop runs it beside the rollup job's and the runtime's (idempotent: the same promise). Both report loops start whatever the `agency_reports_enabled` flag says: the flag
 * gates requests.
 */

let runtime: AgencyRuntime | null = null;
let runtimeOptions: AgencyRuntimeOptions = {};

/**
 * How the runtime is assembled, set before it is first built: the primary of a
 * multi-process server installs its media-worker adapters here (`cluster/primary.ts`).
 * Unset (one process): the runtime is built as it always was.
 */
export function configureAgencyRuntime(options: AgencyRuntimeOptions): void {
  if (runtime) throw new Error('configureAgencyRuntime must run before the agency runtime is built');
  runtimeOptions = options;
}
/** The stop {@link startAgency} returned while it has not yet run; null otherwise. */
let activeStop: (() => Promise<void>) | null = null;
/** The report pipeline {@link startAgency} started, until its stop has run. */
let activeReports: ReportPipeline | null = null;

/**
 * The report pipeline, or null before `startAgency` and after its stop. The shutdown plan drains
 * it with the other drains (`index.ts`), so its bounded wait overlaps theirs.
 */
export function getReportPipeline(): ReportPipeline | null {
  return activeReports;
}

export function ensureAgencyRuntime(redis: Redis | null, keyPrefix: string): AgencyRuntime {
  if (runtime) return runtime;
  const { bridge } = ensureVoiceEngine(redis);
  runtime = new AgencyRuntime(bridge, redis, keyPrefix, runtimeOptions);
  return runtime;
}

/** The agency runtime, or null before `ensureAgencyRuntime` / `startAgency`. The agency routes read it. */
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
  runtimeOptions = {};
}

/**
 * Returns a stop function the process awaits on shutdown.
 */
export async function startAgency(ctx: AppContext): Promise<() => Promise<void>> {
  const agencyRuntime = ensureAgencyRuntime(ctx.redis, ctx.config.redis.keyPrefix);

  // Fail every agency ingest actually orphaned by a restart,
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

  // A concurrency-limit write invalidates the pacing engine's cached limit as well as
  // the guards' (`agency/pacing/limit-invalidation.ts`). Voice starts first and has
  // registered the seam's implementation; this wraps it, and the stop unwraps it.
  const undecorated = getConcurrencyControl();
  const decorated = withPacingInvalidation(undecorated);
  setConcurrencyControl(decorated);

  // The startup reaper runs BEFORE the pacing supervisor. A crash leaves attempts non-terminal and contacts `in_flight`, and those count
  // against the tick's occupancy — a supervisor started first would compute a fabricated
  // occupancy from dead rows and quietly dial nothing forever.
  await agencyRuntime.start();

  // Inbound calls (docs/inbound.md): the startup sweep ends calls a restart left open, then
  // the router takes the inbound answer and hangup webhooks (`seams/inbound-call-router.ts`).
  // Not gated on `agency_inbound_enabled`: a call on a linked number is always answered (§8.1).
  // P2 (docs/inbound.md §2): the connector puts waiting callers through to agents, gated on the
  // account's `agency_inbound_enabled` and on one process (IB8); the outcome-lapse sweep with it.
  const inbound = await startInboundCalls({
    bridge: ensureVoiceEngine(ctx.redis).bridge,
    dnc: new DncRegistry(),
    connect: {
      runtime: agencyRuntime,
      enabled: (tenantId, accountId) => getFeatureFlagService().isEnabled(FLAGS.agency_inbound_enabled, { tenantId, accountId }),
      mediaWorkers: ctx.config.processes.mediaWorkers,
    },
  });

  // Main process only (this bootstrap never runs in a worker), so once per deployment.
  const insightsRollup = startInsightsRollupJob(ctx.config.agency.insightsRollup);
  // Main process only, like the rollup job: one assembler and one tick per deployment.
  const reports = startReportPipeline(ctx.config);
  activeReports = reports;

  const stop = async (): Promise<void> => {
    if (activeStop === stop) activeStop = null;
    if (agencyIngestReapInterval) clearInterval(agencyIngestReapInterval);
    // First, synchronously: an arriving call now hears the fallback message rather than reaching
    // a stopping runtime. Its calls still held are then ended and settled (bounded) while the
    // runtime and the database are still up, before the runtime stops below.
    const inboundStopped = inbound.stop();
    // The report pipeline stops beside the rest (it needs none of it), so its bounded wait
    // overlaps the runtime's completion-notice drain, which in one process runs in
    // `agencyRuntime.stop()`. With media workers it already stopped as a shutdown drain
    // (`index.ts`), and this is the same, settled promise.
    const reportsStopped = reports.stop();
    const rest = (async () => {
      await inboundStopped;
      // The batch in flight commits or rolls back; marks left over are the next boot's.
      await insightsRollup.stop();
      // Stops pacing first, then the reaper, sweeps, dialer and wrap-up timers. Agents
      // are NOT returned to the pool: they rehydrate into `break`.
      await agencyRuntime.stop();
    })();
    await Promise.all([reportsStopped, rest]);
    if (activeReports === reports) activeReports = null;
    if (getConcurrencyControl() === decorated) setConcurrencyControl(undecorated);
  };
  activeStop = stop;
  return stop;
}
