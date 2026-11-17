import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Live call listening on Plivo (docs/listening.md §4), through the whole server against the mock
 * Plivo carrier (`plivo-rig.ts`, `inbound-connect-rig.ts`): the customer's leg is μ-law, which the
 * tap transcodes with its own codec, and the agent's leg `pcm16`, which it encodes. Two variants
 * the VoiceLink suite (`test/integration/agency/live-listen-e2e.test.ts`) cannot reach:
 *  - an outbound dialler call on a tenant's own Plivo account: both legs reach the listener tagged,
 *    as 161-byte messages;
 *  - an inbound caller: parked on hold with no agent bound it is not live (absent from the list, the
 *    grant 404); once put through to an agent it is listed (origin `inbound`, its route) and heard.
 */

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
const fb = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: fb.verifyIdToken }));

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import {
  ACCOUNT, PLIVO_E2E_ENV, TENANT, closePlivoDb, initPlivoDb, joinAgent as joinPlivoAgent, plivoCampaign, startPlivoRig, waitFor,
  type PlivoRig,
} from './plivo-rig.js';
import {
  agentTalks, busyAgent, callerScript, callers, campaign, goAvailable, ring, spineWhen, startInboundWorld, type InboundWorld,
} from './inbound-connect-rig.js';

const pool = () => getTestPool();

interface User { id: string; uid: string }

async function supervisorUser(): Promise<User> {
  const id = randomUUID();
  const uid = `fb-sup-${id.slice(0, 8)}`;
  await pool().query('INSERT INTO users (id, firebase_uid, email) VALUES ($1, $2, $3)', [id, uid, `${uid}@example.test`]);
  await pool().query(`INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, 'account_admin')`, [id, TENANT, ACCOUNT]);
  return { id, uid };
}

