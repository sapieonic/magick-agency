/**
 * Shared rig for the inbound connect suites (docs/inbound.md §2, P2): the plivo rig
 * (`plivo-rig.ts`: the real server listening on loopback, the mock Plivo carrier, the voice and
 * agency bootstraps) plus what connecting needs: the tenant's number linked to an open inbound
 * route with real clips, `agency_inbound_enabled` on for the account, agents on real station
 * sockets (the simulated fleet, `test/mocks/station-fleet.ts`), and the carrier ringing the number
 * (`ringInbound`).
 *
 * A suite sets {@link PLIVO_E2E_ENV} in its own `vi.hoisted` (config is read at import).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { mintInboundToken } from '../../../src/telephony/plivo/inbound-token.js';
import {
  plivoInboundAnswerUrl, plivoInboundFallbackUrl, plivoInboundStatusUrl, withInboundToken,
} from '../../../src/telephony/plivo/inbound-urls.js';
import { writeTtsFile } from '../../../src/tts/tts-file-cache.js';
import { parseInboundRouteCreate } from '../../../src/agency/inbound/route-config.js';
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { callCore } from '../../../src/api/core-dispatch.js';
import {
  agencyAgentSessionRepository,
  agencyInboundCallRepository,
  agencyInboundRouteRepository,
  type AgencyInboundCallRecord,
} from '../../../src/db/repositories/agency.repository.js';
import type { PlivoCall, PlivoCallStep } from '../../mocks/plivo/index.js';
import { StationFleet, type FleetAgent } from '../../mocks/station-fleet.js';
import { ACCOUNT, ADMIN, CALLER_ID, NO_RETRY, PLIVO_NUMBER, TENANT, waitFor, type PlivoRig } from './plivo-rig.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';

const pool = () => getTestPool();
export const BASE = 'https://agency.test/api/v1/webhooks/plivo';
export const CALLER = '919812345678';
export const CALLER_E164 = `+${CALLER}`;

/** Every day, all day, in UTC. */
export const ALWAYS = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '24:00' }));

export interface InboundWorld {
  rig: PlivoRig;
  token: string;
  phoneNumberId: string;
  routeId: string;
  clips: Record<'greeting' | 'hold' | 'callback' | 'notice' | 'closed' | 'busy', { id: string; hash: string; bytes: number }>;
  fleet: StationFleet;
}

/** A clip on this replica's cache (8 kHz PCM16, a tone), with its `audio_files` row. */
export async function clip(ms: number, freq = 440): Promise<{ id: string; hash: string; bytes: number }> {
  const hash = randomBytes(20).toString('hex');
  const samples = Math.round((8000 * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / 8000)), i * 2);
  writeTtsFile(hash, pcm, 8000, 1);
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO audio_files (tenant_id, account_id, name, slug, original_filename, content_type, size_bytes, s3_key,
                              pcm_audio_hash, pcm_sample_rate, pcm_channels)
     VALUES ($1, $2, $3, $3, 'clip.wav', 'audio/wav', 1, $4, $5, 8000, 1) RETURNING id`,
    [TENANT, ACCOUNT, `clip-${hash.slice(0, 8)}`, `audio/${hash}.wav`, hash]);
  return { id: rows[0]!.id, hash, bytes: samples };
}

/** `agency_inbound_enabled` for the account (the flag service's cache dropped). */
export async function setInboundFlag(on: boolean): Promise<void> {
  await pool().query(`DELETE FROM feature_flag_overrides WHERE flag_key = 'agency_inbound_enabled' AND tenant_id = $1`, [TENANT]);
  await pool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
     VALUES ('agency_inbound_enabled', 'account', $1, $2, $3::jsonb)`, [TENANT, ACCOUNT, on ? 'true' : 'false']);
  await getFeatureFlagService().invalidate({ tenantId: TENANT });
}

