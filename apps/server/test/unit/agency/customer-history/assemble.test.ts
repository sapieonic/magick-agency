import { describe, expect, it } from 'vitest';
import type {
  CustomerHistoryAttemptRow,
  CustomerHistoryCampaignRow,
  CustomerHistoryContactRow,
  CustomerHistoryDncRow,
  CustomerHistoryManualCallRow,
} from '../../../../src/db/repositories/agency.repository.js';
import {
  buildSummary,
  buildTimeline,
  callbackStatus,
  chainAttemptId,
  contactFields,
  filterTimeline,
  pageTimeline,
  recordingState,
  uploadFileName,
  type CustomerHistoryData,
} from '../../../../src/agency/customer-history/assemble.js';
import { buildViewer, canOpenCallPage, canSeeCallNotes, canSeeDncDetail } from '../../../../src/agency/customer-history/visibility.js';
import { decodeTimelineCursor } from '../../../../src/agency/customer-history/cursor.js';
import { toTimelineFilter } from '../../../../src/agency/customer-history/requests.js';
import { customerHistoryCsv, CUSTOMER_HISTORY_CSV_HEADERS } from '../../../../src/agency/customer-history/csv.js';

/**
 * The customer-history assembler (`src/agency/customer-history/assemble.ts`,
 * `docs/customer-history.md` §3–§4): one order across every source, the callback and recording
 * judgements, what each caller is shown (CH8), retry chains as one row (CH7), the filters, keyset
 * pages that never skip or repeat, and the CSV.
 */

const NOW = new Date('2026-11-06T10:00:00.000Z');
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = uid(1);
const ACC_A = uid(10);
const ACC_B = uid(11);
const ME = uid(20);
const OTHER = uid(21);
const ROOT = uid(30);
const RETRY = uid(31);
const OTHER_CAMPAIGN = uid(32);

const micro = (iso: string) => `${new Date(iso).toISOString().slice(0, 23)}000Z`;

function campaign(id: string, over: Partial<CustomerHistoryCampaignRow> = {}): CustomerHistoryCampaignRow {
  return {
    id, account_id: ACC_A, name: `Campaign ${id.slice(-2)}`, status: 'running', root_id: id, retry_generation: 0,
    context_display: { hero: ['Name', 'Loan No'] },
    disposition_catalog: [{ code: 'callback', label: 'Call back', requires_datetime: true }, { code: 'ptp', label: 'PTP' }],
    ...over,
  };
}

function contact(id: string, over: Partial<CustomerHistoryContactRow> = {}): CustomerHistoryContactRow {
  const created = over.created_at ?? new Date('2026-10-01T09:00:00Z');
  return {
    id, root_contact_id: id, campaign_id: ROOT, account_id: ACC_A, phone_e164: '+919876543210',
    context: { Name: 'Asha Rao', 'Loan No': 'LN-0042', City: 'Pune' }, state: 'pending', suppressed_reason: null,
    last_outcome: null, last_disposition: null, next_attempt_at: new Date('2026-11-07T05:30:00Z'), assigned_user_id: null,
    override_disposition: null, override_extra_attempts: 0, override_retry_delay: false, override_calling_hours: false,
    override_granted_at: null, created_at: created, at: micro(created.toISOString()), ...over,
  };
}

function attempt(id: string, createdIso: string, over: Partial<CustomerHistoryAttemptRow> = {}): CustomerHistoryAttemptRow {
  const created = new Date(createdIso);
  return {
    id, contact_id: uid(100), campaign_id: ROOT, account_id: ACC_A, attempt_number: 1, webrtc_call_id: null,
    agent_user_id: OTHER, state: 'ended', outcome: 'connected', disposition_code: 'ptp', notes: 'Spoke to her',
    callback_at: null, dialed_at: created, ended_at: new Date(created.getTime() + 60_000), talk_seconds: 50,
    dispositioned_by_user_id: null, dispositioned_at: null, redial_of_attempt_id: null, redial_number: 0,
    override_applied: [], override_note: null, created_at: created, at: micro(createdIso),
    booked_at: micro(new Date(created.getTime() + 60_000).toISOString()), ...over,
  };
}

