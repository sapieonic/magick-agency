import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * ─── Tagged soft-phone calls in the campaign's results (SR1–SR6) ───────────────
 *
 * One seed, real Postgres, read through the real app:
 *
 *  - `/stats` `softphone` (lifetime) and Insights `calls.softphone` (a range) count the tagged
 *    soft-phone calls by ONE definition (`softphone-campaign-sql.ts`): placed (`dialed_at` set),
 *    connected (outcome `connected`), reached a person (bridged, coded neither voicemail nor
 *    `no_disposition`);
 *  - the DIALLER's connect rate is unchanged by them, on `/stats` and on Insights (SR1): the
 *    soft-phone calls here reach people at a different rate, so blending them in would move it;
 *  - the campaign call export (`attempts.csv`) carries them as `soft_phone` rows beside the
 *    dialler's, newest first on one keyset, with the attempt list's filters (SR6);
 *  - the Call log's JSON route (`call-log`, CL11) lists the same rows with a `type`, pages them
 *    on that keyset, and counts each type for its chips;
 *  - untagged calls, calls tagged to another campaign and a row in another tenant carrying this
 *    campaign's id (the tag has no foreign key) are in none of it (SR4).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'softphone-results-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { bulkInsert } from '../agency/insights-rollup-world.js';
import { insightsCache } from '../../../src/agency/insights/cache.js';
import { agencyInsightsRollupRepository } from '../../../src/db/repositories/agency.repository.js';
import { ATTEMPT_CSV_COLUMNS, SPINE_EXPORT_PAGE_SIZE } from '../../../src/agency/agency-spine.js';

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
let campaignId: string;
let siblingCampaignId: string;
let softSession: string;
let linkedContactId: string;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const MIN = 60_000;
const QUARTER = 15 * MIN;
/** A 15-minute boundary three hours ago: Insights ranges are served on the rollup's buckets. */
const BASE = new Date(Math.floor((Date.now() - 3 * 60 * MIN) / QUARTER) * QUARTER);
const at = (minutes: number, seconds = 0) => new Date(BASE.getTime() + minutes * MIN + seconds * 1000);
/** The Insights range the soft-phone counts are checked over: `[BASE+30m, BASE+60m)`. */
const RANGE = { from: at(30), to: at(60) };

const get = async (path: string, actor = () => floor.supervisors[0]!) => {
  const res = await call(loaded.app, 'GET', path, actor(), floor);
  expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
  return res;
};

/** The dialler's seed: 10 placed first dials, 2 reached a person (20%), plus one queued never placed. */
const DIALLER = ['human', 'human', 'voicemail', 'auto', 'unwritten', 'no_answer', 'no_answer', 'no_answer', 'no_answer', 'no_answer', 'queued'] as const;
const DIALLER_RATE = (2 / 10) * 100;

interface SoftSeed {
  label: string;
  /** Minutes after BASE it was created (and dialled, when placed). */
  minute: number;
  second?: number;
  placed: boolean;
  bridged: boolean;
  state: string;
  outcome: string | null;
  code: string | null;
  campaign?: 'self' | 'sibling' | 'none';
  tenant?: 'self' | 'other';
  contact?: boolean;
}

/**
 * Tagged to the campaign, in range unless noted. Lifetime: placed 9, connected 6, reached 3.
 * In RANGE: placed 7, connected 5, reached 2 (the 29:59 and 60:00 ones are out of it).
 */
