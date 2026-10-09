import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertTenant, insertUser } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
const { enrichAgencyCampaignStats } = await import('../../../src/agency/agency-stats-enrichment.js');
const { userRepository } = await import('@magick-agency/db/repositories/user.repository');

/**
 * `enrichAgencyCampaignStats` on REAL Postgres.
 *
 * The route-level suite drives this module with a hand-written fake pool, so its cases are
 * run here directly against the real `users`/`memberships` tables: the `agent_name` cases,
 * the byte-identity cases and the pass-through cases for the success / retry fields. There
 * is no credit overlay, so there are no `credits_low` cases.
 */

let tenantId: string;
let otherTenantId: string;
let accountId: string;
let ravi: string;
let sunita: string;
let foreign: string;
let deleted: string;
let noName: string;

const CAMPAIGN = '44444444-4444-4444-4444-444444444444';

async function member(userId: string, tenant: string, account: string | null) {
  await getTestPool().query(
    `INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, 'agent')`,
    [userId, tenant, account],
  );
}

function coreStatsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaign_id: CAMPAIGN,
    status: 'dialing',
    contacts_total: 400,
    attempts_total: 900,
    attempts_connected: 240,
    agents_live: 2,
    agents: [
      {
        session_id: 'sess-1', agent_user_id: ravi, state: 'on_call',
        state_since: '2026-08-15T09:00:00.000Z',
        // A field this repo does not know about, standing in for what the handler adds next.
        last_heartbeat: '2026-08-15T09:04:55.000Z', break_reason: null, calls_handled: 12,
      },
      { session_id: 'sess-2', agent_user_id: sunita, state: 'available', calls_handled: 9 },
    ],
    stall: null,
    other_stalls: [],
    ...overrides,
  };
}

const enrich = async (body: unknown, status = 200) =>
  (await enrichAgencyCampaignStats(body, { tenantId, status })) as Record<string, unknown>;
const agents = (b: Record<string, unknown>) => b['agents'] as Record<string, unknown>[];

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  tenantId = (await insertTenant()).id;
  otherTenantId = (await insertTenant()).id;
  accountId = (await insertAccount({ tenant_id: tenantId })).id;
  ravi = (await insertUser({ display_name: 'Ravi', email: 'ravi@example.com' })).id;
  sunita = (await insertUser({ display_name: 'Sunita', email: 'sunita@example.com' })).id;
  foreign = (await insertUser({ display_name: 'Priya', email: 'priya@other.example' })).id;
  deleted = (await insertUser({ display_name: 'Gone', email: 'gone@example.com', status: 'deleted' })).id;
  noName = (await insertUser({ display_name: null, email: 'anon@example.com' })).id;
  for (const u of [ravi, sunita, deleted, noName]) await member(u, tenantId, accountId);
  await member(foreign, otherTenantId, null);
});

afterAll(async () => {
  await closeTestPool();
});