function manual(id: string, createdIso: string, over: Partial<CustomerHistoryManualCallRow> = {}): CustomerHistoryManualCallRow {
  const created = new Date(createdIso);
  return {
    id, account_id: ACC_A, agent_user_id: ME, campaign_id: null, contact_id: null, webrtc_call_id: null,
    destination_e164: '+919876543210', state: 'ended', outcome: 'no_answer', disposition_code: null, notes: null,
    callback_at: null, fields: {}, dnc_override_note: null, hours_override_note: null, dialed_at: created,
    ended_at: created, talk_seconds: null, dispositioned_by_user_id: null, dispositioned_at: null,
    created_at: created, at: micro(createdIso), booked_at: micro(createdIso), ...over,
  };
}

function dnc(id: string, createdIso: string, over: Partial<CustomerHistoryDncRow> = {}): CustomerHistoryDncRow {
  return {
    id, account_id: ACC_A, campaign_id: null, source: 'agent', reason: 'Asked not to be called', added_by: OTHER,
    created_at: new Date(createdIso), at: micro(createdIso), ...over,
  };
}

function viewerAs(role: 'agent' | 'viewer' | 'account_admin' | 'tenant_owner', scope: 'account' | 'tenant' = 'account') {
  return buildViewer(
    ME,
    [{ account_id: scope === 'tenant' ? null : ACC_A, role, status: 'active' }],
    scope === 'tenant' ? [{ id: ACC_A, name: 'North' }, { id: ACC_B, name: 'South' }] : [{ id: ACC_A, name: 'North' }],
  );
}

function data(over: Partial<CustomerHistoryData> = {}): CustomerHistoryData {
  return {
    now: NOW,
    viewer: viewerAs('account_admin'),
    contacts: [],
    campaigns: new Map([[ROOT, campaign(ROOT)], [RETRY, campaign(RETRY, { root_id: ROOT, retry_generation: 1, name: 'Retry 1' })]]),
    attempts: [],
    manualCalls: [],
    dnc: [],
    mediaLegs: new Map(),
    uploads: [],
    names: new Map([[ME, 'Me'], [OTHER, 'Karan Shah']]),
    ...over,
  };
}

describe('visibility (CH2, CH8)', () => {
  it('the role in an account is the higher of the tenant-level and the account role', () => {
    const v = buildViewer(ME, [
      { account_id: null, role: 'viewer' },
      { account_id: ACC_A, role: 'account_admin' },
    ], [{ id: ACC_A, name: 'North' }, { id: ACC_B, name: 'South' }]);
    expect(v.accounts.get(ACC_A)?.role).toBe('account_admin');
    expect(v.accounts.get(ACC_B)?.role).toBe('viewer');
    expect(v.highestRole).toBe('account_admin');
    // A revoked membership grants nothing.
    const revoked = buildViewer(ME, [{ account_id: ACC_A, role: 'tenant_owner', status: 'revoked' }, { account_id: ACC_A, role: 'agent' }], [{ id: ACC_A, name: 'N' }]);
    expect(revoked.accounts.get(ACC_A)?.role).toBe('agent');
  });

  it('notes: campaigns.read in the account, or the caller\'s own call; the call page: supervise; DNC detail: dnc.read', () => {
    const agent = viewerAs('agent');
    expect(canSeeCallNotes(agent, ACC_A, OTHER)).toBe(false);
    expect(canSeeCallNotes(agent, ACC_A, ME)).toBe(true);
    expect(canSeeCallNotes(viewerAs('viewer'), ACC_A, OTHER)).toBe(true);
    expect(canOpenCallPage(agent, ACC_A)).toBe(false);
    expect(canOpenCallPage(viewerAs('viewer'), ACC_A)).toBe(false);
    expect(canOpenCallPage(viewerAs('account_admin'), ACC_A)).toBe(true);
    expect(canSeeDncDetail(agent, ACC_A)).toBe(false);
    expect(canSeeDncDetail(viewerAs('viewer'), ACC_A)).toBe(true);
    expect(canSeeDncDetail(agent, null)).toBe(false);
    // An account the caller cannot see grants nothing.
    expect(canSeeCallNotes(viewerAs('tenant_owner'), ACC_B, OTHER)).toBe(false);
    expect(canSeeCallNotes(viewerAs('tenant_owner', 'tenant'), ACC_B, OTHER)).toBe(true);
  });
});

