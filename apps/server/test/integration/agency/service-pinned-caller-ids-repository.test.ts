import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { agencyServicePinnedCallerIdRepository as repo } from '../../../src/db/repositories/agency.repository.js';
import { getPacingInvalidationBus } from '../../../src/agency/pacing/invalidation-bus.js';
import {
  ACCOUNT, OTHER_TENANT, PIN_OTHER, PIN_OWN, SVC1, SVC2, TENANT, callerIdsById, seedPinnedWorld, type PinnedWorld,
} from './pinned-caller-id-world.js';

/**
 * The CR9 clean-up's repository, on real Postgres: the read of service-account campaigns that are
 * not finished and hold a caller ID pinned to a credential, and the locked removal of those IDs
 * from one campaign (re-checked under `FOR UPDATE`; refused when it would leave the campaign
 * empty unless allowed, never for a running one; the record written in the same transaction).
 */

let world: PinnedWorld;

beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 }); });
beforeEach(async () => {
  await truncateAll();
  world = await seedPinnedWorld();
});
afterAll(async () => {
  await closePool();
  await closeTestPool();
});

const noRecord = async () => { /* no audit in these tests */ };

describe('findServiceCampaignsHoldingPinned', () => {
  it('lists only unfinished service-account campaigns that hold a pinned number, with each credential and what would remain', async () => {
    const found = await repo.findServiceCampaignsHoldingPinned();
    const c = world.campaigns;
    expect(found.map((f) => f.campaign_id)).toEqual([
      c.draftMixed, c.runningMixed, c.stoppingMixed, c.pausedAllPinned, c.runningAllPinned,
    ]);
    const [draft, running, , paused, runningAll] = found;
    expect(draft).toMatchObject({
      campaign_name: 'A draft mixed', status: 'draft', tenant_id: TENANT, tenant_name: 'Acme Collections',
      account_id: ACCOUNT, account_name: 'Mumbai', caller_ids: [SVC1, PIN_OWN, SVC2], remaining: [SVC1, SVC2],
      pinned: [{ phone_number: PIN_OWN, telephony_credential_id: world.ownCredential, credential_label: 'Own VoiceLink', credential_tenant_id: TENANT }],
    });
    expect(running!.pinned).toEqual([
      { phone_number: PIN_OTHER, telephony_credential_id: world.otherCredential, credential_label: 'Their VoiceLink', credential_tenant_id: OTHER_TENANT },
    ]);
    expect(running!.remaining).toEqual([SVC1]);
    expect(paused!.remaining).toEqual([]);
    expect(runningAll!.pinned.map((p) => p.phone_number)).toEqual([PIN_OWN, PIN_OTHER]);
  });

  it('is empty once nothing is pinned', async () => {
    await getTestPool().query('UPDATE phone_numbers SET telephony_credential_id = NULL');
    expect(await repo.findServiceCampaignsHoldingPinned()).toEqual([]);
  });
});

