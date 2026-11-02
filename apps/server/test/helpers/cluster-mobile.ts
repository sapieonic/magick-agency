import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

/**
 * The mobile app's side of a server running in another process tree (`cluster-server.ts`),
 * for `test/integration/cluster/mobile-stations.test.ts`: everything the app does goes
 * through the PUBLIC API and a real station upgrade, so the primary's routing, its
 * forwarding of session-owned handlers to the owning media worker, and the handoff of the
 * socket are all on the path.
 *
 * Identity is the one thing stood in for. The forked server cannot be `vi.mock`ed, so it
 * runs with `FIREBASE_AUTH_EMULATOR_HOST` pointing at {@link FakeFirebaseEmulator}:
 * `firebase-admin` then accepts unsigned ID tokens (`alg: none`, the Auth Emulator's) and
 * asks the emulator only whether the user exists and is enabled. Every other check the
 * session middleware makes (the user row, the membership, RBAC) is the real one.
 */

/** The Auth Emulator's one endpoint `verifyIdToken` uses (`accounts:lookup`). */
export class FakeFirebaseEmulator {
  private server: http.Server | null = null;
  host = '';

  constructor(readonly projectId: string) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url?.endsWith('/accounts:lookup')) {
          res.writeHead(404).end();
          return;
        }
        const ids = (JSON.parse(body || '{}') as { localId?: string[] }).localId ?? [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ kind: 'identitytoolkit#GetAccountInfoResponse', users: ids.map((localId) => ({ localId, emailVerified: true, disabled: false })) }));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.host = `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** An unsigned ID token for `uid`, as the Auth Emulator mints them. */
  tokenFor(uid: string): string {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      iss: `https://securetoken.google.com/${this.projectId}`,
      aud: this.projectId,
      sub: uid,
      user_id: uid,
      iat: now - 5,
      auth_time: now - 5,
      exp: now + 3600,
      email: `${uid}@example.com`,
      email_verified: true,
      firebase: { identities: {}, sign_in_provider: 'password' },
    })}.`;
  }
}

/** The `X-Client` the app sends: picks the mobile intervals at join. */
export const MOBILE_X_CLIENT = 'magick-agency-mobile/1.4.0+212 (android 14; Pixel 8)';

/**
 * One station socket as the app opens it (`client=mobile&media=alaw8`), with the parts of
 * the app's liveness the test needs to switch off one at a time:
 *  - `answerPings`: the WebSocket stack answering the server's RFC 6455 pings (a phone
 *    whose OS suspended the app, or whose transport died, stops answering);
 *  - `appPings`: the app's own JSON `ping` every 10 s;
 *  - `talking`: one 160-byte A-law frame every 20 ms.
 * `silence()` stops all three and leaves the TCP connection up, which is what a phone that
 * went dark looks like to the server.
 */
export class PhoneLeg {
  readonly ws: WebSocket;
  readonly frames: Array<Record<string, unknown>> = [];
  /** Binary frames heard, and how many of them were not 160 bytes. */
  heard = 0;
  heardOddSize = 0;
  /** Arrival times (ms) of the server's protocol pings. */
  readonly pingTimes: number[] = [];
  /** Last time this leg showed the server a sign of life (pong or app ping). */
  lastSignOfLife = 0;
  closed: { code: number; at: number } | null = null;
  answerPings = true;
  private appPinger: NodeJS.Timeout | null = null;
  private talker: NodeJS.Timeout | null = null;

  constructor(url: string) {
    // `autoPong: false`: the pong is this class's to send (or withhold).
    this.ws = new WebSocket(url, { autoPong: false });
    this.ws.on('ping', (data: Buffer) => {
      this.pingTimes.push(Date.now());
      if (this.answerPings && this.ws.readyState === WebSocket.OPEN) {
        this.ws.pong(data);
        this.lastSignOfLife = Date.now();
      }
    });
    this.ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.heard++;
        if (raw.length !== 160) this.heardOddSize++;
        return;
      }
      this.frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    this.ws.on('close', (code: number) => {
      this.closed = { code, at: Date.now() };
      this.stopTimers();
    });
    this.ws.on('error', () => { /* the close follows */ });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  ofEvent(event: string): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f['event'] === event);
  }

  get ready(): Record<string, unknown> | undefined {
    return this.ofEvent('ready')[0];
  }

  /** The app's JSON ping, every `ms` (the mobile cadence is 10 s). */
  startAppPings(ms = 10_000): void {
    this.stopAppPings();
    const ping = (): void => {
      if (!this.open) return;
      this.ws.send(JSON.stringify({ event: 'ping', ts: Date.now() }));
      this.lastSignOfLife = Date.now();
    };
    ping();
    this.appPinger = setInterval(ping, ms);
  }

  stopAppPings(): void {
    if (this.appPinger) clearInterval(this.appPinger);
    this.appPinger = null;
  }

  startTalking(): void {
    if (this.talker) return;
    const frame = Buffer.alloc(160, 0x55);
    this.talker = setInterval(() => { if (this.open) this.ws.send(frame, { binary: true }); }, 20);
  }

  stopTalking(): void {
    if (this.talker) clearInterval(this.talker);
    this.talker = null;
  }

  /** The phone goes dark: no pongs, no app pings, no audio; the TCP connection stays up. */
  silence(): void {
    this.answerPings = false;
    this.stopTimers();
  }

  private stopTimers(): void {
    this.stopAppPings();
    this.stopTalking();
  }

  close(): Promise<void> {
    this.stopTimers();
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.terminate();
    });
  }
}

export interface MobileAgentIdentity {
  userId: string;
  firebaseUid: string;
  tenantId: string;
  accountId: string;
}

/** An agent on the mobile app: the public API calls it makes, and its station legs. */
export class MobileAgent {
  sessionId = '';
  readonly legs: PhoneLeg[] = [];

  constructor(
    private readonly origin: string,
    private readonly emulator: FakeFirebaseEmulator,
    readonly who: MobileAgentIdentity,
  ) {}

  get leg(): PhoneLeg {
    const leg = this.legs[this.legs.length - 1];
    if (!leg) throw new Error('no station leg yet');
    return leg;
  }

  async api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${this.origin}/proxy/agency${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.emulator.tokenFor(this.who.firebaseUid)}`,
        'x-tenant-id': this.who.tenantId,
        'x-account-id': this.who.accountId,
        'x-client': MOBILE_X_CLIENT,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
  }

  private async ok(method: 'POST', path: string, body: unknown = {}): Promise<Record<string, unknown>> {
    const res = await this.api(method, path, body);
    if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  /** `POST /sessions` (runs in the primary). Returns the station URL to open. */
  async join(campaignId: string): Promise<string> {
    const body = await this.ok('POST', '/sessions', { campaign_id: campaignId });
    this.sessionId = body['session_id'] as string;
    return body['station_ws_url'] as string;
  }

  /** `POST /sessions/:id/station-token`, forwarded to the owning worker. */
  async mintStationUrl(): Promise<string> {
    return (await this.ok('POST', `/sessions/${this.sessionId}/station-token`))['station_ws_url'] as string;
  }

  /** Open a station leg on `stationUrl` (a path from the API) and wait for `ready`. */
  async connect(stationUrl: string): Promise<PhoneLeg> {
    const ws = `${this.origin.replace(/^http/, 'ws')}${stationUrl}&client=mobile&media=alaw8`;
    const leg = new PhoneLeg(ws);
    this.legs.push(leg);
    const deadline = Date.now() + 20_000;
    while (!leg.ready) {
      if (leg.closed) throw new Error(`station ${this.sessionId} closed ${leg.closed.code} before ready`);
      if (Date.now() > deadline) throw new Error(`station ${this.sessionId} not ready`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return leg;
  }

  /** What the app does on its way back: a fresh token, a fresh leg. */
  async reconnect(): Promise<PhoneLeg> {
    return this.connect(await this.mintStationUrl());
  }

  available(): Promise<Record<string, unknown>> {
    return this.ok('POST', `/sessions/${this.sessionId}/available`);
  }

  /** What the app sends the moment it is backgrounded. */
  deviceAway(): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.api('POST', `/sessions/${this.sessionId}/break`, { reason: 'device_away' });
  }

  hangup(attemptId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.api('POST', `/attempts/${attemptId}/hangup`, {});
  }

  async leave(): Promise<void> {
    await this.api('POST', `/sessions/${this.sessionId}/leave`, {}).catch(() => undefined);
    await Promise.all(this.legs.map((l) => l.close()));
  }
}