describe('the small judgements', () => {
  it('recording state', () => {
    const legs = new Map([['leg-1', { recording_url: 'https://r/1' }], ['leg-2', { recording_url: null }]]);
    expect(recordingState(null, legs)).toBe('no_call');
    expect(recordingState('leg-1', legs)).toBe('available');
    expect(recordingState('leg-2', legs)).toBe('not_recorded');
    expect(recordingState('leg-purged', legs)).toBe('expired');
  });

  it('callback status: the next call placed after the booking, 15 minutes inclusive', () => {
    const due = Date.parse('2026-11-06T09:00:00Z');
    const booked = Date.parse('2026-11-05T09:00:00Z');
    const judge = (placed: Array<[string, string]>, nowIso = '2026-11-06T12:00:00Z') => callbackStatus({
      bookingCallId: 'booking', bookedAtMs: booked, dueAtMs: due, nowMs: Date.parse(nowIso),
      placed: placed.map(([id, at]) => ({ id, dialedAtMs: Date.parse(at) })),
    });
    // The booking call itself, and calls before the booking, are not "the next call".
    expect(judge([['booking', '2026-11-05T10:00:00Z'], ['old', '2026-11-04T09:00:00Z']]).status).toBe('missed');
    expect(judge([['early', '2026-11-06T08:00:00Z']])).toEqual({ status: 'kept', dialledAtMs: Date.parse('2026-11-06T08:00:00Z') });
    expect(judge([['edge', '2026-11-06T09:15:00Z']]).status).toBe('kept');
    expect(judge([['late', '2026-11-06T09:15:00.001Z']]).status).toBe('late');
    // The FIRST call after the booking decides, not the closest to due.
    expect(judge([['b', '2026-11-06T09:05:00Z'], ['a', '2026-11-06T11:00:00Z']]).status).toBe('kept');
    expect(judge([['a', '2026-11-06T11:00:00Z'], ['b', '2026-11-06T09:30:00Z']]).status).toBe('late');
    expect(judge([], '2026-11-06T08:59:59Z').status).toBe('upcoming');
    expect(judge([], '2026-11-06T09:00:00Z').status).toBe('due');
    expect(judge([], '2026-11-06T09:15:00Z').status).toBe('due');
    expect(judge([], '2026-11-06T09:15:00.001Z').status).toBe('missed');
  });

  it('the redial chain\'s first attempt', () => {
    const a = { id: 'a', redial_of_attempt_id: null };
    const b = { id: 'b', redial_of_attempt_id: 'a' };
    const c = { id: 'c', redial_of_attempt_id: 'b' };
    const byId = new Map([a, b, c].map((x) => [x.id, x]));
    expect(chainAttemptId(c, byId)).toBe('a');
    expect(chainAttemptId(a, byId)).toBe('a');
    expect(chainAttemptId({ id: 'd', redial_of_attempt_id: 'gone' }, byId)).toBe('gone');
    const loop = new Map([['x', { id: 'x', redial_of_attempt_id: 'y' }], ['y', { id: 'y', redial_of_attempt_id: 'x' }]]);
    expect(['x', 'y']).toContain(chainAttemptId(loop.get('x')!, loop));
  });

  it('hero fields, else the first four columns', () => {
    expect(contactFields({ Name: 'Asha', 'Loan No': 'LN-1', City: 'Pune' }, campaign(ROOT)))
      .toEqual([{ column: 'Name', value: 'Asha' }, { column: 'Loan No', value: 'LN-1' }]);
    expect(contactFields({ a: 1, b: '', c: true, d: 'x', e: 'y' }, campaign(ROOT, { context_display: {} })))
      .toEqual([{ column: 'a', value: '1' }, { column: 'c', value: 'true' }, { column: 'd', value: 'x' }]);
  });

  it('the upload whose run covers the row', () => {
    const uploads = [
      { campaign_id: ROOT, file_name: 'first.csv', started_at: new Date('2026-10-01T08:59:00Z'), finished_at: new Date('2026-10-01T09:01:00Z'), created_at: new Date('2026-10-01T08:58:00Z') },
      { campaign_id: ROOT, file_name: 'second.csv', started_at: new Date('2026-10-02T09:00:00Z'), finished_at: null, created_at: new Date('2026-10-02T09:00:00Z') },
    ];
    expect(uploadFileName(ROOT, new Date('2026-10-01T09:00:00Z'), uploads, NOW)).toBe('first.csv');
    expect(uploadFileName(ROOT, new Date('2026-10-03T00:00:00Z'), uploads, NOW)).toBe('second.csv');
    expect(uploadFileName(ROOT, new Date('2026-09-30T00:00:00Z'), uploads, NOW)).toBeNull();
    expect(uploadFileName(RETRY, new Date('2026-10-01T09:00:00Z'), uploads, NOW)).toBeNull();
  });
});

