/**
 * `away_ring`: the away break whose phone is rung for inbound callers (Mode B, IQ58–IQ74,
 * docs/inbound.md "Ringing an away phone"). The runtime owns one {@link AwayRingService}
 * (`runtime.awayRing`); the session routes, the push-device routes, the dialer's release, the
 * station rehydrate and the bootstrap's reconcile go through it, and the inbound connector's ring
 * ends each unanswered ring with {@link AwayRingService.releaseInbound}.
 *
 * The state lives in two places, written in this order:
 *  - Redis (`agent-state-machine.ts`): `state = break, ring = 1`, a key no heartbeat renews, whose
 *    TTL is the time left to the maximum age (IQ67, N2);
 *  - the mirror (`agency_agent_sessions`): `break/away_ring`, and `away_ring_since`, the start of
 *    this absence, which survives the rings (each rewrites `state_since`) and the restart's
 *    `markAllOffline`, and keys the reconcile (N1).
 *
 * Every END of `away_ring` (IQ67) is `device_away`, then `offline` when no station socket is here
 * (as `device_away` with no socket always ends), with `away_ring_since` cleared and, when the
 * server ended it, a `ring_off` push (`reason`, and `away_since`: the absence it ends) so the
 * phone's "rings this phone" notification never lies. `away_ring → device_away` is a switch
 * inside ONE absence, so it keeps the absence's start as `since` (Redis, the `agent_state` frame,
 * the mirror's `state_since`): the app measures its 30 s return and "who rang while you were
 * away" from it. Only the `offline` arm starts a new state. A ring in flight (the session holds an inbound call, or the connector holds a push
 * offer for it) is never ended here: its end is the connector's, on the call's own chain (N1).
 */
import { createChildLogger } from '@magick-agency/observability';
import { trackAwayRingEnded, type AwayRingEndedReason } from '@magick-agency/observability/metrics/agency';
import type { BreakRegistry } from '@magick-agency/domain/break-manager';
import {
  AGENCY_INBOUND_RING_MAX_MISSES,
  AWAY_RING_BREAK_REASON,
  DEVICE_AWAY_BREAK_REASON,
  type AgencyAgentState,
  type AgencyAwayRingRefusal,
  type AgencyAwayRingRefusalCode,
  type AgencyPushPlatform,
  type AgencyRingOffReason,
} from '@magick-agency/contracts/agency';
import { pushTokenOf, type PushDeviceRecord } from '@magick-agency/db/models/push-device.model';
import {
  agencyAgentSessionRepository,
  agencyPushDeviceRepository,
  type AgencyAwayRingCandidate,
  type AgencyRingableSession,
} from '../db/repositories/agency.repository.js';
import { isCampaignSession, type AgencyAgentSessionRecord } from '../db/models/agency.model.js';
import { getPushSender } from '../seams/push-sender.js';
import { FLAGS, getFeatureFlagService } from '../feature-flags/index.js';
import { platformAuditLogger } from '../audit/platform/audit-logger.js';
import { SYSTEM_AUDIT_ACTOR, type AuditActorFields } from '../audit/platform/audit-actor.js';
import { AGENCY_AWAY_RING_MAX_MS_DEFAULT } from '../config/blocks/agency.js';
import { AGENT_LEASE_MS, type AgentStateMachine } from './agent-state-machine.js';
import type { StationRegistry } from './station-registry.js';
import type { InboundConnector } from './inbound/inbound-connector.js';

const log = createChildLogger({ component: 'agency-away-ring' });

/**
 * How long a `ring_off` push may wait at the carrier for a phone that is offline. Short: a late
 * one could reach the phone after its NEXT absence began (it carries `away_since`, so the app
 * drops one older than the absence it shows), and a phone offline for longer finds out on its
 * next open anyway (its `ready` is not `away_ring`).
 */
export const RING_OFF_PUSH_TTL_MS = 10 * 60 * 1000;
/** How long a `test_ring` push may wait at the carrier: a test nobody sees within a minute is moot. */
export const TEST_RING_PUSH_TTL_MS = 60 * 1000;
/** The reconcile's period (IQ67): at boot, then every minute. */
export const AWAY_RING_RECONCILE_MS = 60_000;

/**
 * The states a queued `away_ring` is applied from by the release at the end of a call or wrap-up.
 * `offline` too: the app parks its socket once it has asked to go away, so a station that closed
 * during the wrap-up was written `offline` there, and the queued `away_ring` (the one break held
 * with no socket) must still apply at the wrap-up's end. With no key at all (that `offline` lease
 * lapsed during a long wrap-up) it is created ({@link AwayRingService.applyQueued}).
 */
const RELEASE_FROM_STATES: readonly AgencyAgentState[] = ['reserved', 'on_call', 'wrapup', 'available', 'break', 'offline'];

/** English fallback copy for each refusal; the app words each code itself. */
const REFUSAL_MESSAGES: Readonly<Record<AgencyAwayRingRefusalCode, string>> = {
  ring_not_allowed: 'Ringing your phone for inbound calls is not available. You are paused as away instead when you leave the app.',
  no_push_device: 'This phone is not registered to ring for inbound calls. You are paused as away instead when you leave the app.',
  ring_disabled: 'Ringing is turned off for this phone. You are paused as away instead when you leave the app.',
  push_unavailable: 'Your phone cannot be rung just now. You are paused as away instead when you leave the app.',
};

/** The 409 body for `code`. */
export function awayRingRefusalBody(code: AgencyAwayRingRefusalCode): AgencyAwayRingRefusal {
  return { error: 'Conflict', code, message: REFUSAL_MESSAGES[code] };
}

