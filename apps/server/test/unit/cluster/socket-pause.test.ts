import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detachFromServer, probeSocketReadStop, socketReadStopSupported, stopSocketReads } from '../../../src/cluster/socket-pause.js';

/*
 * The Node internal the upgrade handoff relies on (`src/cluster/socket-pause.ts`,
 * docs/scaling.md §2.1), pinned against the Node running the tests. If a Node upgrade
 * changes `net.Socket`'s handle, the first test here fails, and so does the boot probe,
 * which makes the primary run without media workers rather than lose bytes.
 */

const opened: Array<{ server: net.Server; client: net.Socket; socket: net.Socket }> = [];

async function pair(): Promise<{ server: net.Server; client: net.Socket; socket: net.Socket }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const p = { server, client, socket };
      opened.push(p);
      resolve(p);
    });
    let client: net.Socket;
    server.listen(0, '127.0.0.1', () => {
      client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
    });
  });
}

const handle = (s: net.Socket) => (s as unknown as { _handle: { reading: boolean } })._handle;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const p of opened.splice(0)) { p.client.destroy(); p.socket.destroy(); p.server.close(); }
});

describe('socket-pause (a Node internal, isolated and feature-detected)', () => {
  it(`this Node (${process.version}) exposes the handle's readStop, and the boot probe says so`, async () => {
    const { socket } = await pair();
    expect(socketReadStopSupported(socket)).toBe(true);
    await expect(probeSocketReadStop()).resolves.toBe(true);
  });

  it('the probe closes its client socket when it times out (its server never saw the connection)', async () => {
    // The probe's client is pointed at another server, which accepts and holds it, so the
    // probe's own server never sees a connection and the probe times out.
    let held: net.Socket | null = null;
    const sink = net.createServer((socket) => { held = socket; });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', () => r()));
    const sinkPort = (sink.address() as net.AddressInfo).port;
    const connect = net.connect.bind(net) as (port: number, host: string) => net.Socket;
    const spy = vi.spyOn(net, 'connect').mockImplementation(((_port: number, host: string) => connect(sinkPort, host)) as never);
    try {
      await expect(probeSocketReadStop({ timeoutMs: 200 })).resolves.toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(held).not.toBeNull();
    // The client end was destroyed by the probe: the held end sees it close.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the probe left its client socket open')), 2_000);
      const s = held as unknown as net.Socket;
      if (s.destroyed) { clearTimeout(t); resolve(); return; }
      s.once('close', () => { clearTimeout(t); resolve(); });
      s.resume();
    });
    sink.close();
  });

  it('pause() alone leaves the handle reading: the public API cannot keep bytes in the kernel', async () => {
    const { socket } = await pair();
    expect(handle(socket).reading).toBe(true);
    socket.pause();
    expect(handle(socket).reading).toBe(true);
  });

  it('stopped reads leave what the client sends in the kernel, and it is all there when reading resumes', async () => {
    const { socket, client } = await pair();
    expect(stopSocketReads(socket)).toBe(true);
    expect(handle(socket).reading).toBe(false);
    client.write('frame-before-handoff');
    await sleep(50);
    expect(socket.readableLength).toBe(0);
    // Reading again as the worker's copy of the fd does (Node's own `tryReadStart`; a
    // plain socket's `resume()` does not restart its handle): the bytes were waiting.
    const got = new Promise<string>((r) => socket.once('data', (d) => r(d.toString())));
    const h = handle(socket) as unknown as { reading: boolean; readStart(): number };
    h.reading = true;
    h.readStart();
    expect(await got).toBe('frame-before-handoff');
  });

  it('stopping a socket that is not reading is a no-op that succeeds; one with no handle cannot be stopped', async () => {
    const { socket } = await pair();
    expect(stopSocketReads(socket)).toBe(true);
    expect(stopSocketReads(socket)).toBe(true);
    const unconnected = new net.Socket();
    expect(socketReadStopSupported(unconnected)).toBe(false);
    expect(stopSocketReads(unconnected)).toBe(false);
  });

  it("a server's socket carries `server` as a writable own property, which detaching clears while `_server` (its count) stays", async () => {
    const { socket, server } = await pair();
    const s = socket as unknown as { server: unknown; _server: unknown };
    expect(s.server).toBe(server);
    expect(detachFromServer(socket)).toBe(true);
    expect(s.server).toBeNull();
    expect(s._server).toBe(server);
    // A socket whose \`server\` is not an own property (a Node that moved it): not detachable.
    expect(detachFromServer(Object.create(net.Socket.prototype) as net.Socket)).toBe(false);
  });
});

