/**
 * `ManualDialer`: places a soft-phone call and owns it until it ends
 * (docs/softphone.md §4.1 steps 4–6, 9). Owned by `AgencyRuntime`, started and
 * stopped with it. The checks before the dial, the row insert and the Redis claim
 * are `SoftphoneService.placeCall`'s; this takes a committed, claimed row and
 * dials it.
 *
 * - **Agent first.** `createBridgedCall` with the session's station socket and the
 *   correlation `{ kind: 'manual', manualCallId }`, so the agent's leg is attached
 *   before the carrier is contacted, and the bridge hangs up at once if the
 *   station closes before the answer (`browserCloseGraceMs` is answer-anchored for
 *   a manual leg; after the answer the deferred-hangup window applies, so a wifi
 *   blip mid-conversation survives through {@link reattachStation}).
 * - **Lifecycle → rows → frames.** Every bridge event for the call is applied to
 *   the row (`advanceState`, forward-only; `end`) in arrival order — one promise
 *   chain per call — and every change sends the `manual_call` frame with the whole
 *   wire row (contact `context` and `prior_attempts` included).
 * - **Ended.** The classified outcome (`classifyAttemptOutcome`, the attempt's
 *   classifier) and why; a call that never bridged owes no outcome and settles at
 *   once — the row, the roster contact (`settleFromManual` with no decision: back
 *   to `pending`, one attempt charged when the dial was placed) and then the
 *   Redis claim. A bridged call waits for its outcome; its claim is kept.
 * - **A dial the bridge refused before the carrier** (concurrency, a dead socket)
 *   is ended `failed`, its contact claim RELEASED (no attempt charged: nothing was
 *   dialled) and the Redis claim cleared; the caller answers the refusal.
 */
import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import { getPool } from '@magick-agency/db';
import type {
  AgencyManualCall,
  AgencyManualCallEndReason,
  AgencyManualCallOutcome,
  AgencyPriorAttempt,
} from '@magick-agency/contracts/agency';
import { WebRtcCallError } from '../../core/webrtc-bridge-manager.js';
import type { WebRtcBridgeManager, WebRtcLifecycleEvent } from '../../core/webrtc-bridge-manager.js';
import {
  agencyAttemptRepository,
  agencyContactRepository,
  agencyManualCallRepository,
} from '../../db/repositories/agency.repository.js';
import type { AgencyManualCallRecord } from '../../db/models/agency.model.js';
import { DEFERRED_HANGUP_MS } from '@magick-agency/domain/timers';
import type { StationRegistry } from '../station-registry.js';
import type { AgentStateMachine } from '../agent-state-machine.js';
import { classifyAttemptOutcome } from '../outcome-classifier.js';

const log = createChildLogger({ component: 'agency-softphone' });

/** Bridge refusals that mean "no line free" (`concurrency_limit`). */
const CONCURRENCY_REFUSALS = new Set([
  'global_concurrency_limit',
  'account_concurrency_limit',
  'provider_concurrency_limit',
  'provider_concurrency_unavailable',
]);

/** Bridge outcomes that are not a hang-up by either party: the call was ended FOR them. */
const SYSTEM_ENDS = new Set(['service_shutdown', 'system_rebooted', 'stuck_active_call', 'max_duration_reached']);

/** Who asked for the end, when someone did (`hangup`). */
type EndRequester = 'agent' | 'supervisor';

/**
 * Why a manual call ended (`agency_manual_calls.end_reason`), from its classified
 * outcome and who, if anyone, hung it up.
 */
export function manualEndReasonFor(
  outcome: AgencyManualCallOutcome,
  bridgeOutcome: string | null | undefined,
  requestedBy: EndRequester | null,
): AgencyManualCallEndReason {
  if (requestedBy === 'supervisor') return 'supervisor_released';
  if (requestedBy === 'agent') return 'agent_hangup';
  switch (outcome) {
    case 'connected':
      return bridgeOutcome && SYSTEM_ENDS.has(bridgeOutcome) ? 'completed' : 'remote_hangup';
    case 'no_answer': return 'no_answer';
    case 'busy': return 'busy';
    case 'invalid': return 'invalid';
    case 'agent_disconnected': return 'agent_disconnected';
    case 'orphaned': return 'orphaned';
    case 'canceled': return 'agent_hangup';
    default: return 'failed';
  }
}

