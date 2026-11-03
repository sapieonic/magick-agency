import type { IpcTransport } from '../../src/cluster/ipc-channel.js';

/**
 * Two connected in-memory IPC transports. Every message is JSON round-tripped and
 * delivered on a later macrotask, as Node's `child_process` channel does, so a test sees
 * the same serialisation and asynchrony as two real processes.
 */
export interface MemoryTransportPair {
  a: IpcTransport;
  b: IpcTransport;
  /** Close both ends, as a child exiting does. */
  disconnect(): void;
  /** Deliver a raw value to `b` as if `a` had sent it (bypassing the channel's encoder). */
  injectToB(raw: unknown): void;
  /** Everything `a` sent, decoded, in order. */
  sentByA: unknown[];
  sentByB: unknown[];
  /** Make `send` on `a` report a backlog (still delivers). */
  backlogA: boolean;
}

export function memoryTransportPair(): MemoryTransportPair {
  let connected = true;
  const handlers = { a: new Set<(m: unknown) => void>(), b: new Set<(m: unknown) => void>() };
  const closers = { a: new Set<() => void>(), b: new Set<() => void>() };
  const pair: MemoryTransportPair = {
    a: null as unknown as IpcTransport,
    b: null as unknown as IpcTransport,
    sentByA: [],
    sentByB: [],
    backlogA: false,
    disconnect() {
      if (!connected) return;
      connected = false;
      for (const h of [...closers.a, ...closers.b]) h();
    },
    injectToB(raw) {
      setImmediate(() => { if (connected) for (const h of handlers.b) h(raw); });
    },
  };
  const end = (self: 'a' | 'b', peer: 'a' | 'b'): IpcTransport => ({
    send(message) {
      if (!connected) return false;
      const wire = JSON.parse(JSON.stringify(message)) as unknown;
      (self === 'a' ? pair.sentByA : pair.sentByB).push(wire);
      setImmediate(() => { if (connected) for (const h of handlers[peer]) h(wire); });
      return !(self === 'a' && pair.backlogA);
    },
    onMessage(handler) {
      handlers[self].add(handler);
      return () => { handlers[self].delete(handler); };
    },
    onClose(handler) {
      closers[self].add(handler);
      return () => { closers[self].delete(handler); };
    },
    get connected() { return connected; },
  });
  pair.a = end('a', 'b');
  pair.b = end('b', 'a');
  return pair;
}