/**
 * Why the ring rule says a session's phone may not be rung ({@link AwayRingService.ringBlocks}), in
 * the order of the remedies (`AgencyAwayRingRefusalCode`, IQ65):
 *  - `not_campaign`: not a campaign session (IQ58);
 *  - `no_device`: no push device holds the session's station, or it is revoked, or it has no token
 *    for its platform;
 *  - `opted_out`: the agent has not turned ringing on for that device (IQ65);
 *  - `push_unconfigured`: the sender has no credentials for its platform;
 *  - `max_age`: the absence is past `AGENCY_AWAY_RING_MAX_MS` (IQ67);
 *  - `missed`: `AGENCY_INBOUND_RING_MAX_MISSES` missed rings in a row (IQ62), until a ring binds or
 *    the agent goes `available`.
 * The account's flags (IQ65) are the rule's other half, read once per account
 * ({@link AwayRingService.ringAllowed}).
 */
export type RingBlock = 'not_campaign' | 'no_device' | 'opted_out' | 'push_unconfigured' | 'max_age' | 'missed';

/** The session's side of the ring rule (a session row, or a reconcile candidate). */
export interface RingSessionFacts {
  campaign_id: string | null;
  /** The absence's start (null: not on one yet, as when entering). */
  away_ring_since: Date | null;
  ring_misses: number;
}

/** The device's side of the ring rule: the push device that holds the session's station. */
export interface RingDeviceFacts {
  platform: AgencyPushPlatform;
  revoked: boolean;
  ringEnabled: boolean;
  hasToken: boolean;
}

/** A device row's side of the ring rule (null: no device holds the station). */
export function ringDeviceOf(device: PushDeviceRecord | null): RingDeviceFacts | null {
  if (!device) return null;
  return { platform: device.platform, revoked: device.revoked_at !== null, ringEnabled: device.ring_enabled, hasToken: pushTokenOf(device) !== null };
}

/** A reconcile candidate's device, as the rule reads it (null: none holds the station). */
function ringDeviceOfCandidate(row: AgencyAwayRingCandidate): RingDeviceFacts | null {
  if (row.device_platform === null) return null;
  return {
    platform: row.device_platform,
    revoked: row.device_revoked === true,
    ringEnabled: row.device_ring_enabled === true,
    hasToken: row.device_has_token === true,
  };
}

/** The `away_ring` refusal for each block of the ring rule (IQ65's codes; the app pauses `device_away` on any). */
const REFUSAL_OF_BLOCK: Readonly<Record<RingBlock, AgencyAwayRingRefusalCode>> = {
  not_campaign: 'ring_not_allowed',
  no_device: 'no_push_device',
  opted_out: 'ring_disabled',
  push_unconfigured: 'push_unavailable',
  max_age: 'ring_not_allowed',
  // The agent was told why the phone stopped (`ring_off`, `ring_missed`); asking again before going
  // `available` is refused as ringing that is not available, with no news for the app to show.
  missed: 'ring_not_allowed',
};

/** How an end of `away_ring` came out ({@link AwayRingService.end}). */
export type AwayRingEndOutcome =
  /** Ended: `device_away` (or `offline`), the mirror written, `ring_off` sent when asked. */
  | 'ended'
  /** A ring is in flight: its end is the connector's, nothing written. */
  | 'ring_in_flight'
  /** The session was not on `away_ring` (something else ended it first): nothing written. */
  | 'not_away_ring'
  /** Redis did not answer: nothing written. */
  | 'unavailable';

/** {@link AwayRingService.end}'s options. */
export interface AwayRingEndOptions {
  /** Write `offline` (default: no station socket here, read right before the Redis write). */
  offline?: boolean;
  actor?: AuditActorFields;
  /** The absence's start when the caller has it (default: read from the session row). */
  absenceSince?: Date | null;
  /**
   * With no `reason`: what `agency_away_ring_ended_total` counts this end as. `returned` for the
   * agent's return and the app's own `device_away`; left out, the end is not counted (an end no
   * label says truly: a session that should never have been on an absence, a stale call row).
   */
  countAs?: Extract<AwayRingEndedReason, 'returned'>;
}

/** {@link AwayRingService.releaseInbound}'s options. */
export interface AwayRingReleaseOptions {
  /**
   * The caller ends the absence itself right after (a reason of its own): a queued `device_away`
   * is taken but not applied here, since that end is `device_away` too.
   */
  ending?: boolean;
}

/** How {@link AwayRingService.releaseInbound} came out. */
export type AwayRingReleaseOutcome =
  /** Back on `away_ring` (Redis and the mirror). */
  | 'away_ring'
  /**
   * The call held the session, but its absence had ended meanwhile (a take-over, the maximum age):
   * the `inbound` field was cleared and the session ended as `device_away` (or `offline`).
   */
  | 'ended'
  /** The session was not on an absence at all (`away_ring_since` NULL, or it left): nothing written. */
  | 'not_away_ring'
  /** The call does not hold the session: nothing written. */
  | 'not_held';

/** What one reconcile pass did ({@link AwayRingService.reconcile}). */
export interface AwayRingReconcileSummary {
  candidates: number;
  ended: number;
  reseeded: number;
  restored: number;
  skippedInFlight: number;
  cleared: number;
}

export interface AwayRingServiceDeps {
  agents: AgentStateMachine;
  stations: StationRegistry;
  /** The inbound connector while one runs (the runtime's `inbound`). */
  inbound: () => InboundConnector | null;
  /**
   * The runtime's break queue: the app's own pauses queued behind a ring (`device_away`,
   * `away_ring`) are settled by the ring's end ({@link AwayRingService.releaseInbound}). Without it
   * (a harness) nothing queued is read.
   */
  breaks?: Pick<BreakRegistry, 'peek' | 'take'>;
  /** Both flags on for the account (IQ65). Default: the feature-flag service. */
  ringAllowed?: (tenantId: string, accountId: string) => Promise<boolean>;
}

