import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A floor of agents dialling a campaign through the WHOLE server against the mock
 * VoiceLink carrier — nothing in the call path faked.
 *
 *  - The app is `buildApp` with a real context, listening on loopback; every agent's
 *    station socket is a REAL WebSocket upgrade into the agency plugin
 *    (`/proxy/agency/station/:sessionId`), exactly as the console opens it.
 *  - Background work is booted as `src/index.ts` does it: `startVoice` then
 *    `startAgency`, so the pacing supervisor and its tick run on their own timers and
 *    choose who to dial.
 *  - The bridge places each call through the REAL provider registry and
 *    `VoicelinkAdapter` (login + `add_lead` over HTTP to the mock). The mock then plays
 *    the carrier: per contact, a seeded outcome — answered (media socket, `start`,
 *    paced A-law, hangup), no-answer, busy or failed — with its webhooks posted to the
 *    real webhook route under the minted token.
 *
 * Everything asserted is state: each contact got exactly one attempt whose outcome is
 * the one its script implies (`connected` only when the carrier answered), each
 * `agency_calls` row is terminal with the classified status, every agent's station
 * heard exactly the audio of the calls it was bridged to, in order (`audio-pattern.ts`),
 * the campaign completed, and nothing is left behind (`assertNoLeaks`).
 *
 * Sizes are `scaled()` (default 6 agents, 24 contacts); randomness is seeded.
 */

vi.hoisted(() => {
  Object.assign(process.env, {
    FF_AGENCY_DIALER: 'true',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    VOICELINK_USERNAME: 'mock-vl-user',
    VOICELINK_PASSWORD: 'mock-vl-password',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    LOG_LEVEL: 'error',
  });
});

import WebSocket from 'ws';
import { getPool } from '@magick-agency/db';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { startVoice } from '../../../src/bootstrap/voice.js';
import { agencyAgentSessionRepository } from '../../../src/db/repositories/agency.repository.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import { createRng, LOAD_SEED, scaled } from '../../helpers/load-scale.js';
import { bits, carrierScripts, isLoudPcm16, type LeadRequest } from '../../mocks/voicelink/index.js';
import {
  LOAD_ACCOUNT, LOAD_TENANT, assertNoLeaks, closeLoadDb, initLoadDb, startLoadRig, stopLoadRig,
  waitFor, type LoadRig,
} from './voicelink-load-harness.js';

const AGENTS = scaled(6);
const CONTACTS = scaled(24);
const FRAMES = 25;
const rng = createRng(LOAD_SEED);

/** Never retried: each contact gets exactly one attempt, so the campaign can finish. */
const NO_RETRY = Object.fromEntries(
  ['no_answer', 'busy', 'failed', 'abandoned', 'agent_disconnected', 'orphaned', 'canceled'].map((o) => [o, { max_attempts: 0 }]),
);

const ATTEMPT_OUTCOME: Record<carrierScripts.ExpectedStatus, string> = {
  completed: 'connected', no_answer: 'no_answer', busy: 'busy', failed: 'failed', canceled: 'canceled',
};

interface Agent {
  sessionId: string;
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  /** Decoded PCM16 of every `media` frame this station received, in order. */
  media: Buffer[];
}

