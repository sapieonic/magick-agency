import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

// The tenant-account carrier can dial from this server only with its webhook base set
// (PL12); set before the config loads. One test below unsets it.
vi.hoisted(() => { process.env['PLIVO_WEBHOOK_BASE_URL'] = 'https://agency.test/api/v1/webhooks/plivo'; });

/**
 * ─── A campaign pinned to a tenant's own carrier account, through the real routes ─
 *
 * Decisions B18–B22, docs/status.md Plivo step 4. The internal campaign handlers (create,
 * PATCH, start, resume, retry) against a real Postgres, with real credential rows and
 * numbers synced by the real `syncForCredential`:
 *  - the carrier must be an active provider row; the service's carrier takes no
 *    credential; a tenant-account carrier needs an ACTIVE credential of THIS tenant;
 *  - its caller IDs must be active numbers synced from that credential;
 *  - start and resume are refused while the pinned credential is not active, and while its
 *    carrier cannot dial from this server (no webhook base, PL12);
 *  - a retry inherits the pin;
 *  - a carrier 401 pauses a running campaign `carrier_auth`, a credential no longer active
 *    `carrier_account_unavailable` (`pauseForCarrierAccount`).
 */

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
const { config } = await import('../../../src/config/index.js');
const { phoneNumberRepository } = await import('@magick-agency/db/repositories/phone-number.repository');
const { decodeConfigChange } = await import('../../../src/agency/campaign-config-audit.js');
const { agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { invalidateDialableCallerIds } = await import('../../../src/agency/campaign-dialability.js');
type AgencyCampaignRouteDeps = import('../../../src/api/routes/agency-campaigns.routes.js').AgencyCampaignRouteDeps;

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;
const HEADERS = { 'x-mgkvc-tenant': TENANT, 'x-mgkvc-account': ACCOUNT };
const MINE = ['+14155550001', '+14155550002'];
const THEIRS = '+14155550009';

let app: FastifyInstance;
let credA: string;
let credOther: string;
let credDisabled: string;

async function pool() { return getTestPool(); }

async function insertTenant(id: string): Promise<void> {
  await (await pool()).query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)`, [id, `t-${id.slice(0, 8)}-${randomUUID().slice(0, 4)}`]);
}

async function insertCredential(tenantId: string, label: string): Promise<string> {
  const { rows } = await (await pool()).query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref)
     VALUES ($1, 'plivo', $2, $3) RETURNING id`,
    [tenantId, label, `MA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`]);
  return rows[0]!.id;
}

async function setStatus(id: string, status: string): Promise<void> {
  await (await pool()).query('UPDATE telephony_credentials SET status = $2 WHERE id = $1', [id, status]);
}

const create = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS, payload: { name: 'C', ...payload } });
const patch = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/api/v1/agency-campaigns/${id}`, headers: HEADERS, payload });
const post = (id: string, verb: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/v1/agency-campaigns/${id}/${verb}`, headers: HEADERS, payload });

async function plivoCampaign(over: Record<string, unknown> = {}) {
  return insertAgencyCampaign({ telephony_provider: 'plivo', telephony_credential_id: credA, caller_ids: MINE, ...over });
}

