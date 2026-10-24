import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PSTN media leg (`GET /api/v1/webrtc-call/:id/pstn-stream`) under load, end to end:
 * the real app and bridge on one side, the mock VoiceLink carrier dialling in over real
 * WebSockets on the other (`voicelink-load-harness.ts`). Each call is placed through the
 * real `VoicelinkAdapter` (`add_lead` to the mock), which then opens the media socket with
 * the token the bridge minted, sends `start`, and streams paced A-law.
 *
 * What this covers that the unit bridge suites (fake sockets, one call at a time) cannot:
 *  - many simultaneous carrier streams relaying in BOTH directions through the real codec,
 *    with order and loss checked per call (`audio-pattern.ts`), and no cross-talk;
 *  - the token gate under concurrency: wrong / missing / another call's / a replayed token
 *    refused while the call's own carrier gets through, and a mid-call reconnect;
 *  - `start` negotiation failures and garbage frames on a live stream;
 *  - a stalled (slow-reader) carrier while the agent keeps talking;
 *  - abrupt TCP loss and every close code a carrier might use;
 *  - the leak check after each scenario (`assertNoLeaks`): no session, slot, token,
 *    socket, timer or station listener left behind.
 *
 * The carrier picks each call's script by the lead's destination number (`plan.number`),
 * because the call id only reaches the test after `add_lead` has been answered.
 *
 * Sizes are `scaled()`; randomness is seeded and the seed is in the describe name.
 */

vi.hoisted(() => {
  Object.assign(process.env, {
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    VOICELINK_USERNAME: 'mock-vl-user',
    VOICELINK_PASSWORD: 'mock-vl-password',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    LOG_LEVEL: 'error',
  });
});

import { createRng, LOAD_SEED, scaled } from '../../helpers/load-scale.js';
import {
  bits, carrierScripts, isLoudAlaw, isLoudPcm16, pcm16kFrame, type CallScript, type CarrierCall, type LeadRequest,
} from '../../mocks/voicelink/index.js';
import {
  LoadStationSocket, assertNoLeaks, callRows, closeLoadDb, dialBridged, endedCounts, initLoadDb,
  startLoadRig, stopLoadRig, waitAllTerminal, waitFor, type CallRow, type LoadRig,
} from './voicelink-load-harness.js';

const CALLS = scaled(50);
const FRAMES = 25;
const rng = createRng(LOAD_SEED);

let rig: LoadRig | null = null;

/** A unique destination per plan; the carrier keys its script choice on it. */
function numberFor(i: number): string {
  return `98${String(70_000_000 + i).padStart(8, '0')}`;
}

/**
 * The agent's side of a call: once the bridge says media is live (`in_progress`), send
 * `pattern` as paced PCM16 frames (`frameMs` 0 = back to back).
 */
function talkingStation(pattern: boolean[], frameMs = 20, frameFor: (k: number, loud: boolean) => Buffer = pcm16kFrame): LoadStationSocket {
  const station = new LoadStationSocket();
  let started = false;
  station.onSent((frame) => {
    if (started || frame['event'] !== 'status' || frame['status'] !== 'in_progress') return;
    started = true;
    void (async () => {
      const t0 = performance.now();
      for (let k = 0; k < pattern.length; k++) {
        if (station.bridgeListenerCount() === 0) return; // the attempt is over
        station.sendMedia(frameFor(k, pattern[k]!));
        if (frameMs > 0) {
          const wait = t0 + (k + 1) * frameMs - performance.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        } else if (k % 20 === 19) {
          await new Promise((r) => setImmediate(r));
        }
      }
    })();
  });
  return station;
}

/** Recovered loud/quiet bits of what each side received. */
const heardByAgent = (st: LoadStationSocket): string => bits(st.media.map(isLoudPcm16));
const heardByCarrier = (c: CarrierCall): string => bits(c.mediaReceived.map(isLoudAlaw));

interface Plan {
  number: string;
  station: LoadStationSocket;
  script: CallScript;
  callId?: string;
}