/** One history with every kind, in a known order. */
function fullHistory(over: Partial<CustomerHistoryData> = {}): CustomerHistoryData {
  const c1 = contact(uid(100), { created_at: new Date('2026-10-01T09:00:00Z') });
  const c1retry = contact(uid(101), { root_contact_id: uid(100), campaign_id: RETRY, created_at: new Date('2026-10-20T09:00:00Z'),
    last_disposition: 'callback', last_outcome: 'connected', assigned_user_id: ME,
    override_disposition: 'ptp', override_extra_attempts: 2, override_retry_delay: true, override_granted_at: new Date('2026-11-04T08:00:00Z') });
  const first = attempt(uid(200), '2026-10-02T10:00:00Z', { webrtc_call_id: uid(900) });
  const redial = attempt(uid(201), '2026-10-02T10:05:00Z', { redial_of_attempt_id: uid(200), redial_number: 1, attempt_number: 2, webrtc_call_id: uid(901) });
  const booking = attempt(uid(202), '2026-11-04T07:56:00Z', {
    contact_id: uid(101), campaign_id: RETRY, attempt_number: 1, disposition_code: 'callback',
    callback_at: new Date('2026-11-07T05:30:00Z'), dispositioned_by_user_id: OTHER,
    dispositioned_at: new Date('2026-11-04T08:00:00Z'), booked_at: micro('2026-11-04T08:00:00Z'),
  });
  return data({
    contacts: [c1retry, c1],
    attempts: [first, redial, booking],
    manualCalls: [
      manual(uid(300), '2026-11-05T11:20:00Z', { campaign_id: null, notes: 'Mine', outcome: 'connected', fields: { promised_amount: 2500 } }),
      manual(uid(301), '2026-10-25T11:20:00Z', { agent_user_id: OTHER, campaign_id: RETRY, contact_id: uid(101), notes: 'Theirs' }),
    ],
    dnc: [dnc(uid(400), '2026-10-03T10:00:00Z', { campaign_id: ROOT })],
    mediaLegs: new Map([[uid(900), { recording_url: 'https://r' }]]),
    ...over,
  });
}

