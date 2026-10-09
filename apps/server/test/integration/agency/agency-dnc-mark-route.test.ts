import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant, uuidFor } from '../setup/factories.js';
import { DEFAULTS as DB_DEFAULTS } from '../../../../../packages/db/test/integration/setup/factories.js';
import {
  insertAgencyAttempt,
  insertAgencyCampaign,
  insertAgencyContact,
} from './agency-factories.js';

/*
 * Under decision B8 the DNC mark route writes the roster suppression, the optional disposition
 * and the `dnc_entries` row in ONE transaction: there is no outbox write and no wire hop. So:
 *  - the campaign-scope and tenant-scope cases assert the `dnc_entries` row (scope, phone,
 *    reason, added_by, source `agent`) and that the outbox stays empty, alongside the HTTP and
 *    roster-SQL assertions;
 *  - "a failed DNC write rolls back the local suppression": the failure is a genuine one
 *    (a trigger raising inside the `dnc_entries` insert); nothing commits;
 *  - "writes nothing for an invalid scope or for another account's attempt" asserts
 *    `dnc_entries` empty;
 *  - harness: the private route module is mounted as `agencyRoutes` under
 *    `/api/v1/agency`; auth is `authMiddleware`'s header half (no API keys); ids are
 *    UUIDs; the pool is mocked through `@magick-agency/db`; the config stub carries no `auth`,
 *    carrier or upstream-service config; the logger targets `@magick-agency/observability`; the
 *    runtime stub has no `dnc.applyDelta|applyReplace` (no Redis set).
 */

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {},
  },
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { flags } = vi.hoisted(() => ({
  flags: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean' } },
}));

const { agencyRoutes } = await import('../../../src/api/routes/agency.routes.js');

const TENANT = DB_DEFAULTS.tenantId;
const ACCOUNT = DB_DEFAULTS.accountId;
const OTHER_ACCOUNT = uuidFor('dnc-mark-other-account');
const PHONE_RAW = '+1 (415) 555-0100';
const PHONE = '+14155550100';
const AGENT_1 = uuidFor('agent-user-1');
const SUPERVISOR_1 = uuidFor('supervisor-user-1');
const AGENT_9 = uuidFor('agent-user-9');

let app: FastifyInstance;

function runtimeStub() {
  return {
    replicaId: 'integration-r1',
    agents: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
    wrapup: { noteDisposition: vi.fn(), stateFor: vi.fn(() => null) },
    stations: {
      send: vi.fn(() => true), detach: vi.fn(), attach: vi.fn(),
      isLocallyOwned: vi.fn(() => true),
    },
    dialer: {
      hasLiveAttempt: vi.fn(() => false), reattachStation: vi.fn(() => null),
      takeMissedRelease: vi.fn(() => null),
    },
    breaks: { queue: vi.fn(), take: vi.fn(() => null), cancel: vi.fn(() => false) },
    tokens: { mint: vi.fn(), verifyAndConsume: vi.fn() },
    dnc: { check: vi.fn() },
    rehydrateAgent: vi.fn().mockResolvedValue('break'),
    releaseStationOnClose: vi.fn().mockResolvedValue(true),
  };
}

function headers(overrides: Record<string, string> = {}) {
  return {
    'x-mgkvc-tenant': TENANT,
    'x-mgkvc-account': ACCOUNT,
    'content-type': 'application/json',
    ...overrides,
  };
}

async function seedAttempt(overrides: {
  tenantId?: string;
  accountId?: string;
  duplicate?: boolean;
  otherCampaign?: boolean;
} = {}) {
  const tenantId = overrides.tenantId ?? TENANT;
  const accountId = overrides.accountId ?? ACCOUNT;
  const campaign = await insertAgencyCampaign({
    tenant_id: tenantId,
    account_id: accountId,
    status: 'running',
  });
  const marked = await insertAgencyContact(campaign.id, {
    tenant_id: tenantId,
    account_id: accountId,
    phone_e164: PHONE_RAW,
    state: 'connected',
    source_row_number: 1,
  });
  const duplicate = overrides.duplicate === false ? null : await insertAgencyContact(campaign.id, {
    tenant_id: tenantId,
    account_id: accountId,
    phone_e164: PHONE,
    state: 'pending',
    source_row_number: 2,
  });
  const attempt = await insertAgencyAttempt(campaign.id, marked.id, {
    tenant_id: tenantId,
    account_id: accountId,
    state: 'bridged',
    outcome: 'connected',
    answered_at: new Date(Date.now() - 2_000),
    bridged_at: new Date(Date.now() - 1_000),
  });
  let elsewhere: Record<string, any> | null = null;
  if (overrides.otherCampaign !== false) {
    const other = await insertAgencyCampaign({
      tenant_id: tenantId, account_id: accountId, status: 'draft',
    });
    elsewhere = await insertAgencyContact(other.id, {
      tenant_id: tenantId,
      account_id: accountId,
      phone_e164: PHONE,
      state: 'pending',
      source_row_number: 1,
    });
  }
  return { campaign, marked, duplicate, attempt, elsewhere };
}

