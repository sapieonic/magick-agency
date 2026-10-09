import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// The apology clip, against the REAL
// clip cache and real disk.
//
// **Why this file exists when `abandoned-call-path.test.ts` already plays a
// clip.** That file mocks `src/tts/tts-file-cache.js`, so its `readTtsPcm`
// returns a clip for *any* argument. Everything downstream of the resolver is
// therefore proven — 10 paced frames, the carrier envelope, frames before the
// hangup — while the one link between the two halves is not: nothing checks that
// the hash `resolveAbandonClip` produced is the hash the bridge looks up. A dial
// path that passed the announcement id, the campaign id, or an empty string to
// `playClipToCarrierThenHangUp` would satisfy every assertion in that file. That
// is the classic self-answering check: the test supplies the answer to the question it
// claims to ask.
//
// `abandon-clip.test.ts` covers the other half (which hash the resolver returns)
// with `generateTtsAudio` and `ensurePcmClip` mocked. So both halves are green
// and the seam between them is untested at any tier.
//
// Here the cache is REAL: bytes are written with `writeTtsFile` under a known
// hash, the announcement row resolves to that hash, and `readTtsPcm` — all the
// bridge reads — hits actual disk. The negative control (clip present under a
// DIFFERENT hash) is the assertion a mocked cache structurally cannot make.
//
// Real: `WebRtcBridgeManager`, `PacedAudioStreamer`, `StationRegistry`,
// `AgentStateMachine`, `tts-file-cache`, the prom-client registry, the disk.
// Doubled: Redis, Postgres repositories, the telephony adapter, and TTS
// SYNTHESIS (never the cache) — a real TTS backend is not available to a unit
// test and is not what is under test.
//
// Self-contained mock harness (project convention: no shared test utilities).
//
// The cache, the disk, the bridge and the pacer are all real. Notes on the harness:
//   - the carrier is VoiceLink: the answer is the media WS's `start` frame, the hangup
//     is the bridge closing that WS, and the row settles on the carrier's `call.ended`
//     (`answerCarrier` / `confirmCarrierEnd`, as in the bridge suites).
//   - the wire format is VoiceLink's: the bridge converts the cached 16 kHz PCM to
//     A-law 8 kHz, 160 bytes per 20 ms frame — 10 frames for the 200 ms clip. So
//     "the customer heard the EXACT bytes on disk" is asserted as: the reassembled wire
//     bytes equal `pcmToAlaw(<the bytes on disk>, 16000)`, the bridge's one conversion of
//     THIS file. A clip read from another hash, truncated, reordered or duplicated
//     still fails it; the NEGATIVE CONTROL (clip present under a different hash) is
//     unchanged.
//   - the apology is an uploaded clip (decision #4: no TTS synthesis): the stubbed
//     step that hands back the cache hash is `ensurePcmClip` (it decodes from S3) —
//     a fixture, not a stand-in for the cache.
// ---------------------------------------------------------------------------

// The cache reads `TTS_AUDIO_DIR` at module-evaluation time, so it must be set
// before any import runs, and `vi.hoisted` is the only hook ordered ahead of
// them. Pure string arithmetic here — no `fs`/`os`/`path`, because a hoisted
// factory runs before this file's own imports are bound and cannot use them.
// The directory is created at the bottom of the import block instead; only the
// env var has to be early.
//
// A per-run directory rather than the shared `os.tmpdir()/tts-audio` default:
// this file writes clips under hashes it chose and asserts on MISSES, and a
// collision with another suite's cache would turn a miss into a hit — the
// negative control would pass while proving nothing.
const { CACHE_DIR } = vi.hoisted(() => {
  const tmp = process.env['TMPDIR'] || '/tmp';
  const dir = `${tmp.replace(/\/$/, '')}/agency-abandon-clip-${process.pid}-${Date.now()}`;
  process.env['TTS_AUDIO_DIR'] = dir;
  return { CACHE_DIR: dir };
});

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {
      voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' },
    },
  },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: {
      setState: vi.fn().mockResolvedValue(null),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
    },
    contact: {
      unclaim: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(undefined),
      chargeAttempt: vi.fn().mockResolvedValue(1),
    },
    session: { setState: vi.fn().mockResolvedValue(undefined), findById: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyContactRepository: repos.contact,
  agencyCampaignRepository: {},
  agencyAgentSessionRepository: repos.session,
}));

