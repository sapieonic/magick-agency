import { AGENCY_LISTEN_RECONNECT_WINDOW_MS, type AgencyCallOrigin, type AgencyListenEndReason, type AgencyListenErrorCode } from '../../types/live-calls';
import { ClockOffsetEstimator, type ClockSample } from '../agencyClock';
import { listenCloseOutcome, terminalEndReason, type ListenCloseOutcome } from './listenFrames';

/**
 * Every state of one supervisor's listen, as one pure reducer (`docs/listening.md` §3, §4, §9).
 * `useListenSession` dispatches what happened (a grant answered, a frame arrived, the socket
 * closed, a timer fired) and does what the new state asks (mint, open, wait, close); nothing
 * about the session lives anywhere else, so every transition is a unit test.
 *
 * Phases:
 *  - `idle`: nothing open (and, with `refusal`, a start that was refused before any audio);
 *  - `connecting`: the first attach of this listen: minting a grant (`step: 'grant'`), opening the
 *    socket and waiting for `ready` (`'socket'`), or waiting to try again after a drop before
 *    any audio (`'wait'`);
 *  - `live`: `ready` arrived; audio plays;
 *  - `reconnecting`: the socket dropped after `ready` and the console is re-minting and
 *    reconnecting, within {@link AGENCY_LISTEN_RECONNECT_WINDOW_MS} of the first drop;
 *  - `lost`: the window passed (or the server failed too often, or the first attach took over
 *    15 s): "Connection lost", Try again;
 *  - `ended`: the session is over for a reason to tell the supervisor (`end.kind`); only an
 *    `unverified` end offers Try again.
 *
 * Every attach (a grant, a socket, a `ready`) carries the `attempt` it belongs to; an event from
 * an older attempt is dropped, so a late grant or a dead socket's close can never move a newer one.
 */

/** What the bar shows about the call being listened to, fixed when the listen starts. */
export interface ListenTarget {
  callId: string;
  origin: AgencyCallOrigin;
  /** The call's spine row (the live row's `correlation_id`): "Open call" opens its page. */
  correlationId: string;
  campaignId: string | null;
  /** The Campaign column's words (`campaignCellLabel`). */
  campaignLabel: string;
  /** The agent's display name. */
  agentName: string;
  /** The masked number, or "Withheld" for a caller who withheld theirs (`maskedNumberLabel`). */
  customerMasked: string;
  /** ISO-8601, server clock: the call's time-on-call anchor. */
  connectedAt: string;
  /** The live list's server clock correction when the listen started (ms, subtracted from server instants). */
  clockOffsetMs: number;
}

export type ListenPhase = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'lost' | 'ended';
export type ListenStep = 'grant' | 'socket' | 'wait';
/**
 * `revoked`: the supervisor may no longer listen; `turned_off`: listening was turned off for the
 * account (the flag); either from the server, or seen here first (`withdrawn`). `unverified`: the
 * server could not check the supervisor's access for too long (LS21, close 4503): the one ended
 * listen Try again starts afresh, since nothing said they may not listen.
 */
export type ListenEndKind = 'call_ended' | 'revoked' | 'turned_off' | 'superseded' | 'unverified' | 'refused';

/** A grant that did not answer 201: its status (null: no answer at all) and code. */
export interface ListenGrantRefusal {
  status: number | null;
  code: string | null;
}

