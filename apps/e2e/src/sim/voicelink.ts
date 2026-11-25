/**
 * The simulated VoiceLink carrier: the server's own test mock (`apps/server/test/mocks/voicelink`),
 * driven by personas instead of fixed scripts, so a browser spec controls what the "customer"
 * does.
 *
 * A persona is picked per dialled number:
 *  1. an override a spec set (`POST /_sim/personas`), else
 *  2. the number's last two digits (the default table below), so a spec that loads a CSV of
 *     numbers knows each outcome without talking to the simulator at all.
 *
 * An answered call streams paced A-law frames until the agent hangs up (the bridge closes the
 * media socket), the spec hangs up for the customer (`POST /_sim/calls/:number/hangup`), or the
 * persona's own talk time runs out. Then the terminal webhooks carry the real talk time.
 */
import { MockVoicelinkCarrier, CarrierCall, type LeadRequest } from '../../../server/test/mocks/voicelink/index.js';
import { hasSound } from './audio.js';
import { RECORDING_HOST } from '../env.js';

export type PersonaName = 'answer' | 'busy' | 'no_answer' | 'failed' | 'answer_then_hangup' | 'silent';

export interface Persona {
  name: PersonaName;
  /** Ring time before the answer (or before the no-answer / busy verdict), ms. */
  ringMs?: number;
  /** `answer_then_hangup`: talk time before the customer hangs up, ms. */
  talkMs?: number;
}

/** The last two digits of the dialled number pick the outcome (docs: apps/e2e/CLAUDE.md). */
export const PERSONA_BY_SUFFIX: Record<string, PersonaName> = {
  '01': 'answer',
  '02': 'busy',
  '03': 'no_answer',
  '04': 'failed',
  '05': 'answer_then_hangup',
  '06': 'silent',
};

const DEFAULT_RING_MS = 800;
const DEFAULT_TALK_MS = 4000;
/** An answered call's ceiling, so a forgotten call cannot stream forever. */
const MAX_TALK_MS = 10 * 60_000;

