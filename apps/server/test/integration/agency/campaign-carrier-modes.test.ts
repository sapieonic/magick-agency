import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { insertAgencyCampaign } from './agency-factories.js';

/**
 * ─── A carrier with both account modes, through the real campaign routes ─────────
 *
 * docs/carriers.md CR1, CR7, CR8, CR9 against a real Postgres. VoiceLink is made a carrier with
 * the service's account AND tenant accounts by a catalogue double
 * (`test/helpers/carrier-catalog-double.ts`), so these hold whatever the real catalogue declares
 * (VoiceLink takes tenant accounts once docs/carriers.md step 2 lands). Its tenant numbers are
 * added by hand, pinned to a credential (`phoneNumberRepository.createPinned`, CR6):
 *  - a campaign may dial on its service account (no credential) or on an active credential of
 *    the tenant on it, each with that account's numbers;
 *  - moving between the two on one carrier is a change of carrier account: the whole pool is
 *    judged (CR8);
 *  - the service account takes no number pinned to a credential (CR9);
 *  - a hand-pinned number follows PL4 and PL13 (CR7): never offered or dialled while its
 *    credential is not active.
 */

const carriers = vi.hoisted(() => ({ voicelink: { accounts: { service: true, tenant: true } } }));
vi.mock('../../../src/telephony/carrier-catalog.js', async (importOriginal) =>
  (await import('../../helpers/carrier-catalog-double.js')).catalogDouble(await importOriginal(), carriers));

vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/db/connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db/connection')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean' } },
}));

const { agencyCampaignRoutes } = await import('../../../src/api/routes/agency-campaigns.routes.js');
const { phoneNumberRepository } = await import('@magick-agency/db/repositories/phone-number.repository');
const { tenantPhoneAssignmentRepository } = await import('@magick-agency/db/repositories/tenant-phone-assignment.repository');
const { dialableCallerIds, invalidateDialableCallerIds } = await import('../../../src/agency/campaign-dialability.js');
type AgencyCampaignRouteDeps = import('../../../src/api/routes/agency-campaigns.routes.js').AgencyCampaignRouteDeps;

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;
const HEADERS = { 'x-mgkvc-tenant': TENANT, 'x-mgkvc-account': ACCOUNT };
const SERVICE_NUMBER = '+919000000001';
const OWN = '+919800000001';
const OWN_DISABLED = '+919800000002';

let app: FastifyInstance;
let credVl: string;
let credVlDisabled: string;
let voicelinkId: string;

const pool = () => getTestPool();

async function insertCredential(provider: string, label: string): Promise<string> {
  const { rows } = await (await pool()).query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, $2, $3, $4) RETURNING id`,
    [TENANT, provider, label, `acct-${randomUUID().slice(0, 12)}`]);
  return rows[0]!.id;
}

async function pinByHand(credentialId: string, phone: string): Promise<void> {
  const created = await phoneNumberRepository.createPinned(
    { phone_number: phone, provider_id: voicelinkId, max_concurrent_calls: 2 }, credentialId);
  expect(created.ok).toBe(true);
}

const create = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS, payload: { name: 'C', ...payload } });
const patch = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/api/v1/agency-campaigns/${id}`, headers: HEADERS, payload });

