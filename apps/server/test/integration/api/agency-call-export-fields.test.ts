import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Export with fields (`docs/call-log.md` §10, CL43–CL52) on real Postgres, through the real app:
 * the field list's set-based read (`callExportFieldsForCampaign`), the call log read's extras
 * (`include=analysis,call_fields`), and the campaign call export with `fields`, the analytics
 * setting on and off, checked cell by cell.
 *
 * The seed is one campaign holding every call type, its media legs analysed in both shapes:
 *
 *  - d1: a dial, the current shape, analysed with profile version V1 (oldest);
 *  - d2: a dial, the legacy flat shape, analysed with V2 (`amount` changed type, a new key);
 *  - d3: a dial whose leg id is ANOTHER TENANT's call, analysed, with a job: never read;
 *  - d4: a dial whose leg id is a SIBLING ACCOUNT's call (same tenant): never read;
 *  - d5: a dial that never placed a leg;
 *  - d6: a dial whose analysis was erased (`deleted`), its old result still in the row;
 *  - s1: a soft-phone call, analysed (a key only in its stored result, no job), with details;
 *  - s2: a soft-phone call that never dialled, with details, awaiting its outcome;
 *  - i1: an inbound call, its analysis pending;
 *  - i2: an inbound call, analysed with the inbound route's profile V3 (newest).
 *
 * Plus the plan of the field list's statement: the legs by `agency_calls`' primary key and the
 * jobs by `uq_dialer_analysis_jobs_call`.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'call-export-fields-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertAccount } from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { getPool } from '@magick-agency/db';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { call, seedFloor, startLoadApp, stopLoadApp, verifyTestToken, type LoadApp, type TenantFloor } from '../load/load-harness.js';
import { insertInboundCall } from '../../helpers/call-log-seed.js';
import { ATTEMPT_CSV_COLUMNS } from '../../../src/agency/agency-spine.js';
import { agencyAttemptRepository } from '../../../src/db/repositories/agency.repository.js';
import { hasCellValueSql } from '../../../src/db/repositories/agency/attempt.repository.js';
import { callExportHasValue } from '../../../src/agency/call-export-fields.js';
import type { AgencyCallExportFieldsResponse } from '@magick-agency/contracts/api/agency/call-export-fields';

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
let siblingAccount: string;
let campaignId: string;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const MIN = 60_000;
const BASE = new Date(Math.floor((Date.now() - 3 * 60 * MIN) / MIN) * MIN);
const at = (minutes: number) => new Date(BASE.getTime() + minutes * MIN);

/** Row ids and leg ids by label. */
const id = new Map<string, string>();
const leg = new Map<string, string>();

const V1 = [
  { key: 'promise_strength', type: 'enum', options: ['strong', 'weak'], description: 'How firm (v1)' },
  { key: 'amount', type: 'number', description: 'Amount promised (v1)' },
  { key: 'Bad-Key', type: 'string', description: 'never offered' },
];
const V2 = [
  { key: 'promise_strength', type: 'enum', options: ['weak', 'none'], description: 'How firm (v2)' },
  { key: 'amount', type: 'string', description: 'Amount promised (v2)' },
  { key: 'new_dim', type: 'boolean', description: 'New in v2' },
];
const V3 = [{ key: 'promise_strength', type: 'enum', options: ['strong', 'maybe'], description: 'How firm (inbound route)' }];

/** An `agency_calls` row (a media leg) with its analysis; and its analysis job when `snapshot` is given. */
async function mediaLeg(label: string, o: {
  tenant?: string; account?: string; status: string | null; result?: unknown; snapshot?: unknown[]; jobAt?: Date;
}): Promise<string> {
  const legId = randomUUID();
  const tenant = o.tenant ?? floor.tenant;
  const account = o.account ?? floor.account;
  await q(
    `INSERT INTO agency_calls (id, tenant_id, account_id, caller_id, destination_phone, analysis_status, call_analysis)
     VALUES ($1, $2, $3, '+919000000001', '+919800000000', $4, $5::jsonb)`,
    [legId, tenant, account, o.status, o.result === undefined ? null : JSON.stringify(o.result)]);
  if (o.snapshot) {
    await q(
      `INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id, profile_snapshot, status, created_at)
       VALUES ($1, $2, $3, $4::jsonb, 'completed', $5)`,
      [legId, tenant, account, JSON.stringify({ custom_dimensions: o.snapshot }), o.jobAt ?? at(0)]);
  }
  leg.set(label, legId);
  return legId;
}

