import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_TENANT } from '../setup/factories.js';
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
 * `paused_at`, `pause_reason` and `last_transition_by_*`), and a stop's time from its
 * `agency_campaign.stopped` audit row (`stopAuditedAt`: the latest for the campaign in its tenant,
 * never another action's or another tenant's row). Names here are the recorded ones (the lookup
 * answers none), so what is asserted is what the rows hold.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const SUPERVISOR = randomUUID();
const STOPPER = randomUUID();

let paused: { id: string };
let auto: { id: string };
let stopping: { id: string };
let stoppingUnaudited: { id: string };
const STOPPED_AT = new Date(Date.now() - 120_000);

async function audit(tenantId: string, campaignId: string, action: string, at: Date) {
  await getTestPool().query(
    `INSERT INTO platform_audit_log (id, tenant_id, account_id, user_id, actor_type, action, resource_type, resource_id, campaign_id, details, created_at)
     VALUES ($1, $2, $3, $4, 'user', $5, 'agency_campaign', $6, $6, '{}', $7)`,
    [randomUUID(), tenantId, A, STOPPER, action, campaignId, at]);
}

beforeAll(async () => {
  await truncateAll();
  paused = await insertAgencyCampaign({ status: 'running' }) as { id: string };
  auto = await insertAgencyCampaign({ status: 'running' }) as { id: string };
  stopping = await insertAgencyCampaign({ status: 'running' }) as { id: string };
  stoppingUnaudited = await insertAgencyCampaign({ status: 'running' }) as { id: string };
  await agencyCampaignRepository.transitionStatus(paused.id, ['running'], 'paused', { last_transition_by: { user_id: SUPERVISOR, name: 'Anitha' } });
  await agencyCampaignRepository.pauseForAbandonment(auto.id, 4.2);
  await agencyCampaignRepository.transitionStatus(stopping.id, ['running'], 'stopping', { last_transition_by: { user_id: STOPPER, name: 'Ravi' } });
  await agencyCampaignRepository.transitionStatus(stoppingUnaudited.id, ['running'], 'stopping', { last_transition_by: { user_id: STOPPER, name: 'Ravi' } });
  // The Stop's audit row; an older row of another action, and another tenant's row for the same id.
  await audit(T, stopping.id, 'agency_campaign.stopped', STOPPED_AT);
  await audit(T, stopping.id, 'agency_campaign.started', new Date(STOPPED_AT.getTime() + 60_000));
  await audit(OTHER_TENANT, stoppingUnaudited.id, 'agency_campaign.stopped', STOPPED_AT);
});

afterAll(closeTestPool);

describe('stopAuditedAt', () => {
  it('reads the Stop\'s audit row per campaign in the tenant; a campaign without one is absent', async () => {
    const at = await agencyCampaignRepository.stopAuditedAt(T, [stopping.id, stoppingUnaudited.id]);
    expect([...at.keys()]).toEqual([stopping.id]);
    expect(at.get(stopping.id)!.toISOString()).toBe(STOPPED_AT.toISOString());
    expect(await agencyCampaignRepository.stopAuditedAt(T, [])).toEqual(new Map());
  });
});

describe('the board\'s status_changed', () => {
  it('names the supervisor of a pause and when, marks the guardrail\'s pause automatic, and times a stop by its audit', async () => {
    resetHomeBoardMemosForTests();
    const rows = await getTestPool().query<{ id: string; paused_at: Date }>('SELECT id, paused_at FROM agency_campaigns WHERE status = $1', ['paused']);
    const pausedAt = new Map(rows.rows.map((r) => [r.id, r.paused_at.toISOString()]));
    const board = await computeHomeBoard({ tenantId: T, accountId: A }, {
      liveStats: async () => null,
      insights: null,
      names: async () => new Map(),
    });
    const changed = Object.fromEntries(board.campaigns.map((c) => [c.id, c.status_changed]));
    expect(changed).toEqual({
      [paused.id]: { at: pausedAt.get(paused.id), by_user_id: SUPERVISOR, by_name: 'Anitha', automatic: false },
      [auto.id]: { at: pausedAt.get(auto.id), by_user_id: null, by_name: null, automatic: true },
      [stopping.id]: { at: STOPPED_AT.toISOString(), by_user_id: STOPPER, by_name: 'Ravi', automatic: false },
      [stoppingUnaudited.id]: { at: null, by_user_id: STOPPER, by_name: 'Ravi', automatic: false },
    });
  });
});