/** The tenant's number linked to an open route with every clip; the flag on; a fleet on the server. */
export async function startInboundWorld(rig: PlivoRig, route: Record<string, unknown> = {}): Promise<InboundWorld> {
  await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Main', 'main') ON CONFLICT (id) DO NOTHING`, [ACCOUNT, TENANT]);
  const pn = await pool().query<{ id: string }>('SELECT id FROM phone_numbers WHERE phone_number = $1', [CALLER_ID]);
  const phoneNumberId = pn.rows[0]!.id;
  const assigned = await pool().query('SELECT 1 FROM tenant_phone_assignments WHERE phone_number_id = $1 AND tenant_id = $2', [phoneNumberId, TENANT]);
  if (assigned.rowCount === 0) {
    await pool().query('INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id, assigned_by) VALUES ($1, $2, $3)', [TENANT, phoneNumberId, ADMIN]);
  }
  await pool().query('UPDATE phone_numbers SET inbound_linked_at = now() WHERE id = $1', [phoneNumberId]);
  const minted = mintInboundToken();
  const enabled = await telephonyCredentialRepository.enableInbound(rig.credentialId, {
    appId: 'app-inbound-connect-e2e',
    answerUrl: plivoInboundAnswerUrl(BASE, rig.credentialId),
    hangupUrl: plivoInboundStatusUrl(BASE, rig.credentialId),
    fallbackAnswerUrl: plivoInboundFallbackUrl(BASE),
    tokenHash: minted.tokenHash,
  }, ADMIN);
  if (!enabled) throw new Error('enableInbound refused');
  const clips = {
    greeting: await clip(200, 300), hold: await clip(200, 500), callback: await clip(300, 700),
    notice: await clip(250, 900), closed: await clip(200, 1100), busy: await clip(200, 1300),
  };
  const parsed = parseInboundRouteCreate({
    name: 'Main line', timezone: 'UTC', weekly_hours: ALWAYS,
    clips: {
      greeting: clips.greeting.id, hold: clips.hold.id, callback: clips.callback.id,
      recording_notice: clips.notice.id, closed: clips.closed.id, busy: clips.busy.id,
    },
    ...route,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const created = await agencyInboundRouteRepository.create({ tenantId: TENANT, accountId: ACCOUNT, createdBy: null, config: parsed.config });
  if (!created.ok) throw new Error('route create refused');
  const attached = await agencyInboundRouteRepository.attachNumber({ tenantId: TENANT, accountId: ACCOUNT, routeId: created.route.id, phoneNumberId, attachedBy: null });
  if (!attached.ok) throw new Error(`attach refused: ${attached.reason}`);
  await setInboundFlag(true);
  const runtime = getAgencyRuntime()!;
  const port = new URL(rig.origin).port;
  const fleet = new StationFleet({
    origin: `ws://127.0.0.1:${port}`,
    heartbeatMs: 10_000,
    client: 'web',
    mintToken: async (a) => (await runtime.tokens.mint(a.sessionId)).token,
  });
  return { rig, token: minted.token, phoneNumberId, routeId: created.route.id, clips, fleet };
}

/** Change the route (a partial config, merged by the repository). */
export async function setRoute(world: InboundWorld, over: Record<string, unknown>): Promise<void> {
  const res = await agencyInboundRouteRepository.update(TENANT, ACCOUNT, world.routeId, over, null);
  if (!res.ok) throw new Error(`route update refused: ${res.reason}`);
}

/** A running campaign on the tenant's credential (no contacts unless given). */
export async function campaign(world: InboundWorld, over: Record<string, unknown> = {}): Promise<string> {
  const c = await insertAgencyCampaign({
    tenant_id: TENANT, account_id: ACCOUNT, status: 'running', wrapup_seconds: 0,
    disposition_catalog: JSON.stringify([]), retry_policy: JSON.stringify(NO_RETRY),
    telephony_provider: 'plivo', telephony_credential_id: world.rig.credentialId, caller_ids: [CALLER_ID],
    ...over,
  });
  return c.id as string;
}

/** A roster contact on `campaignId`. */
export async function contact(campaignId: string, over: Record<string, unknown> = {}): Promise<string> {
  const ct = await insertAgencyContact(campaignId, {
    tenant_id: TENANT, account_id: ACCOUNT, phone_e164: CALLER_E164, source_row_number: 1, ...over,
  });
  return ct.id as string;
}

let userSeq = 0;
/** A user who is an agent of the account (so a sticky signal naming them survives the member filter). */
export async function agentUser(): Promise<string> {
  const id = randomUUID();
  userSeq++;
  await pool().query(`INSERT INTO users (id, firebase_uid, email) VALUES ($1, $2, $3)`, [id, `fb-ib-${id.slice(0, 8)}`, `ib-agent-${userSeq}-${id.slice(0, 6)}@example.test`]);
  await pool().query(`INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, 'agent')`, [id, TENANT, ACCOUNT]);
  return id;
}

/** An agent joins `campaignId` on a real station socket (the fleet) and is put `available` (unless told). */
export async function joinAgent(world: InboundWorld, campaignId: string, opts: { userId?: string; available?: boolean } = {}): Promise<FleetAgent> {
  const runtime = getAgencyRuntime()!;
  const userId = opts.userId ?? await agentUser();
  const join = await agencyAgentSessionRepository.joinOrRehydrate({
    tenantId: TENANT, accountId: ACCOUNT, campaignId, agentUserId: userId, replicaId: runtime.replicaId,
  });
  if (!join.ok) throw new Error('join refused');
  const agent = world.fleet.add({ sessionId: join.session.id, tenantId: TENANT, accountId: ACCOUNT, campaignId, agentUserId: userId });
  await agent.connectReady();
  await waitFor('station attached', () => runtime.stations.isLocallyOwned(agent.sessionId));
  if (opts.available !== false) await goAvailable(agent);
  return agent;
}

/** `available` as the agent's button writes it (the release path: a waiting caller first). */
export async function goAvailable(agent: FleetAgent): Promise<void> {
  const runtime = getAgencyRuntime()!;
  runtime.wrapup.cancel(agent.sessionId, 'agent_returned');
  await runtime.agents.set(agent.sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
  await agencyAgentSessionRepository.setState(agent.sessionId, 'available');
}

/** A customer rings the linked number; the carrier runs `steps`. */
export function ring(world: InboundWorld, steps: PlivoCallStep[], from = CALLER): PlivoCall {
  return world.rig.carrier.ringInbound({
    from,
    to: PLIVO_NUMBER,
    answerUrl: withInboundToken(plivoInboundAnswerUrl(BASE, world.rig.credentialId), world.token),
    hangupUrl: withInboundToken(plivoInboundStatusUrl(BASE, world.rig.credentialId), world.token),
    script: { name: 'inbound-connect', steps },
  });
}

/** The caller's media, as 20 ms frames: a loud second then a quiet one, on a loop. */
export const SPEECH = [...Array(50).fill(true), ...Array(50).fill(false)] as boolean[];

/** Set by a suite's teardown: every scripted caller still on the line hangs up. */
export const callers = { hangUpAll: false };

/** Answer, open the stream, talk in the background; then the caller hangs up when `until` holds (or at teardown). */
export function callerScript(until: () => boolean, opts: { timeoutMs?: number } = {}): PlivoCallStep[] {
  return [
    { do: 'answer' },
    { do: 'connect' },
    { do: 'start' },
    { do: 'mediaBackground', pattern: SPEECH },
    { do: 'waitFor', until: (c) => until() || callers.hangUpAll || c.hungUpByApi, what: 'the test to hang the caller up', timeoutMs: opts.timeoutMs ?? 60_000 },
    { do: 'hangup', status: 'completed', source: 'Caller' },
    { do: 'close' },
  ];
}

export async function spineOf(call: PlivoCall): Promise<AgencyInboundCallRecord | null> {
  return agencyInboundCallRepository.findByProviderCallId('plivo', call.callUuid);
}

export async function spineWhen(call: PlivoCall, what: string, ok: (row: AgencyInboundCallRecord) => boolean, timeoutMs = 20_000): Promise<AgencyInboundCallRecord> {
  return waitFor(what, async () => {
    const row = call.callUuid ? await spineOf(call) : null;
    return row && ok(row) ? row : null;
  }, timeoutMs, async () => JSON.stringify({ spine: call.callUuid ? await spineOf(call) : null, errors: call.errors }));
}

/** Every frame of `event` the agent's consoles received, in order. */
export function framesOf(agent: FleetAgent, event: string): Array<Record<string, unknown>> {
  return agent.allFrames().filter((f) => f.frame?.['event'] === event).map((f) => f.frame!);
}

/** The `inbound_call` frames' calls. */
export function inboundCalls(agent: FleetAgent): Array<Record<string, unknown>> {
  return framesOf(agent, 'inbound_call').map((f) => f['call'] as Record<string, unknown>);
}

/** The agent's state as the frames tell it (the last `agent_state`). */
export function stateFrames(agent: FleetAgent): string[] {
  return framesOf(agent, 'agent_state').map((f) => String(f['state']));
}

/** The agent's console sends `n` 20 ms PCM16 frames (the agent talking). */
export function agentTalks(agent: FleetAgent, n: number): void {
  for (let i = 0; i < n; i++) {
    const pcm = Buffer.alloc(640);
    for (let s = 0; s < 320; s++) pcm.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 600 * s) / 16000)), s * 2);
    agent.leg!.sendRaw(JSON.stringify({ event: 'media', media: { payload: pcm.toString('base64') } }));
  }
}

/** The finish routes, through the internal handler instance (`callCore`), as the public layer sends them. */
export async function finish(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  actorUserId: string,
  body: Record<string, unknown> = {},
  supervise = false,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await callCore(method === 'GET'
    ? { method, path: `/agency/inbound/calls/${path}`, query: { actor_user_id: actorUserId, ...(supervise ? { supervise: 'true' } : {}) }, tenantId: TENANT, accountId: ACCOUNT }
    : { method, path: `/agency/inbound/calls/${path}`, body: { ...body, agent_user_id: actorUserId, ...(supervise ? { on_behalf: true } : {}) }, tenantId: TENANT, accountId: ACCOUNT });
  const raw = res.body as Record<string, unknown>;
  return { status: res.status, body: raw && typeof raw === 'object' && 'answer' in raw ? raw['answer'] as Record<string, unknown> : raw };
}

/** Redis's view of a session. */
export async function liveOf(sessionId: string) {
  return getAgencyRuntime()!.agents.get(sessionId);
}
