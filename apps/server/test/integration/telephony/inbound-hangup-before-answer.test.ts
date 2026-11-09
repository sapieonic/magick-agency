// QA-F4, end to end: the caller gives up while our answer is still in flight, so Plivo's hangup
// callback reaches us BEFORE the answer webhook completes. The hangup finds no spine row; the
// router remembers it, and the answer that follows ends the freshly written row at once as the
// caller who left (`abandoned_in_queue`, its Missed row and callback) and answers `<Hangup/>`:
// no stream promised, no bridge session or slot held until the media deadline, never `failed`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { env } = vi.hoisted(() => {
  const e = {
    FF_AGENCY_DIALER: 'true',
    PLIVO_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/plivo',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    PLIVO_REQUEST_TIMEOUT_MS: '3000',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    LOG_LEVEL: 'warn',
  };
  Object.assign(process.env, e);
  return { env: e };
});

import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { closePlivoDb, initPlivoDb, startPlivoRig, waitFor, type PlivoRig } from './plivo-rig.js';
import { campaign, contact, ring, spineOf, startInboundWorld, type InboundWorld } from './inbound-connect-rig.js';

const pool = () => getTestPool();
let rig: PlivoRig | null = null;
let world: InboundWorld;

beforeAll(() => { void env; initPlivoDb(); });
beforeEach(async () => {
  rig = await startPlivoRig();
  world = await startInboundWorld(rig);
});
afterEach(async () => { await rig?.carrier.settled(); await rig?.stop(); rig = null; });
afterAll(closePlivoDb);

describe('the hangup callback lands before the answer completes (QA-F4)', () => {
  it('the answer ends the call at once as the caller who left: abandoned_in_queue with its follow-up, `<Hangup/>`, nothing held', async () => {
    const campaignId = await campaign(world);
    const contactId = await contact(campaignId, { next_attempt_at: new Date(Date.now() + 86_400_000) });
    const startedAt = Date.now();
    const call = ring(world, [
      // The caller gave up: Plivo's hangup for this CallUUID first, then the answer webhook.
      { do: 'post', to: 'hangup', params: { CallStatus: 'completed', HangupSource: 'Caller', HangupCause: 'NORMAL_CLEARING' } },
      { do: 'answer' },
    ]);
    const row = await waitFor('the spine ended', async () => {
      const r = call.callUuid ? await spineOf(call) : null;
      return r?.state === 'ended' ? r : null;
    }, 10_000, async () => JSON.stringify({ spine: call.callUuid ? await spineOf(call) : null, errors: call.errors }));
    await rig!.carrier.settled();

    // At once, not at the 30 s media deadline.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(call.answerXml).toContain('<Hangup');
    expect(call.answerXml).not.toContain('<Stream');
    expect(row).toMatchObject({
      outcome: 'abandoned_in_queue', follow_up_status: 'open', follow_up_reason: 'abandoned_in_queue',
      settled_at: expect.any(Date), bridged_at: null,
    });
    // The caller rang and left: followed up, as any caller who hung up in the queue.
    const { rows } = await pool().query<{ callback_source: string | null }>('SELECT callback_source FROM agency_contacts WHERE id = $1', [contactId]);
    expect(rows[0]!.callback_source).toBe('inbound');
    // No stream was taken: nothing is held in the bridge, and the route's live count is empty.
    expect(rig!.bridge.getActiveCount()).toBe(0);
    const { rows: live } = await pool().query(`SELECT 1 FROM agency_inbound_calls WHERE state <> 'ended'`);
    expect(live).toHaveLength(0);
  }, 30_000);
});
