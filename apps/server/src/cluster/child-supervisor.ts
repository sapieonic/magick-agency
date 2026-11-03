/**
 * The primary's side of one role's child processes (`docs/scaling.md` §6): fork one per
 * slot, wait for each to say `ready`, give each incarnation its own {@link IpcChannel},
 * restart a slot that exits with backoff, and stop them all within a grace.
 *
 * Generic over the role: what an analysis or a media child DOES with its channel is the
 * caller's (`onChannel`), and what must happen between an exit and the re-fork is the
 * caller's too (`onExit`, awaited first: a media slot's reap runs there, so nothing new
 * can be owned by the slot before its dead incarnation's work is closed).
 */
import type { ChildProcess } from 'node:child_process';
import { createChildLogger } from '@magick-agency/observability';
import { primeChildExits, trackChildExit } from '@magick-agency/observability/metrics/voice';
import { IpcChannel, childProcessTransport, type IpcChannelOptions } from './ipc-channel.js';
import type { HealthBody, IpcEventMap, IpcEventType, WsHandoff } from './ipc-protocol.js';
import type { ChildRole } from './roles.js';

const log = createChildLogger({ component: 'child-supervisor' });

export const DEFAULT_RESTART_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
/** Exits within this window count towards the backoff step and the crash-loop limit. */
export const CRASH_WINDOW_MS = 5 * 60_000;
export const DEFAULT_READY_TIMEOUT_MS = 30_000;

export interface ChildExit {
  slot: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the supervisor asked for it (stop) and it exited cleanly (code 0, no signal) within the stop's grace. */
  expected: boolean;
  pid: number | undefined;
}

export interface ChildSupervisorOptions {
  role: ChildRole;
  count: number;
  fork: (slot: number) => ChildProcess;
  /** Wire one incarnation's channel (event handlers, request handlers). Called before `ready`. */
  onChannel?: (slot: number, channel: IpcChannel) => void;
  /** Awaited after an unexpected exit (a crash, also one during a stop, or a child the stop had to SIGKILL), before the slot is re-forked. */
  onExit?: (exit: ChildExit) => void | Promise<void>;
  /** A slot became ready (first boot or a restart). */
  onReady?: (slot: number, pid: number) => void;
  /** Bounds for each incarnation's channel (`IpcChannelOptions`). */
  channelBounds?: Pick<IpcChannelOptions, 'maxInFlight' | 'maxInFlightByType'>;
  readyTimeoutMs?: number;
  restartBackoffMs?: readonly number[];
  /** More than `max` unexpected exits of one slot inside {@link CRASH_WINDOW_MS}: no re-fork, `onCrashLoop` instead. */
  crashLoop?: { max: number; onCrashLoop: (slot: number) => void };
  now?: () => number;
}

interface Slot {
  slot: number;
  child: ChildProcess | null;
  channel: IpcChannel | null;
  ready: boolean;
  exits: number[];
  restartTimer: NodeJS.Timeout | null;
  exited: Promise<void> | null;
  /** The stop had to SIGKILL this incarnation: its exit is not a clean one, and `onExit` runs. */
  killedAtStop: boolean;
}

export class ChildSupervisor {
  private readonly slots: Slot[];
  private stopping = false;
  private readonly now: () => number;
  private readonly readyWaiters = new Map<number, Array<() => void>>();

  constructor(private readonly opts: ChildSupervisorOptions) {
    if (!Number.isInteger(opts.count) || opts.count < 1) throw new RangeError(`child count must be ≥ 1, got ${opts.count}`);
    this.now = opts.now ?? Date.now;
    // Both exit series exist at zero from now on, so the crash alert's `increase()` sees the
    // role's first crash (`primeChildExits`).
    primeChildExits(opts.role);
    this.slots = Array.from({ length: opts.count }, (_, slot) => ({
      slot, child: null, channel: null, ready: false, exits: [], restartTimer: null, exited: null, killedAtStop: false,
    }));
  }

  get role(): ChildRole {
    return this.opts.role;
  }

  get count(): number {
    return this.slots.length;
  }

  /** Fork every slot and wait until each is ready. Rejects if one is not ready in time. */
  async start(): Promise<void> {
    for (const s of this.slots) this.spawn(s);
    const timeoutMs = this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    await Promise.all(this.slots.map((s) => this.waitReady(s.slot, timeoutMs)));
  }

  isReady(slot: number): boolean {
    return this.slots[slot]?.ready === true;
  }

  readyCount(): number {
    return this.slots.filter((s) => s.ready).length;
  }

  /** The channel of a READY slot; null while it boots, restarts or after it stopped. */
  channel(slot: number): IpcChannel | null {
    const s = this.slots[slot];
    return s && s.ready ? s.channel : null;
  }

  pidOf(slot: number): number | undefined {
    return this.slots[slot]?.child?.pid;
  }

  /** Send an event to every ready slot (but `exceptSlot`). Returns how many it went to. */
  broadcast<K extends IpcEventType>(type: K, body: IpcEventMap[K], exceptSlot?: number): number {
    let sent = 0;
    for (const s of this.slots) {
      if (s.slot === exceptSlot || !s.ready || !s.channel) continue;
      if (s.channel.emit(type, body)) sent++;
    }
    return sent;
  }

  /** Hand an upgraded socket to a READY slot. False when it could not be sent. */
  sendHandoff(slot: number, msg: WsHandoff, socket: unknown): boolean {
    const s = this.slots[slot];
    if (!s || !s.ready || !s.channel) return false;
    return s.channel.sendHandoff(msg, socket);
  }