export interface ListenSessionState {
  phase: ListenPhase;
  target: ListenTarget | null;
  /** Bumped by every attach; events carry the attempt they belong to. */
  attempt: number;
  /** Within `connecting` and `reconnecting`: what the attach is doing. Null otherwise. */
  step: ListenStep | null;
  /** The session the current attach was granted (`ready` repeats it). */
  listenId: string | null;
  /**
   * Client ms of this listen's first `ready`: "you listened for". Try again moves it on by the time
   * the listen stood stopped ({@link stoppedAt}), so nothing unheard is counted.
   */
  startedAt: number | null;
  /** Client ms the listen stopped at, in `lost` and `ended`: Try again leaves the gap out. */
  stoppedAt: number | null;
  /** While recovering from a drop: when the window closes. */
  retry: { deadline: number } | null;
  /**
   * The first attach's own deadline (client ms), from the Listen click until its first `ready`:
   * a grant or a socket that never answers ends in `lost`, not "Connecting…" for ever.
   */
  connectDeadline: number | null;
  /**
   * Server failures (close 1011) since the listen last stayed live for {@link LISTEN_STABLE_MS}.
   * A `ready` does not clear it: a tap that fails just after every `ready` must still stop.
   */
  internalErrors: number;
  /** Client ms of the latest `ready`. */
  liveSince: number | null;
  /** Why the session ended, in `ended`. */
  end: { kind: ListenEndKind; listenedMs: number; code: AgencyListenErrorCode | null } | null;
  /** A start refused before any audio, for the toast; `refusalSeq` moves once per refusal. */
  refusal: ListenGrantRefusal | null;
  refusalSeq: number;
  /** The browser will not run the audio (autoplay policy): "Your browser blocked the sound." */
  soundBlocked: boolean;
  /** The agent's leg has been silent for over two seconds while live: "Agent is silent". */
  agentSilent: boolean;
  /** Pong samples: the bar's timer on the server clock. */
  clock: ClockOffsetEstimator;
}

export type ListenSessionEvent =
  | { type: 'start'; target: ListenTarget; now: number }
  | { type: 'granted'; attempt: number; listenId: string }
  | { type: 'grant_refused'; attempt: number; refusal: ListenGrantRefusal; now: number }
  | { type: 'ready'; attempt: number; listenId: string; now: number }
  | { type: 'server_ended'; attempt: number; reason: AgencyListenEndReason; now: number }
  | { type: 'closed'; attempt: number; code: number; reason: string; now: number }
  | { type: 'reattach'; now: number }
  | { type: 'tick'; now: number }
  | { type: 'pong'; attempt: number; sample: ClockSample }
  | { type: 'stop' }
  /** This console saw the permission (`revoked`) or the flag (`turned_off`) go: ended, saying why. */
  | { type: 'withdrawn'; kind: 'revoked' | 'turned_off'; now: number }
  | { type: 'retry'; now: number }
  | { type: 'dismiss' }
  | { type: 'sound'; blocked: boolean }
  | { type: 'agent_silent'; silent: boolean };

/** Server failures (close 1011) in a row before the console stops retrying. */
export const LISTEN_MAX_INTERNAL_ERRORS = 3;

/** Live this long since its last `ready`, a listen has recovered: its server-failure count starts again. */
export const LISTEN_STABLE_MS = 10_000;

export const INITIAL_LISTEN_STATE: ListenSessionState = {
  phase: 'idle',
  target: null,
  attempt: 0,
  step: null,
  listenId: null,
  startedAt: null,
  stoppedAt: null,
  retry: null,
  connectDeadline: null,
  internalErrors: 0,
  liveSince: null,
  end: null,
  refusal: null,
  refusalSeq: 0,
  soundBlocked: false,
  agentSilent: false,
  clock: ClockOffsetEstimator.empty(),
};

/**
 * Whether Try again applies: "Connection lost", or a listen ended because the server could not
 * check the supervisor's access (`unverified`, LS21), where a fresh grant checks it afresh.
 */
export function retryable(state: ListenSessionState): boolean {
  return state.phase === 'lost' || (state.phase === 'ended' && state.end?.kind === 'unverified');
}

/** Whether an attach is under way: the phases with a step. */
function attaching(state: ListenSessionState): boolean {
  return state.phase === 'connecting' || state.phase === 'reconnecting';
}

/** The session over, keeping the target for the bar. */
function toEnded(state: ListenSessionState, kind: ListenEndKind, now: number, code: AgencyListenErrorCode | null = null): ListenSessionState {
  return {
    ...state,
    phase: 'ended',
    step: null,
    retry: null,
    connectDeadline: null,
    stoppedAt: now,
    end: { kind, listenedMs: state.startedAt === null ? 0 : Math.max(0, now - state.startedAt), code },
    agentSilent: false,
  };
}

