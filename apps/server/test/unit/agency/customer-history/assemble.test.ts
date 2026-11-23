import { describe, expect, it } from 'vitest';
import type {
  CustomerHistoryAttemptRow,
  CustomerHistoryCallbackRow,
  CustomerHistoryCallStatsRow,
  CustomerHistoryCampaignRow,
  CustomerHistoryContactRow,
  CustomerHistoryDncRow,
  CustomerHistoryInboundCallRow,
  CustomerHistoryManualCallRow,
  CustomerHistorySummaryContactRow,
} from '../../../../src/db/repositories/agency.repository.js';
import { UUID_MAX, UUID_NIL } from '../../../../src/db/repositories/agency.repository.js';
import {
  buildSummary,
  buildTimeline,
  callbackStatus,
  contactFields,
  cutPage,
  EMPTY_SOURCES,
  entryCount,
  recordingState,
  sourceBound,
  timelinePage,
  uploadFileName,
  type CustomerHistorySummaryData,
  type TimelinePageData,
  type TimelineSourceRows,
} from '../../../../src/agency/customer-history/assemble.js';
import { buildViewer, canOpenCallPage, canSeeCallNotes, canSeeDncDetail } from '../../../../src/agency/customer-history/visibility.js';
import { compareTimeline, decodeTimelineCursor, type TimelinePosition } from '../../../../src/agency/customer-history/cursor.js';
import { customerHistoryCsv, CUSTOMER_HISTORY_CSV_HEADERS } from '../../../../src/agency/customer-history/csv.js';
import type { CustomerTimelineKind } from '@magick-agency/contracts/api/agency/customer-history';

/**
 * The customer-history assembler (`src/agency/customer-history/assemble.ts`,
 * `docs/customer-history.md` §3–§4): one order across every source, the per-source keyset bound
 * and the merge of the sources' heads (no skips, no repeats, across kinds sharing one instant),
 * the callback and recording judgements, what each caller is shown (CH8), retry chains as one
 * row (CH7), the summary from its aggregates, and the CSV. The SQL half of the keyset (each
 * source's `(at, id) < bound`) is run on real Postgres by `test/integration/api/customer-history.test.ts`.
 */

const NOW = new Date('2026-11-06T10:00:00.000Z');
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACC_A = uid(10);
const ACC_B = uid(11);
const ME = uid(20);
const OTHER = uid(21);
const ROOT = uid(30);
const RETRY = uid(31);

const micro = (iso: string) => `${new Date(iso).toISOString().slice(0, 23)}000Z`;

function campaign(id: string, over: Partial<CustomerHistoryCampaignRow> = {}): CustomerHistoryCampaignRow {
  return {
    id, account_id: ACC_A, name: `Campaign ${id.slice(-2)}`, status: 'running', root_id: id, retry_generation: 0,
    context_display: { hero: ['Name', 'Loan No'] },
    disposition_catalog: [{ code: 'callback', label: 'Call back', requires_datetime: true }, { code: 'ptp', label: 'PTP' }],
    ...over,
  };
}

function contact(id: string, over: Partial<CustomerHistorySummaryContactRow> = {}): CustomerHistorySummaryContactRow {
  const created = over.created_at ?? new Date('2026-10-01T09:00:00Z');
  return {
    id, root_contact_id: id, campaign_id: ROOT, account_id: ACC_A, phone_e164: '+919876543210',
    context: { Name: 'Asha Rao', 'Loan No': 'LN-0042', City: 'Pune' }, state: 'pending', suppressed_reason: null,
    last_outcome: null, last_disposition: null, next_attempt_at: new Date('2026-11-07T05:30:00Z'), assigned_user_id: null,
    override_disposition: null, override_extra_attempts: 0, override_retry_delay: false, override_calling_hours: false,
    override_granted_at: null, created_at: created, at: micro(created.toISOString()), placed: 0, ...over,
  };
}

function attempt(id: string, createdIso: string, over: Partial<CustomerHistoryAttemptRow> = {}): CustomerHistoryAttemptRow {
  const created = new Date(createdIso);
  return {
    id, contact_id: uid(100), campaign_id: ROOT, account_id: ACC_A, attempt_number: 1, webrtc_call_id: null,
    agent_user_id: OTHER, state: 'ended', outcome: 'connected', disposition_code: 'ptp', auto_disposition_code: null, notes: 'Spoke to her',
    callback_at: null, promise_date: null, promise_amount: null,
    dialed_at: created, ended_at: new Date(created.getTime() + 60_000), talk_seconds: 50,
    dispositioned_by_user_id: null, dispositioned_at: null, redial_of_attempt_id: null, chain_attempt_id: id, redial_number: 0,
    override_applied: [], override_note: null, record_calls: true, created_at: created, at: micro(createdIso), ...over,
  };
}

function manual(id: string, createdIso: string, over: Partial<CustomerHistoryManualCallRow> = {}): CustomerHistoryManualCallRow {
  const created = new Date(createdIso);
  return {
    id, account_id: ACC_A, agent_user_id: ME, campaign_id: null, contact_id: null, webrtc_call_id: null,
    destination_e164: '+919876543210', state: 'ended', outcome: 'no_answer', disposition_code: null, notes: null,
    callback_at: null, promise_date: null, promise_amount: null, fields: {}, dnc_override_note: null, hours_override_note: null, recording_requested: false,
    dialed_at: created, ended_at: created, talk_seconds: null, dispositioned_by_user_id: null, dispositioned_at: null,
    created_at: created, at: micro(createdIso), ...over,
  };
}

