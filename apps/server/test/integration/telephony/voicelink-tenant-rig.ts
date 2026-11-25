/**
 * Rig for the VoiceLink tenant-account suite (docs/carriers.md CR2–CR5, CR12): a campaign pinned
 * to a tenant's OWN VoiceLink login, dialled through the whole server against the mock VoiceLink
 * carrier (`test/mocks/voicelink`), which holds two accounts: the service's own
 * (`VOICELINK_USERNAME`) and the tenant's.
 *
 * Real: Postgres 5436 and this worktree's Redis db; the app (`buildApp` with a real context)
 * listening on loopback, so VoiceLink's status webhooks reach the real webhook routes and its
 * media socket the real `pstn-stream` upgrade; the voice and agency bootstraps (the pacing loop
 * dials); the bridge; the provider registry, the tenant factory and `VoicelinkAdapter`; the
 * credential service with a real sealer over a test keyring, its credential created through it
 * (validated, logged in against the mock, sealed). Nothing in the call path is faked.
 *
 * The tenant's VoiceLink number is written straight to `phone_numbers` pinned to the credential
 * and assigned to the tenant untagged, as a number added by hand would be (CR6): the write route
 * for it is not this suite's subject. Campaigns are inserted with the agency factories, not
 * through the campaign write route, for the same reason.
 *
 * The REST host is `config.telephony.voicelink.baseUrl`, pointed at the mock here (the object the
 * registry and the credential service both read by reference); the mock rewrites the bridge's
 * public `wss://agency.test` / `https://agency.test` URLs to the listening app.
 *
 * A suite sets {@link VOICELINK_TENANT_E2E_ENV} in its own `vi.hoisted` (config is read at import).
 */
import { randomBytes } from 'node:crypto';
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
import { resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import type { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import { CredentialSealer, EnvKeyringWrapper } from '../../../src/telephony/credentials/credential-sealer.js';
import { TelephonyCredentialService } from '../../../src/telephony/credentials/credential-service.js';
import { setTelephonyCredentialServiceForTests } from '../../../src/telephony/credentials/index.js';
import { resetVoicelinkTenantLoginsForTests } from '../../../src/telephony/voicelink/voicelink-tenant.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import { MockVoicelinkCarrier } from '../../mocks/voicelink/index.js';
import { ACCOUNT, ADMIN, NO_RETRY, TENANT } from './plivo-rig.js';

export { ACCOUNT, ADMIN, TENANT };

/** The service's own VoiceLink login (the mock's default account). */
export const SERVICE_USER = 'mock-vl-user';
export const SERVICE_PASSWORD = 'mock-vl-password';
/** The tenant's own VoiceLink login. The password has spaces: it is never trimmed. */
/** Mixed case: the login must send it as typed, while its account ref is lower-cased (CR2). */
export const TENANT_USER = 'Tenant-VL-User';
export const TENANT_PASSWORD = ' tenant vl password ';
/** The tenant's VoiceLink DID (pinned to its credential) and the service account's. */
export const TENANT_DID = '+919800000777';
export const SERVICE_DID = '+919800000111';

export const VOICELINK_TENANT_E2E_ENV: Record<string, string> = {
  FF_AGENCY_DIALER: 'true',
  VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
  VOICELINK_USERNAME: SERVICE_USER,
  VOICELINK_PASSWORD: SERVICE_PASSWORD,
  VOICELINK_LOGIN_TIMEOUT_MS: '3000',
  VOICELINK_ADD_LEAD_TIMEOUT_MS: '3000',
  MAX_CONCURRENT_CALLS: '100000',
  RATE_LIMIT_WEBHOOK_MAX: '1000000',
  RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
  LOG_LEVEL: 'warn',
};

export interface VoicelinkTenantRig {
  app: FastifyInstance;
  origin: string;
  bridge: WebRtcBridgeManager;
  carrier: MockVoicelinkCarrier;
  credentials: TelephonyCredentialService;
  /** The tenant's VoiceLink credential, created through the credential service. */
  credentialId: string;
  stop(): Promise<void>;
}

export function initVoicelinkTenantDb(): void {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 12 });
}

export async function closeVoicelinkTenantDb(): Promise<void> {
  await closePool();
  await closeTestPool();
  await closeTestRedis();
}