export interface SimCall {
  callId: string;
  number: string;
  persona: PersonaName;
  state: 'ringing' | 'answered' | 'ended';
  placedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  /** Who ended an answered call. */
  endedBy: 'agent' | 'customer' | null;
  /** Frames the bridge sent us (the agent's voice), and how many carried sound. */
  framesFromServer: number;
  nonSilentFramesFromServer: number;
  framesToServer: number;
  recordingUrl: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/** Strip a country code / formatting so the persona table and overrides match on the national number. */
export function normaliseNumber(n: string): string {
  const digits = n.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function personaFor(number: string, overrides: Map<string, Persona>): Persona {
  const key = normaliseNumber(number);
  const o = overrides.get(key);
  if (o) return o;
  return { name: PERSONA_BY_SUFFIX[key.slice(-2)] ?? 'answer' };
}

export class VoicelinkSim {
  readonly carrier: MockVoicelinkCarrier;
  readonly overrides = new Map<string, Persona>();
  readonly calls: SimCall[] = [];
  private readonly live = new Map<string, { call: CarrierCall; sim: SimCall; hangup: () => void }>();

  constructor(opts: { username: string; password: string; serverOrigin: () => string }) {
    this.carrier = new MockVoicelinkCarrier({
      username: opts.username,
      password: opts.password,
      targetOrigin: opts.serverOrigin,
      // We drive every call ourselves (persona-based, open-ended talk), so the mock only places
      // it and registers it; returning null keeps the mock from running a script of its own.
      scriptFor: (_lead, ctx) => {
        const call = this.carrier.calls.get(ctx.callId);
        if (call) void this.drive(call);
        return null;
      },
    });
  }

  async start(): Promise<void> {
    await this.carrier.start();
  }

  async stop(): Promise<void> {
    for (const l of this.live.values()) l.hangup();
    await this.carrier.stop();
  }

  get baseUrl(): string {
    return this.carrier.baseUrl;
  }

  reset(): void {
    for (const l of this.live.values()) l.hangup();
    this.overrides.clear();
    this.calls.length = 0;
    this.carrier.reset();
  }

  callsTo(number: string): SimCall[] {
    const key = normaliseNumber(number);
    return this.calls.filter((c) => c.number === key);
  }

  /**
   * Every customer still on a call hangs up, and this waits (up to `timeoutMs`) until each call
   * has sent its terminal webhooks. Run after every test, so no call outlives the test that
   * placed it. The number of calls that were live.
   */
  async hangupAll(timeoutMs = 10_000): Promise<number> {
    const n = this.live.size;
    for (const l of this.live.values()) l.hangup();
    const deadline = Date.now() + timeoutMs;
    while (this.live.size > 0 && Date.now() < deadline) await sleep(100);
    return n;
  }

  /** The customer hangs up the newest live call to `number`. False when there is none. */
  hangup(number: string): boolean {
    const key = normaliseNumber(number);
    const live = [...this.live.values()].reverse().find((l) => l.sim.number === key);
    if (!live) return false;
    live.hangup();
    return true;
  }

  private async drive(call: CarrierCall): Promise<void> {
    const lead: LeadRequest = call.lead;
    const persona = personaFor(lead.customer_number, this.overrides);
    const sim: SimCall = {
      callId: call.callId,
      number: normaliseNumber(lead.customer_number),
      persona: persona.name,
      state: 'ringing',
      placedAt: Date.now(),
      answeredAt: null,
      endedAt: null,
      endedBy: null,
      framesFromServer: 0,
      nonSilentFramesFromServer: 0,
      framesToServer: 0,
      recordingUrl: null,
    };
    this.calls.push(sim);
    const ringMs = persona.ringMs ?? DEFAULT_RING_MS;
    const end = () => { sim.state = 'ended'; sim.endedAt = Date.now(); };

    await call.run({ name: 'ring', steps: [{ do: 'webhook', spec: { event: 'call.initiated', call: { status: 'initiated' } } }] });
    await call.run({ name: 'ring', steps: [{ do: 'webhook', spec: { event: 'call.ringing', call: { status: 'ringing', ringingAt: nowIso() } } }] });
    await sleep(ringMs);

    switch (persona.name) {
      case 'busy':
        await call.run({ name: 'busy', steps: [{ do: 'webhook', spec: { event: 'call.ended', call: { status: 'ended', hangupCause: '17 - User busy', hangupReason: 'User busy', sipStatus: '486' } } }] });
        end();
        return;
      case 'no_answer':
        await call.run({ name: 'no_answer', steps: [{ do: 'webhook', spec: { event: 'call.completed', call: { status: 'ended', callStatus: 'NO ANSWER', hangupCause: '19 - User alerting, no answer', hangupReason: 'User alerting, no answer', sipStatus: '480', answeredAt: null } } }] });
        end();
        return;
      case 'failed':
        await call.run({ name: 'failed', steps: [{ do: 'webhook', spec: { event: 'call.failed', call: { status: 'failed', hangupCause: '38 - Network out of order', hangupReason: 'Network out of order', sipStatus: '503' } } }] });
        end();
        return;
      default:
        break;
    }

    // Answered personas: open the media socket, answer, stream until someone hangs up.
    const answeredAt = nowIso();
    await call.run({
      name: 'answer',
      steps: [
        { do: 'connect' },
        { do: 'webhook', spec: { event: 'call.answered', call: { status: 'answered', answeredAt } } },
        { do: 'start' },
      ],
    });
    sim.state = 'answered';
    sim.answeredAt = Date.now();

    let customerHungUp = false;
    let stopStreaming = false;
    const hangup = () => {
      if (stopStreaming) return;
      customerHungUp = true;
      stopStreaming = true;
    };
    this.live.set(call.callId, { call, sim, hangup });

    const ceiling = persona.name === 'answer_then_hangup' ? persona.talkMs ?? DEFAULT_TALK_MS : MAX_TALK_MS;
    const loud = persona.name !== 'silent';
    // Stream in 1 s chunks of 20 ms frames so a hangup is noticed promptly.
    const t0 = Date.now();
    // Frames are judged once each, as they arrive: a long call never re-decodes its history.
    let judged = 0;
    const countReceived = () => {
      const received = call.mediaReceived;
      for (; judged < received.length; judged++) if (hasSound(received[judged]!)) sim.nonSilentFramesFromServer += 1;
      sim.framesFromServer = received.length;
    };
    while (!stopStreaming && call.ws && call.ws.readyState === 1 && Date.now() - t0 < ceiling) {
      const pattern = Array.from({ length: 50 }, (_, i) => loud && i % 10 < 7);
      await call.run({ name: 'talk', steps: [{ do: 'media', pattern, frameMs: 20 }] });
      sim.framesToServer = call.mediaSentPattern.length;
      countReceived();
    }
    if (!customerHungUp && Date.now() - t0 >= ceiling) customerHungUp = true;
    const serverClosed = !call.ws || call.ws.readyState !== 1;
    sim.endedBy = serverClosed && !customerHungUp ? 'agent' : 'customer';
    countReceived();

    const durationSec = Math.max(1, Math.round((Date.now() - (sim.answeredAt ?? Date.now())) / 1000));
    const recordingUrl = `https://${RECORDING_HOST}/client_e2e/${call.callId}.wav`;
    sim.recordingUrl = recordingUrl;
    await call.run({
      name: 'end',
      steps: [
        {
          do: 'webhooks',
          specs: [
            { event: 'call.ended', call: { status: 'ended', hangupCause: '16', sipStatus: '200', answeredAt, endedAt: nowIso(), durationSec } },
            {
              event: 'call.completed',
              call: {
                status: 'ended', callStatus: 'ANSWERED', hangupCause: '16', hangupReason: 'Normal Clearing',
                sipStatus: '200', answeredAt, endedAt: nowIso(), durationSec, recordingUrl,
              },
            },
          ],
        },
        { do: 'close', code: 1000 },
      ],
    });
    this.live.delete(call.callId);
    end();
  }
}