function toIdle(state: ListenSessionState): ListenSessionState {
  return { ...INITIAL_LISTEN_STATE, attempt: state.attempt, refusal: state.refusal, refusalSeq: state.refusalSeq };
}

function toLost(state: ListenSessionState, now: number): ListenSessionState {
  return { ...state, phase: 'lost', step: null, retry: null, connectDeadline: null, stoppedAt: now, agentSilent: false };
}

/**
 * Recover from a drop: wait, then attach again, until the window closes. The window opens at the
 * first drop and is not renewed by later ones; only a `ready` (or Try again) ends the recovery.
 * Before any audio the window is the first attach's own, from the click.
 *
 * Server failures are counted across `ready`s: one failing right after every `ready` would
 * otherwise mint a grant, a session row and two audit rows every few seconds for ever. The count
 * starts again only once the listen has stayed live for {@link LISTEN_STABLE_MS}.
 */
function recover(state: ListenSessionState, now: number, internal: boolean): ListenSessionState {
  const retry = state.retry ?? { deadline: state.connectDeadline ?? now + AGENCY_LISTEN_RECONNECT_WINDOW_MS };
  const settled = state.phase === 'live' && state.liveSince !== null && now - state.liveSince >= LISTEN_STABLE_MS;
  const internalErrors = (settled ? 0 : state.internalErrors) + (internal ? 1 : 0);
  if (internalErrors >= LISTEN_MAX_INTERNAL_ERRORS || now >= retry.deadline) return toLost(state, now);
  return {
    ...state,
    phase: state.startedAt === null ? 'connecting' : 'reconnecting',
    step: 'wait',
    retry,
    internalErrors,
    agentSilent: false,
  };
}

function applyOutcome(state: ListenSessionState, outcome: ListenCloseOutcome, now: number): ListenSessionState {
  switch (outcome.kind) {
    case 'stopped':
      return toIdle(state);
    case 'call_ended':
    case 'revoked':
    case 'turned_off':
    case 'superseded':
    case 'unverified':
      return toEnded(state, outcome.kind, now);
    case 'refused':
      return toEnded(state, 'refused', now, outcome.code);
    case 'reconnect':
      return recover(state, now, false);
    case 'internal':
      return recover(state, now, true);
  }
}

/**
 * What a refused re-grant means while recovering: the call is gone (`listen_call_not_live`, a
 * 404), listening was turned off for the account (403 `feature_disabled`), the supervisor may no
 * longer listen (any other 401 or 403), a refusal that will not change (409 `listen_recording_off`,
 * `listen_limit_call`, `listen_own_call`), or one worth retrying within the window (no answer,
 * 5xx, `listen_limit_server`, `listen_unavailable`).
 */
export function regrantOutcome(refusal: ListenGrantRefusal): ListenCloseOutcome {
  if (refusal.code === 'listen_call_not_live' || refusal.status === 404) return { kind: 'call_ended' };
  if (refusal.status === 403 && refusal.code === 'feature_disabled') return { kind: 'turned_off' };
  if (refusal.status === 401 || refusal.status === 403) return { kind: 'revoked' };
  if (
    refusal.code === 'listen_recording_off'
    || refusal.code === 'listen_limit_call'
    || refusal.code === 'listen_own_call'
  ) {
    return { kind: 'refused', code: refusal.code };
  }
  if (refusal.status !== null && refusal.status >= 400 && refusal.status < 500 && refusal.status !== 408 && refusal.status !== 429) {
    return { kind: 'refused', code: null };
  }
  return { kind: 'reconnect' };
}

