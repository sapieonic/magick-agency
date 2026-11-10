import { createChildLogger } from '@magick-agency/observability';
import { getInboundCallRouter, setInboundCallRouter } from '../../seams/inbound-call-router.js';
import { WEBRTC_MAX_DURATION_SECONDS } from '../../config/call-duration-limits.js';
import type { AgencyRuntime } from '../runtime.js';
import {
  AgencyInboundCallRouter,
  INBOUND_MAX_PARKED_SECONDS,
  type AgencyInboundCallRouterDeps,
} from './inbound-call-router.js';
import { InboundConnector, type InboundConnectorDeps } from './inbound-connector.js';
import { INBOUND_LAPSE_SWEEP_INTERVAL_MS } from './inbound-disposition.js';
import { withTimeoutOr } from '../../utils/with-timeout.js';

const log = createChildLogger({ component: 'agency-inbound-router' });

/**
 * ─── INBOUND CALLS' BACKGROUND WORK (docs/inbound.md §3.4, §6, §10) ─────────────────────────
 *
 * What runs in this process for inbound calls, started by `bootstrap/agency.ts` with the rest of
 * the agency's background work: the router and the connector built and wired, the startup and
 * periodic stale sweeps, the outcome-lapse sweep, and the shutdown drain. The router
 * (`inbound-call-router.ts`) is the seam's implementation only.
 */

