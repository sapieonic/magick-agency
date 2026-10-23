import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Webhook storms against the real bridge and Postgres: many calls at once, each posting
 * its lifecycle webhooks duplicated, shuffled and concurrently, through the real route
 * (`POST /api/v1/webhooks/voicelink/webrtc-status/:callId?token=`) with the token the
 * bridge minted. The carrier is the mock (`test/mocks/voicelink`); the calls are placed
 * through the real adapter.
 *
 * The invariants, per call, read from Postgres and the bridge's lifecycle stream:
 *  - exactly one terminal settlement (`ended` emitted once) however many terminals arrive;
 *  - the terminal status is the carrier's classification, whatever order the events came
 *    in, and a progress event (`ringing`/`answered`) arriving after it never moves the row
 *    back to a live status;
 *  - `ended_at` is set and the recording URL lands even when its webhook trails teardown;
 *  - every concurrency slot and media token is released (`assertNoLeaks`).
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

import { createRng, LOAD_SEED, scaled, type Rng } from '../../helpers/load-scale.js';
import { carrierScripts, type CallScript, type CallStep, type LeadRequest, type WebhookSpec } from '../../mocks/voicelink/index.js';
import {
  LoadStationSocket, assertNoLeaks, callRows, closeLoadDb, dialBridged, endedCounts, initLoadDb,
  startLoadRig, stopLoadRig, waitAllTerminal, waitFor, type LoadRig,
} from './voicelink-load-harness.js';

const CALLS = scaled(40);
const rng = createRng(LOAD_SEED);
const { webhooks } = carrierScripts;

let rig: LoadRig | null = null;

type Kind = 'answered_media' | 'answered_no_media' | 'no_answer' | 'busy' | 'failed';
const EXPECTED: Record<Kind, string> = {
  answered_media: 'completed',
  answered_no_media: 'completed',
  no_answer: 'no_answer',
  busy: 'busy',
  failed: 'failed',
};

interface StormPlan {
  number: string;
  kind: Kind;
  /** `burst`: every webhook of the call at once; `shuffled`: one at a time, in a seeded order. */
  delivery: 'burst' | 'shuffled' | 'ordered';
  script: CallScript;
  recordingUrl: string | null;
  callId?: string;
}

function numberFor(i: number): string {
  return `98${String(60_000_000 + i).padStart(8, '0')}`;
}

/** Each spec 1–3 times. */
function duplicated(r: Rng, specs: WebhookSpec[]): WebhookSpec[] {
  return specs.flatMap((s) => Array.from({ length: r.int(1, 3) }, () => s));
}

function plan(i: number, r: Rng, kinds: readonly Kind[], deliveries: ReadonlyArray<StormPlan['delivery']>): StormPlan {
  const kind = r.pick(kinds);
  const delivery = r.pick(deliveries);
  const answeredAt = new Date(Date.now() - 5_000).toISOString();
  const recordingUrl = kind.startsWith('answered') ? `https://recording.app.voicelink.co.in/client_1150/storm/${i}.mp3` : null;
  const lifecycle: WebhookSpec[] =
    kind === 'answered_no_media' ? [webhooks.ringing(), webhooks.answered(answeredAt), webhooks.endedAnswered(answeredAt, 4), webhooks.completedAnswered(answeredAt, 4, recordingUrl!)]
      : kind === 'no_answer' ? [webhooks.initiated(), webhooks.ringing(), webhooks.noAnswer()]
        : kind === 'busy' ? [webhooks.ringing(), webhooks.busy()]
          : kind === 'failed' ? [webhooks.initiated(), webhooks.failed()]
            : [];
  let steps: CallStep[];
  if (kind === 'answered_media') {
    // Media first (the WS is only up while the call is live), then the terminal storm.
    steps = [
      { do: 'webhook', spec: webhooks.ringing() },
      { do: 'connect' },
      { do: 'webhook', spec: webhooks.answered(answeredAt) },
      { do: 'start' },
      { do: 'media', pattern: carrierScripts.framePattern(r, 5), frameMs: 10 },
      {
        do: 'webhooks', concurrent: true,
        specs: duplicated(r, [webhooks.answered(answeredAt), webhooks.endedAnswered(answeredAt, 4), webhooks.completedAnswered(answeredAt, 4, recordingUrl!), webhooks.ringing()]),
      },
      { do: 'waitForServerClose' },
    ];
  } else {
    const all = duplicated(r, lifecycle);
    steps = delivery === 'burst'
      ? [{ do: 'webhooks', concurrent: true, specs: all }]
      : [{ do: 'webhooks', specs: delivery === 'shuffled' ? r.shuffle(all) : all }];
  }
  return { number: numberFor(i), kind, delivery, recordingUrl, script: { name: `${kind}/${delivery}`, steps } };
}

