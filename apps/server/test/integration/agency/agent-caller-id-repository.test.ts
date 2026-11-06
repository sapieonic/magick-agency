import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertTenant, insertUser } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { agencyAgentCallerIdRepository: repo, agencyAssignmentRepository, agencyCampaignRepository } =
  await import('../../../src/db/repositories/agency.repository.js');
const { writeCampaignPatch } = await import('../../../src/api/routes/agency-campaigns/crud.js');

/**
 * The dedicated caller ID repository on real Postgres (DN1, DN5, DN6, DN7): set (new, replace,
 * the same number again), the number held by another agent refused as `taken` (by the read, and
 * by the unique index when two sets race), the staffing and the campaign's caller IDs checked
 * inside the write's transaction, the dial paths' map, release, and the unstaff release riding
 * CA6's statement whatever `on_unstaff` says.
 *
 * The effective dedication (`EFFECTIVE_DEDICATION_SQL`): a row whose agent is no longer staffed,
 * or was staffed again after it was set, counts nowhere and never blocks a new PUT. The races:
 * a PUT against an unstaff, against a campaign PATCH dropping the number, and two first-time
 * PUTs for one agent (the audit's `previous_caller_id`), each ordered deterministically by
 * holding a lock from a test client and waiting until the racers queue behind it.
 *
 * Mutation-checked: dropping the staffing join from `EFFECTIVE_DEDICATION_SQL` reds the stale
 * row cases; dropping its `set_at >= assigned_at` clause reds the re-staff case; reading the
 * campaign without `FOR SHARE` reds the PATCH races; dropping the staffing row's `FOR SHARE`
 * reds the unstaff race; dropping the advisory lock reds the `previous_caller_id` race.
 */

const X = '+918041000001';
const Y = '+918041000002';

let campaign: { id: string; tenant_id: string; account_id: string; caller_ids: string[] };
let a: string;
let b: string;
let supervisor: string;

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: DEFAULTS.tenantId });
  a = (await insertUser()).id as string;
  b = (await insertUser()).id as string;
  supervisor = (await insertUser()).id as string;
  campaign = await insertAgencyCampaign({ caller_ids: [X, Y] }) as typeof campaign;
  await staff(a);
  await staff(b);
});
afterAll(closeTestPool);

const set = (userId: string, callerId: string, campaignId = campaign.id) => repo.set({
  tenantId: campaign.tenant_id, accountId: campaign.account_id, campaignId, userId, callerId, setByUserId: supervisor,
});

/** An active staffing row (no account: a tenant-level staffing). */
async function staff(userId: string, campaignId = campaign.id): Promise<void> {
  await getTestPool().query(
    'INSERT INTO agency_campaign_agents (tenant_id, campaign_id, user_id) VALUES ($1, $2, $3)',
    [campaign.tenant_id, campaignId, userId]);
}

/** Close the staffing row WITHOUT the release, as an unstaff whose release failed or raced. */
const closeStaffing = (userId: string, campaignId = campaign.id) => getTestPool().query(
  'UPDATE agency_campaign_agents SET unassigned_at = now() WHERE campaign_id = $1 AND user_id = $2 AND unassigned_at IS NULL',
  [campaignId, userId]);

const release = (userId: string, campaignIds = [campaign.id]) => agencyAssignmentRepository.returnOnUnstaff({
  tenantId: campaign.tenant_id, userId, campaignIds, actorUserId: null,
});

async function storedRows(campaignId = campaign.id): Promise<Array<[string, string]>> {
  const { rows } = await getTestPool().query<{ user_id: string; caller_id: string }>(
    'SELECT user_id::text AS user_id, caller_id FROM agency_campaign_agent_caller_ids WHERE campaign_id = $1 ORDER BY caller_id',
    [campaignId]);
  return rows.map((r) => [r.user_id, r.caller_id]);
}

