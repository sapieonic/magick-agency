/**
 * One call as the mock Plivo carrier places it, driven by a per-call {@link PlivoCallScript}.
 *
 * Plivo runs a call the other way round from its REST API: once the create-call is
 * accepted it POSTs form-encoded, V3-signed callbacks to the URLs our dial named (ring and
 * hangup to `ring_url` / `hangup_url`, answer to `answer_url`), executes the XML our answer
 * callback returns, opens the media WebSocket that XML's `<Stream>` names, and later posts
 * the `<Record callbackUrl>`. A script is the list of those steps in order, so a scenario
 * reads the way the carrier behaves: "ring, answer (fetch the XML), connect the stream,
 * `start`, 25 μ-law frames, wait for our REST hangup, post the recording".
 *
 * Every step records what happened (each callback's HTTP status and body, the answer XML
 * and what was parsed out of it, the frames the bridge sent back, the close) on the call,
 * so a test asserts on recorded state. A step never throws out of the run: a failure is
 * recorded on `errors` and the script carries on. `done` always resolves.
 */
import http from 'node:http';
import querystring from 'node:querystring';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { mulawFrame } from '../voicelink/audio-pattern.js';
import { plivoNonce, signPlivoCallback } from './signature.js';

/** The create-call body the adapter sent (`POST /v1/Account/{id}/Call/`). */
export interface PlivoDialRequest {
  from: string;
  to: string;
  answer_url: string;
  answer_method?: string;
  hangup_url: string;
  hangup_method?: string;
  ring_url?: string;
  ring_method?: string;
  time_limit?: number;
  ring_timeout?: number;
}

/**
 * How a callback is signed. `valid` (the default): with the account's CURRENT auth token
 * over the exact URL Plivo was given. `none`: no signature headers. `{ token }`: with that
 * token instead (another account's, a rotated-out one). `{ url }`: over another URL.
 */
export type SignMode = 'valid' | 'none' | { token: string } | { url: string };

export type CallbackTarget = 'answer' | 'ring' | 'hangup' | 'recording';

export type PlivoCallStep =
  /** `ring_url`: `CallStatus=ringing`. */
  | { do: 'ring'; sign?: SignMode }
  /**
   * Plivo takes the call out of its queue and hands it to the network, posting nothing:
   * from here a cancel by request id answers 404, and only the call id (named on the
   * next callback) can hang it up.
   */
  | { do: 'dequeue' }
  /** `answer_url`: `CallStatus=in-progress`; the reply is kept and its `<Stream>` / `<Record>` parsed. */
  | { do: 'answer'; sign?: SignMode }
  /** `hangup_url`: a terminal `CallStatus` (default `completed`). */
  | { do: 'hangup'; status?: PlivoTerminalStatus; cause?: string; source?: string; sign?: SignMode }
  /** The `<Record callbackUrl>` from the answer XML. */
  | { do: 'recording'; recordingId?: string; sign?: SignMode }
  /** Any callback with these params (merged over the call's own), e.g. a forged or stale one. */
  | { do: 'post'; to: CallbackTarget; params?: Record<string, string>; sign?: SignMode; token?: string }
  /** Open the media WebSocket the answer XML named (rewritten to the server under test). */
  | { do: 'connect' }
  | { do: 'start'; encoding?: string; sampleRate?: number }
  /** Paced 20 ms μ-law frames, loud/quiet per bit; `frameMs` 0 blasts them. */
  | { do: 'media'; pattern: boolean[]; frameMs?: number }
  | { do: 'stop' }
  | { do: 'close'; code?: number }
  | { do: 'wait'; ms: number }
  | { do: 'waitFor'; until: (call: PlivoCall) => boolean; timeoutMs?: number; what?: string }
  | { do: 'waitForServerClose'; timeoutMs?: number };

export type PlivoTerminalStatus = 'completed' | 'busy' | 'failed' | 'timeout' | 'no-answer' | 'cancel';

export interface PlivoCallScript {
  name: string;
  steps: PlivoCallStep[];
}

export interface CallbackResult {
  to: CallbackTarget;
  /** `CallStatus` sent, or the step kind for a recording. */
  what: string;
  status: number;
  contentType: string;
  body: string;
  error?: string;
}

