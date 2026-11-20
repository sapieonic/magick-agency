import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * The agent station's campaign settings (BE-6, BE-8, AS4) as a supervisor sets them, through the
 * REAL app (`buildApp`) on real Postgres: the public `/proxy/agency/campaigns` routes, session
 * middleware (Firebase's token check is the one stub), tenancy, RBAC, `callCore`, the internal
 * handlers and the repositories.
 *
 * Pinned here:
 *  - BE-8 `agent_script`: PATCH stores it (texts trimmed) on a running campaign, GET serves it,
 *    the change is audited by name; an unknown `{placeholder}`, too many steps or a wrong shape is
 *    a 400 naming the field and nothing is written; `{}` clears it.
 *  - BE-6 `context_display.roles` / `.types`: stored and served; with no import yet only the shape
 *    is checked; once the campaign has an import, a role or type naming a column its customer list
 *    does not have is a 400 listing the columns, matched ignoring case; a hidden column is never a
 *    role; a retry campaign is checked against its lineage root's import.
 *  - AS4: a campaign created from the Collections starter set stores it as sent.
 *
 * The bootstrap's `script` and the panel's `facts` on a live station:
 * `test/integration/agency/station-script-facts-e2e.test.ts`.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import { closePool, initDbPool } from '@magick-agency/db';
import { AGENCY_COLLECTIONS_STARTER_CATALOG } from '@magick-agency/contracts/agency';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { insertAgencyCampaign } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

let app: FastifyInstance;
let w: { tenant: string; account: string; uid: string; userId: string };

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (token.startsWith('tok:')) return { uid: token.slice(4), email: `${token.slice(4)}@example.com`, email_verified: true };
    throw new Error('bad token');
  });
  app = await buildApp({ ctx: null });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  const tenant = await insertTenant();
  const account = await insertAccount({ tenant_id: tenant.id });
  const user = await insertUser({ display_name: 'Sam Supervisor' });
  await insertMembership({ user_id: user.id, tenant_id: tenant.id, account_id: account.id, role: 'account_admin' });
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenant.id],
  );
  w = { tenant: tenant.id, account: account.id, uid: user.firebase_uid, userId: user.id };
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

function headers(): Record<string, string> {
  return { authorization: `Bearer tok:${w.uid}`, 'x-tenant-id': w.tenant, 'x-account-id': w.account };
}

const patch = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/proxy/agency/campaigns/${id}`, headers: headers(), payload });
const read = (id: string) => app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${id}`, headers: headers() });

async function campaignAt(status: string, extra: Record<string, unknown> = {}): Promise<string> {
  const row = await insertAgencyCampaign({ tenant_id: w.tenant, account_id: w.account, status, ...extra });
  return row.id as string;
}

/** The two columns as STORED, read independently of any response. */
async function stored(id: string): Promise<{ agent_script: unknown; context_display: unknown }> {
  const { rows } = await getTestPool().query<{ agent_script: unknown; context_display: unknown }>(
    'SELECT agent_script, context_display FROM agency_campaigns WHERE id = $1', [id]);
  return rows[0]!;
}

/** A roster import of the campaign that kept these columns. */
async function importOf(campaignId: string, columns: string[], dryRun = false): Promise<void> {
  await getTestPool().query(
    `INSERT INTO agency_ingest_jobs (tenant_id, account_id, campaign_id, s3_key, file_name, phone_column, status, dry_run, context_columns)
     VALUES ($1, $2, $3, 'k/roster', 'roster.csv', 'phone', 'completed', $4, $5)`,
    [w.tenant, w.account, campaignId, dryRun, columns],
  );
}

async function configChangedFields(campaignId: string): Promise<unknown[]> {
  await platformAuditLogger.shutdown();
  const { rows } = await getTestPool().query<{ details: { fields: unknown } }>(
    `SELECT details FROM platform_audit_log
      WHERE action = 'agency_campaign.config_changed' AND campaign_id = $1 ORDER BY created_at`,
    [campaignId],
  );
  return rows.map((r) => r.details.fields);
}

const SCRIPT = {
  opening: '  Namaste {name}, I am {agent_name} from {campaign_name}.  ',
  steps: [{ text: 'Tell them {amount_due} is due on {due_date}. ' }, { text: 'Ask when they can pay.' }],
};
const SCRIPT_TRIMMED = {
  opening: 'Namaste {name}, I am {agent_name} from {campaign_name}.',
  steps: [{ text: 'Tell them {amount_due} is due on {due_date}.' }, { text: 'Ask when they can pay.' }],
};