async function setAnalytics(on: boolean): Promise<void> {
  await q(
    `INSERT INTO account_settings (tenant_id, account_id, allow_recording, analyze_calls, max_concurrent_calls)
     VALUES ($1, $2, true, $3, 20)
     ON CONFLICT (tenant_id, account_id) DO UPDATE SET analyze_calls = EXCLUDED.analyze_calls`,
    [floor.tenant, floor.account, on]);
  accountSettingsRepository.invalidate(floor.tenant, floor.account);
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = await seedFloor({ tenants: 2, agentsPerTenant: 1, supervisorsPerTenant: 1, campaignsPerTenant: 1 }) as [TenantFloor, TenantFloor];
  campaignId = floor.campaigns[0]!;
  siblingAccount = (await insertAccount({ tenant_id: floor.tenant })).id as string;
  await setAnalytics(true);

  // ── The legs. ──
  await mediaLeg('d1', {
    status: 'completed', snapshot: V1, jobAt: at(1),
    result: {
      common: { summary: '=HYPERLINK("http://evil","click")', key_topics: ['emi', 'waiver'], overall_sentiment: { label: 'positive', score: 0.8 } },
      custom: { promise_strength: 'strong', amount: 5000, 'Bad-Key': 'x' },
    },
  });
  await mediaLeg('d2', {
    status: 'completed', snapshot: V2, jobAt: at(2),
    result: {
      summary: 'Legacy summary,\nsecond line', key_topics: [], overall_sentiment: { label: 'negative', score: -0.4 },
      custom_dimensions: { promise_strength: 'weak', amount: '5,000', new_dim: false },
    },
  });
  await mediaLeg('d3', {
    tenant: other.tenant, account: other.account, status: 'completed', snapshot: [{ key: 'leak_snap', type: 'string', description: 'LEAK' }],
    result: { common: { summary: 'LEAK other tenant' }, custom: { leak_dim: 'LEAK' } },
  });
  await mediaLeg('d4', {
    account: siblingAccount, status: 'completed', snapshot: [{ key: 'leak_sibling_snap', type: 'string', description: 'LEAK' }],
    result: { common: { summary: 'LEAK sibling account' }, custom: { leak_sibling: 'LEAK' } },
  });
  await mediaLeg('d6', { status: 'deleted', result: { common: { summary: 'ERASED' }, custom: { erased_dim: 'gone' } } });
  await mediaLeg('s1', { status: 'completed', result: { common: { summary: 'Soft summary' }, custom: { stored_only: 'abc' } } });
  await mediaLeg('i1', { status: 'pending' });
  await mediaLeg('i2', { status: 'completed', snapshot: V3, jobAt: at(3), result: { custom: { promise_strength: 'strong' } } });

  // ── The dialler. ──
  const contact = async (phone: string) => (await q(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, 'completed') RETURNING id`, [campaignId, floor.tenant, floor.account, phone])).rows[0].id as string;
  const attempt = async (label: string, minute: number, legId: string | null) => {
    const { rows: [row] } = await q(
      `INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id,
              state, outcome, webrtc_call_id, dialed_at, ended_at, created_at)
       VALUES ($1, $2, $3, $4, 1, '+919000000001', 'ended', 'connected', $5, $6, $6, $6) RETURNING id`,
      [campaignId, await contact(`+9197000000${String(minute).padStart(2, '0')}`), floor.tenant, floor.account, legId, at(minute)]);
    id.set(label, row.id as string);
  };
  await attempt('d1', 10, leg.get('d1')!);
  await attempt('d2', 11, leg.get('d2')!);
  await attempt('d3', 12, leg.get('d3')!);
  await attempt('d4', 13, leg.get('d4')!);
  await attempt('d5', 14, null);
  await attempt('d6', 15, leg.get('d6')!);

  // ── The soft phone. ──
  await q(
    `INSERT INTO agency_softphone_settings (tenant_id, account_id, call_fields) VALUES ($1, $2, $3::jsonb)`,
    [floor.tenant, floor.account, JSON.stringify([
      { key: 'loan_no', label: 'Loan number', type: 'text' },
      { key: 'visited', label: 'Visited', type: 'boolean' },
    ])]);
  const { rows: [session] } = await q(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, kind, joined_at, left_at)
     VALUES ($1, $2, NULL, $3, 'offline', 'softphone', $4, $5) RETURNING id`, [floor.tenant, floor.account, floor.agents[0]!.id, at(0), at(170)]);
  const manual = async (label: string, minute: number, o: { leg: string | null; fields: Record<string, unknown>; settled: boolean }) => {
    const created = at(minute);
    const { rows: [row] } = await q(
      `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, campaign_id, destination_e164, caller_id,
              state, outcome, webrtc_call_id, dialed_at, ended_at, settled_at, created_at, fields)
       VALUES ($1, $2, $3, $4, $5, '+919811000040', '+919000000002', 'ended', $6, $7, $8, $10, $9, $10, $11::jsonb) RETURNING id`,
      [floor.tenant, floor.account, session.id, floor.agents[0]!.id, campaignId, o.leg ? 'connected' : 'failed', o.leg,
        o.leg ? created : null, o.settled ? created : null, created, JSON.stringify(o.fields)]);
    id.set(label, row.id as string);
  };
  await manual('s1', 20, { leg: leg.get('s1')!, settled: true, fields: { loan_no: 'LN-1', visited: true, empty_one: '', removed_field: 'r', constructor: null } });
  await manual('s2', 21, { leg: null, settled: false, fields: { loan_no: '=cmd|"/c calc"!A1' } });

  // ── Inbound. ──
  for (const [label, minute] of [['i1', 30], ['i2', 31]] as const) {
    id.set(label, await insertInboundCall(label, {
      tenantId: floor.tenant, accountId: floor.account, campaign: campaignId, from: `+9198000000${minute}`, to: '+919000000009',
      arrived: at(minute), bridgedAfter: 5, answeredBy: floor.agents[0]!.id, endedAfter: 60, talk: 55, webrtcCallId: leg.get(label)!,
    }));
  }
}, 180_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