const { mockWebrtcRepo } = vi.hoisted(() => ({
  mockWebrtcRepo: {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  webrtcCallRepository: mockWebrtcRepo,
}));

vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(null),
  },
}));

// ── The apology's dependencies. NOTE: `tts-file-cache` is NOT mocked. ───────
//
// `generateTtsAudio` is, because synthesis needs a network backend. It returns
// the hash the real cache is keyed on — which is precisely the value whose
// journey to `readTtsPcm` this file exists to check, so it is a fixture, not a
// stand-in for the thing under test.
// `ensurePcmClip` supplies the hash — see the header.
const { announcements, audioFiles, ensurePcmClip } = vi.hoisted(() => ({
  announcements: { findActiveByIdScoped: vi.fn() },
  audioFiles: { findById: vi.fn().mockResolvedValue(null) },
  ensurePcmClip: vi.fn(),
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: announcements,
}));
vi.mock('@magick-agency/db/repositories/audio-file.repository', () => ({
  audioFileRepository: audioFiles,
}));
vi.mock('../../../src/audio/ensure-pcm-clip.js', () => ({ ensurePcmClip }));

const { mockAdapter } = vi.hoisted(() => ({
  mockAdapter: {
    initiateCall: vi.fn().mockResolvedValue({ providerCallId: 'pcid-1' }),
    endCall: vi.fn().mockResolvedValue(undefined),
    generateAnswerResponse: vi.fn().mockReturnValue('<Response><Stream/></Response>'),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class { get() { return mockAdapter; } },
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));
// `isEnabled` and `agency_late_binding` are here because `executeDial` resolves
// the late-binding flag on every dial. `false` keeps these cases on the
// early-binding path they were written for — the flag's own registry default, so
// this double agrees with production for a tenant nobody has enrolled.
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({
    getValue: vi.fn().mockResolvedValue(1800),
    isEnabled: vi.fn().mockResolvedValue(false),
  }),
  FLAGS: {
    webrtc_max_duration_seconds: { default: 1800 },
    agency_late_binding: { key: 'agency_late_binding', type: 'boolean', default: false },
  },
}));

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import { AgencyDialer } from '../../../src/agency/agency-dialer.js';
import { AgentStateMachine, AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { StationRegistry } from '../../../src/agency/station-registry.js';
import { BreakRegistry } from '@magick-agency/domain/break-manager';
import {
  writeTtsFile, readTtsPcm, getTtsFilePath, ttsFileExists,
} from '../../../src/tts/tts-file-cache.js';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';
// The bridge's own clip conversion for VoiceLink — see the header.
import { pcmToAlaw } from '../../../src/utils/audio.js';

// `writeTtsFile` does not create its directory (`initTtsFileCache` does, at
// startup). Done here rather than in `beforeEach` so the very first write in the
// file has somewhere to land.
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ─── Doubles ───────────────────────────────────────────────────────────────

class StationSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly frames: any[] = [];
  send(s: string): void { try { this.frames.push(JSON.parse(s)); } catch { /* binary */ } }
  close(): void { this.drop(); }
  drop(): void { this.readyState = 3; this.emit('close'); }
}

/** The carrier leg — the customer's ear. Frames are stamped so pacing is observable. */
class PstnSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly frames: Array<{ at: number; frame: any }> = [];
  bufferedAmount = 0;
  get mediaFrames(): Array<{ at: number; frame: any }> {
    return this.frames.filter((f) => f.frame?.event === 'playAudio' || f.frame?.event === 'media');
  }
  /** Everything the customer actually heard, reassembled from the wire. */
  get heardPcm(): Buffer {
    return Buffer.concat(
      this.mediaFrames.map((f) => Buffer.from(f.frame.media.payload as string, 'base64')),
    );
  }
  send(s: string): void {
    try { this.frames.push({ at: Date.now(), frame: JSON.parse(s) }); } catch { /* ignore */ }
  }
  /** VoiceLink's hangup is the bridge closing this WS; stamped here. */
  closedAt: number | null = null;
  close(): void {
    this.readyState = 3;
    this.closedAt ??= Date.now();
    hangupAt ??= this.closedAt;
  }
}