async function listenFlagOn(): Promise<void> {
  await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Main', 'main') ON CONFLICT (id) DO NOTHING`, [ACCOUNT, TENANT]);
  await pool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
     VALUES ('agency_live_listen_enabled', 'account', $1, $2, 'true'::jsonb)`, [TENANT, ACCOUNT]);
  await getFeatureFlagService().invalidate({ tenantId: TENANT });
}

function http(who: User, method: 'GET' | 'POST', url: string) {
  return rig!.app.inject({ method, url, headers: { authorization: `Bearer tok:${who.uid}`, 'x-tenant-id': TENANT, 'x-account-id': ACCOUNT } });
}

interface Listener { ws: WebSocket; frames: Array<Record<string, unknown>>; legs: { customer: number; agent: number; odd: number }; closed: number | null }

async function listen(who: User, callId: string): Promise<Listener> {
  const res = await http(who, 'POST', `/proxy/agency/live-calls/${callId}/listen`);
  expect(res.statusCode, res.body).toBe(201);
  const l: Listener = {
    ws: new WebSocket(`${rig!.origin.replace('http', 'ws')}${(res.json() as { ws_url: string }).ws_url}`),
    frames: [], legs: { customer: 0, agent: 0, odd: 0 }, closed: null,
  };
  l.ws.on('message', (raw: Buffer, isBinary) => {
    if (!isBinary) { l.frames.push(JSON.parse(raw.toString()) as Record<string, unknown>); return; }
    if (raw.length !== 161) l.legs.odd++;
    else if (raw[0] === 1) l.legs.customer++;
    else if (raw[0] === 2) l.legs.agent++;
    else l.legs.odd++;
  });
  l.ws.on('close', (code) => { l.closed = code; });
  l.ws.on('error', () => undefined);
  await waitFor('ready', () => l.frames.some((f) => f['event'] === 'ready'));
  return l;
}

let rig: PlivoRig | null = null;
let supervisor: User;

beforeAll(() => {
  expect(env).toEqual(PLIVO_E2E_ENV);
  initPlivoDb();
  fb.verifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith('tok:')) throw new Error('bad token');
    const uid = token.slice(4);
    return { uid, email: `${uid}@example.test`, email_verified: true };
  });
});
afterAll(closePlivoDb);

describe('listening on Plivo: an outbound dialler call', () => {
  let hangUp = false;
  beforeEach(async () => {
    hangUp = false;
    rig = await startPlivoRig();
    await listenFlagOn();
    supervisor = await supervisorUser();
  });
  afterEach(async () => {
    hangUp = true;
    await rig?.carrier.settled();
    await rig?.stop();
    rig = null;
  });

  it('the μ-law customer and the pcm16 agent reach the listener as tagged A-law frames; the call\'s end ends the listen', async () => {
    const r = rig!;
    r.carrier.setScript(() => ({
      name: 'listen-outbound',
      steps: [
        { do: 'ring' },
        { do: 'answer' },
        { do: 'connect' },
        { do: 'start' },
        { do: 'mediaBackground', pattern: Array.from({ length: 50 }, (_, i) => i % 2 === 0) },
        { do: 'waitFor', until: (c) => hangUp || c.hungUpByApi, what: 'the test to hang up', timeoutMs: 60_000 },
        { do: 'hangup', status: 'completed', source: 'Caller' },
        { do: 'close' },
      ],
    }));
    const { campaignId } = await plivoCampaign(r);
    const station = await joinPlivoAgent(r, campaignId);
    const attempt = await waitFor('bridged', async () => {
      const { rows } = await pool().query<{ id: string; webrtc_call_id: string | null; state: string }>(
        'SELECT id, webrtc_call_id, state FROM agency_call_attempts WHERE campaign_id = $1', [campaignId]);
      return rows[0]?.state === 'bridged' && rows[0].webrtc_call_id ? rows[0] : null;
    }, 30_000);
    const row = (await http(supervisor, 'GET', '/proxy/agency/live-calls')).json().calls[0];
    expect(row).toMatchObject({ call_id: attempt.webrtc_call_id, origin: 'campaign', correlation_id: attempt.id, listenable: true });
    const l = await listen(supervisor, attempt.webrtc_call_id!);
    const talker = setInterval(() => station.talk(1), 20);
    try {
      await waitFor('both legs', () => l.legs.customer >= 10 && l.legs.agent >= 10, 15_000, () => JSON.stringify(l.legs));
    } finally {
      clearInterval(talker);
    }
    expect(l.legs.odd).toBe(0);
    hangUp = true;
    await waitFor('the listen ended', () => l.closed);
    expect(l.closed).toBe(1000);
    expect(l.frames.at(-1)).toEqual({ event: 'ended', reason: 'call_ended' });
    await station.close();
  }, 60_000);
});

describe('listening on Plivo: an inbound caller', () => {
  let world: InboundWorld;
  beforeEach(async () => {
    callers.hangUpAll = false;
    rig = await startPlivoRig();
    world = await startInboundWorld(rig);
    await listenFlagOn();
    supervisor = await supervisorUser();
  });
  afterEach(async () => {
    callers.hangUpAll = true;
    await world?.fleet.closeAll();
    await rig?.carrier.settled();
    await rig?.stop();
    rig = null;
  });

  it('parked on hold it is not live (absent, 404); put through to an agent it is listed and heard', async () => {
    const campaignId = await campaign(world);
    // An agent on another call: someone who could take the caller later, so it waits (PM-M6).
    const agent = await busyAgent(world, campaignId);
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    // No agent free: the caller is queued, on hold.
    const queued = await spineWhen(call, 'queued', (r) => r.state === 'queued');
    const { rows: [leg] } = await pool().query<{ id: string }>('SELECT id FROM agency_calls WHERE inbound_call_id = $1', [queued.id]);
    expect(leg).toBeDefined();
    expect((await http(supervisor, 'GET', '/proxy/agency/live-calls')).json().calls).toEqual([]);
    const parked = await http(supervisor, 'POST', `/proxy/agency/live-calls/${leg!.id}/listen`);
    expect([parked.statusCode, parked.json().code]).toEqual([404, 'listen_call_not_live']);

    // The agent comes free: the caller is put through.
    await goAvailable(agent);
    const connected = await spineWhen(call, 'connected', (r) => r.state === 'connected' && r.bridged_at !== null);
    const row = await waitFor('listed', async () => (await http(supervisor, 'GET', '/proxy/agency/live-calls')).json().calls[0]);
    expect(row).toMatchObject({
      call_id: leg!.id, origin: 'inbound', correlation_id: connected.id, inbound_route_name: 'Main line',
      agent_session_id: agent.sessionId, listenable: true,
    });
    const l = await listen(supervisor, leg!.id);
    const talker = setInterval(() => agentTalks(agent, 1), 20);
    try {
      await waitFor('both legs', () => l.legs.customer >= 10 && l.legs.agent >= 10, 15_000, () => JSON.stringify(l.legs));
    } finally {
      clearInterval(talker);
    }
    expect(l.legs.odd).toBe(0);
    hangUp = true;
    await waitFor('the listen ended', () => l.closed);
    expect(l.closed).toBe(1000);
    // The row is closed after the socket (the close write is not awaited before the close frame), so
    // wait for it rather than read it once.
    const session = await waitFor('the row closed', async () => {
      const { rows: [r] } = await pool().query('SELECT origin, correlation_id, end_reason FROM agency_listen_sessions WHERE call_id = $1', [leg!.id]);
      return r?.end_reason ? r : undefined;
    });
    expect(session).toEqual({ origin: 'inbound', correlation_id: connected.id, end_reason: 'call_ended' });
  }, 60_000);
});