/** Until `n` backends of this database wait on a lock (row or advisory). */
async function waitForLockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const { rows } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`);
    if (rows[0]!.n >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`fewer than ${n} backends ever waited on a lock`);
}

describe('set', () => {
  it('a new number, a replacement (previous named), and the same number again (nothing written)', async () => {
    const first = await set(a, X);
    expect(first).toMatchObject({ ok: true, changed: true, previous_caller_id: null, caller_ids: [X, Y], row: { user_id: a, caller_id: X, set_by_user_id: supervisor } });
    const second = await set(a, Y);
    expect(second).toMatchObject({ ok: true, changed: true, previous_caller_id: X, row: { caller_id: Y } });
    const again = await set(a, Y);
    expect(again).toMatchObject({ ok: true, changed: false, previous_caller_id: Y });
    if (second.ok && again.ok) expect(again.row.set_at).toEqual(second.row.set_at);
    expect(await repo.mapForCampaign(campaign.id)).toEqual(new Map([[a, Y]]));
  });

  it('a number held by another agent is taken, naming the holder; nothing changes', async () => {
    await set(a, X);
    await set(b, Y);
    expect(await set(b, X)).toEqual({ ok: false, reason: 'taken', holder_user_id: a });
    expect(await repo.mapForCampaign(campaign.id)).toEqual(new Map([[a, X], [b, Y]]));
  });

  it('two sets of one number racing: exactly one wins, the other is taken (the unique index, never a throw)', async () => {
    for (let round = 0; round < 10; round++) {
      await getTestPool().query('DELETE FROM agency_campaign_agent_caller_ids');
      const outcomes = await Promise.all([set(a, X), set(b, X)]);
      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      const lost = outcomes.find((o) => !o.ok);
      const won = outcomes.find((o) => o.ok);
      expect(lost).toEqual({ ok: false, reason: 'taken', holder_user_id: won!.ok ? won!.row.user_id : null });
    }
  });

  it('the same number on another campaign is free', async () => {
    const other = await insertAgencyCampaign({ caller_ids: [X] }) as { id: string };
    await staff(b, other.id);
    await set(a, X);
    expect(await set(b, X, other.id)).toMatchObject({ ok: true });
  });

  it('refuses inside the transaction: an agent with no active staffing row, a number not among the campaign\'s', async () => {
    const stranger = (await insertUser()).id as string;
    expect(await set(stranger, X)).toEqual({ ok: false, reason: 'not_staffed' });
    await closeStaffing(b);
    expect(await set(b, X)).toEqual({ ok: false, reason: 'not_staffed' });
    expect(await set(a, '+919999999999')).toEqual({ ok: false, reason: 'not_in_campaign', caller_ids: [X, Y] });
    await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [campaign.id, [` ${X} `, '']]);
    expect(await set(a, Y)).toEqual({ ok: false, reason: 'not_in_campaign', caller_ids: [X] });
    expect(await storedRows()).toEqual([]);
  });
});

describe('clear and reads', () => {
  it('clear returns the number released, then null; findForAgent and listForCampaign', async () => {
    await set(a, X);
    expect(await repo.findForAgent(campaign.id, a)).toBe(X);
    expect((await repo.listForCampaign(campaign.tenant_id, campaign.id)).map((r) => [r.user_id, r.caller_id])).toEqual([[a, X]]);
    expect(await repo.listForCampaign('44444444-4444-4444-8444-444444444444', campaign.id)).toEqual([]);
    expect(await repo.clear(campaign.id, a)).toBe(X);
    expect(await repo.clear(campaign.id, a)).toBeNull();
    expect(await repo.findForAgent(campaign.id, a)).toBeNull();
    expect(await repo.mapForCampaign(campaign.id)).toEqual(new Map());
  });
});

describe('the effective dedication: a row left behind by an unstaff counts nowhere', () => {
  it('ignored by the dial map, the list, the agent\'s summary read, the holder read and the PATCH guard', async () => {
    await set(a, X);
    await set(b, Y);
    await closeStaffing(a);
    expect(await storedRows()).toEqual([[a, X], [b, Y]]);

    expect(await repo.mapForCampaign(campaign.id)).toEqual(new Map([[b, Y]]));
    expect((await repo.listForCampaign(campaign.tenant_id, campaign.id)).map((r) => r.user_id)).toEqual([b]);
    expect(await repo.findForAgent(campaign.id, a)).toBeNull();
    expect(await repo.holderOf(campaign.id, X)).toBeNull();
    // The PATCH may drop X (its holder is gone), not Y.
    const record = await agencyCampaignRepository.findById(campaign.id);
    expect(await writeCampaignPatch(record!, { caller_ids: [X] })).toEqual({ refused: [Y] });
    const dropped = await writeCampaignPatch(record!, { caller_ids: [Y] });
    expect('row' in dropped && dropped.row?.caller_ids).toEqual([Y]);
    // A stale row is not reported as released (nothing was ever dialled from it).
    expect(await repo.clear(campaign.id, a)).toBeNull();
    expect(await storedRows()).toEqual([[b, Y]]);
  });

  it('an agent staffed again does not get the old row back', async () => {
    await set(a, X);
    await closeStaffing(a);
    await new Promise((r) => setTimeout(r, 5));
    await staff(a);
    expect(await repo.mapForCampaign(campaign.id)).toEqual(new Map());
    expect(await repo.findForAgent(campaign.id, a)).toBeNull();
    expect(await repo.listForCampaign(campaign.tenant_id, campaign.id)).toEqual([]);
    // A PUT on the new staffing replaces it, with nothing previous to name.
    expect(await set(a, Y)).toMatchObject({ ok: true, changed: true, previous_caller_id: null, row: { caller_id: Y } });
    expect(await repo.mapForCampaign(campaign.id)).toEqual(new Map([[a, Y]]));
  });

  it('a PUT for a number a stale row holds succeeds, and so does re-setting the stale agent\'s own number', async () => {
    await set(a, X);
    await closeStaffing(a);
    expect(await set(b, X)).toMatchObject({ ok: true, changed: true, previous_caller_id: null });
    expect(await storedRows()).toEqual([[b, X]]);

    // The stale row is the agent's own, same number: written afresh, not "unchanged".
    await closeStaffing(b);
    await new Promise((r) => setTimeout(r, 5));
    await staff(b);
    expect(await set(b, X)).toMatchObject({ ok: true, changed: true, previous_caller_id: null });
    expect(await repo.mapForCampaign(campaign.id)).toEqual(new Map([[b, X]]));
  });
});

describe('races, ordered by a lock the test holds', () => {
  it('a PUT holding the staffing row: the unstaff waits for it, then the release sees the row; never an effective dedication', async () => {
    await set(a, X);
    const blocker = await getTestPool().connect();
    try {
      // Hold a's row so the PUT stops after its staffing lock, at its own `FOR UPDATE`.
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM agency_campaign_agent_caller_ids WHERE user_id = $1 FOR UPDATE', [a]);
      const put = set(a, Y);
      await waitForLockWaiters(1);
      const closing = closeStaffing(a);
      // The close queues behind the PUT's FOR SHARE on the staffing row.
      await waitForLockWaiters(2);
      await blocker.query('COMMIT');
      expect(await put).toMatchObject({ ok: true, row: { caller_id: Y } });
      await closing;
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    // Closed and not yet released: already not effective.
    expect(await repo.mapForCampaign(campaign.id)).toEqual(new Map());
    // The release, after the close, sees the PUT's row.
    expect((await release(a)).map((r) => r.released_caller_id)).toEqual([Y]);
    expect(await storedRows()).toEqual([]);
  });

  it('an unstaff holding the staffing row: the PUT waits, then refuses agent_not_staffed', async () => {
    const closer = await getTestPool().connect();
    try {
      await closer.query('BEGIN');
      await closer.query(
        'UPDATE agency_campaign_agents SET unassigned_at = now() WHERE campaign_id = $1 AND user_id = $2', [campaign.id, a]);
      const put = set(a, X);
      await waitForLockWaiters(1);
      await closer.query('COMMIT');
      expect(await put).toEqual({ ok: false, reason: 'not_staffed' });
    } finally {
      await closer.query('ROLLBACK').catch(() => undefined);
      closer.release();
    }
    expect(await storedRows()).toEqual([]);
  });

  it('PUTs racing unstaffs in either order never leave an effective dedication', async () => {
    for (let round = 0; round < 10; round++) {
      await getTestPool().query('DELETE FROM agency_campaign_agent_caller_ids');
      await getTestPool().query('DELETE FROM agency_campaign_agents WHERE user_id = $1', [a]);
      await staff(a);
      await Promise.all([set(a, round % 2 ? X : Y), (async () => { await closeStaffing(a); await release(a); })()]);
      expect(await repo.mapForCampaign(campaign.id), `round ${round}`).toEqual(new Map());
    }
  });

  it('a campaign PATCH dropping the number, holding the row: the PUT waits, then refuses caller_id_not_in_campaign', async () => {
    const patcher = await getTestPool().connect();
    try {
      await patcher.query('BEGIN');
      await patcher.query('SELECT 1 FROM agency_campaigns WHERE id = $1 FOR UPDATE', [campaign.id]);
      await patcher.query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [campaign.id, [X]]);
      const put = set(a, Y);
      await waitForLockWaiters(1);
      await patcher.query('COMMIT');
      expect(await put).toEqual({ ok: false, reason: 'not_in_campaign', caller_ids: [X] });
    } finally {
      await patcher.query('ROLLBACK').catch(() => undefined);
      patcher.release();
    }
    expect(await storedRows()).toEqual([]);
  });

  it('a PUT holding the campaign row: the PATCH waits, then sees the new dedication and refuses to drop it', async () => {
    await set(a, X);
    const blocker = await getTestPool().connect();
    let patched: Awaited<ReturnType<typeof writeCampaignPatch>>;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM agency_campaign_agent_caller_ids WHERE user_id = $1 FOR UPDATE', [a]);
      // a: X → Y, stopped after its campaign FOR SHARE and staffing lock.
      const put = set(a, Y);
      await waitForLockWaiters(1);
      const record = await agencyCampaignRepository.findById(campaign.id);
      const patch = writeCampaignPatch(record!, { caller_ids: [X] });
      await waitForLockWaiters(2);
      await blocker.query('COMMIT');
      expect(await put).toMatchObject({ ok: true, row: { caller_id: Y } });
      patched = await patch;
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    expect(patched).toEqual({ refused: [Y] });
    expect((await agencyCampaignRepository.findById(campaign.id))!.caller_ids).toEqual([X, Y]);
  });

  it('two first-time PUTs for one agent serialise: the second names the first\'s number as previous', async () => {
    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT pg_advisory_xact_lock(hashtext('agency_campaign_agent_caller_ids'), hashtext($1::text || ':' || $2::text))`,
        [campaign.id, a]);
      const both = Promise.all([set(a, X), set(a, Y)]);
      // Both queue on the agent's lock, neither having read "previous" yet.
      await waitForLockWaiters(2);
      await holder.query('COMMIT');
      const outcomes = await both;
      const first = outcomes.find((o) => o.ok && o.previous_caller_id === null);
      const second = outcomes.find((o) => o !== first);
      expect(first, JSON.stringify(outcomes)).toBeDefined();
      expect(second).toMatchObject({ ok: true, changed: true, previous_caller_id: first!.ok ? first!.row.caller_id : 'unreachable' });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});

