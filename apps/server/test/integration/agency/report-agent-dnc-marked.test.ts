import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant } from '../setup/factories.js';
import { insertAccount } from '../../../../../packages/db/test/integration/setup/factories.js';
import { insertAgencyCampaign } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyReportDatasetRepository: repo } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * The agent report's `dnc_marked` (`agentDncMarked`, docs/reports.md) on real Postgres, with an
 * agent who works in two accounts of one tenant. A campaign entry is stored `account_id NULL`
 * (as the station and a suppress outcome write it), so "this account or tenant-wide" read as
 * `account_id IS NULL` took the other account's campaign marks too. It now counts the Do Not
 * Call list's own idea of this account's entries (DS6): its account rows, its campaigns' rows,
 * plus the agent's tenant-wide marks.
 *
 * Mutation-checked: putting back `OR d.account_id IS NULL` reds all three cases (the first counts 5, not 4).
 */

const pool = () => getTestPool();
const FROM = new Date('2026-11-01T00:00:00Z');
const TO = new Date('2026-11-08T00:00:00Z');
const IN_WINDOW = new Date('2026-11-03T10:00:00Z');

let tenant: string;
let north: string;
let south: string;
let northCampaign: string;
let southCampaign: string;
const agent = randomUUID();

async function mark(o: { account?: string | null; campaign?: string | null; addedBy?: string; source?: string; at?: Date }) {
  await pool().query(
    `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source, added_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenant, o.account ?? null, o.campaign ?? null, `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      o.source ?? 'agent', o.addedBy ?? agent, o.at ?? IN_WINDOW],
  );
}

const count = (accountId: string) =>
  repo.agentDncMarked({ agentUserId: agent, tenantId: tenant, accountId, from: FROM, to: TO });

beforeEach(async () => {
  await truncateAll();
  tenant = (await insertTenant()).id as string;
  north = (await insertAccount({ tenant_id: tenant })).id as string;
  south = (await insertAccount({ tenant_id: tenant })).id as string;
  northCampaign = (await insertAgencyCampaign({ tenant_id: tenant, account_id: north })).id as string;
  southCampaign = (await insertAgencyCampaign({ tenant_id: tenant, account_id: south })).id as string;
});

afterAll(closeTestPool);

describe('agentDncMarked: the agent report counts this account\'s marks only', () => {
  it('counts the account\'s own, its campaigns\' and tenant-wide marks, and not another account\'s campaign marks', async () => {
    await mark({ campaign: northCampaign });                        // a station mark on North's campaign
    await mark({ campaign: northCampaign, addedBy: `user:${agent}` }); // bare or prefixed author
    await mark({ account: north });                                 // North's account entry
    await mark({});                                                  // tenant-wide escalation
    await mark({ campaign: southCampaign });                        // South's campaign: not North's
    await mark({ account: south });                                 // South's account entry

    expect(await count(north)).toBe(4);
    expect(await count(south)).toBe(3);
  });

  it('leaves out a campaign that no longer exists, other authors, other sources and marks outside the window', async () => {
    await mark({ campaign: randomUUID() });
    await mark({ campaign: northCampaign, addedBy: randomUUID() });
    await mark({ campaign: northCampaign, source: 'api' });
    await mark({ campaign: northCampaign, at: new Date('2026-10-31T23:59:59Z') });
    await mark({ campaign: northCampaign, at: TO });

    expect(await count(north)).toBe(0);
  });

  it('takes a campaign of another tenant as no campaign of this account', async () => {
    const otherTenant = (await insertTenant()).id as string;
    // A campaign row with the same account id but another tenant cannot make the mark this account's.
    const foreign = (await insertAgencyCampaign({ tenant_id: otherTenant, account_id: north })).id as string;
    await mark({ campaign: foreign });

    expect(await count(north)).toBe(0);
  });
});