describe('PATCH /proxy/agency/campaigns/:id — agent_script (BE-8)', () => {
  it('stores it trimmed on a running campaign, GET serves it, and the change is audited by name', async () => {
    const id = await campaignAt('running');
    expect((await read(id)).json().agent_script).toEqual({});

    const res = await patch(id, { agent_script: SCRIPT });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ agent_script: SCRIPT_TRIMMED, status: 'running' });
    expect((await stored(id)).agent_script).toEqual(SCRIPT_TRIMMED);
    expect((await read(id)).json().agent_script).toEqual(SCRIPT_TRIMMED);
    expect(await configChangedFields(id)).toEqual([['agent_script']]);
  });

  it('{} clears it', async () => {
    const id = await campaignAt('paused', { agent_script: JSON.stringify(SCRIPT_TRIMMED) });
    const res = await patch(id, { agent_script: {} });
    expect(res.statusCode, res.body).toBe(200);
    expect((await stored(id)).agent_script).toEqual({});
  });

  it.each([
    ['an unknown placeholder', { opening: 'Namaste {customer}' }, 'agent_script.opening',
      '{customer} is not a word the script can fill in. Use only: {name}, {place}, {amount_due}, {due_date}, {agent_name}, {campaign_name}.'],
    ['a placeholder in the wrong case, in a step', { steps: [{ text: 'Hi {Name}' }] }, 'agent_script.steps[0].text',
      '{Name} is not a word the script can fill in. Use only: {name}, {place}, {amount_due}, {due_date}, {agent_name}, {campaign_name}.'],
    ['thirteen steps', { steps: Array.from({ length: 13 }, () => ({ text: 'Ask.' })) }, 'agent_script.steps',
      'A script can have at most 12 steps.'],
    ['a step of 201 characters', { steps: [{ text: 'a'.repeat(201) }] }, 'agent_script.steps[0].text',
      'Step 1 must be 1 to 200 characters.'],
    ['not an object', 'Namaste', 'agent_script',
      'The script must have an opening line and steps. Leave both empty for no script.'],
  ])('refuses %s with a 400 naming the field, and writes nothing', async (_why, script, field, message) => {
    const id = await campaignAt('running', { agent_script: JSON.stringify(SCRIPT_TRIMMED) });
    const res = await patch(id, { agent_script: script });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details).toEqual({ [field]: message });
    expect((await stored(id)).agent_script).toEqual(SCRIPT_TRIMMED);
  });
});

describe('PATCH /proxy/agency/campaigns/:id — context_display.roles and .types (BE-6)', () => {
  const DISPLAY = {
    hero: ['Loan No', 'Amount Due', 'Due Date'],
    hidden: ['Aadhaar'],
    roles: { name: 'Customer Name', place: 'City', amount_due: 'Amount Due', due_date: 'Due Date' },
    types: { Limit: 'money' },
  };
  const COLUMNS = ['Customer Name', 'City', 'Loan No', 'Amount Due', 'Due Date', 'Limit', 'Aadhaar'];

  it('no import yet: stored and served after the shape check alone', async () => {
    const id = await campaignAt('draft');
    const res = await patch(id, { context_display: DISPLAY });
    expect(res.statusCode, res.body).toBe(200);
    expect((await stored(id)).context_display).toEqual(DISPLAY);
    expect((await read(id)).json().context_display).toEqual(DISPLAY);
  });

  it('with an import: names its columns ignoring case; a missing column is a 400 listing them', async () => {
    const id = await campaignAt('running');
    await importOf(id, COLUMNS);
    // A check (dry run) keeps columns that are not the roster's: never read.
    await importOf(id, ['Balance'], true);

    const ok = await patch(id, { context_display: { ...DISPLAY, roles: { amount_due: 'amount due' }, types: { LIMIT: 'money' } } });
    expect(ok.statusCode, ok.body).toBe(200);

    const refused = await patch(id, { context_display: { roles: { amount_due: 'Balance' }, types: { Opened: 'date' } } });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().details).toEqual({
      'context_display.roles.amount_due': `There is no column 'Balance' in this campaign's customer list, so it cannot be the amount due. The columns are: ${COLUMNS.join(', ')}.`,
      'context_display.types.Opened': `There is no column 'Opened' in this campaign's customer list, so it cannot be given a type. The columns are: ${COLUMNS.join(', ')}.`,
    });
    expect((await stored(id)).context_display).toMatchObject({ roles: { amount_due: 'amount due' } });
  });

  it('a retry campaign is checked against its lineage root\'s import', async () => {
    const root = await campaignAt('completed');
    await importOf(root, COLUMNS);
    const retry = await campaignAt('draft', { parent_campaign_id: root, root_campaign_id: root, retry_generation: 1 });
    expect((await patch(retry, { context_display: { roles: { due_date: 'Due Date' } } })).statusCode).toBe(200);
    const refused = await patch(retry, { context_display: { roles: { due_date: 'Next Due' } } });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(Object.keys(refused.json().details)).toEqual(['context_display.roles.due_date']);
  });

  it('refuses a hidden column as a role and a type that is not text, money or date (the public layer\'s shape rule)', async () => {
    const id = await campaignAt('draft');
    const res = await patch(id, { context_display: { hidden: ['Aadhaar'], roles: { name: 'aadhaar' }, types: { City: 'place' } } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details).toEqual({
      'context_display.roles.name': "'aadhaar' is hidden from agents, so it cannot be the customer's name. Show the column first.",
      'context_display.types.City': "Choose how to read 'City': as text, money or a date.",
    });
    expect((await stored(id)).context_display).toEqual({});
  });
});

describe('POST /proxy/agency/campaigns — the Collections starter set (AS4)', () => {
  it('creates a campaign whose outcomes are the starter set, as sent', async () => {
    const res = await app.inject({
      method: 'POST', url: '/proxy/agency/campaigns', headers: headers(),
      payload: { name: 'November dues', caller_ids: ['+919000000001'], disposition_catalog: AGENCY_COLLECTIONS_STARTER_CATALOG },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().disposition_catalog).toEqual(AGENCY_COLLECTIONS_STARTER_CATALOG);
    const { rows } = await getTestPool().query('SELECT disposition_catalog FROM agency_campaigns WHERE id = $1', [res.json().id]);
    expect(rows[0].disposition_catalog).toEqual(AGENCY_COLLECTIONS_STARTER_CATALOG);
  });
});
