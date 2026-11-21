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
 *    role; a retry campaign is checked against its lineage root's import, and a retry's
 *    `config_overrides.context_display` against its parent's (AS19 R4).
 *  - AS19 `context_display.facts`: stored and served, held to its rules and to the roster; the
 *    script's keys are the campaign's facts', judged against the resulting display both ways (a
 *    script key that is not a fact; a fact the stored script uses taken away) and as a pair when
 *    one write carries both, on a PATCH and on a create.
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
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
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
    // AS19 S13: a key in the wrong case is told how to write it.
    ['a placeholder in the wrong case, in a step', { steps: [{ text: 'Hi {Name}' }] }, 'agent_script.steps[0].text',
      'The script uses {Name}. Write it as {name}.'],
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
    // Stored in the roster's spelling (AS19 S9).
    expect((await stored(id)).context_display).toMatchObject({ roles: { amount_due: 'Amount Due' }, types: { LIMIT: 'money' } });
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

  it('a retry\'s config_overrides are checked against the parent\'s customer list, as a PATCH is (AS19 R4)', async () => {
    const parent = await campaignAt('completed');
    await importOf(parent, COLUMNS);
    await insertAgencyContact(parent, {
      tenant_id: w.tenant, account_id: w.account, phone_e164: '+919000000011',
      state: 'completed', last_outcome: 'no_answer', attempt_count: 1,
    });
    const retry = (overrides: Record<string, unknown>) => app.inject({
      method: 'POST', url: `/proxy/agency/campaigns/${parent}/retry`, headers: headers(),
      payload: { selector: { last_outcome: ['no_answer'] }, config_overrides: overrides },
    });
    const campaigns = async () => (await getTestPool().query(
      'SELECT count(*)::int AS n FROM agency_campaigns WHERE tenant_id = $1', [w.tenant])).rows[0].n as number;

    const refused = await retry({ context_display: { facts: [{ column: 'Region', label: 'Region', key: 'region' }] } });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().details).toEqual({
      'context_display.facts.0.column': `There is no column 'Region' in this campaign's customer list, so it cannot be a fact. The columns are: ${COLUMNS.join(', ')}.`,
    });
    expect(await campaigns()).toBe(1);

    const facts = [{ column: 'loan no', label: 'Loan', key: 'loan_no' }];
    const ok = await retry({ context_display: { facts } });
    expect(ok.statusCode, ok.body).toBe(201);
    // In the parent's roster's spelling (AS19 S9).
    expect((await stored((ok.json() as { campaign: { id: string } }).campaign.id)).context_display)
      .toEqual({ facts: [{ column: 'Loan No', label: 'Loan', key: 'loan_no' }] });
  });

  it('refuses a hidden column as a role and a type that is not one of the six (the public layer\'s shape rule)', async () => {
    const id = await campaignAt('draft');
    const res = await patch(id, { context_display: { hidden: ['Aadhaar'], roles: { name: 'aadhaar' }, types: { City: 'place' } } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details).toEqual({
      'context_display.roles.name': "'aadhaar' is hidden from agents, so it cannot be the customer's name. Show the column first.",
      'context_display.types.City': "Choose how to read 'City': as text, money, a number, a date, a phone number or yes / no.",
    });
    expect((await stored(id)).context_display).toEqual({});
  });
});

