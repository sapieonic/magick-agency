import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The campaign script on the bootstrap (BE-8) and the customer's typed facts on the panel (BE-6),
 * end to end: the real app over HTTP (the public route, `callCore`, the internal handler), the
 * real runtime, bridge, Redis and Postgres; only the carrier is faked (as
 * `wrapup-redial-e2e.test.ts` does).
 *
 *  1. A campaign with a script and column roles: the agent's join carries `script` as stored, and
 *     the paced call's `reserved` frame carries `facts` built from the contact's roster row: the
 *     name and place by their roles, the amount and due date parsed, an unreadable value `null`
 *     with its raw text, a hidden column nowhere.
 *  2. AS19: a campaign with `context_display.facts`: the paced call's tiles are exactly those
 *     facts (at most four), each with its label and key, the highlighted one first, typed by
 *     `types` alone; `hero` is not read for tiles.
 *  3. A campaign with no script (`{}`, the column default, or one with no opening and no steps):
 *     the join carries no `script` at all.
 *
 * The settings routes that write both: `test/integration/api/agent-station-campaign-settings.test.ts`.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'station-script-facts-e2e-secret-0123456789';
  process.env['FF_AGENCY_DIALER'] = 'true';
  process.env['MAX_CONCURRENT_CALLS'] = '20';
  process.env['VOICELINK_WEBHOOK_BASE_URL'] = 'https://agency.test/api/v1/webhooks/voicelink';
  return {
    verifyIdToken: vi.fn(),
    fakeAdapter: {
      name: 'voicelink',
      capabilities: { cancelRinging: false, queuesOutboundDials: true },
      initiateCall: vi.fn(async (req: { callId: string }) => ({ providerCallId: `carrier-${req.callId}` })),
      endCall: vi.fn(async () => undefined),
    },
  };
});

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() { return mocks.fakeAdapter; }
  },
}));

import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { resetVoiceEngineForTests, startVoice } from '../../../src/bootstrap/voice.js';

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v as T;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Who { id: string; tok: string }
type Frame = Record<string, any>;

const SCRIPT = {
  opening: 'Namaste {name}, I am {agent_name} calling from {campaign_name}.',
  steps: [{ text: 'Tell them {amount_due} is due on {due_date}.' }, { text: 'Ask when they can pay.' }],
};

const DISPLAY = {
  hero: ['Loan No', 'Amount Due', 'Due Date', 'Limit'],
  hidden: ['Aadhaar'],
  roles: { name: 'Customer Name', place: 'City', amount_due: 'Amount Due', due_date: 'Due Date' },
  types: { Limit: 'money' },
};

const ROW = {
  'Customer Name': 'Ramesh Goud',
  City: 'Hyderabad',
  'Loan No': 'LN-0042',
  'Amount Due': '₹1,25,000',
  'Due Date': '25/11/2026',
  Limit: 'about 2 lakh',
  Aadhaar: '1234 5678 9012',
};