/** The VoiceLink answer — the media WS's `start` frame. */
function answerCarrier(world: { bridge: WebRtcBridgeManager }, pstn: PstnSocket): void {
  world.bridge.attachPstnLeg('call-1', pstn as any);
  pstn.emit('message', JSON.stringify({
    event: 'start',
    start: { call_sid: 'carrier-1', stream_sid: 'stream-1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
  }));
}

/** The carrier's `call.ended`, confirming the hangup the bridge issued. */
async function confirmCarrierEnd(world: { bridge: WebRtcBridgeManager }): Promise<void> {
  await world.bridge.handleVoicelinkStatus('call-1', {
    providerCallId: 'carrier-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
    metadata: { event: 'call.ended', call: { id: 'carrier-1', status: 'ended' } },
  } as any);
}

/** In-memory Redis: `eval` is ioredis's Lua entry point, never JavaScript's. */
class FakeRedis {
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
}

function makeCallManager() {
  return {
    concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
}

function fakeWrapup() {
  return {
    enter: vi.fn(async () => false), cancel: vi.fn(), force: vi.fn(async () => false),
    stateFor: vi.fn(() => null), noteDisposition: vi.fn(async () => false),
    stop: vi.fn(), active: vi.fn(() => 0),
  };
}

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3 Renewals', tenant_id: 't1', account_id: 'a1',
  telephony_provider: 'voicelink', record_calls: false,
  analysis_profile_id: null, caller_ids: ['+14155550100'],
  disposition_catalog: [], wrapup_seconds: 0, wrapup_auto_return: true,
  abandon_announcement_id: 'ann-1',
} as any;

function makeCmd(campaign: any = CAMPAIGN): DialCommand {
  return {
    attemptId: 'att-1', campaignId: 'camp-1', contactId: 'contact-1',
    sessionId: 's1', ownerReplica: 'r1', tenantId: 't1', accountId: 'a1',
    callerId: '+14155550100', attemptNumber: 1,
    campaign,
    contact: { id: 'contact-1', phone_e164: '+919876543210', context: {}, attempt_count: 0 } as any,
  };
}

function makeWorld() {
  const redis = new FakeRedis();
  const bridge = new WebRtcBridgeManager(makeCallManager() as any, redis as any);
  const stations = new StationRegistry(redis as any, '', 'r1');
  const agents = new AgentStateMachine(redis as any, '');
  const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, new BreakRegistry());
  dialer.start();
  return { bridge, stations, agents, dialer };
}

// ─── The clip, and the numbers derived from it ──────────────────────────────
//
// 3200 samples at 16 kHz is exactly 200 ms. The bridge converts the cached 16 kHz PCM
// to A-law 8 kHz, so the wire bytes are comparable to the bytes on disk through that
// one conversion and "the customer heard THIS clip" is assertable rather than only
// "some audio arrived". 20 ms frames of 160 bytes ⇒ 10 frames. Every number is derived,
// not read off a run.
const CLIP_SAMPLE_RATE = 16000;
const CLIP_SAMPLES = 3200;
const CLIP_MS = (CLIP_SAMPLES / CLIP_SAMPLE_RATE) * 1000;
const FRAME_MS = 20;
// VoiceLink's wire is A-law at 8 kHz, one byte per sample: 160 bytes per 20 ms
// frame. Derived, not read off a run.
const FRAME_BYTES = (8000 * 1 * FRAME_MS) / 1000;
const EXPECTED_FRAMES = CLIP_MS / FRAME_MS;

/** The hash the announcement resolves to, and the clip is stored under. */
const APOLOGY_HASH = 'a'.repeat(40);
/** A hash nothing was ever written under — the miss the negative control needs. */
const ABSENT_HASH = 'b'.repeat(40);

function apologyPcm(): Buffer {
  const pcm = new Int16Array(CLIP_SAMPLES);
  // A ramp, not a sine: every sample is distinct, so a frame delivered out of
  // order or a duplicated frame changes the reassembled bytes. A periodic signal
  // would hide both.
  for (let i = 0; i < CLIP_SAMPLES; i++) pcm[i] = (i % 20000) - 10000;
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Wait on a real condition against real timers.
 *
 * Playback is paced with `setTimeout`, so draining the check phase observes
 * exactly one frame. Polling the terminal event rather than sleeping a guessed
 * duration also means the test cannot pass by having waited long enough.
 */
async function waitUntil(pred: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition never became true');
    await new Promise((r) => setTimeout(r, 5));
  }
  await flush();
}

