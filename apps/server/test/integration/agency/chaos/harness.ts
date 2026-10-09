import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { getTestPool } from '../../setup/test-utils.js';
import { uuidFor } from '../../setup/factories.js';
import { TEST_REDIS_URL } from '../../../helpers/test-redis.js';
import {
  insertAgencyCampaign,
  insertAgencyContacts,
  insertAgentSession,
} from '../agency-factories.js';
// The ONE function that decides whether a bridged call owes a write-up, imported
// from the product rather than restated here — see {@link ScriptedBridge.emit}.
//
// Statically, unlike every other `src/` import in this file. That is safe for this
// module specifically and was checked rather than assumed: `outcome-classifier.ts`
// has only `import type` lines, which are erased, so it pulls no `logger`, no
// `db/connection` and no config graph at runtime and cannot load anything ahead of
// a caller's `vi.mock`.
import { requiresDisposition } from '../../../../src/agency/outcome-classifier.js';

/*
 * PORT NOTE (magick-agency, Phase 6): ported from core
 * test/integration/agency/chaos/harness.ts@4850d1d9. The design is core's, verbatim:
 * the real `AgencyRuntime` (pacing engine, dialer, station registry, agent state
 * machine, reaper) over REAL Postgres and REAL Redis, with `ScriptedBridge` standing
 * in for the carrier and `FakeStationSocket` for the browser. Recorded changes:
 *  - Redis: the worktree's agency test URL (6383, a non-zero db from
 *    `.test-env.local.json`) instead of core's hard-coded 6380; `CHAOS_DB` is read
 *    off that URL rather than fixed at 7 (see the constant).
 *  - Agent user ids are UUIDs (`uuidFor('chaos-agent-<i>')`, the same deterministic
 *    label core used): the baseline types `agent_user_id` UUID.
 *  - DNC (decision B8): there is no Redis set to publish, so
 *    `makeTenantDncAuthoritative` no longer calls `applyReplace` — a tenant with no
 *    `dnc_entries` row is authoritative by construction. It still asks the gate's own
 *    `check()` and still throws unless the answer is `clear`, which is the half its
 *    own comment calls load-bearing. `chaos.resyncDnc` therefore only re-proves that.
 *  - `check()` takes the scope the pre-dial gate passes (this campaign and account).
 *  - The metric reader is core's `test/helpers/otel-metric-reader.ts`, ported at the
 *    same path (see its header).
 *  - Config/logger import specifiers per the path rule.
 */

/**
 * ─── AD-P2-X-01 — THE CHAOS HARNESS ────────────────────────────────────────
 *
 * A scenario here is a **scripted, repeatable run**, not a procedure someone
 * follows. That is the acceptance criterion, and it drives every design choice
 * below:
 *
 * - **Nothing is driven by a wall-clock interval.** The pacing engine's own
 *   `setInterval` supervisor is never started; the harness calls `tickOnce`
 *   directly. A scenario that depends on a 250ms tick landing before a 5ms
 *   bridge event is a scenario that fails differently on a loaded CI box, and
 *   an intermittent chaos suite is worse than none — it trains people to re-run.
 * - **The bridge is a queue, not a timer.** `createBridgedCall` enqueues a
 *   scripted lifecycle sequence and `flush()` drains it, awaiting each
 *   listener. So a run is deterministic end to end and a failure is
 *   reproducible from the seed alone. The one place wall-clock is unavoidable
 *   is a Redis TTL genuinely lapsing, and that scenario says so.
 * - **Everything real that can be real, is.** The real `PacingEngine`, the real
 *   `AgencyDialer`, the real `StationRegistry` and `AgentStateMachine` against
 *   real Redis, the real repositories against real Postgres. The fakes are the
 *   carrier and the browser socket, because those are the two things we cannot
 *   host. In particular the station registry is NOT faked: the ownership key it
 *   writes is what `dialUpTo` consults before every dial, and a fake would make
 *   the whole ownership question untestable.
 *
 * **Assertions read Postgres and Redis. Never logs.** A log line proves a code
 * path was entered; it does not prove the system ended up anywhere in
 * particular, and it silently stops meaning anything the day someone reworks a
 * message. Every helper this module exports returns state.
 *
 * ── The private Redis database ─────────────────────────────────────────────
 * Database 7, for the reason `agency-lease-ring-duration.test.ts` documents at
 * length: `flushTestRedis()` calls `FLUSHDB` on database 0, this worktree is
 * shared, and an overlapping run flushing db0 mid-scenario reads exactly like a
 * lease bug. It is doubly important here, because one of these scenarios
 * flushes a database ON PURPOSE — sharing db0 would mean the chaos suite is
 * itself the hazard the other suites are protecting against.
 */

// PORT NOTE: `TEST_REDIS_URL` is the agency harness's (imported above).

/**
 * This suite's own database. Touched by nothing else.
 *
 * PORT NOTE: core pinned 7 on a Redis shared with every other suite on db 0. Here the
 * worktree's whole test Redis db is already private to this checkout (its
 * `.test-env.local.json`), and the harness may not touch any other db index (the
 * agency guard refuses db 0 and other worktrees own the rest), so the chaos database
 * IS the worktree's — read off its URL.
 */
