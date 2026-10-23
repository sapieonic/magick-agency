import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { getTestPool } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { createRng, LOAD_SEED, type Rng } from '../../helpers/load-scale.js';
import {
  AGENT_DISCONNECT_OUTCOME,
  CHAOS_DB,
  FakeStationSocket,
  KEY_PREFIX,
  SCRIPTED_ANSWER_LEAD_MS,
} from '../agency/chaos/harness.js';
import { insertAgencyCampaign } from '../agency/agency-factories.js';

/**
 * ─── THE FLOOR HARNESS ──────────────────────────────────────────────────────
 *
 * The chaos harness (`../agency/chaos/harness.ts`) stands up ONE campaign with a
 * handful of agents, and its carrier drains every call to its end inside one
 * flush. That is the right shape for a scripted failure and the wrong shape for a
 * floor: what this suite asks is whether the dialer runtime stays correct with a
 * hundred agents spread over several campaigns, accounts and tenants, with calls
 * of every length overlapping each other for many ticks. So this file builds a
 * multi-campaign world on the same principles and the same fakes, and adds only
 * what scale needs:
 *
 * - **One real `AgencyRuntime` for the whole floor** — the single replica the
 *   dialer supports — over real Postgres and real Redis. Every campaign is led by
 *   the same `PacingEngine`, every agent sits in the same `StationRegistry`, and
 *   the campaigns therefore contend for the same pool, the same tables and the
 *   same Redis exactly as they do in production.
 * - **A carrier with duration.** {@link FloorCarrier} keeps each call alive for a
 *   scripted number of ROUNDS (ringing, then talking), so at any instant the
 *   floor holds a realistic mix of ringing, connected and just-ended calls. The
 *   script for a dial is a pure function of the seed, the destination number and
 *   how many times that number has been dialled — never of the order the dials
 *   happened to arrive in — so a run's outcome stream is reproducible from the
 *   seed even though campaign ticks run concurrently.
 * - **Events are delivered concurrently, and the barrier is batched.** The carrier
 *   emits every lifecycle event due in a round in one synchronous burst (the
 *   dialer's subscription is fire-and-forget, so the handlers genuinely interleave,
 *   as webhooks from a real carrier do) and then waits ONCE for Postgres and Redis
 *   to show every one of them absorbed. A per-event poll, as the chaos carrier
 *   does, costs a sleep per event and would make a floor run minutes long.
 * - **Nothing is driven by a wall-clock interval.** `tickOnce` is called by
 *   {@link FloorWorld.round}; the supervisor, the reaper and the metric refreshes
 *   are never started. The station heartbeat — which in production renews the idle
 *   lease and the station ownership key every 10s — is modelled by
 *   {@link FloorWorld.heartbeat}, which `round()` calls every few rounds, because a
 *   floor run is long enough for an un-renewed 30s ownership key to lapse.
 *
 * Assertions read Postgres and Redis, never logs: {@link FloorWorld.checkInvariants}
 * and {@link FloorWorld.finalAudit} return violations as data, and every message
 * carries the seed so a red run can be replayed with `LOAD_SEED`.
 *
 * The caller mocks `@magick-agency/db`, `@magick-agency/db/connection` and
 * `src/config/index.js` before importing this module, exactly as the chaos
 * scenarios do; the db mock should hand out {@link floorPool} so the product runs on
 * a pool sized like production's rather than the 5-connection test pool.
 */

export { floorPool, closeFloorPool } from './floor-pool.js';

// ── Seeded scripts ─────────────────────────────────────────────────────────

/** 32-bit FNV-1a — mixes the seed, the number and the dial ordinal into one PRNG seed. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * What the carrier does with one dial. Every outcome a floor sees:
 *
 * - `connected_short` / `connected_long` — answered and bridged, ended after zero
 *   or several rounds of talk.
 * - `voicemail` — answered and bridged by the carrier, a few seconds of audio,
 *   then ended. There is no answering-machine detection on this path, so the
 *   dialer classifies a voicemail pickup `connected`; the kind exists so the mix
 *   contains it, and the audit treats it as the connected call it is.
 * - `no_answer` — rings out (`status: no_answer`).
 * - `busy` — refused at once (`status: busy`).
 * - `failed` — a carrier failure (`status: failed`).
 * - `invalid` — a carrier failure naming an unreachable number, which the
 *   classifier turns into `invalid` and the retry policy into a suppression.
 * - `ring_hangup` — the customer hangs up while it is still ringing: the carrier
 *   reports `canceled` with no local outcome, which classifies `no_answer`.
 */
export type OutcomeKind =
  | 'connected_short' | 'connected_long' | 'voicemail'
  | 'no_answer' | 'busy' | 'failed' | 'invalid' | 'ring_hangup';

export type OutcomeMix = Partial<Record<OutcomeKind, number>>;

export const DEFAULT_MIX: OutcomeMix = {
  connected_short: 22, connected_long: 14, voicemail: 8,
  no_answer: 22, busy: 10, failed: 6, invalid: 3, ring_hangup: 15,
};

const ANSWERING: ReadonlySet<OutcomeKind> = new Set(['connected_short', 'connected_long', 'voicemail']);

export interface FloorScript {
  kind: OutcomeKind;
  /** Advances spent ringing before the answer (or the terminal status). */
  ringRounds: number;
  /** Advances spent talking after the bridge. */
  talkRounds: number;
  /** Talk time the terminal event reports. */
  talkSeconds: number;
}

export function pickKind(rng: Rng, mix: OutcomeMix): OutcomeKind {
  const entries = Object.entries(mix).filter(([, w]) => (w ?? 0) > 0) as Array<[OutcomeKind, number]>;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng.next() * total;
  for (const [kind, w] of entries) {
    r -= w;
    if (r < 0) return kind;
  }
  return entries[entries.length - 1]![0];
}

export function scriptFrom(rng: Rng, kind: OutcomeKind): FloorScript {
  switch (kind) {
    case 'connected_short': return { kind, ringRounds: rng.int(0, 2), talkRounds: 0, talkSeconds: rng.int(5, 60) };
    case 'connected_long': return { kind, ringRounds: rng.int(0, 2), talkRounds: rng.int(2, 5), talkSeconds: rng.int(120, 900) };
    case 'voicemail': return { kind, ringRounds: rng.int(1, 2), talkRounds: 0, talkSeconds: rng.int(3, 12) };
    case 'no_answer': return { kind, ringRounds: rng.int(1, 3), talkRounds: 0, talkSeconds: 0 };
    case 'busy': return { kind, ringRounds: 0, talkRounds: 0, talkSeconds: 0 };
    case 'failed': return { kind, ringRounds: 0, talkRounds: 0, talkSeconds: 0 };
    case 'invalid': return { kind, ringRounds: 0, talkRounds: 0, talkSeconds: 0 };
    case 'ring_hangup': return { kind, ringRounds: rng.int(0, 2), talkRounds: 0, talkSeconds: 0 };
  }
}

// ── The carrier ─────────────────────────────────────────────────────────────

interface FloorCall {
  attemptId: string;
  callId: string;
  phone: string;
  campaignId: string;
  sessionId: string;
  tenantId: string;
  accountId: string;
  provider: string;
  script: FloorScript;
  phase: 'ringing' | 'talking' | 'answered_unbridged';
  /** Advances spent in the current phase. */
  rounds: number;
  answeredAt?: Date;
  /** The re-attach window the dialer asked for (`browserCloseGraceMs`). */
  graceMs: number;
  /** The agent's media leg closed and the window is running. */
  browserGone: boolean;
  /** Parked by a scenario: the carrier does not advance it until released. */
  parked: boolean;
}

