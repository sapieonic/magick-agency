import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { WebSocket as WsWebSocket, type RawData } from 'ws';
import type { AddressInfo } from 'node:net';

/**
 * WebSocket test harness.
 *
 * Provides a client helper and a proxy app for the station WebSocket route.
 *
 * The shape it provides is deliberately end-to-end over **real sockets** rather
 * than mocks: the things that break in a WS route are close-code propagation,
 * ordering, and back-pressure, and a mocked `ws` reproduces none of them. A
 * real server and a real client cost a few milliseconds and actually exercise
 * the protocol.
 */

/** A Fastify app with `@fastify/websocket` and the route under test mounted. */
export interface HarnessApp {
  app: FastifyInstance;
  /** ws:// origin the client connects to. */
  url: string;
  close(): Promise<void>;
}

export async function startProxyApp(
  register: (app: FastifyInstance) => Promise<void>,
  prefix: string,
): Promise<HarnessApp> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(register, { prefix });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;

  return {
    app,
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      await app.close();
    },
  };
}

/** A connected client socket with recorded frames and close details. */
export interface TestClient {
  socket: WsWebSocket;
  messages: string[];
  closed: { code: number; reason: string } | null;
  waitForMessages(n: number): Promise<void>;
  waitForClose(): Promise<{ code: number; reason: string }>;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Connect a client. Deliberately does NOT wait for `open`: a proxy that refuses
 * an upgrade closes immediately, and waiting for `open` would hang the very
 * tests that assert refusal.
 */
export function connectClient(url: string): TestClient {
  const socket = new WsWebSocket(url);
  const messages: string[] = [];
  let closed: { code: number; reason: string } | null = null;

  socket.on('message', (data: RawData) => {
    messages.push(data.toString());
  });
  socket.on('close', (code, reason) => {
    closed = { code, reason: reason?.toString() ?? '' };
  });
  // A refused upgrade surfaces as an error on some paths; recording it keeps
  // the process from dying on an unhandled 'error' event.
  socket.on('error', () => {});

  return {
    socket,
    messages,
    get closed() {
      return closed;
    },
    waitForMessages: (n) => waitFor(() => messages.length >= n, `${n} client messages`),
    waitForClose: async () => {
      await waitFor(() => closed !== null, 'client close');
      return closed!;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
}

/** Poll until `predicate` holds. Polling beats event races for "N so far" checks. */
export async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}
