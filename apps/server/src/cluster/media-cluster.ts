/**
 * The primary's side of the media workers (`MEDIA_WORKERS > 0`, `docs/scaling.md`):
 * one object that owns the media {@link ChildSupervisor} and gives every part of the
 * primary the adapter it needs:
 *
 *  - the upgrade handoff's target (`ws-handoff.plugin.ts`): the station socket goes to
 *    `slotFor(sessionId)`, the carrier's stream to the slot its URL's `w` names;
 *  - pacing's {@link StationDirectory}, {@link IpcDialDispatcher} and reserved-agent return;
 *  - `callCore`'s injector: a session-owned internal handler runs in the session's worker;
 *  - the carrier webhook forwarders: a VoiceLink status post, and a Plivo answer, status
 *    or recording callback, runs in the worker its `w` names;
 *  - the reaper's liveness inputs (the workers' live attempts, unrecorded ends, live
 *    soft-phone calls) and the guard host's live call ids, refreshed by `reaper.snapshot`;
 *  - the relay of the workers' events into this process (the pacing bus, the guard's
 *    self-heal wake, the analysis wake).
 */
import type net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyStationServerFrame } from '@magick-agency/contracts/agency';
import { publishPacingInvalidation } from '../agency/pacing/invalidation-bus.js';
import type { ReservedReturn } from '../agency/pacing-engine.js';
import type { AgencyManualCallRecord } from '../db/models/agency.model.js';
import {
  agencyAgentSessionRepository,
  agencyAttemptRepository,
  agencyManualCallRepository,
} from '../db/repositories/agency.repository.js';
import type { CoreInjectArgs, CoreInjectResult, CoreInjector } from '../api/core-dispatch.js';
import { resolveCoreRoute } from '../api/core-owners.js';
import type { VoicelinkWebhookForwarder } from '../api/routes/webhooks.routes.js';
import {
  PLIVO_HANGUP_ANSWER, plivoCallbackUnavailable, type PlivoCallbackForwarder,
} from '../api/routes/webhooks/plivo.js';
import { getDialerAnalysisWorker } from '../core/dialer-analysis-worker-handle.js';
import { ChildSupervisor } from './child-supervisor.js';
import { IpcRequestError, type IpcChannel } from './ipc-channel.js';
import type { CallLease, ReaperSnapshotBody, WsHandoff } from './ipc-protocol.js';
import { IpcDialDispatcher } from './ipc-dial-dispatcher.js';
import { slotFor } from './roles.js';
import { StationDirectory } from './station-directory.js';
import type { WsHandoffTarget, WsOwnerConfig } from './ws-handoff.plugin.js';

const log = createChildLogger({ component: 'media-cluster' });

const CORE_INJECT_DEADLINE_MS = 15_000;
const WEBHOOK_DEADLINE_MS = 10_000;
const RETURN_RESERVED_DEADLINE_MS = 5_000;
const SNAPSHOT_DEADLINE_MS = 5_000;
/**
 * How often the workers' live call ids are refreshed for the guard host's stale sweep, and
 * the slot leases reconciled, unless {@link MediaClusterOptions.snapshotRefreshMs} says
 * otherwise (`MEDIA_SNAPSHOT_REFRESH_MS`, `config.processes.mediaSnapshotRefreshMs`).
 */
export const SNAPSHOT_REFRESH_MS = 5_000;