async function flagsAllowRing(tenantId: string, accountId: string): Promise<boolean> {
  const flags = getFeatureFlagService();
  const [ring, inbound] = await Promise.all([
    flags.isEnabled(FLAGS.agency_inbound_ring_enabled, { tenantId, accountId }),
    flags.isEnabled(FLAGS.agency_inbound_enabled, { tenantId, accountId }),
  ]);
  return ring && inbound;
}

export class AwayRingService {
  private maxAge = AGENCY_AWAY_RING_MAX_MS_DEFAULT;
  private reconciling: Promise<AwayRingReconcileSummary> | null = null;
  /** The reconcile's timer ({@link startReconcile}); null when not running. */
  private reconcileTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Work started and not awaited (the `ring_off` pushes): {@link drain} and {@link stop} wait for it. */
  private readonly background = new Set<Promise<unknown>>();
  private readonly ringAllowedFn: (tenantId: string, accountId: string) => Promise<boolean>;

  constructor(private readonly deps: AwayRingServiceDeps) {
    this.ringAllowedFn = deps.ringAllowed ?? flagsAllowRing;
  }

  /** Set at start from config (`AGENCY_AWAY_RING_MAX_MS`). */
  configure(opts: { maxAgeMs: number }): void {
    this.maxAge = opts.maxAgeMs;
  }

  /** The time left to the maximum age of an absence that began at `since` (null: one starting now). */
  ttlLeft(since: Date | null, now = Date.now()): number {
    return this.maxAge - (since ? Math.max(0, now - since.getTime()) : 0);
  }

  /** Both flags on for the account (IQ65). A flag read that fails reads as off. */
  async ringAllowed(tenantId: string, accountId: string): Promise<boolean> {
    return this.ringAllowedFn(tenantId, accountId).catch((err: unknown) => {
      log.warn({ err, tenantId, accountId }, 'Could not read the ring flags; treating ringing as off');
      return false;
    });
  }

  // ─── The ring rule (IQ58, IQ62, IQ65, IQ67): who may be rung, in ONE place ───────────
  //
  // The session's and the device's side is {@link ringBlocks}; the account's flags are
  // {@link ringAllowed}. Every reader applies both: the `away_ring` entry ({@link refusalFor}), the
  // inbound search ({@link ringableSessions}), the ring as it starts ({@link ringableDevice}) and the
  // reconcile ({@link reconcile}), so a session admitted to `away_ring` is one the search rings, and
  // one the search will not ring any more is ended by the reconcile.

  /**
   * Every reason the rule refuses to ring the session's phone, in the order of the remedies
   * ({@link RingBlock}); empty: it may be rung, as far as the session and its device tell.
   */
  ringBlocks(session: RingSessionFacts, device: RingDeviceFacts | null, now = Date.now()): RingBlock[] {
    const blocks: RingBlock[] = [];
    if (session.campaign_id === null) blocks.push('not_campaign');
    if (!device || device.revoked || !device.hasToken) blocks.push('no_device');
    else if (!device.ringEnabled) blocks.push('opted_out');
    if (device && !getPushSender().configured(device.platform)) blocks.push('push_unconfigured');
    if (this.ttlLeft(session.away_ring_since, now) <= 0) blocks.push('max_age');
    if (session.ring_misses >= AGENCY_INBOUND_RING_MAX_MISSES) blocks.push('missed');
    return blocks;
  }

  /** The rule's session-and-device half lets the session's phone be rung ({@link ringBlocks} is empty). */
  canRing(session: RingSessionFacts, device: RingDeviceFacts | null, now = Date.now()): boolean {
    return this.ringBlocks(session, device, now).length === 0;
  }

  /**
   * The inbound search's read (`InboundConnectorDeps.ringables`' default): the account's sessions
   * on an absence whose phone the rule lets ring now. Both flags on, then the account's candidates
   * (`findAwayRingCandidates`, one statement), then {@link canRing}.
   */
  async ringableSessions(tenantId: string, accountId: string): Promise<AgencyRingableSession[]> {
    if (!(await this.ringAllowed(tenantId, accountId))) return [];
    const rows = await agencyAgentSessionRepository.findAwayRingCandidates({ tenantId, accountId });
    const now = Date.now();
    return rows.flatMap((r): AgencyRingableSession[] => {
      if (r.campaign_id === null || r.device_platform === null || !this.canRing(r, ringDeviceOfCandidate(r), now)) return [];
      return [{ id: r.id, agent_user_id: r.agent_user_id, campaign_id: r.campaign_id, device_platform: r.device_platform }];
    });
  }

  /**
   * The device to ring for the session, read again as a ring starts (the search read the session
   * ringable a moment ago): the push device that holds its station if the rule ({@link canRing}) still
   * lets it ring; null otherwise. The flags are the search's read of a moment ago (a flag turned
   * off ends the absence at the reconcile, which cancels the ring, N1). A failed read rejects.
   */
  async ringableDevice(sessionId: string): Promise<PushDeviceRecord | null> {
    const [session, device] = await Promise.all([
      agencyAgentSessionRepository.findById(sessionId),
      agencyPushDeviceRepository.findForSession(sessionId),
    ]);
    if (!session || session.left_at || !device) return null;
    return this.canRing(session, ringDeviceOf(device)) ? device : null;
  }

  /**
   * The connector's synchronous answer: the session holds a push offer (a ring, or an answered
   * ring in its accept grace). False while no connector runs.
   */
  holdsPushOffer(sessionId: string): boolean {
    return this.deps.inbound()?.holdsPushOffer(sessionId) ?? false;
  }

