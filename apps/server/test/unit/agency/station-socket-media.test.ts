import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// The station socket's media format (contracts `AgencyStationMediaFormat`): the
// `media=` upgrade parameter, and how the station handler routes frames by it.
//
// The routing half is the one that matters for the mobile app. An `alaw8` socket
// sends raw A-law as BINARY frames, 50 a second, and the station handler used to
// `JSON.parse` every frame and swallow the failure — so routing was decided by
// whether the bytes happened to parse. Here it is decided by `ws`'s `isBinary`:
// a binary frame is audio (the bridge's), never a control frame, even when its
// bytes are valid JSON. The bridge half is `test/unit/core/webrtc-bridge-alaw8-media.test.ts`.
// ---------------------------------------------------------------------------

const { log } = vi.hoisted(() => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({
  logger: log,
  createChildLogger: () => log,
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    masterService: { url: 'https://directory.test', s2sToken: 'tok' },
    telephony: { voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' } },
  },
}));

vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({
    isEnabled: vi.fn().mockResolvedValue(true),
    getValue: vi.fn().mockResolvedValue(1800),
  }),
  FLAGS: {
    agency_dialer_enabled: { key: 'agency_dialer_enabled', default: false },
    webrtc_max_duration_seconds: { default: 1800 },
  },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(null) },
    campaign: { findById: vi.fn() },
    contact: { findById: vi.fn(), markState: vi.fn(), unclaim: vi.fn() },
    session: {
      findById: vi.fn(),
      // The station attach's session read (it also records `client_kind`): the row `findById` gives.
      readForStationAttach: vi.fn((id: string) => repos.session.findById(id)),
      setState: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn(),
    },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAgentSessionRepository: repos.session,
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { getAllowRecording: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  webrtcCallRepository: { create: vi.fn(), findById: vi.fn(), update: vi.fn() },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class { get() { return {}; } },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

import { registerStationSocket } from '../../../src/agency/station-socket.js';
import { AgencyRuntime } from '../../../src/agency/runtime.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { browserLegMediaFormatOf } from '../../../src/core/bridge/browser-leg-media.js';

/** Shape-interpreted Redis — enough for the agent state machine to be real. */
class ShapeRedis {
  private readonly hashes = new Map<string, Record<string, string>>();
  private readonly strings = new Map<string, string>();
  async eval(script: string, _n: number, key: string, ...argv: string[]): Promise<number> {
    const h = this.hashes.get(key);
    if (script.includes('EXISTS')) return h && h.state === argv[0] ? 1 : 0;
    if (script.includes('HGET')) {
      if (!h || h.state !== argv[0]) return 0;
      this.hashes.set(key, { state: argv[1]!, attempt: argv[2] ?? '', since: argv[4] ?? '' });
      return 1;
    }
    this.hashes.set(key, { state: argv[0]!, attempt: argv[1] ?? '', since: argv[3] ?? '' });
    return 1;
  }
  async hgetall(key: string): Promise<Record<string, string>> { return this.hashes.get(key) ?? {}; }
  async set(key: string, value: string): Promise<'OK'> { this.strings.set(key, value); return 'OK'; }
  async get(key: string): Promise<string | null> { return this.strings.get(key) ?? null; }
  async del(key: string): Promise<number> {
    this.hashes.delete(key);
    return this.strings.delete(key) ? 1 : 0;
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.strings.get(k) ?? null);
  }
}

const SESSION = {
  id: 'sess-1', agent_user_id: 'u-agent', campaign_id: 'camp-1',
  tenant_id: 't1', account_id: 'a1', state: 'available', left_at: null,
};