  /** Every slot's health, null for a slot that is not ready or did not answer in time. */
  async health(deadlineMs = 1_000): Promise<Array<HealthBody | null>> {
    return Promise.all(this.slots.map(async (s) => {
      if (!s.ready || !s.channel) return null;
      return s.channel.request('health.ping', {}, { deadlineMs }).catch(() => null);
    }));
  }

  /** Resolves when `slot` is ready (now or later), rejects after `timeoutMs`. */
  waitReady(slot: number, timeoutMs: number): Promise<void> {
    if (this.isReady(slot)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.readyWaiters.get(slot);
        if (list) this.readyWaiters.set(slot, list.filter((w) => w !== done));
        reject(new Error(`${this.opts.role} worker ${slot} not ready within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      const done = (): void => { clearTimeout(timer); resolve(); };
      const list = this.readyWaiters.get(slot) ?? [];
      list.push(done);
      this.readyWaiters.set(slot, list);
    });
  }

  /**
   * Ask every child to shut down, wait up to `graceMs` for each to exit, then kill what is
   * left and wait for those exits too. No slot is restarted once this has begun.
   */
  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    for (const s of this.slots) {
      if (s.restartTimer) clearTimeout(s.restartTimer);
      s.restartTimer = null;
    }
    await Promise.all(this.slots.map(async (s) => {
      const child = s.child;
      // A child that already exited may still be in its `onExit` (a media slot's crash reap
      // writing its calls' rows): wait for that too, or the pool closes under it.
      if (!child) { await s.exited; return; }
      if (!s.exited) return;
      const exited = s.exited;
      s.channel?.request('shutdown', { graceMs }, { deadlineMs: graceMs }).catch(() => {});
      const inTime = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((r) => { const t = setTimeout(() => r(false), graceMs); t.unref?.(); }),
      ]);
      if (!inTime) {
        log.error({ role: this.opts.role, slot: s.slot, pid: child.pid, graceMs }, 'Child did not exit within its grace — killing it');
        // Its own shutdown did not finish, so what it owned was not closed: its exit runs
        // `onExit` like a crash (a media slot's reap: its calls' slots, attempts and
        // agents), and the stop waits for that before it resolves. No restart follows.
        s.killedAtStop = true;
        child.kill('SIGKILL');
        await exited;
      }
    }));
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private spawn(s: Slot): void {
    const child = this.opts.fork(s.slot);
    s.child = child;
    s.ready = false;
    s.killedAtStop = false;
    const channel = new IpcChannel(childProcessTransport(child), { name: `primary→${this.opts.role}${s.slot}`, ...this.opts.channelBounds });
    s.channel = channel;
    channel.onEvent('ready', (body) => {
      if (body.role !== this.opts.role || body.slot !== s.slot || s.child !== child) {
        log.error({ expected: { role: this.opts.role, slot: s.slot }, got: body }, 'A child announced the wrong role or slot — ignoring');
        return;
      }
      s.ready = true;
      log.info({ role: this.opts.role, slot: s.slot, pid: body.pid }, 'Child process ready');
      this.opts.onReady?.(s.slot, body.pid);
      for (const w of this.readyWaiters.get(s.slot) ?? []) w();
      this.readyWaiters.delete(s.slot);
    });
    this.opts.onChannel?.(s.slot, channel);
    s.exited = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        channel.close();
        if (s.child === child) {
          s.ready = false;
          s.child = null;
          s.channel = null;
        }
        void this.onChildExit(s, { slot: s.slot, code, signal, expected: this.isCleanStopExit(s, code, signal), pid: child.pid }).finally(resolve);
      });
    });
    child.on('error', (err) => log.error({ err, role: this.opts.role, slot: s.slot }, 'Child process error'));
  }

  /**
   * Expected only when the stop asked for it AND the child finished its own shutdown: code 0,
   * no signal, not killed by the stop. A child that crashes while it stops (an OOM, a
   * SIGSEGV, an uncaught throw: a signal or a non-zero code) did not close what it owned, so
   * its exit is unexpected: counted as a crash and reaped by `onExit` (no restart follows).
   */
  private isCleanStopExit(s: Slot, code: number | null, signal: NodeJS.Signals | null): boolean {
    return this.stopping && !s.killedAtStop && code === 0 && signal === null;
  }

  private async onChildExit(s: Slot, exit: ChildExit): Promise<void> {
    trackChildExit(this.opts.role, exit.expected);
    if (exit.expected) {
      log.info({ ...exit, role: this.opts.role }, 'Child process exited');
      return;
    }
    log.error({ ...exit, role: this.opts.role }, 'Child process exited unexpectedly');
    try {
      await this.opts.onExit?.(exit);
    } catch (err) {
      log.error({ err, role: this.opts.role, slot: s.slot }, 'Child exit handling failed');
    }
    if (this.stopping) return;
    const now = this.now();
    s.exits = s.exits.filter((t) => now - t < CRASH_WINDOW_MS);
    s.exits.push(now);
    if (this.opts.crashLoop && s.exits.length > this.opts.crashLoop.max) {
      log.fatal({ role: this.opts.role, slot: s.slot, exits: s.exits.length, windowMs: CRASH_WINDOW_MS }, 'Child process crash loop');
      this.opts.crashLoop.onCrashLoop(s.slot);
      return;
    }
    const backoff = this.opts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    const delay = backoff[Math.min(s.exits.length - 1, backoff.length - 1)] ?? 1_000;
    log.warn({ role: this.opts.role, slot: s.slot, delayMs: delay }, 'Restarting child process');
    s.restartTimer = setTimeout(() => {
      s.restartTimer = null;
      if (!this.stopping) this.spawn(s);
    }, delay);
    s.restartTimer.unref?.();
  }
}