  /**
   * Why `away_ring` is refused for `session`, or null: it may enter. The ring rule's first block
   * ({@link ringBlocks}), in the order of the remedies (IQ58, IQ65; `AgencyAwayRingRefusalCode`): not
   * a campaign session or the flags off (`ring_not_allowed`); no usable registration for the
   * station's device (none, revoked, no token: `no_push_device`); not opted in (`ring_disabled`);
   * the sender has no credentials for the platform (`push_unavailable`). An absence already past its
   * maximum age, or an agent at the maximum missed rings (IQ62: until they go `available`), is
   * `ring_not_allowed` too: the app pauses as `device_away` instead.
   */
  async refusalFor(session: AgencyAgentSessionRecord): Promise<AgencyAwayRingRefusalCode | null> {
    if (!isCampaignSession(session)) return 'ring_not_allowed';
    if (!(await this.ringAllowed(session.tenant_id, session.account_id))) return 'ring_not_allowed';
    const device = session.station_device_id
      ? await agencyPushDeviceRepository.find(session.agent_user_id, session.station_device_id)
      : null;
    const block = this.ringBlocks(session, ringDeviceOf(device))[0];
    return block ? REFUSAL_OF_BLOCK[block] : null;
  }

  /**
   * Enter `away_ring` from one of `fromStates` (the route's apply: `available`, or `break` for the
   * `device_away → away_ring` switch): Redis first (a compare-and-swap), then the mirror
   * (`break/away_ring`, `away_ring_since` stamped once per absence), then the station's
   * `agent_state` frame. The caller ran {@link refusalFor}.
   */
  async enter(
    session: AgencyAgentSessionRecord,
    fromStates: readonly AgencyAgentState[],
  ): Promise<{ ok: true; since: string } | { ok: false; reason: string; noKey?: boolean }> {
    const sinceMs = Date.now();
    const entered = await this.deps.agents.enterAwayRing(session.id, {
      ttlMs: this.ttlLeft(session.away_ring_since),
      fromStates,
      sinceMs,
    });
    if (!entered.ok) {
      return { ok: false, reason: entered.reason, ...(entered.reason === 'wrong_state' && entered.state === null ? { noKey: true } : {}) };
    }
    return { ok: true, since: await this.mirrorEntered(session.id, sinceMs) };
  }

  /** {@link applyQueued}'s entry over no key at all: created only if still absent, then mirrored. */
  private async enterWhereNoKey(session: AgencyAgentSessionRecord): Promise<{ ok: true; since: string } | { ok: false; reason: string; noKey?: boolean }> {
    const sinceMs = Date.now();
    const created = await this.deps.agents.reseedAwayRing(session.id, {
      sinceMs,
      ttlMs: this.ttlLeft(session.away_ring_since),
    });
    if (!created) return { ok: false, reason: 'wrong_state' };
    return { ok: true, since: await this.mirrorEntered(session.id, sinceMs) };
  }

  /**
   * After Redis entered `away_ring` with `since = sinceMs`: the mirror (`break/away_ring`,
   * `away_ring_since` stamped with the same instant once per absence) and the station's
   * `agent_state` frame. Answers the absence's start as the mirror holds it (an absence that was
   * already running keeps its start), the `since` the app is told.
   */
  private async mirrorEntered(sessionId: string, sinceMs: number): Promise<string> {
    const stored = await agencyAgentSessionRepository.enterAwayRing(sessionId, new Date(sinceMs));
    const since = (stored ?? new Date(sinceMs)).toISOString();
    this.deps.stations.send(sessionId, { event: 'agent_state', state: 'break', since, break_reason: AWAY_RING_BREAK_REASON });
    return since;
  }

  /**
   * The dialer's release applying a queued `away_ring` (`AgencyDialer.releaseAgent`): re-checked
   * (the flags or the device may have changed while it was queued), then entered from whatever
   * state the release found. Null when it cannot apply: the caller applies `device_away` instead.
   * No station socket is needed: this is the one break an agent holds without one.
   */
  async applyQueued(sessionId: string): Promise<{ state: 'break'; since: string } | null> {
    const session = await agencyAgentSessionRepository.findById(sessionId).catch((err: unknown) => {
      log.warn({ err, sessionId }, 'Could not read the session to apply a queued away-ring break');
      return null;
    });
    if (!session || session.left_at) return null;
    const refused = await this.refusalFor(session).catch((err: unknown) => {
      log.warn({ err, sessionId }, 'Could not check a queued away-ring break');
      return 'ring_not_allowed' as const;
    });
    if (refused) {
      log.info({ sessionId, refused }, 'Queued away-ring break no longer allowed; applying device_away instead');
      return null;
    }
    let entered = await this.enter(session, RELEASE_FROM_STATES);
    if (!entered.ok && entered.noKey) {
      // No key: the `offline` the station close wrote mid wrap-up lapsed before the wrap-up ended.
      // Created only if still absent (the re-seed's create-if-absent), then mirrored as `enter` does.
      entered = await this.enterWhereNoKey(session);
    }
    if (!entered.ok) {
      log.info({ sessionId, reason: entered.reason }, 'Queued away-ring break could not apply; applying device_away instead');
      return null;
    }
    return { state: 'break', since: entered.since };
  }

