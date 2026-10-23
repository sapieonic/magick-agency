/**
 * One call as the mock VoiceLink carrier places it: the media WebSocket it dials OUT to
 * our `websocket_url`, and the lifecycle webhooks it POSTs to our `webhook_url`, driven
 * by a per-call {@link CallScript}.
 *
 * The script is a list of steps run in order, so a scenario reads the way the carrier
 * behaves: "ring, answer, open the socket, send `start`, stream 50 frames, post
 * `call.ended`, close 1000". Every step records what happened (frames received from the
 * bridge, webhook HTTP statuses, the close code and who closed) on the {@link CarrierCall}
 * so a test asserts on recorded state, never on a log line.
 *
 * A step never throws out of the run: a failure is recorded on `call.errors` and the
 * script carries on, because "the carrier kept going after our side broke" is itself the
 * behaviour under test in most fault scenarios. `done` therefore always resolves.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { alawFrame } from './audio-pattern.js';

/** One webhook body in VoiceLink's observed NESTED shape (`body.call.*`). */
export interface WebhookSpec {
  event: string;
  /** Merged over the call's own `call` object (`id`, `direction`). */
  call?: Record<string, unknown>;
  /** Replaces the whole body (flat-shape payloads, junk). */
  body?: unknown;
  /** Send this exact string instead of JSON (malformed-body scenarios). */
  raw?: string;
  /** Overrides the webhook URL's token: 'missing' strips it, any other string replaces it. */
  token?: 'missing' | string;
}

export type CallStep =
  | { do: 'webhook'; spec: WebhookSpec }
  /** Post several webhooks; `concurrent` fires them at once, otherwise in order. */
  | { do: 'webhooks'; specs: WebhookSpec[]; concurrent?: boolean }
  /**
   * Dial the media WebSocket. `token` defaults to the one in the `websocket_url`;
   * 'missing' strips it, 'wrong' substitutes a random one, any other string is used as is.
   * `callId` re-targets the path (a token presented for another call).
   */
  | { do: 'connect'; token?: 'missing' | 'wrong' | string | (() => string); callId?: string | (() => string) }
  | { do: 'start'; encoding?: string; sampleRate?: string | number; callSid?: string; streamSid?: string; omitFormat?: boolean }
  /**
   * Stream `pattern.length` paced 20 ms A-law frames (loud/quiet per bit). `frameMs` is the
   * spacing; 0 blasts them back to back. `stopIfClosed` (default true) ends early when the
   * socket goes away, as a real carrier would.
   */
  | { do: 'media'; pattern: boolean[]; frameMs?: number; stopIfClosed?: boolean }
  /** Send these frames verbatim (garbage, wrong shapes, oversized payloads). */
  | { do: 'raw'; frames: Array<string | Buffer> }
  | { do: 'stop' }
  | { do: 'close'; code?: number; reason?: string }
  /** Tear the TCP connection down with no close frame (a carrier crash / network cut). */
  | { do: 'destroy' }
  /** Stop reading from the socket (a slow / stalled carrier); the bridge's sends back up. */
  | { do: 'pauseReading' }
  | { do: 'resumeReading' }
  | { do: 'wait'; ms: number }
  /** Wait until `until(call)` holds (polled), bounded by `timeoutMs` as a deadlock guard. */
  | { do: 'waitFor'; until: (call: CarrierCall) => boolean; timeoutMs?: number; what?: string }
  /** Wait for the bridge to close the media socket. */
  | { do: 'waitForServerClose'; timeoutMs?: number };

export interface CallScript {
  /** A label for failure messages and per-outcome tallies. */
  name: string;
  steps: CallStep[];
}

/** What the lead the bridge handed the carrier said, parsed. */
export interface LeadRequest {
  did_number: string;
  customer_number: string;
  country_code: string;
  websocket_url: string;
  webhook_url: string;
}

export interface CallCloseRecord {
  /** Which connect of this call the socket was (0 = the first). */
  socket: number;
  code: number;
  reason: string;
  /** Who started the close: the carrier (a script step) or the server (the bridge). */
  by: 'carrier' | 'server';
  /** True when the TCP connection was destroyed with no close frame. */
  abrupt: boolean;
}

export interface WebhookResult {
  event: string;
  status: number;
  /** Network failure, if the POST never got a status. */
  error?: string;
}

