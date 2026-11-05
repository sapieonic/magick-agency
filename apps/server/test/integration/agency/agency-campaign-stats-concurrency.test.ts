import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, insertAccountSettings } from '../setup/factories.js';
import {
  insertAgencyAttempt,
  insertAgencyCampaign,
  insertAgencyContact,
  insertManualCall,
  insertSoftphoneSession,
} from './agency-factories.js';

/*
 * `concurrency` on `GET /api/v1/agency-campaigns/:id/stats` (decisions MC7): where one
 * campaign sits in its account's line limit now that several campaigns may run at once.
 * Real Postgres for the three reads behind it — the account's `max_concurrent_calls`,
 * `countLiveForAccount` (attempts of every campaign plus live soft-phone calls) and the
 * account's running campaigns — so a predicate that drifts from pacing's reds here.
 *
 * Harness as `agency-campaign-stats.routes.test.ts` (the route runs on the private
 * in-process instance, header auth only), plus `@magick-agency/db/connection`: the
 * account-settings repository imports the pool from there, not from the package root,
 * and without it the limit read degrades and `concurrency` is `null` in every case.
 */

vi.mock('@magick-agency/db/connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db/connection')>()),
  getPool: () => getTestPool(),
}));

vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({
  auditLogger: { log: vi.fn() },
}));

const { flags } = vi.hoisted(() => ({
  flags: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean' } },
}));

const { agencyCampaignRoutes } = await import(
  '../../../src/api/routes/agency-campaigns.routes.js'
);
type AgencyCampaignRouteDeps = import(
  '../../../src/api/routes/agency-campaigns.routes.js'
).AgencyCampaignRouteDeps;

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;
const LIMIT = 10;

/** Healthy strip dependencies; this file is about the SQL half of `concurrency`. */
function statsDeps(): AgencyCampaignRouteDeps {
  return {
    runtime: {
      dnc: { appliedVersion: vi.fn(async () => 1) },
      stations: { connectedBySession: vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, true]))) },
    },
    callManager: {
      accountConcurrencyGuard: {
        getDistributedAccountCount: vi.fn(async () => ({ status: 'available' as const, count: 0 })),
      },
    },
  } as unknown as AgencyCampaignRouteDeps;
}

let app: FastifyInstance;

async function concurrencyOf(campaignId: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/agency-campaigns/${campaignId}/stats`,
    headers: { 'x-mgkvc-tenant': TENANT, 'x-mgkvc-account': ACCOUNT },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  // The key is always sent, so a console can tell "not reported" (absent, an older
  // server) from "holds no lines" (`null`).
  expect(body).toHaveProperty('concurrency');
  return { concurrency: body.concurrency, attemptsLive: body.attempts_live as number };
}

/** `count` live attempts on `campaignId`, each on its own contact, plus one ended one. */
async function liveAttempts(campaignId: string, count: number, accountId = ACCOUNT) {
  for (let i = 0; i < count; i += 1) {
    const contact = await insertAgencyContact(campaignId, {
      account_id: accountId, state: 'in_flight', source_row_number: i + 1,
    });
    await insertAgencyAttempt(campaignId, contact.id, {
      account_id: accountId, state: i % 2 === 0 ? 'queued' : 'answered', answered_at: i % 2 === 0 ? null : new Date(),
    });
  }
  const done = await insertAgencyContact(campaignId, {
    account_id: accountId, state: 'completed', source_row_number: count + 1,
  });
  await insertAgencyAttempt(campaignId, done.id, {
    account_id: accountId, state: 'ended', outcome: 'no_answer', ended_at: new Date(),
  });
}

describe('GET /api/v1/agency-campaigns/:id/stats · concurrency (MC7, integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    flags.isEnabled.mockResolvedValue(true);
    await insertAccountSettings({ max_concurrent_calls: LIMIT });

    app = Fastify({ logger: false });
    await app.register(async (scope) => agencyCampaignRoutes(scope, statsDeps()), {
      prefix: '/api/v1/agency-campaigns',
    });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(closeTestPool);

  it('splits the limit equally between two running campaigns and counts every live call on the account', async () => {
    const first = await insertAgencyCampaign({ status: 'running' });
    const second = await insertAgencyCampaign({ status: 'running' });
    const paused = await insertAgencyCampaign({ status: 'paused' });
    await liveAttempts(first.id, 3);
    await liveAttempts(second.id, 1);
    // A paused campaign still has a call draining: it is on the account's lines.
    await liveAttempts(paused.id, 1);
    // A live soft-phone call holds a line and belongs to no campaign.
    await insertManualCall(await insertSoftphoneSession());
    // Another account's running campaign and its calls are not this account's.
    const elsewhere = await insertAgencyCampaign({ status: 'running', account_id: OTHER_ACCOUNT });
    await liveAttempts(elsewhere.id, 2, OTHER_ACCOUNT);

    const { concurrency, attemptsLive } = await concurrencyOf(first.id);

    expect(concurrency).toEqual({
      campaign_live: 3,
      fair_share: 5,
      account_limit: LIMIT,
      account_live: 3 + 1 + 1 + 1,
      running_campaigns: 2,
    });
    expect(concurrency.campaign_live).toBe(attemptsLive);

    // The other running campaign sees the same account and its own live calls.
    expect((await concurrencyOf(second.id)).concurrency).toMatchObject({
      campaign_live: 1, fair_share: 5, account_live: 6, running_campaigns: 2,
    });
  });

  it('rounds the share down', async () => {
    const campaigns = await Promise.all([1, 2, 3].map(() => insertAgencyCampaign({ status: 'running' })));

    const { concurrency } = await concurrencyOf(campaigns[0]!.id);

    expect(concurrency).toMatchObject({ fair_share: 3, account_limit: LIMIT, running_campaigns: 3 });
  });

  it('gives no share to a campaign running alone, and none to a paused or stopping one', async () => {
    const running = await insertAgencyCampaign({ status: 'running' });
    const paused = await insertAgencyCampaign({ status: 'paused' });
    const stopping = await insertAgencyCampaign({ status: 'stopping' });
    await liveAttempts(running.id, 2);
    await liveAttempts(stopping.id, 1);

    expect((await concurrencyOf(running.id)).concurrency).toEqual({
      campaign_live: 2, fair_share: null, account_limit: LIMIT, account_live: 3, running_campaigns: 1,
    });
    expect((await concurrencyOf(paused.id)).concurrency).toEqual({
      campaign_live: 0, fair_share: null, account_limit: LIMIT, account_live: 3, running_campaigns: 1,
    });
    expect((await concurrencyOf(stopping.id)).concurrency).toEqual({
      campaign_live: 1, fair_share: null, account_limit: LIMIT, account_live: 3, running_campaigns: 1,
    });
  });

  it('is null for a draft or a finished campaign, which hold no lines', async () => {
    await insertAgencyCampaign({ status: 'running' });
    for (const status of ['draft', 'completed', 'stopped']) {
      const campaign = await insertAgencyCampaign({ status });
      expect((await concurrencyOf(campaign.id)).concurrency, status).toBeNull();
    }
  });
});