  /**
   * The connector: a push offer for `inboundCallId` ended unanswered (declined, expired, lapsed, the caller
   * left, the push failed, given back, answered elsewhere) while the agent has no open station:
   * the session goes back to `away_ring` (Redis: `inbound` cleared, `break, ring = 1`, a fresh
   * `since`, the TTL left to the maximum age; the mirror: `break/away_ring`, N1).
   *
   *  - `away_ring`: done.
   *  - `ended`: the call held the session but the absence had ended meanwhile (the take-over moved
   *    the station, the maximum age passed): the field is cleared and the session ends
   *    (`device_away`, or `offline` with no socket; `ring_off` with the reason when there is one).
   *  - `not_away_ring`: the session is not on an absence (never was, or it left). Nothing written:
   *    the connector returns the agent as Mode A does (`releaseInbound` + `releaseAgent`).
   *  - `not_held`: the call does not hold the session. Nothing written.
   *
   * The app's own pause queued behind the ring (`device_away` or `away_ring`, asked while the ring
   * held the session `reserved`) is settled here, never left for the release after the agent's
   * next call: a queued `away_ring` is what the session is back on, and a queued `device_away`
   * ends the absence as `device_away`, keeping its start (IQ76; no `ring_off`: the app asked),
   * unless the caller ends it with a reason of its own (`opts.ending`).
   */
  async releaseInbound(sessionId: string, inboundCallId: string, opts: AwayRingReleaseOptions = {}): Promise<AwayRingReleaseOutcome> {
    const session = await agencyAgentSessionRepository.findById(sessionId);
    if (!session || session.left_at || !session.away_ring_since) return 'not_away_ring';
    const ttl = this.ttlLeft(session.away_ring_since);
    // Past the maximum age mid-ring: back to `away_ring` for a moment (a 1 s key), then ended
    // `max_age` like any other end, so there is one path that writes an end.
    if (!(await this.deps.agents.releaseInboundToAwayRing(sessionId, inboundCallId, Math.max(ttl, 1000)))) return 'not_held';
    const queued = this.takeQueuedAwayPause(sessionId);
    if (!(await agencyAgentSessionRepository.restoreAwayRing(sessionId))) {
      // The absence ended between the read above and here (a take-over cleared its key).
      await this.end(sessionId, null);
      return 'ended';
    }
    if (ttl <= 0) {
      await this.end(sessionId, 'max_age');
      return 'ended';
    }
    if (queued === DEVICE_AWAY_BREAK_REASON && !opts.ending) {
      log.info({ sessionId, inboundCallId }, 'A device_away queued behind a ring applies at its end');
      await this.end(sessionId, null, { offline: false, countAs: 'returned' });
      return 'ended';
    }
    return 'away_ring';
  }

  /**
   * Take the app's own pause queued for the session, if it is one of the two away breaks
   * (`device_away`, `away_ring`); another break (the agent's choice) stays queued. The code taken.
   */
  takeQueuedAwayPause(sessionId: string): typeof DEVICE_AWAY_BREAK_REASON | typeof AWAY_RING_BREAK_REASON | null {
    const code = this.deps.breaks?.peek(sessionId)?.code;
    if (code !== DEVICE_AWAY_BREAK_REASON && code !== AWAY_RING_BREAK_REASON) return null;
    this.deps.breaks!.take(sessionId);
    return code;
  }

  /**
   * The app asked `device_away` while the session holds a push offer (`POST /sessions/:id/break`,
   * the away notification's "Stop ringing", IQ79): the connector's
   * `InboundConnector.declineRingForDeviceAway`, on the call's chain. A ring not yet answered is
   * the agent saying no to it: declined (`declined`, never a miss), and the absence ended as
   * `device_away` keeping its start (`declined`). An answered ring is the agent taking the call
   * (`answered`): the pause queues behind it as behind any call. `none`: no push offer.
   */
  async declineRingForDeviceAway(sessionId: string): Promise<'declined' | 'answered' | 'none'> {
    return (await this.deps.inbound()?.declineRingForDeviceAway(sessionId)) ?? 'none';
  }

  /**
   * End `away_ring` (IQ67): `device_away`, then `offline` when no station socket is here. Redis
   * first, by the end script (only from `break, ring = 1`, or no key at all), then the mirror
   * (`away_ring_since` cleared), the station's frame when one is attached, the `ring_off` push
   * (`reason`; null: none, the app itself asked or is on screen) and the audit row.
   *
   * `offline` defaults to "no station socket here", read synchronously right before the script's
   * eval, as the station close reads it; a caller that is about to attach one (the return, the
   * take-over) passes false.
   *
   * A ring in flight is never ended here (`ring_in_flight`): its end is the connector's, on the
   * call's own chain (N1). {@link endOrCancelRing} goes through
   * `InboundConnector.cancelRingForAwayRingEnd`, which cancels the ring and then calls this.
   */
  async end(
    sessionId: string,
    reason: AgencyRingOffReason | null,
    opts: AwayRingEndOptions = {},
  ): Promise<AwayRingEndOutcome> {
    return (await this.endKeepingSince(sessionId, reason, opts)).outcome;
  }