export interface CarrierCallOptions {
  lead: LeadRequest;
  /** The carrier's own id for this call (VoiceLink `call.id`). */
  carrierCallId: string;
  /** Rewrites our public `wss://`/`https://` origin to the listening test server. */
  rewrite: (url: string) => string;
  /** Every socket this call opens, so the carrier can account for and close them. */
  sockets: Set<WebSocket>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A POST with node:http, independent of any `fetch` a test may have stubbed. */
export function postRaw(url: string, payload: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

export class CarrierCall {
  readonly lead: LeadRequest;
  readonly carrierCallId: string;
  /** Our call id, read off the `websocket_url` path the bridge built. */
  readonly callId: string;
  readonly streamSid = `MZ${randomUUID().replace(/-/g, '')}`;

  ws: WebSocket | null = null;
  /** Every frame the bridge sent on the media socket, parsed (or raw text if not JSON). */
  readonly received: unknown[] = [];
  /** Decoded A-law payloads of the bridge's `media` frames, in arrival order. */
  readonly mediaReceived: Buffer[] = [];
  /** Media frames this carrier sent (each script `media` step appends its pattern). */
  readonly mediaSentPattern: boolean[] = [];
  readonly webhookResults: WebhookResult[] = [];
  readonly errors: string[] = [];
  /** The close of the CURRENT socket (the latest connect), once it has closed. */
  close: CallCloseRecord | null = null;
  /** Every socket's close, in the order they happened. */
  readonly closes: CallCloseRecord[] = [];
  /** Did the latest upgrade complete? (`false` = refused before open, e.g. a 4xx on upgrade.) */
  opened = false;
  /** How many media sockets this call has opened. */
  connects = 0;
  /** The script's name, once run. */
  scriptName = '';

  private readonly rewrite: (url: string) => string;
  private readonly sockets: Set<WebSocket>;
  /** Per socket: did the carrier start the close, and was it a TCP destroy? */
  private readonly closeIntent = new Map<WebSocket, { requested: boolean; destroyed: boolean }>();
  private resolveDone!: () => void;
  readonly done: Promise<void>;
  private finished = false;

  constructor(opts: CarrierCallOptions) {
    this.lead = opts.lead;
    this.carrierCallId = opts.carrierCallId;
    this.rewrite = opts.rewrite;
    this.sockets = opts.sockets;
    this.callId = CarrierCall.callIdFromLead(opts.lead);
    this.done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
  }

  /** `/api/v1/webrtc-call/<id>/pstn-stream` → `<id>`; falls back to the webhook path's tail. */
  static callIdFromLead(lead: LeadRequest): string {
    try {
      const ws = new URL(lead.websocket_url);
      const m = /\/webrtc-call\/([^/]+)\/pstn-stream/.exec(ws.pathname);
      if (m) return m[1]!;
    } catch { /* fall through */ }
    try {
      const segs = new URL(lead.webhook_url).pathname.split('/').filter(Boolean);
      return segs.at(-1) ?? '';
    } catch {
      return '';
    }
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** The token in the `websocket_url` the bridge minted. */
  get providerToken(): string | null {
    try { return new URL(this.lead.websocket_url).searchParams.get('token'); } catch { return null; }
  }

  /** Statuses of every webhook POST, by event. */
  statusesFor(event: string): number[] {
    return this.webhookResults.filter((r) => r.event === event).map((r) => r.status);
  }

  async run(script: CallScript): Promise<void> {
    this.scriptName = script.name;
    try {
      for (const step of script.steps) {
        try {
          await this.runStep(step);
        } catch (err) {
          this.errors.push(`${step.do}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.finished = true;
      this.resolveDone();
    }
  }

  private async runStep(step: CallStep): Promise<void> {
    switch (step.do) {
      case 'webhook':
        await this.postWebhook(step.spec);
        return;
      case 'webhooks':
        if (step.concurrent) await Promise.all(step.specs.map((s) => this.postWebhook(s)));
        else for (const s of step.specs) await this.postWebhook(s);
        return;
      case 'connect':
        await this.connect(step.token, step.callId);
        return;
      case 'start':
        this.sendJson({
          event: 'start',
          sequence_number: '1',
          start: {
            call_sid: step.callSid ?? this.carrierCallId,
            stream_sid: step.streamSid ?? this.streamSid,
            ...(step.omitFormat ? {} : {
              media_format: {
                encoding: step.encoding ?? 'audio/alaw',
                sample_rate: String(step.sampleRate ?? '8000'),
                channels: 1,
              },
            }),
          },
        });
        return;
      case 'media':
        await this.streamMedia(step.pattern, step.frameMs ?? 20, step.stopIfClosed ?? true);
        return;
      case 'raw':
        for (const f of step.frames) this.sendRaw(f);
        return;
      case 'stop':
        this.sendJson({ event: 'stop', stream_sid: this.streamSid, stop: { call_sid: this.carrierCallId } });
        return;
      case 'close':
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.closeIntent.set(this.ws, { requested: true, destroyed: false });
          this.ws.close(step.code ?? 1000, step.reason ?? '');
          await this.waitClosed(DEFAULT_WAIT_TIMEOUT_MS);
        }
        return;
      case 'destroy':
        if (this.ws) {
          this.closeIntent.set(this.ws, { requested: true, destroyed: true });
          this.ws.terminate();
          await this.waitClosed(DEFAULT_WAIT_TIMEOUT_MS);
        }
        return;
      case 'pauseReading':
        this.rawSocket()?.pause();
        return;
      case 'resumeReading':
        this.rawSocket()?.resume();
        return;
      case 'wait':
        await sleep(step.ms);
        return;
      case 'waitFor': {
        const deadline = Date.now() + (step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
        while (!step.until(this)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${step.what ?? 'condition'}`);
          await sleep(10);
        }
        return;
      }
      case 'waitForServerClose':
        await this.waitClosed(step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
        return;
    }
  }

  private rawSocket(): { pause(): void; resume(): void } | null {
    return (this.ws as unknown as { _socket?: { pause(): void; resume(): void } } | null)?._socket ?? null;
  }

  private async waitClosed(timeoutMs: number): Promise<void> {
    if (!this.ws) return;
    const deadline = Date.now() + timeoutMs;
    while (this.ws.readyState !== WebSocket.CLOSED) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the media socket to close');
      await sleep(10);
    }
  }

  private connect(
    tokenArg: 'missing' | 'wrong' | string | (() => string) | undefined,
    callIdArg: string | (() => string) | undefined,
  ): Promise<void> {
    const token = typeof tokenArg === 'function' ? tokenArg() : tokenArg;
    const callId = typeof callIdArg === 'function' ? callIdArg() : callIdArg;
    const url = new URL(this.rewrite(this.lead.websocket_url));
    if (callId) url.pathname = url.pathname.replace(/\/webrtc-call\/[^/]+\//, `/webrtc-call/${callId}/`);
    if (token === 'missing') url.searchParams.delete('token');
    else if (token === 'wrong') url.searchParams.set('token', randomUUID());
    else if (token !== undefined) url.searchParams.set('token', token);

    const ws = new WebSocket(url.toString());
    const index = this.connects++;
    this.ws = ws;
    this.opened = false;
    this.close = null;
    this.closeIntent.set(ws, { requested: false, destroyed: false });
    this.sockets.add(ws);
    ws.on('message', (data, isBinary) => {
      const text = isBinary ? Buffer.from(data as Buffer).toString('utf8') : data.toString();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      this.received.push(parsed);
      const frame = parsed as { event?: string; media?: { payload?: unknown } };
      if (frame?.event === 'media' && typeof frame.media?.payload === 'string') {
        this.mediaReceived.push(Buffer.from(frame.media.payload, 'base64'));
      }
    });
    ws.on('close', (code, reason) => {
      this.sockets.delete(ws);
      const intent = this.closeIntent.get(ws) ?? { requested: false, destroyed: false };
      const record: CallCloseRecord = {
        socket: index,
        code,
        reason: reason.toString(),
        by: intent.requested ? 'carrier' : 'server',
        abrupt: intent.destroyed || code === 1006,
      };
      this.closes.push(record);
      if (ws === this.ws) this.close = record;
    });
    ws.on('error', (err) => { this.errors.push(`ws: ${err.message}`); });
    return new Promise<void>((resolve) => {
      ws.once('open', () => { if (ws === this.ws) this.opened = true; resolve(); });
      // A refused upgrade never opens; the close/error handlers above record it.
      ws.once('close', () => resolve());
    });
  }

  private sendJson(frame: unknown): void {
    this.sendRaw(JSON.stringify(frame));
  }

  private sendRaw(frame: string | Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.errors.push('send on a socket that is not open');
      return;
    }
    this.ws.send(frame);
  }

  private async streamMedia(pattern: boolean[], frameMs: number, stopIfClosed: boolean): Promise<void> {
    // A monotonic schedule (frame k at t0 + k·frameMs), the way a carrier paces RTP —
    // not sleep-per-frame, which drifts under load.
    const t0 = performance.now();
    for (let k = 0; k < pattern.length; k++) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        if (stopIfClosed) return;
        this.errors.push('media frame on a closed socket');
        continue;
      }
      const index = this.mediaSentPattern.length;
      const loud = pattern[k]!;
      this.ws.send(JSON.stringify({
        event: 'media',
        sequence_number: String(index + 2),
        stream_sid: this.streamSid,
        media: { track: 'inbound', chunk: String(index + 1), timestamp: String(index * 20), payload: alawFrame(index, loud).toString('base64') },
      }));
      this.mediaSentPattern.push(loud);
      if (frameMs > 0) {
        const due = t0 + (k + 1) * frameMs;
        const wait = due - performance.now();
        if (wait > 0) await sleep(wait);
      } else if (k % 50 === 49) {
        await sleep(0); // let the loop breathe when blasting
      }
    }
  }

  private async postWebhook(spec: WebhookSpec): Promise<void> {
    const url = new URL(this.rewrite(this.lead.webhook_url));
    if (spec.token === 'missing') url.searchParams.delete('token');
    else if (spec.token !== undefined) url.searchParams.set('token', spec.token);
    const payload = spec.raw ?? JSON.stringify(spec.body ?? {
      event: spec.event,
      timestamp: new Date().toISOString(),
      call: { id: this.carrierCallId, direction: 'outbound', ...spec.call },
    });
    try {
      const status = await postRaw(url.toString(), payload);
      this.webhookResults.push({ event: spec.event, status });
    } catch (err) {
      this.webhookResults.push({ event: spec.event, status: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