/** An inbound call from the number: answered by `OTHER`, filed under `ROOT`, unless `over` says otherwise. */
function inboundCall(id: string, arrivedIso: string, over: Partial<CustomerHistoryInboundCallRow> = {}): CustomerHistoryInboundCallRow {
  const { inbound: facts, ...rest } = over;
  return {
    source: 'inbound', id, campaign_id: ROOT, contact_id: null, attempt_number: null, phone_e164: '+919876543210',
    caller_id: '+918000000009', agent_user_id: OTHER, reserved_agent_id: null, state: 'ended', outcome: 'answered',
    disposition_code: 'ptp', auto_disposition_code: null, notes: 'Rang about her EMI', callback_at: null, promise_date: null,
    promise_amount: null, dispositioned_by_user_id: OTHER, dispositioned_at: arrivedIso, dispositioned_on_behalf: false,
    webrtc_call_id: null, dialed_at: null, answered_at: arrivedIso, bridged_at: arrivedIso, ended_at: arrivedIso, talk_seconds: 75,
    wrapup_seconds: null, redial_of_attempt_id: null, redial_number: null, dnc_overridden: false, hours_overridden: false,
    requires_disposition: false, settled_at: arrivedIso, created_at: arrivedIso,
    inbound: {
      campaign_source: 'contact', route_name: 'Collections line', wait_seconds: 18, queued: false, via_sticky_agent: true,
      voicemail_seconds: null, follow_up: null, called_back: null, ...facts,
    },
    account_id: ACC_A, recording_requested: false, at: micro(arrivedIso), ...rest,
  };
}

function callback(id: string, bookedIso: string, over: Partial<CustomerHistoryCallbackRow> = {}): CustomerHistoryCallbackRow {
  return {
    channel: 'campaign', id, account_id: ACC_A, campaign_id: RETRY, callback_at: new Date('2026-11-07T05:30:00Z'),
    booked_by_user_id: OTHER, at: micro(bookedIso), booked_at: micro(bookedIso), ...over,
  };
}

