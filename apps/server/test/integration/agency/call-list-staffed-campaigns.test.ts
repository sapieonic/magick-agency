import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign } from './agency-factories.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, insertAccount, insertTenant, insertUser } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyCallListRepository } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * `AgencyCallListRepository.staffedCampaigns` on real Postgres: the campaigns My calls reads
 * an agent's callbacks due on (`myCallbacksDue`, `docs/call-log.md` §7). One statement in place
 * of the tenant-wide staffing list and a campaign read each, so everything the route used to
 * filter after the reads is the statement's to get right: the user, an ACTIVE staffing row, the
 * tenant, the ACCOUNT (the campaign's own, never the staffing row's attribution) and the archive.
 */

const CATALOG = [{ code: 'call_back', label: 'Call back', requires_datetime: true }];
const DISPLAY = { name_fields: ['customer'] };

let me: string;
let colleague: string;

type Campaign = { id: string; tenant_id: string; account_id: string };

async function campaign(overrides: Record<string, unknown> = {}): Promise<Campaign> {
  return await insertAgencyCampaign(overrides) as Campaign;
}

/** Staff `userId` on the campaign at `minutesAgo`; `active: false` closes the row. */
async function staff(c: Campaign, userId: string, minutesAgo: number, active = true): Promise<void> {
  await getTestPool().query(
    `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id, assigned_at, unassigned_at)
     VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5), $6)`,
    [c.tenant_id, c.account_id, c.id, userId, minutesAgo, active ? null : new Date()]);
}

const read = (accountId: string = DEFAULTS.accountId, userId: string = me, tenantId: string = DEFAULTS.tenantId) =>
  agencyCallListRepository.staffedCampaigns(tenantId, accountId, userId);

describe('AgencyCallListRepository.staffedCampaigns', () => {
  afterAll(async () => { await closeTestPool(); });

  beforeEach(async () => {
    await truncateAll();
    await insertTenant({ id: DEFAULTS.tenantId });
    await insertAccount({ id: DEFAULTS.accountId, tenant_id: DEFAULTS.tenantId });
    await insertAccount({ id: OTHER_ACCOUNT, tenant_id: DEFAULTS.tenantId });
    await insertTenant({ id: OTHER_TENANT });
    me = (await insertUser() as { id: string }).id;
    colleague = (await insertUser() as { id: string }).id;
  });

  it('the campaigns the user is on, oldest staffing first, with the columns the callbacks are read by', async () => {
    const newer = await campaign({ name: 'Newer staffing' });
    const older = await campaign({
      name: 'Older staffing', default_timezone: 'Asia/Kolkata', assignment_mode: 'strict', callback_fallback: 'wait',
      context_display: JSON.stringify(DISPLAY), disposition_catalog: JSON.stringify(CATALOG),
    });
    await staff(newer, me, 5);
    await staff(older, me, 50);

    const rows = await read();
    expect(rows.map((r) => r.id)).toEqual([older.id, newer.id]);
    expect(rows[0]).toEqual({
      id: older.id, name: 'Older staffing', default_timezone: 'Asia/Kolkata', assignment_mode: 'strict',
      callback_fallback: 'wait', context_display: DISPLAY, disposition_catalog: CATALOG,
    });
  });

  it('leaves out an archived campaign, another account\'s, a closed staffing row and a colleague\'s', async () => {
    const mine = await campaign({ name: 'Mine' });
    const archived = await campaign({ name: 'Archived', archived_at: new Date() });
    const elsewhere = await campaign({ name: 'Another account', account_id: OTHER_ACCOUNT });
    const left = await campaign({ name: 'Taken off' });
    const theirs = await campaign({ name: 'A colleague\'s' });
    await staff(mine, me, 40);
    await staff(archived, me, 30);
    // The staffing row's own `account_id` is attribution (here: this account's), never the rule.
    await staff({ ...elsewhere, account_id: DEFAULTS.accountId }, me, 20);
    await staff(left, me, 10, false);
    await staff(theirs, colleague, 10);

    expect((await read()).map((r) => r.name)).toEqual(['Mine']);
    expect((await read(OTHER_ACCOUNT)).map((r) => r.name)).toEqual(['Another account']);
    expect((await read(DEFAULTS.accountId, colleague)).map((r) => r.name)).toEqual(['A colleague\'s']);
    expect(await read(DEFAULTS.accountId, randomUUID())).toEqual([]);
  });

  it('never crosses the tenant: a staffing row or a campaign of another tenant is not read', async () => {
    const mine = await campaign({ name: 'Mine' });
    await staff(mine, me, 10);
    expect(await read(DEFAULTS.accountId, me, OTHER_TENANT)).toEqual([]);
    // A staffing row written under another tenant for this tenant's campaign answers neither tenant.
    await getTestPool().query('UPDATE agency_campaign_agents SET tenant_id = $1 WHERE campaign_id = $2', [OTHER_TENANT, mine.id]);
    expect(await read()).toEqual([]);
    expect(await read(DEFAULTS.accountId, me, OTHER_TENANT)).toEqual([]);
  });
});