  /**
   * {@link end}, also answering the `since` the session now has when it ended on `break`
   * (`device_away`): the absence's start, kept. The device-away route answers it.
   */
  async endKeepingSince(
    sessionId: string,
    reason: AgencyRingOffReason | null,
    opts: AwayRingEndOptions = {},
  ): Promise<{ outcome: AwayRingEndOutcome; since?: string }> {
    // The absence's start, read first: Redis keeps it as `since` on the `device_away` it writes.
    const absenceSince = opts.absenceSince !== undefined ? opts.absenceSince : await this.absenceStartOf(sessionId);
    if (this.holdsPushOffer(sessionId)) return { outcome: 'ring_in_flight' };
    // Read and eval with nothing awaited between them (the station close's rule).
    const offline = opts.offline ?? !this.deps.stations.isLocallyOwned(sessionId);
    const redis = await this.deps.agents.endAwayRing(sessionId, { offline, absenceSinceMs: absenceSince?.getTime() ?? null });
    if (redis.outcome === 'unavailable') return { outcome: 'unavailable' };
    if (redis.outcome === 'not_away_ring') {
      const live = await this.deps.agents.get(sessionId);
      return { outcome: live?.inboundCallId ? 'ring_in_flight' : 'not_away_ring' };
    }
    const ended = await agencyAgentSessionRepository.endAwayRing(sessionId, offline ? 'offline' : 'break');
    if (!ended) return { outcome: 'not_away_ring' };
    const awaySince = ended.away_since ?? absenceSince;
    // `taken_over` is counted where its `ring_off` is sent ({@link sendRingOff}): the take-over and
    // the leaves end the absence outside this method. An end with no reason counts as its caller
    // says (`countAs`), or not at all.
    if (reason !== null && reason !== 'taken_over') trackAwayRingEnded(reason);
    else if (reason === null && opts.countAs) trackAwayRingEnded(opts.countAs);
    const since = offline ? undefined : (awaySince ?? new Date()).toISOString();
    if (since) {
      this.deps.stations.send(sessionId, { event: 'agent_state', state: 'break', since, break_reason: DEVICE_AWAY_BREAK_REASON });
    }
    if (reason) {
      this.sendRingOff(ended.agent_user_id, ended.station_device_id, sessionId, reason, awaySince);
      const actor = opts.actor ?? SYSTEM_AUDIT_ACTOR;
      platformAuditLogger.log({
        ...actor,
        tenant_id: ended.tenant_id,
        account_id: ended.account_id,
        action: 'agency_session.away_ring_ended',
        resource_type: 'agency_session',
        resource_id: sessionId,
        ...(ended.campaign_id ? { campaign_id: ended.campaign_id } : {}),
        details: {
          reason,
          from_state: ended.from_state,
          to_state: offline ? 'offline' : 'break',
          ...(ended.campaign_id ? { campaign_id: ended.campaign_id } : {}),
        },
      });
    }
    log.info({ sessionId, reason, offline }, 'Away-ring ended');
    return { outcome: 'ended', ...(since ? { since } : {}) };
  }

  /** The session's `away_ring_since` (the absence's start), or null: none, or the read failed. */
  private async absenceStartOf(sessionId: string): Promise<Date | null> {
    const row = await agencyAgentSessionRepository.findById(sessionId).catch((err: unknown) => {
      log.warn({ err, sessionId }, 'Could not read the absence start to end away-ring');
      return null;
    });
    return row?.away_ring_since ?? null;
  }

  /**
   * A push offer ended while its absence had already been ended by what ended the ring (the
   * take-over's claim rewrote the mirror to `device_away` and cleared `away_ring_since`): the
   * call's `inbound` field cleared and the session left on `break`, the mirror on `device_away`,
   * both keeping `since` at the absence's start (`absenceSince`, the claim's; now when unknown).
   * The new station's attach shows it. No `ring_off`: the take-over sends its own.
   */
  async endAfterRing(sessionId: string, inboundCallId: string, absenceSince: Date | null): Promise<void> {
    await this.deps.agents.releaseInbound(sessionId, inboundCallId);
    const sinceMs = absenceSince?.getTime();
    await this.deps.agents.set(sessionId, 'break', { leaseMs: AGENT_LEASE_MS.break, ...(sinceMs !== undefined ? { sinceMs } : {}) });
    await agencyAgentSessionRepository.setState(sessionId, 'break', DEVICE_AWAY_BREAK_REASON, { stateSince: absenceSince })
      .catch((err: unknown) => log.warn({ err, sessionId }, 'Could not mirror a ring ended with its absence'));
  }

  /**
   * The agent came back to the app (a station attach, or a join, rehydrating a `break, ring = 1`
   * key: N5's "clears ring only when the state is break"): `device_away`, the station about to
   * show it. No `ring_off`: the app is on screen and drops its own notification.
   */
  async endOnReturn(sessionId: string): Promise<AwayRingEndOutcome> {
    return this.end(sessionId, null, { offline: false, countAs: 'returned' });
  }

  /**
   * OS3's take-over moved the station off the device it rang (the claim already rewrote the
   * mirror, `claimStationDevice`'s `endedAwayRing`): Redis's `ring` cleared (`break`: the new
   * device is attaching), and the old device told (`ring_off`, `taken_over`).
   */
  async endOnTakeOver(
    sessionId: string,
    agentUserId: string,
    previousDeviceId: string | null,
    awaySince: Date | null = null,
  ): Promise<void> {
    if (this.holdsPushOffer(sessionId)) {
      // The ring in flight is the connector's to cancel, on the call's chain (`answered_elsewhere`;
      // an answered one too: the device that answered no longer holds the station). It leaves the
      // agent on a plain break for the new device's attach, `since` kept at the absence's start.
      const cancelled = await this.deps.inbound()?.cancelRingForAwayRingEnd(sessionId, 'taken_over', { absenceSince: awaySince });
      log.info({ sessionId, cancelled }, 'Take-over during a ring: the ring was cancelled');
    } else {
      const redis = await this.deps.agents.endAwayRing(sessionId, { offline: false, absenceSinceMs: awaySince?.getTime() ?? null });
      if (redis.outcome === 'not_away_ring') {
        log.info({ sessionId, state: redis.state }, 'Take-over ended away-ring: Redis was already off it');
      }
    }
    this.sendRingOff(agentUserId, previousDeviceId, sessionId, 'taken_over', awaySince);
  }

