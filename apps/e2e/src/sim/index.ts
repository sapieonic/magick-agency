/**
 * The simulator: one HTTP server standing in for every vendor the server and the console talk
 * to, plus `/_sim/*`, the control API specs use to script the "customer" and read what the
 * vendors received.
 *
 *   /identitytoolkit.googleapis.com/*, /securetoken.googleapis.com/*   fake Firebase Auth (the browser, and
 *                                                                     firebase-admin's emulator-mode lookups)
 *   /s3/<bucket>/<key>                                                fake S3
 *   /mailjet/v3.1/send                                                Mailjet mailbox
 *   /recordings/<path>                                                the recording host
 *   /openai/v1/chat/completions, /gemini/*                            AI endpoints
 *   /_sim/*                                                           control
 *
 * VoiceLink runs on a port of its own (the server's own test mock); its base URL is in
 * `GET /_sim/health` and goes into the server's `VOICELINK_BASE_URL`.
 */
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { FakeFirebaseAuth } from './firebase-auth.js';
import { FakeS3 } from './s3.js';
import { Mailbox, handleChatCompletion, handleGemini, recordingWav } from './vendors.js';
import { VoicelinkSim, type PersonaName, PERSONA_BY_SUFFIX, normaliseNumber } from './voicelink.js';

export interface SimOptions {
  port: number;
  host?: string;
  projectId: string;
  voicelink: { username: string; password: string };
  /** The server's loopback origin, where carrier webhooks and media sockets go. */
  serverOrigin: string;
}

const PERSONAS = new Set<PersonaName>(['answer', 'busy', 'no_answer', 'failed', 'answer_then_hangup', 'silent']);

export class Simulator {
  readonly firebase: FakeFirebaseAuth;
  readonly s3 = new FakeS3();
  readonly mail = new Mailbox();
  readonly voicelink: VoicelinkSim;
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();
  private port = 0;

  constructor(private readonly opts: SimOptions) {
    this.firebase = new FakeFirebaseAuth(opts.projectId);
    this.voicelink = new VoicelinkSim({ ...opts.voicelink, serverOrigin: () => opts.serverOrigin });
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    await this.voicelink.start();
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
    });
    server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host ?? '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await this.voicelink.stop();
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    for (const sock of this.sockets) sock.destroy();
    await new Promise<void>((r) => s.close(() => r()));
  }

  reset(): void {
    this.voicelink.reset();
    this.mail.reset();
    this.s3.reset();
    // Firebase accounts stay: a reset between specs must not sign every seeded user out.
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://sim.local');
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(payload));
    };
    const bodyJson = (): Record<string, unknown> => {
      try { return raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {}; } catch { return {}; }
    };

    if (this.firebase.handle(path, raw.toString('utf8'), String(req.headers['content-type'] ?? ''), res, req)) return;
    if (path.startsWith('/s3/') || path === '/s3') return this.s3.handle(method, url, raw, req.headers, res);
    if (path === '/mailjet/v3.1/send') return this.mail.handleSend(raw.toString('utf8'), res);
    if (path.startsWith('/recordings/')) {
      const wav = recordingWav();
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wav.length) });
      res.end(method === 'HEAD' ? undefined : wav);
      return;
    }
    if (path.startsWith('/openai/') && path.endsWith('/chat/completions')) return handleChatCompletion(res);
    if (path.startsWith('/gemini/')) return handleGemini(method, url, this.origin, res);

    // ── control ──
    if (path === '/_sim/health') {
      return json(200, { ok: true, voicelinkBaseUrl: this.voicelink.baseUrl, personas: PERSONA_BY_SUFFIX });
    }
    if (path === '/_sim/reset' && method === 'POST') {
      this.reset();
      return json(200, { ok: true });
    }
    if (path === '/_sim/firebase/users' && method === 'POST') {
      const b = bodyJson();
      const user = this.firebase.upsertUser(String(b['email']), String(b['password']), b['displayName'] ? String(b['displayName']) : undefined);
      return json(200, { localId: user.localId, email: user.email });
    }
    if (path === '/_sim/firebase/token' && method === 'POST') {
      const b = bodyJson();
      // With a password, the user is registered (or their password set) first; without one, the
      // user must already be registered, and their password is left as it is.
      const user = b['password'] !== undefined
        ? this.firebase.upsertUser(String(b['email']), String(b['password']))
        : this.firebase.userByEmail(String(b['email']));
      if (!user) return json(404, { error: `no fake Firebase user ${String(b['email'])}` });
      return json(200, { idToken: this.firebase.idToken(user) });
    }
    if (path === '/_sim/calls' && method === 'GET') {
      const number = url.searchParams.get('number');
      return json(200, { calls: number ? this.voicelink.callsTo(number) : this.voicelink.calls });
    }
    if (path === '/_sim/calls/hangup-all' && method === 'POST') {
      return json(200, { hungUp: await this.voicelink.hangupAll() });
    }
    const hangup = /^\/_sim\/calls\/([^/]+)\/hangup$/.exec(path);
    if (hangup && method === 'POST') {
      const ok = this.voicelink.hangup(decodeURIComponent(hangup[1]!));
      return json(ok ? 200 : 404, { ok });
    }
    if (path === '/_sim/personas' && method === 'POST') {
      const b = bodyJson();
      const persona = String(b['persona']) as PersonaName;
      if (!PERSONAS.has(persona)) return json(400, { error: `unknown persona ${persona}` });
      this.voicelink.overrides.set(normaliseNumber(String(b['number'])), {
        name: persona,
        ...(typeof b['ringMs'] === 'number' ? { ringMs: b['ringMs'] } : {}),
        ...(typeof b['talkMs'] === 'number' ? { talkMs: b['talkMs'] } : {}),
      });
      return json(200, { ok: true });
    }
    if (path === '/_sim/personas' && method === 'DELETE') {
      this.voicelink.overrides.clear();
      return json(200, { ok: true });
    }
    if (path === '/_sim/mail' && method === 'GET') {
      const to = url.searchParams.get('to');
      return json(200, { messages: to ? this.mail.to(to) : this.mail.sent });
    }
    if (path === '/_sim/s3' && method === 'GET') {
      return json(200, { keys: this.s3.keys(url.searchParams.get('bucket') ?? 'e2e-bucket') });
    }
    if (path === '/_sim/carrier/requests' && method === 'GET') {
      return json(200, {
        requests: this.voicelink.carrier.requests.map((r) => ({ route: r.route, status: r.status, body: r.route === 'add_lead' ? r.body : undefined })),
      });
    }
    json(404, { error: `e2e sim: nothing at ${method} ${path}` });
  }
}
