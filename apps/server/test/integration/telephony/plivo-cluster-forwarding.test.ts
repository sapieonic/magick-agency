import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A Plivo call placed by a media worker, its callbacks forwarded to it (`docs/scaling.md`
 * §3.2), end to end in one process: the voice engine is built as media worker slot 0
 * builds it (`carrierRouteHint: '0'`, so every URL Plivo gets carries `&w=0`), and the
 * app's Plivo routes forward through the REAL `MediaCluster` forwarder to a worker whose
 * IPC handler decodes the request with the real decoder and runs the real
 * `handlePlivoCallback` on that engine's bridge. Everything else is `plivo-rig.ts`: real
 * Postgres and Redis, pacing, the bridge, the adapter, the credential service, the mock
 * Plivo carrier. With two workers (the engine built as slot 1), each callback reaches the
 * worker its `w` names and never the other.
 *
 * What it shows: the answer XML a worker renders crosses back to Plivo (its `<Stream>`
 * keeps the `w`), every callback's V3 signature still verifies in the worker over the URL
 * the primary received, and a forged one is refused there.
 *
 * Not the real process tree: a forked worker builds its adapters with `fetch` to Plivo's
 * fixed host, which no test may move (`media-workers.test.ts` covers the tree with
 * VoiceLink, whose host is configurable).
 */

vi.hoisted(() => {
  Object.assign(process.env, {
    FF_AGENCY_DIALER: 'true',
    PLIVO_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/plivo',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    PLIVO_REQUEST_TIMEOUT_MS: '3000',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    LOG_LEVEL: 'warn',
  });
});

import { MediaCluster } from '../../../src/cluster/media-cluster.js';
import { IPC_REQUEST_DECODERS } from '../../../src/cluster/ipc-protocol.js';
import { setPlivoCallbackForwarder } from '../../../src/api/routes/webhooks.routes.js';
import { handlePlivoCallback } from '../../../src/api/routes/webhooks/plivo.js';
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import { PLIVO_HANGUP_XML } from '../../../src/telephony/plivo/plivo.adapter.js';
import { EMPTY_SNAPSHOT, FakeChildProcess } from '../../helpers/fake-child-process.js';
import {
  attemptOf, callRow, closePlivoDb, initPlivoDb, joinAgent, plivoCampaign, startPlivoRig, waitFor, type PlivoRig, type Station,
} from './plivo-rig.js';

let rig: PlivoRig | null = null;
let station: Station | null = null;
let cluster: MediaCluster | null = null;
/** The fake media workers, by slot. */
let workers: FakeChildProcess[] = [];
/** The worker that holds the call (the rig's route hint). */
let worker: FakeChildProcess | null = null;

/**
 * The rig's voice engine is built as media worker `owner` builds it (every URL Plivo gets
 * carries `&w=<owner>`), behind a cluster of `count` fake workers. Only the owner serves
 * `carrier.plivo_callback` (the real decoder and handler on that engine's bridge): it is
 * the one holding the call. Any other worker has no handler for it, so a callback
 * forwarded there would go unanswered.
 */
async function startCluster(count: number, owner: number): Promise<void> {
  rig = await startPlivoRig({ carrierRouteHint: String(owner) });
  const bridge = rig.bridge;
  workers = [];
  cluster = new MediaCluster({
    count,
    fork: (slot) => {
      const child = new FakeChildProcess('media', slot);
      child.handlers.set('reaper.snapshot', () => EMPTY_SNAPSHOT);
      // The worker's side of the request, as `media-child.ts` serves it after its channel decoded it.
      if (slot === owner) {
        child.handlers.set('carrier.plivo_callback', (raw) => {
          const body = IPC_REQUEST_DECODERS['carrier.plivo_callback'].req(JSON.parse(JSON.stringify(raw)));
          if (!body) return Promise.reject(new Error('malformed'));
          const { token, ...input } = body;
          return handlePlivoCallback(bridge, { ...input, token: token ?? undefined });
        });
      }
      workers[slot] = child;
      setImmediate(() => child.ready());
      return child.asChild();
    },
    readOwner: async () => null,
    setAgentOffline: async () => {},
    readyTimeoutMs: 2_000,
  });
  await cluster.start();
  worker = workers[owner] ?? null;
  setPlivoCallbackForwarder(cluster.plivoCallbackForwarder);
}

beforeAll(() => { initPlivoDb(); });
afterEach(async () => {
  setPlivoCallbackForwarder(null);
  await station?.close();
  station = null;
  await rig?.carrier.settled();
  await cluster?.stop(1_000);
  cluster = null;
  workers = [];
  worker = null;
  await rig?.stop();
  rig = null;
});
afterAll(closePlivoDb);