export interface MediaClusterOptions {
  count: number;
  fork: (slot: number) => ChildProcess;
  /** The Redis ownership key's replica id (`StationRegistry.ownerOf`). */
  readOwner: (sessionId: string) => Promise<string | null>;
  /** Write a session `offline` (Redis) when its worker cannot take the reserved-agent return. */
  setAgentOffline: (sessionId: string) => Promise<void>;
  /** The grant pacing leads a campaign under. Set once the runtime exists. */
  grantFor?: (campaignId: string) => number | null;
  /** Wake this process's guard self-heal poll (a worker's calls ended). */
  wakeSelfHeal?: () => void;
  /**
   * Awaited after a media worker exits unexpectedly, before it is re-forked (the slot
   * reap): its last snapshot, and the exact slots it held (`call.lease` deltas, reconciled
   * by each snapshot).
   */
  onWorkerExit?: (slot: number, lastSnapshot: ReaperSnapshotBody | null, leases: CallLease[]) => Promise<void>;
  crashLoop?: { max: number; onCrashLoop: (slot: number) => void };
  readyTimeoutMs?: number;
  restartBackoffMs?: readonly number[];
  /** The periodic snapshot refresh; 0 turns it off. Default {@link SNAPSHOT_REFRESH_MS}. */
  snapshotRefreshMs?: number;
  /**
   * How many `dial.execute` may be outstanding to one worker (the primary passes
   * `MAX_CONCURRENT_CALLS`). A dial is outstanding from send to the carrier's `add_lead`
   * answer, up to 40 s, and pacing sends at most one per idle agent, so a shift start on a
   * worker that holds most of the floor has as many in flight as it has agents. Each also
   * takes a global concurrency slot, so more than `MAX_CONCURRENT_CALLS` could never be
   * admitted anyway: that is the bound, and legitimate load cannot reach it. Dials are
   * bounded apart from the other requests, so a dial burst never refuses an agent's
   * forwarded request or a carrier post (and the reverse). Default
   * {@link DEFAULT_MAX_DIALS_IN_FLIGHT}.
   */
  maxDialsInFlight?: number;
}

/** `MAX_CONCURRENT_CALLS`' default (`config/blocks/voice.ts`). */
export const DEFAULT_MAX_DIALS_IN_FLIGHT = 1_000;