beforeEach(async () => {
  await truncateAll();
  flags.isEnabled.mockResolvedValue(true);
  await (await pool()).query(
    `INSERT INTO telephony_providers (name, display_name, status) VALUES ('voicelink', 'VoiceLink', 'active'), ('plivo', 'Plivo', 'active')`);
  const other = randomUUID();
  await insertTenant(TENANT);
  await insertTenant(other);
  credA = await insertCredential(TENANT, 'Main');
  credDisabled = await insertCredential(TENANT, 'Old');
  credOther = await insertCredential(other, 'Theirs');
  await phoneNumberRepository.syncForCredential(credA, MINE.map((n) => ({ phone_number: n, label: null })), null);
  await phoneNumberRepository.syncForCredential(credDisabled, [{ phone_number: '+14155550003', label: null }], null);
  await phoneNumberRepository.syncForCredential(credOther, [{ phone_number: THEIRS, label: null }], null);
  await setStatus(credDisabled, 'disabled');
  app = Fastify({ logger: false });
  await app.register(async (scope) => agencyCampaignRoutes(scope, {} as AgencyCampaignRouteDeps), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
});

afterAll(closeTestPool);

describe('POST /api/v1/agency-campaigns — the carrier account', () => {
  it('pins an active credential of this tenant, with its synced numbers as caller IDs', async () => {
    const res = await create({ telephony_provider: 'plivo', telephony_credential_id: credA, caller_ids: MINE });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ telephony_provider: 'plivo', telephony_credential_id: credA, caller_ids: MINE });
  });

  it('omitted: the service\'s own carrier, no credential', async () => {
    const res = await create({ caller_ids: ['+919000000001'] });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ telephony_provider: 'voicelink', telephony_credential_id: null });
  });

  it('another tenant\'s credential is not found (404), and nothing is created', async () => {
    const res = await create({ telephony_provider: 'plivo', telephony_credential_id: credOther, caller_ids: [THEIRS] });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'telephony_credential_not_found' });
    const { rows } = await (await pool()).query('SELECT 1 FROM agency_campaigns');
    expect(rows).toHaveLength(0);
  });

  it('an unknown credential id is not found too', async () => {
    const res = await create({ telephony_provider: 'plivo', telephony_credential_id: randomUUID(), caller_ids: MINE });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'telephony_credential_not_found' });
  });

  it.each(['disabled', 'invalid'])('a %s credential cannot be pinned (409)', async (status) => {
    await setStatus(credA, status);
    const res = await create({ telephony_provider: 'plivo', telephony_credential_id: credA, caller_ids: MINE });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'telephony_credential_not_active' });
    expect(res.json().message).toContain(status);
  });

  it('a caller ID that is not one of the credential\'s active synced numbers is a 400 naming it', async () => {
    const res = await create({ telephony_provider: 'plivo', telephony_credential_id: credA, caller_ids: [MINE[0], THEIRS, '+14155550003'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.caller_ids).toContain(THEIRS);
    expect(res.json().details.caller_ids).toContain('+14155550003');
    expect(res.json().details.caller_ids).not.toContain(MINE[0]);
  });

  it('a synced number the account no longer lists (retired) cannot be a caller ID', async () => {
    await phoneNumberRepository.syncForCredential(credA, [{ phone_number: MINE[0]!, label: null }], null);
    const res = await create({ telephony_provider: 'plivo', telephony_credential_id: credA, caller_ids: MINE });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.caller_ids).toContain(MINE[1]);
  });

  it('a tenant-account carrier requires a credential; the service carrier refuses one', async () => {
    const without = await create({ telephony_provider: 'plivo', caller_ids: MINE });
    expect(without.statusCode).toBe(400);
    expect(without.json().details).toHaveProperty('telephony_credential_id');
    const withOne = await create({ telephony_provider: 'voicelink', telephony_credential_id: credA, caller_ids: ['+919000000001'] });
    expect(withOne.statusCode).toBe(400);
    expect(withOne.json().details).toHaveProperty('telephony_credential_id');
  });

  it('an unknown or inactive carrier is a 400', async () => {
    expect((await create({ telephony_provider: 'twilio', caller_ids: ['+919000000001'] })).statusCode).toBe(400);
    await (await pool()).query(`UPDATE telephony_providers SET status = 'inactive' WHERE name = 'plivo'`);
    const res = await create({ telephony_provider: 'plivo', telephony_credential_id: credA, caller_ids: MINE });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual({ telephony_provider: 'must name an active carrier' });
  });

  it('a malformed credential id is a 400, not a 22P02', async () => {
    const res = await create({ telephony_provider: 'plivo', telephony_credential_id: 'nope', caller_ids: MINE });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/v1/agency-campaigns/:id — the carrier account', () => {
  it('moves a service-carrier campaign onto a credential, with its numbers', async () => {
    const campaign = await insertAgencyCampaign();
    const res = await patch(campaign.id, { telephony_provider: 'plivo', telephony_credential_id: credA, caller_ids: MINE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ telephony_provider: 'plivo', telephony_credential_id: credA });
  });

  it('moving back to the service carrier must clear the credential in the same PATCH', async () => {
    const campaign = await plivoCampaign();
    const kept = await patch(campaign.id, { telephony_provider: 'voicelink', caller_ids: ['+919000000001'] });
    expect(kept.statusCode).toBe(400);
    expect(kept.json().details).toHaveProperty('telephony_credential_id');
    const cleared = await patch(campaign.id, { telephony_provider: 'voicelink', telephony_credential_id: null, caller_ids: ['+919000000001'] });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ telephony_provider: 'voicelink', telephony_credential_id: null });
  });

  it('a caller-ID edit on a pinned campaign is judged against the credential\'s numbers', async () => {
    const campaign = await plivoCampaign();
    const res = await patch(campaign.id, { caller_ids: [THEIRS] });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.caller_ids).toContain(THEIRS);
    expect((await patch(campaign.id, { caller_ids: [MINE[1]] })).statusCode).toBe(200);
  });

  it('a stored caller ID retired since does not lock the campaign: a save resending the pool is accepted', async () => {
    const campaign = await plivoCampaign();
    // A sync retires MINE[1]; the settings page still resends the whole stored pool.
    await phoneNumberRepository.syncForCredential(credA, [{ phone_number: MINE[0]!, label: null }], null);
    const res = await patch(campaign.id, { name: 'Renamed', caller_ids: MINE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Renamed', caller_ids: MINE });
    // Naming the same carrier account it is already on changes nothing about that.
    const same = await patch(campaign.id, { telephony_provider: 'plivo', telephony_credential_id: credA, caller_ids: MINE });
    expect(same.statusCode, same.body).toBe(200);
  });

  it('only the caller IDs a save ADDS are judged on the same carrier account', async () => {
    const campaign = await plivoCampaign({ caller_ids: [MINE[0]] });
    await phoneNumberRepository.syncForCredential(credA, [{ phone_number: MINE[0]!, label: null }], null);
    const res = await patch(campaign.id, { caller_ids: [MINE[0], MINE[1], THEIRS] });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.caller_ids).toContain(MINE[1]);
    expect(res.json().details.caller_ids).toContain(THEIRS);
  });

  it('moving to another credential judges the whole pool, stored numbers included', async () => {
    const credB = await insertCredential(TENANT, 'Second');
    await phoneNumberRepository.syncForCredential(credB, [{ phone_number: '+14155550004', label: null }], null);
    const campaign = await plivoCampaign();
    const res = await patch(campaign.id, { telephony_credential_id: credB, caller_ids: [...MINE, '+14155550004'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.caller_ids).toContain(MINE[0]);
  });

  it('a caller-ID edit is not refused because the credential was disabled since (the pin is not being set)', async () => {
    const campaign = await plivoCampaign({ status: 'paused' });
    await setStatus(credA, 'disabled');
    const res = await patch(campaign.id, { caller_ids: [MINE[0]] });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('re-pinning to another tenant\'s credential is not found', async () => {
    const campaign = await plivoCampaign();
    const res = await patch(campaign.id, { telephony_credential_id: credOther, caller_ids: [THEIRS] });
    expect(res.statusCode).toBe(404);
    const { rows } = await (await pool()).query('SELECT telephony_credential_id FROM agency_campaigns WHERE id = $1', [campaign.id]);
    expect(rows[0]!.telephony_credential_id).toBe(credA);
  });
});

describe('PATCH — the config-change record names the carrier account by its label (IN8)', () => {
  const changeOf = (res: { headers: Record<string, unknown> }) =>
    decodeConfigChange(res.headers['x-mgkvc-config-change'] as string | undefined);

  it('each side that is a tenant account carries its label as it was; the service account carries none', async () => {
    const campaign = await insertAgencyCampaign();
    const onto = await patch(campaign.id, { telephony_provider: 'plivo', telephony_credential_id: credA, caller_ids: MINE });
    expect(onto.statusCode, onto.body).toBe(200);
    expect(changeOf(onto)?.changes['telephony_credential_id']).toEqual({ from: null, to: credA, to_label: 'Main' });

    // Revoked since: its label is still what the trail shows.
    await (await pool()).query(`UPDATE telephony_credentials SET status = 'revoked', revoked_at = NOW() WHERE id = $1`, [credA]);
    const off = await patch(campaign.id, { telephony_provider: 'voicelink', telephony_credential_id: null, caller_ids: ['+919000000001'] });
    expect(off.statusCode, off.body).toBe(200);
    expect(changeOf(off)?.changes['telephony_credential_id']).toEqual({ from: credA, to: null, from_label: 'Main' });
  });
});

describe('start and resume on a pinned campaign', () => {
  it('start is refused while the credential is not active, and allowed once it is', async () => {
    const campaign = await plivoCampaign();
    await insertAgencyContact(campaign.id);
    await setStatus(credA, 'invalid');
    const refused = await post(campaign.id, 'start');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'telephony_credential_not_active' });
    expect(refused.json().message).toContain('invalid');
    await setStatus(credA, 'active');
    const started = await post(campaign.id, 'start');
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().status).toBe('running');
  });

  it('a carrier_auth pause cannot be resumed until the credential is active; resuming clears the reason', async () => {
    const campaign = await plivoCampaign({ status: 'paused', pause_reason: 'carrier_auth', paused_at: new Date() });
    await setStatus(credA, 'disabled');
    const refused = await post(campaign.id, 'resume');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'telephony_credential_not_active' });
    await setStatus(credA, 'active');
    const resumed = await post(campaign.id, 'resume');
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json()).toMatchObject({ status: 'running', pause_reason: null });
  });

  it('a carrier_refusing_calls pause resumes while the credential is active; resuming clears the reason (PL11)', async () => {
    const campaign = await plivoCampaign({ status: 'paused', pause_reason: 'carrier_refusing_calls', paused_at: new Date() });
    const resumed = await post(campaign.id, 'resume');
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json()).toMatchObject({ status: 'running', pause_reason: null });
  });

  it('start and resume are refused while the carrier cannot dial from this server (no webhook base), with a vendor-free message (PL12)', async () => {
    const plivo = config.telephony.plivo as { webhookBaseUrl: string };
    const saved = plivo.webhookBaseUrl;
    plivo.webhookBaseUrl = '';
    try {
      const draft = await plivoCampaign();
      await insertAgencyContact(draft.id);
      const paused = await plivoCampaign({ status: 'paused', pause_reason: 'supervisor', paused_at: new Date() });
      for (const [id, verb] of [[draft.id, 'start'], [paused.id, 'resume']] as const) {
        const refused = await post(id, verb);
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json()).toMatchObject({ code: 'carrier_not_ready' });
        expect(refused.json().message).not.toMatch(/plivo|voicelink|PLIVO_/i);
      }
      // A service-carrier campaign is not judged by it.
      const own = await insertAgencyCampaign();
      await insertAgencyContact(own.id);
      expect((await post(own.id, 'start')).statusCode).toBe(200);
    } finally {
      plivo.webhookBaseUrl = saved;
    }
  });

  it('pause and stop are never refused for it (they reduce dialling)', async () => {
    const campaign = await plivoCampaign({ status: 'running' });
    await setStatus(credA, 'disabled');
    expect((await post(campaign.id, 'pause')).statusCode).toBe(200);
    expect((await post(campaign.id, 'stop')).statusCode).toBe(200);
  });

  it('start and resume are refused while none of the caller IDs is still on the carrier account (PL13)', async () => {
    const campaign = await plivoCampaign();
    await insertAgencyContact(campaign.id);
    // A sync retires both stored numbers.
    await phoneNumberRepository.syncForCredential(credA, [{ phone_number: '+14155550005', label: null }], null);
    const refused = await post(campaign.id, 'start');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'campaign_caller_ids_unavailable' });
    expect(refused.json().message).not.toMatch(/plivo|voicelink/i);

    const paused = await plivoCampaign({ status: 'paused', paused_at: new Date(), pause_reason: 'supervisor' });
    const resume = await post(paused.id, 'resume');
    expect(resume.statusCode).toBe(409);
    expect(resume.json()).toMatchObject({ code: 'campaign_caller_ids_unavailable' });

    // One number back on the account: it starts, and dials from that one only.
    await phoneNumberRepository.syncForCredential(credA, [{ phone_number: MINE[0]!, label: null }], null);
    invalidateDialableCallerIds();
    const started = await post(campaign.id, 'start');
    expect(started.statusCode, started.body).toBe(200);
  });

  it('start and resume are refused while the account’s per-carrier concurrency gives the carrier no lines (PL14)', async () => {
    const { providerConcurrencyRepository } = await import('@magick-agency/db/repositories/provider-concurrency.repository');
    const campaign = await plivoCampaign();
    await insertAgencyContact(campaign.id);
    const breakdown = (providers: Array<{ provider: string; max_concurrent_calls: number }>, version: number) =>
      providerConcurrencyRepository.replaceProviderBreakdown({ tenant_id: TENANT, account_id: ACCOUNT, expected_version: version, providers });
    // The account splits its lines by carrier, none for this campaign's.
    await breakdown([{ provider: 'voicelink', max_concurrent_calls: 5 }], 1);
    const refused = await post(campaign.id, 'start');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'carrier_capacity_unallocated' });
    expect(refused.json().message).toMatch(/Contact support to add capacity for this carrier/);
    expect(refused.json().message).not.toMatch(/plivo|voicelink/i);

    const paused = await plivoCampaign({ status: 'paused', paused_at: new Date(), pause_reason: 'supervisor' });
    expect((await post(paused.id, 'resume')).json()).toMatchObject({ code: 'carrier_capacity_unallocated' });

    // A service-carrier campaign on the same account is not refused: it has lines.
    const service = await insertAgencyCampaign();
    await insertAgencyContact(service.id);
    expect((await post(service.id, 'start')).statusCode).toBe(200);

    await breakdown([{ provider: 'voicelink', max_concurrent_calls: 5 }, { provider: 'plivo', max_concurrent_calls: 2 }], 2);
    const started = await post(campaign.id, 'start');
    expect(started.statusCode, started.body).toBe(200);
  });

  it('the stats strip names a running campaign that cannot dial on its carrier account (PL13, PL14)', async () => {
    const stall = async (id: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/agency-campaigns/${id}/stats`, headers: HEADERS });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { stall: { code: string } | null; other_stalls: string[] };
    };
    const campaign = await plivoCampaign({ status: 'running' });
    expect([(await stall(campaign.id)).stall?.code, ...(await stall(campaign.id)).other_stalls])
      .not.toContain('no_dialable_caller_ids');

    // Every stored number retired by a sync: named, with the stored count.
    await phoneNumberRepository.syncForCredential(credA, [], null);
    invalidateDialableCallerIds();
    expect((await stall(campaign.id)).stall).toEqual({ code: 'no_dialable_caller_ids', caller_ids_stored: 2 });

    // No lines for the carrier on an account split by carrier.
    const { providerConcurrencyRepository } = await import('@magick-agency/db/repositories/provider-concurrency.repository');
    await providerConcurrencyRepository.replaceProviderBreakdown({
      tenant_id: TENANT, account_id: ACCOUNT, expected_version: 1, providers: [{ provider: 'voicelink', max_concurrent_calls: 5 }],
    });
    const both = await stall(campaign.id);
    expect(both.stall?.code).toBe('no_dialable_caller_ids');
    expect(both.other_stalls).toContain('no_carrier_capacity');

    // A carrier pause is named on its own, with its reason.
    const paused = await plivoCampaign({ status: 'paused', pause_reason: 'carrier_auth', paused_at: new Date() });
    expect((await stall(paused.id)).stall).toMatchObject({ code: 'auto_paused_carrier', reason: 'carrier_auth' });
  });

  it('a service-carrier campaign starts without any credential read', async () => {
    const campaign = await insertAgencyCampaign();
    await insertAgencyContact(campaign.id);
    expect((await post(campaign.id, 'start')).statusCode).toBe(200);
  });
});

describe('retry of a pinned campaign', () => {
  it('the child inherits the credential; an override to another tenant\'s is refused', async () => {
    const parent = await plivoCampaign({ status: 'completed' });
    await insertAgencyContact(parent.id);
    const refused = await post(parent.id, 'retry', {
      selector: { state: ['pending'] }, config_overrides: { telephony_credential_id: credOther, caller_ids: [THEIRS] },
    });
    expect(refused.statusCode).toBe(404);
    const res = await post(parent.id, 'retry', { selector: { state: ['pending'] } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().campaign).toMatchObject({ telephony_provider: 'plivo', telephony_credential_id: credA, caller_ids: MINE });
  });

  it('a caller-ID override keeping a number retired since is accepted; one adding a foreign number is not', async () => {
    const parent = await plivoCampaign({ status: 'completed' });
    await insertAgencyContact(parent.id);
    await phoneNumberRepository.syncForCredential(credA, [{ phone_number: MINE[0]!, label: null }], null);
    const refused = await post(parent.id, 'retry', {
      selector: { state: ['pending'] }, config_overrides: { caller_ids: [...MINE, THEIRS] },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().details.caller_ids).toContain(THEIRS);
    expect(refused.json().details.caller_ids).not.toContain(MINE[1]);
    const res = await post(parent.id, 'retry', { selector: { state: ['pending'] }, config_overrides: { caller_ids: MINE } });
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('agencyCampaignRepository.pauseForCarrierAccount — the pinned credential cannot dial', () => {
  it.each(['carrier_auth', 'carrier_account_unavailable', 'carrier_refusing_calls'] as const)('pauses a running campaign `%s`, clears the actor and the abandonment evidence, and then refuses a second time', async (reason) => {
    const campaign = await plivoCampaign({
      status: 'running', last_transition_by_name: 'Asha', pause_abandonment_rate_pct: 7.5,
    });
    const paused = await agencyCampaignRepository.pauseForCarrierAccount(campaign.id, reason);
    expect(paused).toMatchObject({
      id: campaign.id, status: 'paused', pause_reason: reason,
      pause_abandonment_rate_pct: null, last_transition_by_user_id: null, last_transition_by_name: null,
    });
    expect(paused!.paused_at).toBeInstanceOf(Date);
    // Already paused: nothing more is written (the caller writes no second audit row).
    expect(await agencyCampaignRepository.pauseForCarrierAccount(campaign.id, 'carrier_auth')).toBeNull();
    const { rows } = await (await pool()).query('SELECT status, pause_reason FROM agency_campaigns WHERE id = $1', [campaign.id]);
    expect(rows[0]).toEqual({ status: 'paused', pause_reason: reason });
  });

  it.each(['draft', 'stopping', 'stopped', 'completed'])('leaves a %s campaign alone', async (status) => {
    const campaign = await plivoCampaign({ status });
    expect(await agencyCampaignRepository.pauseForCarrierAccount(campaign.id, 'carrier_account_unavailable')).toBeNull();
    const { rows } = await (await pool()).query('SELECT status, pause_reason FROM agency_campaigns WHERE id = $1', [campaign.id]);
    expect(rows[0]).toEqual({ status, pause_reason: null });
  });

  it('a supervisor`s pause is not rewritten', async () => {
    const campaign = await plivoCampaign({ status: 'paused', pause_reason: 'supervisor', paused_at: new Date() });
    expect(await agencyCampaignRepository.pauseForCarrierAccount(campaign.id, 'carrier_account_unavailable')).toBeNull();
    const { rows } = await (await pool()).query('SELECT pause_reason FROM agency_campaigns WHERE id = $1', [campaign.id]);
    expect(rows[0]!.pause_reason).toBe('supervisor');
  });
});