const supervisor = () => floor.supervisors[0]!;
const get = (path: string) => call(loaded.app, 'GET', path, supervisor(), floor);
const fieldList = async (query = ''): Promise<AgencyCallExportFieldsResponse> => {
  const res = await get(`/proxy/agency/campaigns/${campaignId}/call-log/export-fields${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AgencyCallExportFieldsResponse;
};

/** RFC 4180 records of a preamble-less body. */
function parseCsv(body: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { record.push(cell); cell = ''; } else if (c === '\n') { record.push(cell); records.push(record); record = []; cell = ''; } else cell += c;
  }
  return records;
}

/** The export's rows as objects by column, keyed by the row's label. */
async function exportRows(fields: string, extra = ''): Promise<{ header: string[]; rows: Map<string, Record<string, string>>; res: Awaited<ReturnType<typeof get>> }> {
  const res = await get(`/proxy/agency/campaigns/${campaignId}/attempts.csv?preamble=false&fields=${encodeURIComponent(fields)}${extra}`);
  expect(res.statusCode, res.body).toBe(200);
  const [header, ...records] = parseCsv(res.body);
  const label = (rowId: string) => [...id.entries()].find(([, v]) => v === rowId)?.[0] ?? rowId;
  return {
    header: header!,
    rows: new Map(records.map((r) => [label(r[0]!), Object.fromEntries(header!.map((h, i) => [h, r[i]!]))])),
    res,
  };
}

describe('the field list (export-fields) over every call type, both shapes', () => {
  it('counts every listed row, a soft-phone call that never dialled included', async () => {
    const list = await fieldList();
    expect(list.calls).toBe(10);
    expect(list.analysis_available).toBe(true);
    expect(list.analysed).toBe(4);
    expect(list.row_limit).toBe(50_000);
    expect(list.ai_row_limit).toBe(20_000);
  });

  it('the analysis fields\' counts read the current and the legacy shape; an empty list and an erased result count none', async () => {
    expect((await fieldList()).analysis).toEqual([
      { name: 'analysis_status', calls: 10 },
      { name: 'ai_summary', calls: 3 },
      { name: 'ai_sentiment', calls: 2 },
      { name: 'ai_sentiment_score', calls: 2 },
      { name: 'ai_key_topics', calls: 1 },
    ]);
  });

  it('the dimensions: every version\'s keys and every stored key, merged per key (CL45)', async () => {
    expect((await fieldList()).dimensions).toEqual([
      {
        name: 'dim_promise_strength', key: 'promise_strength', types: ['enum'],
        options: ['strong', 'weak', 'none', 'maybe'], description: 'How firm (inbound route)', calls: 3, sources: ['dialler', 'inbound'],
      },
      // The type changed between versions: both, oldest first; the newest description.
      { name: 'dim_amount', key: 'amount', types: ['number', 'string'], options: [], description: 'Amount promised (v2)', calls: 2, sources: ['dialler'] },
      // `false` is a value.
      { name: 'dim_new_dim', key: 'new_dim', types: ['boolean'], options: [], description: 'New in v2', calls: 1, sources: ['dialler'] },
      // Only in a stored result: no type, no description.
      { name: 'dim_stored_only', key: 'stored_only', types: [], options: [], description: null, calls: 1, sources: ['soft_phone'] },
    ]);
  });

  it('never reads another tenant\'s or another account\'s leg, its job or its result, nor an erased one', async () => {
    const body = JSON.stringify(await fieldList());
    for (const leaked of ['leak_dim', 'leak_snap', 'leak_sibling', 'leak_sibling_snap', 'erased_dim', 'Bad-Key', 'LEAK']) {
      expect(body, leaked).not.toContain(leaked);
    }
  });

  it('the call details: keys with a value, labelled from the settings as they are now, a removed one null', async () => {
    expect((await fieldList()).call_fields).toEqual([
      { name: 'field_loan_no', key: 'loan_no', label: 'Loan number', type: 'text', calls: 2 },
      { name: 'field_removed_field', key: 'removed_field', label: null, type: null, calls: 1 },
      { name: 'field_visited', key: 'visited', label: 'Visited', type: 'boolean', calls: 1 },
    ]);
  });

  it('follows the export\'s source, status and filters', async () => {
    const dialler = await fieldList('?source=dialler');
    expect(dialler.calls).toBe(6);
    expect(dialler.analysed).toBe(2);
    expect(dialler.call_fields).toEqual([]);
    expect(dialler.dimensions.find((d) => d.key === 'promise_strength')).toMatchObject({
      options: ['strong', 'weak', 'none'], description: 'How firm (v2)', calls: 2, sources: ['dialler'],
    });
    expect(dialler.dimensions.map((d) => d.key)).not.toContain('stored_only');

    const settled = await fieldList('?status=settled');
    expect(settled.calls).toBe(1);
    expect(settled.call_fields.map((f) => [f.key, f.calls])).toEqual([['loan_no', 1], ['removed_field', 1], ['visited', 1]]);
    expect(settled.dimensions.map((d) => d.key)).toEqual(['stored_only']);

    const inbound = await fieldList('?source=inbound');
    expect(inbound).toMatchObject({ calls: 2, analysed: 1 });

    const window = await fieldList(`?from=${encodeURIComponent(at(10).toISOString())}&to=${encodeURIComponent(at(11).toISOString())}`);
    expect(window.calls).toBe(2);
  });

  it('without the analytics setting: the analysis groups are not offered; the call details still are', async () => {
    await setAnalytics(false);
    try {
      const list = await fieldList();
      expect(list).toMatchObject({ calls: 10, analysis_available: false, analysed: null, analysis: [], dimensions: [] });
      expect(list.call_fields).toHaveLength(3);
    } finally {
      await setAnalytics(true);
    }
  });
});

describe('the call log read\'s extras (include)', () => {
  it('the legs lookup is scoped to the tenant and the account: another\'s leg id answers nothing', async () => {
    const legs = await agencyAttemptRepository.callExportLegAnalyses(floor.tenant, floor.account, [...leg.values()], { withResult: true });
    expect([...legs.keys()].sort()).toEqual(['d1', 'd2', 'd6', 's1', 'i1', 'i2'].map((l) => leg.get(l)!).sort());
    // The status alone: no stored result is read.
    const statuses = await agencyAttemptRepository.callExportLegAnalyses(floor.tenant, floor.account, [...leg.values()], { withResult: false });
    expect([...statuses.keys()].sort()).toEqual([...legs.keys()].sort());
    for (const [legId, analysis] of statuses) {
      expect(analysis).toEqual({ analysis_status: legs.get(legId)!.analysis_status, result: null });
    }
    const fields = await agencyAttemptRepository.callExportCallFields(other.tenant, other.account, [id.get('s1')!, id.get('s2')!]);
    expect(fields.size).toBe(0);
  });

  it('projects only what the fields read: the current shape first, else the legacy one; an erased leg has none', async () => {
    const legs = await agencyAttemptRepository.callExportLegAnalyses(floor.tenant, floor.account, [...leg.values()], { withResult: true });
    const empty = { ai_summary: null, ai_sentiment: null, ai_sentiment_score: null, ai_key_topics: null, custom: null, custom_dimensions: null };
    expect(legs.get(leg.get('d1')!)).toEqual({
      analysis_status: 'completed',
      result: {
        ...empty, ai_summary: '=HYPERLINK("http://evil","click")', ai_sentiment: 'positive', ai_sentiment_score: 0.8,
        ai_key_topics: ['emi', 'waiver'], custom: { promise_strength: 'strong', amount: 5000, 'Bad-Key': 'x' },
      },
    });
    expect(legs.get(leg.get('d2')!)).toEqual({
      analysis_status: 'completed',
      result: {
        ...empty, ai_summary: 'Legacy summary,\nsecond line', ai_sentiment: 'negative', ai_sentiment_score: -0.4, ai_key_topics: [],
        custom_dimensions: { promise_strength: 'weak', amount: '5,000', new_dim: false },
      },
    });
    expect(legs.get(leg.get('d6')!)).toEqual({ analysis_status: 'deleted', result: empty });
    expect(legs.get(leg.get('i1')!)).toEqual({ analysis_status: 'pending', result: empty });
  });

  it('with both shapes in one result, a common field the current shape has no value for falls back', async () => {
    const [mixed] = (await q(
      `INSERT INTO agency_calls (tenant_id, account_id, caller_id, destination_phone, analysis_status, call_analysis)
       VALUES ($1, $2, '+919000000001', '+919800000000', 'completed', $3::jsonb) RETURNING id`,
      [floor.tenant, floor.account, JSON.stringify({
        common: { summary: null, key_topics: ['now'] }, summary: 'old', key_topics: ['old'], overall_sentiment: { label: 'neutral' },
        custom: 'not an object', custom_dimensions: { a: 1 },
      })],
    )).rows as Array<{ id: string }>;
    try {
      const legs = await agencyAttemptRepository.callExportLegAnalyses(floor.tenant, floor.account, [mixed!.id], { withResult: true });
      expect(legs.get(mixed!.id)!.result).toEqual({
        ai_summary: 'old', ai_sentiment: 'neutral', ai_sentiment_score: null, ai_key_topics: ['now'], custom: null, custom_dimensions: { a: 1 },
      });
    } finally {
      await q('DELETE FROM agency_calls WHERE id = $1', [mixed!.id]);
    }
  });
});

describe('the preamble\'s descriptions read (callExportDimensionDescriptions)', () => {
  const read = (keys: string[], extra: Partial<Parameters<typeof agencyAttemptRepository.callExportDimensionDescriptions>[0]> = {}) =>
    agencyAttemptRepository.callExportDimensionDescriptions({
      campaignId, tenantId: floor.tenant, accountId: floor.account, filters: {}, source: null, keys, ...extra,
    });

  it('answers the chosen keys\' newest descriptions as the field list does, and nothing else', async () => {
    const list = await fieldList();
    const keys = ['promise_strength', 'amount', 'stored_only', 'leak_snap', 'leak_sibling_snap'];
    expect(await read(keys)).toEqual(new Map(list.dimensions
      .filter((d) => keys.includes(d.key) && d.description !== null)
      .map((d) => [d.key, d.description])));
    expect((await read(['promise_strength'])).get('promise_strength')).toBe('How firm (inbound route)');
    expect(await read([])).toEqual(new Map());
  });

  it('follows the export\'s filters', async () => {
    expect(await read(['promise_strength'], { source: 'dialler' })).toEqual(new Map([['promise_strength', 'How firm (v2)']]));
    expect(await read(['promise_strength'], { source: 'soft_phone' })).toEqual(new Map());
  });

  it('reads the jobs\' dimension copies alone: never a result', async () => {
    const pool = getPool();
    const spy = vi.spyOn(pool, 'query');
    try {
      await read(['promise_strength']);
      const [text] = spy.mock.calls.at(-1)! as unknown as [string];
      expect(text).not.toContain('call_analysis');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the export with fields, end to end', () => {
  const ALL = 'analysis_status,ai_summary,ai_sentiment,ai_sentiment_score,ai_key_topics,dim_promise_strength,dim_amount,dim_new_dim,field_loan_no,field_visited,field_constructor';

  it('writes today\'s columns, then the chosen ones, with the real values of every row', async () => {
    const { header, rows, res } = await exportRows(ALL);
    expect(header).toEqual([...ATTEMPT_CSV_COLUMNS, ...ALL.split(',')]);
    expect(res.headers['x-export-rows']).toBe('10');
    const pick = (label: string) => Object.fromEntries(ALL.split(',').map((f) => [f, rows.get(label)![f]]));
    expect(pick('d1')).toEqual({
      analysis_status: 'completed', ai_summary: '\'=HYPERLINK("http://evil","click")', ai_sentiment: 'positive', ai_sentiment_score: '0.8',
      ai_key_topics: 'emi; waiver', dim_promise_strength: 'strong', dim_amount: '5000', dim_new_dim: '', field_loan_no: '', field_visited: '', field_constructor: '',
    });
    expect(pick('d2')).toMatchObject({
      // A negative score is a JSON number, written as a number: no formula guard (CL49).
      analysis_status: 'completed', ai_summary: 'Legacy summary,\nsecond line', ai_sentiment: 'negative', ai_sentiment_score: '-0.4',
      ai_key_topics: '', dim_promise_strength: 'weak', dim_amount: '5,000', dim_new_dim: 'false',
    });
    // Another tenant's and another account's leg: as if there were none.
    for (const label of ['d3', 'd4', 'd5']) {
      expect(pick(label), label).toMatchObject({ analysis_status: 'none', ai_summary: '', dim_promise_strength: '' });
    }
    expect(pick('d6')).toMatchObject({ analysis_status: 'deleted', ai_summary: '' });
    expect(pick('s1')).toMatchObject({ analysis_status: 'completed', ai_summary: 'Soft summary', field_loan_no: 'LN-1', field_visited: 'true', field_constructor: '' });
    expect(pick('s2')).toMatchObject({ analysis_status: 'none', field_loan_no: '\'=cmd|"/c calc"!A1' });
    expect(pick('i1')).toMatchObject({ analysis_status: 'pending', ai_summary: '' });
    expect(pick('i2')).toMatchObject({ analysis_status: 'completed', dim_promise_strength: 'strong' });
    expect(res.body).not.toContain('LEAK');
    expect(res.body).not.toContain('ERASED');
  });

  it('the preamble carries the dimension descriptions read with the file\'s own filters, and the ceiling', async () => {
    const res = await get(`/proxy/agency/campaigns/${campaignId}/attempts.csv?source=dialler&fields=dim_promise_strength,dim_amount`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-export-rows']).toBe('6');
    expect(res.body).toContain('# dim_promise_strength: How firm (v2)\n');
    expect(res.body).toContain('# dim_amount: Amount promised (v2)\n');
    expect(res.body).toContain('Row ceiling: 20,000 rows');
  });

  it('without the analytics setting: analysis and dimension fields are refused 403, call details still export', async () => {
    await setAnalytics(false);
    try {
      for (const fields of ['ai_summary', 'analysis_status', 'dim_amount,field_loan_no']) {
        const res = await get(`/proxy/agency/campaigns/${campaignId}/attempts.csv?fields=${fields}`);
        expect(res.statusCode, fields).toBe(403);
        expect(res.json().code).toBe('export_fields_not_permitted');
      }
      const { rows } = await exportRows('field_loan_no');
      expect(rows.get('s1')!['field_loan_no']).toBe('LN-1');
    } finally {
      await setAnalytics(true);
    }
  });

  it('analysis_status alone: the right status on every row, read without the stored result', async () => {
    const spy = vi.spyOn(agencyAttemptRepository, 'callExportLegAnalyses');
    try {
      const { rows } = await exportRows('analysis_status');
      expect(Object.fromEntries([...rows].map(([label, row]) => [label, row['analysis_status']]))).toEqual({
        d1: 'completed', d2: 'completed', d3: 'none', d4: 'none', d5: 'none', d6: 'deleted',
        s1: 'completed', s2: 'none', i1: 'pending', i2: 'completed',
      });
      expect(spy).toHaveBeenCalled();
      for (const args of spy.mock.calls) expect(args[3]).toEqual({ withResult: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('a bad field is refused 400 before anything is read', async () => {
    const res = await get(`/proxy/agency/campaigns/${campaignId}/attempts.csv?fields=transcript`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'export_fields_invalid', details: { invalid: ['transcript'] } });
  });

  it('another tenant\'s supervisor cannot read this campaign\'s field list', async () => {
    const res = await call(loaded.app, 'GET', `/proxy/agency/campaigns/${campaignId}/call-log/export-fields`, other.supervisors[0]!, other);
    expect(res.statusCode).toBe(404);
  });
});

describe('the field list\'s statement: legs by primary key, jobs by their unique call', () => {
  it('plans agency_calls on its primary key and dialer_analysis_jobs on uq_dialer_analysis_jobs_call', async () => {
    // Many other calls and jobs of the account, so the planner has a reason to choose.
    await q(
      `INSERT INTO agency_calls (tenant_id, account_id, caller_id, destination_phone, analysis_status, call_analysis)
       SELECT $1, $2, '+919000000001', '+919800000000', 'completed', '{"custom":{"x":1}}'::jsonb FROM generate_series(1, 20000)`,
      [floor.tenant, floor.account]);
    await q(
      `INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id, profile_snapshot, status)
       SELECT id, tenant_id, account_id, '{"custom_dimensions":[{"key":"x","type":"number","description":"x"}]}'::jsonb, 'completed'
         FROM agency_calls c WHERE NOT EXISTS (SELECT 1 FROM dialer_analysis_jobs j WHERE j.call_id = c.id)`);
    await q('ANALYZE agency_calls');
    await q('ANALYZE dialer_analysis_jobs');
    const pool = getPool();
    const spy = vi.spyOn(pool, 'query');
    let statement: { text: string; values: unknown[] };
    try {
      await agencyAttemptRepository.callExportFieldsForCampaign({
        campaignId, tenantId: floor.tenant, accountId: floor.account, filters: {}, source: null, includeAnalysis: true,
      });
      const [text, values] = spy.mock.calls.at(-1)! as unknown as [string, unknown[]];
      statement = { text, values };
    } finally {
      spy.mockRestore();
    }
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement.text}`, statement.values);
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/Index Scan using agency_calls_pkey on agency_calls c/);
    expect(plan).not.toMatch(/Seq Scan on agency_calls/);
    expect(plan).toContain('uq_dialer_analysis_jobs_call');
    expect(plan).not.toMatch(/Seq Scan on dialer_analysis_jobs/);
    // The materialised CTEs carry only the paths read: never a whole `call_analysis` or
    // `profile_snapshot` (each node's Output is what its tuplestore holds).
    const verbose = (await getTestPool().query<{ 'QUERY PLAN': string }>(`EXPLAIN (VERBOSE) ${statement.text}`, statement.values))
      .rows.map((row) => row['QUERY PLAN']);
    for (const cte of ['CTE legs', 'CTE snapshots']) {
      const start = verbose.findIndex((line) => line.trim() === cte);
      expect(start, cte).toBeGreaterThanOrEqual(0);
      const output = verbose.slice(start + 1).find((line) => line.trim().startsWith('Output:'))!;
      const rest = output.replace(`(j.profile_snapshot -> 'custom_dimensions'::text)`, '');
      expect(rest, cte).not.toContain('call_analysis');
      expect(rest, cte).not.toContain('profile_snapshot');
    }
    // The answer is unchanged by the other calls: none of them is listed.
    expect((await fieldList()).calls).toBe(10);
  });
});