export class MediaCluster implements WsHandoffTarget {
  readonly supervisor: ChildSupervisor;
  readonly directory: StationDirectory;
  readonly dispatcher: IpcDialDispatcher;
  private grantFor: (campaignId: string) => number | null;
  private wakeSelfHeal: () => void;
  private readonly snapshots = new Map<number, ReaperSnapshotBody>();
  /** Per slot: the telephony slots its worker holds, by concurrency key. */
  private readonly leases = new Map<number, Map<string, CallLease>>();
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: MediaClusterOptions) {
    this.grantFor = opts.grantFor ?? (() => null);
    this.wakeSelfHeal = opts.wakeSelfHeal ?? (() => {});
    this.directory = new StationDirectory({
      readOwner: opts.readOwner,
      broadcastToWorkers: (campaignId, frame) => { this.supervisor.broadcast('station.broadcast', { campaignId, frame }); },
      sendToWorker: (slot, sessionId, frame) => this.supervisor.channel(slot)?.emit('station.send', { sessionId, frame }) ?? false,
    });
    this.supervisor = new ChildSupervisor({
      role: 'media',
      count: opts.count,
      fork: opts.fork,
      onChannel: (slot, channel) => this.wireChannel(slot, channel),
      channelBounds: { maxInFlightByType: { 'dial.execute': opts.maxDialsInFlight ?? DEFAULT_MAX_DIALS_IN_FLIGHT } },
      onExit: async (exit) => {
        this.directory.workerDown(exit.slot);
        const last = this.snapshots.get(exit.slot) ?? null;
        const held = [...(this.leases.get(exit.slot)?.values() ?? [])];
        this.snapshots.delete(exit.slot);
        this.leases.delete(exit.slot);
        await opts.onWorkerExit?.(exit.slot, last, held);
      },
      ...(opts.crashLoop ? { crashLoop: opts.crashLoop } : {}),
      ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
      ...(opts.restartBackoffMs !== undefined ? { restartBackoffMs: opts.restartBackoffMs } : {}),
    });
    this.dispatcher = new IpcDialDispatcher({
      channelForReplica: (replicaId) => {
        const slot = this.directory.slotOfReplica(replicaId);
        return slot === null ? null : this.supervisor.channel(slot);
      },
      grantFor: (campaignId) => this.grantFor(campaignId),
    });
  }

  get count(): number {
    return this.opts.count;
  }

  /** Late wiring, once the runtime and the voice engine exist. */
  bind(input: { grantFor: (campaignId: string) => number | null; wakeSelfHeal: () => void }): void {
    this.grantFor = input.grantFor;
    this.wakeSelfHeal = input.wakeSelfHeal;
  }

  async start(): Promise<void> {
    await this.supervisor.start();
    const refreshMs = this.opts.snapshotRefreshMs ?? SNAPSHOT_REFRESH_MS;
    if (refreshMs > 0) {
      this.snapshotTimer = setInterval(() => { void this.refreshSnapshots(); }, refreshMs);
      this.snapshotTimer.unref?.();
    }
    await this.refreshSnapshots();
  }

  async stop(graceMs: number): Promise<void> {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
    await this.supervisor.stop(graceMs);
  }

  private wireChannel(slot: number, channel: IpcChannel): void {
    channel.onEvent('ready', (body) => {
      if (body.role === 'media' && body.slot === slot && body.replicaId) this.directory.workerUp(slot, body.replicaId);
    });
    channel.onEvent('station.attached', (b) => this.directory.attached(slot, b.sessionId, b.campaignId, b.replicaId));
    channel.onEvent('station.detached', (b) => this.directory.detached(slot, b.sessionId));
    channel.onEvent('station.snapshot', (b) => this.directory.snapshot(slot, b.replicaId, b.sessions));
    channel.onEvent('pacing.invalidate', (ev) => publishPacingInvalidation(ev));
    channel.onEvent('voice.wake_self_heal', () => this.wakeSelfHeal());
    channel.onEvent('analysis.wake', () => getDialerAnalysisWorker()?.wake());
    channel.onEvent('call.lease', (change) => {
      let held = this.leases.get(slot);
      if (!held) { held = new Map(); this.leases.set(slot, held); }
      if (change.op === 'held') held.set(change.lease.concurrencyKey, change.lease);
      else held.delete(change.concurrencyKey);
    });
  }

  // ─── the upgrade handoff ─────────────────────────────────────────────────

  slotFor(owner: WsOwnerConfig, params: Record<string, string | undefined>, query: Record<string, unknown>): number | null {
    let slot: number | null = null;
    if (owner.by === 'session') {
      const key = params[owner.param];
      if (key) slot = slotFor(key, this.opts.count);
    } else {
      slot = this.slotFromHint(query['w']);
    }
    return slot !== null && this.supervisor.isReady(slot) ? slot : null;
  }

  handoff(slot: number, msg: WsHandoff, socket: net.Socket): boolean {
    return this.supervisor.sendHandoff(slot, msg, socket);
  }

  private slotFromHint(raw: unknown): number | null {
    if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw)) return null;
    const slot = Number(raw);
    return slot < this.opts.count ? slot : null;
  }

  // ─── pacing ──────────────────────────────────────────────────────────────

  readonly reservedReturn: ReservedReturn = {
    returnReserved: async (sessionId: string) => {
      const channel = this.supervisor.channel(slotFor(sessionId, this.opts.count));
      if (channel) {
        try {
          await channel.request('agent.return_reserved', { sessionId }, { deadlineMs: RETURN_RESERVED_DEADLINE_MS });
          return;
        } catch (err) {
          log.warn({ err, sessionId }, 'Reserved-agent return to the media worker failed — writing the agent offline');
        }
      }
      // No worker holds the agent's station: as for a pair whose owner is gone.
      await this.opts.setAgentOffline(sessionId);
    },
  };

  /** Withdraw dial authority in every worker (`PacingEngine.onAuthorisationRevoked`). */
  revoke(campaignId: string | null, upTo: number): void {
    this.supervisor.broadcast('pacing.revoke', { campaignId, upTo });
  }

  // ─── callCore ────────────────────────────────────────────────────────────

  readonly coreInjector: CoreInjector = async (args, local) => {
    const match = resolveCoreRoute(args.method, args.url);
    if (!match || match.owner === 'none') return local(args);
    let sessionId: string | null;
    try {
      sessionId = await this.sessionOf(match.owner, match.id, args);
    } catch (err) {
      log.warn({ err, url: args.url }, 'Could not resolve the owning session of an internal request — running it here');
      return local(args);
    }
    // No session to own it (an unknown id, no live session): the handler answers that
    // the same wherever it runs.
    if (!sessionId) return local(args);
    const slot = slotFor(sessionId, this.opts.count);
    const channel = this.supervisor.channel(slot);
    if (!channel) return jsonAnswer(503, { error: 'Service Unavailable', code: 'worker_unavailable', message: 'Try again in a moment.' });
    try {
      const res = await channel.request('core.inject', args, { deadlineMs: CORE_INJECT_DEADLINE_MS });
      return { statusCode: res.statusCode, headers: res.headers, rawPayload: Buffer.from(res.body, 'base64') };
    } catch (err) {
      const code = err instanceof IpcRequestError ? err.code : 'handler_error';
      log.warn({ err, slot, url: args.url, code }, 'Forwarded internal request failed');
      if (code === 'timeout') return jsonAnswer(504, { error: 'Gateway Timeout', code: 'worker_timeout', message: 'Try again in a moment.' });
      return jsonAnswer(503, { error: 'Service Unavailable', code: 'worker_unavailable', message: 'Try again in a moment.' });
    }
  };

  private async sessionOf(owner: string, id: string | null, args: CoreInjectArgs): Promise<string | null> {
    const tenantId = args.headers['x-mgkvc-tenant'];
    const accountId = args.headers['x-mgkvc-account'];
    switch (owner) {
      case 'session_param':
        return id;
      case 'attempt_param': {
        if (!id) return null;
        const attempt = await agencyAttemptRepository.findById(id);
        return attempt?.reserved_agent_id ?? null;
      }
      case 'manual_call_param': {
        if (!id || !tenantId || !accountId) return null;
        const call = await agencyManualCallRepository.findById(id, { tenantId, accountId });
        return call?.session_id ?? null;
      }
      case 'body_session': {
        if (args.payload === undefined) return null;
        const body = JSON.parse(args.payload) as { session_id?: unknown };
        return typeof body.session_id === 'string' ? body.session_id : null;
      }
      case 'actor_session': {
        const userId = new URLSearchParams(args.url.split('?')[1] ?? '').get('actor_user_id');
        if (!userId || !tenantId) return null;
        const live = await agencyAgentSessionRepository.findLiveForAgent(tenantId, userId);
        return live?.id ?? null;
      }
      default:
        return null;
    }
  }

  // ─── carrier webhooks ────────────────────────────────────────────────────

  readonly webhookForwarder: VoicelinkWebhookForwarder = async ({ callId, token, hint, body }) => {
    const slot = this.slotFromHint(hint);
    if (slot === null) return null; // no hint: this process's session-less bridge (the late-terminal path)
    const channel = this.supervisor.channel(slot);
    if (!channel) return null; // the worker is gone, and its calls with it: the late-terminal path
    try {
      return await channel.request('carrier.webhook', { callId, token: token ?? null, body }, { deadlineMs: WEBHOOK_DEADLINE_MS });
    } catch (err) {
      log.warn({ err, slot, callId }, 'Forwarded carrier webhook failed — answering 503 so it is not taken as processed');
      return { statusCode: 503, body: { status: false } };
    }
  };

  /**
   * Plivo's answer, status and recording callbacks, routed by `w` as the VoiceLink status
   * post is. The worker runs `handlePlivoCallback` (token, signature, bridge) on exactly
   * the URL, params and signature headers the primary received, and its answer (the answer
   * XML included) is Plivo's reply. No hint: null, run here. The worker gone: an answer
   * callback is hung up here (its call went with the worker; nothing could stream it),
   * a status or recording is run here (the late path off the call row). A forwarded
   * callback that fails (deadline, the worker exiting) is unavailable: a hangup for the
   * answer, 503 for the others.
   */
  readonly plivoCallbackForwarder: PlivoCallbackForwarder = async ({ hint, ...input }) => {
    const slot = this.slotFromHint(hint);
    if (slot === null) return null;
    const channel = this.supervisor.channel(slot);
    if (!channel) return input.kind === 'answer' ? PLIVO_HANGUP_ANSWER : null;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers)) if (typeof v === 'string') headers[k] = v;
    try {
      return await channel.request('carrier.plivo_callback', {
        kind: input.kind,
        callId: input.callId,
        token: input.token ?? null,
        url: input.url,
        params: input.params,
        headers,
      }, { deadlineMs: WEBHOOK_DEADLINE_MS });
    } catch (err) {
      log.warn({ err, slot, callId: input.callId, kind: input.kind }, 'Forwarded Plivo callback failed — answering it as unavailable');
      return plivoCallbackUnavailable(input.kind);
    }
  };

  // ─── the reaper and the guard ────────────────────────────────────────────

  /**
   * Fresh liveness from every worker, or null when one is not ready or does not answer:
   * the reaper then skips the sweep (fail closed: an unanswered worker's calls must not
   * look orphaned).
   */
  async freshSnapshots(): Promise<ReaperSnapshotBody | null> {
    const parts = await Promise.all(Array.from({ length: this.opts.count }, async (_, slot) => {
      const channel = this.supervisor.channel(slot);
      if (!channel) return null;
      try {
        const s = await channel.request('reaper.snapshot', {}, { deadlineMs: SNAPSHOT_DEADLINE_MS });
        this.snapshots.set(slot, s);
        // Reconcile by replacing. Sound because the worker's snapshot is exactly the deltas it
        // has told (the bridge adds and removes a lease where it emits `held` / `released`,
        // from admission to release, registered call or not), and its synchronous handler
        // answers in the turn it computed the snapshot, so on this FIFO channel every delta
        // before the answer is in it, and every delta after arrives after it.
        this.leases.set(slot, new Map(s.leases.map((l) => [l.concurrencyKey, l])));
        return s;
      } catch {
        return null;
      }
    }));
    if (parts.some((p) => p === null)) return null;
    return mergeSnapshots(parts as ReaperSnapshotBody[]);
  }

  private async refreshSnapshots(): Promise<void> {
    await this.freshSnapshots().catch(() => null);
  }

  /** The workers' live call ids as last reported (for the stale-call sweep's exclusion and B13). */
  activeCallIds(): string[] {
    return mergeSnapshots([...this.snapshots.values()]).activeCallIds;
  }

  /** Forget unrecorded ends in every worker once the reaper wrote them. */
  forgetUnrecorded(attemptIds: readonly string[]): void {
    if (attemptIds.length > 0) this.supervisor.broadcast('reaper.forget_unrecorded', { attemptIds: [...attemptIds] });
  }

  /** Tell each soft-phone call's own worker that a sweep closed it. */
  async manualCallsClosed(rows: readonly AgencyManualCallRecord[]): Promise<void> {
    const bySlot = new Map<number, AgencyManualCallRecord[]>();
    for (const row of rows) {
      const slot = slotFor(row.session_id, this.opts.count);
      bySlot.set(slot, [...(bySlot.get(slot) ?? []), row]);
    }
    await Promise.all([...bySlot].map(async ([slot, list]) => {
      const channel = this.supervisor.channel(slot);
      if (!channel) return;
      await channel.request('softphone.closed_by_sweep', { rows: list }, { deadlineMs: 10_000 })
        .catch((err) => log.warn({ err, slot }, 'Could not tell a media worker its soft-phone calls were closed'));
    }));
  }

  /** Broadcast a concurrency-limit change so every worker drops its cached limit. */
  invalidateLimits(tenantId: string, accountId: string): void {
    this.supervisor.broadcast('concurrency.invalidate', { tenantId, accountId });
  }

  /** Slot health for `/readyz`. */
  async health(): ReturnType<ChildSupervisor['health']> {
    return this.supervisor.health(1_000);
  }
}

export function mergeSnapshots(parts: readonly ReaperSnapshotBody[]): ReaperSnapshotBody {
  return {
    activeAttemptIds: parts.flatMap((p) => p.activeAttemptIds),
    unrecordedEnds: parts.flatMap((p) => p.unrecordedEnds),
    manualActiveIds: parts.flatMap((p) => p.manualActiveIds),
    activeCallIds: parts.flatMap((p) => p.activeCallIds),
    leases: parts.flatMap((p) => p.leases),
  };
}

function jsonAnswer(statusCode: number, body: unknown): CoreInjectResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    rawPayload: Buffer.from(JSON.stringify(body)),
  };
}

/** For `station.broadcast` typing in tests. */
export type BroadcastFrame = AgencyStationServerFrame;