async function markDnc(attemptId: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/agency/attempts/${attemptId}/dnc`,
    headers: headers(),
    payload,
  });
}

async function readContacts(ids: string[]) {
  const { rows } = await getTestPool().query<{
    id: string;
    state: string;
    suppressed_reason: string | null;
  }>(
    `SELECT id, state, suppressed_reason FROM agency_contacts
      WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

// `agency_dnc_outbox` is dead under B8 (kept in
// the schema for the rollback-window mirror; nothing writes it). Read here as a TRIPWIRE:
// a mark that started queueing an outbox row again — the old two-step write coming back — reds
// the `toEqual([])` assertions below.
async function readOutbox() {
  const { rows } = await getTestPool().query('SELECT id FROM agency_dnc_outbox');
  return rows;
}

async function readDncEntries() {
  const { rows } = await getTestPool().query(
    `SELECT tenant_id, account_id, campaign_id, phone_e164, source, reason, added_by
       FROM dnc_entries ORDER BY created_at`,
  );
  return rows as Array<Record<string, unknown>>;
}

describe('POST /api/v1/agency/attempts/:id/dnc (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    // `dnc_entries.tenant_id` references `tenants` (an FK that must be satisfied by seeding the tenant).
    await insertTenant({ id: TENANT });
    flags.isEnabled.mockResolvedValue(true);
    app = Fastify({ logger: false });
    await app.register(async (scope) => agencyRoutes(scope, runtimeStub() as never), {
      prefix: '/api/v1/agency',
    });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    await getTestPool().query('DROP TRIGGER IF EXISTS p8_fail_dnc ON dnc_entries');
    await getTestPool().query('DROP FUNCTION IF EXISTS p8_fail_dnc()');
  });

  afterAll(closeTestPool);

  it('defaults to campaign scope across HTTP, roster SQL and the dnc_entries row', async () => {
    const seeded = await seedAttempt();

    const response = await markDnc(seeded.attempt.id, {
      reason: 'customer requested removal',
      agent_user_id: AGENT_1,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      attempt_id: seeded.attempt.id,
      contact_id: seeded.marked.id,
      campaign_id: seeded.campaign.id,
      phone_e164: PHONE,
      contact_state: 'suppressed',
      dnc_recorded: true,
    });

    const contacts = await readContacts([
      seeded.marked.id, seeded.duplicate!.id, seeded.elsewhere!.id,
    ]);
    expect(contacts.get(seeded.marked.id)).toMatchObject({ state: 'suppressed', suppressed_reason: 'dnc' });
    expect(contacts.get(seeded.duplicate!.id)).toMatchObject({ state: 'suppressed', suppressed_reason: 'dnc' });
    expect(contacts.get(seeded.elsewhere!.id)).toMatchObject({ state: 'pending', suppressed_reason: null });

    expect(await readDncEntries()).toEqual([{
      tenant_id: TENANT,
      account_id: null,
      campaign_id: seeded.campaign.id,
      phone_e164: PHONE,
      source: 'agent',
      reason: 'customer requested removal',
      added_by: AGENT_1,
    }]);
    expect(await readOutbox()).toEqual([]);
  });

  it('stores tenant scope without a campaign id while suppressing locally immediately', async () => {
    const seeded = await seedAttempt();

    const response = await markDnc(seeded.attempt.id, {
      scope: 'tenant',
      agent_user_id: SUPERVISOR_1,
    });

    expect(response.statusCode).toBe(200);
    const entries = await readDncEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tenant_id: TENANT,
      phone_e164: PHONE,
      added_by: SUPERVISOR_1,
      campaign_id: null,
    });
    expect(await readOutbox()).toEqual([]);

    const contacts = await readContacts([
      seeded.marked.id, seeded.duplicate!.id, seeded.elsewhere!.id,
    ]);
    expect(contacts.get(seeded.marked.id)?.state).toBe('suppressed');
    expect(contacts.get(seeded.duplicate!.id)?.state).toBe('suppressed');
    expect(contacts.get(seeded.elsewhere!.id)?.state).toBe('pending');
  });

  it('a failed DNC write rolls back the local suppression (one transaction, B8)', async () => {
    const seeded = await seedAttempt();
    await getTestPool().query(`
      CREATE FUNCTION p8_fail_dnc() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'dnc table unavailable'; END $$`);
    await getTestPool().query('CREATE TRIGGER p8_fail_dnc BEFORE INSERT ON dnc_entries FOR EACH ROW EXECUTE FUNCTION p8_fail_dnc()');

    const response = await markDnc(seeded.attempt.id, {
      reason: 'customer asked not to be called',
      agent_user_id: AGENT_9,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('dnc table unavailable'); // the trigger, not some other fault
    expect(await readDncEntries()).toEqual([]);
    const contacts = await readContacts([seeded.marked.id, seeded.duplicate!.id]);
    expect(contacts.get(seeded.marked.id)).toMatchObject({ state: 'connected', suppressed_reason: null });
    expect(contacts.get(seeded.duplicate!.id)).toMatchObject({ state: 'pending', suppressed_reason: null });
  });

  it('writes nothing for an invalid scope or for another account\'s attempt', async () => {
    const owned = await seedAttempt({ duplicate: false, otherCampaign: false });

    const invalid = await markDnc(owned.attempt.id, { scope: 'workspace' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('invalid_dnc_scope');

    const foreign = await seedAttempt({
      accountId: OTHER_ACCOUNT, duplicate: false, otherCampaign: false,
    });
    const forbidden = await markDnc(foreign.attempt.id);
    expect(forbidden.statusCode).toBe(404);
    expect(forbidden.json().message).toBe('Attempt not found');

    expect(await readDncEntries()).toEqual([]);
    const contacts = await readContacts([owned.marked.id, foreign.marked.id]);
    expect(contacts.get(owned.marked.id)).toMatchObject({ state: 'connected', suppressed_reason: null });
    expect(contacts.get(foreign.marked.id)).toMatchObject({ state: 'connected', suppressed_reason: null });
  });
});