/** Admission for one dial — the bridge's concurrency guards, when a scenario wires them. */
export interface CarrierAdmission {
  admit(call: { attemptId: string; tenantId: string; accountId: string; provider: string }): Promise<void>;
  release(call: { attemptId: string; tenantId: string; accountId: string; provider: string }): Promise<void>;
}

const BARRIER_TIMEOUT_MS = 10_000;

/**
 * The carrier, with calls that last.
 *
 * Implements every bridge verb the dialer calls (`createBridgedCall`,
 * `createUnboundBridgedCall`, `bindBorrowedBrowserLeg`, `reattachBorrowedBrowserLeg`,
 * `forceEndWithOutcome`, `playClipToCarrierThenHangUp`, `onLifecycle`) with the same
 * refusal semantics as the chaos harness's `ScriptedBridge`, which documents why
 * each refusal matters. A missing verb would surface as a `TypeError` swallowed by
 * the dialer's fire-and-forget subscription, so the set is complete on purpose.
 */
export class FloorCarrier {
  private readonly listeners: Array<(ev: unknown) => void> = [];
  private readonly live = new Map<string, FloorCall>();
  /** attemptId → ended call (kept so a late verb gets the "already over" refusal). */
  private readonly ended = new Map<string, FloorCall>();
  private readonly dialsByPhone = new Map<string, number>();
  /** Ends emitted since the last end barrier — including ones the dialer forced. */
  private pendingEnds: FloorCall[] = [];

  /** Every admitted dial, in arrival order. */
  readonly dials: Array<{ attemptId: string; callId: string; phone: string; campaignId: string; sessionId: string; kind: OutcomeKind }> = [];
  /** createBridgedCall seen twice for one attempt id. Must stay empty. */
  readonly duplicateDials: string[] = [];
  /** Dials refused by admission, with the code the bridge would have thrown. */
  readonly refusals: Array<{ attemptId: string; campaignId: string; code: string }> = [];
  /** Absorption barriers that did not see their writes land. Must stay empty. */
  readonly barrierTimeouts: Array<{ attemptId: string; waitingFor: string; observed: string }> = [];
  /** Peak live calls the carrier held per account, over the run. */
  readonly peakLiveByAccount = new Map<string, number>();

  admission: CarrierAdmission | null = null;
  /** Per-campaign outcome mix; campaigns absent here use {@link mix}. */
  readonly mixByCampaign = new Map<string, OutcomeMix>();
  /** A scenario's override for one dial, consulted before the seeded script. */
  scriptOverride: ((dial: { phone: string; nth: number; campaignId: string }) => FloorScript | undefined) | null = null;

  /** Reads the agents' Redis state for the end barrier. Set by the world. */
  agentAttempt: (sessionIds: string[]) => Promise<Array<{ state: string; attemptId: string | null } | null>> =
    async (ids) => ids.map(() => null);

  constructor(readonly seed: number, public mix: OutcomeMix = DEFAULT_MIX) {}

