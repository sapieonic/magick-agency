import { beforeEach, describe, expect, it, vi } from 'vitest';

// The two occupancy reads (the per-agent record and the roster) open with ONE
// builder's CTEs. What they MEAN is pinned on Postgres by agent-occupancy-window,
// agent-occupancy-carried-bound and the roster suites; this pins that they cannot
// drift apart in TEXT: the shared part is byte-identical except for the two
// variant slots, and both repository statements are built from it.

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { occupancyIntervalsCtes, AgencyAgentStatsRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);

const FROM = new Date('2026-08-18T00:00:00Z');
const TO = new Date('2026-08-19T00:00:00Z');

/** Everything after `sess`, with the two variant slots replaced by markers. */
function sharedPart(sql: string, agentMatch: string, intervalKey: string): string {
  const tail = sql.slice(sql.indexOf('), in_window AS ('));
  expect(tail.split(`e.agent_user_id ${agentMatch}\n`)).toHaveLength(3); // in_window + carried
  return tail
    .replaceAll(`e.agent_user_id ${agentMatch}\n`, 'e.agent_user_id <AGENT>\n')
    .replace(`SELECT ${intervalKey},\n`, 'SELECT <KEY>,\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [] });
});

describe('occupancyIntervalsCtes', () => {
  it('the two variants are byte-identical outside sess, the agent predicate and the interval key', () => {
    const agent = occupancyIntervalsCtes('agent', '');
    const roster = occupancyIntervalsCtes('roster', '');
    expect(sharedPart(agent, '= $1', 'sess.zone'))
      .toBe(sharedPart(roster, '= ANY($1::uuid[])', 'sess.agent_user_id'));
    // The clips and the carried-in bound are in the shared part, so both carry them.
    for (const sql of [agent, roster]) {
      expect(sql).toContain('AND e.at >= (SELECT MIN(joined_at) FROM sess)');
      expect(sql).toContain('ORDER BY e.session_id, e.at DESC, e.id DESC');
      expect(sql).toContain("WHEN ev.to_state = 'offline' THEN 'infinity'::timestamptz");
    }
  });

  it('both sess CTEs bind the same five positions and select joined_at for the bound', () => {
    for (const variant of ['agent', 'roster'] as const) {
      const sess = occupancyIntervalsCtes(variant, '').split('), in_window AS (')[0]!;
      for (const placeholder of ['$1', '$2', '$3', '$4', '$5']) expect(sess, variant).toContain(placeholder);
      expect(sess, variant).toContain('s.joined_at');
      expect(sess, variant).toContain('AND (s.left_at IS NULL OR s.left_at > $2)');
    }
  });

  it('appends the optional campaign narrowing to sess', () => {
    const filter = '\n            AND s.campaign_id = $6::uuid';
    for (const variant of ['agent', 'roster'] as const) {
      const sess = occupancyIntervalsCtes(variant, filter).split('), in_window AS (')[0]!;
      expect(sess).toContain('AND (s.left_at IS NULL OR s.left_at > $2)\n            AND s.campaign_id = $6::uuid');
    }
  });

  it('the per-agent record and the roster each open their statement with their variant', async () => {
    const repo = new AgencyAgentStatsRepository();
    await repo.stats({ tenantId: 't', accountId: 'a', agentUserId: 'u' }, { from: FROM, to: TO, bucket: 'day', campaignId: 'c' } as never);
    const statsSql = pool.query.mock.calls.map((c) => String(c[0])).find((s) => s.includes('in_window AS ('))!;
    expect(statsSql.startsWith(occupancyIntervalsCtes('agent', '\n            AND s.campaign_id = $6::uuid'))).toBe(true);

    pool.query.mockClear();
    pool.query.mockResolvedValueOnce({
      rows: [{ agent_user_id: 'u', attempts: '1', connected: '0', successes: '0', talk_seconds: '0', wrapup_seconds: '0', campaigns: '1', last_dialed_at: null }],
    });
    await repo.roster({ tenantId: 't', accountId: 'a' }, { from: FROM, to: TO, sort: 'attempts', order: 'desc', limit: 5, campaignId: 'c' } as never);
    const rosterSql = pool.query.mock.calls.map((c) => String(c[0])).find((s) => s.includes('in_window AS ('))!;
    expect(rosterSql.startsWith(occupancyIntervalsCtes('roster', '\n            AND s.campaign_id = $6::uuid'))).toBe(true);
  });
});