describe('removePinnedCallerIds', () => {
  it('removes only the pinned IDs, keeps the order, records inside the transaction and announces the change', async () => {
    const heard: unknown[] = [];
    const unsubscribe = getPacingInvalidationBus().subscribe((e) => heard.push(e));
    const record = vi.fn(async (_r: unknown, client: { query: (sql: string, v?: unknown[]) => Promise<{ rows: Array<{ caller_ids: string[] }> }> }) => {
      // Inside the transaction: this client sees the write, the row is locked.
      const { rows } = await client.query('SELECT caller_ids FROM agency_campaigns WHERE id = $1', [world.campaigns.draftMixed]);
      expect(rows[0]!.caller_ids).toEqual([SVC1, SVC2]);
    });
    const result = await repo.removePinnedCallerIds(world.campaigns.draftMixed, { allowEmpty: false, record });
    unsubscribe();
    expect(result).toMatchObject({ outcome: 'removed', before: [SVC1, PIN_OWN, SVC2], after: [SVC1, SVC2] });
    expect(result.outcome === 'removed' && result.removed.map((p) => p.phone_number)).toEqual([PIN_OWN]);
    expect(record).toHaveBeenCalledTimes(1);
    const after = await callerIdsById();
    expect(after.get(world.campaigns.draftMixed)).toEqual([SVC1, SVC2]);
    // Nothing else moved.
    expect(after.get(world.campaigns.runningMixed)).toEqual([PIN_OTHER, SVC1]);
    expect(heard).toEqual([{ type: 'campaign_changed', campaignId: world.campaigns.draftMixed }]);
  });

  it('a record that throws rolls the removal back', async () => {
    await expect(repo.removePinnedCallerIds(world.campaigns.draftMixed, {
      allowEmpty: false, record: async () => { throw new Error('audit insert failed'); },
    })).rejects.toThrow('audit insert failed');
    expect((await callerIdsById()).get(world.campaigns.draftMixed)).toEqual([SVC1, PIN_OWN, SVC2]);
  });

  it('would leave a campaign empty: refused unless allowed, and never for a running one', async () => {
    const c = world.campaigns;
    expect(await repo.removePinnedCallerIds(c.pausedAllPinned, { allowEmpty: false, record: noRecord }))
      .toMatchObject({ outcome: 'would_empty' });
    expect(await repo.removePinnedCallerIds(c.runningAllPinned, { allowEmpty: true, record: noRecord }))
      .toMatchObject({ outcome: 'would_empty' });
    let ids = await callerIdsById();
    expect(ids.get(c.pausedAllPinned)).toEqual([PIN_OWN]);
    expect(ids.get(c.runningAllPinned)).toEqual([PIN_OWN, PIN_OTHER]);
    expect(await repo.removePinnedCallerIds(c.pausedAllPinned, { allowEmpty: true, record: noRecord }))
      .toMatchObject({ outcome: 'removed', after: [] });
    ids = await callerIdsById();
    expect(ids.get(c.pausedAllPinned)).toEqual([]);
  });

  it('touches nothing finished, on a credential, already clean, or gone', async () => {
    const c = world.campaigns;
    const before = await callerIdsById();
    const record = vi.fn(noRecord);
    for (const [id, reason] of [
      [c.completed, 'finished'], [c.stopped, 'finished'], [c.onCredential, 'on_credential'],
      [c.clean, 'nothing_pinned'], ['3f5d0c1e-0000-4000-8000-000000000000', 'not_found'],
    ] as const) {
      expect(await repo.removePinnedCallerIds(id, { allowEmpty: true, record })).toEqual({ outcome: 'unchanged', reason });
    }
    expect(record).not.toHaveBeenCalled();
    expect(await callerIdsById()).toEqual(before);
  });

  it('re-checks under the lock: a campaign edited while the removal waited for its row is judged as edited', async () => {
    const editor = await getTestPool().connect();
    try {
      await editor.query('BEGIN');
      await editor.query('SELECT 1 FROM agency_campaigns WHERE id = $1 FOR UPDATE', [world.campaigns.runningMixed]);
      const removal = repo.removePinnedCallerIds(world.campaigns.runningMixed, { allowEmpty: false, record: noRecord });
      // The removal waits on the row lock …
      await vi.waitFor(async () => {
        const { rows } = await getTestPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM agency_campaigns WHERE id = $1::uuid FOR UPDATE%'`);
        expect(rows[0]!.n).toBe(1);
      });
      // … while a supervisor's edit drops the pinned number itself and commits.
      await editor.query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [world.campaigns.runningMixed, [SVC1]]);
      await editor.query('COMMIT');
      expect(await removal).toEqual({ outcome: 'unchanged', reason: 'nothing_pinned' });
    } finally {
      editor.release();
    }
    expect((await callerIdsById()).get(world.campaigns.runningMixed)).toEqual([SVC1]);
  });
});