async function dialAll(r: LoadRig, plans: StormPlan[]): Promise<void> {
  const byNumber = new Map(plans.map((p) => [p.number, p]));
  r.carrier.setScript((lead: LeadRequest) => byNumber.get(lead.customer_number)?.script ?? null);
  await Promise.all(plans.map(async (p) => {
    const { callId } = await dialBridged(r, new LoadStationSocket(), `+91${p.number}`);
    p.callId = callId;
  }));
}

describe(`VoiceLink webhook storms (calls ${CALLS}, seed ${LOAD_SEED})`, () => {
  beforeAll(() => initLoadDb(12));
  beforeEach(async () => { rig = await startLoadRig(); });
  afterEach(async () => { await stopLoadRig(rig); rig = null; });
  afterAll(async () => { await closeLoadDb(); });

  it('duplicated, shuffled and concurrent webhooks for many calls settle each call exactly once with the classified status', async () => {
    const r = rig!;
    const plans = Array.from({ length: CALLS }, (_, i) =>
      plan(i, rng, ['answered_media', 'answered_no_media', 'no_answer', 'busy', 'failed'], ['burst', 'shuffled', 'ordered']));
    await dialAll(r, plans);
    await r.carrier.settled();

    const ids = plans.map((p) => p.callId!);
    const rows = await waitFor('terminal rows with their recordings', async () => {
      const latest = await waitAllTerminal(r, ids);
      return plans.every((p) => !p.recordingUrl || latest.get(p.callId!)!.recording_url) ? latest : null;
    }, 30_000, async () => {
      const latest = await callRows(ids);
      return JSON.stringify(plans.filter((p) => p.recordingUrl && !latest.get(p.callId!)?.recording_url)
        .slice(0, 5).map((p) => ({ plan: p.script.name, row: latest.get(p.callId!) })));
    });
    const ended = endedCounts(r);
    for (const [i, p] of plans.entries()) {
      const call = r.carrier.calls.get(p.callId!)!;
      const row = rows.get(p.callId!)!;
      const what = `plan ${i} ${p.script.name} call ${p.callId} seed ${LOAD_SEED}`;
      expect(call.errors, what).toEqual([]);
      // Every post was accepted (the token is right; duplicates and late ones are 200s).
      expect(call.webhookResults.every((w) => w.status === 200), what).toBe(true);
      expect(ended.get(p.callId!), what).toBe(1);
      expect(row.status, what).toBe(EXPECTED[p.kind]);
      expect(row.ended_at, what).not.toBeNull();
      if (p.recordingUrl) expect(row.recording_url, what).toBe(p.recordingUrl);
      // The carrier's real id replaced the dial-time placeholder.
      expect(row.provider_call_id, what).toBe(call.carrierCallId);
      if (p.kind === 'answered_media' || (p.kind === 'answered_no_media' && p.delivery === 'ordered')) {
        expect(row.answered_at, what).not.toBeNull();
      }
      if (!p.kind.startsWith('answered')) expect(row.answered_at, what).toBeNull();
    }

    // A second storm of the same webhooks after everything settled moves nothing.
    const before = await callRows(ids);
    await Promise.all(plans.map((p) => r.carrier.calls.get(p.callId!)!.run({
      name: 'replay',
      steps: [{ do: 'webhooks', concurrent: true, specs: [webhooks.answered(new Date().toISOString()), webhooks.ringing(), webhooks.failed(), webhooks.noAnswer()] }],
    })));
    expect(await callRows(ids)).toEqual(before);
    expect(endedCounts(r)).toEqual(ended);
    await assertNoLeaks(r);
  }, 120_000);

  it('a terminal that races its own call.answered (both posted at once) never loses the terminal state', async () => {
    // The tightest interleaving: the answer handler's `in_progress` write and the terminal
    // write are issued back to back on different pool connections. A live status written
    // after the terminal would leave the row `in_progress` with `ended_at` set.
    const r = rig!;
    const n = scaled(40);
    const plans: StormPlan[] = Array.from({ length: n }, (_, i) => {
      const answeredAt = new Date(Date.now() - 3_000).toISOString();
      const recordingUrl = `https://recording.app.voicelink.co.in/client_1150/race/${i}.mp3`;
      return {
        number: numberFor(i),
        kind: 'answered_no_media',
        delivery: 'burst',
        recordingUrl,
        script: {
          name: 'answer_vs_terminal',
          steps: [{ do: 'webhooks', concurrent: true, specs: [webhooks.answered(answeredAt), webhooks.completedAnswered(answeredAt, 3, recordingUrl)] }],
        },
      };
    });
    await dialAll(r, plans);
    await r.carrier.settled();
    const rows = await waitAllTerminal(r, plans.map((p) => p.callId!));
    for (const p of plans) {
      expect(rows.get(p.callId!)!.status, `${p.callId} seed ${LOAD_SEED}`).toBe('completed');
    }
    expect([...endedCounts(r).values()].every((v) => v === 1)).toBe(true);
    await assertNoLeaks(r);
  }, 120_000);

  // DEFECT (open): a terminal webhook that overtakes its own `call.answered` (two POSTs
  // in flight at once; nothing orders them) settles the call `completed` — the classifier
  // reads the terminal's `answeredAt` — but never anchors the answer: `answered_at` stays
  // NULL, talk time is 0, and the `ended` lifecycle event says `answered: false`. The
  // agency's outcome classifier maps `completed` + not answered + not bridged to
  // `no_answer`, so a customer who picked up is recorded as a no-answer (and redialled),
  // and an answered-unbridged call drops out of the abandonment numerator. The late
  // `call.answered` is then ignored (no session). Anchoring from the terminal payload
  // means emitting `answered` immediately before `ended`, which the dialer's `answered`
  // arm acts on (bind / abandon flow) — not a local change, so it is left open.
  it.fails('a terminal that overtakes its own call.answered still records the answer', async () => {
    const r = rig!;
    const n = Math.max(4, Math.round(CALLS / 4));
    const plans: StormPlan[] = Array.from({ length: n }, (_, i) => {
      const answeredAt = new Date(Date.now() - 4_000).toISOString();
      return {
        number: numberFor(i),
        kind: 'answered_no_media',
        delivery: 'ordered',
        recordingUrl: null,
        script: {
          name: 'terminal_before_answered',
          steps: [{ do: 'webhooks', specs: [webhooks.endedAnswered(answeredAt, 4), webhooks.answered(answeredAt)] }],
        },
      };
    });
    await dialAll(r, plans);
    await r.carrier.settled();
    const rows = await waitAllTerminal(r, plans.map((p) => p.callId!));
    for (const p of plans) {
      const row = rows.get(p.callId!)!;
      expect(row.status).toBe('completed'); // holds today
      expect(row.answered_at, `${p.callId} seed ${LOAD_SEED}`).not.toBeNull();
      const ended = r.lifecycle.find((e) => e.callId === p.callId && e.phase === 'ended');
      expect(ended?.answered).toBe(true);
    }
  }, 60_000);
});