export interface PlivoCallOptions {
  request: PlivoDialRequest;
  requestUuid: string;
  authId: string;
  /** The account's auth token as it is NOW (rotation changes it). */
  authToken: () => string;
  rewrite: (url: string) => string;
  sockets: Set<WebSocket>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const xmlUnescape = (s: string): string => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** A form POST with node:http, independent of any `fetch` a test may have stubbed. */
function postForm(url: string, params: Record<string, string>, headers: Record<string, string>): Promise<{ status: number; contentType: string; body: string }> {
  const payload = querystring.stringify(params);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(payload),
        'user-agent': 'PlivoHTTP/1.0 (mock)',
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        contentType: String(res.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

export class PlivoCall {
  readonly request: PlivoDialRequest;
  readonly requestUuid: string;
  /** Plivo's `CallUUID`: named to us on the first callback. */
  readonly callUuid = randomUUID();
  readonly streamId = randomUUID();
  /** Our call id, read off the answer URL's path. */
  readonly callId: string;

  /** The answer callback's reply, verbatim. */
  answerXml: string | null = null;
  /** The `<Stream>` URL parsed out of the answer XML (XML-unescaped). */
  streamUrl: string | null = null;
  /** The `<Record callbackUrl>` parsed out of the answer XML. */
  recordCallbackUrl: string | null = null;
  /** True once the carrier has sent a callback naming `callUuid` (our REST hangup may now name it). */
  named = false;
  answered = false;
  /** Set when the call ended at the carrier (a hangup callback was sent, or our REST hung it up). */
  ended = false;
  /** Our REST cancel (`DELETE …/Request/{request_uuid}/`) reached this call. */
  canceledByApi = false;
  /** Out of Plivo's queue (a `dequeue` step): a cancel by request id is 404 from here. */
  dequeued = false;
  /** Every cancel by request id that reached this call, with the status it was answered. */
  readonly cancelAttempts: number[] = [];
  /** Our REST hangup (`DELETE …/Call/{call_uuid}/`) reached this call. */
  hungUpByApi = false;

  ws: WebSocket | null = null;
  opened = false;
  /** Every frame the bridge sent on the media socket, parsed. */
  readonly received: Array<Record<string, unknown>> = [];
  /** Decoded μ-law payloads of the bridge's `playAudio` frames, in order. */
  readonly playAudio: Buffer[] = [];
  readonly mediaSentPattern: boolean[] = [];
  readonly callbacks: CallbackResult[] = [];
  readonly errors: string[] = [];
  closeCode: number | null = null;
  closedBy: 'carrier' | 'server' | null = null;
  scriptName = '';

  private readonly authId: string;
  private readonly authToken: () => string;
  private readonly rewrite: (url: string) => string;
  private readonly sockets: Set<WebSocket>;
  private closeRequested = false;
  private resolveDone!: () => void;
  readonly done: Promise<void>;

  constructor(opts: PlivoCallOptions) {
    this.request = opts.request;
    this.requestUuid = opts.requestUuid;
    this.authId = opts.authId;
    this.authToken = opts.authToken;
    this.rewrite = opts.rewrite;
    this.sockets = opts.sockets;
    this.callId = PlivoCall.callIdFromUrl(opts.request.answer_url);
    this.done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
  }

  /** `…/webrtc-answer/<id>?…` → `<id>`. */
  static callIdFromUrl(url: string): string {
    try {
      return new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
    } catch {
      return '';
    }
  }

  /** The statuses of every callback to `to`, in order. */
  statusesFor(to: CallbackTarget): number[] {
    return this.callbacks.filter((c) => c.to === to).map((c) => c.status);
  }

  async run(script: PlivoCallScript): Promise<void> {
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
      this.resolveDone();
    }
  }

  private baseParams(): Record<string, string> {
    return {
      CallUUID: this.callUuid,
      RequestUUID: this.requestUuid,
      From: this.request.from,
      To: this.request.to,
      Direction: 'outbound',
      CallerName: '',
      ALegUUID: this.callUuid,
      ALegRequestUUID: this.requestUuid,
    };
  }

  private targetUrl(to: CallbackTarget): string {
    switch (to) {
      case 'answer': return this.request.answer_url;
      case 'ring': return this.request.ring_url ?? this.request.hangup_url;
      case 'hangup': return this.request.hangup_url;
      case 'recording':
        if (!this.recordCallbackUrl) throw new Error('no <Record callbackUrl> in the answer XML');
        return this.recordCallbackUrl;
    }
  }

  /** POST one callback as Plivo does: form params, V3-signed over the public URL. */
  async callback(to: CallbackTarget, params: Record<string, string>, sign: SignMode = 'valid', tokenOverride?: string): Promise<CallbackResult> {
    // The URL exactly as our dial (or answer XML) wrote it: Plivo signs what it was handed,
    // so it is never re-serialised (`URL` would lower-case the host and drop a `:443`).
    let url = this.targetUrl(to);
    if (tokenOverride !== undefined) {
      const publicUrl = new URL(url);
      publicUrl.searchParams.set('token', tokenOverride);
      url = publicUrl.toString();
    }
    const headers: Record<string, string> = {};
    if (sign !== 'none') {
      const nonce = plivoNonce();
      const token = typeof sign === 'object' && 'token' in sign ? sign.token : this.authToken();
      const signedUrl = typeof sign === 'object' && 'url' in sign ? sign.url : url;
      headers['X-Plivo-Signature-V3'] = signPlivoCallback(token, signedUrl, params, nonce);
      headers['X-Plivo-Signature-V3-Nonce'] = nonce;
    }
    const what = params['CallStatus'] ?? to;
    let result: CallbackResult;
    try {
      const res = await postForm(this.rewrite(url), params, headers);
      result = { to, what, ...res };
    } catch (err) {
      result = { to, what, status: 0, contentType: '', body: '', error: err instanceof Error ? err.message : String(err) };
    }
    this.callbacks.push(result);
    return result;
  }

  /** The terminal callback Plivo posts to `hangup_url`. Used by script steps and by the carrier on a REST hangup or cancel. */
  async postHangup(status: PlivoTerminalStatus, opts: { cause?: string; source?: string; sign?: SignMode } = {}): Promise<CallbackResult> {
    this.ended = true;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const answered = this.answered && status === 'completed';
    const cause = opts.cause ?? (status === 'completed' ? 'NORMAL_CLEARING' : status === 'busy' ? 'USER_BUSY'
      : status === 'cancel' ? 'ORIGINATOR_CANCEL' : status === 'no-answer' || status === 'timeout' ? 'NO_ANSWER' : 'CALL_REJECTED');
    this.named = true;
    return this.callback('hangup', {
      ...this.baseParams(),
      CallStatus: status,
      Event: 'Hangup',
      HangupCause: cause,
      HangupCauseName: cause.toLowerCase().split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' '),
      HangupCauseCode: status === 'completed' ? '4000' : '3000',
      HangupSource: opts.source ?? (this.hungUpByApi || this.canceledByApi ? 'API Request' : 'Callee'),
      Duration: answered ? String(Math.max(1, Math.round(this.mediaSentPattern.length * 0.02))) : '0',
      BillDuration: answered ? '60' : '0',
      StartTime: now,
      AnswerTime: answered ? now : '',
      EndTime: now,
    }, opts.sign);
  }

  private async runStep(step: PlivoCallStep): Promise<void> {
    switch (step.do) {
      case 'ring':
        this.named = true;
        await this.callback('ring', { ...this.baseParams(), CallStatus: 'ringing', Event: 'Ring' }, step.sign);
        return;
      case 'dequeue':
        this.dequeued = true;
        return;
      case 'answer': {
        this.named = true;
        this.answered = true;
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const res = await this.callback('answer', { ...this.baseParams(), CallStatus: 'in-progress', Event: 'StartApp', AnswerTime: now }, step.sign);
        this.answerXml = res.body;
        const stream = /<Stream\b[^>]*>([^<]*)<\/Stream>/.exec(res.body);
        this.streamUrl = stream ? xmlUnescape(stream[1]!.trim()) : null;
        const record = /<Record\b[^>]*\bcallbackUrl="([^"]*)"/.exec(res.body);
        this.recordCallbackUrl = record ? xmlUnescape(record[1]!) : null;
        return;
      }
      case 'hangup':
        await this.postHangup(step.status ?? 'completed', { ...(step.cause ? { cause: step.cause } : {}), ...(step.source ? { source: step.source } : {}), ...(step.sign ? { sign: step.sign } : {}) });
        return;
      case 'recording': {
        const id = step.recordingId ?? randomUUID();
        await this.callback('recording', {
          CallUUID: this.callUuid,
          RecordUrl: `https://media.plivo.com/v1/Account/${this.authId}/Recording/${id}.mp3`,
          RecordingID: id,
          RecordingDuration: String(Math.max(1, Math.round(this.mediaSentPattern.length * 0.02))),
          RecordingDurationMs: String(this.mediaSentPattern.length * 20),
          RecordingStartMs: String(Date.now() - this.mediaSentPattern.length * 20),
          RecordingEndMs: String(Date.now()),
        }, step.sign);
        return;
      }
      case 'post':
        await this.callback(step.to, { ...this.baseParams(), ...step.params }, step.sign, step.token);
        return;
      case 'connect':
        await this.connect();
        return;
      case 'start':
        this.sendJson({
          event: 'start',
          sequenceNumber: 0,
          start: {
            callId: this.callUuid,
            streamId: this.streamId,
            accountId: this.authId,
            tracks: ['inbound'],
            mediaFormat: { encoding: step.encoding ?? 'audio/x-mulaw', sampleRate: step.sampleRate ?? 8000 },
          },
        });
        return;
      case 'media':
        await this.streamMedia(step.pattern, step.frameMs ?? 20);
        return;
      case 'stop':
        this.sendJson({ event: 'stop', sequenceNumber: this.mediaSentPattern.length + 1, streamId: this.streamId });
        return;
      case 'close':
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.closeRequested = true;
          this.ws.close(step.code ?? 1000);
          await this.waitClosed(DEFAULT_WAIT_TIMEOUT_MS);
        }
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