function dnc(id: string, createdIso: string, over: Partial<CustomerHistoryDncRow> = {}): CustomerHistoryDncRow {
  return {
    id, account_id: ACC_A, campaign_id: null, effective_account_id: over.account_id === undefined ? ACC_A : over.account_id,
    source: 'agent', reason: 'Asked not to be called', added_by: OTHER,
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

const CAMPAIGNS = new Map([[ROOT, campaign(ROOT)], [RETRY, campaign(RETRY, { root_id: ROOT, retry_generation: 1, name: 'Retry 1' })]]);
const NAMES = new Map([[ME, 'Me'], [OTHER, 'Karan Shah']]);

function page(over: Partial<TimelinePageData> = {}): TimelinePageData {
  return {
    ...EMPTY_SOURCES,
    now: NOW,
    viewer: viewerAs('account_admin'),
    campaigns: CAMPAIGNS,
    mediaLegs: new Map(),
    uploads: [],
    names: NAMES,
    callbackNext: new Map(),
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
  it('recording state: a purged leg is "expired" only when the call asked for a recording', () => {
    const legs = new Map([['leg-1', { recording_url: 'https://r/1' }], ['leg-2', { recording_url: null }]]);
    expect(recordingState(null, legs, true)).toBe('no_call');
    expect(recordingState('leg-1', legs, true)).toBe('available');
    expect(recordingState('leg-2', legs, true)).toBe('not_recorded');
    expect(recordingState('leg-purged', legs, true)).toBe('expired');
    expect(recordingState('leg-purged', legs, false)).toBe('not_recorded');
  });

  it('callback status: the next call placed after the booking, 15 minutes inclusive', () => {
    const due = Date.parse('2026-11-06T09:00:00Z');
    const judge = (next: string | null, nowIso = '2026-11-06T12:00:00Z') =>
      callbackStatus({ dueAtMs: due, nextDialledAtMs: next ? Date.parse(next) : null, nowMs: Date.parse(nowIso) });
    expect(judge('2026-11-06T08:00:00Z')).toBe('kept'); // early counts
    expect(judge('2026-11-06T09:15:00Z')).toBe('kept');
    expect(judge('2026-11-06T09:15:00.001Z')).toBe('late');
    expect(judge(null, '2026-11-06T08:59:59Z')).toBe('upcoming');
    expect(judge(null, '2026-11-06T09:00:00Z')).toBe('due');
    expect(judge(null, '2026-11-06T09:15:00Z')).toBe('due');
    expect(judge(null, '2026-11-06T09:15:00.001Z')).toBe('missed');
  });

  it('hero fields: the configured heroes; never a hidden column; the fallback in the IMPORT\'s column order', () => {
    expect(contactFields({ Name: 'Asha', 'Loan No': 'LN-1', City: 'Pune' }, campaign(ROOT)))
      .toEqual([{ column: 'Name', value: 'Asha' }, { column: 'Loan No', value: 'LN-1' }]);
    // No hero, Aadhaar hidden; JSONB hands the keys back by length, the import kept the file's order.
    const jsonb = { Id: '7', City: 'Pune', Aadhaar: '1234 5678 9012', Zz: 'x' };
    const hidden = campaign(ROOT, { context_display: { hidden: ['Aadhaar'] } });
    expect(contactFields(jsonb, hidden).map((f) => f.column)).not.toContain('Aadhaar');
    expect(contactFields({ a: '1', bb: '2', Aadhaar: '3', ccc: '4' }, hidden, ['ccc', 'Aadhaar', 'bb', 'a']))
      .toEqual([{ column: 'ccc', value: '4' }, { column: 'bb', value: '2' }, { column: 'a', value: '1' }]);
    // Every hero hidden: the hidden ones still do not come back through the fallback.
    expect(contactFields({ Name: 'Asha', Aadhaar: '1' }, campaign(ROOT, { context_display: { hero: ['Aadhaar'], hidden: ['Aadhaar'] } })))
      .toEqual([{ column: 'Name', value: 'Asha' }]);
  });

  it('the upload whose run covers the row', () => {
    const uploads = [
      { campaign_id: ROOT, file_name: 'first.csv', context_columns: null, started_at: new Date('2026-10-01T08:59:00Z'), finished_at: new Date('2026-10-01T09:01:00Z'), created_at: new Date('2026-10-01T08:58:00Z') },
      { campaign_id: ROOT, file_name: 'second.csv', context_columns: null, started_at: new Date('2026-10-02T09:00:00Z'), finished_at: null, created_at: new Date('2026-10-02T09:00:00Z') },
    ];
    expect(uploadFileName(ROOT, new Date('2026-10-01T09:00:00Z'), uploads, NOW)).toBe('first.csv');
    expect(uploadFileName(ROOT, new Date('2026-10-03T00:00:00Z'), uploads, NOW)).toBe('second.csv');
    expect(uploadFileName(ROOT, new Date('2026-09-30T00:00:00Z'), uploads, NOW)).toBeNull();
    expect(uploadFileName(RETRY, new Date('2026-10-01T09:00:00Z'), uploads, NOW)).toBeNull();
  });
});

describe('paging: the per-source bound and the merge of the heads', () => {
  it('a source resumes at the cursor\'s own id for its kind; at the cursor\'s instant, all of an earlier kind and none of a later one', () => {
    const at = '2026-11-04T07:56:00.123456Z';
    const cursor = { at, key: `dnc_mark:${uid(5)}` };
    expect(sourceBound('dnc_mark', cursor)).toEqual({ at, id: uid(5) });
    // `campaign_call` < `dnc_mark`: its keys at that instant sort after the cursor's.
    expect(sourceBound('campaign_call', cursor)).toEqual({ at, id: UUID_MAX });
    expect(sourceBound('callback', cursor)).toEqual({ at, id: UUID_MAX });
    expect(sourceBound('roster_entry', cursor)).toEqual({ at, id: UUID_NIL });
    expect(sourceBound('softphone_call', cursor)).toEqual({ at, id: UUID_NIL });
    expect(sourceBound('roster_entry', null)).toEqual({ at: 'infinity', id: UUID_MAX });
    // `inbound_call` sorts after `dnc_mark` (the cursor's kind): none of its rows at the cursor's instant are still to come.
    expect(sourceBound('inbound_call', cursor)).toEqual({ at, id: UUID_NIL });
  });

  /**
   * Every source as SQL runs it: rows with `(at, id) < bound`, `at DESC, id DESC`, `limit + 1`.
   * Many rows share instants across kinds, so a page boundary falls inside a tie.
   */
  function simulate(limit: number) {
    const instants = ['2026-10-02T10:00:00.000001Z', '2026-10-02T10:00:00.000002Z', '2026-10-03T10:00:00.000000Z'];
    const pick = (i: number) => instants[i % instants.length]!;
    const all: TimelineSourceRows = {
      attempts: Array.from({ length: 9 }, (_, i) => ({ ...attempt(uid(1000 + i), '2026-10-02T10:00:00Z'), at: pick(i) })),
      manualCalls: Array.from({ length: 5 }, (_, i) => ({ ...manual(uid(2000 + i), '2026-10-02T10:00:00Z'), at: pick(i + 1) })),
      inboundCalls: Array.from({ length: 5 }, (_, i) => ({ ...inboundCall(uid(6000 + i), '2026-10-02T10:00:00Z'), at: pick(i + 2) })),
      callbacks: Array.from({ length: 4 }, (_, i) => callback(uid(3000 + i), '2026-10-02T10:00:00Z', { at: pick(i + 2) })),
      dnc: Array.from({ length: 3 }, (_, i) => ({ ...dnc(uid(4000 + i), '2026-10-02T10:00:00Z'), at: pick(i) })),
      contacts: Array.from({ length: 4 }, (_, i) => ({ ...contact(uid(5000 + i)), at: pick(i + 1) })),
    };
    const head = <R extends { id: string; at: string }>(rows: readonly R[], kind: CustomerTimelineKind, cursor: TimelinePosition | null) => {
      const b = sourceBound(kind, cursor);
      return rows
        .filter((r) => b.at === 'infinity' || r.at < b.at || (r.at === b.at && r.id < b.id))
        .sort((x, y) => (x.at === y.at ? (x.id < y.id ? 1 : -1) : x.at < y.at ? 1 : -1))
        .slice(0, limit + 1);
    };
    const keys: string[] = [];
    let cursor: TimelinePosition | null = null;
    for (let guard = 0; guard < 200; guard++) {
      const cut = cutPage({
        attempts: head(all.attempts, 'campaign_call', cursor),
        manualCalls: head(all.manualCalls, 'softphone_call', cursor),
        inboundCalls: head(all.inboundCalls, 'inbound_call', cursor),
        callbacks: head(all.callbacks, 'callback', cursor),
        dnc: head(all.dnc, 'dnc_mark', cursor),
        contacts: head(all.contacts, 'roster_entry', cursor),
      }, limit);
      const entries = buildTimeline(page({ ...cut.rows }));
      expect(entries.length).toBeLessThanOrEqual(limit);
      keys.push(...entries.map((e) => e.key));
      const wire = timelinePage(entries, cut);
      if (!wire.next_cursor) break;
      cursor = decodeTimelineCursor(wire.next_cursor);
      expect(cursor).not.toBeNull();
    }
    const expected = [
      ...all.attempts.map((r) => ({ at: r.at, key: `campaign_call:${r.id}` })),
      ...all.manualCalls.map((r) => ({ at: r.at, key: `softphone_call:${r.id}` })),
      ...all.inboundCalls.map((r) => ({ at: r.at, key: `inbound_call:${r.id}` })),
      ...all.callbacks.map((r) => ({ at: r.at, key: `callback:${r.id}` })),
      ...all.dnc.map((r) => ({ at: r.at, key: `dnc_mark:${r.id}` })),
      ...all.contacts.map((r) => ({ at: r.at, key: `roster_entry:${r.id}` })),
    ].sort(compareTimeline).map((p) => p.key);
    return { keys, expected };
  }

  it('every page size walks every entry once, in order, across kinds sharing one instant', () => {
    for (const limit of [1, 2, 3, 4, 7, 29, 30, 100]) {
      const { keys, expected } = simulate(limit);
      expect(expected).toHaveLength(30);
      expect(keys, `limit ${limit}`).toEqual(expected);
    }
  });

  it('the cut: the first n of the merge, the last position, and whether more follow', () => {
    const rows: TimelineSourceRows = {
      ...EMPTY_SOURCES,
      attempts: [attempt(uid(1), '2026-10-03T00:00:00Z'), attempt(uid(2), '2026-10-01T00:00:00Z')],
      dnc: [dnc(uid(3), '2026-10-02T00:00:00Z')],
    };
    const cut = cutPage(rows, 2);
    expect(cut.rows.attempts.map((a) => a.id)).toEqual([uid(1)]);
    expect(cut.rows.dnc.map((d) => d.id)).toEqual([uid(3)]);
    expect(cut.last).toEqual({ at: micro('2026-10-02T00:00:00Z'), key: `dnc_mark:${uid(3)}` });
    expect(cut.hasMore).toBe(true);
    expect(cutPage(rows, 3).hasMore).toBe(false);
    expect(timelinePage([], cutPage(EMPTY_SOURCES, 50))).toEqual({ entries: [], next_cursor: null });
  });
});

/** One page with every kind, in a known order. */
function fullPage(over: Partial<TimelinePageData> = {}): TimelinePageData {
  const c1 = contact(uid(100), { created_at: new Date('2026-10-01T09:00:00Z') });
  const c1retry = contact(uid(101), { root_contact_id: uid(100), campaign_id: RETRY, created_at: new Date('2026-10-20T09:00:00Z') });
  return page({
    contacts: [c1retry, c1],
    attempts: [
      attempt(uid(200), '2026-10-02T10:00:00Z', { webrtc_call_id: uid(900) }),
      attempt(uid(201), '2026-10-02T10:05:00Z', {
        redial_of_attempt_id: uid(200), chain_attempt_id: uid(200), redial_number: 1, attempt_number: 2, webrtc_call_id: uid(901),
        override_applied: ['extra_attempts'], override_note: 'Promised to pay on Friday',
      }),
      attempt(uid(202), '2026-11-04T07:56:00Z', { contact_id: uid(101), campaign_id: RETRY, disposition_code: 'callback', callback_at: new Date('2026-11-07T05:30:00Z') }),
    ],
    callbacks: [callback(uid(202), '2026-11-04T08:00:00Z')],
    callbackNext: new Map([[uid(202), new Date('2026-11-05T11:20:00Z')]]),
    manualCalls: [
      manual(uid(300), '2026-11-05T11:20:00Z', { notes: 'Mine', outcome: 'connected', fields: { promised_amount: 2500 } }),
      manual(uid(301), '2026-10-25T11:20:00Z', { agent_user_id: OTHER, campaign_id: RETRY, contact_id: uid(101), notes: 'Theirs' }),
    ],
    // A campaign mark as the dialer writes it: no account of its own; it belongs to its campaign's.
    dnc: [dnc(uid(400), '2026-10-03T10:00:00Z', { account_id: null, campaign_id: ROOT, effective_account_id: ACC_A })],
    mediaLegs: new Map([[uid(900), { recording_url: 'https://r' }]]),
    ...over,
  });
}

describe('the timeline page', () => {
  it('every kind, in one order (at DESC, key DESC), with the redial chain and the callback judged', () => {
    const entries = buildTimeline(fullPage());
    expect(entries.map((e) => e.key)).toEqual([
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
    const byKey = new Map(entries.map((e) => [e.key, e]));
    expect(byKey.get(`campaign_call:${uid(201)}`)).toMatchObject({ redial_of_attempt_id: uid(200), chain_attempt_id: uid(200), redial_number: 1, recording: 'expired' });
    expect(byKey.get(`campaign_call:${uid(200)}`)).toMatchObject({ recording: 'available', chain_attempt_id: uid(200) });
    expect(byKey.get(`callback:${uid(202)}`)).toMatchObject({ kind: 'callback', at: '2026-11-04T08:00:00.000Z', due_at: '2026-11-07T05:30:00.000Z',
      status: 'kept', dialled_at: '2026-11-05T11:20:00.000Z', booked_by: { user_id: OTHER, name: 'Karan Shah' },
      source: { channel: 'campaign', id: uid(202) } });
    // The campaign mark is shown in its campaign's account.
    expect(byKey.get(`dnc_mark:${uid(400)}`)).toMatchObject({ account_id: ACC_A,
      entry: { scope: 'campaign', account_id: ACC_A, account_name: 'North', campaign: { id: ROOT, name: 'Campaign 30' } } });
  });

  it('an agent sees others\' notes hidden and their own shown, no call page, no DNC detail', () => {
    const entries = buildTimeline(fullPage({ viewer: viewerAs('agent') }));
    const byKey = new Map(entries.map((e) => [e.key, e]));
    expect(byKey.get(`softphone_call:${uid(301)}`)).toMatchObject({ notes: null, notes_hidden: true, fields: null, call_page: null });
    expect(byKey.get(`softphone_call:${uid(300)}`)).toMatchObject({ notes: 'Mine', notes_hidden: false, fields: { promised_amount: 2500 }, call_page: null });
    expect(byKey.get(`campaign_call:${uid(200)}`)).toMatchObject({ notes: null, notes_hidden: true, call_page: null });
    expect(byKey.get(`dnc_mark:${uid(400)}`)).toMatchObject({ entry: { reason: null, added_by: null, scope: 'campaign' } });
  });

  it('a supervisor sees notes, the call page and who added a DNC entry', () => {
    const entries = buildTimeline(fullPage());
    const byKey = new Map(entries.map((e) => [e.key, e]));
    expect(byKey.get(`campaign_call:${uid(200)}`)).toMatchObject({
      notes: 'Spoke to her', notes_hidden: false,
      call_page: { account_id: ACC_A, campaign_id: ROOT, attempt_id: uid(200) },
    });
    expect(byKey.get(`softphone_call:${uid(301)}`)).toMatchObject({ notes: 'Theirs', call_page: { account_id: ACC_A, manual_call_id: uid(301) } });
    expect(byKey.get(`dnc_mark:${uid(400)}`)).toMatchObject({ entry: { reason: 'Asked not to be called', added_by: 'Karan Shah' } });
  });

  it('the automatic outcome rides beside the recorded code, shown even where the notes are hidden', () => {
    // OD1–OD8: a catalog code the campaign chose, not agent-typed text, so it is not gated by CH8
    // the way `notes` is. Null on an attempt that has none.
    const unanswered = attempt(uid(5), '2026-10-05T09:00:00Z', {
      outcome: 'no_answer', disposition_code: null, notes: null, auto_disposition_code: 'callback', talk_seconds: null,
    });
    const answered = attempt(uid(6), '2026-10-06T09:00:00Z');
    for (const viewer of [viewerAs('agent'), viewerAs('account_admin')]) {
      const byKey = new Map(buildTimeline(page({ viewer, attempts: [unanswered, answered] })).map((e) => [e.key, e]));
      expect(byKey.get(`campaign_call:${uid(5)}`)).toMatchObject({ outcome: 'no_answer', disposition_code: null, auto_disposition_code: 'callback' });
      expect(byKey.get(`campaign_call:${uid(6)}`)).toMatchObject({ disposition_code: 'ptp', auto_disposition_code: null });
    }
  });

  it('DNC detail follows the entry\'s own account, not the caller\'s highest role', () => {
    // An agent in A who is a viewer in B: B's campaign mark shows its reason, A's does not.
    const viewer = buildViewer(ME, [{ account_id: ACC_A, role: 'agent' }, { account_id: ACC_B, role: 'viewer' }],
      [{ id: ACC_A, name: 'North' }, { id: ACC_B, name: 'South' }]);
    const entries = buildTimeline(page({
      viewer,
      dnc: [
        dnc(uid(400), '2026-10-03T10:00:00Z', { account_id: null, campaign_id: ROOT, effective_account_id: ACC_A }),
        dnc(uid(401), '2026-10-04T10:00:00Z', { account_id: null, campaign_id: uid(33), effective_account_id: ACC_B }),
      ],
    }));
    const byKey = new Map(entries.map((e) => [e.key, e]));
    expect(byKey.get(`dnc_mark:${uid(400)}`)).toMatchObject({ entry: { reason: null, added_by: null } });
    expect(byKey.get(`dnc_mark:${uid(401)}`)).toMatchObject({ entry: { reason: 'Asked not to be called', account_name: 'South' } });
  });
});

const STATS: CustomerHistoryCallStatsRow = {
  contact_entries: 2, call_entries: 6, callback_entries: 1, calls: 6, connected: 4, inbound_calls: 0, inbound_answered: 0,
  agent_ids: [ME, OTHER], outcomes: ['no_answer', 'connected'], disposition_codes: ['ptp', 'callback'], campaign_ids: [ROOT, RETRY],
};

function summaryData(over: Partial<CustomerHistorySummaryData> = {}): CustomerHistorySummaryData {
  return {
    now: NOW,
    viewer: viewerAs('account_admin'),
    contacts: [],
    contactsTruncated: false,
    campaigns: CAMPAIGNS,
    stats: { ...STATS, contact_entries: 0, call_entries: 0, callback_entries: 0, calls: 0, connected: 0, agent_ids: [], outcomes: [], disposition_codes: [], campaign_ids: [] },
    lastPlaced: null,
    liveCalls: [],
    bookings: new Map(),
    dnc: [],
    uploads: [],
    names: NAMES,
    ...over,
  };
}

describe('inbound calls (CL39–CL42)', () => {
  const missedCall = (id: string, iso: string) => inboundCall(id, iso, {
    campaign_id: null, agent_user_id: null, outcome: 'voicemail', disposition_code: null, notes: null, talk_seconds: null,
    inbound: {
      campaign_source: null, route_name: null, wait_seconds: 100, queued: true, via_sticky_agent: false, voicemail_seconds: 22,
      follow_up: { status: 'open', reason: 'overflow', closed_cause: null, assignee_user_id: ME, handled_reason: null, handled_at: null },
      called_back: { call_id: uid(900), at: '2026-10-05T10:20:00.000Z' },
    },
  });

  it('a supervisor: the Call log\'s row facts, the notes, the Call page of a call filed under a campaign; none for a call filed under none', () => {
    const entries = buildTimeline(page({
      inboundCalls: [inboundCall(uid(700), '2026-10-06T10:00:00Z', { webrtc_call_id: 'leg-1', recording_requested: true }), missedCall(uid(701), '2026-10-05T10:00:00Z')],
      mediaLegs: new Map([['leg-1', { recording_url: 'https://r/1' }]]),
    }));
    expect(entries.map((e) => e.key)).toEqual([`inbound_call:${uid(700)}`, `inbound_call:${uid(701)}`]);
    expect(entries[0]).toEqual({
      key: `inbound_call:${uid(700)}`, kind: 'inbound_call', at: '2026-10-06T10:00:00.000Z', account_id: ACC_A,
      inbound_call_id: uid(700), campaign: { id: ROOT, name: 'Campaign 30', status: 'running', account_id: ACC_A, root_id: ROOT, retry_generation: 0 },
      campaign_source: 'contact', contact_id: null, line_e164: '+918000000009', route_name: 'Collections line',
      agent: { user_id: OTHER, name: 'Karan Shah' }, outcome: 'answered', disposition_code: 'ptp', talk_seconds: 75,
      notes: 'Rang about her EMI', notes_hidden: false, callback_at: null, promise_date: null, promise_amount: null,
      wait_seconds: 18, queued: false, via_sticky_agent: true, voicemail_seconds: null, follow_up: null, called_back_at: null,
      recording: 'available', call_page: { account_id: ACC_A, campaign_id: ROOT, inbound_call_id: uid(700) },
    });
    expect(entries[1]).toMatchObject({
      campaign: null, campaign_source: null, agent: null, outcome: 'voicemail', voicemail_seconds: 22, queued: true,
      follow_up: { status: 'open', reason: 'overflow', assignee: { user_id: ME, name: 'Me' }, handled_reason: null },
      called_back_at: '2026-10-05T10:20:00.000Z', recording: 'no_call', call_page: null,
    });
    // The row carries no key of the media: not the leg, not a link.
    expect(Object.keys(entries[0]!).filter((k) => /webrtc|url|voicemail_key/.test(k))).toEqual([]);
  });

  it('an agent: notes hidden on a call somebody else answered, shown on one they answered; never a Call page', () => {
    const entries = buildTimeline(page({
      viewer: viewerAs('agent'),
      inboundCalls: [inboundCall(uid(700), '2026-10-06T10:00:00Z'), inboundCall(uid(702), '2026-10-04T10:00:00Z', { agent_user_id: ME, notes: 'Mine' })],
    }));
    expect(entries[0]).toMatchObject({ notes: null, notes_hidden: true, call_page: null, disposition_code: 'ptp' });
    expect(entries[1]).toMatchObject({ notes: 'Mine', notes_hidden: false, call_page: null });
  });

  it('a campaign the read did not return is no campaign and no Call page, never a dangling id', () => {
    const [entry] = buildTimeline(page({ inboundCalls: [inboundCall(uid(700), '2026-10-06T10:00:00Z', { campaign_id: uid(39) })] }));
    expect(entry).toMatchObject({ campaign: null, campaign_source: null, call_page: null });
  });

  it('the summary counts the calls received apart from the calls placed', () => {
    const s = buildSummary(summaryData({ stats: { ...STATS, inbound_calls: 3, inbound_answered: 2 } }));
    expect(s.totals).toMatchObject({ calls: 6, connected: 4, inbound: { calls: 3, answered: 2 } });
  });

  it('the CSV: an inbound call\'s line, its outcome as the wire writes it, what only it has in Details', () => {
    const entries = buildTimeline(page({
      inboundCalls: [inboundCall(uid(700), '2026-10-06T10:00:00Z', { promise_date: '2026-11-25', promise_amount: '4500.00' }), missedCall(uid(701), '2026-10-05T10:00:00Z')],
    }));
    const lines = customerHistoryCsv(entries, '+919876543210', () => 'North').trim().split('\n');
    expect(lines[1]).toBe([
      '2026-10-06T10:00:00.000Z', 'Inbound call', "'+919876543210", 'North', 'Campaign 30', 'Karan Shah', 'answered', 'ptp', '75',
      'Rang about her EMI', '', '', 'No call',
      '"Rang +918000000009; Route: Collections line; Waited 18 seconds; Came through their agent; Promised to pay: 2026-11-25, amount 4500.00"',
    ].join(','));
    expect(lines[2]).toContain('voicemail');
    expect(lines[2]).toContain('Rang +918000000009; Waited 100 seconds; Voicemail 22 seconds; Missed: overflow; Follow-up: open; Assigned to: Me; Called back 2026-10-05T10:20:00.000Z (UTC)');
  });
});

describe('the summary', () => {
  it('one row per retry chain, totals, open callbacks and overrides, live calls, filter options', () => {
    const c1 = contact(uid(100), { created_at: new Date('2026-10-01T09:00:00Z'), placed: 2 });
    const c1retry = contact(uid(101), { root_contact_id: uid(100), campaign_id: RETRY, created_at: new Date('2026-10-20T09:00:00Z'),
      last_disposition: 'callback', last_outcome: 'connected', assigned_user_id: ME, placed: 2,
      override_disposition: 'ptp', override_extra_attempts: 2, override_retry_delay: true, override_granted_at: new Date('2026-11-04T08:00:00Z') });
    const s = buildSummary(summaryData({
      contacts: [c1retry, c1],
      stats: STATS,
      lastPlaced: { channel: 'campaign', id: uid(203), dialed_at: new Date('2026-11-06T09:59:30Z'), agent_user_id: OTHER, outcome: null, disposition_code: null },
      liveCalls: [{ channel: 'campaign', id: uid(203), campaign_id: RETRY, agent_user_id: OTHER, started_at: new Date('2026-11-06T09:59:30Z') }],
      bookings: new Map([[uid(101), OTHER]]),
      dnc: [dnc(uid(400), '2026-10-03T10:00:00Z', { account_id: null, campaign_id: ROOT, effective_account_id: ACC_A })],
    }));
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
    expect('contacts_truncated' in s).toBe(false);
    expect(s.totals).toEqual({ calls: 6, connected: 4, inbound: { calls: 0, answered: 0 }, last_contacted: {
      at: '2026-11-06T09:59:30.000Z', channel: 'campaign', agent: { user_id: OTHER, name: 'Karan Shah' }, outcome: null, disposition_code: null,
    } });
    expect(s.open.callbacks).toEqual([expect.objectContaining({
      contact_id: uid(101), due_at: '2026-11-07T05:30:00.000Z', owner: { user_id: ME, name: 'Me' },
      booked_by: { user_id: OTHER, name: 'Karan Shah' }, disposition_code: 'callback',
    })]);
    expect(s.open.overrides).toEqual([expect.objectContaining({
      contact_id: uid(101), disposition_code: 'ptp', extra_attempts: 2, retry_delay: true, calling_hours: false,
      follow_up_at: '2026-11-07T05:30:00.000Z',
    })]);
    expect(s.open.live_calls).toEqual([{ channel: 'campaign', campaign: expect.objectContaining({ id: RETRY }), agent: { user_id: OTHER, name: 'Karan Shah' }, started_at: '2026-11-06T09:59:30.000Z' }]);
    expect(s.filter_options).toEqual({
      campaigns: [{ id: ROOT, name: 'Campaign 30' }],
      agents: [{ user_id: OTHER, name: 'Karan Shah' }, { user_id: ME, name: 'Me' }],
      outcomes: ['connected', 'no_answer'],
      disposition_codes: ['callback', 'ptp'],
    });
    expect(s.dnc).toEqual([expect.objectContaining({ id: uid(400), scope: 'campaign', account_id: ACC_A, campaign: { id: ROOT, name: 'Campaign 30' } })]);
    expect(entryCount(STATS, 1)).toBe(10);
  });

  it('an override with every grant spent is not open; a grant on a contact not waiting to be dialled has no follow-up', () => {
    const spent = contact(uid(100), { override_disposition: 'ptp', override_extra_attempts: 0, override_retry_delay: false, override_calling_hours: false });
    const hoursOnly = contact(uid(102), { override_disposition: 'ptp', override_calling_hours: true, state: 'completed' });
    const s = buildSummary(summaryData({ contacts: [spent, hoursOnly] }));
    expect(s.open.overrides).toEqual([expect.objectContaining({ contact_id: uid(102), calling_hours: true, follow_up_at: null })]);
  });

  it('the contact cap says so', () => {
    expect(buildSummary(summaryData({ contacts: [contact(uid(100))], contactsTruncated: true })).contacts_truncated).toBe(true);
  });

  it('a household line: two rows on one number in one campaign stay two rows', () => {
    const s = buildSummary(summaryData({ contacts: [contact(uid(100)), contact(uid(102), { context: { Name: 'Ravi' } })] }));
    expect(s.contacts.map((c) => c.contact_id).sort()).toEqual([uid(100), uid(102)]);
  });

  it('a callback the contact is no longer waiting on is not open', () => {
    const s = buildSummary(summaryData({ contacts: [contact(uid(100), { last_disposition: 'callback', last_outcome: 'no_answer' })] }));
    expect(s.open.callbacks).toEqual([]);
    const done = buildSummary(summaryData({ contacts: [contact(uid(100), { last_disposition: 'callback', last_outcome: 'connected', state: 'completed' })] }));
    expect(done.open.callbacks).toEqual([]);
  });

  it('nothing: an empty answer', () => {
    expect(buildSummary(summaryData())).toEqual({
      contacts: [], totals: { calls: 0, connected: 0, inbound: { calls: 0, answered: 0 }, last_contacted: null }, dnc: [],
      open: { callbacks: [], overrides: [], live_calls: [] },
      filter_options: { campaigns: [], agents: [], outcomes: [], disposition_codes: [] },
    });
  });
});

describe('the CSV', () => {
  it('British English headers, one row per entry, hidden notes say so, a redial in words', () => {
    const entries = buildTimeline(fullPage({ viewer: viewerAs('agent') }));
    const csv = customerHistoryCsv(entries, '+919876543210', (id) => (id === ACC_A ? 'North' : null));
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(CUSTOMER_HISTORY_CSV_HEADERS.join(','));
    expect(lines).toHaveLength(entries.length + 1);
    expect(lines[0]).toContain('Talk time (seconds)');
    const theirs = lines.find((l) => l.includes('Soft-phone call') && l.includes('Karan Shah'))!;
    expect(theirs).toContain(',Hidden,');
    expect(csv).not.toContain('Theirs');
    expect(csv).toContain('Callback booked');
    expect(csv).toContain('Recording expired');
    expect(csv).toContain('Marked do-not-call');
    // A redial reads as words, never as the first attempt's UUID.
    const redial = lines.find((l) => l.includes('Attempt 2'))!;
    expect(redial).toContain('Wrap-up redial 1');
    expect(redial).not.toContain(uid(200));
  });

  it('the automatic outcome goes in "Details", leaving every column where it was', () => {
    const entries = buildTimeline(page({
      attempts: [
        attempt(uid(7), '2026-10-07T09:00:00Z', { outcome: 'busy', disposition_code: null, auto_disposition_code: 'callback' }),
        attempt(uid(8), '2026-10-08T09:00:00Z'),
      ],
    }));
    const csv = customerHistoryCsv(entries, '+919876543210', () => null);
    const [header, newer, older] = csv.trimEnd().split('\n');
    expect(header).toBe(CUSTOMER_HISTORY_CSV_HEADERS.join(','));
    expect(CUSTOMER_HISTORY_CSV_HEADERS.at(-1)).toBe('Details');
    // "Outcome code" stays what a person recorded: empty on the unanswered call.
    const code = CUSTOMER_HISTORY_CSV_HEADERS.indexOf('Outcome code');
    expect(older!.split(',')[code]).toBe('');
    expect(older!.split(',').at(-1)).toBe('Attempt 1; Automatic outcome: callback');
    expect(newer!.split(',')[code]).toBe('ptp');
    expect(newer).not.toContain('Automatic outcome');
  });

  it('every cell that starts like a formula (= + - @) is written as text', () => {
    const entries = buildTimeline(page({
      attempts: [
        attempt(uid(1), '2026-10-01T00:00:00Z', { notes: '=HYPERLINK("http://x","y")' }),
        attempt(uid(2), '2026-10-02T00:00:00Z', { notes: '@SUM(A1:A2)' }),
        attempt(uid(3), '2026-10-03T00:00:00Z', { notes: '-2+3' }),
      ],
    }));
    const csv = customerHistoryCsv(entries, '+919876543210', () => null);
    expect(csv).toContain(`'+919876543210`);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csv).toContain(`'@SUM(A1:A2)`);
    expect(csv).toContain(`'-2+3`);
    for (const line of csv.trimEnd().split('\n').slice(1)) {
      for (const cell of line.split(',')) expect(cell, line).not.toMatch(/^"?[=+\-@]/);
    }
  });
});