const SOFT: SoftSeed[] = [
  { label: 'reached-1', minute: 31, placed: true, bridged: true, state: 'ended', outcome: 'connected', code: 'interested', contact: true },
  { label: 'reached-2', minute: 32, placed: true, bridged: true, state: 'ended', outcome: 'connected', code: 'not_interested' },
  { label: 'voicemail', minute: 33, placed: true, bridged: true, state: 'ended', outcome: 'connected', code: 'voicemail' },
  { label: 'lapsed', minute: 34, placed: true, bridged: true, state: 'ended', outcome: 'connected', code: 'no_disposition' },
  { label: 'awaiting', minute: 35, placed: true, bridged: true, state: 'ended', outcome: 'connected', code: null },
  { label: 'no-answer', minute: 36, placed: true, bridged: false, state: 'ended', outcome: 'no_answer', code: null },
  { label: 'ringing', minute: 37, placed: true, bridged: false, state: 'ringing', outcome: null, code: null },
  // Failed before the dial was sent: a row, never a call.
  { label: 'never-placed', minute: 38, placed: false, bridged: false, state: 'ended', outcome: 'failed', code: null },
  // Just before the range, and exactly at its exclusive end.
  { label: 'before-range', minute: 29, second: 59, placed: true, bridged: false, state: 'ended', outcome: 'busy', code: null },
  { label: 'at-range-end', minute: 60, placed: true, bridged: true, state: 'ended', outcome: 'connected', code: 'interested' },
  // In no figure of this campaign.
  { label: 'untagged', minute: 40, placed: true, bridged: true, state: 'ended', outcome: 'connected', code: 'interested', campaign: 'none' },
  { label: 'sibling', minute: 41, placed: true, bridged: true, state: 'ended', outcome: 'connected', code: 'interested', campaign: 'sibling' },
  { label: 'other-tenant', minute: 42, placed: true, bridged: true, state: 'ended', outcome: 'connected', code: 'interested', tenant: 'other' },
];
const softId = new Map<string, string>();

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = await seedFloor({ tenants: 2, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 2, staffAgents: true }) as [TenantFloor, TenantFloor];
  campaignId = floor.campaigns[0]!;
  siblingCampaignId = floor.campaigns[1]!;
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2 WHERE id = ANY($1::uuid[])`, [floor.campaigns, at(0)]);

  // The dialler's dials, by agent 0.
  const { rows: [session] } = await q(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, joined_at, left_at)
     VALUES ($1, $2, $3, $4, 'offline', $5, $6) RETURNING id`,
    [floor.tenant, floor.account, campaignId, floor.agents[0]!.id, at(0), at(170)]);
  const contacts: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];
  for (const [n, kind] of DIALLER.entries()) {
    const contactId = randomUUID();
    contacts.push({ id: contactId, campaign_id: campaignId, tenant_id: floor.tenant, account_id: floor.account,
      phone_e164: `+9197${String(n).padStart(8, '0')}`, context: {}, state: 'completed' });
    const dialed = at(30, 10 + n);
    const base = { id: randomUUID(), campaign_id: campaignId, contact_id: contactId, tenant_id: floor.tenant, account_id: floor.account,
      attempt_number: 1, caller_id: '+919000000001', reserved_agent_id: session.id, redial_number: 0, created_at: dialed };
    if (kind === 'queued') {
      attempts.push({ ...base, state: 'queued', outcome: null, disposition_code: null, dialed_at: null, answered_at: null, bridged_at: null, ended_at: null });
    } else if (kind === 'no_answer') {
      attempts.push({ ...base, state: 'ended', outcome: 'no_answer', disposition_code: null, dialed_at: dialed, answered_at: null, bridged_at: null,
        ended_at: new Date(dialed.getTime() + 20_000) });
    } else {
      const code = { human: 'interested', voicemail: 'voicemail', auto: 'no_disposition', unwritten: null }[kind];
      attempts.push({ ...base, state: 'ended', outcome: 'connected', disposition_code: code, dialed_at: dialed,
        answered_at: new Date(dialed.getTime() + 4000), bridged_at: new Date(dialed.getTime() + 4200), ended_at: new Date(dialed.getTime() + 60_000) });
    }
  }
  await bulkInsert(getTestPool(), 'agency_contacts', [
    ['id', 'uuid'], ['campaign_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['phone_e164', 'text'], ['context', 'jsonb'], ['state', 'text'],
  ], contacts);
  await bulkInsert(getTestPool(), 'agency_call_attempts', [
    ['id', 'uuid'], ['campaign_id', 'uuid'], ['contact_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'],
    ['attempt_number', 'int'], ['caller_id', 'text'], ['reserved_agent_id', 'uuid'], ['state', 'text'], ['outcome', 'text'],
    ['disposition_code', 'text'], ['dialed_at', 'timestamptz'], ['answered_at', 'timestamptz'], ['bridged_at', 'timestamptz'],
    ['ended_at', 'timestamptz'], ['redial_number', 'int'], ['created_at', 'timestamptz'],
  ], attempts);
  linkedContactId = contacts[0]!.id as string;

  // The soft phone's calls, by agent 1 (and one by the other tenant's agent).
  const softSessionFor = async (f: TenantFloor, agent: string) => (await q(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, kind, joined_at, left_at)
     VALUES ($1, $2, NULL, $3, 'offline', 'softphone', $4, $5) RETURNING id`, [f.tenant, f.account, agent, at(0), at(170)])).rows[0].id as string;
  softSession = await softSessionFor(floor, floor.agents[1]!.id);
  const otherSession = await softSessionFor(other, other.agents[0]!.id);
  for (const [n, s] of SOFT.entries()) {
    const created = at(s.minute, s.second ?? 0);
    const dialed = s.placed ? new Date(created.getTime() + 500) : null;
    const bridged = s.bridged ? new Date(created.getTime() + 5000) : null;
    const ended = s.state === 'ended' ? new Date(created.getTime() + 60_000) : null;
    const theirs = s.tenant === 'other';
    const tag = s.campaign === 'none' ? null : s.campaign === 'sibling' ? siblingCampaignId : campaignId;
    const { rows: [row] } = await q(
      `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, campaign_id, contact_id,
              destination_e164, caller_id, state, outcome, disposition_code, disposition_source,
              dialed_at, bridged_at, ended_at, settled_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '+919000000002', $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [theirs ? other.tenant : floor.tenant, theirs ? other.account : floor.account, theirs ? otherSession : softSession,
        theirs ? other.agents[0]!.id : floor.agents[1]!.id, tag, s.contact ? linkedContactId : null,
        `+9188${String(n).padStart(8, '0')}`, s.state, s.outcome, s.code,
        s.code === null ? null : tag === null ? 'softphone' : 'campaign',
        dialed, bridged, ended,
        // One unsettled call per session (uq_agency_manual_call_unsettled): only the live one is.
        s.label === 'ringing' ? null : ended, created]);
    softId.set(s.label, row.id as string);
  }

  for (let i = 0; i < 50; i++) if ((await agencyInsightsRollupRepository.recomputeBatch(200)).picked < 200) break;
  insightsCache.clear();
}, 180_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