  /** Close the media socket from the carrier's side (a REST hangup ends the stream). */
  closeMedia(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.closeRequested = true;
      this.ws.close(1000);
    }
  }

  private async waitClosed(timeoutMs: number): Promise<void> {
    if (!this.ws) return;
    const deadline = Date.now() + timeoutMs;
    while (this.ws.readyState !== WebSocket.CLOSED) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the media socket to close');
      await sleep(10);
    }
  }

  private connect(): Promise<void> {
    if (!this.streamUrl) return Promise.reject(new Error('no <Stream> URL: the answer XML named none'));
    const ws = new WebSocket(this.rewrite(this.streamUrl));
    this.ws = ws;
    this.opened = false;
    this.sockets.add(ws);
    ws.on('message', (data, isBinary) => {
      const text = isBinary ? Buffer.from(data as Buffer).toString('utf8') : data.toString();
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(text) as Record<string, unknown>; } catch { return; }
      this.received.push(frame);
      const media = frame['media'] as { payload?: unknown; contentType?: unknown } | undefined;
      if (frame['event'] === 'playAudio' && typeof media?.payload === 'string') {
        this.playAudio.push(Buffer.from(media.payload, 'base64'));
      }
    });
    ws.on('close', (code) => {
      this.sockets.delete(ws);
      this.closeCode = code;
      this.closedBy = this.closeRequested ? 'carrier' : 'server';
    });
    ws.on('error', (err) => { this.errors.push(`ws: ${err.message}`); });
    return new Promise<void>((resolve) => {
      ws.once('open', () => { this.opened = true; resolve(); });
      ws.once('close', () => resolve());
    });
  }

  private sendJson(frame: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.errors.push('send on a socket that is not open');
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }

  private async streamMedia(pattern: boolean[], frameMs: number): Promise<void> {
    const t0 = performance.now();
    for (let k = 0; k < pattern.length; k++) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const index = this.mediaSentPattern.length;
      const loud = pattern[k]!;
      this.ws.send(JSON.stringify({
        event: 'media',
        sequenceNumber: index + 1,
        streamId: this.streamId,
        media: { track: 'inbound', timestamp: String(index * 20), chunk: index + 1, payload: mulawFrame(index, loud).toString('base64') },
      }));
      this.mediaSentPattern.push(loud);
      if (frameMs > 0) {
        const wait = t0 + (k + 1) * frameMs - performance.now();
        if (wait > 0) await sleep(wait);
      }
    }
  }
}
