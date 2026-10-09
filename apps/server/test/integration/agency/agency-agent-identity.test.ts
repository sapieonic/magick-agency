import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertTenant, insertUser } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
const { enrichAssignedAgents, resolveAgentNames, enrichAgentStatsIdentity, enrichGroupedRowAgentNames } =
  await import('../../../src/agency/agency-agent-identity.js');

/**
 * The database-touching half of `agency-agent-identity.ts` on REAL Postgres. The unit suite of
 * this module is pure-function only (`foldHighestRole`), so the three enrichers and
 * `resolveAgentNames` would otherwise run their SQL (`users` JOIN `memberships`, tenant-scoped) only in route
 * tests with a fake pool.
 */

let tenantId: string;
let otherTenantId: string;
let accountA: string;
let accountB: string;
let sam: string;
let foreign: string;

async function member(user: string, tenant: string, account: string | null, role: string) {
  await getTestPool().query(
    `INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, $4)`,
    [user, tenant, account, role],
  );
}

beforeEach(async () => {
  await truncateAll();
  tenantId = (await insertTenant()).id;
  otherTenantId = (await insertTenant()).id;
  accountA = (await insertAccount({ tenant_id: tenantId })).id;
  accountB = (await insertAccount({ tenant_id: tenantId })).id;
  sam = (await insertUser({ display_name: 'Sam', email: 'sam@example.com' })).id;
  foreign = (await insertUser({ display_name: 'Priya', email: 'priya@other.example' })).id;
  // Sam is an agent in one account and a tenant_admin tenant-wide: the HIGHEST role must win.
  await member(sam, tenantId, accountA, 'agent');
  await member(sam, tenantId, null, 'tenant_admin');
  await member(foreign, otherTenantId, null, 'tenant_owner');
});

afterAll(async () => {
  await closeTestPool();
});

describe('agency-agent-identity on real Postgres', () => {
  it('enrichAssignedAgents: one row per assignment, name/email split, highest role, tenant-scoped', async () => {
    const assigned_at = new Date('2026-06-01T00:00:00Z');
    const base = { id: randomUUID(), tenant_id: tenantId, account_id: accountB, campaign_id: randomUUID() };
    const rows = await enrichAssignedAgents(
      [
        { ...base, user_id: sam, assigned_at },
        { ...base, user_id: foreign, assigned_at },
        { ...base, user_id: randomUUID(), assigned_at },
      ] as never,
      tenantId,
    );

    expect(rows).toEqual([
      { user_id: sam, name: 'Sam', email: 'sam@example.com', role: 'tenant_admin', assigned_at },
      expect.objectContaining({ user_id: foreign, name: null, email: null, role: null }),
      expect.objectContaining({ name: null, email: null, role: null }),
    ]);
  });

  it('resolveAgentNames: tenant-scoped; a non-UUID id resolves to nothing instead of throwing', async () => {
    const names = await resolveAgentNames([sam, foreign, 'nope'], tenantId);
    expect([...names.entries()]).toEqual([[sam, 'Sam']]);
  });

  it('enrichAgentStatsIdentity: adds agent_name, null for a foreign-tenant id', async () => {
    expect(await enrichAgentStatsIdentity({ agent_user_id: sam, calls: 3 }, tenantId, resolveAgentNames))
      .toEqual({ agent_user_id: sam, calls: 3, agent_name: 'Sam' });
    expect(await enrichAgentStatsIdentity({ agent_user_id: foreign }, tenantId, resolveAgentNames))
      .toEqual({ agent_user_id: foreign, agent_name: null });
  });

  it('enrichGroupedRowAgentNames: names every grouped row with one lookup', async () => {
    const out = (await enrichGroupedRowAgentNames(
      { rows: [{ key: { agent_user_id: sam } }, { key: { agent_user_id: foreign } }], next_cursor: null },
      tenantId,
      resolveAgentNames,
    )) as { rows: Array<Record<string, unknown>> };

    expect(out.rows.map((r) => r['agent_name'])).toEqual(['Sam', null]);
  });
});