const rangeQuery = `from=${encodeURIComponent(RANGE.from.toISOString())}&to=${encodeURIComponent(RANGE.to.toISOString())}`;

describe('the soft phone\'s campaign figures: one definition, beside the dialler\'s (SR1–SR4)', () => {
  it('/stats: lifetime placed, connected and reached; the dialler\'s connect rate is the dialler\'s alone', async () => {
    const stats = (await get(`/proxy/agency/campaigns/${campaignId}/stats`)).json();
    expect(stats.softphone).toEqual({ placed: 9, connected: 6, human_connects: 3 });
    // The dialler's own counts and rate, as the seed spells them, soft-phone calls nowhere in them.
    expect(stats.first_dials_placed).toBe(10);
    expect(stats.human_connects).toBe(2);
    expect(stats.attempts_connected).toBe(5);
    expect(stats.connect_rate_pct).toBeCloseTo(DIALLER_RATE, 9);
    // Not vacuous: blended, the rate would be (2 + 3) / (10 + 9).
    expect(stats.connect_rate_pct).not.toBeCloseTo(((2 + 3) / (10 + 9)) * 100, 3);
  });

  it('Insights over [from, to): the range\'s tagged calls, half-open on created_at, the dialler\'s rate untouched', async () => {
    const activity = (await get(`/proxy/agency/campaigns/${campaignId}/insights/activity?${rangeQuery}`)).json();
    expect(activity.range.from).toBe(RANGE.from.toISOString());
    expect(activity.range.to).toBe(RANGE.to.toISOString());
    expect(activity.calls.softphone).toEqual({ placed: 7, connected: 5, human_connects: 2 });
    // The older reader's count is the same number.
    expect(activity.calls.softphone_calls).toBe(7);
    // The dialler's: 10 placed first dials, 2 reached, no redials.
    expect(activity.calls.dials).toBe(10);
    expect(activity.calls.redials.placed).toBe(0);
    expect(activity.calls.human_connects).toBe(2);
    expect(activity.calls.connected).toBe(5);
    expect(activity.calls.human_connects / (activity.calls.dials - activity.calls.redials.placed) * 100).toBeCloseTo(DIALLER_RATE, 9);
  });

  it('a campaign with no soft-phone calls serves zeros, and one with only soft-phone calls serves no dials', async () => {
    const sibling = (await get(`/proxy/agency/campaigns/${siblingCampaignId}/stats`)).json();
    // The sibling has one tagged call and no dials at all.
    expect(sibling.softphone).toEqual({ placed: 1, connected: 1, human_connects: 1 });
    expect(sibling.first_dials_placed).toBe(0);
    expect(sibling.connect_rate_pct).toBeNull();
    const theirs = (await call(loaded.app, 'GET', `/proxy/agency/campaigns/${other.campaigns[0]}/stats`, other.supervisors[0]!, other)).json();
    expect(theirs.softphone).toEqual({ placed: 0, connected: 0, human_connects: 0 });
  });
});