describe('PATCH /proxy/agency/campaigns/:id — the card\'s chosen facts and the script\'s keys (AS19)', () => {
  const COLUMNS = ['Customer Name', 'City', 'Amount Due', 'Due Date', 'Branch', 'Tenure'];
  const FACTS = {
    roles: { name: 'Customer Name', place: 'City' },
    types: { 'Amount Due': 'money', 'Due Date': 'date', Tenure: 'number' },
    facts: [
      { column: 'Amount Due', label: 'Amount due', key: 'amount_due', highlight: true },
      { column: 'Due Date', label: 'Due on', key: 'due_date' },
      { column: 'Branch', label: 'Branch', key: 'branch' },
    ],
  };
  const withoutKey = (key: string) => ({ ...FACTS, facts: FACTS.facts.filter((f) => f.key !== key) });
  const USES_DUE_DATE = { opening: 'Namaste {name}.', steps: [{ text: 'Pay {amount_due} by {due_date}.' }] };

  it('stores the facts and the six types, and serves them; checked against the roster once there is one', async () => {
    const id = await campaignAt('running');
    await importOf(id, COLUMNS);
    const display = { ...FACTS, types: { ...FACTS.types, Branch: 'phone', City: 'text' } };
    const ok = await patch(id, { context_display: display });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await stored(id)).context_display).toEqual(display);
    expect((await read(id)).json().context_display).toEqual(display);

    const refused = await patch(id, { context_display: { ...FACTS, facts: [...FACTS.facts, { column: 'Region', label: 'Region', key: 'region' }] } });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().details).toEqual({
      'context_display.facts.3.column': `There is no column 'Region' in this campaign's customer list, so it cannot be a fact. The columns are: ${COLUMNS.join(', ')}.`,
    });
    expect((await stored(id)).context_display).toEqual(display);
  });

  it('S9: a role or a fact written in another case is stored in the roster\'s spelling, so the own-contacts list\'s exact match finds it', async () => {
    const id = await campaignAt('running');
    await importOf(id, COLUMNS);
    const ok = await patch(id, { context_display: {
      ...FACTS,
      roles: { name: 'CUSTOMER NAME', place: 'city' },
      facts: [{ column: 'amount due', label: 'Amount due', key: 'amount_due' }, { column: 'BRANCH', label: 'Branch', key: 'branch' }],
    } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await stored(id)).context_display).toMatchObject({
      roles: { name: 'Customer Name', place: 'City' },
      facts: [{ column: 'Amount Due', label: 'Amount due', key: 'amount_due' }, { column: 'Branch', label: 'Branch', key: 'branch' }],
    });
    expect((await read(id)).json().context_display.facts.map((f: { column: string }) => f.column)).toEqual(['Amount Due', 'Branch']);
  });

  it('S3(e): the name or the line under it may not be a phone-typed column, and nothing is written', async () => {
    const id = await campaignAt('draft');
    const res = await patch(id, { context_display: { roles: { name: 'Mobile 2', place: 'Alt' }, types: { 'Mobile 2': 'phone', alt: 'phone' }, facts: [] } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details).toEqual({
      'context_display.roles.name': "A phone number cannot be the customer's name. Add it as a fact instead.",
      'context_display.roles.place': 'A phone number cannot be the line under the name. Add it as a fact instead.',
    });
    expect((await stored(id)).context_display).toEqual({});
  });

  it('refuses a fifth fact, a long name and a repeated name, each on its own path, and writes nothing', async () => {
    const id = await campaignAt('draft');
    const five = ['A', 'B', 'C', 'D', 'E'].map((c) => ({ column: c, label: c, key: c.toLowerCase() }));
    const res = await patch(id, { context_display: { facts: five } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details).toEqual({ 'context_display.facts': 'You can show 4 facts at most. Remove one to add another.' });

    const names = await patch(id, { context_display: { facts: [
      { column: 'A', label: 'Outstanding amount', key: 'a' },
      { column: 'B', label: 'Due', key: 'b' },
      { column: 'C', label: 'due', key: 'c' },
    ] } });
    expect(names.statusCode, names.body).toBe(400);
    expect(names.json().details).toEqual({
      'context_display.facts.0.label': "A fact's name can be 16 letters at most.",
      'context_display.facts.2.label': 'Two facts cannot have the same name.',
    });
    expect((await stored(id)).context_display).toEqual({});
  });

  it('the script: a key that is not a fact on the campaign\'s card is refused, naming it; a fact\'s key is accepted', async () => {
    const id = await campaignAt('running', { context_display: JSON.stringify(withoutKey('branch')) });
    const refused = await patch(id, { agent_script: { opening: 'Namaste {name} from {branch}.' } });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().details).toEqual({
      'agent_script.opening': 'The script uses {branch}, which is not a fact on the card. Add it as a fact or take it out.',
    });
    expect((await stored(id)).agent_script).toEqual({});

    const other = await campaignAt('running', { context_display: JSON.stringify(FACTS) });
    const ok = await patch(other, { agent_script: { opening: 'Namaste {name} from {branch}.' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await stored(other)).agent_script).toEqual({ opening: 'Namaste {name} from {branch}.' });
  });

  it('the card: taking away a fact the stored script uses is refused on context_display.facts; one it does not use may go', async () => {
    const id = await campaignAt('running', { context_display: JSON.stringify(FACTS), agent_script: JSON.stringify(USES_DUE_DATE) });
    const refused = await patch(id, { context_display: withoutKey('due_date') });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().details).toEqual({
      'context_display.facts': 'The script uses {due_date}. Take it out of the script first, or keep the fact.',
    });
    expect((await stored(id)).context_display).toEqual(FACTS);

    const ok = await patch(id, { context_display: withoutKey('branch') });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await stored(id)).context_display).toEqual(withoutKey('branch'));
  });

  it('a write carrying both is checked as the pair', async () => {
    const id = await campaignAt('running', { context_display: JSON.stringify(FACTS), agent_script: JSON.stringify(USES_DUE_DATE) });
    // The fact goes and the script stops using it, in one write: accepted.
    const pair = { context_display: withoutKey('due_date'), agent_script: { opening: 'Namaste {name}.', steps: [{ text: 'Pay {amount_due}.' }] } };
    const ok = await patch(id, pair);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await stored(id)).toEqual(pair);

    // The fact goes and the new script still uses it: refused on the script, nothing written.
    const refused = await patch(id, { context_display: withoutKey('branch'), agent_script: { opening: 'From {branch}.' } });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().details).toEqual({
      'agent_script.opening': 'The script uses {branch}, which is not a fact on the card. Add it as a fact or take it out.',
    });
    expect(await stored(id)).toEqual(pair);
  });

  it('a campaign set up before AS19 moves to facts: its {amount_due} must come along as a fact', async () => {
    const legacy = { roles: { name: 'Customer Name', amount_due: 'Amount Due' }, hero: ['Due Date'] };
    const id = await campaignAt('running', { context_display: JSON.stringify(legacy), agent_script: JSON.stringify(USES_DUE_DATE) });
    const dropped = await patch(id, { context_display: withoutKey('amount_due') });
    expect(dropped.statusCode, dropped.body).toBe(400);
    expect(dropped.json().details).toEqual({
      'context_display.facts': 'The script uses {amount_due}. Take it out of the script first, or keep the fact.',
    });
    const kept = await patch(id, { context_display: FACTS });
    expect(kept.statusCode, kept.body).toBe(200);
    expect((await stored(id)).context_display).toEqual(FACTS);
  });

  it('a create carrying both is checked as the pair', async () => {
    const create = (payload: Record<string, unknown>) => app.inject({
      method: 'POST', url: '/proxy/agency/campaigns', headers: headers(),
      payload: { name: 'Chosen facts', caller_ids: ['+919000000001'], ...payload },
    });
    const ok = await create({ context_display: FACTS, agent_script: { opening: 'From {branch}.' } });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await stored(ok.json().id)).toEqual({ context_display: FACTS, agent_script: { opening: 'From {branch}.' } });
    // No facts: the legacy keys, and their wording.
    const refused = await create({ agent_script: { opening: 'From {branch}.' } });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().details).toEqual({
      'agent_script.opening': '{branch} is not a word the script can fill in. Use only: {name}, {place}, {amount_due}, {due_date}, {agent_name}, {campaign_name}.',
    });
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
