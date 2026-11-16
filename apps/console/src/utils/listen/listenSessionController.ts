import { AGENCY_LISTEN_PING_INTERVAL_MS, type AgencyListenLeg } from '../../types/live-calls';
import type { ListenGrantResult } from '../../api/liveCalls';
import { encodeListenClientFrame, parseListenMessage } from './listenFrames';
import {
  INITIAL_LISTEN_STATE,
  listenSessionReducer,
  listenSocketWanted,
  type ListenSessionEvent,
  type ListenSessionState,
  type ListenTarget,
} from './listenSessionReducer';

/**
 * The listen's side effects, driven by {@link listenSessionReducer}: it mints grants, opens and
 * closes the socket, sends `ping` every 10 s and `stop`, waits between reconnects and checks the
 * window. After every event it compares the state before and after and does only what the new
 * state asks for, so the reducer stays the one place a state is decided.
 *
 * A small store (`getState` / `subscribe`) rather than React state, so a decision is visible the
 * moment it is made: `useListenSession` reads it with `useSyncExternalStore`.
 */

/** The socket surface used (a fake in tests). */
export interface ListenSocket {
  binaryType: BinaryType;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ListenSessionDeps {
  grant: (callId: string) => Promise<ListenGrantResult>;
  /** Opens the socket for a grant's `ws_url` (a relative path; the caller resolves the host). */
  openSocket: (wsUrl: string) => ListenSocket;
  /** One audio frame of a live session. Called ~100 times a second: no React state behind it. */
  onAudio: (leg: AgencyListenLeg, frame: Uint8Array) => void;
  /** A new socket is about to open: the playback drops the last attach's queue. */
  onAttach?: () => void;
  now?: () => number;
}

/** Waits before each reconnect within the window: quick first, then steady. */
export const LISTEN_RECONNECT_DELAYS_MS: readonly number[] = [250, 1_000, 2_000, 3_000];

/** How long "Call ended · you listened for mm:ss" stays before the bar goes. */
export const LISTEN_ENDED_DISMISS_MS = 6_000;

const OPEN = 1;

export class ListenSessionController {
  private state: ListenSessionState = INITIAL_LISTEN_STATE;
  private readonly listeners = new Set<() => void>();
  private socket: ListenSocket | null = null;
  private socketAttempt = -1;
  private grantUrl: { attempt: number; url: string } | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private waits = 0;
  private readonly now: () => number;

  constructor(private deps: ListenSessionDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Swap the dependencies (a new tenant header, say) without touching the session. */
  setDeps(deps: ListenSessionDeps): void {
    this.deps = deps;
  }

  getState = (): ListenSessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch(event: ListenSessionEvent): void {
    const prev = this.state;
    const next = listenSessionReducer(prev, event);
    if (next === prev) return;
    this.state = next;
    this.sync(prev, next);
    for (const listener of this.listeners) listener();
  }

  /** Listen to a call; any listen open here is stopped first (one at a time per supervisor). */
  start(target: ListenTarget): void {
    if (this.state.phase !== 'idle') this.stop();
    this.waits = 0;
    this.dispatch({ type: 'start', target, now: this.now() });
  }

  /** The supervisor stopped: `stop` on the socket, then close it. */
  stop(): void {
    const socket = this.socket;
    if (socket && socket.readyState === OPEN) {
      try {
        socket.send(encodeListenClientFrame({ event: 'stop' }));
      } catch {
        /* the close below is what matters */
      }
    }
    this.dispatch({ type: 'stop' });
  }

  retry(): void {
    this.waits = 0;
    this.dispatch({ type: 'retry', now: this.now() });
  }

  dismiss(): void {
    this.dispatch({ type: 'dismiss' });
  }

  /** Whether the browser runs the audio, from the playback. */
  reportSound(blocked: boolean): void {
    this.dispatch({ type: 'sound', blocked });
  }

  reportAgentSilent(silent: boolean): void {
    this.dispatch({ type: 'agent_silent', silent });
  }

  /** Leaving the shell or the account: stop whatever is open and forget it. Safe to call twice. */
  destroy(): void {
    this.stop();
    this.dispatch({ type: 'dismiss' });
    this.clearTimers();
    this.closeSocket();
  }

  // ── Side effects ──────────────────────────────────────────────────────────

  private sync(prev: ListenSessionState, next: ListenSessionState): void {
    // A new grant to mint: a new attach at its grant step.
    if (next.step === 'grant' && (prev.attempt !== next.attempt || prev.step !== 'grant')) {
      this.mint(next.attempt, next.target!.callId);
    }

    // The socket: open the granted one, close one no longer wanted (or an older attempt's).
    if (!listenSocketWanted(next) || this.socketAttempt !== next.attempt) this.closeSocket();
    if (next.step === 'socket' && this.socket === null && this.grantUrl?.attempt === next.attempt) {
      this.open(next.attempt, this.grantUrl.url);
    }

    // Liveness: `ping` every 10 s while live.
    if (next.phase === 'live' && this.pingTimer === null) {
      this.pingTimer = setInterval(() => this.ping(), AGENCY_LISTEN_PING_INTERVAL_MS);
    } else if (next.phase !== 'live' && this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (next.phase === 'live') this.waits = 0;

    // Recovery: wait, then attach again; and close the window on time even while waiting.
    if (next.step === 'wait' && prev.step !== 'wait') {
      const delay = LISTEN_RECONNECT_DELAYS_MS[Math.min(this.waits, LISTEN_RECONNECT_DELAYS_MS.length - 1)]!;
      this.waits += 1;
      this.clearWait();
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        this.dispatch({ type: 'reattach', now: this.now() });
      }, delay);
    }
    if (next.retry && next.retry !== prev.retry && next.retry.deadline !== prev.retry?.deadline) {
      this.clearDeadline();
      this.deadlineTimer = setTimeout(() => {
        this.deadlineTimer = null;
        this.dispatch({ type: 'tick', now: this.now() });
      }, Math.max(0, next.retry.deadline - this.now()));
    }
    if (next.retry === null) this.clearDeadline();
    if (next.step !== 'wait') this.clearWait();

    // "Call ended · you listened for mm:ss" goes by itself.
    if (next.phase === 'ended' && prev.phase !== 'ended' && next.end?.kind === 'call_ended') {
      this.clearDismiss();
      this.dismissTimer = setTimeout(() => {
        this.dismissTimer = null;
        this.dispatch({ type: 'dismiss' });
      }, LISTEN_ENDED_DISMISS_MS);
    }
    if (next.phase !== 'ended') this.clearDismiss();
  }

