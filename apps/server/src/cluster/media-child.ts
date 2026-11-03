/**
 * A media worker (`MA_PROCESS_ROLE=media`, `docs/scaling.md` §1): a dialer-runtime shard.
 * It holds the station sockets of the sessions `slotFor` gives its slot, their in-process
 * runtime state (live attempts, wrap-up, breaks, the soft phone's live call) and both legs
 * of their calls, and relays every audio frame of those calls itself. Nothing per frame
 * crosses IPC.
 *
 * What it does NOT run (the primary does, once for the host): pacing, the reaper and its
 * sweeps, the guard self-heal, the abandonment and live-concurrency refreshes, audit
 * partitions, retention, the clip cache sweep, the credential shred, the analysis slots.
 *
 * Its IPC surface (`ipc-protocol.ts`): it serves `dial.execute`, `core.inject`,
 * `carrier.webhook`, `agent.return_reserved`, `reaper.snapshot`, `softphone.closed_by_sweep`,
 * `health.ping` and `shutdown`, applies `pacing.revoke`, `station.broadcast`,
 * `concurrency.invalidate` and `reaper.forget_unrecorded`, and tells the primary
 * `ready`, `station.attached` / `.detached` / `.snapshot`, `pacing.invalidate`,
 * `voice.wake_self_heal` and `analysis.wake`.
 */
import type net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyRuntime } from '../agency/runtime.js';
import type { WebRtcBridgeManager } from '../core/webrtc-bridge-manager.js';
import type { TelephonyGuardHost } from '../core/telephony-guard-host.js';
import { setPacingInvalidationBus, type PacingInvalidationBus } from '../agency/pacing/invalidation-bus.js';
import { injectLocal, type CoreInjectArgs } from '../api/core-dispatch.js';
import { handleVoicelinkStatusWebhook } from '../api/routes/webhooks.routes.js';
import type { IpcChannel } from './ipc-channel.js';
import type { HealthBody } from './ipc-protocol.js';
import { DialGrants } from './ipc-dial-dispatcher.js';
import { adoptUpgrade } from './ws-adopt.js';
import { createLoopSampler } from './loop-sampler.js';

const log = createChildLogger({ component: 'media-child' });

export interface MediaChildDeps {
  slot: number;
  channel: IpcChannel;
  runtime: AgencyRuntime;
  bridge: WebRtcBridgeManager;
  guardHost: TelephonyGuardHost;
  /** The worker's Fastify instance (`worker-app.ts`): handed-off upgrades are adopted on its server. */
  app: FastifyInstance;
  /** This worker's internal handler instance (`buildCoreHandlers`), for forwarded `core.inject`. */
  core: FastifyInstance;
}

export interface MediaChild {
  /** Close the sockets, stop the shard's timers, end live calls. Idempotent. */
  shutdown(): Promise<void>;
  health(): HealthBody;
}

/**
 * The pacing invalidation bus in a worker: every event this process publishes (an agent
 * entering `available`, a station attaching, a call ending) goes to the primary, where the
 * one pacing engine is. Nothing subscribes here.
 */
export class IpcPacingInvalidationBus implements PacingInvalidationBus {
  constructor(private readonly channel: IpcChannel) {}
  publish(event: Parameters<PacingInvalidationBus['publish']>[0]): void {
    this.channel.emit('pacing.invalidate', event);
  }
  subscribe(): () => void {
    return () => {};
  }
}

export function installIpcPacingBus(channel: IpcChannel): void {
  setPacingInvalidationBus(new IpcPacingInvalidationBus(channel));
}