export function listenSessionReducer(state: ListenSessionState, event: ListenSessionEvent): ListenSessionState {
  switch (event.type) {
    case 'start':
      return {
        ...INITIAL_LISTEN_STATE,
        phase: 'connecting',
        step: 'grant',
        target: event.target,
        attempt: state.attempt + 1,
        connectDeadline: event.now + AGENCY_LISTEN_RECONNECT_WINDOW_MS,
        refusal: null,
        refusalSeq: state.refusalSeq,
      };

    case 'granted':
      if (!attaching(state) || event.attempt !== state.attempt || state.step !== 'grant') return state;
      return { ...state, step: 'socket', listenId: event.listenId };

    case 'grant_refused': {
      if (!attaching(state) || event.attempt !== state.attempt || state.step !== 'grant') return state;
      // The very first grant of a listen: nothing was heard, so it is a toast and no bar.
      if (state.phase === 'connecting' && state.startedAt === null && state.retry === null) {
        return { ...toIdle(state), refusal: event.refusal, refusalSeq: state.refusalSeq + 1 };
      }
      return applyOutcome(state, regrantOutcome(event.refusal), event.now);
    }

    case 'ready':
      if (!attaching(state) || event.attempt !== state.attempt || state.step !== 'socket') return state;
      return {
        ...state,
        phase: 'live',
        step: null,
        listenId: event.listenId,
        startedAt: state.startedAt ?? event.now,
        liveSince: event.now,
        retry: null,
        connectDeadline: null,
      };

    case 'server_ended': {
      if (event.attempt !== state.attempt || !(attaching(state) || state.phase === 'live')) return state;
      const outcome = terminalEndReason(event.reason);
      return outcome ? applyOutcome(state, outcome, event.now) : state;
    }

    case 'closed':
      if (event.attempt !== state.attempt) return state;
      if (state.phase === 'live' || (attaching(state) && state.step === 'socket')) {
        return applyOutcome(state, listenCloseOutcome(event.code, event.reason), event.now);
      }
      return state;

    case 'reattach':
      if (!attaching(state) || state.step !== 'wait') return state;
      if (pastDeadline(state, event.now)) return toLost(state, event.now);
      return { ...state, attempt: state.attempt + 1, step: 'grant', listenId: null };

    case 'tick':
      if (attaching(state) && pastDeadline(state, event.now)) return toLost(state, event.now);
      return state;

    case 'pong':
      if (event.attempt !== state.attempt || state.phase !== 'live') return state;
      return { ...state, clock: state.clock.push(event.sample) };

    case 'stop':
      return state.phase === 'idle' ? state : toIdle(state);

    case 'withdrawn':
      // Anything open, a lost listen included (Try again could not work now); an ended one keeps
      // the reason it already gives.
      if (state.phase === 'idle' || state.phase === 'ended') return state;
      return toEnded(state, event.kind, event.now);

    case 'retry':
      if (!retryable(state) || !state.target) return state;
      return {
        ...state,
        end: null,
        // The time it stood stopped was not heard: "you listened for" leaves it out.
        startedAt: state.startedAt === null ? null : state.startedAt + Math.max(0, event.now - (state.stoppedAt ?? event.now)),
        stoppedAt: null,
        phase: state.startedAt === null ? 'connecting' : 'reconnecting',
        step: 'grant',
        attempt: state.attempt + 1,
        listenId: null,
        retry: { deadline: event.now + AGENCY_LISTEN_RECONNECT_WINDOW_MS },
        internalErrors: 0,
      };

    case 'dismiss':
      return state.phase === 'ended' || state.phase === 'lost' ? toIdle(state) : state;

    case 'sound':
      return state.soundBlocked === event.blocked ? state : { ...state, soundBlocked: event.blocked };

    case 'agent_silent': {
      const silent = event.silent && state.phase === 'live';
      return state.agentSilent === silent ? state : { ...state, agentSilent: silent };
    }
  }
}

/**
 * When the attach under way gives up (client ms): the recovery window, else the first attach's
 * own deadline; null when nothing is pending. The controller's timer fires a `tick` at it.
 */
export function listenDeadline(state: ListenSessionState): number | null {
  if (!attaching(state)) return null;
  return state.retry?.deadline ?? state.connectDeadline;
}

function pastDeadline(state: ListenSessionState, now: number): boolean {
  const deadline = listenDeadline(state);
  return deadline !== null && now >= deadline;
}

/** Whether the bar is up: anything but idle. */
export function listenBarVisible(state: ListenSessionState): boolean {
  return state.phase !== 'idle' && state.target !== null;
}

/** Whether a socket should be open or opening: the attach is at its socket step, or live. */
export function listenSocketWanted(state: ListenSessionState): boolean {
  return state.phase === 'live' || (attaching(state) && state.step === 'socket');
}