describe('the timeline', () => {
  it('every kind, in one order (at DESC, key DESC), with the redial chain', () => {
    const items = buildTimeline(fullHistory());
    expect(items.map((i) => i.key)).toEqual([
      `softphone_call:${uid(300)}`, // 11-05 11:20
      `callback:${uid(202)}`, // booked 11-04 08:00
      `campaign_call:${uid(202)}`, // 11-04 07:56
      `softphone_call:${uid(301)}`, // 10-25
      `roster_entry:${uid(101)}`, // 10-20
      `dnc_mark:${uid(400)}`, // 10-03
      `campaign_call:${uid(201)}`, // 10-02 10:05 (the redial)
      `campaign_call:${uid(200)}`, // 10-02 10:00
      `roster_entry:${uid(100)}`, // 10-01
    ]);
    const redial = items.find((i) => i.key === `campaign_call:${uid(201)}`)!.entry;
    expect(redial).toMatchObject({ redial_of_attempt_id: uid(200), chain_attempt_id: uid(200), redial_number: 1, recording: 'expired' });
    expect(items.find((i) => i.key === `campaign_call:${uid(200)}`)!.entry).toMatchObject({ recording: 'available', chain_attempt_id: uid(200) });
    const cb = items.find((i) => i.key === `callback:${uid(202)}`)!.entry;
    // The soft-phone call on 11-05 is the next call after the 11-04 booking; due 11-07: kept (early).
    expect(cb).toMatchObject({ kind: 'callback', at: '2026-11-04T08:00:00.000Z', due_at: '2026-11-07T05:30:00.000Z',
      status: 'kept', dialled_at: '2026-11-05T11:20:00.000Z', booked_by: { user_id: OTHER, name: 'Karan Shah' },
      source: { channel: 'campaign', id: uid(202) } });
  });

  it('entries sharing one instant are ordered by key alone', () => {
    const at = '2026-10-02T10:00:00Z';
    const items = buildTimeline(data({
      contacts: [contact(uid(100), { created_at: new Date(at) })],
      attempts: [attempt(uid(200), at)],
      manualCalls: [manual(uid(300), at)],
      dnc: [dnc(uid(400), at)],
    }));
    expect(items.map((i) => i.key.split(':')[0])).toEqual(['softphone_call', 'roster_entry', 'dnc_mark', 'campaign_call']);
  });

  it('an agent sees others\' notes hidden and their own shown, and no call page', () => {
    const items = buildTimeline(fullHistory({ viewer: viewerAs('agent') }));
    const theirs = items.find((i) => i.key === `softphone_call:${uid(301)}`)!.entry;
    const mine = items.find((i) => i.key === `softphone_call:${uid(300)}`)!.entry;
    const campaignCall = items.find((i) => i.key === `campaign_call:${uid(200)}`)!.entry;
    expect(theirs).toMatchObject({ notes: null, notes_hidden: true, fields: null, call_page: null });
    expect(mine).toMatchObject({ notes: 'Mine', notes_hidden: false, fields: { promised_amount: 2500 }, call_page: null });
    expect(campaignCall).toMatchObject({ notes: null, notes_hidden: true, call_page: null });
    const mark = items.find((i) => i.key === `dnc_mark:${uid(400)}`)!.entry;
    expect(mark).toMatchObject({ entry: { reason: null, added_by: null, scope: 'campaign' } });
  });

  it('a supervisor sees notes, the call page and who added a DNC entry', () => {
    const items = buildTimeline(fullHistory());
    expect(items.find((i) => i.key === `campaign_call:${uid(200)}`)!.entry).toMatchObject({
      notes: 'Spoke to her', notes_hidden: false,
      call_page: { account_id: ACC_A, campaign_id: ROOT, attempt_id: uid(200) },
    });
    expect(items.find((i) => i.key === `softphone_call:${uid(301)}`)!.entry)
      .toMatchObject({ notes: 'Theirs', call_page: { account_id: ACC_A, manual_call_id: uid(301) } });
    expect(items.find((i) => i.key === `dnc_mark:${uid(400)}`)!.entry)
      .toMatchObject({ entry: { reason: 'Asked not to be called', added_by: 'Karan Shah' } });
  });

  it('filters: campaign roots include retries; from/to half-open; call-only filters keep only calls', () => {
    const items = buildTimeline(fullHistory());
    const keys = (f: Parameters<typeof toTimelineFilter>[0]) => filterTimeline(items, toTimelineFilter(f)).map((i) => i.key);
    // The root campaign keeps its retry's calls, callbacks and roster rows; not the untagged call.
    expect(keys({ campaign_ids: [ROOT] })).toEqual([
      `callback:${uid(202)}`, `campaign_call:${uid(202)}`, `softphone_call:${uid(301)}`, `roster_entry:${uid(101)}`,
      `dnc_mark:${uid(400)}`, `campaign_call:${uid(201)}`, `campaign_call:${uid(200)}`, `roster_entry:${uid(100)}`,
    ]);
    expect(keys({ campaign_ids: [RETRY] })).toEqual([]); // a retry is not a root
    expect(keys({ from: '2026-10-02T10:05:00Z', to: '2026-10-25T11:20:00Z' })).toEqual([
      `roster_entry:${uid(101)}`, `dnc_mark:${uid(400)}`, `campaign_call:${uid(201)}`,
    ]);
    expect(keys({ channel: 'softphone' })).toEqual([`softphone_call:${uid(300)}`, `softphone_call:${uid(301)}`]);
    expect(keys({ connected_only: true })).toEqual([
      `softphone_call:${uid(300)}`, `campaign_call:${uid(202)}`, `campaign_call:${uid(201)}`, `campaign_call:${uid(200)}`,
    ]);
    expect(keys({ outcomes: ['no_answer'] })).toEqual([`softphone_call:${uid(301)}`]);
    expect(keys({ disposition_codes: ['callback'] })).toEqual([`campaign_call:${uid(202)}`]);
    expect(keys({ agent_user_ids: [ME] })).toEqual([`softphone_call:${uid(300)}`]);
  });

  it('pages: no duplicates, no skips, across entries sharing one instant', () => {
    const at = '2026-10-02T10:00:00Z';
    const attempts = Array.from({ length: 23 }, (_, i) => attempt(uid(1000 + i), i < 15 ? at : `2026-10-0${3 + (i % 5)}T10:00:00Z`));
    const items = buildTimeline(data({ attempts, contacts: [contact(uid(100), { created_at: new Date(at) })] }));
    for (const limit of [1, 2, 5, 7, 24, 100]) {
      const seen: string[] = [];
      let cursor = null as ReturnType<typeof decodeTimelineCursor>;
      for (let guard = 0; guard < 100; guard++) {
        const page = pageTimeline(items, cursor, limit);
        expect(page.entries.length).toBeLessThanOrEqual(limit);
        seen.push(...page.entries.map((e) => e.key));
        if (!page.next_cursor) break;
        cursor = decodeTimelineCursor(page.next_cursor);
        expect(cursor).not.toBeNull();
      }
      expect(seen, `limit ${limit}`).toEqual(items.map((i) => i.key));
    }
    // The last page has no cursor; an exactly full last page too.
    expect(pageTimeline(items, null, items.length).next_cursor).toBeNull();
    expect(pageTimeline([], null, 50)).toEqual({ entries: [], next_cursor: null });
  });
});