describe('agent_name — the field only the public API layer can fill', () => {
  it('is present on every agent row and carries the display name', async () => {
    const body = await enrich(coreStatsBody());
    expect(agents(body).map((a) => a['agent_name'])).toEqual(['Ravi', 'Sunita']);
  });

  it('resolves the WHOLE roster in one query, deduped — not one per agent', async () => {
    const spy = vi.spyOn(userRepository, 'findDisplayNamesInTenant');
    const row = (id: string) => ({ session_id: randomUUID(), agent_user_id: id, state: 'available' });
    await enrich(coreStatsBody({ agents: [row(ravi), row(sunita), row(ravi)] }));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('resolves an agent_user_id from ANOTHER tenant to null, never to that tenant’s name', async () => {
    const body = await enrich(coreStatsBody({ agents: [{ session_id: 's', agent_user_id: foreign }] }));
    expect(agents(body)[0]!['agent_name']).toBeNull();
  });

  it('resolves a soft-deleted user to null', async () => {
    const body = await enrich(coreStatsBody({ agents: [{ session_id: 's', agent_user_id: deleted }] }));
    expect(agents(body)[0]!['agent_name']).toBeNull();
  });

  it('resolves an unknown user id to null rather than a placeholder string', async () => {
    const body = await enrich(coreStatsBody({ agents: [{ session_id: 's', agent_user_id: randomUUID() }] }));
    expect(agents(body)[0]).toHaveProperty('agent_name', null);
  });

  it('survives a non-UUID agent_user_id without throwing, resolving it to null', async () => {
    const body = await enrich(coreStatsBody({
      agents: [{ session_id: 'a', agent_user_id: 'not-a-uuid' }, { session_id: 'b', agent_user_id: ravi }],
    }));
    expect(agents(body).map((a) => a['agent_name'])).toEqual([null, 'Ravi']);
  });

  it('falls back to the email for a resolved user with no display name', async () => {
    const body = await enrich(coreStatsBody({ agents: [{ session_id: 's', agent_user_id: noName }] }));
    expect(agents(body)[0]!['agent_name']).toBe('anon@example.com');
  });

  it('still emits agent_name: null on every row when the lookup throws', async () => {
    vi.spyOn(userRepository, 'findDisplayNamesInTenant').mockRejectedValue(new Error('db down'));
    const body = await enrich(coreStatsBody());
    expect(agents(body).map((a) => a['agent_name'])).toEqual([null, null]);
  });
});

describe('everything else passes through byte-identically', () => {
  const strip = (b: Record<string, unknown>) => ({
    ...b,
    agents: agents(b).map(({ agent_name: _dropped, ...rest }) => rest),
  });

  it('is the exact handler body once the agent_name keys are removed', async () => {
    const core = coreStatsBody();
    expect(JSON.stringify(strip(await enrich(core)))).toBe(JSON.stringify(core));
  });

  it('appends agent_name AFTER the keys the handler sent, leaving their order intact', async () => {
    const body = await enrich(coreStatsBody());
    expect(Object.keys(agents(body)[0]!)).toEqual([
      'session_id', 'agent_user_id', 'state', 'state_since', 'last_heartbeat', 'break_reason',
      'calls_handled', 'agent_name',
    ]);
  });

  it('forwards a field this repo has never heard of, untouched', async () => {
    const body = await enrich(coreStatsBody({ some_field_added_next_quarter: { nested: [1, 2, 3] } }));
    expect(body['some_field_added_next_quarter']).toEqual({ nested: [1, 2, 3] });
  });

  it('leaves a non-2xx body completely alone (by reference), doing no work', async () => {
    const spy = vi.spyOn(userRepository, 'findDisplayNamesInTenant');
    const errorBody = { error: 'Not Found', code: 'campaign_not_found' };
    expect(await enrichAgencyCampaignStats(errorBody, { tenantId, status: 404 })).toBe(errorBody);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not invent an agents array the handler did not send', async () => {
    expect(await enrich({ campaign_id: CAMPAIGN, status: 'draft' })).not.toHaveProperty('agents');
  });

  it('leaves stall and other_stalls exactly as the handler sent them (no credits_low overlay)', async () => {
    const stall = { code: 'elevated_failure_rate', failed_pct: 40, attempts: 100, window_minutes: 15 };
    const body = await enrich(coreStatsBody({ stall, other_stalls: ['outside_calling_hours'] }));
    expect(body['stall']).toEqual(stall);
    expect(body['other_stalls']).toEqual(['outside_calling_hours']);
  });
});

describe('the handler success and retry fields reach the client untouched', () => {
  it('carries attempts_success and success_rate_pct through, keeping a NULL rate NULL', async () => {
    const withRate = await enrich(coreStatsBody({ attempts_success: 120, success_rate_pct: 50 }));
    expect(withRate).toMatchObject({ attempts_success: 120, success_rate_pct: 50 });

    const noRate = await enrich(coreStatsBody({ attempts_success: 0, success_rate_pct: null }));
    expect(noRate['success_rate_pct']).toBeNull();
    expect(noRate['attempts_success']).toBe(0);
  });

  it('carries attempts_retried through, keeps a real 0, and does not manufacture the field when absent', async () => {
    expect((await enrich(coreStatsBody({ attempts_retried: 17 })))['attempts_retried']).toBe(17);
    expect((await enrich(coreStatsBody({ attempts_retried: 0 })))['attempts_retried']).toBe(0);
    expect(await enrich(coreStatsBody())).not.toHaveProperty('attempts_retried');
  });
});
