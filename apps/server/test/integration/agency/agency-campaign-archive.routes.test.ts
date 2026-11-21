import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT } from '../setup/factories.js';
import { insertAgencyCampaign } from './agency-factories.js';

/**
 * ─── Archived campaigns (AR1–AR7), the internal handlers against a real Postgres ─────
 *
 * `POST /:id/archive` and `/:id/unarchive`, the list's `archived` filter, and Start refused on an
 * archived draft. The rules live in SQL as much as in the routes (the archive's conditional UPDATE,
 * `transitionStatus`'s `archived_at IS NULL`, the 0063 CHECK), which a mocked pool cannot show.
 */

vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

// The Start route's carrier checks read through the connection module rather than the barrel.
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { flags } = vi.hoisted(() => ({
  flags: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean' } },
}));

const { agencyCampaignRoutes } = await import('../../../src/api/routes/agency-campaigns.routes.js');
const { agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
type AgencyCampaignRouteDeps = import('../../../src/api/routes/agency-campaigns.routes.js').AgencyCampaignRouteDeps;

const BASE = '/api/v1/agency-campaigns';
const OWNER = { 'x-mgkvc-tenant': DEFAULTS.tenantId, 'x-mgkvc-account': DEFAULTS.accountId };
const ACTOR = randomUUID();

describe('archived campaigns (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await truncateAll();
    flags.isEnabled.mockResolvedValue(true);
    app = Fastify({ logger: false });
    await app.register(async (scope) => agencyCampaignRoutes(scope, {} as AgencyCampaignRouteDeps), { prefix: BASE });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(closeTestPool);

  const post = (path: string, payload?: unknown) =>
    app.inject({ method: 'POST', url: `${BASE}${path}`, headers: OWNER, ...(payload ? { payload } : {}) });
  const list = (query = '') => app.inject({ method: 'GET', url: `${BASE}${query}`, headers: OWNER });

  it('archives a draft and a stopped campaign, keeping their status and naming who archived them', async () => {
    const draft = await insertAgencyCampaign({ name: 'Draft', status: 'draft' });
    const stopped = await insertAgencyCampaign({ name: 'Stopped', status: 'stopped' });

    const a = await post(`/${draft.id}/archive`, { actor_user_id: ACTOR, actor_name: '  Ravi Kumar  ' });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ id: draft.id, status: 'draft', archived_by: { user_id: ACTOR, name: 'Ravi Kumar' } });
    expect(a.json().archived_at).toEqual(expect.any(String));
    // Folded, never served flat.
    expect(a.json()).not.toHaveProperty('archived_by_user_id');
    expect(a.json()).not.toHaveProperty('archived_by_name');

    const b = await post(`/${stopped.id}/archive`);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ status: 'stopped', archived_by: null });
  });

  it('records an id that is not a UUID as unattributed rather than failing the archive', async () => {
    const draft = await insertAgencyCampaign({ status: 'draft' });
    const res = await post(`/${draft.id}/archive`, { actor_user_id: 'not-a-uuid', actor_name: 'X' });
    expect(res.statusCode).toBe(200);
    expect(res.json().archived_by).toBeNull();
  });

  it.each(['running', 'paused', 'stopping', 'completed'])('refuses to archive a %s campaign, 409 campaign_not_archivable', async (status) => {
    const c = await insertAgencyCampaign({ status });
    const res = await post(`/${c.id}/archive`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'campaign_not_archivable', current_status: status, archived_at: null });
    expect((await agencyCampaignRepository.findById(c.id as string))?.archived_at).toBeNull();
  });

  it('refuses to archive one already archived, 409 campaign_archived, and keeps the first stamp', async () => {
    const draft = await insertAgencyCampaign({ status: 'draft' });
    const first = (await post(`/${draft.id}/archive`, { actor_user_id: ACTOR })).json();
    const again = await post(`/${draft.id}/archive`, { actor_user_id: randomUUID() });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'campaign_archived', current_status: 'draft' });
    const row = await agencyCampaignRepository.findById(draft.id as string);
    expect(row?.archived_by_user_id).toBe(ACTOR);
    expect(row?.archived_at?.toISOString()).toBe(first.archived_at);
  });

  it('restores an archived campaign as it was, clearing who archived it', async () => {
    const stopped = await insertAgencyCampaign({ status: 'stopped' });
    await post(`/${stopped.id}/archive`, { actor_user_id: ACTOR, actor_name: 'Ravi' });

    const res = await post(`/${stopped.id}/unarchive`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'stopped', archived_at: null, archived_by: null });

    const again = await post(`/${stopped.id}/unarchive`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'campaign_not_archived', current_status: 'stopped' });
  });

  it('refuses Start on an archived draft, 409 campaign_archived, and starts it once restored past that refusal', async () => {
    const draft = await insertAgencyCampaign({ status: 'draft' });
    await post(`/${draft.id}/archive`);

    const res = await post(`/${draft.id}/start`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'campaign_archived', current_status: 'draft' });
    expect((await agencyCampaignRepository.findById(draft.id as string))?.status).toBe('draft');

    await post(`/${draft.id}/unarchive`);
    // Restored, Start is judged as any draft's: this one has no contacts, so the roster refusal.
    const restarted = await post(`/${draft.id}/start`);
    expect(restarted.json().code).toBe('campaign_roster_empty');
  });

  it('answers Stop, Pause and Resume on an archived campaign as before archiving: the ordinary transition refusal', async () => {
    for (const status of ['draft', 'stopped']) {
      const c = await insertAgencyCampaign({ status });
      await post(`/${c.id}/archive`);
      // Resume moves into `running` too, but from `paused`: not a move an archived campaign
      // could make, so it is not told to restore it.
      for (const action of ['stop', 'pause', 'resume']) {
        const res = await post(`/${c.id}/${action}`);
        expect(res.statusCode, `${action} ${status}`).toBe(409);
        expect(res.json(), `${action} ${status}`).toMatchObject({ code: 'invalid_campaign_transition', current_status: status });
      }
    }
  });

  it('names the archive when an archive lands between Start\'s read and its write', async () => {
    const draft = await insertAgencyCampaign({ status: 'draft' });
    await getTestPool().query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164) VALUES ($1, $2, $3, '+919876543210')`,
      [draft.id, DEFAULTS.tenantId, DEFAULTS.accountId],
    );
    const real = agencyCampaignRepository.transitionStatus.bind(agencyCampaignRepository);
    const spy = vi.spyOn(agencyCampaignRepository, 'transitionStatus').mockImplementationOnce(async (...args) => {
      await agencyCampaignRepository.archive(draft.id as string, null);
      return real(...args);
    });
    try {
      const res = await post(`/${draft.id}/start`);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: 'campaign_archived', current_status: 'draft' });
      expect(res.json().archived_at).toEqual(expect.any(String));
    } finally {
      spy.mockRestore();
    }
  });

  it('transitionStatus itself moves no archived campaign, whatever the route checked', async () => {
    const draft = await insertAgencyCampaign({ status: 'draft' });
    await agencyCampaignRepository.archive(draft.id as string, null);
    expect(await agencyCampaignRepository.transitionStatus(draft.id as string, ['draft'], 'running')).toBeNull();
    expect((await agencyCampaignRepository.findById(draft.id as string))?.status).toBe('draft');
  });

  it('archive loses to a Start that committed first: the write matches nothing', async () => {
    const draft = await insertAgencyCampaign({ status: 'draft' });
    await getTestPool().query(`UPDATE agency_campaigns SET status = 'running' WHERE id = $1`, [draft.id]);
    expect(await agencyCampaignRepository.archive(draft.id as string, null)).toBeNull();
  });

  it('lists campaigns that are not archived by default, and only the archived ones with archived=true', async () => {
    const live = await insertAgencyCampaign({ name: 'Live', status: 'running' });
    const kept = await insertAgencyCampaign({ name: 'Kept', status: 'stopped' });
    const old = await insertAgencyCampaign({ name: 'Old', status: 'stopped' });
    const draft = await insertAgencyCampaign({ name: 'Draft', status: 'draft' });
    // Another account's archived campaign is never listed.
    const foreign = await insertAgencyCampaign({ name: 'Foreign', status: 'draft', account_id: OTHER_ACCOUNT });
    await post(`/${old.id}/archive`);
    await post(`/${draft.id}/archive`);
    await agencyCampaignRepository.archive(foreign.id as string, null);

    const main = (await list()).json();
    expect(main.total).toBe(2);
    expect(main.campaigns.map((c: { id: string }) => c.id).sort()).toEqual([live.id, kept.id].sort());
    expect((await list('?archived=false')).json().total).toBe(2);

    const archived = (await list('?archived=true')).json();
    expect(archived.total).toBe(2);
    // Newest archived first.
    expect(archived.campaigns.map((c: { id: string }) => c.id)).toEqual([draft.id, old.id]);

    // `status` narrows within the archived list too.
    const stoppedOnly = (await list('?archived=true&status=stopped')).json();
    expect(stoppedOnly.campaigns.map((c: { id: string }) => c.id)).toEqual([old.id]);
  });

  it('refuses an archived filter it does not know, 400', async () => {
    const res = await list('?archived=yes');
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/archived/);
  });

  it('answers 404 for a campaign in another account', async () => {
    const foreign = await insertAgencyCampaign({ status: 'draft', account_id: OTHER_ACCOUNT });
    expect((await post(`/${foreign.id}/archive`)).statusCode).toBe(404);
    expect((await agencyCampaignRepository.findById(foreign.id as string))?.archived_at).toBeNull();
  });
});
