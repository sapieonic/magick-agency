/**
 * A media-worker stand-in for `test/integration/cluster/ws-handoff.test.ts`: the real
 * adoption path (`IpcChannel.onHandoff` → `adoptUpgrade` → `@fastify/websocket` on a
 * Fastify instance that never listens), with the two WebSocket routes reduced to the
 * A-law passthrough relay. Each socket is greeted with where it landed.
 */
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import type net from 'node:net';
import { IpcChannel, parentTransport } from '../../src/cluster/ipc-channel.js';
import { processIdentityFromEnv } from '../../src/cluster/roles.js';
import { adoptUpgrade } from '../../src/cluster/ws-adopt.js';
import { websocketPluginOptions } from '../../src/utils/ws-limits.js';

const identity = processIdentityFromEnv(process.env);
if (identity.kind !== 'child') throw new Error('ws-handoff-child-entry needs a child role');
const slot = identity.slot;

async function main(): Promise<void> {
  const app = Fastify({ logger: false, trustProxy: (_a: string, hop: number) => hop < 1 });
  await app.register(websocket, websocketPluginOptions());
  const calls = new Map<string, { station?: WebSocket; pstn?: WebSocket }>();
  const legOf = (id: string) => { let c = calls.get(id); if (!c) { c = {}; calls.set(id, c); } return c; };
  const hello = (ws: WebSocket, route: string, req: { ip: string; url: string; headers: Record<string, unknown> }) =>
    ws.send(JSON.stringify({ event: 'hello', slot, pid: process.pid, route, ip: req.ip, url: req.url, requestId: req.headers['x-request-id'] }));

  app.get<{ Params: { sessionId: string } }>('/proxy/agency/station/:sessionId', { websocket: true }, (ws, req) => {
    const call = legOf(req.params.sessionId);
    call.station = ws;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary && call.pstn?.readyState === WebSocket.OPEN) {
        call.pstn.send(JSON.stringify({ event: 'media', media: { payload: data.toString('base64') } }));
      }
    });
    hello(ws, 'station', req);
  });
  app.get<{ Params: { id: string } }>('/api/v1/webrtc-call/:id/pstn-stream', { websocket: true }, (ws, req) => {
    const call = legOf(req.params.id);
    call.pstn = ws;
    ws.on('message', (data: Buffer) => {
      const f = JSON.parse(data.toString()) as { event?: string; media?: { payload?: string } };
      if (f.event === 'media' && f.media?.payload && call.station?.readyState === WebSocket.OPEN) {
        call.station.send(Buffer.from(f.media.payload, 'base64'), { binary: true });
      }
    });
    hello(ws, 'pstn', req);
  });
  await app.ready();

  const channel = new IpcChannel(parentTransport(), { name: `media${slot}→primary` });
  channel.onHandoff((msg, socket) => adoptUpgrade(app.server, msg, socket as net.Socket));
  channel.handle('shutdown', async () => {
    await app.close();
    setImmediate(() => process.exit(0));
    return {};
  });
  channel.onClose(() => process.exit(0));
  channel.emit('ready', { role: 'media', slot, pid: process.pid, replicaId: `test:mw${slot}:${process.pid}` });
}

void main();
