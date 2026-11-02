/**
 * Stop a TCP socket reading from the kernel, so the bytes a client sends next stay in the
 * file descriptor and travel with it when the socket is handed to a media worker
 * (`docs/scaling.md` §2.1).
 *
 * ── Why a Node internal, and only here ──────────────────────────────────────
 * Node has no public API for this. `socket.pause()` stops a plain `net.Socket`'s stream
 * from flowing but leaves its handle reading: libuv keeps pulling bytes into the JS
 * buffer (up to the high-water mark), and `child.send(msg, socket)` closes the parent's
 * copy without moving that buffer, so those bytes are lost. Draining with `socket.read()`
 * after `pause()` does not close the race either: `read()` re-arms the handle
 * (`_read` → `tryReadStart`), so more bytes can land in the buffer after the drain and
 * before the handle is sent; and once `send` takes the handle it sets `handle.onread` to
 * a no-op, so anything read in that window is dropped. The spike measured it: a frame sent
 * while the primary is in its async hook is lost unless the handle's reads are stopped.
 *
 * So this is the one place that touches `socket._handle.readStop()`, the call
 * `net.Socket.prototype.pause` itself makes for its own buffered sockets. It is feature
 * detected: {@link socketReadStopSupported} answers whether this Node has it, and the
 * primary checks it once at boot on a real loopback socket ({@link probeSocketReadStop}).
 * Without it the primary does not fork media workers at all and serves every socket
 * itself, as a single process does; per-socket handoff is never attempted without it.
 * `test/unit/cluster/socket-pause.test.ts` pins the internal against the running Node,
 * so an upgrade that changes it fails loudly there. Known good: Node 22 (`.nvmrc`).
 */
import net from 'node:net';

interface ReadableHandle {
  reading?: boolean;
  readStop?: () => number;
}

function handleOf(socket: net.Socket): ReadableHandle | null {
  const handle = (socket as unknown as { _handle?: unknown })._handle;
  return handle && typeof handle === 'object' ? (handle as ReadableHandle) : null;
}

/** Does this socket expose the internal this module relies on? */
export function socketReadStopSupported(socket: net.Socket): boolean {
  const handle = handleOf(socket);
  return !!handle && typeof handle.readStop === 'function' && typeof handle.reading === 'boolean';
}

/**
 * Stop the socket's handle reading. True when it is stopped (or was not reading); false
 * when this Node does not expose the internal, in which case the caller must NOT hand the
 * socket off.
 */
export function stopSocketReads(socket: net.Socket): boolean {
  const handle = handleOf(socket);
  if (!handle || typeof handle.readStop !== 'function' || typeof handle.reading !== 'boolean') return false;
  if (!handle.reading) return true;
  handle.reading = false;
  const err = handle.readStop();
  return err === 0 || err === undefined;
}

/**
 * Detach a server's socket from the server's worker tracking before `child.send` hands it
 * to a media worker. The second Node behaviour the handoff must step around: for a socket
 * a `net.Server` accepted (`socket.server` set), `child_process` registers the child as a
 * "worker" of that server, and the server's `close()` then waits until the CHILD reports
 * every socket it was sent as closed. The primary closes HTTP first on shutdown, while
 * its workers still hold live stations and calls, so `close()` would wait for them
 * forever. With `socket.server` cleared, Node does no such tracking; the server's own
 * count (`_server`, untouched) is decremented once when the primary destroys its copy of
 * the socket after the send (`ipc-channel.ts`). False when the property is not there to
 * clear (a Node that changed it): the caller must not hand the socket off.
 */
export function detachFromServer(socket: net.Socket): boolean {
  const own = Object.getOwnPropertyDescriptor(socket, 'server');
  if (!own || !own.writable) return false;
  (socket as unknown as { server: unknown }).server = null;
  return true;
}

/**
 * Check, on a real loopback connection, that a server-side socket exposes the internals
 * the handoff needs (reads can be stopped; `server` can be detached) and that stopping
 * reads works. Run once at boot by a primary configured for media workers.
 */
export async function probeSocketReadStop(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      server.close();
      resolve(ok);
    };
    const server = net.createServer((socket) => {
      const ok = socketReadStopSupported(socket) && stopSocketReads(socket) && handleOf(socket)?.reading === false
        && detachFromServer(socket);
      socket.destroy();
      client.destroy();
      done(ok);
    });
    server.on('error', () => done(false));
    let client: net.Socket;
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      client = net.connect(port, '127.0.0.1');
      client.on('error', () => done(false));
    });
    setTimeout(() => done(false), 2_000).unref();
  });
}