describe('media workers: Plivo`s callbacks reach the worker that placed the call', () => {
  beforeEach(() => startCluster(1, 0));

  it('ring, answer (the worker`s XML), stream, REST hangup, hangup and recording callbacks: all forwarded, all verified there', async () => {
    const r = rig!;
    const pattern = Array.from({ length: 10 }, (_, i) => i % 2 === 0);
    r.carrier.setScript(() => ({
      name: 'answered via a worker',
      steps: [
        { do: 'ring' },
        { do: 'answer' },
        { do: 'connect' },
        { do: 'start' },
        { do: 'media', pattern },
        { do: 'waitFor', until: (c) => c.hungUpByApi, what: 'our REST hangup', timeoutMs: 20_000 },
        { do: 'waitFor', until: (c) => c.callbacks.some((cb) => cb.to === 'hangup'), what: 'the hangup callback' },
        { do: 'recording', recordingId: 'rec-worker' },
      ],
    }));
    const { campaignId } = await plivoCampaign(r);
    station = await joinAgent(r, campaignId);
    const call = await waitFor('the dial', () => r.carrier.callOrder[0]);
    // The worker's slot is in every URL Plivo was given.
    expect(call.request.answer_url).toMatch(/&w=0$/);
    expect(call.request.hangup_url).toMatch(/&w=0$/);
    await waitFor('the customer heard', () => station!.media.length >= pattern.length);
    const attempt = await attemptOf(campaignId);
    expect(await getAgencyRuntime()!.dialer.hangupAttempt(attempt!.id)).toBe(true);
    await r.carrier.settled();

    expect(call.errors).toEqual([]);
    expect(call.callbacks.map((c) => [c.to, c.status])).toEqual([['ring', 200], ['answer', 200], ['hangup', 200], ['recording', 200]]);
    // The answer XML came from the worker, over IPC, with the worker's hint in its stream URL.
    expect(call.answerXml).toContain('<Stream bidirectional="true"');
    expect(call.streamUrl).toMatch(/\/pstn-stream\?token=[0-9a-f-]{36}&w=0$/);
    expect(call.recordCallbackUrl).toMatch(/\/webrtc-recording\/.+&w=0$/);
    const forwarded = worker!.requests('carrier.plivo_callback').map((q) => (q.body as { kind: string }).kind);
    expect(forwarded).toEqual(['status', 'answer', 'status', 'recording']);
    const row = await waitFor('terminal with recording', async () => {
      const x = await callRow(call.callId);
      return x?.status === 'completed' && x.recording_url ? x : null;
    });
    expect(row).toMatchObject({ provider_call_id: call.callUuid, provider_request_id: call.requestUuid, telephony_credential_id: r.credentialId });
  }, 60_000);

  it('a forwarded answer callback signed by another tenant`s account is refused in the worker: the hangup XML', async () => {
    const r = rig!;
    let done = false;
    r.carrier.setScript(() => ({
      name: 'forged answer via a worker',
      steps: [
        { do: 'post', to: 'answer', params: { CallStatus: 'in-progress' }, sign: { token: r.otherCarrier.authToken } },
        { do: 'waitFor', until: () => done, what: 'the check' },
        { do: 'hangup', status: 'no-answer' },
      ],
    }));
    const { campaignId } = await plivoCampaign(r);
    station = await joinAgent(r, campaignId);
    const call = await waitFor('the dial', () => r.carrier.callOrder[0]);
    await waitFor('the forged answer', () => call.callbacks.length === 1);
    expect(call.callbacks[0]).toMatchObject({ to: 'answer', status: 200, body: PLIVO_HANGUP_XML });
    expect(worker!.requests('carrier.plivo_callback')).toHaveLength(1);
    expect(await callRow(call.callId)).toMatchObject({ status: 'initiating', answered_at: null });
    done = true;
    await r.carrier.settled();
    expect(call.statusesFor('hangup')).toEqual([200]);
  }, 60_000);
});

describe('several media workers: a callback reaches the worker its route hint names, and no other', () => {
  beforeEach(() => startCluster(2, 1));

  it('a call placed by worker 1: ring, answer and hangup forwarded to worker 1, none to worker 0', async () => {
    const r = rig!;
    r.carrier.setScript(() => ({
      name: 'answered via worker 1',
      steps: [{ do: 'ring' }, { do: 'answer' }, { do: 'connect' }, { do: 'start' }, { do: 'hangup' }],
    }));
    const { campaignId } = await plivoCampaign(r);
    station = await joinAgent(r, campaignId);
    const call = await waitFor('the dial', () => r.carrier.callOrder[0]);
    expect(call.request.answer_url).toMatch(/&w=1$/);
    expect(call.request.hangup_url).toMatch(/&w=1$/);
    await r.carrier.settled();

    expect(call.errors).toEqual([]);
    expect(call.callbacks.map((c) => [c.to, c.status])).toEqual([['ring', 200], ['answer', 200], ['hangup', 200]]);
    // The answer XML came from worker 1, with its hint in the stream URL.
    expect(call.streamUrl).toMatch(/\/pstn-stream\?token=[0-9a-f-]{36}&w=1$/);
    const kinds = (w: FakeChildProcess) => w.requests('carrier.plivo_callback').map((q) => (q.body as { kind: string }).kind);
    expect(kinds(workers[1]!)).toEqual(['status', 'answer', 'status']);
    expect(kinds(workers[0]!)).toEqual([]);
    const row = await waitFor('terminal', async () => {
      const x = await callRow(call.callId);
      return x?.ended_at ? x : null;
    });
    expect(row).toMatchObject({ provider_call_id: call.callUuid, telephony_credential_id: r.credentialId });
  }, 60_000);
});