describe('the station socket routes frames by isBinary, per its media format', () => {
  let app: FastifyInstance;
  let runtime: AgencyRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    repos.session.findById.mockResolvedValue(SESSION);
    runtime = new AgencyRuntime({} as never, new ShapeRedis() as never, '');
    vi.spyOn(runtime.tokens, 'verifyAndConsume').mockResolvedValue(true);
    await runtime.agents.set('sess-1', 'available', { leaseMs: AGENT_LEASE_MS.available });
    app = Fastify();
    await app.register(websocket);
    await app.register(async (a) => registerStationSocket(a as never, runtime), { prefix: '/api/v1/agency' });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    runtime.stopStationSweep();
    await app.close();
  });

  /** Connect, wait for `ready`, and return the client plus the server's view of the socket. */
  async function connect(query: string) {
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agency/station/sess-1?token=tok${query}`);
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (raw, isBinary) => { if (!isBinary) frames.push(JSON.parse(raw.toString())); });
    await vi.waitFor(() => expect(frames.some((f) => f['event'] === 'ready')).toBe(true));
    const server = [...app.websocketServer.clients][0]!;
    return { ws, frames, server };
  }

  /**
   * The close lines logged so far. A previous case's socket can finish closing after this
   * case has started (the close handler is async), so a case looks for its own line among
   * them rather than taking the first.
   */
  const closeLines = () => log.info.mock.calls.filter((c) => c[1] === 'Station socket closed').map((c) => c[0]);

  const pongTs = (frames: Array<Record<string, unknown>>) =>
    frames.filter((f) => f['event'] === 'pong').map((f) => f['ts']);

  it('refuses an unknown media format with 1008 before the token is consumed', async () => {
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agency/station/sess-1?token=tok&media=mulaw`);
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(1008);
    expect(runtime.tokens.verifyAndConsume).not.toHaveBeenCalled();
    expect(runtime.stations.isLocallyOwned('sess-1')).toBe(false);
  });

  it('records the socket’s format for the bridge: alaw8 when asked, pcm16 by default', async () => {
    const compact = await connect('&media=alaw8');
    expect(browserLegMediaFormatOf(compact.server as never)).toBe('alaw8');
    compact.ws.terminate();
    await vi.waitFor(() => expect(app.websocketServer.clients.size).toBe(0));

    const plain = await connect('');
    expect(browserLegMediaFormatOf(plain.server as never)).toBe('pcm16');
    plain.ws.terminate();
  });

  it.each(['alaw8', 'pcm16'] as const)(
    'on a %s socket a BINARY frame is never a control frame, even when its bytes are a valid ping',
    async (format) => {
      // FALSIFIED by routing on a failed `JSON.parse` again (drop the `isBinary` branch
      // in the station handler's listener): the binary ping parses, is answered, and
      // `pong` ts 5 appears.
      const { ws, frames } = await connect(`&media=${format}`);
      ws.send(Buffer.from(JSON.stringify({ event: 'ping', ts: 5 })), { binary: true });
      ws.send(Buffer.alloc(160, 0xd5), { binary: true }); // a frame of A-law silence
      ws.send(JSON.stringify({ event: 'ping', ts: 6 }));

      await vi.waitFor(() => expect(pongTs(frames)).toContain(6));
      // Text is answered; the binary ping was not (frames on one socket arrive in order,
      // so it had been handled before the text ping was).
      expect(pongTs(frames)).toEqual([6]);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.terminate();
    },
  );

  it('counts media in the other format and logs only the first, at debug', async () => {
    const { ws, frames } = await connect('');
    // pcm16 socket: binary audio is not its format.
    for (let i = 0; i < 3; i++) ws.send(Buffer.alloc(160, 0xd5), { binary: true });
    ws.send(JSON.stringify({ event: 'ping', ts: 1 }));
    await vi.waitFor(() => expect(pongTs(frames)).toContain(1));
    const ignored = log.debug.mock.calls.filter((c) => String(c[1]).includes('not in this socket'));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]![0]).toMatchObject({ sessionId: 'sess-1', mediaFormat: 'pcm16' });

    ws.terminate();
    await vi.waitFor(() => expect(closeLines()).toContainEqual(expect.objectContaining({ mediaFormat: 'pcm16', ignoredMediaFrames: 3 })));
  });

  it('ignores a JSON media frame on an alaw8 socket (counted), and still answers text pings', async () => {
    const { ws, frames } = await connect('&media=alaw8');
    ws.send(JSON.stringify({ event: 'media', media: { payload: Buffer.alloc(640).toString('base64') } }));
    ws.send(JSON.stringify({ event: 'ping', ts: 2 }));
    await vi.waitFor(() => expect(pongTs(frames)).toContain(2));
    ws.terminate();
    await vi.waitFor(() => expect(closeLines()).toContainEqual(expect.objectContaining({ mediaFormat: 'alaw8', ignoredMediaFrames: 1 })));
  });
});