describe('the summary', () => {
  it('one row per retry chain, totals, open callbacks and overrides, live calls, filter options', () => {
    const live = attempt(uid(203), '2026-11-06T09:59:30Z', { state: 'bridged', outcome: null, disposition_code: null, contact_id: uid(101), campaign_id: RETRY, ended_at: null });
    const d = fullHistory();
    const s = buildSummary({ ...d, attempts: [...d.attempts, live] });
    expect(s.contacts).toHaveLength(1);
    expect(s.contacts[0]).toMatchObject({
      contact_id: uid(101), root_contact_id: uid(100), account_name: 'North',
      campaign: { id: RETRY, root_id: ROOT, retry_generation: 1 },
      campaigns: [{ id: ROOT }, { id: RETRY }],
      attempt_count: 4,
      fields: [{ column: 'Name', value: 'Asha Rao' }, { column: 'Loan No', value: 'LN-0042' }],
      assigned_to: { user_id: ME, name: 'Me' },
      entered_at: '2026-10-01T09:00:00.000Z',
    });
    // Placed: 4 attempts + 2 soft-phone calls; connected: three attempts and one soft-phone call.
    expect(s.totals).toMatchObject({ calls: 6, connected: 4, last_contacted: { at: '2026-11-06T09:59:30.000Z', channel: 'campaign' } });
    expect(s.open.callbacks).toEqual([expect.objectContaining({
      contact_id: uid(101), due_at: '2026-11-07T05:30:00.000Z', owner: { user_id: ME, name: 'Me' },
      booked_by: { user_id: OTHER, name: 'Karan Shah' }, disposition_code: 'callback',
    })]);
    expect(s.open.overrides).toEqual([expect.objectContaining({ contact_id: uid(101), disposition_code: 'ptp', extra_attempts: 2, retry_delay: true, calling_hours: false })]);
    expect(s.open.live_calls).toEqual([expect.objectContaining({ channel: 'campaign', started_at: '2026-11-06T09:59:30.000Z' })]);
    expect(s.filter_options).toEqual({
      campaigns: [{ id: ROOT, name: 'Campaign 30' }],
      agents: [{ user_id: OTHER, name: 'Karan Shah' }, { user_id: ME, name: 'Me' }],
      outcomes: ['connected', 'no_answer'],
      disposition_codes: ['callback', 'ptp'],
    });
    expect(s.dnc).toEqual([expect.objectContaining({ id: uid(400), scope: 'campaign', campaign: { id: ROOT, name: 'Campaign 30' } })]);
  });

  it('a household line: two rows on one number in one campaign stay two rows', () => {
    const s = buildSummary(data({ contacts: [contact(uid(100)), contact(uid(102), { context: { Name: 'Ravi' } })] }));
    expect(s.contacts.map((c) => c.contact_id).sort()).toEqual([uid(100), uid(102)]);
  });

  it('a callback the contact is no longer waiting on is not open', () => {
    const s = buildSummary(data({ contacts: [contact(uid(100), { last_disposition: 'callback', last_outcome: 'no_answer' })] }));
    expect(s.open.callbacks).toEqual([]);
    const done = buildSummary(data({ contacts: [contact(uid(100), { last_disposition: 'callback', last_outcome: 'connected', state: 'completed' })] }));
    expect(done.open.callbacks).toEqual([]);
  });

  it('nothing: an empty answer', () => {
    expect(buildSummary(data())).toEqual({
      contacts: [], totals: { calls: 0, connected: 0, last_contacted: null }, dnc: [],
      open: { callbacks: [], overrides: [], live_calls: [] },
      filter_options: { campaigns: [], agents: [], outcomes: [], disposition_codes: [] },
    });
  });
});

describe('the CSV', () => {
  it('British English headers, one row per entry, hidden notes say so, formula cells guarded', () => {
    const d = fullHistory({ viewer: viewerAs('agent') });
    const entries = buildTimeline(d).map((i) => i.entry);
    const csv = customerHistoryCsv(entries, '+919876543210', (id) => (id === ACC_A ? 'North' : null));
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(CUSTOMER_HISTORY_CSV_HEADERS.join(','));
    expect(lines).toHaveLength(entries.length + 1);
    expect(lines[0]).toContain('Talk time (seconds)');
    // The number begins with `+`: guarded against formula injection.
    expect(lines[1]).toContain(`'+919876543210`);
    const theirs = lines.find((l) => l.includes('Soft-phone call') && l.includes('Karan Shah'))!;
    expect(theirs).toContain(',Hidden,');
    expect(csv).not.toContain('Theirs');
    expect(csv).toContain('Callback booked');
    expect(csv).toContain('Recording expired');
    expect(csv).toContain('Marked do-not-call');
  });
});
