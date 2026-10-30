import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertSoftphoneSession } from './agency-factories.js';
import { DEFAULTS, uuidFor } from '../setup/factories.js';

/**
 * ─── `POST /sessions` WHILE ON THE SOFT PHONE, REAL REPOSITORY ──────────────
 *
 * `test/unit/agency/session-join-conflict-route.test.ts` proves the route's 409
 * `session_on_softphone` body from a mocked repository result. This drives the
 * same route over the REAL `joinOrRehydrate` on Postgres, so the result the route
 * narrows on is the one the database actually produced for a NULL-campaign
 * blocker — and the soft-phone row is left exactly as it was.
 */

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));
vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn(async () => { /* authenticated */ }),
  getTenantId: (req: { headers: Record<string, string> }) => req.headers['x-mgkvc-tenant'],
  getAccountId: (req: { headers: Record<string, string> }) => req.headers['x-mgkvc-account'],
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({ isEnabled: async () => true }),
  FLAGS: { agency_dialer_enabled: { default: false } },
}));

const { agencyRoutes } = await import('../../../src/api/routes/agency.routes.js');

const mint = vi.fn();
function makeRuntime() {
  return {
    replicaId: 'replica-new',
    agents: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), clear: vi.fn() },
    wrapup: { stateFor: vi.fn(() => null) },
    stations: { send: vi.fn(() => true), attach: vi.fn(), detach: vi.fn(), isLocallyOwned: vi.fn(() => true) },
    // The soft phone's runtime surface (docs/softphone.md): nothing live in these tests.
    softphone: { hasLiveCall: vi.fn(() => false), reattachStation: vi.fn(async () => null) },
    dialer: { hasLiveAttempt: vi.fn(() => false), noteStationClosed: vi.fn(), reattachStation: vi.fn(() => null) },
    breaks: { queue: vi.fn(), take: vi.fn(() => null), cancel: vi.fn(() => false) },
    tokens: { mint, verifyAndConsume: vi.fn() },
    rehydrateAgent: vi.fn().mockResolvedValue('break'),
    releaseStationOnClose: vi.fn().mockResolvedValue(true),
  };
}

const HEADERS = { 'x-mgkvc-tenant': DEFAULTS.tenantId, 'x-mgkvc-account': DEFAULTS.accountId };

describe('POST /sessions on the soft phone — real repository (integration)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAll();
  });
  afterAll(closeTestPool);

  it('409s session_on_softphone with the soft-phone session, and leaves it untouched', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const agent = uuidFor('sp-route-agent');
    const sp = await insertSoftphoneSession({ agent_user_id: agent, owner_replica: 'replica-old' });

    const app = Fastify();
    await app.register((a) => agencyRoutes(a as never, makeRuntime() as never), { prefix: '/api/v1/agency' });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/agency/sessions', headers: HEADERS,
        payload: { campaign_id: campaign.id, agent_user_id: agent },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'Conflict',
        code: 'session_on_softphone',
        message: expect.stringMatching(/soft phone/i),
        session_id: sp.id,
      });
      expect(mint).not.toHaveBeenCalled();
      const { rows } = await getTestPool().query(
        'SELECT * FROM agency_agent_sessions WHERE agent_user_id = $1', [agent],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].owner_replica).toBe('replica-old');
      expect(rows[0].kind).toBe('softphone');
    } finally {
      await app.close();
    }
  });
});
