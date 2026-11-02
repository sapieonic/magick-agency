/**
 * The primary process with media workers (`MEDIA_WORKERS > 0`, `docs/scaling.md`): what
 * `index.ts` does around its single-process start when workers are configured.
 *
 * Before `buildApp`: {@link prepareMediaPrimary} probes the Node internal the handoff
 * needs (`socket-pause.ts`; without it the server runs as one process and says so), builds
 * the {@link MediaCluster}, and installs its adapters where the single-process code looks
 * them up: the agency runtime's stations, dispatcher, reserved-agent return and reaper
 * inputs; `callCore`'s injector; the carrier webhook forwarder.
 *
 * After the bootstraps (the startup reap has run, with no worker alive, so its "every
 * non-terminal row is dead" premise holds): {@link startMediaWorkers} binds what only
 * exists then (pacing's grants and revocations, the guard host's wake and live calls,
 * the concurrency invalidations) and forks the workers.
 */
import type { ChildProcess } from 'node:child_process';
import os from 'node:os';
import { logger } from '@magick-agency/observability';
import type Redis from 'ioredis';
import type { AppContext } from '../app-context.js';
import { StationRegistry } from '../agency/station-registry.js';
import { AgentStateMachine } from '../agency/agent-state-machine.js';
import { configureAgencyRuntime, getAgencyRuntime } from '../bootstrap/agency.js';
import { getVoiceEngine } from '../bootstrap/voice.js';
import { setCoreInjector } from '../api/core-dispatch.js';
import { setVoicelinkWebhookForwarder } from '../api/routes/webhooks.routes.js';
import { getConcurrencyControl, setConcurrencyControl, type ConcurrencyControl } from '../seams/concurrency-control.js';
import { releaseTelephonyLease } from '../core/telephony-release.js';
import { agencyCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { MediaCluster } from './media-cluster.js';
import type { CallLease, ReaperSnapshotBody } from './ipc-protocol.js';
import { forkServerChild } from './fork.js';
import { probeSocketReadStop } from './socket-pause.js';
import { slotFor } from './roles.js';

export interface PrepareMediaPrimaryOptions {
  /** Tests: how a media child is forked. */
  forkChild?: (slot: number) => ChildProcess;
  /** Called on a crash loop; `index.ts` passes its shutdown with exit code 1. */
  onFatal: (why: string) => void;
  readyTimeoutMs?: number;
}

/** Stop grace for media workers: inside the 45 s container grace with the primary's own stops. */
export const MEDIA_WORKER_STOP_GRACE_MS = 30_000;

/**
 * Build the media cluster and install its adapters, or null when the server must run as
 * one process (no workers configured, no Redis, or this Node lacks the internal the
 * handoff needs).
 */
export async function prepareMediaPrimary(ctx: AppContext, opts: PrepareMediaPrimaryOptions): Promise<MediaCluster | null> {
  const { config } = ctx;
  const count = config.processes.mediaWorkers;
  warnIfMoreProcessesThanCores(count, config.dialerAnalysis?.enabled ? config.dialerAnalysis.processes : 0);
  if (count === 0) return null;
  if (!(await probeSocketReadStop())) {
    logger.warn({ mediaWorkers: count, node: process.version },
      'MEDIA_WORKERS is set but this Node cannot stop a socket reading (socket-pause.ts) — running as one process');
    return null;
  }
  const redis: Redis = ctx.redis;
  const keyPrefix = config.redis.keyPrefix;
  // Only the Redis ownership key is read through this registry; it holds no sockets.
  const ownership = new StationRegistry(redis, keyPrefix, 'primary-reader');
  const agents = new AgentStateMachine(redis, keyPrefix);
  let latest: ReaperSnapshotBody = { activeAttemptIds: [], unrecordedEnds: [], manualActiveIds: [], activeCallIds: [], leases: [] };

  const cluster: MediaCluster = new MediaCluster({
    count,
    fork: opts.forkChild ?? ((slot) => forkServerChild({ role: 'media', slot, heapMb: config.processes.mediaWorkerHeapMb })),
    readOwner: (sessionId) => ownership.ownerOf(sessionId),
    setAgentOffline: async (sessionId) => { await agents.set(sessionId, 'offline'); },
    onWorkerExit: (slot, last, held) => reapSlot(cluster, slot, last, held),
    crashLoop: {
      max: config.processes.crashLoopMax,
      onCrashLoop: (slot) => opts.onFatal(`media worker ${slot} crash loop`),
    },
    ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
    snapshotRefreshMs: config.processes.mediaSnapshotRefreshMs,
  });

  configureAgencyRuntime({
    pacingStations: cluster.directory,
    dispatcher: cluster.dispatcher,
    reservedReturn: cluster.reservedReturn,
    reaper: {
      beforeSweep: async () => {
        const fresh = await cluster.freshSnapshots();
        if (!fresh) return false;
        latest = fresh;
        return true;
      },
      activeAttemptIds: () => latest.activeAttemptIds,
      ownerOf: (sessionId) => cluster.directory.ownerOf(sessionId),
      unrecordedEnds: { ids: () => latest.unrecordedEnds, forget: (ids) => cluster.forgetUnrecorded(ids) },
      manual: { activeIds: () => latest.manualActiveIds, onClosed: (rows) => cluster.manualCallsClosed(rows) },
    },
  });
  setCoreInjector(cluster.coreInjector);
  setVoicelinkWebhookForwarder(cluster.webhookForwarder);
  return cluster;
}

/**
 * Not refused (the config does not depend on the host), but said once at boot: more
 * processes than cores share the cores, and a media worker that waits for a core delays
 * its calls' audio (`docs/operations.md`, "Sizing the media workers").
 */
export function warnIfMoreProcessesThanCores(
  mediaWorkers: number,
  analysisWorkers: number,
  cores: number = os.availableParallelism(),
  warn: (fields: Record<string, number>, msg: string) => void = (f, m) => logger.warn(f, m),
): boolean {
  if (mediaWorkers + analysisWorkers === 0) return false;
  const processes = 1 + mediaWorkers + analysisWorkers;
  if (processes <= cores) return false;
  warn({ cores, processes, mediaWorkers, analysisWorkers, primary: 1 },
    'More server processes than CPU cores: they will share cores (MEDIA_WORKERS + ANALYSIS_WORKERS + the primary)');
  return true;
}

/** After the bootstraps: bind what exists only now, then fork the workers and wait for them. */
export async function startMediaWorkers(cluster: MediaCluster): Promise<() => Promise<void>> {
  const runtime = getAgencyRuntime();
  const voice = getVoiceEngine();
  if (!runtime || !voice) throw new Error('media workers need the agency runtime and the voice engine started first');
  cluster.bind({
    grantFor: (campaignId) => runtime.pacing.leadershipGrant(campaignId),
    wakeSelfHeal: () => voice.guardHost.wakeSelfHeal(),
  });
  const offRevoke = runtime.pacing.onAuthorisationRevoked((campaignId, upTo) => cluster.revoke(campaignId, upTo));
  // The stale-call sweep must never fail a call a worker is bridging; B13: the self-heal
  // poll stays armed while any worker holds a call.
  voice.guardHost.registerWebrtcActiveIdsProvider(() => [...voice.bridge.getActiveCallIds(), ...cluster.activeCallIds()]);
  // A super-admin limit change drops every worker's cached limit too.
  const inner = getConcurrencyControl();
  const broadcasting: ConcurrencyControl = {
    async invalidateAccountLimit(tenantId, accountId) {
      try { await inner.invalidateAccountLimit(tenantId, accountId); } finally { cluster.invalidateLimits(tenantId, accountId); }
    },
    async invalidateProviderLimits(tenantId, accountId) {
      try { await inner.invalidateProviderLimits(tenantId, accountId); } finally { cluster.invalidateLimits(tenantId, accountId); }
    },
    getAccountProviderCounts: (tenantId, accountId) => inner.getAccountProviderCounts(tenantId, accountId),
    getAccountCount: (tenantId, accountId) => inner.getAccountCount(tenantId, accountId),
    getDistributedAccountCount: (tenantId, accountId) => inner.getDistributedAccountCount(tenantId, accountId),
  };
  setConcurrencyControl(broadcasting);

  await cluster.start();
  logger.info({ mediaWorkers: cluster.count }, 'Media worker processes started');

  return async () => {
    // Pacing first (no dial is prepared or sent once it has halted), then the workers
    // drain beside the completion-notice drain: the order of one process, overlapped so
    // the 45 s grace holds (docs/scaling.md §6.4).
    await runtime.pacing.halt();
    await Promise.all([
      runtime.pacing.drainNotices(),
      cluster.stop(MEDIA_WORKER_STOP_GRACE_MS),
    ]);
    offRevoke();
    if (getConcurrencyControl() === broadcasting) setConcurrencyControl(inner);
  };
}

/**
 * A media worker exited: close what it owned before the slot is re-forked
 * (`docs/scaling.md` §6.1). Its process is dead, so every non-terminal attempt and
 * soft-phone call of a session in its slot is dead by definition (the startup reap's
 * rule, narrowed to one slot), and nothing new can be owned by the slot until this ends.
 */
export async function reapSlot(
  cluster: MediaCluster,
  slot: number,
  last: ReaperSnapshotBody | null,
  held: readonly CallLease[] = last?.leases ?? [],
): Promise<void> {
  const runtime = getAgencyRuntime();
  const voice = getVoiceEngine();
  const isDead = (sessionId: string): boolean => slotFor(sessionId, cluster.count) === slot;
  // Capacity back now, not when the 330 s locks lapse: exactly the slots the worker held,
  // from its `call.lease` deltas (a call admitted a moment before the crash included).
  if (voice) {
    for (const lease of held) {
      await releaseTelephonyLease(voice.guardHost, {
        concurrencyKey: lease.concurrencyKey, tenantId: lease.tenantId, accountId: lease.accountId,
        provider: lease.provider, source: 'webrtc', callId: lease.callId,
      }).catch(() => 'failure');
    }
  }
  if (runtime) {
    const report = await runtime.reaper.reapSessions(isDead)
      .catch((err) => { logger.error({ err, slot }, 'Slot reap failed'); return null; });
    // Their call rows: what the worker last reported live, and the calls of the attempts
    // the reap just ended (a call placed after that report included).
    const callIds = [...new Set([...(last?.activeCallIds ?? []), ...(report?.callIds ?? [])])];
    if (callIds.length > 0) {
      await agencyCallRepository.failActiveByIds(callIds, 'worker_exited')
        .catch((err) => logger.error({ err, slot }, 'Could not fail the dead media worker\'s call rows'));
    }
    logger.warn({ slot, report, slotsReleased: held.length, callRowsFailed: callIds.length },
      'Reaped a dead media worker\'s calls, attempts and agents');
  }
  voice?.guardHost.wakeSelfHeal();
}
