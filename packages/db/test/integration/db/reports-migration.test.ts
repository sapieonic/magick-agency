// Real Postgres: migrations/0023_reports.sql (docs/reports.md, RP1–RP16). globalSetup has
// applied every migration. Pins report_runs and report_subscriptions (columns, every CHECK
// including the 31-days-plus-an-hour window cap at its boundary, the one-run-per-period unique
// index, the tenant cascade), the pipeline's indexes, the agent-first sessions index and that
// the planner uses it, then down and up again.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, insertRow, insertTenant } from '../fixtures.js';

const pool = () => getTestPool();

let tenantId: string;
beforeEach(async () => {
  await truncateAll();
  tenantId = (await insertTenant()).id as string;
});
afterAll(closeTestPool);

const FILE = '0023_reports.sql';

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

async function columns(table: string) {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return rows.map((r) => `${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}`);
}

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

async function planOf(sql: string, params: unknown[]): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** A valid queued run: October 2026 in Europe/London (31 days, one of them 25 hours long). */
function run(o: Record<string, unknown> = {}) {
  return insertRow('report_runs', {
    tenant_id: tenantId,
    account_id: ACCOUNT,
    kind: 'campaign',
    subject_id: randomUUID(),
    range_from: '2026-09-30T23:00:00Z',
    range_to: '2026-11-01T00:00:00Z',
    local_from: '2026-10-01',
    local_to: '2026-10-31',
    timezone: 'Europe/London',
    formats: ['pdf', 'xlsx'],
    audience: 'supervisor',
    ...o,
  });
}

function subscription(o: Record<string, unknown> = {}) {
  return insertRow('report_subscriptions', {
    tenant_id: tenantId,
    account_id: ACCOUNT,
    kind: 'account',
    subject_id: ACCOUNT,
    cadence: 'daily',
    send_local_time: '07:30',
    timezone: 'Asia/Kolkata',
    formats: ['pdf'],
    recipient_user_ids: [randomUUID()],
    next_run_at: '2026-11-09T02:00:00Z',
    created_by: randomUUID(),
    ...o,
  });
}

const refused = (constraint: string) => ({ code: '23514', constraint });

