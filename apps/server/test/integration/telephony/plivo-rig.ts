/**
 * Shared rig for the Plivo end-to-end suites: a call on a tenant's OWN Plivo account
 * (B18–B22) through the whole server against the mock Plivo carrier (`test/mocks/plivo`).
 *
 * Real: Postgres 5436 and this worktree's Redis db; the app (`buildApp` with a real
 * context) listening on loopback, so Plivo's callbacks reach the real webhook routes and
 * its media socket the real `pstn-stream` upgrade; the voice and agency bootstraps (the
 * pacing loop dials); the bridge; the provider registry and `PlivoAdapter`; the
 * credential service with a real sealer over a test keyring, its credential created,
 * verified and its numbers synced against the mock. Nothing in the call path is faked.
 *
 * The one seam: the adapters reach the mock through `setPlivoTransportForTests`, whose
 * transport accepts only Plivo's fixed API host (`carrier.offHost` must stay empty), and
 * the credential service is handed the same transport.
 *
 * A suite sets {@link PLIVO_E2E_ENV} in its own `vi.hoisted` (config is read at import).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { phoneNumberRepository } from '@magick-agency/db/repositories/phone-number.repository';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import type { AppContext } from '../../../src/app-context.js';
import { buildApp } from '../../../src/app.js';
import { ensureVoiceEngine, resetVoiceEngineForTests, startVoice } from '../../../src/bootstrap/voice.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { agencyAgentSessionRepository } from '../../../src/db/repositories/agency.repository.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import type { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import { CredentialSealer, EnvKeyringWrapper } from '../../../src/telephony/credentials/credential-sealer.js';
import { TelephonyCredentialService } from '../../../src/telephony/credentials/credential-service.js';
import { setTelephonyCredentialServiceForTests } from '../../../src/telephony/credentials/index.js';
import { setPlivoTransportForTests } from '../../../src/telephony/plivo/plivo.adapter.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import { MockPlivoCarrier } from '../../mocks/plivo/index.js';
import { pcm16kFrame } from '../../mocks/voicelink/audio-pattern.js';

export const PLIVO_E2E_ENV: Record<string, string> = {
  FF_AGENCY_DIALER: 'true',
  PLIVO_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/plivo',
  VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
  PLIVO_REQUEST_TIMEOUT_MS: '3000',
  MAX_CONCURRENT_CALLS: '100000',
  RATE_LIMIT_WEBHOOK_MAX: '1000000',
  RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
  LOG_LEVEL: 'warn',
};

export const TENANT = '8b1d0c8e-3d0e-4c7a-8b44-1f6b0a000001';
export const ACCOUNT = '8b1d0c8e-3d0e-4c7a-8b44-1f6b0a000002';
export const OTHER_TENANT = '8b1d0c8e-3d0e-4c7a-8b44-1f6b0a000009';
export const ADMIN = '8b1d0c8e-3d0e-4c7a-8b44-1f6b0a0000ad';
/** The tenant's Plivo number, as Plivo lists it and as E.164 once synced. */
export const PLIVO_NUMBER = '14155550101';
export const CALLER_ID = `+${PLIVO_NUMBER}`;

export const NO_RETRY = Object.fromEntries(
  ['no_answer', 'busy', 'failed', 'abandoned', 'agent_disconnected', 'orphaned', 'canceled'].map((o) => [o, { max_attempts: 0 }]),
);

export interface PlivoRig {
  app: FastifyInstance;
  origin: string;
  bridge: WebRtcBridgeManager;
  /** The tenant's Plivo account. */
  carrier: MockPlivoCarrier;
  /** Another tenant's Plivo account (its own credential, its own token). */
  otherCarrier: MockPlivoCarrier;
  credentials: TelephonyCredentialService;
  /** The tenant's credential id, created, verified and synced against `carrier`. */
  credentialId: string;
  otherCredentialId: string;
  stop(): Promise<void>;
}

export function initPlivoDb(): void {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 12 });
}

export async function closePlivoDb(): Promise<void> {
  await closePool();
  await closeTestPool();
  await closeTestRedis();
}