  private mint(attempt: number, callId: string): void {
    this.grantUrl = null;
    let pending: Promise<ListenGrantResult>;
    try {
      pending = this.deps.grant(callId);
    } catch {
      pending = Promise.resolve({ ok: false, status: null, code: null });
    }
    void pending
      .catch((): ListenGrantResult => ({ ok: false, status: null, code: null }))
      .then((result) => {
        if (this.state.attempt !== attempt) return;
        if (result.ok) {
          this.grantUrl = { attempt, url: result.grant.ws_url };
          this.dispatch({ type: 'granted', attempt, listenId: result.grant.listen_id });
        } else {
          this.dispatch({ type: 'grant_refused', attempt, refusal: { status: result.status, code: result.code }, now: this.now() });
        }
      });
  }

  private open(attempt: number, url: string): void {
    this.deps.onAttach?.();
    let socket: ListenSocket;
    try {
      socket = this.deps.openSocket(url);
    } catch {
      // An unopenable URL is a drop like any other; dispatched after this sync returns.
      queueMicrotask(() => this.dispatch({ type: 'closed', attempt, code: 1006, reason: '', now: this.now() }));
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.socketAttempt = attempt;
    socket.onmessage = (ev) => this.onMessage(attempt, ev.data);
    socket.onclose = (ev) => {
      if (this.socket === socket) {
        this.socket = null;
        this.socketAttempt = -1;
      }
      this.dispatch({ type: 'closed', attempt, code: ev.code, reason: ev.reason ?? '', now: this.now() });
    };
    socket.onerror = () => {
      /* the close follows */
    };
  }

  private onMessage(attempt: number, data: unknown): void {
    if (attempt !== this.state.attempt) return;
    const message = parseListenMessage(data);
    if (!message) return;
    if (message.kind === 'audio') {
      if (this.state.phase === 'live') this.deps.onAudio(message.leg, message.frame);
      return;
    }
    const frame = message.frame;
    const now = this.now();
    switch (frame.event) {
      case 'ready':
        this.dispatch({ type: 'ready', attempt, listenId: frame.listen_id, now });
        return;
      case 'ended':
        this.dispatch({ type: 'server_ended', attempt, reason: frame.reason, now });
        return;
      case 'pong':
        if (typeof frame.ts === 'number') {
          this.dispatch({ type: 'pong', attempt, sample: { ts: frame.ts, server_ts: frame.server_ts, receivedAt: now } });
        }
        return;
    }
  }

  private ping(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    try {
      socket.send(encodeListenClientFrame({ event: 'ping', ts: this.now() }));
    } catch {
      /* the close follows */
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.socketAttempt = -1;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000);
    } catch {
      /* already closed */
    }
  }

  private clearWait(): void {
    if (this.waitTimer !== null) clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private clearDismiss(): void {
    if (this.dismissTimer !== null) clearTimeout(this.dismissTimer);
    this.dismissTimer = null;
  }

  private clearTimers(): void {
    this.clearWait();
    this.clearDeadline();
    this.clearDismiss();
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