describe('the unstaff release (DN7) in CA6\'s statement', () => {
  it('releases on return_to_pool and keep alike; a row per campaign with a release or held contacts, and only those', async () => {
    const keep = await insertAgencyCampaign({ caller_ids: [X, Y], on_unstaff: 'keep' }) as { id: string };
    const untouched = await insertAgencyCampaign({ caller_ids: [X] }) as { id: string };
    await staff(a, keep.id);
    await staff(b, keep.id);
    await set(a, X);
    await set(a, Y, keep.id);
    await set(b, X, keep.id);
    // Agent a holds an open contact on `keep`, nothing on `campaign`.
    await insertAgencyContact(keep.id, { assigned_user_id: a, assigned_at: new Date(), state: 'pending' });

    const rows = await release(a, [campaign.id, keep.id, untouched.id]);
    expect(rows.map((r) => ({ c: r.campaign_id, held: r.held, released: r.released_caller_id, kept: r.kept, moved: r.moved }))
      .sort((p, q) => p.c.localeCompare(q.c)))
      .toEqual([
        { c: campaign.id, held: false, released: X, kept: 0, moved: 0 },
        { c: keep.id, held: true, released: Y, kept: 1, moved: 0 },
      ].sort((p, q) => p.c.localeCompare(q.c)));
    expect(await repo.mapForCampaign(campaign.id)).toEqual(new Map());
    // Only the unstaffed agent's number goes.
    expect(await repo.mapForCampaign(keep.id)).toEqual(new Map([[b, X]]));
  });
});
