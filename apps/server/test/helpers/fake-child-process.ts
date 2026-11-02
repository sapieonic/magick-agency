import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

/**
 * A fake forked child for the primary's cluster objects (`ChildSupervisor`,
 * `MediaCluster`): it speaks the IPC envelope (`ipc-protocol.ts`) on `send` / `message`,
 * announces `ready` for its slot, answers the requests it has a handler for, and exits on
 * `shutdown` (unless told not to) or `kill`.
 */
let nextPid = 50_000;

export type FakeRequestHandler = (body: unknown) => unknown;

export class FakeChildProcess extends EventEmitter {
  connected = true;
  readonly pid = nextPid++;
  /** Every envelope the primary sent, in order. */
  readonly sent: Array<{ kind?: string; type?: string; id?: number; body?: unknown }> = [];
  /** Answer `shutdown` by exiting 0. False: ignore it (a worker that hangs at stop). */
  answerShutdown = true;
  readonly handlers = new Map<string, FakeRequestHandler>();

  constructor(readonly role: 'media' | 'analysis', readonly slot: number) { super(); }

  send(message: unknown, ...rest: unknown[]): boolean {
    const m = message as { kind?: string; type?: string; id?: number; body?: unknown };
    this.sent.push(m);
    const cb = rest.find((r) => typeof r === 'function') as ((e: Error | null) => void) | undefined;
    cb?.(null);
    if (m.kind === 'req' && m.type === 'shutdown') {
      if (this.answerShutdown) setImmediate(() => this.exit(0, null));
      return true;
    }
    const handler = m.kind === 'req' && m.type ? this.handlers.get(m.type) : undefined;
    if (handler && m.id !== undefined) {
      const id = m.id;
      setImmediate(() => {
        if (!this.connected) return;
        this.emit('message', { v: 1, kind: 'res', id, ok: true, body: handler(m.body) });
      });
    }
    return true;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  ready(replicaId = `fake:mw${this.slot}:${this.pid}`): void {
    this.emit('message', { v: 1, kind: 'event', type: 'ready', body: { role: this.role, slot: this.slot, pid: this.pid, replicaId } });
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnect');
    this.emit('exit', code, signal);
  }

  /** The requests of one type the primary sent. */
  requests(type: string): Array<{ id?: number; body?: unknown }> {
    return this.sent.filter((m) => m.kind === 'req' && m.type === type);
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

/** An empty `reaper.snapshot` answer. */
export const EMPTY_SNAPSHOT = { activeAttemptIds: [], unrecordedEnds: [], manualActiveIds: [], activeCallIds: [], leases: [] };
