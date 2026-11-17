import WebSocket from 'ws';
import type pg from 'pg';
import { AGENCY_LISTEN_LEG, AGENCY_LISTEN_MESSAGE_BYTES } from '@magick-agency/contracts/agency';

/*
 * A supervisor's listener socket as the integration suites drive it (live-listen-e2e, the cluster's
 * live-listen, the Plivo listen e2e, the load clients): open a grant's socket, keep its JSON
 * frames, count each leg's audio messages by their tag byte, and read the listen session's row.
 */

/** Audio messages by leg; `odd`: anything not a 161-byte message tagged customer or agent. */
export interface LegCounts {
  customer: number;
  agent: number;
  odd: number;
}

/** Count one binary listener message into `legs`, and say which it was. */
export function countLeg(legs: LegCounts, raw: Buffer): keyof LegCounts {
  const leg = raw.length !== AGENCY_LISTEN_MESSAGE_BYTES ? 'odd'
    : raw[0] === AGENCY_LISTEN_LEG.customer ? 'customer'
      : raw[0] === AGENCY_LISTEN_LEG.agent ? 'agent'
        : 'odd';
  legs[leg]++;
  return leg;
}

export interface ListenClient {
  ws: WebSocket;
  /** The JSON frames, in order (`ready`, `pong`, `ended`). */
  frames: Array<Record<string, unknown>>;
  legs: LegCounts;
  closed: { code: number; reason: string } | null;
  listenId: string;
}

/**
 * Open the listener socket of `grant` (`POST /live-calls/:callId/listen`'s answer) on the server at
 * `origin` (`http://host:port`) and record what arrives. The caller waits for `ready`.
 */
export function openListener(origin: string, grant: { listen_id: string; ws_url: string }): ListenClient {
  const l: ListenClient = {
    ws: new WebSocket(`${origin.replace('http', 'ws')}${grant.ws_url}`),
    frames: [],
    legs: { customer: 0, agent: 0, odd: 0 },
    closed: null,
    listenId: grant.listen_id,
  };
  l.ws.on('message', (raw: Buffer, isBinary) => {
    if (isBinary) countLeg(l.legs, raw);
    else l.frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });
  l.ws.on('close', (code, reason) => { l.closed = { code, reason: reason.toString() }; });
  l.ws.on('error', () => { /* the close follows */ });
  return l;
}

/** A listen session row (`agency_listen_sessions`). */
export interface ListenRow {
  id: string;
  replica_id: string;
  ended_at: Date | null;
  end_reason: string | null;
  frames_sent: number;
  frames_dropped: number;
  origin: string;
  correlation_id: string;
  campaign_id: string | null;
  listener_user_id: string;
  agent_user_id: string;
}

/** Which row: one listen's, or the newest of a call's. */
export type ListenRowKey = { listenId: string } | { callId: string };

/** The row, or undefined while there is none. */
export async function listenRow(pool: pg.Pool, key: ListenRowKey): Promise<ListenRow | undefined> {
  const { rows } = 'listenId' in key
    ? await pool.query<ListenRow>('SELECT * FROM agency_listen_sessions WHERE id = $1', [key.listenId])
    : await pool.query<ListenRow>(
      'SELECT * FROM agency_listen_sessions WHERE call_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1', [key.callId]);
  return rows[0];
}

/**
 * The row once it is closed (with `reason`, when given), polled: the listen's end closes its row
 * after the socket's close frame, by design, so a test that saw the close waits for the row.
 */
export async function closedRow(pool: pg.Pool, key: ListenRowKey, reason?: string, timeoutMs = 15_000): Promise<ListenRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await listenRow(pool, key);
    if (row?.ended_at && (reason === undefined || row.end_reason === reason)) return row;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the listen row ${JSON.stringify(key)} closed${reason ? ` ${reason}` : ''}: ${JSON.stringify(row)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