beforeEach(async () => {
  await truncateAll();
  flags.isEnabled.mockResolvedValue(true);
  const { rows } = await (await pool()).query<{ id: string; name: string }>(
    `INSERT INTO telephony_providers (name, display_name, status) VALUES ('voicelink', 'VoiceLink', 'active'), ('plivo', 'Plivo', 'active') RETURNING id, name`);
  voicelinkId = rows.find((r) => r.name === 'voicelink')!.id;
  await (await pool()).query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)`, [TENANT, `t-${randomUUID().slice(0, 8)}`]);
  credVl = await insertCredential('voicelink', 'Own line');
  credVlDisabled = await insertCredential('voicelink', 'Old line');
  await pinByHand(credVl, OWN);
  await pinByHand(credVlDisabled, OWN_DISABLED);
  await (await pool()).query(`UPDATE telephony_credentials SET status = 'disabled' WHERE id = $1`, [credVlDisabled]);
  const own = await (await pool()).query<{ id: string }>(
    `INSERT INTO phone_numbers (phone_number, provider_id) VALUES ($1, $2) RETURNING id`, [SERVICE_NUMBER, voicelinkId]);
  await (await pool()).query(`INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2)`, [TENANT, own.rows[0]!.id]);
  invalidateDialableCallerIds();
  app = Fastify({ logger: false });
  await app.register(async (scope) => agencyCampaignRoutes(scope, {} as AgencyCampaignRouteDeps), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
});

afterAll(closeTestPool);

describe('a carrier with both modes (CR1, CR8)', () => {
  it('a campaign dials on its service account with a service number, or on a credential with that credential`s number', async () => {
    const service = await create({ telephony_provider: 'voicelink', caller_ids: [SERVICE_NUMBER] });
    expect(service.statusCode, service.body).toBe(201);
    expect(service.json()).toMatchObject({ telephony_provider: 'voicelink', telephony_credential_id: null });
    const own = await create({ telephony_provider: 'voicelink', telephony_credential_id: credVl, caller_ids: [OWN] });
    expect(own.statusCode, own.body).toBe(201);
    expect(own.json()).toMatchObject({ telephony_provider: 'voicelink', telephony_credential_id: credVl, caller_ids: [OWN] });
  });

  it('on a credential, a service number is not one of its numbers; a disabled credential cannot be pinned', async () => {
    const res = await create({ telephony_provider: 'voicelink', telephony_credential_id: credVl, caller_ids: [OWN, SERVICE_NUMBER] });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.caller_ids).toContain(SERVICE_NUMBER);
    const disabled = await create({ telephony_provider: 'voicelink', telephony_credential_id: credVlDisabled, caller_ids: [OWN_DISABLED] });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ code: 'telephony_credential_not_active' });
  });

  it('moving from the service account onto a credential on the same carrier judges the stored pool too', async () => {
    const campaign = await insertAgencyCampaign({ telephony_provider: 'voicelink', caller_ids: [SERVICE_NUMBER] });
    const kept = await patch(campaign.id, { telephony_credential_id: credVl });
    expect(kept.statusCode).toBe(400);
    expect(kept.json().details.caller_ids).toContain(SERVICE_NUMBER);
    const moved = await patch(campaign.id, { telephony_credential_id: credVl, caller_ids: [OWN] });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ telephony_provider: 'voicelink', telephony_credential_id: credVl, caller_ids: [OWN] });
  });

  it('moving from a credential back onto the service account judges the stored pool too (CR9)', async () => {
    const campaign = await insertAgencyCampaign({ telephony_provider: 'voicelink', telephony_credential_id: credVl, caller_ids: [OWN] });
    const kept = await patch(campaign.id, { telephony_credential_id: null });
    expect(kept.statusCode).toBe(400);
    expect(kept.json().details.caller_ids).toContain(OWN);
    const moved = await patch(campaign.id, { telephony_credential_id: null, caller_ids: [SERVICE_NUMBER] });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ telephony_provider: 'voicelink', telephony_credential_id: null });
  });

  it('a credential of another carrier is not found, even on a carrier that takes credentials', async () => {
    const plivo = await insertCredential('plivo', 'Plivo main');
    const res = await create({ telephony_provider: 'voicelink', telephony_credential_id: plivo, caller_ids: [OWN] });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'telephony_credential_not_found' });
  });
});

describe('the service account takes no hand-pinned number (CR9)', () => {
  it('a service campaign naming a number added by hand onto a credential is refused, the credential active or not', async () => {
    for (const number of [OWN, OWN_DISABLED]) {
      const res = await create({ telephony_provider: 'voicelink', caller_ids: [SERVICE_NUMBER, number] });
      expect(res.statusCode, number).toBe(400);
      expect(res.json().details.caller_ids).toContain(number);
      expect(res.json().details.caller_ids).not.toContain(SERVICE_NUMBER);
    }
  });

  it('a caller-ID-only edit adding one is refused', async () => {
    const campaign = await insertAgencyCampaign({ telephony_provider: 'voicelink', caller_ids: [SERVICE_NUMBER] });
    const res = await patch(campaign.id, { caller_ids: [SERVICE_NUMBER, OWN] });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.caller_ids).toContain(OWN);
  });
});

describe('a hand-pinned number follows PL4 and PL13 (CR7)', () => {
  it('a disabled credential`s hand-pinned number is not offered as a caller ID; an active one`s is', async () => {
    const offered = (await tenantPhoneAssignmentRepository.findAvailableForAccount(TENANT, ACCOUNT)).map((n) => n.phone_number);
    expect(offered).toContain(OWN);
    expect(offered).toContain(SERVICE_NUMBER);
    expect(offered).not.toContain(OWN_DISABLED);
  });

  it('a campaign pinned to the credential dials it only while the credential is active', async () => {
    const campaign = await insertAgencyCampaign({ telephony_provider: 'voicelink', telephony_credential_id: credVl, caller_ids: [OWN] });
    expect(await dialableCallerIds(campaign)).toEqual([OWN]);
    await (await pool()).query(`UPDATE telephony_credentials SET status = 'disabled' WHERE id = $1`, [credVl]);
    invalidateDialableCallerIds();
    expect(await dialableCallerIds(campaign)).toEqual([OWN]);
    // PL13 reads the number's status and assignment; the credential's status is PL4's (the offer)
    // and the start's (`campaignCredentialStartRefusal`). Retired by hand, it is not dialled.
    await (await pool()).query(`UPDATE phone_numbers SET status = 'retired' WHERE phone_number = $1`, [OWN]);
    invalidateDialableCallerIds();
    expect(await dialableCallerIds(campaign)).toEqual([]);
  });
});