/** How often the periodic sweep runs (§10). */
export const INBOUND_SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * The periodic sweep ends a call not ended whose latest start (`COALESCE(bridged_at,
 * arrived_at)`, `sweepStale`) is older than this. A live session ends every call before it: an
 * unbridged call within its budget from the answer (at most {@link INBOUND_MAX_PARKED_SECONDS}
 * parked, then the account's max duration, at most `WEBRTC_MAX_DURATION_SECONDS`; a message or a
 * voicemail's budget is shorter), a bridged one within the max duration the bind re-arms. So with
 * the margin it never ends a call a live session in this process still holds (SWE-m1: on the
 * arrival alone, a caller parked 15 minutes and then talking to the ceiling was swept mid-call).
 * The startup sweep instead ends every call that arrived before this process started: no session
 * of the process that held it survives a restart (one replica; IB8).
 */
export const INBOUND_SWEEP_STALE_AFTER_MS = (WEBRTC_MAX_DURATION_SECONDS + INBOUND_MAX_PARKED_SECONDS + 10 * 60) * 1000;

/**
 * What {@link startInboundCalls} connects agents with (P2): the agency runtime's pieces, and the
 * gate (IQ12, IQ13). Absent: P1 (nobody is connected).
 */
export interface InboundConnectOptions {
  runtime: Pick<AgencyRuntime, 'stations' | 'agents' | 'dialer' | 'inboundCalls' | 'attachInbound'>;
  /** `agency_inbound_enabled` for an account; a read that fails is false. */
  enabled(tenantId: string, accountId: string): Promise<boolean>;
  /** `MEDIA_WORKERS` (IB8). */
  mediaWorkers: number;
  /** The outcome-lapse sweep's interval (default {@link INBOUND_LAPSE_SWEEP_INTERVAL_MS}). */
  lapseSweepIntervalMs?: number;
  /** The connector's own options (tests: a shorter connect delay). */
  connector?: Pick<InboundConnectorDeps, 'connectDelayMs' | 'republishMs' | 'now'>;
}

/** How long the inbound stop waits for the calls it ends to settle (see {@link startInboundCalls}). */
export const INBOUND_SHUTDOWN_DRAIN_MS = 10_000;

/**
 * Start inbound calls in this process (`bootstrap/agency.ts`): the startup sweep, THEN the router
 * registered on the seam (so no call this process answers can be swept as a leftover), then the
 * periodic sweep. With `connect` (P2) the connector is built beside the router, put in the agency
 * runtime (`attachInbound`: the release hook, the `available` listener, the station close) and
 * started, and the outcome-lapse sweep runs every {@link INBOUND_LAPSE_SWEEP_INTERVAL_MS}.
 *
 * The stop, synchronously before its first await: unregisters the router (arriving calls hear the
 * fallback message), stops the sweeps and detaches the connector. Then it ends every call this
 * process still holds (the connector's and the router's own message and voicemail sequences)
 * `service_shutdown`, as the bridge's graceful shutdown would, and waits for them to settle (a
 * caller nobody took: `failed` with its Missed row and callback, IQ18; an answered one: owing its
 * outcome), at most {@link INBOUND_SHUTDOWN_DRAIN_MS}. Ended later, by the voice stop, their settles
 * raced the database pool's close and the next start's sweep wrote them instead.
 */
export async function startInboundCalls(deps: Omit<AgencyInboundCallRouterDeps, 'bridge' | 'connect'> & {
  bridge: AgencyInboundCallRouterDeps['bridge'] & InboundConnectorDeps['bridge'];
  sweepIntervalMs?: number;
  connect?: InboundConnectOptions;
  /** The stop's bound on waiting for the calls it ends (tests). */
  shutdownDrainMs?: number;
}): Promise<{
  router: AgencyInboundCallRouter;
  connector: InboundConnector | null;
  stop: () => Promise<void>;
}> {
  const { connect: connectOpts, ...routerDeps } = deps;
  const connectDeps = connectOpts
    ? {
      connector: null as InboundConnector | null,
      enabled: connectOpts.enabled,
      mediaWorkers: connectOpts.mediaWorkers,
      dialer: connectOpts.runtime.dialer,
    }
    : undefined;
  const router = new AgencyInboundCallRouter({ ...routerDeps, ...(connectDeps ? { connect: connectDeps } : {}) });
  let connector: InboundConnector | null = null;
  if (connectOpts && connectDeps) {
    const { runtime } = connectOpts;
    connector = new InboundConnector({
      bridge: deps.bridge,
      stations: runtime.stations,
      agents: runtime.agents,
      releaseAgent: (sessionId) => runtime.dialer.releaseAgent(sessionId),
      exits: router,
      ...connectOpts.connector,
    });
    connectDeps.connector = connector;
  }
  const now = deps.now ?? (() => new Date());
  try {
    const swept = await router.sweep(now());
    if (swept > 0) log.warn({ swept }, 'Ended inbound calls left open by a restart');
  } catch (err) {
    log.error({ err }, 'Startup sweep of inbound calls failed — the periodic sweep retries');
  }
  if (connector && connectOpts) {
    connector.start();
    connectOpts.runtime.attachInbound(connector);
  }
  setInboundCallRouter(router);
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    router.sweep(new Date(now().getTime() - INBOUND_SWEEP_STALE_AFTER_MS))
      .then((swept) => { if (swept > 0) log.warn({ swept }, 'Ended stale inbound calls'); })
      .catch((err: unknown) => log.error({ err }, 'Periodic sweep of inbound calls failed'))
      .finally(() => { sweeping = false; });
  }, deps.sweepIntervalMs ?? INBOUND_SWEEP_INTERVAL_MS);
  timer.unref?.();
  // The outcome lapse (IQ11): answered calls whose outcome never came, closed `no_disposition`.
  let lapsing = false;
  const lapseTimer = connectOpts
    ? setInterval(() => {
      if (lapsing) return;
      lapsing = true;
      connectOpts.runtime.inboundCalls.sweepLapsed()
        .then((n) => { if (n > 0) log.info({ lapsed: n }, 'Closed inbound calls whose outcome lapsed'); })
        .catch((err: unknown) => log.error({ err }, 'Inbound outcome-lapse sweep failed'))
        .finally(() => { lapsing = false; });
    }, connectOpts.lapseSweepIntervalMs ?? INBOUND_LAPSE_SWEEP_INTERVAL_MS)
    : null;
  lapseTimer?.unref?.();
  return {
    router,
    connector,
    stop: async () => {
      clearInterval(timer);
      if (lapseTimer) clearInterval(lapseTimer);
      if (getInboundCallRouter() === router) setInboundCallRouter(null);
      if (connector && connectOpts) {
        connector.stop();
        connectOpts.runtime.attachInbound(null);
      }
      const held = router.liveCallIds();
      if (held.length === 0) return;
      log.info({ calls: held.length }, 'Ending inbound calls for shutdown');
      const settled = (async () => {
        await Promise.allSettled(held.map((id) => deps.bridge.forceEndWithOutcome(id, 'service_shutdown')));
        await Promise.all([router.drain(), connector?.drain()]);
      })().catch((err: unknown) => log.error({ err }, 'Ending inbound calls for shutdown failed'));
      const result = await withTimeoutOr(settled, deps.shutdownDrainMs ?? INBOUND_SHUTDOWN_DRAIN_MS, 'timeout' as const);
      if (result === 'timeout') {
        log.warn({ calls: router.liveCallIds().length }, 'Inbound calls still settling at shutdown — the next start\'s sweep ends them');
      }
    },
  };
}