describe('0023 — reports', () => {
  it('report_runs: the columns the wire types and the pipeline need', async () => {
    expect(await columns('report_runs')).toEqual([
      'id uuid not null', 'tenant_id uuid not null', 'account_id uuid', 'kind character varying not null',
      'subject_id uuid not null', 'campaign_ids ARRAY', 'range_from timestamp with time zone not null',
      'range_to timestamp with time zone not null', 'local_from date not null', 'local_to date not null',
      'timezone text not null', 'formats ARRAY not null', 'audience character varying not null', 'requested_by uuid',
      'email_me boolean not null', 'subscription_id uuid', 'period_start date', 'status character varying not null',
      'claim_generation integer not null', 'claimed_at timestamp with time zone', 'render_attempt integer not null',
      'sent_at timestamp with time zone', 'dataset_key text', 'detail_files jsonb not null', 'files jsonb not null',
      'truncated boolean not null', 'renderer_version text', 'error_code character varying', 'error_message text',
      'notified_at timestamp with time zone', 'created_at timestamp with time zone not null',
      'finished_at timestamp with time zone', 'expires_at timestamp with time zone',
    ]);
    const row = await run();
    expect(row).toMatchObject({
      status: 'queued', claim_generation: 0, render_attempt: 0, detail_files: [], files: [], truncated: false,
      email_me: false, subscription_id: null, notified_at: null,
    });
  });

  it('report_subscriptions: the columns of the wire type', async () => {
    expect(await columns('report_subscriptions')).toEqual([
      'id uuid not null', 'tenant_id uuid not null', 'account_id uuid', 'kind character varying not null',
      'subject_id uuid not null', 'cadence character varying not null', 'send_local_time time without time zone not null',
      'send_weekday smallint', 'send_monthday smallint', 'timezone text not null', 'formats ARRAY not null',
      'recipient_user_ids ARRAY not null', 'enabled boolean not null', 'next_run_at timestamp with time zone',
      'created_by uuid not null', 'created_at timestamp with time zone not null', 'updated_at timestamp with time zone not null',
    ]);
  });

  it('the window cap is 745 hours exactly (RP2), and the window runs forwards', async () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const at = (ms: number) => new Date(from.getTime() + ms).toISOString();
    const cap = (31 * 24 + 1) * 3_600_000;
    await run({ range_from: from.toISOString(), range_to: at(cap) });
    await expect(run({ range_from: from.toISOString(), range_to: at(cap + 1000) })).rejects.toMatchObject(refused('ck_report_runs_window'));
    await expect(run({ range_from: from.toISOString(), range_to: from.toISOString() })).rejects.toMatchObject(refused('ck_report_runs_window'));
    await expect(run({ local_from: '2026-10-02', local_to: '2026-10-01' })).rejects.toMatchObject(refused('ck_report_runs_window'));
  });

  it('refuses a bad kind, status, audience, format list, campaign list, zone or counter', async () => {
    await expect(run({ kind: 'team' })).rejects.toMatchObject(refused('ck_report_runs_kind'));
    await expect(run({ status: 'done' })).rejects.toMatchObject(refused('ck_report_runs_status'));
    // `self` is an agent's own review only (RP5).
    await expect(run({ audience: 'self' })).rejects.toMatchObject(refused('ck_report_runs_audience'));
    await run({ kind: 'agent', audience: 'self' });
    await expect(run({ formats: [] })).rejects.toMatchObject(refused('ck_report_runs_formats'));
    await expect(run({ formats: ['pdf', 'csv'] })).rejects.toMatchObject(refused('ck_report_runs_formats'));
    await expect(run({ campaign_ids: [randomUUID()] })).rejects.toMatchObject(refused('ck_report_runs_campaign_ids'));
    await expect(run({ kind: 'account', campaign_ids: [] })).rejects.toMatchObject(refused('ck_report_runs_campaign_ids'));
    await run({ kind: 'account', campaign_ids: [randomUUID()] });
    await expect(run({ timezone: ' Europe/London' })).rejects.toMatchObject(refused('ck_report_runs_timezone'));
    await expect(run({ render_attempt: -1 })).rejects.toMatchObject(refused('ck_report_runs_counters'));
    await expect(run({ files: JSON.stringify({}) })).rejects.toMatchObject(refused('ck_report_runs_json'));
  });

  it('a subscription run carries its period, an ad hoc one none; one run per (subscription, period)', async () => {
    const sub = randomUUID();
    await expect(run({ subscription_id: sub })).rejects.toMatchObject(refused('ck_report_runs_subscription'));
    await expect(run({ period_start: '2026-10-01' })).rejects.toMatchObject(refused('ck_report_runs_subscription'));
    await run({ subscription_id: sub, period_start: '2026-10-01' });
    await expect(run({ subscription_id: sub, period_start: '2026-10-01' }))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_report_runs_subscription_period' });
    await run({ subscription_id: sub, period_start: '2026-11-01' });
    await run({ subscription_id: randomUUID(), period_start: '2026-10-01' });
    // Ad hoc runs are not constrained by the index.
    await run();
    await run();
    expect(await indexDef('uq_report_runs_subscription_period')).toBe(
      'CREATE UNIQUE INDEX uq_report_runs_subscription_period ON public.report_runs USING btree (subscription_id, period_start) WHERE (subscription_id IS NOT NULL)');
  });

  it('only a failed run has an error, with a known code; finished_at and expires_at follow the status', async () => {
    const now = new Date().toISOString();
    await expect(run({ error_code: 'render_failed', error_message: 'x' })).rejects.toMatchObject(refused('ck_report_runs_error'));
    await expect(run({ status: 'failed', finished_at: now })).rejects.toMatchObject(refused('ck_report_runs_error'));
    await expect(run({ status: 'failed', finished_at: now, error_code: 'oops', error_message: 'x' }))
      .rejects.toMatchObject(refused('ck_report_runs_error'));
    await expect(run({ status: 'failed', finished_at: now, error_code: 'render_failed' }))
      .rejects.toMatchObject(refused('ck_report_runs_error'));
    await run({ status: 'failed', finished_at: now, error_code: 'render_failed', error_message: 'Chromium exited' });
    await expect(run({ status: 'ready' })).rejects.toMatchObject(refused('ck_report_runs_finished'));
    await expect(run({ status: 'ready', finished_at: now })).rejects.toMatchObject(refused('ck_report_runs_finished'));
    await expect(run({ finished_at: now })).rejects.toMatchObject(refused('ck_report_runs_finished'));
    await run({ status: 'ready', finished_at: now, expires_at: now });
    await run({ status: 'expired', finished_at: now, expires_at: now });
  });

  it('subscriptions: the day field of the cadence only, 1–7 and 1–28; next_run_at exactly while enabled', async () => {
    await subscription();
    await expect(subscription({ send_weekday: 1 })).rejects.toMatchObject(refused('ck_report_subscriptions_days'));
    await expect(subscription({ cadence: 'weekly' })).rejects.toMatchObject(refused('ck_report_subscriptions_days'));
    await expect(subscription({ cadence: 'weekly', send_weekday: 8 })).rejects.toMatchObject(refused('ck_report_subscriptions_days'));
    await expect(subscription({ cadence: 'weekly', send_weekday: 0 })).rejects.toMatchObject(refused('ck_report_subscriptions_days'));
    await subscription({ cadence: 'weekly', send_weekday: 7 });
    await expect(subscription({ cadence: 'monthly', send_monthday: 29 })).rejects.toMatchObject(refused('ck_report_subscriptions_days'));
    await expect(subscription({ cadence: 'monthly', send_monthday: 3, send_weekday: 1 })).rejects.toMatchObject(refused('ck_report_subscriptions_days'));
    await subscription({ cadence: 'monthly', send_monthday: 28 });
    await expect(subscription({ cadence: 'hourly' })).rejects.toMatchObject(refused('ck_report_subscriptions_cadence'));
    await expect(subscription({ recipient_user_ids: [] })).rejects.toMatchObject(refused('ck_report_subscriptions_recipients'));
    await expect(subscription({ recipient_user_ids: Array.from({ length: 21 }, () => randomUUID()) }))
      .rejects.toMatchObject(refused('ck_report_subscriptions_recipients'));
    await expect(subscription({ formats: ['docx'] })).rejects.toMatchObject(refused('ck_report_subscriptions_formats'));
    await expect(subscription({ enabled: false })).rejects.toMatchObject(refused('ck_report_subscriptions_enabled'));
    await expect(subscription({ next_run_at: null })).rejects.toMatchObject(refused('ck_report_subscriptions_enabled'));
    await subscription({ enabled: false, next_run_at: null });
    await expect(subscription({ kind: 'team' })).rejects.toMatchObject(refused('ck_report_subscriptions_kind'));
  });

  it('a tenant delete cascades to its runs and subscriptions', async () => {
    await run();
    await subscription();
    await pool().query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    const { rows } = await pool().query(
      'SELECT (SELECT count(*) FROM report_runs)::int AS runs, (SELECT count(*) FROM report_subscriptions)::int AS subs');
    expect(rows[0]).toEqual({ runs: 0, subs: 0 });
  });

  it('the pipeline and history indexes, as defined', async () => {
    expect(await indexDef('idx_report_runs_pending')).toBe(
      "CREATE INDEX idx_report_runs_pending ON public.report_runs USING btree (status, created_at) WHERE ((status)::text = ANY ((ARRAY['queued'::character varying, 'assembling'::character varying, 'rendering'::character varying])::text[]))");
    expect(await indexDef('idx_report_runs_history')).toBe(
      'CREATE INDEX idx_report_runs_history ON public.report_runs USING btree (tenant_id, account_id, created_at DESC, id DESC)');
    expect(await indexDef('idx_report_runs_requester')).toBe(
      'CREATE INDEX idx_report_runs_requester ON public.report_runs USING btree (requested_by, created_at DESC, id DESC) WHERE (requested_by IS NOT NULL)');
    expect(await indexDef('idx_report_runs_expiry')).toBe(
      "CREATE INDEX idx_report_runs_expiry ON public.report_runs USING btree (expires_at) WHERE ((status)::text = 'ready'::text)");
    expect(await indexDef('idx_report_runs_unnotified')).toMatch(/\(finished_at\) WHERE \(\(notified_at IS NULL\)/);
    expect(await indexDef('idx_report_subscriptions_due')).toBe(
      'CREATE INDEX idx_report_subscriptions_due ON public.report_subscriptions USING btree (next_run_at) WHERE enabled');
  });

  it('the agent-first sessions index, and the planner reads one agent through it', async () => {
    // No agent-first rollup index: it would draw the allocation counters' campaign-first plan off
    // the unique index (insights-reads.test.ts pins that plan).
    expect(await indexDef('idx_agency_insights_rollup_agents_agent')).toBeUndefined();
    expect(await indexDef('idx_agency_agent_sessions_agent')).toBe(
      'CREATE INDEX idx_agency_agent_sessions_agent ON public.agency_agent_sessions USING btree (agent_user_id, joined_at)');
    const agent = randomUUID();
    const sessions = await planOf(
      `SELECT id FROM agency_agent_sessions
        WHERE agent_user_id = $1::uuid AND joined_at < $3::timestamptz AND (left_at IS NULL OR left_at > $2::timestamptz)`,
      [agent, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z']);
    expect(sessions).toMatch(/idx_agency_agent_sessions_agent/);
  });

  it('down drops both tables and the sessions index; up re-applies', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      const { rows } = await pool().query(
        `SELECT tablename AS name FROM pg_tables WHERE tablename IN ('report_runs', 'report_subscriptions')
         UNION ALL SELECT indexname FROM pg_indexes
          WHERE indexname = 'idx_agency_agent_sessions_agent'`);
      expect(rows).toEqual([]);
    } finally {
      await migrate('up');
    }
    expect((await columns('report_runs')).length).toBe(33);
    expect(await indexDef('idx_agency_agent_sessions_agent')).toBeDefined();
  });
});