describe(`full stack: a floor of agents through the real server and the mock carrier (agents ${AGENTS}, contacts ${CONTACTS}, seed ${LOAD_SEED})`, () => {
  let rig: LoadRig | null = null;
  let stopVoice: (() => Promise<void>) | null = null;
  let stopAgency: (() => Promise<void>) | null = null;
  const agents: Agent[] = [];
  let pinger: NodeJS.Timeout | null = null;

  beforeAll(async () => {
    initLoadDb(16);
    await resetAgencyRuntimeForTests();
  });

  afterAll(async () => {
    if (pinger) clearInterval(pinger);
    // Close the stations and let the server's close handlers finish before teardown.
    await Promise.all(agents.map((a) => new Promise<void>((resolve) => {
      if (a.ws.readyState === WebSocket.CLOSED) return resolve();
      a.ws.once('close', () => resolve());
      a.ws.close();
    })));
    await waitFor('stations offline', async () => {
      const { rows } = await getTestPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM agency_agent_sessions WHERE state <> 'offline'`);
      return rows[0]!.n === '0';
    }, 15_000).catch(() => undefined);
    if (stopAgency) await stopAgency();
    if (stopVoice) await stopVoice();
    await stopLoadRig(rig);
    await resetAgencyRuntimeForTests();
    await closeLoadDb();
  });

  it('every contact is dialled once, settles with its carrier outcome, every agent hears exactly its own calls, and nothing leaks', async () => {
    rig = await startLoadRig();
    const r = rig;
    await getTestPool().query(
      'UPDATE account_settings SET allow_recording = true WHERE tenant_id = $1 AND account_id = $2',
      [LOAD_TENANT, LOAD_ACCOUNT],
    );
    const campaign = await insertAgencyCampaign({
      tenant_id: LOAD_TENANT,
      account_id: LOAD_ACCOUNT,
      status: 'running',
      wrapup_seconds: 0,
      disposition_catalog: JSON.stringify([]),
      retry_policy: JSON.stringify(NO_RETRY),
    });

    // Per contact: its number and the carrier's seeded behaviour for it.
    const plans = new Map<string, carrierScripts.ScriptedOutcome & { contactId: string }>();
    for (let i = 0; i < CONTACTS; i++) {
      const national = `97${String(10_000_000 + i).padStart(8, '0')}`;
      const outcome = carrierScripts.pickOrdinary(rng, FRAMES, { answered: 0.5, noAnswer: 0.2, busy: 0.15, failed: 0.15 });
      const contact = await insertAgencyContact(campaign.id, {
        tenant_id: LOAD_TENANT, account_id: LOAD_ACCOUNT, phone_e164: `+91${national}`, source_row_number: i + 1,
      });
      plans.set(national, { ...outcome, contactId: contact.id as string });
    }
    r.carrier.setScript((lead: LeadRequest) => plans.get(lead.customer_number)?.script ?? null);

    // Boot as index.ts does: the app is up (startLoadRig), then voice, then agency.
    const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
    stopVoice = await startVoice(ctx);
    stopAgency = await startAgency(ctx);
    const runtime = getAgencyRuntime()!;
    const port = new URL(r.origin).port;

    // The floor: each agent joins, opens a real station socket, and goes available.
    for (let i = 0; i < AGENTS; i++) {
      const join = await agencyAgentSessionRepository.joinOrRehydrate({
        tenantId: LOAD_TENANT, accountId: LOAD_ACCOUNT, campaignId: campaign.id as string,
        agentUserId: `6c1d0c8e-3d0e-4c7a-8b44-${String(i).padStart(12, '0')}`, replicaId: runtime.replicaId,
      });
      if (!join.ok) throw new Error('join refused');
      const { token } = await runtime.tokens.mint(join.session.id);
      const agent: Agent = {
        sessionId: join.session.id,
        ws: new WebSocket(`ws://127.0.0.1:${port}/proxy/agency/station/${join.session.id}?token=${token}`),
        frames: [],
        media: [],
      };
      agent.ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (frame['event'] === 'media') {
          agent.media.push(Buffer.from((frame['media'] as { payload: string }).payload, 'base64'));
        } else {
          agent.frames.push(frame);
        }
      });
      agents.push(agent);
      await waitFor(`agent ${i} ready`, () => agent.frames.some((f) => f['event'] === 'ready'));
      runtime.wrapup.cancel(agent.sessionId, 'agent_returned');
      await runtime.agents.set(agent.sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
      await agencyAgentSessionRepository.setState(agent.sessionId, 'available');
    }
    // Presence: the station heartbeat, as the console sends it.
    pinger = setInterval(() => {
      for (const a of agents) if (a.ws.readyState === WebSocket.OPEN) a.ws.send(JSON.stringify({ event: 'ping', ts: Date.now() }));
    }, 5_000);

    // ── The run: the pacing engine dials until the list is exhausted. ─────────────
    await waitFor('campaign completed', async () => {
      const { rows } = await getTestPool().query<{ status: string }>('SELECT status FROM agency_campaigns WHERE id = $1', [campaign.id]);
      return rows[0]?.status === 'completed';
    }, 90_000, async () => {
      const { rows } = await getTestPool().query('SELECT state, count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 GROUP BY state', [campaign.id]);
      return `contacts ${JSON.stringify(rows)}, carrier calls ${r.carrier.callOrder.length}, live ${r.bridge.getActiveCount()}`;
    });
    await r.carrier.settled();

    // ── One attempt per contact, with the carrier's outcome. ──────────────────────
    const { rows: attempts } = await getTestPool().query<{
      contact_id: string; outcome: string; state: string; reserved_agent_id: string; webrtc_call_id: string;
      bridged_at: Date | null; answered_at: Date | null;
    }>(
      `SELECT contact_id, outcome, state, reserved_agent_id, webrtc_call_id, bridged_at, answered_at
         FROM agency_call_attempts WHERE campaign_id = $1 ORDER BY dialed_at`,
      [campaign.id],
    );
    expect(attempts).toHaveLength(CONTACTS);
    const byContact = new Map(attempts.map((a) => [a.contact_id, a]));
    const { rows: calls } = await getTestPool().query<{ id: string; status: string; ended_at: Date | null; answered_at: Date | null }>(
      'SELECT id, status, ended_at, answered_at FROM agency_calls WHERE campaign_id = $1', [campaign.id]);
    const callById = new Map(calls.map((c) => [c.id, c]));
    expect(calls).toHaveLength(CONTACTS);

    for (const [national, p] of plans) {
      const what = `contact ${national} (${p.script.name}) seed ${LOAD_SEED}`;
      const a = byContact.get(p.contactId);
      expect(a, what).toBeDefined();
      expect({ state: a!.state, outcome: a!.outcome }, what).toEqual({ state: 'ended', outcome: ATTEMPT_OUTCOME[p.expected] });
      expect(a!.bridged_at !== null, what).toBe(p.answered);
      const call = callById.get(a!.webrtc_call_id)!;
      expect({ status: call.status, ended: call.ended_at !== null, answered: call.answered_at !== null }, what)
        .toEqual({ status: p.expected, ended: true, answered: p.answered });
    }

    // ── Every agent heard exactly the calls it was bridged to, in bridge order. ───
    for (const [i, agent] of agents.entries()) {
      const mine = attempts
        .filter((a) => a.reserved_agent_id === agent.sessionId && a.bridged_at)
        .sort((x, y) => x.bridged_at!.getTime() - y.bridged_at!.getTime());
      const expected = mine.map((a) => bits(r.carrier.calls.get(a.webrtc_call_id)!.mediaSentPattern)).join('');
      expect(bits(agent.media.map(isLoudPcm16)), `agent ${i} seed ${LOAD_SEED}`).toBe(expected);
    }
    // The work was spread over the floor rather than serialised onto one agent.
    const busyAgents = new Set(attempts.map((a) => a.reserved_agent_id));
    expect(busyAgents.size).toBeGreaterThan(1);

    // ── Nothing left behind. ─────────────────────────────────────────────────────
    expect(r.carrier.callOrder.every((c) => c.errors.length === 0)).toBe(true);
    // The agents' own station sockets stay open (the shift is not over); nothing else may.
    await assertNoLeaks(r, [], AGENTS);
  }, 120_000);
});
