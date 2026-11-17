/**
 * The supervisors' side of `listen-media-load.test.ts`, in a child process of its own, so the
 * load check measures what listening costs the SERVER's loop and not the listeners' own reading
 * (in production they are browsers on other machines). Forked by the suite with `--import tsx`; it
 * speaks only over the IPC channel:
 *
 *   parent → child  { op: 'open', listenId, url, stalled, pingMs }   open a listener socket
 *                   { op: 'count', on }                               count frames into the window, or stop
 *                   { op: 'report', id }                              answer the counts so far
 *                   { op: 'terminate', listenId }                     drop the TCP connection
 *   child → parent  { op: 'up' }                                      ready for work
 *                   { op: 'ready', listenId, localPort }              the listener got `ready`
 *                   { op: 'closed', listenId, code, reason }          the listener's socket closed
 *                   { op: 'report', id, listeners }                   the counts, by listen id
 *
 * A listener counts the binary messages of each leg by their tag byte (anything not 161 bytes or
 * of an unknown tag is `odd`), keeps its text frames' events, and pings every `pingMs` as the
 * console does. A stalled one pauses its socket as `ready` arrives and never reads or writes again
 * (the parent corks the server end: see the suite's `corkServerEnd`).
 */
import WebSocket from 'ws';
import { countLeg, type LegCounts } from '../../helpers/listen-client.js';

interface Counts extends LegCounts { windowCustomer: number; windowAgent: number; events: string[] }

const listeners = new Map<string, { ws: WebSocket; counts: Counts; pinger: NodeJS.Timeout | null }>();
let counting = false;

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

function open(listenId: string, url: string, stalled: boolean, pingMs: number): void {
  const ws = new WebSocket(url);
  const counts: Counts = { customer: 0, agent: 0, odd: 0, windowCustomer: 0, windowAgent: 0, events: [] };
  const entry = { ws, counts, pinger: null as NodeJS.Timeout | null };
  listeners.set(listenId, entry);
  ws.on('error', () => { /* the close follows */ });
  ws.on('close', (code, reason) => {
    if (entry.pinger) clearInterval(entry.pinger);
    send({ op: 'closed', listenId, code, reason: reason.toString() });
  });
  ws.on('message', (raw: Buffer, isBinary) => {
    if (!isBinary) {
      const event = String((JSON.parse(raw.toString()) as { event?: unknown }).event);
      counts.events.push(event);
      if (event !== 'ready') return;
      const socket = (ws as unknown as { _socket: { pause(): void; localPort?: number } })._socket;
      if (stalled) {
        socket.pause();
      } else {
        entry.pinger = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'ping', ts: Date.now() }));
        }, pingMs);
      }
      send({ op: 'ready', listenId, localPort: socket.localPort });
      return;
    }
    const leg = countLeg(counts, raw);
    if (!counting) return;
    if (leg === 'customer') counts.windowCustomer++;
    else if (leg === 'agent') counts.windowAgent++;
  });
}

process.on('message', (m: { op: string; [k: string]: unknown }) => {
  switch (m.op) {
    case 'open': open(m['listenId'] as string, m['url'] as string, m['stalled'] as boolean, m['pingMs'] as number); break;
    case 'count': counting = m['on'] as boolean; break;
    case 'report':
      send({ op: 'report', id: m['id'], listeners: Object.fromEntries([...listeners].map(([id, l]) => [id, l.counts])) });
      break;
    case 'terminate': listeners.get(m['listenId'] as string)?.ws.terminate(); break;
  }
});
process.on('disconnect', () => process.exit(0));
send({ op: 'up' });