interface LiveManualCall {
  id: string;
  sessionId: string;
  tenantId: string;
  accountId: string;
  /** Filled at the dial; the frames carry them. */
  priors: AgencyPriorAttempt[];
  /** Set by a hang-up that arrived before the bridge held the call. */
  endRequestedBy: EndRequester | null;
}

export type ManualDialFailure = 'concurrency_limit' | 'station_unavailable';

export class ManualDialer {
  /** manualCallId → the call, from the dial until its `ended` is handled. */
  private readonly live = new Map<string, LiveManualCall>();
  /** manualCallId → the tail of its event chain (events applied in arrival order). */
  private readonly chains = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly bridge: WebRtcBridgeManager,
    private readonly stations: StationRegistry,
    private readonly agents: AgentStateMachine,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bridge.onLifecycle((ev) => {
      const entry = ev.correlationId ? this.live.get(ev.correlationId) : undefined;
      if (!entry) return; // not a soft-phone call of this process
      this.serial(entry.id, () => this.onLifecycle(entry, ev));
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.live.clear();
    this.chains.clear();
  }

  /** The live manual calls of this process — the orphan sweep's live set. */
  activeManualCallIds(): string[] {
    return [...this.live.keys()];
  }

  /** Whether this session has a call this process is driving (dialling through ended). */
  hasLiveCall(sessionId: string): boolean {
    for (const entry of this.live.values()) if (entry.sessionId === sessionId) return true;
    return false;
  }

  private liveFor(sessionId: string): LiveManualCall | undefined {
    for (const entry of this.live.values()) if (entry.sessionId === sessionId) return entry;
    return undefined;
  }

  /** Run `fn` after every earlier event of this call. Never rejects. */
  private serial(callId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(callId) ?? Promise.resolve();
    const next = prev.then(fn).catch((err) => log.error({ err, manualCallId: callId }, 'Soft-phone call event handling failed'));
    this.chains.set(callId, next);
    void next.then(() => { if (this.chains.get(callId) === next) this.chains.delete(callId); });
    return next;
  }

  /** Wait for every event queued on this call so far (tests, and the dial's own result). */
  async settled(callId: string): Promise<void> {
    await (this.chains.get(callId) ?? Promise.resolve());
  }

  // ─── Frames ───────────────────────────────────────────────────────────────

  /** The wire row of a call, with the contact's context and prior attempts (the live view). */
  async wireFor(
    call: Pick<AgencyManualCallRecord, 'id' | 'tenant_id' | 'account_id' | 'contact_id'>,
    priors?: AgencyPriorAttempt[],
  ): Promise<AgencyManualCall | null> {
    const wire = await agencyManualCallRepository.findWireById(
      call.id, { tenantId: call.tenant_id, accountId: call.account_id }, { withContext: true },
    );
    if (!wire || !wire.contact) return wire;
    const prior = priors ?? await this.priorsFor(call.contact_id, call.id);
    return { ...wire, contact: { ...wire.contact, prior_attempts: prior } };
  }

  /** The matched contact's earlier dials, lineage-scoped as the station panel's. Never throws. */
  async priorsFor(contactId: string | null, manualCallId: string): Promise<AgencyPriorAttempt[]> {
    if (!contactId) return [];
    try {
      const contact = await agencyContactRepository.findById(contactId);
      if (!contact) return [];
      const rows = await agencyAttemptRepository.findPriorForContactLineage(
        contact.root_contact_id ?? contact.id,
        manualCallId, // an attempt id it can never be: excludes nothing
      );
      return rows.map((r) => ({
        attempt_number: r.attempt_number,
        outcome: r.outcome,
        disposition_code: r.disposition_code,
        notes: r.notes,
        ended_at: r.ended_at ? r.ended_at.toISOString() : null,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        dialed_at: r.dialed_at ? r.dialed_at.toISOString() : null,
      }));
    } catch (err) {
      log.warn({ err, contactId }, 'Could not load prior attempts for a soft-phone call');
      return [];
    }
  }

  /** Send the `manual_call` frame for this call to its session. Never throws. */
  async sendFrame(call: AgencyManualCallRecord, ws?: WebSocket): Promise<AgencyManualCall | null> {
    try {
      const wire = await this.wireFor(call, this.live.get(call.id)?.priors);
      if (wire) this.stations.send(call.session_id, { event: 'manual_call', call: wire }, ws);
      return wire;
    } catch (err) {
      log.warn({ err, manualCallId: call.id }, 'Could not send the manual_call frame');
      return null;
    }
  }

  // ─── The dial ─────────────────────────────────────────────────────────────

  /**
   * Dial a committed, Redis-claimed `queued` row on the session's open station
   * socket. Resolves once the bridge has accepted (or refused) the dial: `ok` means
   * the call is in the bridge's hands (or the carrier refused it and it has
   * already ended `failed`, settled by its own `ended`).
   */
  async dial(
    call: AgencyManualCallRecord,
    opts: { socket: WebSocket; provider?: string },
  ): Promise<{ ok: true } | { ok: false; failure: ManualDialFailure }> {
    // Registered before the first await: a hang-up (or the reconnect, or the orphan
    // sweep's live set) arriving while the priors load must find the call.
    const entry: LiveManualCall = {
      id: call.id,
      sessionId: call.session_id,
      tenantId: call.tenant_id,
      accountId: call.account_id,
      priors: [],
      endRequestedBy: null,
    };
    this.live.set(call.id, entry);
    entry.priors = await this.priorsFor(call.contact_id, call.id);
    await this.sendFrame(call);

    // Hung up before the carrier was ever contacted: nothing to ring.
    if (entry.endRequestedBy) {
      const requestedBy = entry.endRequestedBy;
      await this.serial(call.id, () => this.abandonUnplaced(call.id, {
        outcome: 'canceled', endReason: requestedBy === 'supervisor' ? 'supervisor_released' : 'agent_hangup',
      }));
      return { ok: true };
    }
    const dialing = await agencyManualCallRepository.advanceState(call.id, 'dialing');
    if (dialing?.changed) await this.sendFrame(dialing.call);

    let webrtcCallId: string;
    try {
      const record = await this.bridge.createBridgedCall({
        tenantId: call.tenant_id,
        accountId: call.account_id,
        callerId: call.caller_id,
        destinationPhone: call.destination_e164,
        ...(opts.provider ? { provider: opts.provider } : {}),
        record: call.recording_requested,
        analysisProfileId: call.analysis_profile_id,
        initiatedBy: call.session_id,
        browserSocket: opts.socket,
        correlation: { kind: 'manual', manualCallId: call.id },
        // Answer-anchored for a manual leg (the bridge's rule): 0 while ringing, the
        // deferred-hangup window once the customer is on the line.
        browserCloseGraceMs: DEFERRED_HANGUP_MS,
      });
      webrtcCallId = record.id;
    } catch (err) {
      if (err instanceof WebRtcCallError && err.code === 'telephony_init_failed') {
        // The carrier refused the dial. The bridge already ended the leg, and the
        // `ended` event settles the row on this call's chain.
        log.warn({ err, manualCallId: call.id }, 'Soft-phone dial refused by the carrier');
        return { ok: true };
      }
      const failure: ManualDialFailure =
        err instanceof WebRtcCallError && err.code === 'station_socket_unavailable' ? 'station_unavailable'
          : err instanceof WebRtcCallError && CONCURRENCY_REFUSALS.has(err.code) ? 'concurrency_limit'
            : 'station_unavailable';
      if (!(err instanceof WebRtcCallError)) {
        log.error({ err, manualCallId: call.id }, 'Soft-phone dial failed before the carrier');
        await this.serial(call.id, () => this.abandonUnplaced(call.id));
        throw err;
      }
      log.warn({ err, manualCallId: call.id, failure }, 'Soft-phone dial refused before the carrier');
      await this.serial(call.id, () => this.abandonUnplaced(call.id));
      return { ok: false, failure };
    }

    // Id only, then `ringing` — forward-only, so an answer that already landed wins.
    await this.serial(call.id, async () => {
      await agencyManualCallRepository.attachWebrtcCall(call.id, webrtcCallId).catch((err) =>
        log.error({ err, manualCallId: call.id, webrtcCallId }, 'Could not attach the media leg to the soft-phone call'));
      const ringing = await agencyManualCallRepository.advanceState(call.id, 'ringing');
      if (ringing?.changed) await this.sendFrame(ringing.call);
    });
    if (entry.endRequestedBy) {
      await this.bridge.forceEndWithOutcome(call.id, 'agent_hangup');
    }
    return { ok: true };
  }

  /**
   * Hang up a live call (SP3: a ringing VoiceLink call may keep ringing at the
   * customer's end; the console says so). `false` when this process holds no such
   * live call.
   */
  async hangup(manualCallId: string, requestedBy: EndRequester): Promise<boolean> {
    const entry = this.live.get(manualCallId);
    if (!entry) return false;
    entry.endRequestedBy = requestedBy;
    // Before the bridge holds the call this is false, and `dial` ends it the moment
    // the bridge returns it.
    await this.bridge.forceEndWithOutcome(manualCallId, 'agent_hangup');
    return true;
  }

  /**
   * End, release and settle a `queued` call that will not be dialled (its Redis
   * claim could not be taken): canceled, no attempt charged.
   */
  async abandonUndialled(manualCallId: string): Promise<void> {
    await this.serial(manualCallId, () => this.abandonUnplaced(manualCallId, { outcome: 'canceled', endReason: 'failed' }));
  }

  /** End, release and settle a call the carrier never saw (on its chain). */
  private async abandonUnplaced(
    manualCallId: string,
    how: { outcome: AgencyManualCallOutcome; endReason: AgencyManualCallEndReason } = { outcome: 'failed', endReason: 'failed' },
  ): Promise<void> {
    this.live.delete(manualCallId);
    const ended = await agencyManualCallRepository.end(manualCallId, { ...how, talkSeconds: null });
    if (!ended) return;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      if (ended.contact_claimed) await agencyContactRepository.releaseManualClaim(ended.id, { client });
      await agencyManualCallRepository.settleWithoutDisposition(ended.id, { client });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      log.error({ err, manualCallId }, 'Could not settle an unplaced soft-phone call — the lapse sweep closes it');
    } finally {
      client.release();
    }
    await this.agents.releaseManual(ended.session_id, ended.id);
    const fresh = await agencyManualCallRepository.findById(manualCallId, { tenantId: ended.tenant_id, accountId: ended.account_id });
    if (fresh) await this.sendFrame(fresh);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  private async onLifecycle(entry: LiveManualCall, ev: WebRtcLifecycleEvent): Promise<void> {
    if (ev.phase === 'answered') {
      const r = await agencyManualCallRepository.advanceState(entry.id, 'answered', ev.answeredAt ?? new Date());
      if (r?.changed) await this.sendFrame(r.call);
      return;
    }
    if (ev.phase === 'bridged') {
      const r = await agencyManualCallRepository.advanceState(entry.id, 'bridged', new Date());
      if (r?.changed) await this.sendFrame(r.call);
      return;
    }
    await this.onEnded(entry, ev);
  }

  private async onEnded(entry: LiveManualCall, ev: WebRtcLifecycleEvent): Promise<void> {
    this.live.delete(entry.id);
    const scope = { tenantId: entry.tenantId, accountId: entry.accountId };
    const before = await agencyManualCallRepository.findById(entry.id, scope);
    if (!before) return;
    const bridged = before.bridged_at !== null;
    const outcome = classifyAttemptOutcome({
      status: ev.status ?? 'failed',
      outcome: ev.outcome,
      errorCode: ev.errorCode,
      errorMessage: ev.errorMessage,
      answered: ev.answered,
      bridged,
    });
    const ended = await agencyManualCallRepository.end(entry.id, {
      outcome,
      endReason: manualEndReasonFor(outcome, ev.outcome, entry.endRequestedBy),
      talkSeconds: typeof ev.talkTimeSeconds === 'number' ? Math.max(0, Math.round(ev.talkTimeSeconds)) : null,
    });
    // Already ended (the orphan sweep got there first): report what is there.
    const row = ended ?? before;
    if (ended && ended.bridged_at === null) {
      // The carrier's own refusal is not a placed dial: no attempt is charged.
      await this.settleUnanswered(ended, ended.dialed_at !== null && ev.outcome !== 'telephony_init_failed');
    }
    log.info({ manualCallId: entry.id, outcome, bridged, owesOutcome: ended?.bridged_at != null }, 'Soft-phone call ended');
    const fresh = await agencyManualCallRepository.findById(entry.id, scope);
    await this.sendFrame(fresh ?? row);
  }

  /**
   * Close an ended call that owes no outcome (§4.1 step 6): the row, its contact
   * (the "none" row of §5), in one transaction; then the Redis claim.
   */
  private async settleUnanswered(row: AgencyManualCallRecord, placed: boolean): Promise<void> {
    const client = await getPool().connect();
    let settled = false;
    try {
      await client.query('BEGIN');
      const done = await agencyManualCallRepository.settleWithoutDisposition(row.id, { client });
      if (done && done.contact_claimed) {
        await agencyContactRepository.settleFromManual({
          manualCallId: row.id, decision: null, placed, lastOutcome: row.outcome, lastDisposition: null,
        }, { client });
      }
      await client.query('COMMIT');
      settled = done !== null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      log.error({ err, manualCallId: row.id }, 'Could not settle an unanswered soft-phone call — the lapse sweep closes it');
    } finally {
      client.release();
    }
    if (settled) await this.agents.releaseManual(row.session_id, row.id);
  }

  // ─── Reconnect and sweeps ─────────────────────────────────────────────────

  /**
   * A station socket (re)attached (§4.1 step 9): re-adopt a live call's browser leg
   * onto it — the bridge refuses one that never bound or has ended, which is
   * correct — and answer the session's unsettled call (live, or awaiting its
   * outcome) for the `manual_call` frame that follows `ready`.
   */
  async reattachStation(sessionId: string, ws: WebSocket): Promise<AgencyManualCall | null> {
    const entry = this.liveFor(sessionId);
    if (entry) {
      const resumed = this.bridge.reattachBorrowedBrowserLeg(entry.id, ws);
      log.info({ sessionId, manualCallId: entry.id, resumed }, 'Station reconnected during a soft-phone call');
    }
    const unsettled = await agencyManualCallRepository.findUnsettledForSession(sessionId).catch((err) => {
      log.warn({ err, sessionId }, 'Could not read the session\'s soft-phone call on reconnect');
      return null;
    });
    return unsettled ? this.wireFor(unsettled, entry?.priors) : null;
  }

  /**
   * The reaper closed these calls (lapse, or an orphan that never bridged). Clear
   * each settled call's Redis claim — by its own id only — and tell its session.
   * The contact claims are the reaper's (database) half.
   */
  async onCallsClosedBySweep(rows: readonly AgencyManualCallRecord[]): Promise<void> {
    for (const row of rows) {
      if (row.settled_at !== null) await this.agents.releaseManual(row.session_id, row.id);
      await this.sendFrame(row);
    }
  }
}
