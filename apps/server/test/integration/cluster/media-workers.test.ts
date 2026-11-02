import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { flushTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import { createRng } from '../../helpers/load-scale.js';
import { MockVoicelinkCarrier, carrierScripts, type LeadRequest } from '../../mocks/voicelink/index.js';
import { startClusterServer, type ClusterServer } from '../../helpers/cluster-server.js';
import { ClusterFloor } from '../../helpers/cluster-floor.js';
import { slotFor } from '../../../src/cluster/roles.js';

/*
 * MEDIA_WORKERS end to end (docs/scaling.md §3): the real server entry, as a process tree
 * (a primary and two forked media workers), against the mock VoiceLink carrier. Nothing in
 * the call path is faked: the primary accepts every upgrade and hands it to the session's
 * worker; pacing in the primary dispatches each dial over IPC to the owner; the worker
 * places it (`add_lead` with `&w=<slot>` in the carrier's URLs), the carrier's media
 * socket and status posts reach that worker through the primary, and the worker relays
 * the audio both ways. Then a graceful SIGTERM inside the 45 s grace.
 *
 * The chaos half kills one media worker mid-call: the other worker's calls keep their
 * audio, the dead slot's attempts are closed and its contacts requeued, its agents are
 * written offline, and the slot comes back.
 */

const TENANT = '7a1d0c8e-3d0e-4c7a-8b44-1f6b0a000001';
const ACCOUNT = '7a1d0c8e-3d0e-4c7a-8b44-1f6b0a000002';
const AGENTS = 6;
const NO_RETRY = Object.fromEntries(
  ['no_answer', 'busy', 'failed', 'abandoned', 'agent_disconnected', 'orphaned', 'canceled'].map((o) => [o, { max_attempts: 0 }]),
);

interface Rig {
  carrier: MockVoicelinkCarrier;
  server: ClusterServer;
  floor: ClusterFloor;
  campaignId: string;
}

/**
 * `contacts` contacts; agents joined until each of the two slots holds at least
 * `perSlot` (session ids are random, so a fixed count could land on one slot).
 */
async function startRig(contacts: number, frames: number, perSlot = 2): Promise<Rig> {
  await truncateAll();
  await flushTestRedis();
  await getTestPool().query(
    'INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls, allow_recording) VALUES ($1, $2, $3, true)',
    [TENANT, ACCOUNT, 10_000],
  );
  const campaign = await insertAgencyCampaign({
    tenant_id: TENANT, account_id: ACCOUNT, status: 'running', wrapup_seconds: 0,
    disposition_catalog: JSON.stringify([]), retry_policy: JSON.stringify(NO_RETRY),
  });
  const rng = createRng(4242);
  const plans = new Map<string, carrierScripts.ScriptedOutcome>();
  for (let i = 0; i < contacts; i++) {
    const national = `96${String(10_000_000 + i).padStart(8, '0')}`;
    await insertAgencyContact(campaign.id as string, { tenant_id: TENANT, account_id: ACCOUNT, phone_e164: `+91${national}`, source_row_number: i + 1 });
    plans.set(national, carrierScripts.answered({ pattern: carrierScripts.framePattern(rng, frames) }));
  }
  let origin = '';
  const carrier = new MockVoicelinkCarrier({ targetOrigin: () => origin });
  carrier.setScript((lead: LeadRequest) => plans.get(lead.customer_number)?.script ?? null);
  await carrier.start();
  const server = await startClusterServer({
    MEDIA_WORKERS: '2',
    FF_AGENCY_DIALER: 'true',
    TELEPHONY_ENABLED_PROVIDERS: 'voicelink',
    VOICELINK_BASE_URL: carrier.baseUrl,
    VOICELINK_USERNAME: carrier.username,
    VOICELINK_PASSWORD: carrier.password,
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    RATE_LIMIT_STATION_MAX: '1000000',
    LOG_LEVEL: process.env['CLUSTER_TEST_LOG_LEVEL'] ?? 'warn',
  });
  origin = server.origin;
  const floor = new ClusterFloor(server.origin);
  const perSlotCount = [0, 0];
  for (let i = 0; i < 40 && (perSlotCount[0]! < perSlot || perSlotCount[1]! < perSlot || i < AGENTS); i++) {
    const agent = await floor.join({
      tenantId: TENANT, accountId: ACCOUNT, campaignId: campaign.id as string,
      agentUserId: `7a1d0c8e-3d0e-4c7a-8b44-${String(i).padStart(12, '0')}`,
    });
    perSlotCount[slotFor(agent.sessionId, 2)]!++;
  }
  floor.startPings();
  return { carrier, server, floor, campaignId: campaign.id as string };
}

async function until(what: string, ms: number, check: () => Promise<boolean> | boolean, diag?: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}${diag ? ` (${await diag()})` : ''}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function stopRig(rig: Rig | null): Promise<void> {
  if (!rig) return;
  await rig.floor.close();
  if (rig.server.child.exitCode === null) await rig.server.stop();
  await rig.carrier.stop?.();
}

describe('media workers: the real server as a primary and two workers', () => {
  let rig: Rig | null = null;
  beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 8 }); });
  afterAll(async () => { await stopRig(rig); await closePool(); await closeTestPool(); }, 120_000);

  it('dials, bridges and relays through the workers that own the sessions, then stops gracefully inside the grace', async () => {
    rig = await startRig(12, 100);
    const r = rig;
    const detail = await r.server.detail();
    expect(detail.status).toBe('ready');
    expect(detail.processes?.map((p) => p?.role)).toEqual(['media', 'media']);

    // Each station is held by the worker its session hashes to.
    for (const a of r.floor.agents) {
      const raw = await r.floor.redisClient.get(`agency:station:${a.sessionId}`);
      const replicaId = (JSON.parse(raw!) as { replicaId: string }).replicaId;
      expect(replicaId).toMatch(new RegExp(`:mw${slotFor(a.sessionId, 2)}:`));
    }

    r.floor.startTalking();
    await until('campaign completed', 120_000, async () => {
      const { rows } = await getTestPool().query<{ status: string }>('SELECT status FROM agency_campaigns WHERE id = $1', [r.campaignId]);
      return rows[0]?.status === 'completed';
    }, async () => {
      const { rows } = await getTestPool().query('SELECT state, count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 GROUP BY state', [r.campaignId]);
      return `contacts ${JSON.stringify(rows)}, carrier calls ${r.carrier.callOrder.length}\n${r.server.output.slice(-15).join('\n')}`;
    });
    r.floor.stopTalking();

    const { rows: attempts } = await getTestPool().query<{ outcome: string; reserved_agent_id: string; bridged_at: Date | null }>(
      'SELECT outcome, reserved_agent_id, bridged_at FROM agency_call_attempts WHERE campaign_id = $1', [r.campaignId]);
    expect(attempts).toHaveLength(12);
    expect(attempts.every((a) => a.outcome === 'connected' && a.bridged_at !== null)).toBe(true);
    // Both workers served calls, and every carrier stream reached its agent's worker.
    const slots = new Set(attempts.map((a) => slotFor(a.reserved_agent_id, 2)));
    expect(slots.size).toBe(2);
    for (const call of r.carrier.callOrder) {
      expect(call.lead.websocket_url).toMatch(/&w=[01]$/);
      expect(call.mediaReceived.length).toBeGreaterThan(0); // the agent's audio reached the carrier
    }
    // Every agent that took a call heard the customer.
    const tookCalls = new Set(attempts.map((a) => a.reserved_agent_id));
    for (const a of r.floor.agents) if (tookCalls.has(a.sessionId)) expect(a.heard).toBeGreaterThan(0);
    const { rows: calls } = await getTestPool().query<{ status: string }>('SELECT status FROM agency_calls');
    expect(calls.every((c) => c.status === 'completed')).toBe(true);

    const stopped = await r.server.stop();
    expect(stopped.code, `${JSON.stringify(stopped)}\n${r.server.output.filter((l) => /shutting|stopp|closed|exit|drain|halt|killed|Child|shutdown/i.test(l)).slice(-40).join('\n')}`).toBe(0);
    expect(stopped.ms).toBeLessThan(45_000);
    await r.floor.close();
    await r.carrier.stop?.();
    rig = null;
  }, 240_000);

  it('a media worker killed mid-call: the other keeps its audio, the dead slot is reaped and comes back', async () => {
    rig = await startRig(40, 3_000); // 60 s calls: still live when the worker is killed
    const r = rig;
    const agents = r.floor.agents.length;
    r.floor.startTalking();
    await until('every agent on a bridged call', 60_000, async () => {
      const { rows } = await getTestPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = $1 AND bridged_at IS NOT NULL AND state <> 'ended'`, [r.campaignId]);
      return rows[0]!.n === agents;
    });
    const before = await r.server.detail();
    const deadPid = before.processes![0]!.pid;
    const survivors = r.floor.agents.filter((a) => slotFor(a.sessionId, 2) === 1);
    const victims = r.floor.agents.filter((a) => slotFor(a.sessionId, 2) === 0);
    expect(survivors.length).toBeGreaterThan(0);
    expect(victims.length).toBeGreaterThan(0);

    process.kill(deadPid, 'SIGKILL');
    const heardAtKill = survivors.map((a) => a.heard);

    // The dead slot's attempts are closed and their contacts requeued; its agents are offline.
    await until('dead slot reaped', 30_000, async () => {
      const { rows } = await getTestPool().query<{ reserved_agent_id: string; state: string; outcome: string | null }>(
        'SELECT reserved_agent_id, state, outcome FROM agency_call_attempts WHERE campaign_id = $1', [r.campaignId]);
      const dead = rows.filter((x) => slotFor(x.reserved_agent_id, 2) === 0);
      return dead.length > 0 && dead.every((x) => x.state === 'ended' && x.outcome === 'orphaned');
    });
    const { rows: sessions } = await getTestPool().query<{ id: string; state: string }>('SELECT id, state FROM agency_agent_sessions');
    for (const s of sessions) if (slotFor(s.id, 2) === 0) expect(s.state).toBe('offline');
    // The survivors' calls never stopped: their stations kept hearing the customer.
    await new Promise((res) => setTimeout(res, 2_000));
    survivors.forEach((a, i) => expect(a.heard - heardAtKill[i]!).toBeGreaterThan(50));
    const { rows: live } = await getTestPool().query<{ reserved_agent_id: string }>(
      `SELECT reserved_agent_id FROM agency_call_attempts WHERE campaign_id = $1 AND state <> 'ended'`, [r.campaignId]);
    expect(live.map((x) => x.reserved_agent_id).sort()).toEqual(survivors.map((a) => a.sessionId).sort());

    // The slot comes back with a new process.
    await until('slot 0 back', 30_000, async () => {
      const d = await r.server.detail().catch(() => null);
      const p0 = d?.processes?.[0];
      return d?.status === 'ready' && !!p0 && p0.pid !== deadPid;
    });

    // And the whole tree still stops gracefully, with the survivors' calls live.
    r.floor.stopTalking();
    const stopped = await r.server.stop();
    expect(stopped.code).toBe(0);
    expect(stopped.ms).toBeLessThan(45_000);
  }, 240_000);

  it('the primary killed: its workers exit on their own, and the next boot closes everything they held', async () => {
    rig = await startRig(40, 3_000);
    const r = rig;
    const agents = r.floor.agents.length;
    r.floor.startTalking();
    await until('every agent on a bridged call', 60_000, async () => {
      const { rows } = await getTestPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = $1 AND bridged_at IS NOT NULL AND state <> 'ended'`, [r.campaignId]);
      return rows[0]!.n === agents;
    });
    const workerPids = (await r.server.detail()).processes!.map((p) => p!.pid);
    r.server.child.kill('SIGKILL');
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await until('workers gone', 20_000, () => workerPids.every((pid) => !alive(pid)));
    r.floor.stopTalking();

    // A new primary's startup reap (before any worker exists) ends every orphaned attempt.
    const next = await startClusterServer({ MEDIA_WORKERS: '2', LOG_LEVEL: 'warn' });
    try {
      const { rows } = await getTestPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = $1 AND state <> 'ended'`, [r.campaignId]);
      expect(rows[0]!.n).toBe(0);
      const { rows: sessions } = await getTestPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agency_agent_sessions WHERE left_at IS NULL AND state <> 'offline'`);
      expect(sessions[0]!.n).toBe(0);
    } finally {
      const stopped = await next.stop();
      expect(stopped.code).toBe(0);
    }
  }, 240_000);
});

