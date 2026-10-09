import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertTenant, insertUser } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
const { fetchActivityPage } = await import('../../../src/agency/agency-activity.service.js');
const { resetAuditRetentionCache } = await import('../../../src/audit/audit-retention.js');

/**
 * The campaign activity trail, end to end on REAL Postgres (decision B7).
 *
 * The trail merges `platform_audit_log` (the "Console" half) and `audit_logs` (the "Dialer" half,
 * read in-process from `audit_logs`). A mocked-pool suite
 * could not see either table's SQL, scope or ordering, and the hop that is now an in-process read
 * of `audit_logs` had no test of its own.
 */

let tenantId: string;
let accountId: string;
let campaignId: string;
let userId: string;

const BASE = Date.parse('2026-06-15T12:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

async function dialer(over: {
  tenant?: string; account?: string; campaign?: string; type?: string; minutes: number;
}) {
  const id = randomUUID();
  await getTestPool().query(
    `INSERT INTO audit_logs (id, tenant_id, account_id, event_type, event_category, severity, event_data, actor, ip_address, timestamp)
     VALUES ($1, $2, $3, $4, 'system', 'info', $5::jsonb, 'pacing-engine', '10.9.9.9', $6)`,
    [
      id, over.tenant ?? tenantId, over.account ?? accountId, over.type ?? 'agency_campaign.running',
      JSON.stringify({ campaign_id: over.campaign ?? campaignId }), at(over.minutes),
    ],
  );
  return id;
}

async function console_(over: {
  tenant?: string; campaign?: string; action?: string; user?: string | null; minutes: number;
}) {
  const id = randomUUID();
  await getTestPool().query(
    `INSERT INTO platform_audit_log (id, tenant_id, account_id, user_id, actor_type, action, resource_type, resource_id, campaign_id, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'agency_campaign', $7, $7, '{}'::jsonb, $8)`,
    [
      id, over.tenant ?? tenantId, accountId, over.user === undefined ? userId : over.user,
      (over.user === undefined ? userId : over.user) === null ? 'system' : 'human',
      over.action ?? 'agency_campaign.paused', over.campaign ?? campaignId, at(over.minutes),
    ],
  );
  return id;
}

const query = (over: Partial<Parameters<typeof fetchActivityPage>[0]> = {}) => ({
  tenantId, campaignId, accountId, limit: 50, cursor: { master: null, core: null }, ...over,
});

beforeEach(async () => {
  await truncateAll();
  resetAuditRetentionCache();
  tenantId = (await insertTenant()).id;
  accountId = (await insertAccount({ tenant_id: tenantId })).id;
  campaignId = randomUUID();
  const user = await insertUser({ display_name: '  Sam Patel  ' });
  userId = user.id;
  await getTestPool().query(
    `INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, 'account_admin')`,
    [userId, tenantId, accountId],
  );
});

afterAll(async () => {
  await closeTestPool();
});

describe('fetchActivityPage on real Postgres', () => {
  it('merges both tables newest first, labelling each row with its source and resolving the actor', async () => {
    const d1 = await dialer({ minutes: 1, type: 'agency_campaign.created' });
    const m1 = await console_({ minutes: 2, action: 'agency_campaign.started' });
    const d2 = await dialer({ minutes: 3, type: 'agency_campaign.running' });

    const page = await fetchActivityPage(query());

    expect(page.rows.map((r) => [r.source, r.id, r.action])).toEqual([
      ['core', `core:${d2}`, 'agency_campaign.running'],
      ['master', `master:${m1}`, 'agency_campaign.started'],
      ['core', `core:${d1}`, 'agency_campaign.created'],
    ]);
    expect(page.rows[1]!.actor).toEqual({
      type: 'human', system: false, user_id: userId, api_key_id: null, display: 'Sam Patel',
    });
    expect(page.rows[0]!.target).toEqual({ type: 'agency_campaign', id: campaignId });
    expect(page).toMatchObject({ nextCursor: null, total: 3, partial: false, partial_reason: null });
    expect(page.retention).not.toBeNull();
    // Operator IPs live on the audit_logs row and must never reach the merged trail.
    expect(JSON.stringify(page.rows)).not.toContain('10.9.9.9');
  });

  it("never returns another tenant's, another account's or another campaign's rows", async () => {
    const otherTenant = (await insertTenant()).id;
    const otherAccount = (await insertAccount({ tenant_id: tenantId })).id;
    const ownDialer = await dialer({ minutes: 1 });
    const ownConsole = await console_({ minutes: 2 });
    // The SAME campaign id under another tenant (ids are not globally unique across tenants here).
    await dialer({ minutes: 3, tenant: otherTenant });
    await console_({ minutes: 4, tenant: otherTenant });
    // Same tenant, a sibling account's audit_logs rows about the same campaign id.
    await dialer({ minutes: 5, account: otherAccount });
    // Same tenant and account, a different campaign.
    await dialer({ minutes: 6, campaign: randomUUID() });
    await console_({ minutes: 7, campaign: randomUUID() });

    const page = await fetchActivityPage(query());

    expect(page.rows.map((r) => r.id).sort()).toEqual([`core:${ownDialer}`, `master:${ownConsole}`].sort());
    expect(page.total).toBe(2);

    // And from the other side: the other tenant's caller sees only its own.
    const theirs = await fetchActivityPage(query({ tenantId: otherTenant, accountId }));
    expect(theirs.rows).toHaveLength(2);
    expect(theirs.rows.map((r) => r.id)).not.toContain(`core:${ownDialer}`);
    expect(theirs.rows.map((r) => r.id)).not.toContain(`master:${ownConsole}`);
  });

  it('pages through both stores with a keyset cursor: no row skipped, none repeated', async () => {
    const expected: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      expected.push(`core:${await dialer({ minutes: i * 2 })}`);
      expected.push(`master:${await console_({ minutes: i * 2 + 1 })}`);
    }
    expected.reverse();

    const seen: string[] = [];
    let cursor = { master: null, core: null } as Parameters<typeof fetchActivityPage>[0]['cursor'];
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await fetchActivityPage(query({ limit: 3, cursor }));
      seen.push(...page.rows.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(expected);
  });

  it('applies the action filter to BOTH halves, and the from/to window', async () => {
    await dialer({ minutes: 1, type: 'agency_campaign.created' });
    const keepD = await dialer({ minutes: 10, type: 'agency_campaign.auto_paused' });
    await console_({ minutes: 11, action: 'agency_campaign.started' });
    const keepM = await console_({ minutes: 12, action: 'agency_campaign.auto_paused' });
    await dialer({ minutes: 30, type: 'agency_campaign.auto_paused' });

    const filtered = await fetchActivityPage(query({ actions: ['agency_campaign.auto_paused'], to: new Date(at(20)) }));
    expect(filtered.rows.map((r) => r.id).sort()).toEqual([`core:${keepD}`, `master:${keepM}`].sort());

    const windowed = await fetchActivityPage(query({ from: new Date(at(10)), to: new Date(at(12)) }));
    expect(windowed.rows).toHaveLength(3);
  });

  it('skipTotal drops both counts', async () => {
    await dialer({ minutes: 1 });
    await console_({ minutes: 2 });

    const page = await fetchActivityPage(query({ skipTotal: true }));

    expect(page.rows).toHaveLength(2);
    expect(page.total).toBeNull();
    expect(page.partial).toBe(false);
  });

  it('reports a null display for an actor whose identity cannot be resolved, never a raw id', async () => {
    const ghost = (await insertUser()).id; // a user with no membership in this tenant
    await console_({ minutes: 1, user: ghost });
    await console_({ minutes: 2, user: null });

    const page = await fetchActivityPage(query());

    expect(page.rows.find((r) => r.actor.user_id === ghost)!.actor.display).toBeNull();
    expect(page.rows.find((r) => r.actor.type === 'system')!.actor).toMatchObject({ system: true, display: 'system' });
  });
});
