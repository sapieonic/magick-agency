/**
 * The media worker's half of the upgrade handoff (`docs/scaling.md` §2.3): rebuild the
 * `IncomingMessage` the primary read, and emit `upgrade` on the worker's own (never
 * listening) HTTP server. `@fastify/websocket` then routes it through the worker's
 * Fastify instance and `ws.handleUpgrade` completes the handshake (the 101, the
 * permessage-deflate negotiation, `head` unshifted), exactly as for a socket accepted
 * here. The route's own handler runs unchanged, including the single-use station token
 * check: the primary never read it.
 */
import http from 'node:http';
import type net from 'node:net';
import type { WsHandoff } from './ipc-protocol.js';

/** Fold raw header pairs into Node's `headers` object: lower-cased, repeats joined with `, `. */
export function foldRawHeaders(rawHeaders: readonly string[]): http.IncomingHttpHeaders {
  const headers: http.IncomingHttpHeaders = {};
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    const value = rawHeaders[i + 1]!;
    const prev = headers[name];
    if (prev === undefined) headers[name] = name === 'set-cookie' ? [value] : value;
    else if (Array.isArray(prev)) prev.push(value);
    else headers[name] = `${prev}, ${value}`;
  }
  return headers;
}

/** Build the request the primary received, on the socket it handed over. */
export function rebuildUpgradeRequest(msg: WsHandoff, socket: net.Socket): http.IncomingMessage {
  const req = new http.IncomingMessage(socket);
  req.method = msg.method;
  req.url = msg.url;
  req.httpVersion = msg.httpVersion;
  const [major, minor] = msg.httpVersion.split('.').map(Number);
  req.httpVersionMajor = Number.isInteger(major) ? major! : 1;
  req.httpVersionMinor = Number.isInteger(minor) ? minor! : 1;
  req.rawHeaders = [...msg.rawHeaders];
  const headers = foldRawHeaders(msg.rawHeaders);
  // Both processes' lines for this upgrade carry the primary's request id.
  if (headers['x-request-id'] === undefined) headers['x-request-id'] = msg.requestId;
  req.headers = headers;
  return req;
}

/** Complete a handed-off upgrade on `server` (the worker's Fastify `app.server`). */
export function adoptUpgrade(server: http.Server, msg: WsHandoff, socket: net.Socket): void {
  // As for a socket this process accepted (`utils/ws-nodelay.ts`): 20 ms frames must not
  // wait on Nagle.
  socket.setNoDelay(true);
  const req = rebuildUpgradeRequest(msg, socket);
  server.emit('upgrade', req, socket, Buffer.from(msg.head, 'base64'));
}
