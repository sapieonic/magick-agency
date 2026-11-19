import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgentSession } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { FloorAssistService } = await import('../../../src/agency/floor-assist.js');
const { agencyFloorAssistRepository } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * Need help's expiry on REAL time (LF4; `agency/floor-assist.ts`): the service over the real
 * repository and Postgres, with the expiry shortened to 1.5 s and the sweep's timer at 200 ms, so
 * the clock that moves is the database's own `now()` and the timer is a real one. In the
 * `wall-clock` lane (`vitest.config.integration.ts`): it waits about 3 s on purpose. The 15-minute
 * value itself is pinned by backdating rows (`floor-assist-repository.test.ts`, the e2e suite).
 *
 * Covered: a request left unanswered expires by the timer alone, with one `help_cleared { expired }`
 * frame and one audit row, and its columns cleared; the floor's read stops serving it at the expiry,
 * before any sweep has run; a request answered before its expiry never expires.
 */

const EXPIRY_MS = 1_500;
const SWEEP_MS = 200;

beforeEach(truncateAll);
afterAll(closeTestPool);

interface Session { id: string; tenant_id: string; account_id: string; campaign_id: string | null; agent_user_id: string }

async function session(): Promise<Session> {
  const campaign = await insertAgencyCampaign({ status: 'running' });
  return await insertAgentSession(campaign.id as string, { state: 'on_call' }) as unknown as Session;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Need help expires on the real clock', () => {
  it('unanswered: the timer expires it once (frame, audit row, columns cleared); the floor stops serving it at the expiry, before any sweep', async () => {
    const frames: Array<[string, Record<string, unknown>]> = [];
    const audits: Array<Record<string, unknown>> = [];
    const service = new FloorAssistService({
      repo: agencyFloorAssistRepository,
      send: (sessionId, frame) => { frames.push([sessionId, frame as never]); return true; },
      canReceive: () => true,
      names: async () => new Map(),
      audit: (entry) => { audits.push(entry as never); },
      expiryMs: EXPIRY_MS,
    });
    const left = await session();
    const answered = await session();
    const raisedLeft = await service.raise(left, null);
    await service.raise(answered, null);
    const open = await agencyFloorAssistRepository.openForAccount(left.tenant_id, left.account_id, EXPIRY_MS);
    expect(open.map((r) => r.session_id).sort()).toEqual([left.id, answered.id].sort());

    // Answered well before its expiry: never expires.
    await sleep(500);
    expect(await service.answer({ sessionId: answered.id, tenantId: answered.tenant_id, byUserId: left.agent_user_id, how: 'message' })).toBe(true);

    // Past the expiry, no sweep yet: the floor no longer serves it (lazy expiry on read).
    await sleep(EXPIRY_MS);
    expect(await agencyFloorAssistRepository.openForAccount(left.tenant_id, left.account_id, EXPIRY_MS)).toEqual([]);
    expect(frames.filter(([, f]) => f['reason'] === 'expired')).toEqual([]);

    // The sweep's timer, on real time, expires it: once.
    service.startSweep(SWEEP_MS);
    try {
      await sleep(SWEEP_MS * 5);
    } finally {
      await service.stopSweep();
    }
    const expired = frames.filter(([, f]) => f['reason'] === 'expired');
    expect(expired).toEqual([[left.id, { event: 'help_cleared', raised_at: raisedLeft.help!.raised_at, reason: 'expired' }]]);
    expect(audits.filter((a) => a['action'] === 'agency_session.help_expired').map((a) => a['resource_id'])).toEqual([left.id]);
    const { rows } = await getTestPool().query(
      'SELECT id, help_raised_at IS NULL AS cleared, help_answered_at IS NOT NULL AS answered FROM agency_agent_sessions WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[left.id, answered.id]]);
    expect(rows).toEqual([
      { id: left.id, cleared: true, answered: false },
      { id: answered.id, cleared: false, answered: true },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)));
  }, 15_000);
});
