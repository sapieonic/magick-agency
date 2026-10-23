/**
 * Ready-made {@link CallScript}s: what the carrier does on the common call outcomes and
 * the fault shapes the load suites throw at the bridge.
 *
 * The webhook bodies are the shapes in `src/telephony/voicelink/voicelink-carrier.fixture.json`
 * (nested `body.call.*`, the live capture shape), so the classification each script
 * implies is the product's own: `expected` on a {@link ScriptedOutcome} is the terminal
 * `agency_calls.status` that classification yields, which a suite compares against
 * Postgres.
 */
import type { Rng } from '../../helpers/load-scale.js';
import type { CallScript, CallStep, WebhookSpec } from './carrier-call.js';

export type ExpectedStatus = 'completed' | 'no_answer' | 'busy' | 'canceled' | 'failed';

export interface ScriptedOutcome {
  script: CallScript;
  /** The terminal `agency_calls.status` this script must settle as. */
  expected: ExpectedStatus;
  /** Did the carrier answer (the row must carry `answered_at`)? */
  answered: boolean;
  /** The recording URL the terminal webhook carries, if any. */
  recordingUrl?: string;
}

const nowIso = (): string => new Date().toISOString();

export const webhooks = {
  initiated: (): WebhookSpec => ({ event: 'call.initiated', call: { status: 'initiated' } }),
  ringing: (): WebhookSpec => ({ event: 'call.ringing', call: { status: 'ringing', ringingAt: nowIso() } }),
  answered: (answeredAt: string): WebhookSpec => ({ event: 'call.answered', call: { status: 'answered', answeredAt } }),
  /** `call.ended` of an answered call: no `callStatus`, `answeredAt` is the discriminator. */
  endedAnswered: (answeredAt: string, durationSec: number): WebhookSpec => ({
    event: 'call.ended',
    call: { status: 'ended', hangupCause: '16', sipStatus: '200', answeredAt, endedAt: nowIso(), durationSec },
  }),
  completedAnswered: (answeredAt: string, durationSec: number, recordingUrl: string): WebhookSpec => ({
    event: 'call.completed',
    call: {
      status: 'ended', callStatus: 'ANSWERED', hangupCause: '16', hangupReason: 'Normal Clearing',
      sipStatus: '200', answeredAt, endedAt: nowIso(), durationSec, recordingUrl,
    },
  }),
  noAnswer: (): WebhookSpec => ({
    event: 'call.completed',
    call: {
      status: 'ended', callStatus: 'NO ANSWER', hangupCause: '19 - User alerting, no answer',
      hangupReason: 'User alerting, no answer', sipStatus: '480', answeredAt: null,
    },
  }),
  busy: (): WebhookSpec => ({
    event: 'call.ended',
    call: { status: 'ended', hangupCause: '17 - User busy', hangupReason: 'User busy', sipStatus: '486' },
  }),
  failed: (): WebhookSpec => ({
    event: 'call.failed',
    call: { status: 'failed', hangupCause: '38 - Network out of order', hangupReason: 'Network out of order', sipStatus: '503' },
  }),
};

/** A seeded loud/quiet pattern of `n` frames (see `audio-pattern.ts`). */
export function framePattern(rng: Rng, n: number): boolean[] {
  return Array.from({ length: n }, () => rng.chance(0.5));
}

export interface AnsweredOptions {
  /** Frames streamed while connected. */
  pattern: boolean[];
  frameMs?: number;
  recordingUrl?: string;
  /**
   * How the customer's end goes away:
   *  - `webhook_then_close`: `call.ended` then a clean 1000 close (the observed order);
   *  - `close_then_webhook`: the socket closes first, the webhook trails;
   *  - `stop_frame`: a `stop` frame, then the webhooks;
   *  - `destroy`: TCP torn down mid-call, webhooks trail (a carrier crash).
   */
  ending?: 'webhook_then_close' | 'close_then_webhook' | 'stop_frame' | 'destroy';
  /** Extra steps after `start`, before media (e.g. a pause for the station to bind). */
  afterStart?: CallStep[];
  /** Wait for this before ending (e.g. "the agent's audio reached me"). */
  beforeEnding?: CallStep[];
}