describe('what counts as a value: the SQL and the cell writer agree', () => {
  it('hasCellValueSql answers as callExportHasValue for every shape', async () => {
    const values: unknown[] = [
      null, '', 'x', ' ', 0, -0.4, false, true, {}, { a: null }, [], [null], [''], ['', null], [null, 'a'],
      [false], [0], [[]], [{}], [[null]], 'null',
    ];
    for (const value of values) {
      const { rows: [row] } = await q(
        `SELECT ${hasCellValueSql('$1::jsonb')} AS has`, [value === null ? null : JSON.stringify(value)]);
      expect(Boolean(row.has), JSON.stringify(value)).toBe(callExportHasValue(value));
    }
    // JSON null as a jsonb value (not SQL NULL) is no value either.
    const { rows: [jsonNull] } = await q(`SELECT ${hasCellValueSql(`'null'::jsonb`)} AS has`);
    expect(jsonNull.has).toBe(false);
  });

  it('a list of nothing is counted as no value in the field list, and written as an empty cell', async () => {
    const legId = await mediaLeg('e1', {
      status: 'completed', result: { common: { key_topics: [null, ''] }, custom: { amount: [null] } },
    });
    const contactRow = (await q(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state)
       VALUES ($1, $2, $3, '+919700000099', '{}'::jsonb, 'completed') RETURNING id`, [campaignId, floor.tenant, floor.account])).rows[0];
    const { rows: [attemptRow] } = await q(
      `INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id,
              state, outcome, webrtc_call_id, dialed_at, ended_at, created_at)
       VALUES ($1, $2, $3, $4, 1, '+919000000001', 'ended', 'connected', $5, $6, $6, $6) RETURNING id`,
      [campaignId, contactRow.id, floor.tenant, floor.account, legId, at(40)]);
    id.set('e1', attemptRow.id as string);
    try {
      const window = `&from=${encodeURIComponent(at(40).toISOString())}&to=${encodeURIComponent(at(40).toISOString())}`;
      const list = await fieldList(`?${window.slice(1)}`);
      expect(list.calls).toBe(1);
      expect(list.analysis.find((f) => f.name === 'ai_key_topics')!.calls).toBe(0);
      expect(list.dimensions.find((d) => d.key === 'amount')?.calls ?? 0).toBe(0);
      const { rows } = await exportRows('ai_key_topics,dim_amount', window);
      expect(rows.get('e1')).toMatchObject({ ai_key_topics: '', dim_amount: '' });
    } finally {
      await q('DELETE FROM agency_call_attempts WHERE id = $1', [id.get('e1')]);
      await q('DELETE FROM agency_contacts WHERE id = $1', [contactRow.id]);
      id.delete('e1');
    }
  });
});

describe('the field list counts exactly the rows the export writes', () => {
  it('under every call type, the follow-ups and a soft-phone status', async () => {
    // An open Missed row, so the follow-ups are not an empty set.
    id.set('m1', await insertInboundCall('m1', {
      tenantId: floor.tenant, accountId: floor.account, campaign: campaignId, from: '+919800000077', to: '+919000000009',
      arrived: at(35), outcome: 'closed', closedCause: 'hours', followUp: { status: 'open', reason: 'closed' },
    }));
    // The field list takes the export's own query, so each case is one query sent to both.
    const cases = [
      '', 'source=dialler', 'source=soft_phone', 'source=inbound', 'source=to_follow_up',
      'source=soft_phone&status=settled', 'source=soft_phone&status=awaiting_outcome',
    ];
    const seen = new Set<number>();
    for (const query of cases) {
      const list = await fieldList(query ? `?${query}` : '');
      const res = await get(`/proxy/agency/campaigns/${campaignId}/attempts.csv?preamble=false&fields=analysis_status${query ? `&${query}` : ''}`);
      expect(res.statusCode, query).toBe(200);
      expect(res.headers['x-export-rows'], query).toBe(String(list.calls));
      expect(parseCsv(res.body).length - 1, query).toBe(list.calls);
      seen.add(list.calls);
    }
    // The cases are not all one number: each filter really narrows.
    expect(seen.size).toBeGreaterThan(3);
  });
});