export function startMediaChild(deps: MediaChildDeps): MediaChild {
  const { slot, channel, runtime, bridge, guardHost, app, core } = deps;
  const grants = new DialGrants();
  let draining = false;
  let shuttingDown: Promise<void> | null = null;
  const sampleLoop = createLoopSampler();

  // ── Upgrades handed over by the primary ──────────────────────────────────
  channel.onHandoff((msg, socket) => {
    if (draining) {
      (socket as net.Socket).destroy();
      return;
    }
    adoptUpgrade(app.server, msg, socket as net.Socket);
  });

  // ── Stations: tell the primary where they are ────────────────────────────
  runtime.stations.onAttached(({ sessionId, campaignId }) => {
    channel.emit('station.attached', { sessionId, campaignId, replicaId: runtime.replicaId });
  });
  runtime.stations.onDetached((sessionId) => {
    channel.emit('station.detached', { sessionId });
  });
  const snapshot = (): void => {
    channel.emit('station.snapshot', {
      replicaId: runtime.replicaId,
      sessions: runtime.stations.all().map((e) => ({ sessionId: e.sessionId, campaignId: e.campaignId })),
    });
  };
  channel.onEvent('station.broadcast', ({ campaignId, frame }) => {
    runtime.stations.broadcast(campaignId, frame);
  });

  // ── Telephony slots: every take and give-back, as it happens ──────────────
  bridge.observeLeases((change) => { channel.emit('call.lease', change); });

  // ── Dials ────────────────────────────────────────────────────────────────
  channel.onEvent('pacing.revoke', ({ campaignId, upTo }) => grants.revoke(campaignId, upTo));
  channel.handle('dial.execute', async ({ cmd, grant }) => {
    if (cmd.ownerReplica !== runtime.replicaId) {
      // As `LocalDialDispatcher`: loud, because dialing anyway would produce an abandoned call.
      log.error({ attemptId: cmd.attemptId, owner: cmd.ownerReplica, self: runtime.replicaId }, 'Dial command for an agent owned by another replica — refusing');
      throw new Error(`Dial for non-owned agent session ${cmd.sessionId}`);
    }
    await runtime.dialer.executeDial(cmd, { stillAuthorised: grants.checker(cmd.campaignId, grant) });
    return {};
  });
  channel.handle('agent.return_reserved', async ({ sessionId }) => {
    // The single-process `returnReserved`, run where the queued break lives.
    if (runtime.breaks.peek(sessionId) !== null) await runtime.dialer.releaseAgent(sessionId);
    else await runtime.agents.set(sessionId, 'available');
    return {};
  });

  // ── Internal handlers and carrier posts forwarded by the primary ─────────
  channel.handle('core.inject', async (args: CoreInjectArgs) => {
    const res = await injectLocal(core, args);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      headers[k] = Array.isArray(v) ? v.map(String) : String(v);
    }
    return { statusCode: res.statusCode, headers, body: res.rawPayload.toString('base64') };
  });
  channel.handle('carrier.webhook', async ({ callId, token, body }) =>
    handleVoicelinkStatusWebhook(bridge, callId, token ?? undefined, body));

  // ── What the primary's sweeps need to know ───────────────────────────────
  // Synchronous on purpose: answered in the turn it is computed, so the primary's lease
  // reconcile can replace its map with `leases` (`media-cluster.ts`, `ipc-channel.ts`).
  channel.handle('reaper.snapshot', () => ({
    activeAttemptIds: runtime.dialer.activeAttemptIds(),
    unrecordedEnds: runtime.dialer.unrecordedEndedAttemptIds(),
    manualActiveIds: runtime.manualDialer.activeManualCallIds(),
    activeCallIds: bridge.getActiveCallIds(),
    leases: bridge.heldLeases(),
  }));
  channel.onEvent('reaper.forget_unrecorded', ({ attemptIds }) => runtime.dialer.forgetUnrecordedEnds(attemptIds));
  channel.handle('softphone.closed_by_sweep', async ({ rows }) => {
    await runtime.manualDialer.onCallsClosedBySweep(rows);
    return {};
  });
  channel.onEvent('concurrency.invalidate', ({ tenantId, accountId }) => {
    void guardHost.accountConcurrencyGuard.invalidateLimit(tenantId, accountId).catch(() => {});
    void guardHost.providerConcurrencyGuard.invalidateLimits(tenantId, accountId).catch(() => {});
  });

  const health = (): HealthBody => {
    return {
      role: 'media', slot, pid: process.pid,
      ...sampleLoop(),
      inFlight: bridge.getActiveCallIds().length,
      pausedForMs: 0,
      draining,
    };
  };
  channel.handle('health.ping', health);

  const shutdown = (): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    draining = true;
    shuttingDown = (async () => {
      // As one process stops (HTTP first, then agency, then voice): the sockets close,
      // the shard's timers stop, the bridge ends the live calls and releases their slots.
      await app.close().catch((err) => log.error({ err, slot }, 'worker app close failed'));
      await runtime.stopShard();
      await bridge.gracefulShutdown().catch((err) => log.error({ err, slot }, 'webrtc-bridge shutdown failed'));
      await guardHost.gracefulShutdown().catch((err) => log.error({ err, slot }, 'guard host shutdown failed'));
      await core.close().catch(() => {});
    })();
    return shuttingDown;
  };

  channel.emit('ready', { role: 'media', slot, pid: process.pid, replicaId: runtime.replicaId });
  snapshot();
  log.info({ slot, replicaId: runtime.replicaId }, 'Media worker process ready');
  return { shutdown, health };
}