describe('the script on the join and the facts on the call — real app, real runtime, fake carrier (integration)', () => {
  let app: FastifyInstance;
  let port = 0;
  let stopAgency: (() => Promise<void>) | null = null;
  let stopVoice: (() => Promise<void>) | null = null;
  const sockets: WebSocket[] = [];
  let tenant: string;
  let account: string;

  function headers(who: Who): Record<string, string> {
    return { authorization: `Bearer ${who.tok}`, 'x-tenant-id': tenant, 'x-account-id': account, 'content-type': 'application/json' };
  }
  const post = (url: string, who: Who, body: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: headers(who), payload: JSON.stringify(body) });

  async function newAgent(): Promise<Who> {
    const u = await insertUser();
    await insertMembership({ user_id: u.id, tenant_id: tenant, account_id: account, role: 'agent' });
    return { id: u.id as string, tok: `tok:${u.firebase_uid as string}` };
  }

  async function join(agent: Who, campaignId: string): Promise<Record<string, any>> {
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)`,
      [tenant, account, campaignId, agent.id],
    );
    const joined = await post('/proxy/agency/sessions', agent, { campaign_id: campaignId });
    expect(joined.statusCode, joined.body).toBe(201);
    return joined.json();
  }

  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 8 });
    mocks.verifyIdToken.mockImplementation(async (token: string) => {
      if (!token.startsWith('tok:')) throw new Error('bad token');
      return { uid: token.slice(4), email: 'script@example.com', email_verified: true };
    });
    await truncateAll();
    await flushTestRedis();
    resetVoiceEngineForTests();
    await resetAgencyRuntimeForTests();

    tenant = (await insertTenant()).id as string;
    account = (await insertAccount({ tenant_id: tenant })).id as string;
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, allow_recording, analyze_calls, max_concurrent_calls)
       VALUES ($1, $2, false, false, 20)`,
      [tenant, account],
    );

    const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
    app = await buildApp({ ctx });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    stopVoice = await startVoice(ctx);
    stopAgency = await startAgency(ctx);
  });

  afterAll(async () => {
    await getTestPool().query("UPDATE agency_campaigns SET status = 'completed' WHERE account_id = $1", [account]).catch(() => undefined);
    for (const ws of sockets.splice(0)) {
      if (ws.readyState !== WebSocket.CLOSED) {
        const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
        ws.close();
        await closed;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
    if (stopAgency) await stopAgency();
    if (stopVoice) await stopVoice();
    await app?.close();
    await resetAgencyRuntimeForTests();
    resetVoiceEngineForTests();
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  it('1. the join carries the script; the paced call carries the customer\'s facts', async () => {
    const campaign = await insertAgencyCampaign({
      tenant_id: tenant, account_id: account, status: 'running', name: 'November dues',
      wrapup_seconds: 60, wrapup_auto_return: true,
      agent_script: JSON.stringify(SCRIPT), context_display: JSON.stringify(DISPLAY),
    });
    const contact = await insertAgencyContact(campaign.id, {
      tenant_id: tenant, account_id: account, phone_e164: '+919812360001', context: JSON.stringify(ROW),
    });
    const agent = await newAgent();

    const boot = await join(agent, campaign.id);
    expect(boot.script).toEqual(SCRIPT);
    expect(boot.context_display).toEqual(DISPLAY);

    const frames: Frame[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${boot.station_ws_url}`);
    sockets.push(ws);
    ws.on('message', (raw, isBinary) => { if (!isBinary) frames.push(JSON.parse(raw.toString())); });
    await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
    const avail = await post(`/proxy/agency/sessions/${boot.session_id}/available`, agent);
    expect(avail.statusCode, avail.body).toBe(200);

    const reserved = await waitFor('reserved', () => frames.find((f) => f['event'] === 'reserved')?.['attempt']);
    expect(reserved.contact_id).toBe(contact.id);
    expect(reserved.facts).toEqual({
      name: 'Ramesh Goud',
      place: 'Hyderabad',
      tiles: [
        { column: 'Loan No', type: 'text', raw: 'LN-0042', value: null },
        { column: 'Amount Due', role: 'amount_due', type: 'money', raw: '₹1,25,000', value: '125000' },
        { column: 'Due Date', role: 'due_date', type: 'date', raw: '25/11/2026', value: '2026-11-25' },
        { column: 'Limit', type: 'money', raw: 'about 2 lakh', value: null },
      ],
      // AS20: More details, every other column (not the name, the place or a hidden one; a legacy
      // card's client leaves out the tiles it drew), the role columns read as the card reads them.
      // With no `order` and no import (this roster is written directly), in the row's own key order
      // as the database gives it back (jsonb: shorter keys first); a real campaign's imports give
      // the file's order (`AgencyDialer.columnOrderOf`).
      more: [
        { column: 'Limit', type: 'money', raw: 'about 2 lakh', value: null },
        { column: 'Loan No', type: 'text', raw: 'LN-0042', value: null },
        { column: 'Due Date', type: 'date', raw: '25/11/2026', value: '2026-11-25' },
        { column: 'Amount Due', type: 'money', raw: '₹1,25,000', value: '125000' },
      ],
    });
    expect(JSON.stringify(reserved.facts)).not.toContain('1234 5678 9012');
    // The raw row still travels as before (the hidden rule is the client's for `context`).
    expect(reserved.context).toEqual(ROW);
  });

  it('2. AS19: a campaign with chosen facts: the call\'s tiles are those facts, labelled and keyed, the highlight first', async () => {
    const display = {
      hero: ['Loan No', 'Limit'],
      hidden: ['Aadhaar'],
      // AS20: More details follows `order` before the row's own key order.
      order: ['Customer Name', 'Loan No', 'Limit'],
      roles: { name: 'Customer Name', place: 'City' },
      types: { 'Amount Due': 'money', 'Due Date': 'date', Tenure: 'number', 'Auto Debit': 'yes_no', 'Alt Phone': 'phone' },
      facts: [
        { column: 'Due Date', label: 'Due on', key: 'due_date' },
        { column: 'Tenure', label: 'Tenure (months)', key: 'tenure' },
        { column: 'amount due', label: 'Amount due', key: 'amount_due', highlight: true },
        { column: 'Auto Debit', label: 'Auto debit on', key: 'auto_debit' },
        // A fifth would be refused at the write; one written by hand is cut at the card's four.
        { column: 'Alt Phone', label: 'Other number', key: 'alt_phone' },
      ],
    };
    const script = { opening: 'Namaste {name}. {amount_due} is due on {due_date}; auto debit: {auto_debit}.' };
    const campaign = await insertAgencyCampaign({
      tenant_id: tenant, account_id: account, status: 'running', name: 'Chosen facts',
      wrapup_seconds: 60, wrapup_auto_return: true,
      agent_script: JSON.stringify(script), context_display: JSON.stringify(display),
    });
    const contact = await insertAgencyContact(campaign.id, {
      tenant_id: tenant, account_id: account, phone_e164: '+919812360002',
      context: JSON.stringify({ ...ROW, Tenure: '24', 'Auto Debit': 'Haan', 'Alt Phone': '098765 43210' }),
    });
    const agent = await newAgent();

    const boot = await join(agent, campaign.id);
    expect(boot.script).toEqual(script);
    expect(boot.context_display).toEqual(display);

    const frames: Frame[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${boot.station_ws_url}`);
    sockets.push(ws);
    ws.on('message', (raw, isBinary) => { if (!isBinary) frames.push(JSON.parse(raw.toString())); });
    await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
    const avail = await post(`/proxy/agency/sessions/${boot.session_id}/available`, agent);
    expect(avail.statusCode, avail.body).toBe(200);

    const reserved = await waitFor('reserved', () => frames.find((f) => f['event'] === 'reserved')?.['attempt']);
    expect(reserved.contact_id).toBe(contact.id);
    expect(reserved.facts).toEqual({
      name: 'Ramesh Goud',
      place: 'Hyderabad',
      tiles: [
        { column: 'Amount Due', label: 'Amount due', key: 'amount_due', highlight: true, role: 'amount_due', type: 'money', raw: '₹1,25,000', value: '125000' },
        { column: 'Due Date', label: 'Due on', key: 'due_date', role: 'due_date', type: 'date', raw: '25/11/2026', value: '2026-11-25' },
        { column: 'Tenure', label: 'Tenure (months)', key: 'tenure', type: 'number', raw: '24', value: '24' },
        { column: 'Auto Debit', label: 'Auto debit on', key: 'auto_debit', type: 'yes_no', raw: 'Haan', value: 'yes' },
      ],
      // AS20: the columns that are neither the name, the place, a fact nor hidden, in `order`.
      more: [
        { column: 'Loan No', type: 'text', raw: 'LN-0042', value: null },
        { column: 'Limit', type: 'text', raw: 'about 2 lakh', value: null },
      ],
    });
    // `hero` is not read for tiles once `facts` is set, and a hidden column is nowhere.
    expect(reserved.facts.tiles.map((t: { column: string }) => t.column)).not.toContain('Loan No');
    expect(JSON.stringify(reserved.facts)).not.toContain('1234 5678 9012');
  });

  it('3. a campaign with no script: the join carries no script at all', async () => {
    const none = await insertAgencyCampaign({ tenant_id: tenant, account_id: account, status: 'paused' });
    const empty = await insertAgencyCampaign({
      tenant_id: tenant, account_id: account, status: 'paused', agent_script: JSON.stringify({ opening: '', steps: [] }),
    });
    expect((await getTestPool().query('SELECT agent_script FROM agency_campaigns WHERE id = $1', [none.id])).rows[0].agent_script).toEqual({});

    const first = await join(await newAgent(), none.id);
    expect(first).not.toHaveProperty('script');
    const second = await join(await newAgent(), empty.id);
    expect(second).not.toHaveProperty('script');
  });
});
