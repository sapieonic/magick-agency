import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Send back-pressure on the bridge's two legs (`src/utils/ws-backpressure.ts`).
//
// The bridge writes the customer's audio to the agent's station socket (the borrowed
// browser leg) and the agent's audio to the carrier, 50 frames a second each way, with
// a synchronous `ws.send` that never refuses. A peer that stops reading used to be
// buffered in server memory for the length of the call. What is pinned here:
//
//  - media to a station past its soft limit (about 3 s of the leg's own audio: 128 KiB
//    on `pcm16`, 24 KiB on `alaw8`) is dropped, counted on the session and reported on
//    the call's end line (`droppedBrowserMediaFrames`); at the limit it is still sent;
//  - control frames (`status`, `ended`) are never dropped for back-pressure;
//  - past the station's hard cap (1 MiB) the station is closed 4408
//    `station_send_backlog`, once, and nothing more is written to it;
//  - media to the carrier past its soft limit (40 KiB) is dropped and counted
//    (`droppedPstnMediaFrames`), and the carrier's stream is NEVER closed for it:
//    closing VoiceLink's media stream hangs the call up.
//
// Mock harness mirrors webrtc-bridge-alaw8-media.test.ts (project convention: no shared
// test utilities).
// ---------------------------------------------------------------------------

const { bridgeLog, metrics } = vi.hoisted(() => ({
  bridgeLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  metrics: { backpressure: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => bridgeLog,
}));
vi.mock('@magick-agency/observability/metrics/voice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability/metrics/voice')>()),
  trackWebsocketSendBackpressure: metrics.backpressure,
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' } },
  },
}));

