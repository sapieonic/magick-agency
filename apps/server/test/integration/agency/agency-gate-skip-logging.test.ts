import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

/*
 * kept, every log-field assertion unchanged. Modified: the connection and logger mocks
 * (agency's `@magick-agency/db` / `@magick-agency/observability`); the config stub
 * drops `telephony.vobiz` (VoBiz deleted) and `masterService` (read only by the DNC
 * resync requester, deleted by B8); and the DNC case (decision B8) puts the number on
 * the list by inserting a tenant-wide `dnc_entries` row instead of publishing
 * `applyReplace({ version: 2, members: [phone] })` into the Redis set — its
 * `synced.applied` check becomes the gate's own `check()` answering `suppressed`.
 */

// The DB pool lives in `@magick-agency/db`
// (the server's repositories import its root, packages/db's repositories `./connection`).
vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {}, // no carrier config is needed
  },
}));

const { log } = vi.hoisted(() => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@magick-agency/observability', () => ({
  logger: log,
  createChildLogger: () => log,
}));

const { createChaosWorld } = await import('./chaos/harness.js');

type World = Awaited<ReturnType<typeof createChaosWorld>>;

let world: World;

function skipLine(): { fields: Record<string, any>; message: string } | null {
  const call = log.info.mock.calls.find(
    (entry) => typeof entry[1] === 'string' && entry[1].includes('pre-dial gate'),
  );
  if (!call) return null;
  return { fields: call[0] as Record<string, any>, message: call[1] as string };
}

async function contactRow(id: string) {
  const { rows } = await getTestPool().query<{
    state: string;
    next_attempt_at: Date;
    suppressed_reason: string | null;
    phone_e164: string;
    csv_line_number: number | null;
  }>(
    `SELECT state, next_attempt_at, suppressed_reason, phone_e164, csv_line_number
       FROM agency_contacts WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

async function attemptCount(campaignId: string): Promise<number> {
  const { rows } = await getTestPool().query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM agency_call_attempts WHERE campaign_id = $1',
    [campaignId],
  );
  return Number(rows[0]!.n);
}

describe('agency pre-dial skip logs at the real pacing/DB seam', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
  });

  afterAll(closeTestPool);

  it('logs an after-hours defer with the exact instant committed to Postgres and creates no attempt', async () => {
    world = await createChaosWorld({
      agents: 1,
      contacts: 1,
      maxConcurrentCalls: 1,
      campaign: {
        calling_window_start: '09:00:00',
        calling_window_end: '20:00:00',
        // A valid window that never opens. The gate parks for one hour rather
        // than making this test depend on the CI machine's wall clock or weekday.
        calling_days: [],
        default_timezone: 'UTC',
      },
    });
    await getTestPool().query(
      'UPDATE agency_contacts SET csv_line_number = 17 WHERE id = $1',
      [world.contactIds[0]],
    );
    await world.bringOnline(world.agents[0]!);

    const before = Date.now();
    await world.tick();
    const after = Date.now();

    const line = skipLine();
    expect(line).not.toBeNull();
    expect(line!.message).toBe('Agency pre-dial gate deferred a contact — no call placed');
    expect(line!.fields).toMatchObject({
      campaignId: world.campaignId,
      tenantId: world.tenantId,
      contactId: world.contactIds[0],
      csvLine: 17,
      gate: 'calling_hours',
      action: 'defer',
      callingWindowStart: '09:00:00',
      callingWindowEnd: '20:00:00',
      callingDays: [],
      campaignTimezone: 'UTC',
      contactTimezone: null,
    });
    expect(Object.keys(line!.fields)).toContain('phone');
    expect(Object.keys(line!.fields)).not.toContain('phone_e164');

    const row = await contactRow(world.contactIds[0]!);
    expect(row.state).toBe('pending');
    expect(row.next_attempt_at.toISOString()).toBe(line!.fields.deferUntil);
    expect(row.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(row.next_attempt_at.getTime()).toBeLessThanOrEqual(after + 60 * 60_000);
    expect(await attemptCount(world.campaignId)).toBe(0);

    const agent = await world.agentState.get(world.agents[0]!.sessionId);
    expect(agent?.state).toBe('available');
  });

  it('logs a DNC suppression with its reason and without irrelevant window fields', async () => {
    world = await createChaosWorld({ agents: 1, contacts: 1, maxConcurrentCalls: 1 });
    const rowBefore = await contactRow(world.contactIds[0]!);
    // Decision B8: the list is `dnc_entries` now; `dnc_entries.tenant_id`
    // references `tenants`, which the chaos world does not insert.
    await getTestPool().query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, 't', $2) ON CONFLICT (id) DO NOTHING`,
      [world.tenantId, `t-${world.tenantId}`],
    );
    await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, phone_e164, source) VALUES ($1, $2, 'api')`,
      [world.tenantId, rowBefore.phone_e164],
    );
    expect(await world.runtime.dnc.check(world.tenantId, rowBefore.phone_e164, {
      accountId: world.accountId, campaignId: world.campaignId,
    })).toBe('suppressed');
    await world.bringOnline(world.agents[0]!);

    await world.tick();

    const line = skipLine();
    expect(line).not.toBeNull();
    expect(line!.message).toBe('Agency pre-dial gate suppressed a contact — no call placed');
    expect(line!.fields).toMatchObject({
      campaignId: world.campaignId,
      contactId: world.contactIds[0],
      gate: 'dnc',
      action: 'suppress',
      suppressedReason: 'dnc',
    });
    expect(line!.fields).not.toHaveProperty('callingWindowStart');
    expect(line!.fields).not.toHaveProperty('deferUntil');
    expect(Object.keys(line!.fields)).toContain('phone');
    expect(Object.keys(line!.fields)).not.toContain('phone_e164');

    const row = await contactRow(world.contactIds[0]!);
    expect(row).toMatchObject({ state: 'suppressed', suppressed_reason: 'dnc' });
    expect(await attemptCount(world.campaignId)).toBe(0);
    expect((await world.agentState.get(world.agents[0]!.sessionId))?.state).toBe('available');
  });
});