/** Dial every plan at once; the carrier runs each plan's script. Returns plans with ids. */
async function dialAll(r: LoadRig, plans: Plan[]): Promise<Plan[]> {
  const byNumber = new Map(plans.map((p) => [p.number, p]));
  r.carrier.setScript((lead: LeadRequest) => byNumber.get(lead.customer_number)?.script ?? null);
  await Promise.all(plans.map(async (p) => {
    const { callId } = await dialBridged(r, p.station, `+91${p.number}`);
    p.callId = callId;
  }));
  return plans;
}

function carrierCallOf(r: LoadRig, p: Plan): CarrierCall {
  const c = r.carrier.calls.get(p.callId!);
  if (!c) throw new Error(`no carrier call for ${p.callId}`);
  return c;
}

function ctx(i: number, p: Plan): string {
  return `plan ${i} (${p.script.name}) call ${p.callId} seed ${LOAD_SEED}`;
}

describe(`VoiceLink media WebSocket under load (calls ${CALLS}, seed ${LOAD_SEED})`, () => {
  beforeAll(() => initLoadDb(12));
  beforeEach(async () => { rig = await startLoadRig(); });
  afterEach(async () => { await stopLoadRig(rig); rig = null; });
  afterAll(async () => { await closeLoadDb(); });

  it('N simultaneous carrier streams relay both directions in order, with no cross-talk, and leave nothing behind', async () => {
    const r = rig!;
    const plans: Plan[] = Array.from({ length: CALLS }, (_, i) => {
      const agentPattern = carrierScripts.framePattern(rng, FRAMES);
      const outcome = carrierScripts.answered({
        pattern: carrierScripts.framePattern(rng, FRAMES),
        ending: rng.pick(['webhook_then_close', 'close_then_webhook', 'stop_frame'] as const),
        // Hang up only once the agent's whole utterance has reached the carrier.
        beforeEnding: [{ do: 'waitFor', what: 'agent audio at the carrier', until: (c) => c.mediaReceived.length >= FRAMES }],
      });
      return { number: numberFor(i), station: talkingStation(agentPattern), script: outcome.script, agentPattern, outcome };
    });

    await dialAll(r, plans);
    await r.carrier.settled();
    // The trailing `call.completed` carries the recording URL; it can land after teardown
    // (the late-terminal path), so wait for it rather than for the first terminal write.
    const rows = await waitFor('terminal rows with recording urls', async () => {
      const latest = await waitAllTerminal(r, plans.map((p) => p.callId!));
      return [...latest.values()].every((row) => row.recording_url) ? latest : null;
    });

    const ended = endedCounts(r);
    for (const [i, p] of plans.entries()) {
      const plan = p as Plan & { agentPattern: boolean[]; outcome: ReturnType<typeof carrierScripts.answered> };
      const call = carrierCallOf(r, p);
      const row = rows.get(p.callId!)! as CallRow;
      expect(call.errors, ctx(i, p)).toEqual([]);
      expect(heardByAgent(p.station), `${ctx(i, p)}: carrier → agent`).toBe(bits(call.mediaSentPattern));
      expect(heardByCarrier(call), `${ctx(i, p)}: agent → carrier`).toBe(bits(plan.agentPattern));
      expect(row.status, ctx(i, p)).toBe('completed');
      expect(row.answered_at, ctx(i, p)).not.toBeNull();
      expect(row.provider_call_id, ctx(i, p)).toBe(call.carrierCallId);
      expect(ended.get(p.callId!), ctx(i, p)).toBe(1);
      // Control order on the agent's socket: live before any audio, `ended` last, and
      // nothing relayed after it.
      const events = p.station.events();
      expect(events.indexOf('status:in_progress'), ctx(i, p)).toBeLessThan(events.indexOf('media'));
      expect(events.at(-1), ctx(i, p)).toBe('ended');
      expect(row.recording_url, ctx(i, p)).toBe(plan.outcome.recordingUrl);
    }
    await assertNoLeaks(r, plans.map((p) => p.station));
  }, 120_000);

  it('the provider-token gate holds under concurrency: forged, missing, cross-call and replayed tokens are refused; the real carrier gets through', async () => {
    const r = rig!;
    type Variant = 'wrong' | 'missing' | 'cross_call' | 'clean';
    const variants: Variant[] = ['wrong', 'missing', 'cross_call', 'clean'];
    const n = Math.max(8, Math.round(CALLS / 2));
    const plans: Array<Plan & { variant: Variant; pattern: boolean[] }> = [];
    for (let i = 0; i < n; i++) {
      const variant = variants[i % variants.length]!;
      const pattern = carrierScripts.framePattern(rng, FRAMES);
      const neighbour = (): CarrierCall => r.carrier.callOrder[(r.carrier.callOrder.findIndex((c) => c.lead.customer_number === numberFor(i)) + 1) % n]!;
      const forged: CallScript['steps'] =
        variant === 'clean' ? []
          : [
            // Every lead is placed before any forged attempt, so a cross-call target exists.
            { do: 'waitFor', what: 'all leads placed', until: () => r.carrier.callOrder.length >= n },
            variant === 'cross_call'
              // OUR valid token, presented on the NEIGHBOUR's media path.
              ? { do: 'connect', callId: () => neighbour().callId }
              : { do: 'connect', token: variant },
            { do: 'waitForServerClose' },
            // Forged webhooks are refused too, and must not move the call.
            { do: 'webhook', spec: { ...carrierScripts.webhooks.answered(new Date().toISOString()), token: 'missing' } },
            { do: 'webhook', spec: { ...carrierScripts.webhooks.failed(), token: 'forged-token' } },
          ];
      const outcome = carrierScripts.answered({ pattern, ending: 'webhook_then_close' });
      plans.push({
        number: numberFor(i),
        station: new LoadStationSocket(),
        variant,
        pattern,
        script: { name: `token/${variant}`, steps: [...forged, ...outcome.script.steps] },
      });
    }

    await dialAll(r, plans);
    await r.carrier.settled();
    const rows = await waitAllTerminal(r, plans.map((p) => p.callId!));

    for (const [i, p] of plans.entries()) {
      const call = carrierCallOf(r, p);
      const row = rows.get(p.callId!)!;
      expect(call.errors, ctx(i, p)).toEqual([]);
      if (p.variant !== 'clean') {
        // The refused socket: the upgrade completes, then the bridge closes it with no
        // status code (a bare `ws.close()`, received as 1005) before any media.
        expect(call.closes[0], ctx(i, p)).toMatchObject({ socket: 0, by: 'server', code: 1005 });
        expect(call.statusesFor('call.answered')[0], ctx(i, p)).toBe(403);
        expect(call.statusesFor('call.failed'), ctx(i, p)).toEqual([403]);
      }
      // The real socket relayed this call's own audio, whole and in order — so neither
      // the refused socket nor a neighbour's forged one was ever attached to it.
      expect(heardByAgent(p.station), ctx(i, p)).toBe(bits(p.pattern));
      expect(row.status, ctx(i, p)).toBe('completed');
      expect(row.answered_at, ctx(i, p)).not.toBeNull();
    }
    expect([...endedCounts(r).values()].every((v) => v === 1)).toBe(true);

    // Replays after teardown: the provider token died with the call, so the same URL is
    // refused; the webhook token outlives it (the carrier's late reports) but a replayed
    // terminal cannot move a settled row.
    for (const p of plans.slice(0, 4)) {
      const call = carrierCallOf(r, p);
      await call.run({
        name: 'replay',
        steps: [
          { do: 'connect' },
          { do: 'waitForServerClose' },
          { do: 'webhook', spec: carrierScripts.webhooks.failed() },
          { do: 'webhook', spec: carrierScripts.webhooks.answered(new Date().toISOString()) },
        ],
      });
      expect(call.close, `replay ${p.callId}`).toMatchObject({ by: 'server', code: 1005 });
      expect(call.webhookResults.slice(-2).map((w) => w.status)).toEqual([200, 200]);
    }
    const after = await callRows(plans.slice(0, 4).map((p) => p.callId!));
    for (const p of plans.slice(0, 4)) expect(after.get(p.callId!)).toEqual(rows.get(p.callId!));
    await assertNoLeaks(r, plans.map((p) => p.station));
  }, 120_000);

  it('start negotiation failures and garbage frames: bad codecs end the call failed, garbage on a live stream is dropped without disturbing the audio', async () => {
    const r = rig!;
    // Shortened from 30s so the never-starts case runs in test time. An instance field,
    // set before any call is dialled.
    (r.bridge as unknown as { startTimeoutSeconds: number }).startTimeoutSeconds = 1;
    const GARBAGE: Array<string | Buffer> = [
      'not json at all',
      'null',
      '[]',
      '{"event":"media"}',
      '{"event":"media","media":{"payload":12345}}',
      '{"event":"media","media":{"payload":null}}',
      JSON.stringify({ event: 'media', media: { payload: 'A'.repeat(200_000) } }), // oversized: dropped before decode
      '{"event":"mark","mark":{"name":"x"}}',
      '{"event":"dtmf","dtmf":{"digit":"5"}}',
      Buffer.from([0xff, 0x00, 0xfe, 0x01]),
      '{"event":"start","start":{"media_format":{"encoding":"audio/alaw","sample_rate":"8000"}}}', // a second start
    ];
    type Kind = 'mulaw' | 'rate16k' | 'no_format' | 'media_before_bad_start' | 'never_starts' | 'garbage';
    const kinds: Kind[] = ['mulaw', 'rate16k', 'no_format', 'media_before_bad_start', 'never_starts', 'garbage', 'garbage'];
    const n = Math.max(kinds.length, Math.round(CALLS / 2));
    const plans: Array<Plan & { kind: Kind; pattern: boolean[] }> = [];
    for (let i = 0; i < n; i++) {
      const kind = kinds[i % kinds.length]!;
      const pattern = carrierScripts.framePattern(rng, FRAMES);
      const trailing = { do: 'webhook', spec: carrierScripts.webhooks.endedAnswered(new Date().toISOString(), 1) } as const;
      let steps: CallScript['steps'];
      switch (kind) {
        case 'mulaw': steps = [{ do: 'connect' }, { do: 'start', encoding: 'audio/x-mulaw' }, { do: 'waitForServerClose' }, trailing]; break;
        case 'rate16k': steps = [{ do: 'connect' }, { do: 'start', sampleRate: 16000 }, { do: 'waitForServerClose' }, trailing]; break;
        case 'no_format': steps = [{ do: 'connect' }, { do: 'start', omitFormat: true }, { do: 'waitForServerClose' }, trailing]; break;
        case 'media_before_bad_start':
          steps = [{ do: 'connect' }, { do: 'media', pattern, frameMs: 0 }, { do: 'start', encoding: 'audio/L16' }, { do: 'waitForServerClose' }, trailing];
          break;
        case 'never_starts': steps = [{ do: 'connect' }, { do: 'media', pattern, frameMs: 5 }, { do: 'waitForServerClose', timeoutMs: 20_000 }, trailing]; break;
        case 'garbage':
          steps = carrierScripts.answered({
            pattern,
            afterStart: [{ do: 'raw', frames: GARBAGE }],
            ending: 'webhook_then_close',
          }).script.steps;
          break;
      }
      plans.push({ number: numberFor(i), station: new LoadStationSocket(), kind, pattern, script: { name: `start/${kind}`, steps } });
    }

    await dialAll(r, plans);
    await r.carrier.settled();
    const rows = await waitAllTerminal(r, plans.map((p) => p.callId!));

    for (const [i, p] of plans.entries()) {
      const call = carrierCallOf(r, p);
      const row = rows.get(p.callId!)!;
      expect(call.errors, ctx(i, p)).toEqual([]);
      if (p.kind === 'garbage') {
        // Only the real frames were relayed: the bit string is exactly the pattern.
        expect(heardByAgent(p.station), ctx(i, p)).toBe(bits(p.pattern));
        expect(row.status, ctx(i, p)).toBe('completed');
        continue;
      }
      expect(call.close, ctx(i, p)).toMatchObject({ by: 'server' });
      // Media sent before (or without) a valid start is never relayed.
      expect(p.station.media, ctx(i, p)).toHaveLength(0);
      expect(row.answered_at, ctx(i, p)).toBeNull();
      expect(row.status, ctx(i, p)).toBe('failed');
      if (p.kind === 'never_starts') {
        expect(row.outcome, ctx(i, p)).toBe('provider_start_timeout');
      } else {
        expect({ outcome: row.outcome, code: row.error_code }, ctx(i, p))
          .toEqual({ outcome: 'unsupported_media_format', code: 'UNSUPPORTED_MEDIA_FORMAT' });
      }
    }
    expect([...endedCounts(r).values()].every((v) => v === 1)).toBe(true);
    await assertNoLeaks(r, plans.map((p) => p.station));
  }, 120_000);

  it('a stalled carrier (slow reader) while the agent keeps talking: the bridge buffers, loses and reorders nothing, and its neighbours are unaffected', async () => {
    const r = rig!;
    const SLOW = scaled(2);
    const NORMAL = scaled(12);
    // Big frames (0.5s each) so a stalled reader backs the bridge's send buffer up past
    // the kernel's socket buffers within the test, rather than after minutes of 20ms frames.
    const BIG_FRAMES = 1000;
    const bigFrame = (k: number, loud: boolean): Buffer => {
      const samples = 8000;
      const pcm = new Int16Array(samples);
      if (loud) for (let j = 0; j < samples; j++) pcm[j] = Math.round(6000 * Math.sin((2 * Math.PI * 1000 * (k * samples + j)) / 16000));
      return Buffer.from(pcm.buffer);
    };
    const maxBuffered = new Map<string, number>();
    const plans: Array<Plan & { slow: boolean; agentPattern: boolean[]; agentDone: () => boolean }> = [];
    for (let i = 0; i < SLOW + NORMAL; i++) {
      const slow = i < SLOW;
      const agentPattern = carrierScripts.framePattern(rng, slow ? BIG_FRAMES : FRAMES);
      const station = talkingStation(agentPattern, slow ? 0 : 20, slow ? bigFrame : pcm16kFrame);
      const agentDone = (): boolean => station.mediaSentCount >= agentPattern.length;
      const steps: CallScript['steps'] = slow
        ? carrierScripts.answered({
          pattern: carrierScripts.framePattern(rng, FRAMES),
          afterStart: [{ do: 'pauseReading' }],
          beforeEnding: [
            {
              do: 'waitFor', what: 'the agent to finish talking into a stalled carrier', timeoutMs: 60_000,
              until: (c) => {
                const ws = r.bridge.getSession(c.callId)?.pstnWs as unknown as { bufferedAmount?: number } | null | undefined;
                maxBuffered.set(c.callId, Math.max(maxBuffered.get(c.callId) ?? 0, ws?.bufferedAmount ?? 0));
                return agentDone();
              },
            },
            { do: 'resumeReading' },
            { do: 'waitFor', what: 'the backlog to drain', timeoutMs: 60_000, until: (c) => c.mediaReceived.length >= BIG_FRAMES },
          ],
        }).script.steps
        : carrierScripts.answered({
          pattern: carrierScripts.framePattern(rng, FRAMES),
          beforeEnding: [{ do: 'waitFor', what: 'agent audio', until: (c) => c.mediaReceived.length >= FRAMES }],
        }).script.steps;
      plans.push({ number: numberFor(i), station, slow, agentPattern, agentDone, script: { name: slow ? 'slow_reader' : 'normal', steps } });
    }

    await dialAll(r, plans);
    await r.carrier.settled();
    const rows = await waitAllTerminal(r, plans.map((p) => p.callId!));

    for (const [i, p] of plans.entries()) {
      const call = carrierCallOf(r, p);
      expect(call.errors, ctx(i, p)).toEqual([]);
      expect(heardByCarrier(call), `${ctx(i, p)}: agent → carrier`).toBe(bits(p.agentPattern));
      expect(heardByAgent(p.station), `${ctx(i, p)}: carrier → agent`).toBe(bits(call.mediaSentPattern));
      expect(rows.get(p.callId!)!.status, ctx(i, p)).toBe('completed');
      // The stall really reached the bridge's own send buffer (not just the kernel's).
      if (p.slow) expect(maxBuffered.get(p.callId!) ?? 0, ctx(i, p)).toBeGreaterThan(0);
    }
    await assertNoLeaks(r, plans.map((p) => p.station));
  }, 120_000);

  it('abrupt TCP loss and every close code a carrier may send settle the call once, answered, with the right outcome', async () => {
    const r = rig!;
    type End = { name: string; steps: CallScript['steps']; outcome: string };
    const ends: End[] = [
      { name: 'tcp_destroy', steps: [{ do: 'destroy' }], outcome: 'pstn_stream_closed' },
      { name: 'close_1000', steps: [{ do: 'close', code: 1000 }], outcome: 'pstn_stream_closed' },
      { name: 'close_1001', steps: [{ do: 'close', code: 1001 }], outcome: 'pstn_stream_closed' },
      { name: 'close_1011', steps: [{ do: 'close', code: 1011, reason: 'internal error' }], outcome: 'pstn_stream_closed' },
      { name: 'close_3000', steps: [{ do: 'close', code: 3000 }], outcome: 'pstn_stream_closed' },
      { name: 'close_4000', steps: [{ do: 'close', code: 4000, reason: 'lead hangup' }], outcome: 'pstn_stream_closed' },
      // `stop` and the TCP loss back to back: two teardown triggers for one call.
      { name: 'stop_then_destroy', steps: [{ do: 'stop' }, { do: 'destroy' }], outcome: 'pstn_stream_stopped' },
      // A `stop` frame with the socket left open: the bridge must close it itself.
      { name: 'stop_then_linger', steps: [{ do: 'stop' }, { do: 'waitForServerClose' }], outcome: 'pstn_stream_stopped' },
      // The webhook alone ends it while the socket is still up.
      { name: 'webhook_only', steps: [{ do: 'webhook', spec: carrierScripts.webhooks.endedAnswered(new Date().toISOString(), 1) }, { do: 'waitForServerClose' }], outcome: 'remote_hangup' },
    ];
    const n = Math.max(ends.length, CALLS);
    const plans: Array<Plan & { end: End; cut: number }> = [];
    for (let i = 0; i < n; i++) {
      const end = ends[i % ends.length]!;
      const pattern = carrierScripts.framePattern(rng, FRAMES);
      const cut = rng.int(1, FRAMES - 1); // mid-stream
      plans.push({
        number: numberFor(i),
        station: new LoadStationSocket(),
        end,
        cut,
        script: {
          name: `end/${end.name}`,
          steps: [
            { do: 'webhook', spec: carrierScripts.webhooks.ringing() },
            { do: 'connect' },
            { do: 'webhook', spec: carrierScripts.webhooks.answered(new Date().toISOString()) },
            { do: 'start' },
            { do: 'media', pattern: pattern.slice(0, cut) },
            ...end.steps,
            // The carrier's own terminal report trails the teardown, as in production.
            { do: 'webhook', spec: carrierScripts.webhooks.completedAnswered(new Date().toISOString(), 1, `https://recording.app.voicelink.co.in/mock/${i}.mp3`) },
          ],
        },
      });
    }

    await dialAll(r, plans);
    await r.carrier.settled();
    const rows = await waitAllTerminal(r, plans.map((p) => p.callId!));
    const ended = endedCounts(r);
    for (const [i, p] of plans.entries()) {
      const call = carrierCallOf(r, p);
      const row = rows.get(p.callId!)!;
      expect(call.errors, ctx(i, p)).toEqual([]);
      expect({ status: row.status, outcome: row.outcome, answered: row.answered_at !== null }, ctx(i, p))
        .toEqual({ status: 'completed', outcome: p.end.outcome, answered: true });
      expect(ended.get(p.callId!), ctx(i, p)).toBe(1);
      // Everything the carrier sent before the cut reached the agent, in order.
      expect(heardByAgent(p.station), ctx(i, p)).toBe(bits(call.mediaSentPattern));
      expect(p.station.events().at(-1), ctx(i, p)).toBe('ended');
    }
    await assertNoLeaks(r, plans.map((p) => p.station));
  }, 120_000);

  it('a carrier that reconnects mid-call: the old socket is closed by the bridge, audio continues on the new one in order, and the call settles once', async () => {
    const r = rig!;
    const n = Math.max(4, Math.round(CALLS / 5));
    const plans: Array<Plan & { pattern: boolean[] }> = [];
    for (let i = 0; i < n; i++) {
      const pattern = carrierScripts.framePattern(rng, FRAMES * 2);
      plans.push({
        number: numberFor(i),
        station: new LoadStationSocket(),
        pattern,
        script: {
          name: 'reconnect',
          steps: [
            { do: 'connect' },
            { do: 'webhook', spec: carrierScripts.webhooks.answered(new Date().toISOString()) },
            { do: 'start' },
            { do: 'media', pattern: pattern.slice(0, FRAMES) },
            // Same URL, same token, new socket — no second `start` (VoiceLink keeps the stream).
            { do: 'connect' },
            { do: 'waitFor', what: 'the bridge to close the superseded socket', until: (c) => c.closes.some((x) => x.socket === 0) },
            { do: 'media', pattern: pattern.slice(FRAMES) },
            { do: 'webhook', spec: carrierScripts.webhooks.endedAnswered(new Date().toISOString(), 1) },
            { do: 'waitForServerClose' },
          ],
        },
      });
    }

    await dialAll(r, plans);
    await r.carrier.settled();
    const rows = await waitAllTerminal(r, plans.map((p) => p.callId!));
    const ended = endedCounts(r);
    for (const [i, p] of plans.entries()) {
      const call = carrierCallOf(r, p);
      expect(call.errors, ctx(i, p)).toEqual([]);
      expect(call.closes.find((c) => c.socket === 0), ctx(i, p)).toMatchObject({ by: 'server' });
      expect(heardByAgent(p.station), ctx(i, p)).toBe(bits(p.pattern));
      expect({ status: rows.get(p.callId!)!.status, ended: ended.get(p.callId!) }, ctx(i, p)).toEqual({ status: 'completed', ended: 1 });
      // One `bridged` per call although the leg connected twice (the latch).
      expect(r.lifecycle.filter((e) => e.callId === p.callId && e.phase === 'bridged'), ctx(i, p)).toHaveLength(1);
    }
    await assertNoLeaks(r, plans.map((p) => p.station));
  }, 120_000);

  it('a carrier that dials before its own add_lead response arrives: the call bridges, settles once, and keeps the carrier\'s real id', async () => {
    // `respond_after_script`: the carrier runs the call's script BEFORE answering add_lead,
    // so the bridge sees `start`, media and (for half of them) the whole call while
    // `initiateCall` is still awaiting the HTTP response. The dial-time placeholder written
    // after that response must not overwrite the carrier id the start/webhook backfilled.
    const r = rig!;
    const n = Math.max(4, Math.round(CALLS / 5));
    const plans: Array<Plan & { pattern: boolean[]; whole: boolean }> = [];
    for (let i = 0; i < n; i++) {
      const pattern = carrierScripts.framePattern(rng, FRAMES);
      const whole = i % 2 === 0;
      const live: CallScript['steps'] = [
        { do: 'connect' },
        { do: 'webhook', spec: carrierScripts.webhooks.answered(new Date().toISOString()) },
        { do: 'start' },
        { do: 'media', pattern, frameMs: 5 },
      ];
      const ending: CallScript['steps'] = [
        { do: 'webhook', spec: carrierScripts.webhooks.endedAnswered(new Date().toISOString(), 1) },
        { do: 'waitForServerClose' },
      ];
      plans.push({
        number: numberFor(i), station: new LoadStationSocket(), pattern, whole,
        script: { name: whole ? 'early_dial/whole_call' : 'early_dial/live', steps: whole ? [...live, ...ending] : live },
      });
    }
    r.carrier.injectFault('add_lead', { kind: 'respond_after_script' }, n);
    await dialAll(r, plans);
    // The calls that were still live when add_lead answered end now.
    await Promise.all(plans.filter((p) => !p.whole).map((p) => carrierCallOf(r, p).run({
      name: 'early_dial/ending',
      steps: [
        { do: 'webhook', spec: carrierScripts.webhooks.endedAnswered(new Date().toISOString(), 1) },
        { do: 'waitForServerClose' },
      ],
    })));
    await r.carrier.settled();
    const rows = await waitAllTerminal(r, plans.map((p) => p.callId!));
    const ended = endedCounts(r);
    for (const [i, p] of plans.entries()) {
      const call = carrierCallOf(r, p);
      const row = rows.get(p.callId!)!;
      expect(call.errors, ctx(i, p)).toEqual([]);
      expect(heardByAgent(p.station), ctx(i, p)).toBe(bits(p.pattern));
      expect({ status: row.status, ended: ended.get(p.callId!) }, ctx(i, p)).toEqual({ status: 'completed', ended: 1 });
      expect(row.provider_call_id, ctx(i, p)).toBe(call.carrierCallId);
    }
    await assertNoLeaks(r, plans.map((p) => p.station));
  }, 120_000);
});