/** Fresh tables and Redis; the tenant, a super-admin, the carrier; the credential and its number; the app. */
export async function startVoicelinkTenantRig(): Promise<VoicelinkTenantRig> {
  await truncateAll();
  await flushTestRedis();
  resetVoicelinkTenantLoginsForTests();
  const pool = getTestPool();
  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'VoiceLink tenant', 'vl-tenant-e2e')`, [TENANT]);
  await pool.query(`INSERT INTO super_admins (id, email, password_hash, name, status) VALUES ($1, 'vl-e2e@example.com', 'x', 'VL E2E', 'active')`, [ADMIN]);
  await pool.query(`INSERT INTO telephony_providers (name, display_name, status) VALUES ('voicelink', 'VoiceLink', 'active')`);
  await pool.query(
    'INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls, allow_recording) VALUES ($1, $2, 10000, true)',
    [TENANT, ACCOUNT],
  );

  let origin = '';
  const carrier = new MockVoicelinkCarrier({ username: SERVICE_USER, password: SERVICE_PASSWORD, targetOrigin: () => origin });
  carrier.addAccount(TENANT_USER, TENANT_PASSWORD);
  await carrier.start();
  config.telephony.voicelink.baseUrl = carrier.baseUrl;
  config.telephony.voicelink.username = SERVICE_USER;
  config.telephony.voicelink.password = SERVICE_PASSWORD;

  const keyring = `vle2e:${randomBytes(32).toString('base64')}`;
  const credentials = new TelephonyCredentialService({
    repo: telephonyCredentialRepository, tenants: tenantRepository, numbers: phoneNumberRepository,
    sealer: new CredentialSealer(new EnvKeyringWrapper(keyring, 'vle2e')),
    telephony: config.telephony,
  });
  setTelephonyCredentialServiceForTests(credentials);
  const created = await credentials.create({
    tenantId: TENANT, provider: 'voicelink', label: 'Own VoiceLink', adminId: ADMIN,
    fields: { username: TENANT_USER, password: TENANT_PASSWORD },
  });
  if (!created.ok) throw new Error(`credential create refused: ${JSON.stringify(created)}`);
  const credentialId = created.value.id;
  // The tenant's DID, added by hand and pinned to the credential (CR6), assigned untagged.
  await pool.query(
    `WITH n AS (
       INSERT INTO phone_numbers (phone_number, provider_id, label, capabilities, created_by, telephony_credential_id)
       SELECT $1, p.id, 'Own line', '{voice}', $2::uuid, $3::uuid FROM telephony_providers p WHERE p.name = 'voicelink'
       RETURNING id)
     INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id, is_default, assigned_by)
     SELECT $4::uuid, n.id, false, $2::uuid FROM n`,
    [TENANT_DID, ADMIN, credentialId, TENANT],
  );
  carrier.reset(); // the create's check login is not a dial

  resetVoiceEngineForTests();
  await resetAgencyRuntimeForTests();
  const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
  const app = await buildApp({ ctx });
  await app.listen({ port: 0, host: '127.0.0.1' });
  origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const bridge = ensureVoiceEngine(getTestRedis()).bridge;
  const stops: Array<() => Promise<void>> = [await startVoice(ctx), await startAgency(ctx)];

  return {
    app, origin, bridge, carrier, credentials, credentialId,
    async stop() {
      for (const stop of stops.reverse()) await stop();
      await carrier.stop();
      await bridge.gracefulShutdown();
      await app.close();
      setTelephonyCredentialServiceForTests(null);
      resetVoiceEngineForTests();
      await resetAgencyRuntimeForTests();
      resetVoicelinkTenantLoginsForTests();
    },
  };
}

/**
 * A running VoiceLink campaign with one contact: on the tenant's credential from its pinned DID
 * by default, or (`credentialId: null`) on the service's own account from the service DID.
 */
export async function voicelinkCampaign(
  rig: VoicelinkTenantRig,
  opts: { credentialId?: string | null; destination?: string } = {},
): Promise<{ campaignId: string; contactId: string }> {
  const credentialId = opts.credentialId === undefined ? rig.credentialId : opts.credentialId;
  const campaign = await insertAgencyCampaign({
    tenant_id: TENANT, account_id: ACCOUNT, status: 'running', wrapup_seconds: 0,
    disposition_catalog: JSON.stringify([]), retry_policy: JSON.stringify(NO_RETRY),
    telephony_provider: 'voicelink', telephony_credential_id: credentialId,
    caller_ids: [credentialId ? TENANT_DID : SERVICE_DID], record_calls: true,
  });
  const contact = await insertAgencyContact(campaign.id as string, {
    tenant_id: TENANT, account_id: ACCOUNT, phone_e164: opts.destination ?? '+919812345678', source_row_number: 1,
  });
  return { campaignId: campaign.id as string, contactId: contact.id as string };
}