/** A preamble-less export's rows, keyed by column. */
async function exportRows(params = ''): Promise<Array<Record<string, string>>> {
  const res = await get(`/proxy/agency/campaigns/${campaignId}/attempts.csv?preamble=false${params}`);
  const lines = res.body.split('\n').filter((l) => l.length > 0);
  expect(lines[0]).toBe(ATTEMPT_CSV_COLUMNS.join(','));
  expect(res.headers['x-export-rows']).toBe(String(lines.length - 1));
  return lines.slice(1).map((line) => {
    // No cell in this seed carries a comma or a quote (notes are NULL).
    const cells = line.split(',');
    return Object.fromEntries(ATTEMPT_CSV_COLUMNS.map((c, i) => [c, cells[i] ?? '']));
  });
}

describe('the campaign call export carries the tagged soft-phone calls (SR6)', () => {
  it('every dialler attempt and every tagged soft-phone call, once, newest first, each with its source', async () => {
    const rows = await exportRows();
    const dialler = rows.filter((r) => r.source === 'dialler');
    const soft = rows.filter((r) => r.source === 'soft_phone');
    expect(dialler).toHaveLength(DIALLER.length);
    // Every tagged row of this tenant, placed or not (the export lists rows, as the dialler's
    // queued attempt shows): not the untagged, the sibling's or the other tenant's.
    const tagged = SOFT.filter((s) => (s.campaign ?? 'self') === 'self' && (s.tenant ?? 'self') === 'self');
    expect(new Set(soft.map((r) => r.attempt_id))).toEqual(new Set(tagged.map((s) => softId.get(s.label))));
    for (const label of ['untagged', 'sibling', 'other-tenant']) {
      expect(rows.some((r) => r.attempt_id === softId.get(label)), label).toBe(false);
    }
    const created = rows.map((r) => r.created_at);
    expect(created).toEqual([...created].sort().reverse());

    const reached = soft.find((r) => r.attempt_id === softId.get('reached-1'))!;
    expect(reached).toMatchObject({
      contact_id: linkedContactId, attempt_number: '', agent_user_id: floor.agents[1]!.id, state: 'ended',
      outcome: 'connected', disposition_code: 'interested', wrapup_seconds: '', auto_disposition_code: '',
    });
    expect(reached.agent_name).not.toBe('');
    expect(soft.find((r) => r.attempt_id === softId.get('no-answer'))!.contact_id).toBe('');
    expect(dialler.every((r) => r.attempt_number === '1')).toBe(true);
  });

  it('a soft-phone row carries its own promise to pay (PT12), column for column with the dialler\'s', async () => {
    // The two halves of the call log are one UNION: a column added to the attempt half and not
    // the soft-phone half fails every export. The soft-phone call's own promise fills it.
    const id = softId.get('reached-1')!;
    await q(`UPDATE agency_manual_calls SET promise_date = DATE '2026-11-20', promise_amount = 12500.50 WHERE id = $1`, [id]);
    try {
      const rows = await exportRows();
      expect(rows.find((r) => r.attempt_id === id)).toMatchObject({
        source: 'soft_phone', promise_date: '2026-11-20', promise_amount: '12500.50',
      });
      expect(rows.filter((r) => r.attempt_id !== id).every((r) => r.promise_date === '' && r.promise_amount === '')).toBe(true);
    } finally {
      await q(`UPDATE agency_manual_calls SET promise_date = NULL, promise_amount = NULL WHERE id = $1`, [id]);
    }
  });

  it('source=dialler is the file as it was; source=soft_phone the tagged calls alone', async () => {
    const dialler = await exportRows('&source=dialler');
    expect(dialler).toHaveLength(DIALLER.length);
    expect(dialler.every((r) => r.source === 'dialler')).toBe(true);
    const soft = await exportRows('&source=soft_phone');
    expect(soft).toHaveLength(SOFT.filter((s) => (s.campaign ?? 'self') === 'self' && (s.tenant ?? 'self') === 'self').length);
    expect(soft.every((r) => r.source === 'soft_phone')).toBe(true);
    const refused = await call(loaded.app, 'GET', `/proxy/agency/campaigns/${campaignId}/attempts.csv?source=softphone`, floor.supervisors[0]!, floor);
    expect(refused.statusCode).toBe(400);
  });

  it('the attempt list\'s filters mean the same on a soft-phone call', async () => {
    const ids = (rows: Array<Record<string, string>>) => new Set(rows.filter((r) => r.source === 'soft_phone').map((r) => r.attempt_id));
    const labels = (...l: string[]) => new Set(l.map((x) => softId.get(x)));
    expect(ids(await exportRows('&outcome=connected'))).toEqual(labels('reached-1', 'reached-2', 'voicemail', 'lapsed', 'awaiting', 'at-range-end'));
    expect(ids(await exportRows('&disposition_code=voicemail'))).toEqual(labels('voicemail'));
    expect(ids(await exportRows('&placed=0'))).toEqual(labels('never-placed'));
    expect(ids(await exportRows(`&dialed_from=${encodeURIComponent(RANGE.from.toISOString())}&dialed_to=${encodeURIComponent(RANGE.to.toISOString())}`)))
      .toEqual(labels('reached-1', 'reached-2', 'voicemail', 'lapsed', 'awaiting', 'no-answer', 'ringing'));
    expect(ids(await exportRows(`&agent_user_id=${floor.agents[1]!.id}`)).size).toBe(10);
    expect(ids(await exportRows(`&agent_user_id=${floor.agents[0]!.id}`)).size).toBe(0);
    expect(ids(await exportRows(`&contact_id=${linkedContactId}`))).toEqual(labels('reached-1'));
    expect(ids(await exportRows('&phone=00000005'))).toEqual(labels('no-answer'));
    expect(ids(await exportRows('&state=ringing'))).toEqual(labels('ringing'));
    // Attempt-only dimensions: a soft-phone call is never one, so `=1` keeps none and `=0` all.
    for (const flag of ['redial', 'agent_manual', 'agent_reopened', 'override_applied']) {
      expect(ids(await exportRows(`&${flag}=1`)).size, `${flag}=1`).toBe(0);
      expect(ids(await exportRows(`&${flag}=0`)).size, `${flag}=0`).toBe(10);
    }
  });
});