/** Dial, lose the agent mid-ring, let the customer answer. The only route to abandonment under D1. */
async function loseAgentThenAnswer(world: ReturnType<typeof makeWorld>) {
  const ws = new StationSocket();
  await world.stations.attach({
    sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
    agentUserId: 'user-1', ws: ws as any,
  });
  await world.agents.set('s1', 'reserved', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.reserved_predial });
  await world.dialer.executeDial(makeCmd());

  ws.drop();
  await world.stations.detach('s1', ws as any);
  expect(world.stations.isLocallyOwned('s1')).toBe(false);

  const pstn = new PstnSocket();
  const answeredAt = Date.now();
  answerCarrier(world, pstn); // VoiceLink answers on `start`
  // Hangup = the bridge closing the media WS; the row settles on `call.ended`.
  await waitUntil(() => pstn.readyState === 3);
  await confirmCarrierEnd(world);
  await waitUntil(() => repos.attempt.setState.mock.calls.some((c) => c[1] === 'ended'));
  return { pstn, answeredAt };
}

function endedWith(): Record<string, unknown> | undefined {
  return repos.attempt.setState.mock.calls.find((c) => c[1] === 'ended')?.[2] as
    Record<string, unknown> | undefined;
}

let seq = 0;
let hangupAt: number | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  hangupAt = null;
  mockWebrtcRepo.create.mockImplementation(async (i: any) => ({
    id: `call-${++seq}`,
    tenant_id: i.tenant_id, account_id: i.account_id,
    caller_id: i.caller_id, destination_phone: i.destination_phone,
    provider: i.provider, status: 'initiating', provider_call_id: null,
    answered_at: null, ended_at: null, duration_seconds: null, talk_time_seconds: null,
    campaign_id: i.campaign_id ?? null, agency_attempt_id: i.agency_attempt_id ?? null,
  }));
  mockAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });
  // `hangupAt` is stamped by `PstnSocket.close` (VoiceLink's hangup).
  mockAdapter.endCall.mockResolvedValue(undefined);
  // An uploaded recording (decision #4).
  announcements.findActiveByIdScoped.mockResolvedValue({
    id: 'ann-1', tenant_id: 't1', account_id: 'a1', name: 'Apology', type: 'audio',
    audio_file_id: 'af-1', is_active: true,
  });
  audioFiles.findById.mockResolvedValue({ id: 'af-1', s3_key: 'clips/af-1.wav' });
  // Synthesis is stubbed; the CACHE is real. By default the clip is on disk under
  // the hash the resolver hands back — the ordinary state after a synthesis.
  // The decode step (`ensurePcmClip`) is what hands the hash back.
  ensurePcmClip.mockResolvedValue({ hash: APOLOGY_HASH, sampleRate: CLIP_SAMPLE_RATE });
  writeTtsFile(APOLOGY_HASH, apologyPcm(), CLIP_SAMPLE_RATE, 1);
});

afterEach(() => {
  for (const hash of [APOLOGY_HASH, ABSENT_HASH]) {
    try { fs.unlinkSync(getTtsFilePath(hash)); } catch { /* not written by this case */ }
  }
});