/** Fresh tables and Redis; the tenants, a super-admin, the carriers; the app; credentials. */
export async function startPlivoRig(opts: {
  /** Build the voice engine as media worker `slot` would (its URLs carry `&w=<slot>`), before the app. */
  carrierRouteHint?: string;
  /** Boot voice and agency (`startVoice`, `startAgency`): the pacing loop dials. Default true. */
  bootstraps?: boolean;
} = {}): Promise<PlivoRig> {
  await truncateAll();
  await flushTestRedis();
  const pool = getTestPool();
  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Plivo tenant', 'plivo-e2e'), ($2, 'Other tenant', 'plivo-e2e-other')`, [TENANT, OTHER_TENANT]);
  await pool.query(`INSERT INTO super_admins (id, email, password_hash, name, status) VALUES ($1, 'plivo-e2e@example.com', 'x', 'Plivo E2E', 'active')`, [ADMIN]);
  await pool.query(`INSERT INTO telephony_providers (name, display_name, status) VALUES ('voicelink', 'VoiceLink', 'active'), ('plivo', 'Plivo', 'active')`);
  await pool.query(
    'INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls, allow_recording) VALUES ($1, $2, 10000, true)',
    [TENANT, ACCOUNT],
  );

  let origin = '';
  const carrier = new MockPlivoCarrier({
    authId: 'MAE2ETENANT000000001', authToken: 'tenantAuthToken-current-0001',
    targetOrigin: () => origin, numbers: [{ number: PLIVO_NUMBER, alias: 'Main line' }],
  });
  const otherCarrier = new MockPlivoCarrier({
    authId: 'MAE2EOTHER0000000009', authToken: 'otherTenantAuthToken-000009',
    targetOrigin: () => origin, numbers: [{ number: '14155550909' }],
  });
  await carrier.start();
  await otherCarrier.start();
  setPlivoTransportForTests(carrier.fetch);

  const keyring = `e2e1:${randomBytes(32).toString('base64')}`;
  const sealer = new CredentialSealer(new EnvKeyringWrapper(keyring, 'e2e1'));
  const service = (fetchImpl: MockPlivoCarrier['fetch']) => new TelephonyCredentialService({
    repo: telephonyCredentialRepository, tenants: tenantRepository, sealer, numbers: phoneNumberRepository, fetchImpl,
  });
  const credentials = service(carrier.fetch);
  setTelephonyCredentialServiceForTests(credentials);
  const created = await credentials.create({
    tenantId: TENANT, provider: 'plivo', label: 'Main', adminId: ADMIN,
    fields: { auth_id: carrier.authId, auth_token: carrier.authToken },
  });
  if (!created.ok) throw new Error(`credential create refused: ${JSON.stringify(created)}`);
  const synced = await credentials.syncNumbers(created.value.id, ADMIN);
  if (!synced.ok) throw new Error(`number sync refused: ${JSON.stringify(synced)}`);
  const other = await service(otherCarrier.fetch).create({
    tenantId: OTHER_TENANT, provider: 'plivo', label: 'Theirs', adminId: ADMIN,
    fields: { auth_id: otherCarrier.authId, auth_token: otherCarrier.authToken },
  });
  if (!other.ok) throw new Error(`other credential create refused: ${JSON.stringify(other)}`);

  resetVoiceEngineForTests();
  await resetAgencyRuntimeForTests();
  if (opts.carrierRouteHint) ensureVoiceEngine(getTestRedis(), { carrierRouteHint: opts.carrierRouteHint });
  const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
  const app = await buildApp({ ctx });
  await app.listen({ port: 0, host: '127.0.0.1' });
  origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  // The engine as buildApp made it (or the worker-shaped one made above).
  const bridge = ensureVoiceEngine(getTestRedis()).bridge;
  const stops: Array<() => Promise<void>> = [];
  if (opts.bootstraps !== false) {
    stops.push(await startVoice(ctx));
    stops.push(await startAgency(ctx));
  }

  return {
    app, origin, bridge, carrier, otherCarrier, credentials,
    credentialId: created.value.id, otherCredentialId: other.value.id,
    async stop() {
      for (const stop of stops.reverse()) await stop();
      await carrier.stop();
      await otherCarrier.stop();
      await bridge.gracefulShutdown();
      await app.close();
      setPlivoTransportForTests(null);
      setTelephonyCredentialServiceForTests(null);
      resetVoiceEngineForTests();
      await resetAgencyRuntimeForTests();
    },
  };
}