export const CHAOS_DB = Number(new URL(TEST_REDIS_URL).pathname.replace(/^\//, '') || '0');

/** Matches the `keyPrefix` given to the client, so key scans line up. */
export const KEY_PREFIX = 'chaos:';

/**
 * How long an emitted lifecycle event may take to appear in Postgres.
 *
 * Generous on purpose: it is not a performance assertion, it is a bound on a
 * deadlock. A healthy absorption is three loopback round trips (~1ms); anything
 * approaching this is a genuinely stuck listener and is reported, not hidden.
 */
const ABSORB_TIMEOUT_MS = 2_000;

/**
 * Extra ticks `runUntilQuiescent` will spend waiting for the fire-and-forget
 * lifecycle chain to land before it accepts a no-dial tick as quiescence. Bounded
 * so a deliberately-parked call can delay the loop but never hang it.
 */
export const QUIESCENCE_SETTLE_TICKS = 20;

/**
 * The outcome the real bridge stamps on every agency call's browser-leg close
 * (`webrtc-bridge-manager.ts:360` — `browserHangupOutcome: 'agent_disconnected'`,
 * fixed there for `createBridgedCall` and not a parameter any caller supplies).
 *
 * Exported so a scenario asserts against the same constant the fake emits, and so
 * §15.9's pair has one place to change. A value copied silently into a test double
 * becomes a fiction the moment the product renames it — and the scenario goes on
 * passing, because both halves of the comparison moved together.
 */
export const AGENT_DISCONNECT_OUTCOME = 'agent_disconnected';

/**
 * How far ahead of the bridge this carrier reports the answer, in ms.
 *
 * Named rather than inline because it is the *only* reason `answered_at` and
 * `bridged_at` can differ in any scenario, and §10.1's standing falsifier —
 * `answered_at != bridged_at` on at least one genuinely bridged row — is an
 * assertion about this number reaching Postgres intact. Inline, it was a `- 40`
 * repeated in four emit sites with a comment claiming the property; a test
 * asserting the property had nothing to compare against but its own copy of 40.
 *
 * Well inside `ABANDONMENT_BRIDGE_GRACE_MS` (1000) on purpose: a bridged call
 * must NOT be abandoned, so the lead has to be observable and compliant at once.
 */
export const SCRIPTED_ANSWER_LEAD_MS = 40;

// ── Fakes: the carrier and the browser socket ──────────────────────────────

/** A station socket that is open and records every frame written to it. */
export class FakeStationSocket extends EventEmitter {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  /** Frames of one event type, in order — for ordering assertions. */
  ofType(event: string): Array<Record<string, unknown>> {
    return this.sent.filter((f) => f['event'] === event);
  }
}

/** What the scripted carrier does with one attempt. */
export interface CallScript {
  /** Carrier reports off-hook. Emits the `answered` phase with its own instant. */
  answer: boolean;
  /** Media reaches this agent's socket. Requires `answer`. */
  bridge: boolean;
  /** Terminal status handed to the outcome classifier. */
  status: 'completed' | 'no_answer' | 'busy' | 'failed';
  /** Seconds of talk time reported on the terminal event. */
  talkTimeSeconds?: number;
  /**
   * Leave the call live after `flush()` — no terminal event is emitted until
   * `endHeld()` is called. This is how a scenario gets calls that are genuinely
   * in flight when the chaos verb fires.
   */
  hold?: boolean;
  /**
   * Park the call **still ringing**: no `answered`, no `bridged`, no terminal
   * event until something ends it.
   *
   * `hold` is not a substitute. `hold` parks the call *after* the answered/bridged
   * pair, so the only in-flight state it can produce is a live conversation —
   * there was previously no way to leave a call ringing while the agent's socket
   * went away, which is the entire network-drop-during-ring scenario and the case
   * where re-attach cannot be keyed on a call id at all (the id does not exist
   * until `createBridgedCall` resolves).
   */
  holdAtRing?: boolean;
  /**
   * Park the call **answered but never bridged**, and leave it live.
   *
   * The one in-flight shape neither `hold` nor `holdAtRing` can produce, and the
   * only one on which §10's terminal filter is observable: `answered_at` is set,
   * `bridged_at` is NULL, and the attempt is not `ended`. Without
   * `state = 'ended'` the predicate counts this row as abandoned **while the
   * bridge is still arriving** — which is the defect ratified away at `8da1bea`,
   * and it is invisible to any assertion taken after the call is over.
   *
   * Requires `answer: true` and `bridge: false`.
   */
  holdAfterAnswer?: boolean;
}

const DEFAULT_SCRIPT: CallScript = { answer: true, bridge: true, status: 'completed', talkTimeSeconds: 12 };

/**
 * Refuse a script whose stages contradict each other, at the point it is set.
 *
 * `{ holdAtRing: true, answer: true }` is the combination that matters. It reads
 * as "park it ringing and then answer", and there is no such sequence — the call
 * either stays in `dialing` or it does not. Silently letting `holdAtRing` win
 * would give a mid-ring scenario a call that never rang; silently letting
 * `answer` win would give it an ordinary connected call that passes every
 * assertion about the *end* state while never entering the state under test.
 * Either way the scenario proves nothing and says it proved something, so this
 * throws where the mistake is written rather than where it fails to show up.
 */
function assertScript(script: CallScript): CallScript {
  if (script.holdAtRing && (script.answer || script.bridge)) {
    throw new Error(
      'CallScript: holdAtRing cannot be combined with answer/bridge — a call parked mid-ring '
      + 'has not answered. Use { answer: false, bridge: false, holdAtRing: true }.',
    );
  }
  if (script.holdAtRing && script.hold) {
    throw new Error('CallScript: holdAtRing and hold are different parks — pick one.');
  }
  if (script.holdAfterAnswer && (!script.answer || script.bridge)) {
    throw new Error(
      'CallScript: holdAfterAnswer needs { answer: true, bridge: false } — it parks a call '
      + 'that the carrier answered and the bridge has not reached.',
    );
  }
  if (script.holdAfterAnswer && (script.hold || script.holdAtRing)) {
    throw new Error('CallScript: holdAfterAnswer, hold and holdAtRing are three different parks — pick one.');
  }
  if (script.bridge && !script.answer) {
    throw new Error('CallScript: bridge requires answer — media cannot reach an unanswered call.');
  }
  return script;
}

interface PendingCall {
  callId: string;
  attemptId: string;
  script: CallScript;
  /** Set once the answered/bridged pair has been emitted. */
  opened: boolean;
  /**
   * The re-attach window the DIALER asked for, in ms.
   *
   * Captured from `createBridgedCall`'s `browserCloseGraceMs` rather than assumed:
   * the real bridge treats an omitted or 0 value as "hang up immediately on
   * browser close", so a harness that hard-coded 8s would pass against a dialer
   * that had stopped requesting a window at all.
   */
  graceMs: number;
  /** True once the browser leg closed and the window is running. */
  graceArmed: boolean;
  /** Terminal event emitted; the session is gone and cannot be re-adopted. */
  ended: boolean;
  /**
   * The instant this carrier reported the answer — the ONE value, emitted on the
   * `answered` phase and re-sent on `bridged`.
   *
   * A single recorded value rather than a fresh `new Date()` per emit, and that is
   * not tidiness: `setState('bridged', { answered_at: ev.answeredAt })` writes
   * through `COALESCE($6, answered_at)`, so with two different instants the second
   * one is silently discarded and a test comparing the row against "the instant the
   * bridge emitted" would have two candidates and no way to say which. The real
   * bridge has one `session.answeredAt`; so does this one.
   */
  answeredAt?: Date;
}

/**
 * The carrier, as a drainable queue.
 *
 * The `answered` phase is emitted **separately from and strictly before**
 * `bridged`, with its own timestamp — which is the whole point of core's
 * `e4ec019`. Collapsing them here would make every abandonment assertion in
 * §10 vacuous again, in the test harness this time instead of in the product,
 * and the suite would have no way to notice.
 */
export class ScriptedBridge {
  private readonly listeners: Array<(ev: unknown) => void> = [];
  private queue: PendingCall[] = [];
  private held: PendingCall[] = [];
  /** Calls parked mid-ring by `holdAtRing`. Never answered, never ended, yet. */
  private ringing: PendingCall[] = [];
  /**
   * attemptId → call, for every call this bridge has ever created, INCLUDING
   * ended ones.
   *
   * Keyed on the attempt id because that is the `correlationId` the real bridge
   * keys `reattachBorrowedBrowserLeg` and `forceEndWithOutcome` on, and for the
   * same reason it does: the call id is unknowable until `createBridgedCall`
   * resolves, and a socket can drop before that. Ended calls are retained rather
   * than deleted so a re-attach arriving after the window lapsed gets `false`
   * (the real bridge's `session.endHandled` arm) rather than the identical
   * `false` that means "no such call" — see {@link reattachBorrowedBrowserLeg}.
   */
  private readonly byAttempt = new Map<string, PendingCall>();
  /** attemptId → script. Anything unscripted takes `DEFAULT_SCRIPT`. */
  private readonly scripts = new Map<string, CallScript>();
  private defaultScript: CallScript = DEFAULT_SCRIPT;
  /** Every call the dialer asked for, in order. Read by assertions. */
  readonly dialed: Array<{ attemptId: string; destinationPhone: string; callerId: string }> = [];
  /**
   * Events the database never absorbed within {@link ABSORB_TIMEOUT_MS}.
   *
   * Empty on a healthy run. A scenario that expects clean absorption asserts
   * this is empty; one that deliberately kills the listener does not. Exposing
   * it rather than throwing keeps the harness from deciding which failures are
   * interesting.
   */
  readonly absorbTimeouts: Array<{
    attemptId: string;
    phase: string;
    observedState: string | undefined;
    observedContactState: string | undefined;
  }> = [];

  setDefaultScript(script: CallScript): void {
    this.defaultScript = assertScript(script);
  }

  scriptFor(attemptId: string, script: CallScript): void {
    this.scripts.set(attemptId, assertScript(script));
  }

  onLifecycle(l: (ev: unknown) => void): () => void {
    this.listeners.push(l);
    return () => {
      const i = this.listeners.indexOf(l);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  async createBridgedCall(params: {
    agencyAttemptId: string;
    destinationPhone: string;
    callerId: string;
    browserCloseGraceMs?: number;
  }): Promise<{ id: string }> {
    const callId = randomUUID();
    const script = this.scripts.get(params.agencyAttemptId) ?? this.defaultScript;
    this.dialed.push({
      attemptId: params.agencyAttemptId,
      destinationPhone: params.destinationPhone,
      callerId: params.callerId,
    });
    const call: PendingCall = {
      callId,
      attemptId: params.agencyAttemptId,
      script,
      opened: false,
      // Captured, never assumed. The real bridge treats an omitted or 0 value as
      // "hang up the instant the browser leg closes", so a harness that hard-coded
      // 8s would model a re-attach window for a dialer that had stopped asking for
      // one — and `network-drop-during-ring` would pass against the regression it
      // exists to catch.
      graceMs: params.browserCloseGraceMs ?? 0,
      graceArmed: false,
      ended: false,
    };
    this.byAttempt.set(params.agencyAttemptId, call);
    this.queue.push(call);
    return { id: callId };
  }

  /**
   * Emit one lifecycle event and **wait for Postgres to absorb it**.
   *
   * `AgencyDialer`'s subscription is `(ev) => { void this.onBridgeLifecycle(ev) }`
   * — deliberately fire-and-forget, because the real listener is called
   * synchronously inside bridge teardown and must never block it or leak a
   * rejection into credit settlement. So awaiting the listener's return value
   * awaits *nothing*: it hands back `undefined` while three DB and Redis round
   * trips are still in flight.
   *
   * That is not a theoretical race. Measured on the first run of this harness:
   * three dials in one tick left the attempt rows reading `bridged`, `dialing`,
   * `dialing`, and a later flush produced `bridged`, `answered`, `bridged` — the
   * events had landed, the assertions had simply run first. A `setImmediate`
   * yield does not fix it either, because the pending work is real I/O.
   *
   * So the barrier is the **observable consequence**, read from the store the
   * assertions read. Anything else is a sleep wearing a disguise.
   *
   * ── The attempt row is NOT the last write, and reading only it under-waits ──
   *
   * The `bridged` handler writes TWO rows, in this order (`agency-dialer.ts`):
   *
   *     await agencyAttemptRepository.setState(attemptId, 'bridged', {…});
   *     if (requiresDisposition('connected', campaign.disposition_catalog)) {
   *       await agencyContactRepository.markState(contactId, 'connected');
   *     }
   *
   * A barrier that returns the instant the ATTEMPT reads `bridged` therefore
   * returns *inside* that pair, with the contact's write still in flight — the
   * same class of race this function exists to close, one row further along.
   * Observed as a 1-in-N red on `AD-P2-X-01`'s precondition: two agents, both
   * attempts `bridged`, and `contactStates()['connected']` reading **1**. The
   * two-call flush is what makes it visible — call A's contact write lands
   * during call B's polling, so the LAST call dialed is the one caught mid-pair,
   * and the count is short by exactly one however many agents are online.
   *
   * So `bridged` additionally waits for `agency_contacts.state = 'connected'` —
   * **but only when the second write is actually coming.**
   *
   * ── Why the condition, and why it is read per event rather than configured ──
   *
   * `MAG-88` made that contact write conditional: a campaign whose
   * `disposition_catalog` is empty owes no write-up, so the contact is left
   * `in_flight` for the duration of the call and the ATTEMPT row is genuinely the
   * last write of the handler. There is then no second half to wait for, and a
   * barrier that waits for one anyway burns the full {@link ABSORB_TIMEOUT_MS} on
   * every bridged call.
   *
   * That is not a slow test, it is a broken one, and the damage is not confined to
   * the scenarios that assert `connected`. Measured on the empty-catalog tree
   * before this condition existed: a 5-agent flush costs 5 × 2s, which outruns
   * `AGENT_LEASE_MS.on_call`, so the pool's leases lapse mid-run and dialing stops
   * dead — `roster-exactly-once`'s 200-contact and 60-contact runs both stalled at
   * **15** attempts (three rounds of five) and burned all 400 ticks. Four of the
   * nine reds on that run were that starvation, in scenarios that never so much as
   * mention `connected`, and none of the four was a product fault.
   *
   * The catalog is read from the joined campaign row **on every poll** rather than
   * captured when the world is built. `agency-agent-state-cycle.test.ts` flips
   * `disposition_catalog` on the live campaign mid-test and then bridges another
   * call, so a value cached at construction would be wrong for exactly the case
   * that cares. Reading it here also means the harness cannot drift from the
   * fixture: there is no second place to update.
   *
   * `requiresDisposition` is the product's own function, not a re-implementation.
   * A harness that restated the rule would keep passing through the next change to
   * it, which is the failure this whole condition exists to have caught.
   *
   * With the condition, the wait cannot stall a healthy run: when a write is owed
   * the two writes are consecutive, so an attempt that reads `bridged` has the
   * contact write already in flight. An attempt this replica holds no live record
   * of never reaches `bridged` at all (`onBridgeLifecycle` returns on `!live`
   * before writing anything), so that path times out exactly as it did before.
   *
   * ── Known residual, named rather than papered over ──
   *
   * The `ended` handler has the identical shape — attempt row, then one of three
   * contact writes — and this barrier does **not** cover it. It cannot use the
   * same trick: the post-end contact state is decided by the retry policy
   * (`pending`/`completed`/`suppressed`… and `connected` again when a
   * disposition is owed), so there is no single value to wait for, and the
   * obvious substitute — `contacts.updated_at >= attempts.updated_at` — is
   * defeated by `WrapupManager.enter()` writing the attempt row again *after*
   * the contact write. A scenario that reads contact state immediately after a
   * flush that ENDS calls should drive `runUntilQuiescent()` (whose repeated
   * ticks settle it) or assert on the attempt row.
   */
  private async emit(ev: Record<string, unknown>, absorbed: string[]): Promise<void> {
    for (const l of [...this.listeners]) await (l(ev) as unknown as Promise<void> | void);
    const attemptId = ev['correlationId'] as string;
    const deadline = Date.now() + ABSORB_TIMEOUT_MS;
    for (;;) {
      const { rows } = await getTestPool().query<{
        state: string;
        contact_state: string;
        disposition_catalog: unknown[] | null;
      }>(
        `SELECT a.state, c.state AS contact_state, cam.disposition_catalog
           FROM agency_call_attempts a
           JOIN agency_contacts c ON c.id = a.contact_id
           JOIN agency_campaigns cam ON cam.id = c.campaign_id
          WHERE a.id = $1`,
        [attemptId],
      );
      const state = rows[0]?.state;
      if (state === undefined) return;
      if (absorbed.includes(state)) {
        // The second half of the pair — for the one phase whose second write has a
        // determinate value, AND only when that write is going to happen at all.
        // Every other state is absorbed on the attempt row alone.
        //
        // `?? []` rather than `?? undefined`, and the difference is the whole
        // behaviour: `requiresDisposition(outcome, undefined)` returns TRUE, so a
        // defaulted read would put an unconfigured campaign back on the 2-second
        // stall this branch exists to avoid. Same reason `reaper.ts` spells its
        // fallback `?? []`.
        const owed = requiresDisposition('connected', rows[0]?.disposition_catalog ?? []);
        if (state !== 'bridged' || !owed || rows[0]?.contact_state === 'connected') return;
      } else if (state === 'ended') {
        // `ended` is always acceptable: a scenario may legitimately have torn the
        // attempt down before the event landed (agent socket gone, reaper ran),
        // and blocking on `bridged` there would hang a correct run.
        return;
      }
      if (Date.now() > deadline) {
        // Recorded, never thrown. A timeout here is evidence about the system,
        // not a harness fault to be swallowed — scenarios that expect clean
        // absorption assert `absorbTimeouts` is 0, and one that deliberately
        // breaks the listener does not.
        //
        // The contact state rides along because a timeout now has two causes, and
        // reporting only the attempt's would name the wrong one half the time.
        this.absorbTimeouts.push({
          attemptId,
          phase: ev['phase'] as string,
          observedState: state,
          observedContactState: rows[0]?.contact_state,
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  /**
   * Drain every queued call to its scripted conclusion.
   *
   * Returns the number of calls advanced, so a driver loop can tell "the run is
   * quiescent" from "the run is still producing work" without a sleep.
   */
  async flush(): Promise<number> {
    let advanced = 0;
    while (this.queue.length > 0) {
      const batch = this.queue;
      this.queue = [];
      for (const call of batch) {
        advanced++;
        // Checked FIRST, and before any event is emitted: the whole point of this
        // stage is that nothing has happened to the call yet. The attempt row stays
        // `dialing`, no `answered` instant exists, and `dropStation` can therefore
        // fire while the customer's phone is still ringing.
        if (call.script.holdAtRing) {
          this.ringing.push(call);
          continue;
        }
        if (call.script.answer) {
          // A distinct instant, deliberately in the past relative to the bridge.
          // `answered_at != bridged_at` for at least one row is §10.1's standing
          // falsifier, and it has to be true of the data this harness produces
          // or every scenario's abandonment check is vacuous. Recorded on the call
          // so a scenario can assert the row carries THIS instant rather than
          // re-deriving 40ms and comparing the harness with itself.
          call.answeredAt = new Date(Date.now() - SCRIPTED_ANSWER_LEAD_MS);
          await this.emit({
            callId: call.callId,
            correlationId: call.attemptId,
            phase: 'answered',
            answeredAt: call.answeredAt,
          }, ['answered', 'bridged']);
        }
        if (call.script.holdAfterAnswer) {
          // Answered and parked: no `bridged`, no terminal event. The attempt row
          // sits `answered` with `bridged_at` NULL for as long as the scenario wants.
          this.held.push(call);
          continue;
        }
        if (call.script.answer && call.script.bridge) {
          await this.emit({
            callId: call.callId,
            correlationId: call.attemptId,
            phase: 'bridged',
            status: 'in_progress',
            answered: true,
            // The SAME instant the `answered` phase carried, not a fresh one — see
            // {@link PendingCall.answeredAt}.
            answeredAt: call.answeredAt,
          }, ['bridged']);
        }
        call.opened = true;
        if (call.script.hold) {
          this.held.push(call);
          continue;
        }
        await this.emitEnd(call);
      }
    }
    return advanced;
  }

  private async emitEnd(call: PendingCall, override?: { status?: string; outcome?: string }): Promise<void> {
    call.ended = true;
    call.graceArmed = false;
    await this.emit({
      callId: call.callId,
      correlationId: call.attemptId,
      phase: 'ended',
      status: override?.status ?? call.script.status,
      answered: call.script.answer && call.script.bridge,
      talkTimeSeconds: call.script.bridge ? (call.script.talkTimeSeconds ?? 0) : 0,
      ...(override?.outcome === undefined ? {} : { outcome: override.outcome }),
    }, ['ended']);
  }

  /** End every call left live by `hold: true`. */
  async endHeld(): Promise<number> {
    const batch = this.held;
    this.held = [];
    for (const call of batch) await this.emitEnd(call);
    return batch.length;
  }

  /** Calls that are open and have not ended — genuinely in flight. */
  liveCount(): number {
    return this.held.length;
  }

  /** Calls parked mid-ring by `holdAtRing` and not yet resolved either way. */
  ringingCount(): number {
    return this.ringing.length;
  }

  /**
   * Abandon every held call WITHOUT emitting a terminal event, as a replica
   * death does. The rows stay non-terminal in Postgres and only the reaper can
   * clear them, which is the state the recovery scenarios need.
   *
   * Ringing calls go too: a replica that dies mid-dial strands a `dialing` row
   * exactly as it strands a `bridged` one, and a version that only orphaned the
   * bridged calls would leave the restart scenario's ringing attempt quietly
   * finishable by the very replica the scenario just killed.
   */
  orphanHeld(): number {
    const n = this.held.length + this.ringing.length;
    for (const call of [...this.held, ...this.ringing]) call.graceArmed = false;
    this.held = [];
    this.ringing = [];
    return n;
  }

  // ─── The deferred-hangup window (`AD-P2-C-07`) ────────────────────────────
  //
  // Modelled rather than mocked: these three verbs reproduce the exact branch
  // structure of `registerBrowserLegHandlers`' `close` handler and
  // `reattachBorrowedBrowserLeg`, because the scenario's whole subject is which
  // branch a drop takes. A fake that simply "held the call for 8s" would collapse
  // the two things `T-B7` warns are different — the supersession guard at
  // `webrtc-bridge-manager.ts:900` (which of two OPEN sockets owns the call) and
  // the window (a socket that is simply gone) — and a scenario built on it passes
  // while the wifi-blip requirement sits unimplemented.

  /**
   * The agent's media socket closed: the `close` handler's branch, as the real
   * bridge takes it.
   *
   * Returns **true when the re-attach window was armed** and false when the call
   * was hung up on the spot — which is the observable difference between a dialer
   * that asked for a window and one that did not, and is why the return value is
   * asserted rather than ignored. With `graceMs === 0` the real bridge hangs up
   * immediately, so this does too; the outcome is `agent_disconnected`, which is
   * the string `createBridgedCall` pins for every agency call
   * (`webrtc-bridge-manager.ts:360`) and NOT one this harness chooses.
   */
  async dropBrowserLeg(attemptId: string): Promise<boolean> {
    const call = this.byAttempt.get(attemptId);
    if (!call || call.ended) return false;
    if (call.graceMs > 0) {
      // Idempotent, anchored on the FIRST drop — a flapping socket that re-armed
      // on every close could hold a customer on silence indefinitely, which is the
      // bound the window exists to impose (`armBrowserLegGrace`).
      call.graceArmed = true;
      return true;
    }
    await this.emitEnd(call, { status: call.script.answer ? 'completed' : 'canceled', outcome: AGENT_DISCONNECT_OUTCOME });
    return false;
  }

  /**
   * The window elapsed with no re-attach: `hangUpForBrowserClose` firing from the
   * grace timer.
   *
   * Deliberately explicit rather than a real `setTimeout` of `DEFERRED_HANGUP_MS`.
   * A scenario that slept 8s would be untestably slow and — worse — would make
   * "inside the window" and "past the window" differ only by wall clock, so a
   * loaded box would flip which branch ran. The two arms are separate calls, which
   * is what lets §15.9's pair be asserted separately instead of one of them
   * silently standing in for both.
   *
   * Returns false when there was no armed window, so a scenario cannot mistake
   * "the window expired" for "there was never a window" — the shape of assertion
   * that let a re-attach test pass against a bridge that never held anything.
   */
  async expireGrace(attemptId: string): Promise<boolean> {
    const call = this.byAttempt.get(attemptId);
    if (!call || call.ended || !call.graceArmed) return false;
    this.held = this.held.filter((c) => c !== call);
    this.ringing = this.ringing.filter((c) => c !== call);
    await this.emitEnd(call, {
      status: call.script.answer ? 'completed' : 'canceled',
      outcome: AGENT_DISCONNECT_OUTCOME,
    });
    return true;
  }

  /**
   * The window lapses and the call dies, but the `ended` lifecycle event has NOT
   * been delivered yet — the race `agency-dialer.ts:547` exists for.
   *
   * This is the only way to reach the bridge's own re-attach refusal, and without
   * it that branch is unreachable from any scenario. `expireGrace` emits the
   * terminal event, the dialer absorbs it and deletes the attempt from
   * `liveByAttempt`, so a subsequent `reattachStation` returns `null` at its FIRST
   * guard (`attemptIdFor`) having never consulted the bridge at all. A scenario
   * that stopped there would read as "the bridge refused a lapsed window" while
   * actually proving "the dialer forgot the attempt" — two different mechanisms,
   * one observation, and the bridge's guard could be deleted with the suite still
   * green. (Found by falsification: stubbing this bridge's refusal to always
   * return `true` reddened nothing.)
   *
   * Emits nothing on purpose, therefore. The call is dead to the bridge and still
   * live to the dialer, which is precisely the millisecond the product comment
   * describes.
   */
  lapseWindowSilently(attemptId: string): boolean {
    const call = this.byAttempt.get(attemptId);
    if (!call || call.ended) return false;
    call.ended = true;
    call.graceArmed = false;
    this.held = this.held.filter((c) => c !== call);
    this.ringing = this.ringing.filter((c) => c !== call);
    return true;
  }

  /** Is a re-attach window currently running for this attempt? */
  graceArmedFor(attemptId: string): boolean {
    return this.byAttempt.get(attemptId)?.graceArmed ?? false;
  }

  /**
   * The window the DIALER asked for, in ms — 0 when it asked for none.
   *
   * Read by the scenario rather than assumed, so "held for the deferred-hangup
   * window" is a claim about the value the product passed in.
   */
  graceMsFor(attemptId: string): number {
    return this.byAttempt.get(attemptId)?.graceMs ?? 0;
  }

  /**
   * `WebRtcBridgeManager.reattachBorrowedBrowserLeg`, which
   * `AgencyDialer.reattachStation` calls unconditionally.
   *
   * Absent, `chaos.reattachStation()` threw a `TypeError` inside a path the dialer
   * does not await — so every network-drop assertion would have run against a
   * re-attach that never happened, and the suite would have been green.
   *
   * The three refusals are the real ones, in the real order, and each is a
   * different `false`: the call is over (window lapsed), there is no such call, or
   * the socket handed in is not open. The last is not pedantry — `reattachStation`
   * is reached from a socket the caller has just opened, and a scenario that
   * re-attached the CLOSED socket it dropped would pass against a bridge that
   * resumed media onto a dead leg.
   */
  reattachBorrowedBrowserLeg(correlationId: string, ws: { readyState: number }): boolean {
    const call = this.byAttempt.get(correlationId);
    if (!call || call.ended) return false;
    if (ws.readyState !== 1) return false;
    call.graceArmed = false;
    return true;
  }

  /**
   * Let a call parked by `holdAtRing` proceed: answered, bridged, then held live.
   *
   * The counterpart to a successful re-attach, and it earns its place rather than
   * being a convenience. `reattachStation` returning an `active_attempt` payload
   * proves the dialer still *knows* about the attempt; it does not prove the
   * bridge can still put media on the new socket. Driving the parked ring through
   * to `bridged` afterwards is what separates a re-attach that resumed the call
   * from one that returned a description of a call nobody can hear — the
   * structural-versus-demonstrated distinction §16.4 records for the focus guard.
   */
  async resumeRinging(attemptId: string): Promise<boolean> {
    const call = this.byAttempt.get(attemptId);
    if (!call || call.ended || !this.ringing.includes(call)) return false;
    this.ringing = this.ringing.filter((c) => c !== call);
    // The script said `answer: false` (see `assertScript`), so the answered/bridged
    // pair is synthesized here — and `answered` must be reflected onto the script
    // or `emitEnd` would later report `answered: false` for a call that plainly was.
    call.script = { ...call.script, answer: true, bridge: true, holdAtRing: false, hold: true };
    call.answeredAt = new Date(Date.now() - SCRIPTED_ANSWER_LEAD_MS);
    await this.emit({
      callId: call.callId,
      correlationId: attemptId,
      phase: 'answered',
      answeredAt: call.answeredAt,
    }, ['answered', 'bridged']);
    // The listener may have ENDED this call inside that await — `abandonAnsweredCall`
    // hangs up synchronously from the `answered` handler when no live station owns
    // the agent. Bridging afterwards would emit media onto a call the product has
    // already settled, and the row's `abandoned` outcome would be overwritten by a
    // `connected` one: the scenario would report the abandoned path as broken when
    // in fact it had worked and the harness had undone it.
    if (call.ended) return false;
    await this.emit({
      callId: call.callId,
      correlationId: attemptId,
      phase: 'bridged',
      status: 'in_progress',
      answered: true,
      answeredAt: call.answeredAt,
    }, ['bridged']);
    call.opened = true;
    this.held.push(call);
    return true;
  }

  /**
   * Answer a call parked by `holdAtRing` and **stop there** — answered, unbridged,
   * still live.
   *
   * Not a convenience over {@link resumeRinging}: that verb drives the parked ring
   * all the way through `bridged`, and the two states this one can produce are
   * unreachable through it.
   *
   * 1. **The carrier answers into a lost station.** `abandonAnsweredCall` fires
   *    from inside the `answered` handler, and it is the ONLY path to a genuine
   *    `outcome = 'abandoned'` row in this harness — every abandonment assertion in
   *    every other scenario is `toBe(0)`, so nothing here has ever exercised
   *    `AD-P2-C-05`. Returns **false** when that happened, which is the observable
   *    difference between "the product abandoned it" and "the answer landed on a
   *    healthy call".
   * 2. **Answered-but-unbridged, live** — §10's terminal filter is only observable
   *    on this row. `holdAfterAnswer` reaches it too, but only from the top of a
   *    dial; this reaches it *after* a mid-ring chaos verb has run, which is the
   *    sequence a real lost station takes.
   */
  async answerRinging(
    attemptId: string,
    opts: { expect: 'abandoned' | 'live' },
  ): Promise<boolean> {
    const call = this.byAttempt.get(attemptId);
    if (!call || call.ended || !this.ringing.includes(call)) return false;
    this.ringing = this.ringing.filter((c) => c !== call);
    // `answer: true, bridge: false` — the shape `assertScript` requires of
    // `holdAfterAnswer`, and what `emitEnd` must later report as `answered: false`
    // so the classifier is not handed a bridge that never happened.
    call.script = { ...call.script, answer: true, bridge: false, holdAtRing: false, holdAfterAnswer: true };
    call.answeredAt = new Date(Date.now() - SCRIPTED_ANSWER_LEAD_MS);
    // ── The barrier is derived from `expect`, and this is a correctness fix ────
    //
    // The first version passed `['answered', 'bridged', 'ended']`, which made this
    // verb **intermittently wrong** and cost a run to diagnose. The dialer's
    // subscription is `(ev) => { void this.onBridgeLifecycle(ev) }`, so awaiting the
    // listener awaits nothing; on the abandoned path the hangup is still in flight
    // when `emit` starts polling. The poll would see `answered` — an accepted state
    // — and return, so `call.ended` was not yet set, this returned `true`, and the
    // scenario read an attempt whose `outcome` was still NULL. It passed or failed
    // by timing: the same three cases went 2-green-1-red on one run.
    //
    // `answered` therefore cannot be an accepted state for a call we expect to be
    // abandoned — it is the state the abandon passes *through*. So the caller
    // declares which end state it is driving toward and the barrier follows. The
    // declaration is CHECKED, not trusted: the return value still reports what
    // actually happened, so `expect: 'abandoned'` on a call that survives returns
    // `true` and the caller's assertion reds. A hint would have been another way to
    // write the same bug.
    const absorbed = opts.expect === 'abandoned' ? ['ended'] : ['answered', 'bridged'];
    await this.emit({
      callId: call.callId,
      correlationId: attemptId,
      phase: 'answered',
      answeredAt: call.answeredAt,
    }, absorbed);
    if (call.ended) return false;
    call.opened = true;
    this.held.push(call);
    return true;
  }

  /**
   * The instant this bridge told the dialer the carrier answered, or undefined
   * when it never did.
   *
   * Exists so §10.1's falsifier can be asserted as an **exact** equality against
   * the value the bridge emitted, rather than as `bridged_at > answered_at` plus a
   * test-side copy of {@link SCRIPTED_ANSWER_LEAD_MS}. The two are not the same
   * check: an inequality is satisfied by any dialer that writes *some* earlier
   * timestamp, including one that invents its own — and inventing one is precisely
   * what `AD-P2-C-11` was.
   */
  answeredAtFor(attemptId: string): Date | undefined {
    return this.byAttempt.get(attemptId)?.answeredAt;
  }

  // ─── The abandoned path's two bridge verbs (`AD-P2-C-05`) ─────────────────
  //
  // `AgencyDialer.abandonAnsweredCall` calls BOTH of these unconditionally, and
  // neither existed here. That is §16.6's third pattern exactly — a verb the
  // product calls and the harness does not have — and its consequence is the
  // dangerous one rather than a crash: `onBridgeLifecycle` is subscribed
  // fire-and-forget (`(ev) => { void this.onBridgeLifecycle(ev) }`), so the
  // `TypeError` was swallowed, the attempt was left non-terminal, and any scenario
  // asserting on the abandoned path would have gone GREEN having proven nothing.
  // Same defect class as the missing `reattachBorrowedBrowserLeg`, found the same
  // way: grep the product for what it calls on the object it is handed.

  /** Clip playbacks this bridge was asked for, in order. Read by assertions. */
  readonly clipPlays: Array<{ attemptId: string; clipHash: string; outcome: string }> = [];

  /**
   * `WebRtcBridgeManager.forceEndWithOutcome` — end a call by correlation id under
   * an outcome the caller names.
   *
   * The refusals are the real ones: no such call, or already settled. `status`
   * derives from whether the carrier answered, exactly as the real one derives it
   * from `session.answeredAt` — an abandoned call is `completed` because the
   * customer did pick up, and reporting `canceled` there would send the classifier
   * down its `canceled` arm where the outcome depends on `bridged`.
   */
  async forceEndWithOutcome(correlationId: string, outcome: string): Promise<boolean> {
    const call = this.byAttempt.get(correlationId);
    if (!call || call.ended) return false;
    await this.emitEnd(call, {
      status: call.answeredAt ? 'completed' : 'canceled',
      outcome,
    });
    return true;
  }

  /**
   * `WebRtcBridgeManager.playClipToCarrierThenHangUp` — the apology, then the
   * hangup, as one terminal act.
   *
   * The pacing, the frame conversion and the tail grace are all deliberately
   * absent: they are the bridge's own unit-tested business and modelling them here
   * would be a second implementation. What this reproduces is the part the dialer's
   * behaviour depends on — **a true return means the call is already settled under
   * `opts.outcome` and the caller must NOT hang up again** (`abandonAnsweredCall`
   * returns early on true), and a false obliges the caller to end it by its own
   * route.
   *
   * ⚠️ **Reached by no scenario today, and that is recorded rather than hidden.**
   * `resolveAbandonClip` returns a hash only for an announcement backed by real TTS
   * output or an S3 audio file, and this stack has neither — so every abandoned
   * call in this suite takes the bare-hangup arm. The verb exists because its
   * ABSENCE is the swallowed-TypeError trap above: the day someone configures
   * `abandon_announcement_id` in a fixture, the abandoned path would break silently
   * without it. `clipPlays` staying empty is asserted, so "the clip arm is
   * unreached" is a checked fact and not an assumption. §16.7 criterion 4's "the
   * apology clip is untested at any tier" therefore still stands, now with a reason.
   */
  async playClipToCarrierThenHangUp(
    correlationId: string,
    opts: { clipHash: string; outcome: string; status?: string },
  ): Promise<boolean> {
    const call = this.byAttempt.get(correlationId);
    if (!call || call.ended) return false;
    this.clipPlays.push({ attemptId: correlationId, clipHash: opts.clipHash, outcome: opts.outcome });
    await this.emitEnd(call, {
      status: opts.status ?? (call.answeredAt ? 'completed' : 'canceled'),
      outcome: opts.outcome,
    });
    return true;
  }
}

// ── The world ──────────────────────────────────────────────────────────────

export interface ChaosAgent {
  sessionId: string;
  agentUserId: string;
  socket: FakeStationSocket;
}

export interface ChaosWorldOptions {
  agents?: number;
  contacts?: number;
  /** Written to `account_settings`; the tick's D9 ceiling. */
  maxConcurrentCalls?: number;
  campaign?: Record<string, unknown>;
}

export interface ChaosWorld {
  redis: Redis;
  campaignId: string;
  tenantId: string;
  accountId: string;
  agents: ChaosAgent[];
  contactIds: string[];
  bridge: ScriptedBridge;
  replicaId: string;

  /**
   * The whole runtime, so a scenario can reach `rehydrateAgent` and
   * `releaseStationOnClose` — which live here, not on the parts, and are
   * therefore untestable through a hand-assembled copy.
   */
  runtime: import('../../../../src/agency/runtime.js').AgencyRuntime;
  /** The reaper, for scenarios that drive recovery explicitly. */
  reaper: import('../../../../src/agency/reaper.js').AgencyReaper;

  /** The real objects, exposed so a scenario can drive or break them. */
  pacing: import('../../../../src/agency/pacing-engine.js').PacingEngine;
  dialer: import('../../../../src/agency/agency-dialer.js').AgencyDialer;
  stations: import('../../../../src/agency/station-registry.js').StationRegistry;
  agentState: import('../../../../src/agency/agent-state-machine.js').AgentStateMachine;
  /**
   * The ONE registry, shared by everything that touches a queued break.
   *
   * Exposed because "queued but not yet applied" has no other honest observer:
   * the agent's Redis state is deliberately unchanged while a break waits, so a
   * scenario asserting on state alone cannot tell a correctly-queued break from
   * one that was silently dropped. Production holds exactly one instance
   * (`runtime.ts:45`) and a route-driven scenario must queue into *this* one —
   * two registries would show a break that never lands.
   */
  breaks: import('@magick-agency/domain/break-manager').BreakRegistry;

  /** One deterministic tick: plan → reserve → claim → dial → drain the carrier. */
  tick(): Promise<void>;
  /**
   * A second pacing engine over the same campaign, agents and stations.
   *
   * Models the split-brain the design says the leader lease cannot prevent — a
   * GC pause, a partition, clock skew — by simply not having a lease at all.
   * It shares the replica id deliberately: under D2 there is one replica, so
   * two leaders means two loops inside one process, and giving the fork a
   * different id would instead exercise the multi-replica ownership refusal,
   * which is a different (and currently unreachable) mechanism.
   */
  forkLeader(): import('../../../../src/agency/pacing-engine.js').PacingEngine;
  /** Tick until nothing changes. Returns the tick count actually used. */
  runUntilQuiescent(maxTicks?: number): Promise<number>;

  /** Attach a station socket and mark the agent available in Redis AND the DB. */
  bringOnline(agent: ChaosAgent): Promise<void>;

  /**
   * Replace the replica — old runtime stopped, new one with a NEW `replicaId`.
   *
   * `reap: false` reproduces the INVERTED boot (supervisor before reaper), which
   * is what makes the ordering assertion falsifiable: `runtime.ts` runs the
   * reaper first precisely because a supervisor started first computes occupancy
   * from dead rows and then quietly dials nothing forever.
   */
  restartReplica(opts?: { reap?: boolean }): Promise<{ previousReplicaId: string; replicaId: string }>;

  chaos: {
    /** Total Redis loss: a restart with no persistence, or a full eviction. */
    expireRedisWholesale(): Promise<void>;
    /** The owning replica dies: renewers stop, lifecycle subscription drops. */
    killRenewers(): void;
    /**
     * One agent's station socket goes away — the whole real event, driving BOTH
     * `close` handlers production registers on that socket (see the
     * implementation).
     *
     * - `wroteOffline` is `releaseStationOnClose`'s verdict: `true` = written
     *   `offline`, `false` = a live attempt exists, so the deferred hangup owns
     *   the outcome and the agent keeps its state for the window.
     * - `graceArmed` is whether the bridge held the call open rather than hanging
     *   up on the spot — the observable difference between a dialer that asked
     *   for a re-attach window and one that stopped asking, which no assertion on
     *   the end state can separate.
     * - `attemptId` is the attempt that was live at the moment of the drop, or
     *   `null` if there was none.
     */
    dropStation(sessionId: string): Promise<{
      wroteOffline: boolean;
      graceArmed: boolean;
      attemptId: string | null;
    }>;
    /**
     * The station reconnects onto whatever attempt it left behind, with a FRESH
     * socket (a reconnect is a new socket; reusing the closed one would let a
     * scenario pass against a bridge that never re-adopted anything).
     *
     * Resolves to the `active_attempt` payload the console would receive, or
     * `null` when there was nothing to resume — which is the observable
     * difference between "inside the window" and "too late".
     */
    reattachStation(sessionId: string): Promise<import('@magick-agency/contracts/agency').AgencyActiveAttempt | null>;
    /**
     * Master re-publishes the tenant's DNC list — **the other half of recovery
     * from a wholesale Redis loss** (`AD-P3-C-06`).
     *
     * `expireRedisWholesale()` deletes the DNC version key along with everything
     * else, and the pre-dial gate then `halt`s on `dnc_unavailable` for the whole
     * campaign. That is correct fail-closed behaviour and it is exactly what
     * production does, so a recovery arm that restores only the *agents* has
     * modelled half the outage: agents re-attach, the pool is live, and the tick
     * still dials nothing. The symptom is zero dials, which is indistinguishable
     * from a pacing bug.
     *
     * Deliberately a separate verb rather than folded into `bringOnline`, because
     * the two recoveries are independent in production — the agents come back when
     * the humans reconnect, the list comes back when master's sync loop next runs —
     * and a scenario asserting the fail-closed *interim* needs to restore one
     * without the other.
     *
     * Version 1 is legitimate after a flush and after no flush at all:
     * `PROMOTE_SCRIPT` refuses only a version strictly *lower* than the applied
     * one, and post-flush there is no applied one.
     */
    resyncDnc(version?: number): Promise<void>;
  };

  teardown(): Promise<void>;
}

/**
 * Make a tenant's DNC set authoritative, and PROVE it (`AD-P3-C-06`).
 *
 * One implementation, called from world setup and from `chaos.resyncDnc` both, so
 * the assertion cannot be present in one place and forgotten in the other — the
 * shape that let the same seeding be "surveyed" as missing when it was central.
 *
 * The pre-dial gate refuses when a tenant has no applied DNC version: an empty
 * Redis set answers `SISMEMBER 0` — "nobody is on the DNC list" — which is the most
 * dangerous reading available and the one a naive check gets for free.
 *
 * Seeded through the SAME call master uses in production, not by writing the key:
 * an empty `replace` is a legitimate full sync, so each scenario PROVES its tenant
 * is authoritative rather than assuming it. Asserted immediately, so a wrong seed
 * fails here naming the cause instead of surfacing as zero dials thirty assertions
 * later.
 *
 * `check()` is asserted as well as `applied`, and that second half is the load-
 * bearing one: `applied: true` says the promote script ran, while `check()` is the
 * exact call the gate makes, so only the second can distinguish "we wrote a version"
 * from "the gate will now clear". A future keyspace-prefix change would break the
 * gate and leave `applied` perfectly true.
 */
async function makeTenantDncAuthoritative(
  dnc: import('../../../../src/agency/dnc-registry.js').DncRegistry,
  tenantId: string,
  version = 1,
  context = 'Chaos harness',
  // PORT NOTE (B8): the scope the pre-dial gate passes; required by the registry.
  scope: { accountId: string | null; campaignId: string | null } = { accountId: null, campaignId: null },
): Promise<void> {
  // PORT NOTE (magick-agency, decision B8): core published an empty `replace` here
  // (`dnc.applyReplace({ tenantId, version, members: [] })`) and asserted it applied
  // at `version`. There is no set and no version: the gate reads `dnc_entries`, so a
  // tenant with no row is authoritative by construction and there is nothing to
  // publish. `version` is kept in the signature so the scenarios' calls read as core's.
  void version;
  // The gate's own call, on a number that is definitively not a member. `clear`
  // is the only answer that means "this tenant may dial"; `unavailable` is what
  // an unsynced tenant returns and is the failure this whole function exists to
  // make loud.
  const verdict = await dnc.check(tenantId, '+919000000099', scope);
  if (verdict !== 'clear') {
    throw new Error(
      `${context} seeded DNC version ${version} for tenant ${tenantId}, but the gate's own `
      + `check still answers '${verdict}' rather than 'clear' — the version was written `
      + 'somewhere the gate does not read. Every scenario would dial nothing.',
    );
  }
}

/**
 * Stand up a world.
 *
 * The caller must have mocked `src/db/connection.js` and `src/config/index.js`
 * before importing this module — see any scenario file for the two `vi.mock`
 * calls and why they are required.
 */
/**
 * Whether this campaign still owes a dial, or is still settling one.
 *
 * `pending` is a contact the pacer has not reached; `in_flight` is one whose call
 * is still being torn down. Either means a later tick can still do work, so
 * neither may be read as quiescence.
 *
 * Gated on the campaign still being `running`, and that guard is not decoration:
 * the abandonment guardrail auto-pauses campaigns in several scenarios in this
 * suite (three separate campaigns in one observed CI run), and a paused campaign
 * owes nothing however many contacts remain `pending`. Without the guard those
 * scenarios would burn the whole settle budget waiting for a dial that is never
 * coming.
 */
export async function hasOutstandingDialWorkFor(campaignId: string): Promise<boolean> {
  const { rows } = await getTestPool().query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM agency_contacts c
       JOIN agency_campaigns cam ON cam.id = c.campaign_id
      WHERE c.campaign_id = $1
        AND cam.status = 'running'
        AND c.state IN ('pending', 'in_flight')`,
    [campaignId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function createChaosWorld(opts: ChaosWorldOptions = {}): Promise<ChaosWorld> {
  const agentCount = opts.agents ?? 5;
  const contactCount = opts.contacts ?? 20;
  const maxConcurrent = opts.maxConcurrentCalls ?? agentCount;

  // Dynamic, NOT top-level: every agency module is imported after the caller's
  // `vi.mock` calls have run, and hoisting one to the top of the file would load
  // it — and its transitive `logger` / `db/connection` imports — before those
  // mocks exist.
  const { AgencyRuntime } = await import('../../../../src/agency/runtime.js');
  const { PacingEngine } = await import('../../../../src/agency/pacing-engine.js');
  const { LocalDialDispatcher } = await import('../../../../src/agency/dial-dispatcher.js');

  const redis = new Redis(TEST_REDIS_URL, { keyPrefix: KEY_PREFIX, db: CHAOS_DB, maxRetriesPerRequest: 3 });
  await redis.flushdb();

  const campaignRow = await insertAgencyCampaign({
    status: 'running',
    // Zero wrap-up keeps the pool circulating without a business timer in the
    // loop. Wrap-up has its own coverage; a chaos scenario that also waits out a
    // countdown is testing two things and diagnosing neither.
    wrapup_seconds: 0,
    ...opts.campaign,
  });
  const campaignId = campaignRow.id as string;
  const tenantId = campaignRow.tenant_id as string;
  const accountId = campaignRow.account_id as string;

  await getTestPool().query(
    `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, account_id) DO UPDATE SET max_concurrent_calls = EXCLUDED.max_concurrent_calls`,
    [tenantId, accountId, maxConcurrent],
  );

  const contactRows = await insertAgencyContacts(campaignId, contactCount);
  const contactIds = contactRows.map((c) => c.id as string);

  const agents: ChaosAgent[] = [];
  for (let i = 0; i < agentCount; i++) {
    // PORT NOTE: a UUID column now; the same deterministic label core used.
    const agentUserId = uuidFor(`chaos-agent-${i}`);
    const session = await insertAgentSession(campaignId, { agent_user_id: agentUserId, state: 'available' });
    agents.push({ sessionId: session.id as string, agentUserId, socket: new FakeStationSocket() });
  }

  const bridge = new ScriptedBridge();

  /**
   * ── The runtime is REAL, and that is the point of this block ──────────────
   *
   * This used to hand-assemble `StationRegistry` / `AgentStateMachine` /
   * `WrapupManager` / `BreakRegistry` / `AgencyDialer` / `PacingEngine` with a
   * comment saying it was "constructed exactly as `AgencyRuntime` does it". It
   * was not, twice: `BreakRegistry` was omitted for a while (every agent release
   * threw a `TypeError` into a fire-and-forget subscription and the pool silently
   * stopped circulating), and the copy could never exercise `rehydrateAgent` or
   * `releaseStationOnClose` because those live on the runtime, not on its parts.
   *
   * Using the real `AgencyRuntime` removes the whole class of drift: a
   * constructor argument added in `runtime.ts` cannot be missing here, because
   * this is not a second construction site. It also gives the restart scenario a
   * genuine replica boundary for free — see `restartReplica`.
   *
   * `reaper.start()` and `pacing.start()` are deliberately NOT called (that is
   * what `runtime.start()` would do): every scenario drives `tickOnce` by hand,
   * and a live 250ms supervisor racing a scripted tick is exactly the
   * non-determinism this harness exists to avoid.
   */
  function newRuntime() {
    const built = new AgencyRuntime(bridge as never, redis, '');
    built.dialer.start();
    return built;
  }

  /**
   * The CURRENT replica. Mutable, because `restartReplica()` replaces it — and
   * every field the world exposes is a getter onto this rather than a captured
   * reference, so a scenario holding `world.dialer` across a restart talks to the
   * new replica exactly as a route handler would.
   */
  let rt = newRuntime();

  // ── The tenant's DNC set must be AUTHORITATIVE before anything dials
  //    (`AD-P3-C-06`).
  //
  // The `flushdb()` above drops the version key, so without this every scenario in
  // the chaos suite would dial nothing, and "nothing dialed" is exactly the shape of
  // a pacing bug. It survives `restartReplica()` because the version lives in Redis,
  // not in the replica — but it does NOT survive
  // `chaos.expireRedisWholesale()`, which is why that recovery has its own verb.
  //
  // See `makeTenantDncAuthoritative` for what is asserted and why the `check()` half
  // is the load-bearing one.
  await makeTenantDncAuthoritative(rt.dnc, tenantId, 1, 'Chaos harness', { accountId, campaignId });

  const world: ChaosWorld = {
    redis, campaignId, tenantId, accountId, agents, contactIds, bridge,
    // Getters, not captured values — see `rt` above. `world.replicaId` in
    // particular MUST be live: the restart scenario asserts the old and new ids
    // differ, and a captured copy would make that assertion pass vacuously.
    get replicaId() { return rt.replicaId; },
    get runtime() { return rt; },
    get pacing() { return rt.pacing; },
    get dialer() { return rt.dialer; },
    get stations() { return rt.stations; },
    get agentState() { return rt.agents; },
    get breaks() { return rt.breaks; },
    get reaper() { return rt.reaper; },

    async bringOnline(agent) {
      await rt.stations.attach({
        sessionId: agent.sessionId,
        campaignId,
        tenantId,
        accountId,
        agentUserId: agent.agentUserId,
        ws: agent.socket as never,
      });
      await rt.agents.set(agent.sessionId, 'available');
      await getTestPool().query(
        `UPDATE agency_agent_sessions SET state = 'available' WHERE id = $1`,
        [agent.sessionId],
      );
    },

    async tick() {
      // `tickOnce` is the whole controller pass. Driving it directly rather than
      // through `start()` is what makes a scenario reproducible.
      await rt.pacing.tickOnce(campaignId);
      await bridge.flush();
    },

    forkLeader() {
      // Shares the CURRENT replica's id, stations and agents deliberately — see
      // the interface docs. Its own dispatcher, because `LocalDialDispatcher`
      // closes over the dialer and a fork must dial through the same one.
      const dispatcher = new LocalDialDispatcher(rt.replicaId, (cmd) => rt.dialer.executeDial(cmd));
      // The CURRENT replica's registry, not a fresh one: a split-brain scenario is
      // about two leaders racing over one campaign's contacts, so both must see the
      // same DNC set. A second registry would work identically today (both read the
      // same Redis) and would stop being equivalent the moment the registry caches.
      return new PacingEngine(redis, '', rt.replicaId, rt.stations, rt.agents, dispatcher, rt.dnc);
    },

    /**
     * Replace the replica: the old runtime's timers and lifecycle subscription
     * die, a NEW one is constructed with a NEW `replicaId`, and the reaper is run
     * in the order `runtime.start()` runs it.
     *
     * Three things make this a real restart rather than a constructor call.
     *
     * 1. **The old runtime is stopped first**, so its lease renewers and its
     *    bridge subscription are gone. Without that the "dead" replica keeps
     *    renewing leases and the scenario proves nothing.
     * 2. **The station map is empty on the new replica.** Sockets live in the old
     *    `StationRegistry`, so after a restart every agent is unowned locally —
     *    which is the true post-crash state and what makes `isLocallyOwned`
     *    disagree with the still-live ownership KEY in Redis (30s TTL, written by
     *    the dead replica's id). That disagreement is the one path
     *    `LocalDialDispatcher` refuses, and it is only reachable here.
     * 3. **`reapOnStartup` is optional**, because the ORDER is the thing under
     *    test. `runtime.ts` runs the reaper before the pacing supervisor, and a
     *    scenario that can only ever run the correct order cannot show the order
     *    matters — so `{ reap: false }` reproduces the inverted boot.
     */
    async restartReplica(o: { reap?: boolean } = {}) {
      const previous = rt.replicaId;
      rt.dialer.stop();
      rt.wrapup.stop();
      rt.reaper.stop();
      await rt.pacing.stop().catch(() => { /* never started */ });

      rt = newRuntime();
      // A shared `REPLICA_ID` env var would make both runtimes claim the same
      // ownership keys and silently defeat property 2 above. Fail loudly instead.
      if (rt.replicaId === previous) {
        throw new Error(
          'restartReplica produced the same replicaId — REPLICA_ID is pinned in the environment, '
          + 'which makes the ownership-disagreement assertions vacuous',
        );
      }
      if (o.reap !== false) await rt.reaper.reapOnStartup();
      return { previousReplicaId: previous, replicaId: rt.replicaId };
    },

    async runUntilQuiescent(maxTicks = 400) {
      let used = 0;
      let idleStreak = 0;
      let settled = 0;
      for (; used < maxTicks; used++) {
        const before = bridge.dialed.length;
        await world.tick();

        if (bridge.dialed.length !== before) {
          // Real work happened; neither counter means anything until it stops.
          idleStreak = 0;
          settled = 0;
          continue;
        }

        // ── Why a tick that dialled nothing is not yet evidence of quiescence ──
        //
        // `bridge.flush()` absorbs on the ATTEMPT row reaching a terminal state,
        // but the CONTACT's transition out of `in_flight` lands later, through the
        // same fire-and-forget lifecycle subscription this file already documents
        // under `expireRedisWholesale` ("`flush()`'s Postgres absorption says
        // nothing about whether they have landed"). Until that write lands the
        // contact is still holding the campaign's concurrency slot, so the pacer
        // correctly dials nothing — which, counted on dials alone, is
        // indistinguishable from "the campaign has finished".
        //
        // Observed on CI and reproduced locally under CPU contention: exit after
        // two such ticks with one contact `in_flight` and one still `pending`, so
        // the second contact was never dialled and the scenario asserted against
        // one attempt row instead of two.
        //
        // The wait is BOUNDED, and that is the load-bearing half. Several
        // scenarios deliberately park a call live and never settle it, and a
        // scenario whose remaining contact can never be dialled (its slot held by
        // that parked call) would otherwise spin to `maxTicks` — trading a wrong
        // answer for a slow one. After `QUIESCENCE_SETTLE_TICKS` the old
        // dial-counting behaviour takes over unchanged, so this can delay a
        // scenario but never hang one.
        if (settled < QUIESCENCE_SETTLE_TICKS && (await hasOutstandingDialWorkFor(campaignId))) {
          settled++;
          idleStreak = 0;
          continue;
        }

        // Two consecutive tickss that dial nothing means the controller has
        // nothing left to do — including the finalization tick, which by design
        // only runs when the tick did no dialing work.
        idleStreak++;
        if (idleStreak >= 2) break;
      }
      return used + 1;
    },

    chaos: {
      async expireRedisWholesale() {
        // ── Quiesce the agent keyspace BEFORE flushing, and why ──────────────
        //
        // The flush models a Redis that came back empty, and a scenario asserting
        // that needs the keyspace to actually BE empty when it looks. The agency
        // writes that land in Redis on the way out of a call — `agents.set(…)` for
        // wrap-up and the return to `available` — are reached through the same
        // fire-and-forget lifecycle subscription as everything else here, so
        // `flush()`'s Postgres absorption says nothing about whether they have
        // landed. One still in flight during `flushdb()` re-creates exactly one
        // `agency:agent:*:state` key a microsecond after the database was emptied,
        // and the scenario reports a survivor that no mechanism resurrected.
        //
        // It is a harness race and NOT a product fault, which was checked rather
        // than assumed: `RENEW_SCRIPT` opens with `if EXISTS == 0 then return 0`,
        // so a renewer cannot bring a flushed lease back. Only a genuine state
        // transition writes, and the transition really did happen — just later
        // than the test read.
        //
        // Two consecutive identical reads bound the window: an in-flight ioredis
        // command completes in about a millisecond, so a 25ms quiet period means
        // nothing was outstanding. Deliberately a barrier on the PRECONDITION and
        // not a relaxation of the assertion — `toEqual([])` after the flush stays
        // exactly as strict, which is the whole point of the scenario.
        //
        // **Pre-existing, and measured rather than assumed.** The first suspicion
        // was that MAG-88 caused it — the old `bridged` barrier waited on a contact
        // write for every bridged call, and losing that incidental pause is exactly
        // the kind of thing that exposes a latent race. That was falsified by
        // running the suite on `main` at `6e75e92`, which carries none of MAG-88:
        // the same single surviving `agency:agent:*:state` key, on the same
        // assertion. It reproduces on both trees and is a genuine harness race,
        // fixed here rather than left to red the suite one run in three.
        let previous: string | null = null;
        const deadline = Date.now() + ABSORB_TIMEOUT_MS;
        for (;;) {
          const observed = (await agencyKeys(redis)).join('\n');
          if (observed === previous || Date.now() > deadline) break;
          previous = observed;
          await new Promise((r) => setTimeout(r, 25));
        }

        // Not a targeted DEL of the keys we happen to know about — a scenario that
        // deletes only `agency:*` would leave the concurrency and ownership
        // keyspaces intact and quietly prove less than it claims.
        await redis.flushdb();
      },
      killRenewers() {
        // `stop()` clears every lease renewer AND drops the lifecycle
        // subscription, which is exactly what the owning replica dying looks
        // like from Redis's and Postgres's point of view.
        rt.dialer.stop();
      },
      async dropStation(sessionId: string) {
        // Models the station WebSocket closing, THROUGH the runtime path the
        // route uses — `releaseStationOnClose` returns false when a live attempt
        // exists, deferring to the deferred hangup rather than writing `offline`.
        // Calling `stations.detach` alone would skip that decision entirely and
        // the scenario would be testing the harness.
        const agent = agents.find((a) => a.sessionId === sessionId);
        agent?.socket.close();

        // ── One socket close, BOTH reactions ─────────────────────────────────
        //
        // In production this socket carries two independent sets of `close`
        // handlers: the station route's (which calls `releaseStationOnClose`) and
        // the bridge's own (`registerBrowserLegHandlers`, which arms the deferred
        // hangup). `ScriptedBridge` cannot register on a socket it never sees, so
        // the bridge half is driven here rather than left to the scenario.
        //
        // That is not tidiness. A scenario that had to remember a second call
        // could drop a station and forget the window, and every assertion about
        // "the attempt survived the drop" would then be describing a call nobody
        // had disconnected — passing while proving nothing. One verb, one real
        // event.
        //
        // The live attempt is resolved from Postgres rather than from the dialer's
        // in-memory map, because `attemptIdFor` is private and a public accessor
        // added for a test would be a second source of truth about which attempt
        // an agent owns.
        const { rows } = await getTestPool().query<{ id: string }>(
          `SELECT id FROM agency_call_attempts
            WHERE reserved_agent_id = $1 AND state <> 'ended'
            ORDER BY created_at DESC LIMIT 1`,
          [sessionId],
        );
        const attemptId = rows[0]?.id ?? null;
        const graceArmed = attemptId === null ? false : await bridge.dropBrowserLeg(attemptId);

        await rt.stations.detach(sessionId, agent?.socket as never);
        const wroteOffline = await rt.releaseStationOnClose(sessionId);
        return { wroteOffline, graceArmed, attemptId };
      },
      /** Reconnect a station socket onto whatever attempt it left behind. */
      async reattachStation(sessionId: string) {
        const agent = agents.find((a) => a.sessionId === sessionId)!;
        agent.socket = new FakeStationSocket();
        await rt.stations.attach({
          sessionId, campaignId, tenantId, accountId,
          agentUserId: agent.agentUserId, ws: agent.socket as never,
        });
        return rt.dialer.reattachStation(sessionId, agent.socket as never);
      },
      /** Master re-publishes the DNC list after a wholesale Redis loss. */
      async resyncDnc(version = 1) {
        await makeTenantDncAuthoritative(rt.dnc, tenantId, version, 'chaos.resyncDnc', { accountId, campaignId });
      },
    },

    async teardown() {
      rt.dialer.stop();
      rt.wrapup.stop();
      rt.reaper.stop();
      await rt.pacing.stop().catch(() => { /* nothing was started */ });
      await redis.flushdb().catch(() => { /* connection already gone */ });
      redis.disconnect();
    },
  };

  return world;
}

// ── State readers. Every assertion in every scenario goes through these. ────

export interface AttemptRow {
  id: string;
  contact_id: string;
  state: string;
  outcome: string | null;
  answered_at: Date | null;
  bridged_at: Date | null;
  ended_at: Date | null;
  reserved_agent_id: string | null;
  attempt_number: number;
}

export async function attempts(campaignId: string): Promise<AttemptRow[]> {
  const { rows } = await getTestPool().query<AttemptRow>(
    `SELECT id, contact_id, state, outcome, answered_at, bridged_at, ended_at,
            reserved_agent_id, attempt_number
       FROM agency_call_attempts WHERE campaign_id = $1
      ORDER BY created_at, id`,
    [campaignId],
  );
  return rows;
}

export interface ContactRow {
  state: string;
  attempt_count: number;
  our_fault_attempts: number;
  last_outcome: string | null;
  next_attempt_at: Date | null;
}

/**
 * The contact row **once the post-`ended` write has actually landed**.
 *
 * ── The other half of `emit`'s known residual ───────────────────────────────
 *
 * `emit` returns the instant the ATTEMPT row reads `ended`, and its own comment
 * names the gap that leaves: the `ended` handler writes the attempt row first
 * and the contact second (`agency-dialer.ts` — `setState(attemptId, 'ended', …)`
 * and then one of three contact writes, with no barrier between them). So a
 * scenario that reads contact state straight after `expireGrace()`/`flush()`
 * reads it *mid-pair*.
 *
 * That is not hypothetical: §15.9 below went red on a real run with
 * `expected 'in_flight' to be 'pending'` — the requeue was correct and the read
 * was simply early. The neighbouring case has the identical shape and survives
 * only because two unrelated queries happen to sit between its flush and its
 * read, which is luck rather than a barrier, and luck that a faster box takes
 * away.
 *
 * ── Why this barrier and not the obvious one ────────────────────────────────
 *
 * `contacts.updated_at >= attempts.updated_at` is ruled out for the reason
 * `emit` gives (`WrapupManager.enter()` writes the attempt row again afterwards),
 * and `updated_at` alone is no better — `chargeOurFaultAttempt`/`chargeAttempt`
 * bump it one statement BEFORE `markState`, so waiting on it returns mid-pair
 * again, one row further along.
 *
 * What is determinate is that the contact **leaves `in_flight`**. All three
 * branches write a state, none of them is `in_flight`, and both charge helpers
 * deliberately do not touch `state` — so the state changing is exactly the last
 * write of the chain completing, with nothing behind it.
 *
 * **Only sound for a contact that was `in_flight` when the call ended.** Before
 * MAG-88 that meant "one whose call never bridged", because a bridged call's
 * contact already read `connected` before the end and this would return
 * immediately having waited for nothing. That is now narrower: a bridged call on
 * a campaign owing no write-up leaves its contact `in_flight` too, so this is
 * sound there as well. It is still unsound for a bridged call on a campaign WITH
 * a catalog, and those scenarios use `runUntilQuiescent()`.
 *
 * On timeout it **returns what it last read instead of throwing**, so a genuine
 * requeue failure still reddens on the caller's own assertion — carrying the
 * real state and the caller's message — rather than being reported as a harness
 * fault at a line that says nothing about the product.
 */
export async function releasedContact(contactId: string): Promise<ContactRow> {
  const deadline = Date.now() + ABSORB_TIMEOUT_MS;
  for (;;) {
    const { rows } = await getTestPool().query<ContactRow>(
      `SELECT state, attempt_count, our_fault_attempts, last_outcome, next_attempt_at
         FROM agency_contacts WHERE id = $1`,
      [contactId],
    );
    const row = rows[0]!;
    if (row.state !== 'in_flight' || Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 2));
  }
}

export async function contactStates(campaignId: string): Promise<Record<string, number>> {
  const { rows } = await getTestPool().query<{ state: string; n: string }>(
    `SELECT state, COUNT(*)::text AS n FROM agency_contacts WHERE campaign_id = $1 GROUP BY state`,
    [campaignId],
  );
  return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
}

export async function campaignStatus(campaignId: string): Promise<string> {
  const { rows } = await getTestPool().query<{ status: string }>(
    `SELECT status FROM agency_campaigns WHERE id = $1`, [campaignId],
  );
  return rows[0]!.status;
}

export async function agentSessionStates(campaignId: string): Promise<Record<string, string>> {
  const { rows } = await getTestPool().query<{ id: string; state: string }>(
    `SELECT id, state FROM agency_agent_sessions WHERE campaign_id = $1`, [campaignId],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.state]));
}

/**
 * One agent's mirrored state **once the post-`ended` write has actually landed**.
 *
 * ── The third instance of `emit`'s residual, one table further along ────────
 *
 * {@link agentSessionStates} is an unbarriered snapshot. `onBridgeLifecycle` is
 * dispatched fire-and-forget (`agency-dialer.ts` — `void this.onBridgeLifecycle(ev)`),
 * so `emit` returns once the ATTEMPT row reads `ended` while the rest of the chain
 * is still running, and `releaseAgent` writes Redis (`agents.set`) BEFORE the
 * mirror (`setState`). A scenario that reads the live state and then the mirror
 * therefore reads that pair mid-write — observed on CI as `live.state` already
 * `offline` with the row still `available`, which is the one value the assertion
 * forbids. {@link releasedContact} does not cover it: the contact write happens
 * earlier in the same chain.
 *
 * Waiting on "the row leaves `available`" is determinate because `reserved` is
 * deliberately not mirrored (`pacing-engine.ts`), so the row reads `available` for
 * the whole call and the state changing IS that last write landing. **Only sound
 * for an agent mirrored `available` whose call has ended** — a scenario asserting
 * an agent went back TO `available` must use {@link agentSessionStates}.
 *
 * On timeout it returns what it last read instead of throwing, so a mirror that
 * genuinely never moved — or one a stray write put back — still reddens on the
 * caller's own assertion rather than as a harness fault.
 */
export async function mirroredAgentState(sessionId: string): Promise<string> {
  const deadline = Date.now() + ABSORB_TIMEOUT_MS;
  for (;;) {
    const { rows } = await getTestPool().query<{ state: string }>(
      `SELECT state FROM agency_agent_sessions WHERE id = $1`, [sessionId],
    );
    const state = rows[0]?.state ?? 'offline';
    if (state !== 'available' || Date.now() > deadline) return state;
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * Contacts carrying more than one live attempt. **Must always be empty.**
 *
 * This is exit criterion 1 stated as a query, and it is deliberately a
 * *snapshot* rather than a running tally: it can be asserted at any point in a
 * scenario, including mid-chaos, and it is the one invariant no failure mode is
 * permitted to break even transiently.
 */
export async function contactsWithConcurrentLiveAttempts(campaignId: string): Promise<Array<{ contact_id: string; n: number }>> {
  const { rows } = await getTestPool().query<{ contact_id: string; n: string }>(
    `SELECT contact_id, COUNT(*)::text AS n FROM agency_call_attempts
      WHERE campaign_id = $1 AND state <> 'ended'
      GROUP BY contact_id HAVING COUNT(*) > 1`,
    [campaignId],
  );
  return rows.map((r) => ({ contact_id: r.contact_id, n: Number(r.n) }));
}

/**
 * Agents holding more than one live attempt. **Must always be empty.**
 *
 * The companion to {@link contactsWithConcurrentLiveAttempts} and NOT a
 * restatement of it: that query groups by contact and therefore cannot see one
 * agent bridged to two *different* customers, which is exactly the shape of the
 * `AD-P2-C-07` reconnect defect (`cf55996`) — a live `on_call` lease overwritten
 * with `available`, and the agent reserved for a second call while still on the
 * first. Exit criterion 1's "no unreserved answer" clause reads per contact; this
 * is the same conservation law read per agent, and the two are independent.
 */
export async function agentsWithConcurrentLiveAttempts(campaignId: string): Promise<Array<{ agent_session_id: string; n: number }>> {
  const { rows } = await getTestPool().query<{ reserved_agent_id: string; n: string }>(
    `SELECT reserved_agent_id, COUNT(*)::text AS n FROM agency_call_attempts
      WHERE campaign_id = $1 AND state <> 'ended' AND reserved_agent_id IS NOT NULL
      GROUP BY reserved_agent_id HAVING COUNT(*) > 1`,
    [campaignId],
  );
  return rows.map((r) => ({ agent_session_id: r.reserved_agent_id, n: Number(r.n) }));
}

/**
 * §10's abandonment predicate, run as written against the campaign.
 *
 * Kept as an independently written query rather than importing core's constant,
 * because §10.1's whole point is that this is an **audit** of the product's number
 * — importing the product's SQL would make the cross-check compare a value with
 * itself. {@link abandonedCountByProductPredicate} is the other half, and
 * {@link assertAbandonmentPredicatesAgree} is what makes "independent" mean
 * "checked" rather than "hoped".
 *
 * ── `state = 'ended'` (ratified in the design doc at `8da1bea`) ─────────────
 *
 * §10 as originally written had **no terminal filter**, and that was a real defect
 * rather than an omission: `bridged_at IS NULL` is true of an attempt that is
 * answered and *still being bridged*, and of one mid-apology on the abandoned
 * path. Live traffic therefore inflated the compliance rate in real time, and
 * `AD-P4-C-02`'s auto-pause would have fired on a **healthy** campaign at
 * concurrency — pausing calls that were seconds from connecting, in the name of a
 * compliance guardrail. Abandonment is a property of a call that is over.
 *
 * Note the shape of how it hid, because it is the §16.6 pattern in a new place: it
 * only misbehaves under the concurrency Phase 2 introduces, and it fails in the
 * direction that **looks like caution**.
 *
 * `N` is 1000ms, matching `ABANDONMENT_BRIDGE_GRACE_MS`. Written as
 * `1000 milliseconds` rather than `1 second` so the two halves are comparable by
 * eye as well as by result.
 */
export async function abandonedCount(campaignId: string): Promise<number> {
  const { rows } = await getTestPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM agency_call_attempts
      WHERE campaign_id = $1
        AND state = 'ended'
        AND answered_at IS NOT NULL
        AND (outcome = 'abandoned' OR bridged_at IS NULL
             OR bridged_at - answered_at > interval '1000 milliseconds')`,
    [campaignId],
  );
  return Number(rows[0]!.n);
}

/**
 * The same count, using **core's own exported predicate** verbatim.
 *
 * Imported dynamically so this module stays loadable before a caller's `vi.mock`
 * calls have run, exactly like the runtime imports in `createChaosWorld`.
 */
export async function abandonedCountByProductPredicate(campaignId: string): Promise<number> {
  const { ABANDONED_ATTEMPT_PREDICATE_SQL } = await import('@magick-agency/domain/abandonment-predicate');
  const { rows } = await getTestPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM agency_call_attempts
      WHERE campaign_id = $1 AND (${ABANDONED_ATTEMPT_PREDICATE_SQL})`,
    [campaignId],
  );
  return Number(rows[0]!.n);
}

/**
 * §10's cross-check, as an assertion: **QA's audit query and the product's
 * predicate must return the same number on the same data.**
 *
 * This is the one thing that makes `AD-P2-C-06`'s acceptance meaningful. The
 * metric is only an independent audit if the two definitions agree, and they are
 * deliberately two separate pieces of SQL — so nothing but a comparison can tell
 * you they still do. A drift here fails the cross-check for a reason that is *not
 * a bug*, which is the most expensive kind of red: it burns a run and teaches
 * people to distrust the check.
 *
 * Returns the agreed count so a caller can assert its value too — agreeing on
 * zero for the wrong reason is still vacuous, which is why every scenario that
 * calls this also asserts what the number should be.
 */
export async function assertAbandonmentPredicatesAgree(campaignId: string): Promise<number> {
  const mine = await abandonedCount(campaignId);
  const theirs = await abandonedCountByProductPredicate(campaignId);
  if (mine !== theirs) {
    throw new Error(
      `Abandonment predicates disagree on campaign ${campaignId}: test-plan §10 says ${mine}, `
      + `core's ABANDONED_ATTEMPT_PREDICATE_SQL says ${theirs}. These are the two halves of `
      + `AD-P2-C-06's cross-check; one of them has drifted and §10 is what changes first.`,
    );
  }
  return mine;
}

/**
 * The live value of one metric series, or **undefined when the series is
 * absent** — which is a different answer from 0 and must stay distinguishable.
 *
 * §12.3.1: nothing anywhere read a real metric value back — unit suites stub the
 * instruments, so they can pin names and label sets and can never see a number.
 * This is the capability §12.3.1 asks for, and it is what makes §10's "the metric
 * agrees with the table" cross-check possible at all — the `AD-P4-C-02` auto-pause
 * reads the metric, not the table.
 *
 * Read from the REAL meter provider through the reader the calling suite installed
 * (`installMetricReader()` in a `vi.hoisted` block, so it is in place before any
 * product module creates its instruments); `installedMetricReader()` throws when
 * none was, because a suite bound to the no-op meter would read every series as
 * absent and pass the absent-series assertions vacuously.
 */
export async function metricValue(
  name: string,
  labels: Record<string, string>,
): Promise<number | undefined> {
  const { collectMetric, installedMetricReader } = await import('../../../helpers/otel-metric-reader.js');
  const points = await collectMetric(installedMetricReader(), name);
  const match = points.find((p) => Object.entries(labels).every(([k, val]) => p.attributes[k] === val));
  return match?.value;
}

/** Every agency key currently in the chaos database, unprefixed. */
export async function agencyKeys(redis: Redis): Promise<string[]> {
  // `keys` is applied to the prefixed keyspace by ioredis for KEYS patterns
  // only when the pattern goes through a key argument — it does not, so the
  // prefix is written by hand and stripped off the results.
  const raw = await redis.keys(`${KEY_PREFIX}agency:*`);
  return raw.map((k) => k.slice(KEY_PREFIX.length)).sort();
}

/**
 * `PTTL` for every agency key, as a map. The chaos suite's standing TTL audit
 * (T-L4c, runtime half) reads this: no observed TTL may originate anywhere but
 * `AGENT_LEASE_MS`.
 */
export async function agencyKeyTtls(redis: Redis): Promise<Record<string, number>> {
  const keys = await agencyKeys(redis);
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = await redis.pttl(key);
  return out;
}