  /**
   * The opt-out (the Me toggle, `PATCH ring_enabled=false`, `opted_out`) or the device removed (`DELETE`,
   * `revoked`): end the `away_ring` of the agent's live session whose station this device holds,
   * if there is one. A ring in flight is left to the connector (and to the next reconcile, which
   * finds the device opted out or revoked).
   */
  async endForDevice(
    agentUserId: string,
    deviceId: string,
    reason: 'opted_out' | 'revoked',
    actor?: AuditActorFields,
  ): Promise<AwayRingEndOutcome | 'none'> {
    const session = await agencyAgentSessionRepository.findLiveAwayRingForDevice(agentUserId, deviceId);
    if (!session) return 'none';
    return this.endOrCancelRing(session.id, reason, { ...(actor ? { actor } : {}) });
  }

  /**
   * {@link end}, or, while the session holds a push offer, the connector's cancel of that ring on
   * the call's chain first (N1: never a direct state write during a ring): a ring not yet answered
   * is cancelled and the absence ended with `reason` (`ended`); an answered one runs to its end
   * (`ring_in_flight`; the next reconcile finds the absence to end).
   */
  async endOrCancelRing(
    sessionId: string,
    reason: AgencyRingOffReason,
    opts: { actor?: AuditActorFields } = {},
  ): Promise<AwayRingEndOutcome> {
    const connector = this.deps.inbound();
    if (connector && this.holdsPushOffer(sessionId)) {
      const out = await connector.cancelRingForAwayRingEnd(sessionId, reason);
      return out === 'cancelled' ? 'ended' : out === 'answered' ? 'ring_in_flight' : this.end(sessionId, reason, opts);
    }
    return this.end(sessionId, reason, opts);
  }

  /**
   * Send `ring_off` to the device (not awaited, never throws; tracked, so {@link drain} and
   * {@link stop} wait for it): Android only (iOS gets no push that is not a call, IQ64), and only
   * to a row with a token, revoked or not (a removed device still drops its notification). It
   * names the absence it ends (`away_since`), and the carrier holds it {@link RING_OFF_PUSH_TTL_MS}
   * at most. A failure is recorded on the row (a refused token revokes it).
   */
  sendRingOff(
    agentUserId: string,
    deviceId: string | null,
    sessionId: string,
    reason: AgencyRingOffReason,
    awaySince: Date | null,
  ): void {
    // The take-over and the leaves end an absence outside `end` and tell the phone here: counted
    // here, once per absence, device or none.
    if (reason === 'taken_over') trackAwayRingEnded('taken_over');
    if (!deviceId) return;
    this.track((async () => {
      const device = await agencyPushDeviceRepository.find(agentUserId, deviceId);
      if (!device || device.platform !== 'android' || pushTokenOf(device) === null) return;
      await this.send(device, {
        type: 'ring_off',
        session_id: sessionId,
        reason,
        ...(awaySince ? { away_since: awaySince.toISOString() } : {}),
      }, RING_OFF_PUSH_TTL_MS);
    })().catch((err: unknown) => log.warn({ err, sessionId, reason }, 'Could not send ring_off')));
  }