afterAll(() => {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// The cache is real, and it is the same directory the product writes to.
// ═══════════════════════════════════════════════════════════════════════════

describe('the clip cache under test is the real one', () => {
  it('writes to a real file that the real reader can read back', () => {
    // The premise every case below rests on, asserted rather than assumed: if
    // `TTS_AUDIO_DIR` had not been set before the module loaded, `writeTtsFile`
    // would be writing to the shared default and this file's "misses" would be
    // whatever another suite left behind.
    expect(getTtsFilePath(APOLOGY_HASH).startsWith(CACHE_DIR)).toBe(true);
    expect(ttsFileExists(APOLOGY_HASH)).toBe(true);
    expect(ttsFileExists(ABSENT_HASH)).toBe(false);

    const read = readTtsPcm(APOLOGY_HASH);
    expect(read).not.toBeNull();
    // The 44-byte-header contract between the sole writer and the reader, on a
    // real file. `readTtsPcm` is not a WAV parser; this is what makes it safe.
    expect(read!.sampleRate).toBe(CLIP_SAMPLE_RATE);
    expect(read!.pcm16.equals(apologyPcm())).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The seam: the hash the resolver returns is the hash the bridge reads.
// ═══════════════════════════════════════════════════════════════════════════

describe('the resolved clip is what reaches the customer', () => {
  it('plays the EXACT bytes on disk to the carrier, then hangs up, settling `abandoned`', async () => {
    const world = makeWorld();
    const { pstn } = await loseAgentThenAnswer(world);

    // The bridge looked the clip up by the hash the resolver produced. Nothing
    // else could have put these bytes on the wire.
    expect(pstn.mediaFrames.length).toBe(EXPECTED_FRAMES);
    // VoiceLink's media envelope.
    expect(pstn.mediaFrames[0]!.frame).toMatchObject({
      event: 'media',
      media: { payload: expect.any(String) },
    });
    for (const f of pstn.mediaFrames) {
      expect(Buffer.from(f.frame.media.payload as string, 'base64').length).toBe(FRAME_BYTES);
    }

    // The assertion the mocked-cache file cannot make: what the customer heard is
    // byte-identical to what was written under the resolved hash. A frame count
    // alone passes against a clip read from the wrong hash, truncated, resampled
    // by mistake, or reordered.
    // VoiceLink transcodes, so "byte-identical to what was written" is
    // byte-identical to the bridge's A-law conversion of what was written.
    expect(pstn.heardPcm.equals(pcmToAlaw(apologyPcm(), CLIP_SAMPLE_RATE))).toBe(true);

    expect(pstn.closedAt).not.toBeNull(); // VoiceLink's hangup
    expect(hangupAt).not.toBeNull();
    for (const f of pstn.mediaFrames) expect(f.at).toBeLessThanOrEqual(hangupAt!);
    expect(endedWith()).toMatchObject({ outcome: 'abandoned' });
  });

  it('NEGATIVE CONTROL: a clip stored under a DIFFERENT hash is not played', async () => {
    // The whole point of the file. The bytes are on disk and perfectly readable —
    // just not under the hash the resolver returned. If any hop dropped, defaulted
    // or substituted the hash, the bridge would find *this* clip and play it, and
    // every positive assertion above would still pass.
    //
    // Without this case a dial path that passed the announcement id (or anything
    // else) to `playClipToCarrierThenHangUp` is indistinguishable from a correct
    // one, because a mocked `readTtsPcm` answers to any argument.
    fs.unlinkSync(getTtsFilePath(APOLOGY_HASH));
    writeTtsFile(ABSENT_HASH, apologyPcm(), CLIP_SAMPLE_RATE, 1);
    expect(ttsFileExists(ABSENT_HASH)).toBe(true);
    expect(ttsFileExists(APOLOGY_HASH)).toBe(false);

    const world = makeWorld();
    const { pstn } = await loseAgentThenAnswer(world);

    expect(pstn.mediaFrames.length).toBe(0);
    // And the accounting is unaffected — the clip is the courtesy, not the
    // mechanism. A cache miss is the ordinary state of a replica that has never
    // played this clip, so it must never leave the attempt non-terminal.
    expect(pstn.closedAt).not.toBeNull(); // VoiceLink's hangup
    expect(endedWith()).toMatchObject({ outcome: 'abandoned' });
  });

  it('REGRESSION LOCK (do not prune): paces playback at real time instead of blasting it', async () => {
    // Carried onto the real-cache path deliberately rather than left to the mocked
    // one. The first implementation pushed the whole clip in one synchronous loop
    // and then slept for its duration: every frame-count, byte-equality and
    // ordering assertion above passes against that, and the customer hears a
    // fragment, because a carrier's jitter buffer discards audio arriving faster
    // than it plays. Occupying its own duration on the wire is the only
    // observable difference — and reading the bytes from real disk adds a
    // synchronous file read ahead of frame 0, which is exactly the kind of change
    // that tempts someone to "just send it all and sleep".
    const world = makeWorld();
    const { pstn } = await loseAgentThenAnswer(world);

    const first = pstn.mediaFrames[0]!.at;
    const last = pstn.mediaFrames[pstn.mediaFrames.length - 1]!.at;
    // 10 frames at 20ms ⇒ the last is scheduled 9 frames (180ms) after the first.
    // One frame of slack for scheduler jitter; a burst measures ~0.
    expect(last - first).toBeGreaterThanOrEqual(CLIP_MS - 2 * FRAME_MS);
  });

  it('starts the apology before the customer can notice silence — with a real disk read in the path', async () => {
    const world = makeWorld();
    const { pstn, answeredAt } = await loseAgentThenAnswer(world);

    // Acceptance (d) re-measured where the resolution is real: the only latency
    // the customer may hear is the clip's own. Budgeted against the clip's length
    // rather than a bare `> 0`, because the failure this catches — a file read or
    // a DB round trip landing ahead of frame 0 — is a whole clip's worth of dead
    // air, not a millisecond.
    expect(pstn.mediaFrames[0]!.at - answeredAt).toBeLessThan(CLIP_MS);
  });
});