/** A running campaign on the tenant's Plivo credential, with one contact. */
export async function plivoCampaign(rig: PlivoRig, destination = '+919812345678', over: Record<string, unknown> = {}): Promise<{ campaignId: string; contactId: string }> {
  const campaign = await insertAgencyCampaign({
    tenant_id: TENANT, account_id: ACCOUNT, status: 'running', wrapup_seconds: 0,
    disposition_catalog: JSON.stringify([]), retry_policy: JSON.stringify(NO_RETRY),
    telephony_provider: 'plivo', telephony_credential_id: rig.credentialId, caller_ids: [CALLER_ID], record_calls: true,
    ...over,
  });
  const contact = await insertAgencyContact(campaign.id as string, {
    tenant_id: TENANT, account_id: ACCOUNT, phone_e164: destination, source_row_number: 1,
  });
  return { campaignId: campaign.id as string, contactId: contact.id as string };
}

export interface Station {
  sessionId: string;
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  /** PCM16 payloads of the `media` frames the station heard. */
  media: Buffer[];
  /** Send `n` 20 ms PCM16 frames up to the bridge (the agent talking), loud or quiet. */
  talk(n: number, loud?: boolean): void;
  close(): Promise<void>;
}

let agentSeq = 0;

/** An agent joins `campaignId`, opens the real station socket and goes available. */
export async function joinAgent(rig: PlivoRig, campaignId: string): Promise<Station> {
  const runtime = getAgencyRuntime()!;
  agentSeq += 1;
  const join = await agencyAgentSessionRepository.joinOrRehydrate({
    tenantId: TENANT, accountId: ACCOUNT, campaignId,
    agentUserId: `8b1d0c8e-3d0e-4c7a-8b44-${String(agentSeq).padStart(12, '0')}`, replicaId: runtime.replicaId,
  });
  if (!join.ok) throw new Error('join refused');
  const { token } = await runtime.tokens.mint(join.session.id);
  const port = new URL(rig.origin).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/proxy/agency/station/${join.session.id}?token=${token}`);
  const station: Station = {
    sessionId: join.session.id,
    ws,
    frames: [],
    media: [],
    talk(n, loud = true) {
      for (let i = 0; i < n; i++) {
        ws.send(JSON.stringify({ event: 'media', media: { payload: pcm16kFrame(i, loud).toString('base64') } }));
      }
    },
    close: () => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', () => resolve());
      ws.close();
    }),
  };
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (frame['event'] === 'media') station.media.push(Buffer.from((frame['media'] as { payload: string }).payload, 'base64'));
    else station.frames.push(frame);
  });
  await waitFor('station ready', () => station.frames.some((f) => f['event'] === 'ready'));
  runtime.wrapup.cancel(station.sessionId, 'agent_returned');
  await runtime.agents.set(station.sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
  await agencyAgentSessionRepository.setState(station.sessionId, 'available');
  return station;
}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 20_000,
  explain?: () => Promise<string> | string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${explain ? `: ${await explain()}` : ''}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface PlivoCallRow {
  id: string;
  status: string;
  outcome: string | null;
  provider: string;
  provider_call_id: string | null;
  provider_request_id: string | null;
  telephony_credential_id: string | null;
  recording_url: string | null;
  answered_at: Date | null;
  ended_at: Date | null;
  caller_id: string;
}

export async function callRow(id: string): Promise<PlivoCallRow | null> {
  const { rows } = await getTestPool().query<PlivoCallRow>(
    `SELECT id, status, outcome, provider, provider_call_id, provider_request_id, telephony_credential_id, recording_url,
            answered_at, ended_at, caller_id
       FROM agency_calls WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function attemptOf(campaignId: string): Promise<{ id: string; outcome: string | null; state: string; webrtc_call_id: string | null } | null> {
  const { rows } = await getTestPool().query<{ id: string; outcome: string | null; state: string; webrtc_call_id: string | null }>(
    'SELECT id, outcome, state, webrtc_call_id FROM agency_call_attempts WHERE campaign_id = $1 ORDER BY dialed_at DESC LIMIT 1', [campaignId]);
  return rows[0] ?? null;
}

export async function campaignRow(id: string): Promise<{ status: string; pause_reason: string | null }> {
  const { rows } = await getTestPool().query<{ status: string; pause_reason: string | null }>(
    'SELECT status, pause_reason FROM agency_campaigns WHERE id = $1', [id]);
  return rows[0]!;
}

export const randomCallId = (): string => randomUUID();
