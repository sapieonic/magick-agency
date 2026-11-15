import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RC1 end to end, through the WHOLE voice path against the scriptable mock VoiceLink carrier:
 * the real app over real sockets, the real `WebRtcBridgeManager`, provider registry and
 * `VoicelinkAdapter`, real Postgres and Redis.
 *
 * VoiceLink is never told whether to record (its `add_lead` has no such field), and the mock,
 * like the real carrier, posts a `recordingUrl` on `call.completed` for every answered call.
 * Two calls on one account that allows recording: one whose campaign records, one whose campaign
 * does not. The one that did not ask has nothing stored (the raw row, not a read through the
 * predicate), nothing served by the signed playback route, and is counted once in
 * `recording_discarded_unrequested_total{provider="voicelink"}`. The other keeps its recording.
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
// A real meter, installed before the metric modules create their instruments.
const { reader } = await vi.hoisted(async () => {
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  return { reader: installMetricReader() };
});

import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { metricValue } from '../../helpers/otel-metric-reader.js';
import { signRecordingUrl } from '../../../src/utils/recording-url.js';
import { carrierScripts, type LeadRequest } from '../../mocks/voicelink/index.js';
import {
  LOAD_ACCOUNT, LOAD_TENANT, LoadStationSocket, assertNoLeaks, closeLoadDb, dialBridged, initLoadDb,
  startLoadRig, stopLoadRig, waitAllTerminal, waitFor, type LoadRig,
} from '../load/voicelink-load-harness.js';

let rig: LoadRig | null = null;

const OFF = '9870000101';
const ON = '9870000102';
const REC_OFF = 'https://recording.app.voicelink.co.in/client_1150/mock/off.mp3';
const REC_ON = 'https://recording.app.voicelink.co.in/client_1150/mock/on.mp3';

describe('VoiceLink records a call with recording off (RC1)', () => {
  beforeAll(() => initLoadDb(8));
  beforeEach(async () => { rig = await startLoadRig(); });
  afterEach(async () => { await stopLoadRig(rig); rig = null; });
  afterAll(async () => { await closeLoadDb(); });

  it('nothing stored, nothing served, counted once; the call that asked keeps its recording', async () => {
    const r = rig!;
    const scripts = new Map([
      [OFF, carrierScripts.answered({ pattern: [true, false, true], recordingUrl: REC_OFF }).script],
      [ON, carrierScripts.answered({ pattern: [true, false, true], recordingUrl: REC_ON }).script],
    ]);
    r.carrier.setScript((lead: LeadRequest) => scripts.get(lead.customer_number) ?? null);
    const before = (await metricValue(reader, 'recording_discarded_unrequested_total', { provider: 'voicelink' })) ?? 0;

    const offStation = new LoadStationSocket();
    const onStation = new LoadStationSocket();
    const off = await dialBridged(r, offStation, `+91${OFF}`, { record: false });
    const on = await dialBridged(r, onStation, `+91${ON}`, { record: true });
    await r.carrier.settled();
    // Every webhook (call.completed included, which can land after teardown) has been posted:
    // wait for the call that asked to have its recording, then read both raw rows.
    await waitFor('the recorded call\'s URL', async () => (await waitAllTerminal(r, [off.callId, on.callId])).get(on.callId)?.recording_url);
    const { rows } = await getTestPool().query<{ id: string; recording_requested: boolean; recording_url: string | null; status: string }>(
      'SELECT id, recording_requested, recording_url, status FROM agency_calls WHERE id = ANY($1::uuid[])', [[off.callId, on.callId]]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(off.callId)).toMatchObject({ recording_requested: false, recording_url: null, status: 'completed' });
    expect(byId.get(on.callId)).toMatchObject({ recording_requested: true, recording_url: REC_ON, status: 'completed' });

    // Nothing served: the signed playback route answers "no recording" for the call that did
    // not ask, whatever the carrier did.
    const signed = (callId: string) => signRecordingUrl({ callId, tenantId: LOAD_TENANT, accountId: LOAD_ACCOUNT }).path;
    const offPlay = await r.app.inject({ method: 'GET', url: signed(off.callId) });
    expect(offPlay.statusCode).toBe(404);

    expect(await metricValue(reader, 'recording_discarded_unrequested_total', { provider: 'voicelink' })).toBe(before + 1);
    await assertNoLeaks(r, [offStation, onStation]);
  });
});
