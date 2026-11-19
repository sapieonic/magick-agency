import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT } from '../setup/factories.js';
import { insertAgencyCampaign } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { computeHomeBoard, resetHomeBoardMemosForTests } = await import('../../../src/agency/home-board.js');

/**
 * Who paused or stopped a campaign, on Home's board (decision B28b), from real rows: a supervisor's
 * pause and the guardrail's automatic one through the repository's own transitions (which write
 * `paused_at`, `pause_reason` and `last_transition_by_*`), and a stop's time from the `stopping_at`
 * the same transition stamps (0051), never from the Stop's audit row: the route writes that row
 * after the transition and does not wait for it, so the console's reload straight after Stop can
 * read the board before it exists. Names here are the recorded ones (the lookup answers none), so
 * what is asserted is what the rows hold.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const SUPERVISOR = randomUUID();
const STOPPER = randomUUID();
const deps = { liveStats: async () => null, insights: null, names: async () => new Map<string, string | null>() };

let paused: { id: string };
let auto: { id: string };
let stopping: { id: string };
let stoppingBefore0051: { id: string };

async function stamps(id: string): Promise<{ status: string; stopping_at: Date | null; updated_at: Date }> {
  const { rows } = await getTestPool().query<{ status: string; stopping_at: Date | null; updated_at: Date }>(
    'SELECT status, stopping_at, updated_at FROM agency_campaigns WHERE id = $1', [id]);
  return rows[0]!;
}

async function auditStop(campaignId: string, at: Date) {
  await getTestPool().query(
    `INSERT INTO platform_audit_log (id, tenant_id, account_id, user_id, actor_type, action, resource_type, resource_id, campaign_id, details, created_at)
     VALUES ($1, $2, $3, $4, 'user', 'agency_campaign.stopped', 'agency_campaign', $5, $5, '{}', $6)`,
    [randomUUID(), T, A, STOPPER, campaignId, at]);
}

const stop = (id: string, from: readonly string[] = ['running', 'paused']) =>
  agencyCampaignRepository.transitionStatus(id, from, 'stopping', { last_transition_by: { user_id: STOPPER, name: 'Ravi' } });

beforeAll(async () => {
  await truncateAll();
  paused = await insertAgencyCampaign({ status: 'running' }) as { id: string };
  auto = await insertAgencyCampaign({ status: 'running' }) as { id: string };
  stopping = await insertAgencyCampaign({ status: 'running' }) as { id: string };
  stoppingBefore0051 = await insertAgencyCampaign({ status: 'running' }) as { id: string };
  await agencyCampaignRepository.transitionStatus(paused.id, ['running'], 'paused', { last_transition_by: { user_id: SUPERVISOR, name: 'Anitha' } });
  await agencyCampaignRepository.pauseForAbandonment(auto.id, 4.2);
  await stop(stopping.id);
  // An audit row for the stop at another instant: the board does not read it.
  await auditStop(stopping.id, new Date(Date.now() - 3_600_000));
  // A campaign that entered `stopping` before 0051 has no stamp: the board serves no time for it.
  await stop(stoppingBefore0051.id);
  await getTestPool().query('UPDATE agency_campaigns SET stopping_at = NULL WHERE id = $1', [stoppingBefore0051.id]);
});

afterAll(closeTestPool);

describe('stopping_at, stamped by transitionStatus', () => {
  it('is the statement\'s own instant on entering stopping (the same as updated_at), and null before it', async () => {
    // Another account's, so the board below lists only its own four.
    const fresh = await insertAgencyCampaign({ status: 'running', account_id: randomUUID() }) as { id: string };
    expect((await stamps(fresh.id)).stopping_at).toBeNull();
    await agencyCampaignRepository.transitionStatus(fresh.id, ['running'], 'paused');
    expect((await stamps(fresh.id)).stopping_at).toBeNull();
    await stop(fresh.id);
    const row = await stamps(fresh.id);
    expect(row.status).toBe('stopping');
    expect(row.stopping_at!.toISOString()).toBe(row.updated_at.toISOString());
  });

  it('a second Stop, were one accepted, does not move it; stopping → stopped keeps it', async () => {
    const id = (await insertAgencyCampaign({ status: 'running', account_id: randomUUID() }) as { id: string }).id;
    await stop(id);
    const first = (await stamps(id)).stopping_at!;
    await new Promise((r) => setTimeout(r, 20));
    expect(await stop(id, ['running', 'paused', 'stopping'])).not.toBeNull();
    const again = await stamps(id);
    expect(again.updated_at.getTime()).toBeGreaterThan(first.getTime());
    expect(again.stopping_at!.toISOString()).toBe(first.toISOString());
    await agencyCampaignRepository.transitionStatus(id, ['stopping'], 'stopped');
    expect((await stamps(id)).stopping_at!.toISOString()).toBe(first.toISOString());
  });
});

describe('the board\'s status_changed', () => {
  it('names the supervisor of a pause and when, marks the guardrail\'s pause automatic, and times a stop by its row', async () => {
    resetHomeBoardMemosForTests();
    const rows = await getTestPool().query<{ id: string; paused_at: Date | null; stopping_at: Date | null }>(
      'SELECT id, paused_at, stopping_at FROM agency_campaigns WHERE status IN ($1, $2)', ['paused', 'stopping']);
    const at = new Map(rows.rows.map((r) => [r.id, (r.paused_at ?? r.stopping_at)?.toISOString() ?? null]));
    const board = await computeHomeBoard({ tenantId: T, accountId: A }, deps);
    const changed = Object.fromEntries(board.campaigns.map((c) => [c.id, c.status_changed]));
    expect(at.get(stopping.id)).toEqual(expect.any(String));
    expect(changed).toEqual({
      [paused.id]: { at: at.get(paused.id), by_user_id: SUPERVISOR, by_name: 'Anitha', automatic: false },
      [auto.id]: { at: at.get(auto.id), by_user_id: null, by_name: null, automatic: true },
      [stopping.id]: { at: at.get(stopping.id), by_user_id: STOPPER, by_name: 'Ravi', automatic: false },
      [stoppingBefore0051.id]: { at: null, by_user_id: STOPPER, by_name: 'Ravi', automatic: false },
    });
  });

  it('the reload straight after Stop, inside the board\'s memo, serves the stop and its time with no audit row', async () => {
    resetHomeBoardMemosForTests();
    const scope = { tenantId: T, accountId: OTHER_ACCOUNT };
    const id = (await insertAgencyCampaign({ status: 'running', account_id: OTHER_ACCOUNT }) as { id: string }).id;
    const before = await computeHomeBoard(scope, deps);
    expect(before.campaigns.map((c) => [c.id, c.status, c.status_changed])).toEqual([[id, 'running', null]]);
    await stop(id);
    // No clock moved, no memo reset: the transition's `updated_at` is in the memo's key.
    const after = await computeHomeBoard(scope, deps);
    const { stopping_at: stoppedAt } = await stamps(id);
    expect(after.campaigns.map((c) => [c.id, c.status, c.status_changed])).toEqual([
      [id, 'stopping', { at: stoppedAt!.toISOString(), by_user_id: STOPPER, by_name: 'Ravi', automatic: false }],
    ]);
    const { rows } = await getTestPool().query('SELECT 1 FROM platform_audit_log WHERE campaign_id = $1', [id]);
    expect(rows).toHaveLength(0);
  });
});