  onLifecycle(l: (ev: unknown) => void): () => void {
    this.listeners.push(l);
    return () => {
      const i = this.listeners.indexOf(l);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit(ev: Record<string, unknown>): void {
    // Synchronous on purpose: the dialer's listener is `void this.onBridgeLifecycle(ev)`,
    // so calling every listener for every due event in one loop is what makes the
    // handlers interleave the way concurrent carrier webhooks do.
    for (const l of [...this.listeners]) l(ev);
  }

  /** The seeded script for the `nth` dial of `phone`. */
  scriptFor(phone: string, nth: number, campaignId: string): FloorScript {
    const override = this.scriptOverride?.({ phone, nth, campaignId });
    if (override) return override;
    const rng = createRng(hash32(`${this.seed}|${phone}|${nth}`));
    return scriptFrom(rng, pickKind(rng, this.mixByCampaign.get(campaignId) ?? this.mix));
  }

  async createBridgedCall(params: {
    agencyAttemptId: string;
    destinationPhone: string;
    tenantId: string;
    accountId: string;
    provider?: string;
    campaignId?: string;
    initiatedBy?: string;
    browserCloseGraceMs?: number;
  }): Promise<{ id: string }> {
    const attemptId = params.agencyAttemptId;
    if (this.live.has(attemptId) || this.ended.has(attemptId)) this.duplicateDials.push(attemptId);
    const provider = params.provider ?? 'voicelink';
    const campaignId = params.campaignId ?? '';
    if (this.admission) {
      try {
        await this.admission.admit({ attemptId, tenantId: params.tenantId, accountId: params.accountId, provider });
      } catch (err) {
        this.refusals.push({ attemptId, campaignId, code: (err as { code?: string }).code ?? 'unknown' });
        throw err;
      }
    }
    const nth = this.dialsByPhone.get(params.destinationPhone) ?? 0;
    this.dialsByPhone.set(params.destinationPhone, nth + 1);
    const script = this.scriptFor(params.destinationPhone, nth, campaignId);
    const call: FloorCall = {
      attemptId,
      callId: randomUUID(),
      phone: params.destinationPhone,
      campaignId,
      sessionId: params.initiatedBy ?? '',
      tenantId: params.tenantId,
      accountId: params.accountId,
      provider,
      script,
      phase: 'ringing',
      rounds: 0,
      graceMs: params.browserCloseGraceMs ?? 0,
      browserGone: false,
      parked: false,
    };
    this.live.set(attemptId, call);
    this.dials.push({ attemptId, callId: call.callId, phone: call.phone, campaignId, sessionId: call.sessionId, kind: script.kind });
    const scope = `${params.tenantId}:${params.accountId}`;
    let n = 0;
    for (const c of this.live.values()) if (`${c.tenantId}:${c.accountId}` === scope) n++;
    this.peakLiveByAccount.set(scope, Math.max(this.peakLiveByAccount.get(scope) ?? 0, n));
    return { id: call.callId };
  }

  /** Late binding's dial. Same carrier; the bind happens at the answer. */
  async createUnboundBridgedCall(params: Parameters<FloorCarrier['createBridgedCall']>[0]): Promise<{ id: string }> {
    return this.createBridgedCall(params);
  }

  bindBorrowedBrowserLeg(attemptId: string, ws: { readyState: number }): boolean {
    const call = this.live.get(attemptId);
    if (!call || ws.readyState !== 1) return false;
    call.browserGone = false;
    return true;
  }

  reattachBorrowedBrowserLeg(correlationId: string, ws: { readyState: number }): boolean {
    const call = this.live.get(correlationId);
    if (!call) return false;
    if (ws.readyState !== 1) return false;
    call.browserGone = false;
    return true;
  }

  async forceEndWithOutcome(correlationId: string, outcome: string): Promise<boolean> {
    const call = this.live.get(correlationId);
    if (!call) return false;
    await this.end(call, { status: call.answeredAt ? 'completed' : 'canceled', outcome });
    return true;
  }

  async playClipToCarrierThenHangUp(
    correlationId: string,
    opts: { clipHash: string; outcome: string; status?: string },
  ): Promise<boolean> {
    const call = this.live.get(correlationId);
    if (!call) return false;
    await this.end(call, { status: opts.status ?? (call.answeredAt ? 'completed' : 'canceled'), outcome: opts.outcome });
    return true;
  }

  /**
   * The agent's media leg closed. With a window the dialer asked for, the call is
   * held (`browserGone`) and the window runs; without one, it is hung up at once —
   * the real bridge's `close` handler, as the chaos carrier models it.
   */
  async dropBrowserLeg(attemptId: string): Promise<boolean> {
    const call = this.live.get(attemptId);
    if (!call) return false;
    if (call.graceMs > 0) {
      call.browserGone = true;
      return true;
    }
    await this.end(call, { status: call.answeredAt ? 'completed' : 'canceled', outcome: AGENT_DISCONNECT_OUTCOME });
    return false;
  }

  /** The re-attach window lapsed: the deferred hangup fires. */
  async expireGrace(attemptId: string): Promise<boolean> {
    const call = this.live.get(attemptId);
    if (!call || !call.browserGone) return false;
    await this.end(call, { status: call.answeredAt ? 'completed' : 'canceled', outcome: AGENT_DISCONNECT_OUTCOME });
    return true;
  }

  /** Hold a call where it is (ringing or talking) until {@link release}. */
  park(attemptId: string): boolean {
    const call = this.live.get(attemptId);
    if (!call) return false;
    call.parked = true;
    return true;
  }

  release(attemptId: string): boolean {
    const call = this.live.get(attemptId);
    if (!call) return false;
    call.parked = false;
    return true;
  }

  /** Change what a live call will do from here on (a burst of answers, say). */
  rescript(attemptId: string, script: Partial<FloorScript>): boolean {
    const call = this.live.get(attemptId);
    if (!call) return false;
    call.script = { ...call.script, ...script };
    return true;
  }

  liveCalls(): Array<{ attemptId: string; sessionId: string; campaignId: string; phase: string; kind: OutcomeKind; parked: boolean; browserGone: boolean }> {
    return [...this.live.values()].map((c) => ({
      attemptId: c.attemptId, sessionId: c.sessionId, campaignId: c.campaignId, phase: c.phase,
      kind: c.script.kind, parked: c.parked, browserGone: c.browserGone,
    }));
  }

  liveCount(): number {
    return this.live.size;
  }

  private async end(call: FloorCall, ev: { status: string; outcome?: string; errorMessage?: string }): Promise<void> {
    if (!this.live.delete(call.attemptId)) return;
    this.ended.set(call.attemptId, call);
    // The real bridge gives the slot back in its teardown, before the dialer hears
    // the call ended — so capacity is free by the time the next tick plans.
    if (this.admission) {
      await this.admission.release({
        attemptId: call.attemptId, tenantId: call.tenantId, accountId: call.accountId, provider: call.provider,
      });
    }
    const bridged = call.phase === 'talking';
    this.pendingEnds.push(call);
    this.emit({
      callId: call.callId,
      correlationId: call.attemptId,
      phase: 'ended',
      status: ev.status,
      answered: bridged,
      talkTimeSeconds: bridged ? call.script.talkSeconds : 0,
      ...(ev.outcome === undefined ? {} : { outcome: ev.outcome }),
      ...(ev.errorMessage === undefined ? {} : { errorMessage: ev.errorMessage }),
    });
  }

  /**
   * Answer a call now, whatever its script said, and report whether the dialer
   * bridged it (true) or abandoned it (false). The burst scenario's verb.
   */
  async answerNow(attemptIds: readonly string[]): Promise<void> {
    const calls = attemptIds.map((id) => this.live.get(id)).filter((c): c is FloorCall => !!c && c.phase === 'ringing');
    for (const call of calls) {
      call.parked = false;
      call.script = { ...call.script, kind: ANSWERING.has(call.script.kind) ? call.script.kind : 'connected_long', ringRounds: 0 };
      call.rounds = call.script.ringRounds;
    }
    await this.answer(calls);
    await this.endBarrier();
  }

  private async answer(calls: FloorCall[]): Promise<void> {
    if (calls.length === 0) return;
    const bridgedIds: string[] = [];
    const unbridgedIds: string[] = [];
    for (const call of calls) {
      // One instant, carried on `answered` and re-sent on `bridged` — see the chaos
      // carrier's `PendingCall.answeredAt` for why it must be one value.
      call.answeredAt = new Date(Date.now() - SCRIPTED_ANSWER_LEAD_MS);
      this.emit({ callId: call.callId, correlationId: call.attemptId, phase: 'answered', answered: true, answeredAt: call.answeredAt });
      if (call.browserGone) {
        // Media cannot reach a leg that is gone; the dialer's answered arm decides
        // (it abandons when the station is lost — `abandonAnsweredCall`).
        call.phase = 'answered_unbridged';
        call.rounds = 0;
        unbridgedIds.push(call.attemptId);
        continue;
      }
      // A fast carrier: `bridged` in the same turn as `answered`, which the dialer is
      // written for (the abandon decision is taken synchronously in the answered arm).
      this.emit({
        callId: call.callId, correlationId: call.attemptId, phase: 'bridged',
        status: 'in_progress', answered: true, answeredAt: call.answeredAt,
      });
      call.phase = 'talking';
      call.rounds = 0;
      bridgedIds.push(call.attemptId);
    }
    await this.rowBarrier(bridgedIds, ['bridged', 'ended'], 'bridged');
    // A leg is only ever gone because its station was dropped (and detached), so an
    // answer into it is one the dialer must abandon: `answered` is the state that
    // path passes THROUGH (the chaos carrier's `answerRinging` explains why it
    // cannot be an accepted state), so the barrier waits for the forced end.
    await this.rowBarrier(unbridgedIds, ['ended'], 'abandoned');
  }

  /**
   * One round of carrier time: every live, unparked call moves one step along its
   * script, the due events go out in one burst, and the round does not return
   * until Postgres and Redis show all of them absorbed.
   */
  async advance(): Promise<{ answered: number; ended: number }> {
    const answering: FloorCall[] = [];
    const ending: Array<{ call: FloorCall; status: string; errorMessage?: string }> = [];
    for (const call of [...this.live.values()]) {
      if (call.parked) continue;
      if (call.phase === 'ringing') {
        if (call.rounds < call.script.ringRounds) { call.rounds++; continue; }
        switch (call.script.kind) {
          case 'connected_short': case 'connected_long': case 'voicemail':
            answering.push(call); break;
          case 'no_answer': ending.push({ call, status: 'no_answer' }); break;
          case 'busy': ending.push({ call, status: 'busy' }); break;
          case 'failed': ending.push({ call, status: 'failed' }); break;
          case 'invalid': ending.push({ call, status: 'failed', errorMessage: 'number not in service' }); break;
          case 'ring_hangup': ending.push({ call, status: 'canceled' }); break;
        }
        continue;
      }
      if (call.phase === 'talking') {
        if (call.rounds < call.script.talkRounds) { call.rounds++; continue; }
        // A talking call whose browser leg is gone is held for the re-attach window;
        // only `expireGrace` or a re-attach moves it.
        if (call.browserGone) continue;
        ending.push({ call, status: 'completed' });
      }
      // `answered_unbridged` waits for the dialer (abandon) or a scenario.
    }
    await this.answer(answering);
    for (const e of ending) await this.end(e.call, { status: e.status, errorMessage: e.errorMessage });
    const ended = this.pendingEnds.length;
    await this.endBarrier();
    return { answered: answering.length, ended };
  }

  /** End a live call now with the given terminal status (a scenario's hangup). */
  async endNow(attemptId: string, status = 'completed'): Promise<boolean> {
    const call = this.live.get(attemptId);
    if (!call) return false;
    await this.end(call, { status });
    await this.endBarrier();
    return true;
  }

  /**
   * Wait for every end emitted since the last barrier — the carrier's own and the
   * ones the dialer forced — to be absorbed through its LAST write: the attempt row
   * `ended`, the contact out of `in_flight`, and the agent's Redis lease no longer
   * bound to the attempt. The chaos carrier documents why the attempt row alone
   * under-waits (`ScriptedBridge.emit`); this is that barrier carried to the end of
   * the chain, which is what lets the per-round invariants be strict.
   */
  async endBarrier(): Promise<void> {
    const deadline = Date.now() + BARRIER_TIMEOUT_MS;
    let waiting: FloorCall[] = [];
    for (;;) {
      // Ends the dialer forces while we poll (an abandon inside a handler) join the
      // set being waited on rather than slipping past the barrier.
      waiting = [...waiting, ...this.pendingEnds];
      this.pendingEnds = [];
      if (waiting.length === 0) return;
      const { rows } = await getTestPool().query<{ id: string; state: string; contact_state: string; reserved_agent_id: string }>(
        `SELECT a.id, a.state, c.state AS contact_state, a.reserved_agent_id
           FROM agency_call_attempts a JOIN agency_contacts c ON c.id = a.contact_id
          WHERE a.id = ANY($1::uuid[])`,
        [waiting.map((c) => c.attemptId)],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const agents = await this.agentAttempt(rows.map((r) => r.reserved_agent_id));
      const agentById = new Map(rows.map((r, i) => [r.id, agents[i]]));
      const still: Array<{ call: FloorCall; observed: string }> = [];
      for (const call of waiting) {
        const row = byId.get(call.attemptId);
        if (!row) continue;
        const agent = agentById.get(call.attemptId);
        const agentBound = !!agent && agent.attemptId === call.attemptId
          && (agent.state === 'reserved' || agent.state === 'on_call');
        if (row.state === 'ended' && row.contact_state !== 'in_flight' && !agentBound) continue;
        still.push({
          call,
          observed: `attempt=${row.state} contact=${row.contact_state} agent=${agent?.state ?? 'none'}/${agent?.attemptId ?? ''}`,
        });
      }
      if (still.length === 0) {
        waiting = [];
        continue;
      }
      if (Date.now() > deadline) {
        // Recorded, never thrown: a stuck chain is evidence about the product, and
        // the invariant checks report it with the seed.
        for (const s of still) this.barrierTimeouts.push({ attemptId: s.call.attemptId, waitingFor: 'ended', observed: s.observed });
        waiting = [];
        if (this.pendingEnds.length === 0) return;
        continue;
      }
      waiting = still.map((s) => s.call);
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  private async rowBarrier(ids: string[], accept: string[], waitingFor: string): Promise<void> {
    if (ids.length === 0) return;
    const deadline = Date.now() + BARRIER_TIMEOUT_MS;
    let pendingIds = ids;
    for (;;) {
      const { rows } = await getTestPool().query<{ id: string; state: string }>(
        'SELECT id, state FROM agency_call_attempts WHERE id = ANY($1::uuid[])', [pendingIds],
      );
      pendingIds = rows.filter((r) => !accept.includes(r.state)).map((r) => r.id);
      if (pendingIds.length === 0) return;
      if (Date.now() > deadline) {
        for (const r of rows.filter((x) => pendingIds.includes(x.id))) {
          this.barrierTimeouts.push({ attemptId: r.id, waitingFor, observed: r.state });
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  }
}

// ── The world ──────────────────────────────────────────────────────────────

export interface FloorCampaignSpec {
  /** Short label used in messages and to derive deterministic ids. */
  label: string;
  /** Tenant label; campaigns sharing it share a tenant. */
  tenant: string;
  /** Account label, unique per running campaign (`uq_agency_campaign_running`). */
  account: string;
  agents: number;
  contacts: number;
  maxConcurrentCalls: number;
  /** Column overrides for `agency_campaigns` (retry policy, status, ceiling …). */
  campaign?: Record<string, unknown>;
  /** Outcome mix for this campaign's dials; defaults to the carrier's. */
  mix?: OutcomeMix;
  /** Destination number for contact `i`; defaults to a number unique to the campaign. */
  phoneFor?: (i: number) => string;
}

export interface FloorAgent {
  sessionId: string;
  agentUserId: string;
  campaignId: string;
  tenantId: string;
  accountId: string;
  label: string;
  socket: FakeStationSocket;
  /** Is a station socket attached on the replica right now (by this harness)? */
  attached: boolean;
  left: boolean;
}

export interface FloorCampaign {
  spec: FloorCampaignSpec;
  id: string;
  tenantId: string;
  accountId: string;
  index: number;
}

export interface CampaignRoundStat {
  /** Locally-owned agents whose Redis state was `available` just before the tick. */
  availableBefore: number;
  liveBefore: number;
  limit: number;
  /** Contacts `claimDialable` could have picked just before the tick. */
  claimableBefore: number;
  status: string;
  attemptsCreated: number;
}

export interface RoundReport {
  round: number;
  campaigns: Record<string, CampaignRoundStat>;
  answered: number;
  ended: number;
}

export interface FloorWorldOptions {
  campaigns: FloorCampaignSpec[];
  seed?: number;
  mix?: OutcomeMix;
  /** Tick the campaigns concurrently each round (production's shape). Default true. */
  parallelTicks?: boolean;
  /** Rounds between modelled station heartbeats. Default 3. */
  heartbeatEvery?: number;
}

export const NO_DELAY_RETRY_POLICY = {
  no_answer: { delay_minutes: 0, max_attempts: 3 },
  busy: { delay_minutes: 0, max_attempts: 3 },
  failed: { delay_minutes: 0, max_attempts: 2 },
  abandoned: { delay_minutes: 0, max_attempts: 2 },
  invalid: { max_attempts: 0 },
  connected: { max_attempts: 0 },
  agent_disconnected: { delay_minutes: 0, max_attempts: 3 },
  orphaned: { delay_minutes: 0, max_attempts: 3 },
  canceled: { delay_minutes: 0, max_attempts: 3 },
} as const;

type Runtime = import('../../../src/agency/runtime.js').AgencyRuntime;

/**
 * Stand up a floor: tenants, accounts and their settings, campaigns, rosters and
 * agent sessions in Postgres; one runtime; every agent's station attached and the
 * agent `available`.
 */
export async function createFloorWorld(opts: FloorWorldOptions) {
  const seed = opts.seed ?? LOAD_SEED;
  const rng = createRng(seed);
  const parallelTicks = opts.parallelTicks ?? true;
  const heartbeatEvery = opts.heartbeatEvery ?? 3;
  const db = getTestPool();

  const { AgencyRuntime } = await import('../../../src/agency/runtime.js');
  const { agencyCampaignRepository, agencyAgentSessionRepository } = await import('../../../src/db/repositories/agency.repository.js');
  const { AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');
  const { breakMustWait } = await import('@magick-agency/domain/break-manager');

  const redis = new Redis(TEST_REDIS_URL, { keyPrefix: KEY_PREFIX, db: CHAOS_DB, maxRetriesPerRequest: 3 });
  await redis.flushdb();

  const carrier = new FloorCarrier(seed, opts.mix ?? DEFAULT_MIX);

  // ── Tenancy, settings, campaigns, rosters ───────────────────────────────
  const tenants = new Map<string, string>();
  const accounts = new Map<string, string>();
  for (const spec of opts.campaigns) {
    if (!tenants.has(spec.tenant)) {
      const id = uuidFor(`floor-tenant-${spec.tenant}`);
      tenants.set(spec.tenant, id);
      await db.query(
        `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [id, `Floor ${spec.tenant}`, `floor-${spec.tenant}-${id.slice(0, 8)}`],
      );
    }
    if (!accounts.has(spec.account)) {
      const id = uuidFor(`floor-account-${spec.account}`);
      accounts.set(spec.account, id);
      await db.query(
        `INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [id, tenants.get(spec.tenant), `Floor ${spec.account}`, `floor-${spec.account}`],
      );
    }
  }

  const campaigns: FloorCampaign[] = [];
  const agents: FloorAgent[] = [];
  for (const [index, spec] of opts.campaigns.entries()) {
    const tenantId = tenants.get(spec.tenant)!;
    const accountId = accounts.get(spec.account)!;
    await db.query(
      `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, account_id) DO UPDATE SET max_concurrent_calls = EXCLUDED.max_concurrent_calls`,
      [tenantId, accountId, spec.maxConcurrentCalls],
    );
    const row = await insertAgencyCampaign({
      tenant_id: tenantId,
      account_id: accountId,
      name: `floor-${spec.label}`,
      status: 'running',
      // Zero wrap-up and no catalog keeps the pool circulating without a business
      // timer in the loop (the chaos harness's reasoning, unchanged).
      wrapup_seconds: 0,
      retry_policy: JSON.stringify(NO_DELAY_RETRY_POLICY),
      ...spec.campaign,
    });
    const campaignId = row.id as string;
    campaigns.push({ spec, id: campaignId, tenantId, accountId, index });
    if (spec.mix) carrier.mixByCampaign.set(campaignId, spec.mix);

    // One statement per roster: thousands of single-row INSERTs would dominate setup.
    const phoneFor = spec.phoneFor ?? ((i: number) => `+9197${String(index).padStart(2, '0')}${String(i).padStart(6, '0')}`);
    const n = spec.contacts;
    await db.query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state, source_row_number)
       SELECT $1, $2, $3, p.phone, '{"name":"Floor Contact"}'::jsonb, 'pending', p.ord
         FROM unnest($4::text[]) WITH ORDINALITY AS p(phone, ord)`,
      [campaignId, tenantId, accountId, Array.from({ length: n }, (_, i) => phoneFor(i))],
    );

    for (let i = 0; i < spec.agents; i++) {
      agents.push(await insertFloorAgent(campaigns[campaigns.length - 1]!, i));
    }
  }

  async function insertFloorAgent(c: FloorCampaign, i: number | string): Promise<FloorAgent> {
    const agentUserId = uuidFor(`floor-agent-${c.spec.label}-${i}`);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state)
       VALUES ($1, $2, $3, $4, 'offline') RETURNING id`,
      [c.tenantId, c.accountId, c.id, agentUserId],
    );
    return {
      sessionId: rows[0]!.id, agentUserId, campaignId: c.id, tenantId: c.tenantId, accountId: c.accountId,
      label: `${c.spec.label}#${i}`, socket: new FakeStationSocket(), attached: false, left: false,
    };
  }

  const rt: Runtime = new AgencyRuntime(carrier as never, redis, '');
  rt.dialer.start();
  carrier.agentAttempt = async (ids) => (await rt.agents.getMany(ids)).map((s) =>
    s ? { state: s.state, attemptId: s.attemptId ?? null } : null);

  // The pre-dial gate must clear for every tenant, or the floor dials nothing and
  // looks exactly like a pacing bug (the chaos harness's `makeTenantDncAuthoritative`).
  for (const c of campaigns) {
    const verdict = await rt.dnc.check(c.tenantId, '+919000000099', { accountId: c.accountId, campaignId: c.id });
    if (verdict !== 'clear') throw new Error(`Floor harness: DNC gate answers '${verdict}' for campaign ${c.spec.label}`);
  }

  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  let roundNo = 0;

  // ── Agent verbs: each mirrors the route or socket handler that does it ──────

  async function bringOnline(agent: FloorAgent): Promise<void> {
    agent.socket = new FakeStationSocket();
    await rt.stations.attach({
      sessionId: agent.sessionId, campaignId: agent.campaignId, tenantId: agent.tenantId,
      accountId: agent.accountId, agentUserId: agent.agentUserId, ws: agent.socket as never,
    });
    agent.attached = true;
    await rt.agents.set(agent.sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
    await agencyAgentSessionRepository.setState(agent.sessionId, 'available');
  }

  for (const agent of agents) await bringOnline(agent);

  const world = {
    seed,
    redis,
    carrier,
    campaigns,
    agents,
    rng,
    get runtime(): Runtime { return rt; },
    get roundsRun(): number { return roundNo; },
    campaign(label: string): FloorCampaign {
      const c = campaigns.find((x) => x.spec.label === label);
      if (!c) throw new Error(`no campaign ${label}`);
      return c;
    },
    agentsOf(label: string): FloorAgent[] {
      const c = world.campaign(label);
      return agents.filter((a) => a.campaignId === c.id);
    },
    bringOnline,

    /** POST /sessions/:id/break, as the route decides it (queued while busy). */
    async goBreak(agent: FloorAgent, code = 'lunch'): Promise<'applied' | 'queued'> {
      const live = await rt.agents.get(agent.sessionId);
      const reason = { code, label: code };
      if (breakMustWait(live?.state)) {
        rt.breaks.queue(agent.sessionId, reason);
        return 'queued';
      }
      await rt.agents.set(agent.sessionId, 'break', { leaseMs: AGENT_LEASE_MS.break });
      await agencyAgentSessionRepository.setState(agent.sessionId, 'break', code);
      return 'applied';
    },

    /** POST /sessions/:id/available — refused (false) where the route refuses. */
    async goAvailable(agent: FloorAgent): Promise<boolean> {
      if (!rt.stations.isLocallyOwned(agent.sessionId)) return false;
      if (rt.dialer.hasUnannouncedAttempt(agent.sessionId)) return false;
      rt.wrapup.cancel(agent.sessionId, 'agent_returned');
      await rt.agents.set(agent.sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
      await agencyAgentSessionRepository.setState(agent.sessionId, 'available');
      return true;
    },

    /**
     * The station socket goes away — both close handlers, as `chaos.dropStation`
     * drives them: the bridge's (arms the re-attach window on a live call) and the
     * route's (`releaseStationOnClose`).
     */
    async dropStation(agent: FloorAgent): Promise<{ attemptId: string | null; wroteOffline: boolean; graceArmed: boolean }> {
      agent.socket.close();
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM agency_call_attempts WHERE reserved_agent_id = $1 AND state <> 'ended'
          ORDER BY created_at DESC LIMIT 1`,
        [agent.sessionId],
      );
      const attemptId = rows[0]?.id ?? null;
      const graceArmed = attemptId === null ? false : await carrier.dropBrowserLeg(attemptId);
      await rt.stations.detach(agent.sessionId, agent.socket as never);
      agent.attached = false;
      const wroteOffline = await rt.releaseStationOnClose(agent.sessionId);
      await carrier.endBarrier();
      return { attemptId, wroteOffline, graceArmed };
    },

    /**
     * A fresh socket for a dropped agent: attach, rehydrate (Redis or `break`),
     * re-attach onto a live attempt if one is still held. What the station socket
     * route does on upgrade.
     */
    async reconnect(agent: FloorAgent): Promise<{ state: string; resumed: boolean }> {
      agent.socket = new FakeStationSocket();
      await rt.stations.attach({
        sessionId: agent.sessionId, campaignId: agent.campaignId, tenantId: agent.tenantId,
        accountId: agent.accountId, agentUserId: agent.agentUserId, ws: agent.socket as never,
      });
      agent.attached = true;
      const state = await rt.rehydrateAgent(agent.sessionId);
      const resumed = rt.dialer.reattachStation(agent.sessionId, agent.socket as never) !== null;
      return { state, resumed };
    },

    /** POST /sessions/:id/leave — refused (false) while a live attempt is held. */
    async leave(agent: FloorAgent): Promise<boolean> {
      if (rt.dialer.hasLiveAttempt(agent.sessionId)) return false;
      await rt.agents.clear(agent.sessionId);
      await agencyAgentSessionRepository.leave(agent.sessionId);
      await rt.stations.detach(agent.sessionId);
      agent.attached = false;
      agent.left = true;
      return true;
    },

    /** A new agent joins a running campaign mid-run. */
    async joinLate(label: string): Promise<FloorAgent> {
      const c = world.campaign(label);
      const agent = await insertFloorAgent(c, `late-${agents.length}`);
      agents.push(agent);
      await bringOnline(agent);
      return agent;
    },

    /** A supervisor's lifecycle control: the route's `transitionStatus`. */
    async transition(label: string, from: string[], to: string): Promise<boolean> {
      const updated = await agencyCampaignRepository.transitionStatus(world.campaign(label).id, from as never, to as never);
      return updated !== null;
    },

    async status(label: string): Promise<string> {
      const { rows } = await db.query<{ status: string }>('SELECT status FROM agency_campaigns WHERE id = $1', [world.campaign(label).id]);
      return rows[0]!.status;
    },

    /**
     * The station heartbeat: renews the ownership key and the idle/break lease of
     * every attached agent, as `handlePing` does every 10s in production.
     */
    async heartbeat(): Promise<void> {
      for (const a of agents) {
        if (!a.attached || a.left) continue;
        if (!(await rt.stations.heartbeat(a.sessionId, a.socket as never))) continue;
        const live = await rt.agents.get(a.sessionId);
        if (live && (live.state === 'available' || live.state === 'break')) {
          await rt.agents.renew(a.sessionId, live.state, AGENT_LEASE_MS.available);
        }
      }
    },

    /** Per-campaign pacing inputs, read the way `planTick` reads them. */
    async pacingInputs(): Promise<Record<string, Omit<CampaignRoundStat, 'attemptsCreated'>>> {
      const out: Record<string, Omit<CampaignRoundStat, 'attemptsCreated'>> = {};
      const { rows: stats } = await db.query<{ id: string; status: string; live: number; claimable: number; lim: number }>(
        `SELECT cam.id, cam.status,
                (SELECT count(*)::int FROM agency_call_attempts a WHERE a.campaign_id = cam.id AND a.state <> 'ended') AS live,
                (SELECT count(*)::int FROM agency_contacts c
                  WHERE c.campaign_id = cam.id AND c.state = 'pending' AND c.next_attempt_at <= now()
                    AND c.suppressed_reason IS DISTINCT FROM 'dnc') AS claimable,
                COALESCE(s.max_concurrent_calls, 5) AS lim
           FROM agency_campaigns cam
           LEFT JOIN account_settings s ON s.tenant_id = cam.tenant_id AND s.account_id = cam.account_id
          WHERE cam.id = ANY($1::uuid[])`,
        [campaigns.map((c) => c.id)],
      );
      for (const c of campaigns) {
        const sessions = await agencyAgentSessionRepository.findLiveForCampaign(c.id);
        const local = sessions.map((s) => s.id).filter((id) => rt.stations.isLocallyOwned(id));
        const states = await rt.agents.getMany(local);
        const s = stats.find((r) => r.id === c.id)!;
        out[c.spec.label] = {
          availableBefore: states.filter((x) => x?.state === 'available').length,
          liveBefore: s.live,
          limit: s.lim,
          claimableBefore: s.claimable,
          status: s.status,
        };
      }
      return out;
    },

    /**
     * One round: every campaign's leader tick (concurrently, unless the world was
     * built sequential), then one carrier advance, then — every few rounds — the
     * station heartbeat. Returns what each campaign's tick had to work with and
     * what it did, for the pacing assertions.
     */
    async round(opts2: { measure?: boolean } = {}): Promise<RoundReport> {
      roundNo++;
      const measure = opts2.measure ?? true;
      const inputs = measure ? await world.pacingInputs() : {};
      const before = measure ? await attemptCounts() : new Map<string, number>();
      const order = rng.shuffle(campaigns);
      if (parallelTicks) {
        await Promise.all(order.map((c) => rt.pacing.tickOnce(c.id)));
      } else {
        for (const c of order) await rt.pacing.tickOnce(c.id);
      }
      const after = measure ? await attemptCounts() : new Map<string, number>();
      const { answered, ended } = await carrier.advance();
      if (roundNo % heartbeatEvery === 0) await world.heartbeat();
      const report: RoundReport = { round: roundNo, campaigns: {}, answered, ended };
      if (measure) {
        for (const c of campaigns) {
          report.campaigns[c.spec.label] = {
            ...inputs[c.spec.label]!,
            attemptsCreated: (after.get(c.id) ?? 0) - (before.get(c.id) ?? 0),
          };
        }
      }
      return report;
    },

    /**
     * Rounds until the floor has nothing left to do: no live call, no claimable
     * contact on a running campaign, and nothing dialled in the last round.
     * `onRound` runs after every round (the per-tick invariant checks).
     */
    async runUntilDrained(o: { maxRounds: number; onRound?: (r: RoundReport) => Promise<void> | void }): Promise<number> {
      let quietRounds = 0;
      for (let i = 0; i < o.maxRounds; i++) {
        const r = await world.round();
        if (o.onRound) await o.onRound(r);
        const created = Object.values(r.campaigns).reduce((s, x) => s + x.attemptsCreated, 0);
        const outstanding = await outstandingWork();
        quietRounds = created === 0 && carrier.liveCount() === 0 && !outstanding ? quietRounds + 1 : 0;
        // Two quiet rounds: the second gives every leader the idle tick on which it
        // finalizes (`maybeFinalize` runs only when the tick dialled nothing).
        if (quietRounds >= 2) return i + 1;
      }
      throw new Error(`Floor did not drain within ${o.maxRounds} rounds (seed ${seed}); ${carrier.liveCount()} calls live`);
    },

    /** Every per-round invariant, as a list of violations. Empty means healthy. */
    async checkInvariants(ctx: { round?: number } = {}): Promise<string[]> {
      return checkInvariants(ctx.round ?? roundNo);
    },

    /** The end-of-run audit, as a list of violations. */
    async finalAudit(): Promise<string[]> {
      return finalAudit();
    },

    async teardown(): Promise<void> {
      rt.dialer.stop();
      rt.wrapup.stop();
      rt.reaper.stop();
      rt.stopStationSweep();
      await rt.pacing.stop().catch(() => { /* never started */ });
      await redis.flushdb().catch(() => { /* connection already gone */ });
      redis.disconnect();
    },
  };

  async function attemptCounts(): Promise<Map<string, number>> {
    const { rows } = await db.query<{ campaign_id: string; n: number }>(
      `SELECT campaign_id, count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = ANY($1::uuid[]) GROUP BY campaign_id`,
      [campaigns.map((c) => c.id)],
    );
    return new Map(rows.map((r) => [r.campaign_id, r.n]));
  }

  async function outstandingWork(): Promise<boolean> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_contacts c JOIN agency_campaigns cam ON cam.id = c.campaign_id
        WHERE c.campaign_id = ANY($1::uuid[])
          AND ((cam.status = 'running' AND c.state = 'pending' AND c.next_attempt_at <= now()) OR c.state = 'in_flight'
               OR cam.status = 'stopping')`,
      [campaigns.map((c) => c.id)],
    );
    return rows[0]!.n > 0;
  }

  const tag = (round: number) => `[seed ${seed}, round ${round}]`;

  async function checkInvariants(round: number): Promise<string[]> {
    const v: string[] = [];
    const ids = campaigns.map((c) => c.id);

    // 1. No contact carries two live attempts (the DB index makes this the backstop's
    //    own claim; asserted anyway, because it is the property).
    const { rows: dupContacts } = await db.query<{ contact_id: string; n: number }>(
      `SELECT contact_id, count(*)::int AS n FROM agency_call_attempts
        WHERE campaign_id = ANY($1::uuid[]) AND state <> 'ended' GROUP BY contact_id HAVING count(*) > 1`, [ids]);
    for (const r of dupContacts) v.push(`${tag(round)} contact ${r.contact_id} has ${r.n} live attempts`);

    // 2. No agent holds two live attempts — the per-agent conservation law.
    const { rows: dupAgents } = await db.query<{ reserved_agent_id: string; n: number }>(
      `SELECT reserved_agent_id, count(*)::int AS n FROM agency_call_attempts
        WHERE campaign_id = ANY($1::uuid[]) AND state <> 'ended' AND reserved_agent_id IS NOT NULL
        GROUP BY reserved_agent_id HAVING count(*) > 1`, [ids]);
    for (const r of dupAgents) v.push(`${tag(round)} agent ${r.reserved_agent_id} holds ${r.n} live attempts`);

    // 3. Live attempts within the account cap and within the campaign's agent pool
    //    (strict power dialing: pacing ratio 1 × agents), and none left `queued`
    //    once the tick that created it has returned.
    const { rows: live } = await db.query<{ campaign_id: string; live: number; queued: number; lim: number; sessions: number }>(
      `SELECT cam.id AS campaign_id,
              count(a.id) FILTER (WHERE a.state <> 'ended')::int AS live,
              count(a.id) FILTER (WHERE a.state = 'queued')::int AS queued,
              COALESCE(max(s.max_concurrent_calls), 5) AS lim,
              (SELECT count(*)::int FROM agency_agent_sessions x WHERE x.campaign_id = cam.id) AS sessions
         FROM agency_campaigns cam
         LEFT JOIN agency_call_attempts a ON a.campaign_id = cam.id
         LEFT JOIN account_settings s ON s.tenant_id = cam.tenant_id AND s.account_id = cam.account_id
        WHERE cam.id = ANY($1::uuid[])
        GROUP BY cam.id`, [ids]);
    for (const r of live) {
      const label = campaignById.get(r.campaign_id)?.spec.label;
      if (r.live > r.lim) v.push(`${tag(round)} campaign ${label}: ${r.live} live attempts > account cap ${r.lim}`);
      if (r.live > r.sessions) v.push(`${tag(round)} campaign ${label}: ${r.live} live attempts > ${r.sessions} agents`);
      if (r.queued > 0) v.push(`${tag(round)} campaign ${label}: ${r.queued} attempts still queued after the tick`);
    }

    // 4. Isolation: an attempt, its contact, its campaign and its agent all agree on
    //    tenant, account and campaign.
    const { rows: leaks } = await db.query<{ id: string }>(
      `SELECT a.id FROM agency_call_attempts a
         JOIN agency_contacts c ON c.id = a.contact_id
         JOIN agency_campaigns cam ON cam.id = a.campaign_id
         LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
        WHERE a.campaign_id = ANY($1::uuid[])
          AND (s.id IS NULL
               OR a.tenant_id <> c.tenant_id OR a.tenant_id <> cam.tenant_id OR a.tenant_id <> s.tenant_id
               OR a.account_id <> c.account_id OR a.account_id <> cam.account_id OR a.account_id <> s.account_id
               OR c.campaign_id <> a.campaign_id OR s.campaign_id <> a.campaign_id)`, [ids]);
    for (const r of leaks) v.push(`${tag(round)} attempt ${r.id} crosses a tenant/account/campaign boundary`);

    // 5. Claims and attempts agree: every `in_flight` contact has a live attempt
    //    (no stranded claim) and every live attempt's contact is claimed.
    const { rows: stranded } = await db.query<{ id: string }>(
      `SELECT c.id FROM agency_contacts c
        WHERE c.campaign_id = ANY($1::uuid[]) AND c.state = 'in_flight'
          AND NOT EXISTS (SELECT 1 FROM agency_call_attempts a WHERE a.contact_id = c.id AND a.state <> 'ended')`, [ids]);
    for (const r of stranded) v.push(`${tag(round)} contact ${r.id} is in_flight with no live attempt`);
    const { rows: unclaimed } = await db.query<{ id: string; state: string }>(
      `SELECT a.id, c.state FROM agency_call_attempts a JOIN agency_contacts c ON c.id = a.contact_id
        WHERE a.campaign_id = ANY($1::uuid[]) AND a.state <> 'ended' AND c.state NOT IN ('in_flight', 'connected')`, [ids]);
    for (const r of unclaimed) v.push(`${tag(round)} live attempt ${r.id} on a contact in '${r.state}'`);

    // 6. Redis and Postgres agree about who is on what: every live attempt's agent
    //    is reserved/on_call FOR THAT ATTEMPT, and every reserved/on_call agent is
    //    bound to a live attempt reserved for them (no orphaned reservation).
    const { rows: liveRows } = await db.query<{ id: string; reserved_agent_id: string }>(
      `SELECT id, reserved_agent_id FROM agency_call_attempts WHERE campaign_id = ANY($1::uuid[]) AND state <> 'ended'`, [ids]);
    const liveById = new Map(liveRows.map((r) => [r.id, r.reserved_agent_id]));
    const sessionIds = agents.map((a) => a.sessionId);
    const states = await rt.agents.getMany(sessionIds);
    const stateBySession = new Map(sessionIds.map((id, i) => [id, states[i]]));
    for (const r of liveRows) {
      const s = stateBySession.get(r.reserved_agent_id);
      if (!s || (s.state !== 'reserved' && s.state !== 'on_call') || s.attemptId !== r.id) {
        v.push(`${tag(round)} live attempt ${r.id}: its agent reads ${s?.state ?? 'no lease'}/${s?.attemptId ?? ''} in Redis`);
      }
    }
    for (const [sessionId, s] of stateBySession) {
      if (!s || (s.state !== 'reserved' && s.state !== 'on_call')) continue;
      if (!s.attemptId || liveById.get(s.attemptId) !== sessionId) {
        v.push(`${tag(round)} agent ${sessionId} is ${s.state} in Redis for '${s.attemptId ?? ''}', which is not a live attempt of theirs`);
      }
    }

    // 7. The carrier: no attempt dialled twice, every absorption barrier landed, and
    //    every live call has a live attempt (a call nobody accounts for is a call
    //    nobody will settle).
    for (const id of carrier.duplicateDials) v.push(`${tag(round)} attempt ${id} was dialled twice`);
    for (const t of carrier.barrierTimeouts) v.push(`${tag(round)} absorption barrier: attempt ${t.attemptId} waiting for ${t.waitingFor}, saw ${t.observed}`);
    for (const c of carrier.liveCalls()) {
      if (!liveById.has(c.attemptId)) v.push(`${tag(round)} carrier holds call for attempt ${c.attemptId} with no live attempt row`);
    }
    return v;
  }

  async function finalAudit(): Promise<string[]> {
    const v: string[] = [];
    const ids = campaigns.map((c) => c.id);
    const t = `[seed ${seed}, final]`;

    // Every attempt reached a terminal state, with an outcome and an end instant.
    const { rows: open } = await db.query<{ id: string; state: string; outcome: string | null }>(
      `SELECT id, state, outcome FROM agency_call_attempts
        WHERE campaign_id = ANY($1::uuid[]) AND (state <> 'ended' OR outcome IS NULL OR ended_at IS NULL)`, [ids]);
    for (const r of open) v.push(`${t} attempt ${r.id} not terminal: state=${r.state} outcome=${r.outcome}`);

    // Roster exactly-once: every contact terminal, or pending on a retry that is
    // genuinely scheduled for later. Nothing in flight, nothing dialable-now left
    // behind on a campaign that stopped dialing.
    const { rows: bad } = await db.query<{ id: string; state: string; campaign_id: string; due: boolean; attempts: number }>(
      `SELECT c.id, c.state, c.campaign_id, (c.next_attempt_at <= now()) AS due,
              (SELECT count(*)::int FROM agency_call_attempts a WHERE a.contact_id = c.id) AS attempts
         FROM agency_contacts c JOIN agency_campaigns cam ON cam.id = c.campaign_id
        WHERE c.campaign_id = ANY($1::uuid[])
          AND (c.state = 'in_flight' OR c.state = 'connected'
               OR (c.state = 'pending' AND cam.status = 'running' AND c.next_attempt_at <= now()))`, [ids]);
    for (const r of bad) {
      v.push(`${t} contact ${r.id} (${campaignById.get(r.campaign_id)?.spec.label}) left ${r.state}${r.due ? ' and due' : ''} after ${r.attempts} attempts`);
    }

    // Counters agree with tables: each contact's charged attempts equal the attempts
    // whose call the carrier actually took (a call refused before the carrier — and
    // only that — charges nothing), and `last_outcome` is the last such attempt's.
    const { rows: drift } = await db.query<{ id: string; charged: number; dialled: number; last_outcome: string | null; last_dialled: string | null }>(
      `SELECT c.id, c.attempt_count + c.our_fault_attempts AS charged,
              (SELECT count(*)::int FROM agency_call_attempts a WHERE a.contact_id = c.id AND a.webrtc_call_id IS NOT NULL) AS dialled,
              c.last_outcome,
              (SELECT a.outcome FROM agency_call_attempts a WHERE a.contact_id = c.id AND a.webrtc_call_id IS NOT NULL
                ORDER BY a.attempt_number DESC LIMIT 1) AS last_dialled
         FROM agency_contacts c WHERE c.campaign_id = ANY($1::uuid[])`, [ids]);
    for (const r of drift) {
      if (r.charged !== r.dialled) v.push(`${t} contact ${r.id}: charged ${r.charged} attempts, carrier took ${r.dialled}`);
      if (r.dialled > 0 && r.last_outcome !== r.last_dialled) {
        v.push(`${t} contact ${r.id}: last_outcome ${r.last_outcome} but last dialled attempt ended ${r.last_dialled}`);
      }
    }

    // Attempt numbers: unique and gapless 1..n per contact (the retry policy and the
    // agent's history both read them).
    const { rows: gaps } = await db.query<{ contact_id: string; n: number; mx: number; distinct_n: number }>(
      `SELECT contact_id, count(*)::int AS n, max(attempt_number)::int AS mx, count(DISTINCT attempt_number)::int AS distinct_n
         FROM agency_call_attempts WHERE campaign_id = ANY($1::uuid[]) GROUP BY contact_id
       HAVING count(*) <> max(attempt_number) OR count(DISTINCT attempt_number) <> count(*) OR min(attempt_number) <> 1`, [ids]);
    for (const r of gaps) v.push(`${t} contact ${r.contact_id}: ${r.n} attempts numbered up to ${r.mx} (${r.distinct_n} distinct)`);

    // The carrier: every dial maps to exactly one attempt row and its call id.
    const { rows: calls } = await db.query<{ id: string; webrtc_call_id: string | null }>(
      `SELECT id, webrtc_call_id FROM agency_call_attempts WHERE campaign_id = ANY($1::uuid[]) AND webrtc_call_id IS NOT NULL`, [ids]);
    const callByAttempt = new Map(calls.map((r) => [r.id, r.webrtc_call_id]));
    for (const d of carrier.dials) {
      if (callByAttempt.get(d.attemptId) !== d.callId) v.push(`${t} carrier dial ${d.attemptId} is not recorded on its attempt row`);
    }
    if (calls.length !== carrier.dials.length) v.push(`${t} ${calls.length} attempts carry a call id, carrier placed ${carrier.dials.length}`);
    if (carrier.liveCount() !== 0) v.push(`${t} carrier still holds ${carrier.liveCount()} live calls`);
    for (const id of carrier.duplicateDials) v.push(`${t} attempt ${id} was dialled twice`);
    for (const b of carrier.barrierTimeouts) v.push(`${t} absorption barrier: attempt ${b.attemptId} waiting for ${b.waitingFor}, saw ${b.observed}`);

    // No agent left reserved or on a call in Redis.
    const states = await rt.agents.getMany(agents.map((a) => a.sessionId));
    states.forEach((s, i) => {
      if (s && (s.state === 'reserved' || s.state === 'on_call')) {
        v.push(`${t} agent ${agents[i]!.label} still ${s.state} (${s.attemptId ?? ''}) after the floor drained`);
      }
    });
    return v;
  }

  return world;
}

export type FloorWorld = Awaited<ReturnType<typeof createFloorWorld>>;

/** Rows of `agency_call_attempts` for a set of campaigns, for scenario-specific asserts. */
export async function attemptRows(campaignIds: readonly string[]): Promise<Array<{
  id: string; campaign_id: string; contact_id: string; state: string; outcome: string | null;
  reserved_agent_id: string; attempt_number: number; answered_at: Date | null; bridged_at: Date | null;
  dialed_at: Date | null; webrtc_call_id: string | null; tenant_id: string; created_at: Date;
}>> {
  const { rows } = await getTestPool().query(
    `SELECT id, campaign_id, contact_id, state, outcome, reserved_agent_id, attempt_number,
            answered_at, bridged_at, dialed_at, webrtc_call_id, tenant_id, created_at
       FROM agency_call_attempts WHERE campaign_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    [campaignIds],
  );
  return rows;
}

export async function contactStateCounts(campaignId: string): Promise<Record<string, number>> {
  const { rows } = await getTestPool().query<{ state: string; n: number }>(
    'SELECT state, count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 GROUP BY state', [campaignId],
  );
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

/** The pacing law for one campaign-round: exactly `min(available, cap − live, claimable)` new dials. */
export function expectedDials(s: Pick<CampaignRoundStat, 'availableBefore' | 'liveBefore' | 'limit' | 'claimableBefore' | 'status'>): number {
  if (s.status !== 'running') return 0;
  return Math.max(0, Math.min(s.availableBefore, s.limit - s.liveBefore, s.claimableBefore));
}