/** Ring, answer, media, customer hangs up. Settles `completed` with `answered_at`. */
export function answered(opts: AnsweredOptions): ScriptedOutcome {
  const answeredAt = nowIso();
  const recordingUrl = opts.recordingUrl ?? `https://recording.app.voicelink.co.in/client_1150/mock/${Math.random().toString(36).slice(2)}.mp3`;
  const durationSec = Math.max(1, Math.round((opts.pattern.length * (opts.frameMs ?? 20)) / 1000));
  const terminal: CallStep = {
    do: 'webhooks',
    specs: [webhooks.endedAnswered(answeredAt, durationSec), webhooks.completedAnswered(answeredAt, durationSec, recordingUrl)],
  };
  const ending = opts.ending ?? 'webhook_then_close';
  const endSteps: CallStep[] =
    ending === 'webhook_then_close' ? [terminal, { do: 'close', code: 1000 }]
      : ending === 'close_then_webhook' ? [{ do: 'close', code: 1000 }, terminal]
        : ending === 'stop_frame' ? [{ do: 'stop' }, terminal, { do: 'close', code: 1000 }]
          : [{ do: 'destroy' }, terminal];
  return {
    expected: 'completed',
    answered: true,
    recordingUrl,
    script: {
      name: `answered/${ending}`,
      steps: [
        { do: 'webhook', spec: webhooks.initiated() },
        { do: 'webhook', spec: webhooks.ringing() },
        { do: 'connect' },
        { do: 'webhook', spec: webhooks.answered(answeredAt) },
        { do: 'start' },
        ...(opts.afterStart ?? []),
        { do: 'media', pattern: opts.pattern, frameMs: opts.frameMs ?? 20 },
        ...(opts.beforeEnding ?? []),
        ...endSteps,
      ],
    },
  };
}

/** Rings out. No socket is ever opened (VoiceLink only dials the WS on answer). */
export function noAnswer(): ScriptedOutcome {
  return {
    expected: 'no_answer',
    answered: false,
    script: { name: 'no_answer', steps: [{ do: 'webhook', spec: webhooks.ringing() }, { do: 'webhook', spec: webhooks.noAnswer() }] },
  };
}

export function busy(): ScriptedOutcome {
  return {
    expected: 'busy',
    answered: false,
    script: { name: 'busy', steps: [{ do: 'webhook', spec: webhooks.ringing() }, { do: 'webhook', spec: webhooks.busy() }] },
  };
}

export function failed(): ScriptedOutcome {
  return {
    expected: 'failed',
    answered: false,
    script: { name: 'failed', steps: [{ do: 'webhook', spec: webhooks.failed() }] },
  };
}

/** The `start` frame names a codec the bridge cannot transcode. Ends `failed`. */
export function wrongCodec(encoding = 'audio/x-mulaw', sampleRate: string | number = '8000'): ScriptedOutcome {
  return {
    expected: 'failed',
    answered: false,
    script: {
      name: `wrong_codec/${encoding}@${sampleRate}`,
      steps: [
        { do: 'connect' },
        { do: 'start', encoding, sampleRate },
        { do: 'waitForServerClose' },
      ],
    },
  };
}

/**
 * Pick one of the four ordinary outcomes with the given weights, seeded. Answered calls
 * stream `frames` frames.
 */
export function pickOrdinary(
  rng: Rng,
  frames: number,
  weights: { answered: number; noAnswer: number; busy: number; failed: number } = { answered: 0.55, noAnswer: 0.2, busy: 0.15, failed: 0.1 },
  frameMs = 20,
): ScriptedOutcome {
  const r = rng.next();
  let acc = weights.answered;
  if (r < acc) return answered({ pattern: framePattern(rng, frames), frameMs, ending: rng.pick(['webhook_then_close', 'close_then_webhook', 'stop_frame', 'destroy'] as const) });
  acc += weights.noAnswer;
  if (r < acc) return noAnswer();
  acc += weights.busy;
  if (r < acc) return busy();
  return failed();
}