  /** Keep `work` (which never rejects) until it settles, so {@link drain} waits for it. */
  private track(work: Promise<unknown>): void {
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  /** Wait for the work started and not awaited (the `ring_off` pushes in flight). */
  async drain(): Promise<void> {
    for (let i = 0; i < 10 && this.background.size > 0; i++) await Promise.allSettled([...this.background]);
  }

  /** Run the reconcile every {@link AWAY_RING_RECONCILE_MS} (the bootstrap, after the boot pass). */
  startReconcile(periodMs = AWAY_RING_RECONCILE_MS): void {
    if (this.reconcileTimer || this.stopped) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((err: unknown) => log.warn({ err }, 'Away-ring reconcile failed — the next pass will retry'));
    }, periodMs);
    this.reconcileTimer.unref?.();
  }

  /**
   * Shutdown: no new reconcile pass (the timer stops at once, before any await), then the pass in
   * flight and the pushes in flight are awaited. Before the runtime and the platform stop, so the
   * push sender and the pool are still there for them.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    await this.reconciling?.catch(() => undefined);
    await this.drain();
  }

  /** Send one push to `device`, recording a failure on its row. Resolves with the sender's answer. */
  async send(
    device: PushDeviceRecord,
    payload: Parameters<ReturnType<typeof getPushSender>['send']>[1],
    ttlMs: number,
  ): ReturnType<ReturnType<typeof getPushSender>['send']> {
    const result = await getPushSender().send(device, payload, { ttlMs });
    if (!result.ok && result.reason !== 'unconfigured') {
      await agencyPushDeviceRepository.recordFailure(device.id, result.reason).catch((err: unknown) =>
        log.warn({ err, deviceRowId: device.id }, 'Could not record a push failure'));
    }
    if (!result.ok) log.info({ deviceRowId: device.id, type: payload.type, reason: result.reason }, 'Push not delivered');
    return result;
  }

  // ─── The reconcile (IQ67, N1): at boot, then every minute ──────────────────

  /**
   * One pass over every live session with `away_ring_since` set (N1; never keyed on
   * `break_reason`, which a ring's `reserved` nulls):
   *  - a ring in flight (the connector holds a push offer, or Redis an `inbound` field): skipped,
   *    unless the absence must end (below) while the connector holds the ring: then the ring is
   *    cancelled on the call's chain (`InboundConnector.cancelRingForAwayRingEnd`) and the absence
   *    ended there (an answered ring runs to its end and the next pass ends the absence);
   *  - the ring rule refusing it (past the maximum age, the flags off, the device gone, revoked or
   *    without a token, opted out, the maximum missed rings): ended (`max_age`, `flag_off`,
   *    `revoked`, `opted_out`, `ring_missed`), `ring_off` sent;
   *  - otherwise live but its Redis key gone (a restart that outlived the lease, a crash mid-ring
   *    whose `reserved` lease lapsed): re-seeded, create-if-absent, and the mirror restored;
   *  - on `away_ring` in Redis while the mirror says otherwise (the startup reaper's
   *    `markAllOffline`): the mirror restored;
   *  - off `away_ring` in Redis with nothing in flight: whatever moved it ended the absence, and
   *    only the key in the mirror is cleared.
   * Passes never overlap: a call while one runs gets that pass's summary.
   */
  reconcile(now = Date.now()): Promise<AwayRingReconcileSummary> {
    if (this.stopped && !this.reconciling) {
      return Promise.resolve({ candidates: 0, ended: 0, reseeded: 0, restored: 0, skippedInFlight: 0, cleared: 0 });
    }
    if (!this.reconciling) {
      this.reconciling = this.reconcileOnce(now).finally(() => { this.reconciling = null; });
    }
    return this.reconciling;
  }

  private async reconcileOnce(now: number): Promise<AwayRingReconcileSummary> {
    const summary: AwayRingReconcileSummary = { candidates: 0, ended: 0, reseeded: 0, restored: 0, skippedInFlight: 0, cleared: 0 };
    const rows = await agencyAgentSessionRepository.findAwayRingCandidates();
    summary.candidates = rows.length;
    const allowed = new Map<string, Promise<boolean>>();
    for (const row of rows) {
      try {
        await this.reconcileOne(row, now, allowed, summary);
      } catch (err) {
        log.warn({ err, sessionId: row.id }, 'Away-ring reconcile failed for a session');
      }
    }
    if (summary.ended || summary.reseeded || summary.restored || summary.cleared) {
      log.info(summary, 'Away-ring reconcile acted');
    }
    return summary;
  }

  private async reconcileOne(
    row: AgencyAwayRingCandidate,
    now: number,
    allowed: Map<string, Promise<boolean>>,
    summary: AwayRingReconcileSummary,
  ): Promise<void> {
    if (this.holdsPushOffer(row.id)) {
      const reason = await this.endReasonFor(row, now, allowed);
      if (reason && (await this.endOrCancelRing(row.id, reason)) === 'ended') summary.ended++;
      else summary.skippedInFlight++;
      return;
    }
    const live = await this.deps.agents.get(row.id);
    if (live?.inboundCallId) {
      summary.skippedInFlight++;
      return;
    }
    if (row.kind !== 'campaign') {
      // Unreachable: `away_ring` is refused to a non-campaign session (`refusalFor`), a live row
      // never changes its kind, and such a session is never rung (the ring rule). Ended
      // all the same, with no `ring_off`: no reason the app words would be true (`flag_off` would
      // tell the agent the account switched ringing off), and not counted: no label says it.
      log.warn({ sessionId: row.id, kind: row.kind }, 'A non-campaign session was on away-ring; ending it');
      if ((await this.end(row.id, null)) === 'ended') summary.ended++;
      return;
    }
    const reason = await this.endReasonFor(row, now, allowed);
    if (reason) {
      if ((await this.end(row.id, reason)) === 'ended') summary.ended++;
      return;
    }
    const mirrorOnIt = row.state === 'break' && row.break_reason === AWAY_RING_BREAK_REASON;
    if (!live) {
      const created = await this.deps.agents.reseedAwayRing(row.id, {
        sinceMs: row.state_since.getTime(),
        ttlMs: this.ttlLeft(row.away_ring_since, now),
      });
      if (created) {
        summary.reseeded++;
        if (!mirrorOnIt) await agencyAgentSessionRepository.restoreAwayRing(row.id);
        log.info({ sessionId: row.id }, 'Away-ring key re-seeded from the database');
      }
      return;
    }
    if (live.state === 'break' && live.ring) {
      if (!mirrorOnIt && (await agencyAgentSessionRepository.restoreAwayRing(row.id))) summary.restored++;
      return;
    }
    // Only the absence this pass read: a new one entered since (a fresh `away_ring_since`) stays.
    if (await agencyAgentSessionRepository.clearAwayRingSince(row.id, row.away_ring_since)) summary.cleared++;
  }

  /**
   * Why the reconcile ends this absence, or null: it may go on. The ring rule ({@link ringBlocks}
   * and the flags), with the `ring_off` reason each block ends it with: past its age first, then a
   * flag off, then the device (gone, revoked or tokenless; opted out), then the misses (IQ62: an
   * end owed by a miss and lost, a ring in flight then or Redis away). A sender with no credentials
   * for the platform ends nobody: it is the deployment's, no `ring_off` reason says it, and the
   * absence ends at its maximum age.
   */
  private async endReasonFor(
    row: AgencyAwayRingCandidate,
    now: number,
    allowed: Map<string, Promise<boolean>>,
  ): Promise<AgencyRingOffReason | null> {
    const blocks = this.ringBlocks(row, ringDeviceOfCandidate(row), now);
    if (blocks.includes('max_age')) return 'max_age';
    const flagKey = `${row.tenant_id}:${row.account_id}`;
    let ok = allowed.get(flagKey);
    if (!ok) {
      // A flag read that FAILS ends nobody's ringing: only a flag read as off does.
      ok = this.ringAllowedFn(row.tenant_id, row.account_id).catch((err: unknown) => {
        log.warn({ err, tenantId: row.tenant_id, accountId: row.account_id }, 'Could not read the ring flags in the reconcile');
        return true;
      });
      allowed.set(flagKey, ok);
    }
    if (!(await ok)) return 'flag_off';
    if (blocks.includes('no_device')) return 'revoked';
    if (blocks.includes('opted_out')) return 'opted_out';
    if (blocks.includes('missed')) return 'ring_missed';
    return null;
  }
}