/** A Call log page as the console reads it. */
interface LogRow { type: string; id: string; created_at: string; [key: string]: unknown }
interface LogPage { rows: LogRow[]; next_cursor: string | null; limit: number; counts?: { all: number; dialler: number; soft_phone: number } }
const logPage = async (params = ''): Promise<LogPage> =>
  (await get(`/proxy/agency/campaigns/${campaignId}/call-log${params ? `?${params}` : ''}`)).json() as LogPage;
/** Every page of the Call log, walked by its cursor. */
async function walkLog(params: string, limit: number): Promise<LogRow[]> {
  const rows: LogRow[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page: LogPage = await logPage(`${params}${params ? '&' : ''}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    rows.push(...page.rows);
    cursor = page.next_cursor;
    if (!cursor) return rows;
  }
  throw new Error('the call log never ended');
}
const TAGGED = SOFT.filter((s) => (s.campaign ?? 'self') === 'self' && (s.tenant ?? 'self') === 'self');

describe('the Call log\'s JSON route: one list, every type (CL11)', () => {
  it('lists the dialler\'s attempts and the tagged soft-phone calls once each, newest first, across pages', async () => {
    // A page size that splits both types and lands boundaries inside the dialler's run.
    const rows = await walkLog('', 4);
    expect(rows).toHaveLength(DIALLER.length + TAGGED.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.filter((r) => r.type === 'dialler')).toHaveLength(DIALLER.length);
    expect(new Set(rows.filter((r) => r.type === 'soft_phone').map((r) => r.id))).toEqual(new Set(TAGGED.map((s) => softId.get(s.label))));
    for (const label of ['untagged', 'sibling', 'other-tenant']) {
      expect(rows.some((r) => r.id === softId.get(label)), label).toBe(false);
    }
    const created = rows.map((r) => r.created_at);
    expect(created).toEqual([...created].sort().reverse());
    // The same rows, in the same order, as the export's file.
    expect(rows.map((r) => r.id)).toEqual((await exportRows()).map((r) => r.attempt_id));
  });

  it('a row of each type carries its own fields, and both name their agent', async () => {
    const rows = await walkLog('', 50);
    const dialler = rows.find((r) => r.type === 'dialler' && r.disposition_code === 'interested')!;
    expect(dialler).toMatchObject({ attempt_number: 1, redial_number: 0, agent_user_id: floor.agents[0]!.id, campaign_id: campaignId });
    expect(dialler.agent_name).toEqual(expect.any(String));
    expect(dialler).not.toHaveProperty('source');
    expect(dialler).not.toHaveProperty('dnc_overridden');

    const reached = rows.find((r) => r.id === softId.get('reached-1'))!;
    expect(reached).toMatchObject({
      type: 'soft_phone', campaign_id: campaignId, contact_id: linkedContactId, agent_user_id: floor.agents[1]!.id,
      state: 'ended', outcome: 'connected', disposition_code: 'interested',
      dnc_overridden: false, hours_overridden: false, requires_disposition: false,
    });
    expect(reached.agent_name).toEqual(expect.any(String));
    expect(reached.phone_e164).toMatch(/^\+9188/);
    for (const key of ['source', 'attempt_number', 'wrapup_seconds', 'auto_disposition_code', 'reserved_agent_id']) {
      expect(reached, key).not.toHaveProperty(key);
    }
    // A number on no list, and a row whose dial was never sent: both listed.
    expect(rows.find((r) => r.id === softId.get('no-answer'))).toMatchObject({ contact_id: null, outcome: 'no_answer' });
    expect(rows.find((r) => r.id === softId.get('never-placed'))).toMatchObject({ dialed_at: null, state: 'ended' });
  });

  it('says which soft-phone calls overrode a refusal and which still owe an outcome', async () => {
    const overridden = softId.get('reached-2')!;
    const awaiting = softId.get('awaiting')!;
    const ringing = softId.get('ringing')!;
    try {
      await q(`UPDATE agency_manual_calls SET dnc_override_note = 'asked us to ring', dnc_override_entry_id = gen_random_uuid(),
                      hours_override_note = 'agreed a time' WHERE id = $1`, [overridden]);
      // One unsettled call per session: the live one ends and settles, so the bridged one can owe its outcome.
      await q(`UPDATE agency_manual_calls SET state = 'ended', ended_at = created_at, settled_at = created_at WHERE id = $1`, [ringing]);
      await q(`UPDATE agency_manual_calls SET settled_at = NULL WHERE id = $1`, [awaiting]);
      const rows = await walkLog('type=soft_phone', 50);
      expect(rows.find((r) => r.id === overridden)).toMatchObject({ dnc_overridden: true, hours_overridden: true });
      expect(rows.find((r) => r.id === awaiting)).toMatchObject({ requires_disposition: true, settled_at: null });
      expect(rows.filter((r) => r.id !== awaiting).every((r) => r.requires_disposition === false)).toBe(true);
      expect(rows.filter((r) => r.id !== overridden).every((r) => !r.dnc_overridden && !r.hours_overridden)).toBe(true);
    } finally {
      await q(`UPDATE agency_manual_calls SET settled_at = ended_at WHERE id = $1`, [awaiting]);
      await q(`UPDATE agency_manual_calls SET state = 'ringing', ended_at = NULL, settled_at = NULL WHERE id = $1`, [ringing]);
      await q(`UPDATE agency_manual_calls SET dnc_override_note = NULL, dnc_override_entry_id = NULL, hours_override_note = NULL WHERE id = $1`, [overridden]);
    }
  });

  it('type keeps one type; all and no type are the whole list; an unknown type is refused', async () => {
    expect((await walkLog('type=dialler', 50)).map((r) => r.type)).toEqual(DIALLER.map(() => 'dialler'));
    expect((await walkLog('type=soft_phone', 50)).map((r) => r.type)).toEqual(TAGGED.map(() => 'soft_phone'));
    expect(await walkLog('type=all', 50)).toHaveLength(DIALLER.length + TAGGED.length);
    for (const bad of ['type=softphone', 'type=inbound', 'source=dialler', 'include_counts=yes']) {
      const refused = await call(loaded.app, 'GET', `/proxy/agency/campaigns/${campaignId}/call-log?${bad}`, floor.supervisors[0]!, floor);
      expect(refused.statusCode, bad).toBe(400);
    }
  });

  it('counts each type for the chips: by the filters, never by the chip or the page', async () => {
    // Soft phone counts the calls whose dial was sent (9 of the 10 tagged rows); the dialler every attempt.
    const placed = TAGGED.filter((s) => s.placed).length;
    const whole = { all: DIALLER.length + placed, dialler: DIALLER.length, soft_phone: placed };
    expect(placed).toBe(9);
    expect((await logPage('include_counts=1')).counts).toEqual(whole);
    // The chip that is on, the page size and the cursor change the rows, not the counts.
    const first = await logPage('include_counts=1&type=soft_phone&limit=2');
    expect(first.rows).toHaveLength(2);
    expect(first.counts).toEqual(whole);
    expect((await logPage(`include_counts=1&type=dialler&limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`)).counts).toEqual(whole);
    // Not asked for, not sent.
    expect(await logPage('type=dialler')).not.toHaveProperty('counts');

    // The filters do: what happened, the dates, the agent, the number.
    expect((await logPage('include_counts=1&outcome=connected')).counts).toEqual({ all: 11, dialler: 5, soft_phone: 6 });
    expect((await logPage(`include_counts=1&agent_user_id=${floor.agents[1]!.id}`)).counts).toEqual({ all: placed, dialler: 0, soft_phone: placed });
    expect((await logPage('include_counts=1&phone=00000005')).counts).toEqual({ all: 2, dialler: 1, soft_phone: 1 });
    const upTo = encodeURIComponent(at(32, 30).toISOString());
    // Created up to 32:30: every dialler attempt (30:10 to 30:20), and before-range, reached-1, reached-2.
    expect((await logPage(`include_counts=1&to=${upTo}`)).counts).toEqual({ all: DIALLER.length + 3, dialler: DIALLER.length, soft_phone: 3 });
    // A row that never dialled is listed and counted nowhere (SR2); the dialler's queued attempt is an attempt.
    const never = await logPage('include_counts=1&placed=0');
    expect(never.counts).toEqual({ all: 1, dialler: 1, soft_phone: 0 });
    expect(never.rows.map((r) => r.type).sort()).toEqual(['dialler', 'soft_phone']);
    // Each count is the number of rows its chip lists, for rows that dialled.
    expect((await walkLog('placed=1&type=soft_phone', 50))).toHaveLength(placed);
  });

  it('is the supervisor\'s: an agent is refused, and another tenant finds no such campaign', async () => {
    const path = `/proxy/agency/campaigns/${campaignId}/call-log`;
    expect((await call(loaded.app, 'GET', path, floor.agents[0]!, floor)).statusCode).toBe(403);
    expect((await call(loaded.app, 'GET', path, other.supervisors[0]!, other)).statusCode).toBe(404);
  });
});

describe('the call log\'s one keyset across both sources', () => {
  it('crosses page boundaries without dropping or repeating a row, ties on created_at included', async () => {
    // A second campaign-sized batch: attempts and soft-phone calls sharing created_at in pairs.
    const n = SPINE_EXPORT_PAGE_SIZE + 37;
    await q(`INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state, source_row_number)
             SELECT $1, $2, $3, '+9196' || lpad(g::text, 8, '0'), '{}'::jsonb, 'pending', g FROM generate_series(1, $4::int) g`,
      [campaignId, floor.tenant, floor.account, n]);
    await q(`INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, created_at)
             SELECT campaign_id, id, tenant_id, account_id, 1, '+919000000001', 'queued', $2::timestamptz - make_interval(secs => source_row_number)
               FROM agency_contacts WHERE campaign_id = $1 AND phone_e164 LIKE '+9196%'`, [campaignId, at(100)]);
    await q(`INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, campaign_id, destination_e164, caller_id,
                                              state, outcome, ended_at, settled_at, created_at)
             SELECT $1, $2, $3, $4, $5, '+9195' || lpad(g::text, 8, '0'), '+919000000002', 'ended', 'failed',
                    $6::timestamptz, $6::timestamptz, $6::timestamptz - make_interval(secs => g)
               FROM generate_series(1, $7::int) g`,
      [floor.tenant, floor.account, softSession, floor.agents[1]!.id, campaignId, at(100), n]);

    const rows = await exportRows();
    const expected = DIALLER.length + n + SOFT.filter((s) => (s.campaign ?? 'self') === 'self' && (s.tenant ?? 'self') === 'self').length + n;
    expect(rows).toHaveLength(expected);
    expect(new Set(rows.map((r) => r.attempt_id)).size).toBe(expected);
    // Newest first across both sources: the pairs interleave.
    const created = rows.map((r) => r.created_at);
    expect(created).toEqual([...created].sort().reverse());
    expect(rows.slice(0, 4).map((r) => r.source).sort()).toEqual(['dialler', 'dialler', 'soft_phone', 'soft_phone']);
    await q(`DELETE FROM agency_manual_calls WHERE destination_e164 LIKE '+9195%'`);
    await q(`DELETE FROM agency_call_attempts WHERE created_at >= $1`, [at(90)]);
    await q(`DELETE FROM agency_contacts WHERE phone_e164 LIKE '+9196%'`);
  });
});