const { mockRepo } = vi.hoisted(() => ({
  mockRepo: { create: vi.fn(), findById: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({ webrtcCallRepository: mockRepo }));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() {
      return {
        capabilities: { cancelRinging: false, queuesOutboundDials: true },
        initiateCall: vi.fn().mockResolvedValue({ providerCallId: 'pcid-1' }),
        endCall: vi.fn().mockResolvedValue(undefined),
      };
    }
  },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import { setBrowserLegMediaFormat, type BrowserLegMediaFormat } from '../../../src/core/bridge/browser-leg-media.js';
import {
  CARRIER_MEDIA_LIMITS,
  STATION_ALAW8_LIMITS,
  STATION_PCM16_LIMITS,
  STATION_SEND_BACKLOG_REASON,
  STATION_SEND_HARD_CAP_BYTES,
} from '../../../src/utils/ws-backpressure.js';
import { AGENCY_STATION_CLOSE } from '@magick-agency/contracts/agency';

// ── Fakes ───────────────────────────────────────────────────────────────────

/** A socket whose `bufferedAmount` the test sets, recording sends and closes as `ws` would. */
function fakeSocket(format?: BrowserLegMediaFormat) {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const ws = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    sent: [] as any[],
    binary: [] as Buffer[],
    closes: [] as Array<{ code?: number; reason?: string }>,
    send(data: string | Buffer, opts?: { binary?: boolean }) {
      if (opts?.binary) this.binary.push(data as Buffer);
      else this.sent.push(JSON.parse(data as string));
    },
    on(ev: string, cb: (...a: any[]) => void) { (handlers[ev] ||= []).push(cb); },
    off(ev: string, cb: (...a: any[]) => void) {
      const list = handlers[ev];
      if (!list) return;
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    emit(ev: string, ...a: any[]) { (handlers[ev] || []).slice().forEach((cb) => cb(...a)); },
    // `ws` moves to CLOSING at once; the close event comes later (it is not emitted here,
    // as for a peer that is not reading the close frame).
    close(code?: number, reason?: string) { this.closes.push({ code, reason }); this.readyState = 2; },
    terminate() { this.readyState = 3; },
    sendBinaryUp(buf: Buffer) { this.emit('message', buf, true); },
    /** The carrier sends audio (JSON, A-law). */
    media(payload: Buffer) { this.emit('message', JSON.stringify({ event: 'media', media: { payload: payload.toString('base64') } })); },
  };
  if (format) setBrowserLegMediaFormat(ws as never, format);
  return ws;
}
type FakeSocket = ReturnType<typeof fakeSocket>;

function makeGuardHost() {
  return {
    concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
}

const ATTEMPT = 'att-1';
const PARAMS = {
  tenantId: 't1',
  accountId: 'a1',
  callerId: '+14155550100',
  destinationPhone: '+14155550199',
  correlation: { kind: 'attempt' as const, campaignId: 'camp-1', agencyAttemptId: ATTEMPT },
  browserCloseGraceMs: 5_000,
};

/** 20 ms of A-law (160 bytes), a distinct pattern. */
const ALAW_20MS = Buffer.alloc(160, 0x55);

/** Dial on VoiceLink with `station` borrowed, attach the PSTN leg and open the relay. */
async function bridged(station: FakeSocket) {
  const mgr = new WebRtcBridgeManager(makeGuardHost() as any, null);
  await mgr.createBridgedCall({ ...PARAMS, provider: 'voicelink', browserSocket: station as any });
  const pstn = fakeSocket();
  expect(mgr.attachPstnLeg('call-1', pstn as any)).toBe(true);
  pstn.emit('message', JSON.stringify({
    event: 'start',
    start: { call_sid: 'c', stream_sid: 's', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
  }));
  const session = mgr.getSession('call-1')!;
  expect(session.providerMediaReady).toBe(true);
  station.sent.length = 0;
  return { mgr, pstn, session };
}

const mediaTo = (ws: FakeSocket) => ws.sent.filter((m) => m.event === 'media');

beforeEach(() => {
  vi.clearAllMocks();
  mockRepo.create.mockImplementation(async (i: any) => ({
    id: 'call-1', tenant_id: i.tenant_id, account_id: i.account_id, caller_id: i.caller_id,
    destination_phone: i.destination_phone, provider: i.provider, status: 'initiating',
    provider_call_id: null, telephony_credential_id: null,
    campaign_id: i.campaign_id ?? null, agency_attempt_id: i.agency_attempt_id ?? null,
  }));
});

describe('bridge send back-pressure: the station leg', () => {
  it('pcm16: sends at the soft limit, drops past it, and counts the drops on the call\'s end line', async () => {
    const station = fakeSocket('pcm16');
    const { mgr, pstn, session } = await bridged(station);

    station.bufferedAmount = STATION_PCM16_LIMITS.mediaSoftLimitBytes;
    pstn.media(ALAW_20MS);
    expect(mediaTo(station)).toHaveLength(1);

    station.bufferedAmount = STATION_PCM16_LIMITS.mediaSoftLimitBytes + 1;
    pstn.media(ALAW_20MS);
    pstn.media(ALAW_20MS);
    expect(mediaTo(station)).toHaveLength(1);
    expect(session.droppedBrowserMediaFrames).toBe(2);
    expect(session.pstnToBrowserFrames).toBe(1);
    expect(metrics.backpressure).toHaveBeenCalledWith('station', 'media_dropped');
    expect(station.closes).toEqual([]);

    // Drained: the next frame goes again.
    station.bufferedAmount = 0;
    pstn.media(ALAW_20MS);
    expect(mediaTo(station)).toHaveLength(2);

    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
    // An answered VoiceLink hangup waits for the carrier's `call.ended`: drive it.
    await mgr.handleVoicelinkStatus('call-1', {
      providerCallId: 'c', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: 'c', status: 'ended' } },
    });
    await vi.waitFor(() => expect(bridgeLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-1', droppedBrowserMediaFrames: 2, droppedPstnMediaFrames: 0 }),
      'WebRTC call ended',
    ));
  });

  it('alaw8: drops each 20 ms binary frame past the leg\'s own (smaller) soft limit', async () => {
    const station = fakeSocket('alaw8');
    const { mgr, pstn, session } = await bridged(station);

    station.bufferedAmount = STATION_ALAW8_LIMITS.mediaSoftLimitBytes;
    pstn.media(ALAW_20MS);
    expect(station.binary).toHaveLength(1);

    // A 40 ms carrier frame is two 20 ms messages: both dropped.
    station.bufferedAmount = STATION_ALAW8_LIMITS.mediaSoftLimitBytes + 1;
    pstn.media(Buffer.concat([ALAW_20MS, ALAW_20MS]));
    expect(station.binary).toHaveLength(1);
    expect(session.droppedBrowserMediaFrames).toBe(2);
    // The alaw8 limit is the smaller one: a pcm16 leg would still send at this backlog.
    expect(STATION_ALAW8_LIMITS.mediaSoftLimitBytes).toBeLessThan(STATION_PCM16_LIMITS.mediaSoftLimitBytes);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });

  it('never drops a control frame for back-pressure: status frames go out past the soft limit', async () => {
    const station = fakeSocket('pcm16');
    const { mgr } = await bridged(station);
    station.bufferedAmount = STATION_SEND_HARD_CAP_BYTES; // past every soft limit, at (not over) the cap
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
    expect(station.sent.filter((m) => m.event === 'status' || m.event === 'ended').length).toBeGreaterThan(0);
    expect(station.closes).toEqual([]);
  });

  it('closes the station 4408 station_send_backlog past the hard cap, once, and writes nothing more to it', async () => {
    const station = fakeSocket('pcm16');
    const { mgr, pstn, session } = await bridged(station);

    station.bufferedAmount = STATION_SEND_HARD_CAP_BYTES + 1;
    pstn.media(ALAW_20MS);
    pstn.media(ALAW_20MS);
    expect(station.closes).toEqual([{ code: AGENCY_STATION_CLOSE.HEARTBEAT_TIMEOUT, reason: STATION_SEND_BACKLOG_REASON }]);
    expect(mediaTo(station)).toHaveLength(0);
    expect(metrics.backpressure).toHaveBeenCalledWith('station', 'closed');
    expect(metrics.backpressure.mock.calls.filter((c) => c[1] === 'closed')).toHaveLength(1);
    // A control frame on an over-cap station closes it rather than queueing more.
    expect(session.droppedBrowserMediaFrames).toBe(0);
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
    expect(station.sent).toEqual([]);
  });
});

describe('bridge send back-pressure: the carrier leg', () => {
  it('drops the agent\'s audio past the carrier\'s soft limit, counts it, and never closes the carrier stream', async () => {
    const station = fakeSocket('alaw8');
    const { mgr, pstn, session } = await bridged(station);
    pstn.sent.length = 0;

    pstn.bufferedAmount = CARRIER_MEDIA_LIMITS.mediaSoftLimitBytes;
    station.sendBinaryUp(ALAW_20MS);
    expect(mediaTo(pstn)).toHaveLength(1);

    pstn.bufferedAmount = CARRIER_MEDIA_LIMITS.mediaSoftLimitBytes + 1;
    station.sendBinaryUp(ALAW_20MS);
    // Even far past the station's hard cap, the carrier's socket is not closed.
    pstn.bufferedAmount = 10 * STATION_SEND_HARD_CAP_BYTES;
    station.sendBinaryUp(ALAW_20MS);
    expect(mediaTo(pstn)).toHaveLength(1);
    expect(session.droppedPstnMediaFrames).toBe(2);
    expect(session.browserToPstnFrames).toBe(1);
    expect(pstn.closes).toEqual([]);
    expect(pstn.readyState).toBe(1);
    expect(metrics.backpressure).toHaveBeenCalledWith('carrier', 'media_dropped');
    await mgr.forceEndWithOutcome(ATTEMPT, 'ended_by_user');
  });
});
