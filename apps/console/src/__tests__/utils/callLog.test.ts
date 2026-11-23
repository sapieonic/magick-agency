import { describe, it, expect } from 'vitest';
import {
  pairedTime,
  CALL_LOG_INBOUND_OUTCOME_OPTIONS,
  CALL_LOG_STATUS_OPTIONS,
  callBackFact,
  callLogBadges,
  callLogCountCopy,
  callLogEmptyState,
  callLogOpening,
  callLogOutcomeFilterLabel,
  callLogOutcomePlaceholder,
  callLogParams,
  callLogRowKey,
  callLogRowPath,
  callLogStatusLabel,
  callLogTypeFacts,
  callLogViewFromParams,
  callLogWhatHappened,
  campaignCallLogPath,
  effectiveCallLogFilters,
  followUpCopy,
  inboundAgentCopy,
  isCallLogFiltered,
  isMissedInbound,
  isNotDialled,
  lastSevenDays,
  manualCallsRedirectPath,
  onOpeningView,
  onlyDatesNarrow,
  pairedRowKey,
  stoppedByInbound,
  visibleCallLogChips,
  type CallLogView,
} from '../../utils/agency/callLog';
import { localDay } from '../../utils/format/date';
import { ALL_CALLS_CAMPAIGN_PARAM, allCallsPath, softphoneCallsRedirectPath, unfiledCallsPath } from '../../utils/agency/callLog';
import { campaignAttemptFiltersFromParams } from '../../utils/agencyCampaignAttemptParams';
import type { AgencyCallLogDiallerRow, AgencyCallLogInboundRow, AgencyCallLogSoftphoneRow } from '../../types/agency-call-log';

/**
 * The campaign Call log's rules (docs/call-log.md, CL11): the chip and the opening day in the
 * URL, which chips show, and how a row of each type reads. The page's own behaviour is in
 * `pages/AgencyCampaignAttemptsPage.test.tsx`.
 */

const DIALLER = {
  type: 'dialler', id: 'a-1', attempt_number: 2, redial_number: 0, outcome: 'no_answer', state: 'ended', dialed_at: '2026-11-22T09:00:00.000Z',
} as AgencyCallLogDiallerRow;
const SOFT = {
  type: 'soft_phone', id: 'm-1', state: 'ended', outcome: 'connected', dialed_at: '2026-11-22T09:00:00.000Z',
  dnc_overridden: false, hours_overridden: false, requires_disposition: false, agent_name: 'Priya Nair',
} as AgencyCallLogSoftphoneRow;

/** 22 Nov 2026, 3:42 PM, on the reader's calendar (UTC in this suite). */
const NOW = new Date(2026, 10, 22, 15, 42);

const V = (over: Partial<CallLogView> = {}): CallLogView => ({ type: 'all', allDates: false, status: null, ...over });
const TODAY = '2026-11-22';

describe('the view in the URL', () => {
  it('reads the chip, the every-date marker and the status, and treats anything else as All, the opening dates and no status', () => {
    expect(callLogViewFromParams(new URLSearchParams(''))).toEqual(V());
    expect(callLogViewFromParams(new URLSearchParams('type=soft_phone&dates=all&status=awaiting_outcome')))
      .toEqual({ type: 'soft_phone', allDates: true, status: 'awaiting_outcome' });
    expect(callLogViewFromParams(new URLSearchParams('type=dialler'))).toEqual(V({ type: 'dialler' }));
    // A type or status this build does not know (a link from a newer one) and a mangled marker.
    expect(callLogViewFromParams(new URLSearchParams('type=missed&dates=some&status=done'))).toEqual(V());
  });

  it('writes the chip only when it is not All, and every-date only when no filter says more', () => {
    expect(callLogParams({}, V()).toString()).toBe('');
    expect(callLogParams({}, V({ type: 'soft_phone' })).toString()).toBe('type=soft_phone');
    expect(callLogParams({}, V({ allDates: true })).toString()).toBe('dates=all');
    expect(callLogParams({ outcome: ['busy'] }, V({ type: 'dialler', allDates: true })).toString()).toBe('outcome=busy&type=dialler');
    // The status is a filter: it is written, and beside it every-date says nothing more.
    expect(callLogParams({}, V({ status: 'live', allDates: true })).toString()).toBe('status=live');
  });

  it('round-trips, and the view’s keys are not attempt filters', () => {
    const view = V({ type: 'soft_phone', status: 'settled' });
    const params = callLogParams({ phone: '98765', placed: '1' }, view);
    expect(campaignAttemptFiltersFromParams(params)).toEqual({ phone: '98765', placed: '1' });
    expect(callLogViewFromParams(params)).toEqual(view);
    expect(campaignAttemptFiltersFromParams(new URLSearchParams('type=soft_phone&dates=all&status=live'))).toEqual({});
  });

  it('builds the Call log’s path for a chip: where a campaign’s Soft-phone calls now live', () => {
    expect(campaignCallLogPath('c-1')).toBe('/agency/campaigns/c-1/attempts');
    expect(campaignCallLogPath('c-1', 'all')).toBe('/agency/campaigns/c-1/attempts');
    expect(campaignCallLogPath('c-1', 'soft_phone')).toBe('/agency/campaigns/c-1/attempts?type=soft_phone');
  });

  it('the old Soft-phone calls URL keeps its query and gains the chip', () => {
    expect(manualCallsRedirectPath('c-1', '')).toBe('/agency/campaigns/c-1/attempts?type=soft_phone');
    expect(manualCallsRedirectPath('c-1', '?phone=98765&dates=all')).toBe('/agency/campaigns/c-1/attempts?phone=98765&dates=all&type=soft_phone');
    // A `type` of its own cannot land it on another chip.
    expect(manualCallsRedirectPath('c-1', '?type=dialler&outcome=busy')).toBe('/agency/campaigns/c-1/attempts?type=soft_phone&outcome=busy');
  });
});

describe('the account’s All calls (CL34)', () => {
  it('the account’s old Soft-phone calls URL lands on All calls with the chip on, its query kept', () => {
    expect(softphoneCallsRedirectPath('')).toBe('/agency/calls?type=soft_phone');
    expect(softphoneCallsRedirectPath('?agent_user_id=u-1&from=2026-11-01T00%3A00%3A00.000Z'))
      .toBe('/agency/calls?agent_user_id=u-1&from=2026-11-01T00%3A00%3A00.000Z&type=soft_phone');
    expect(softphoneCallsRedirectPath('?type=inbound')).toBe('/agency/calls?type=soft_phone');
  });

  it('builds its path for a chip and a campaign', () => {
    expect(allCallsPath()).toBe('/agency/calls');
    expect(allCallsPath({ type: 'to_follow_up' })).toBe('/agency/calls?type=to_follow_up');
    expect(allCallsPath({ campaign: 'none' })).toBe('/agency/calls?campaign_id=none');
  });

  it('Settings › Calls’ count of unfiled calls leads to those calls: no campaign, the same days', () => {
    const params = new URLSearchParams(unfiledCallsPath(30, new Date(2026, 10, 22, 15, 0)).split('?')[1]);
    expect(params.get(ALL_CALLS_CAMPAIGN_PARAM)).toBe('none');
    expect(new Date(params.get('from')!).toISOString()).toBe(new Date(2026, 9, 23, 0, 0, 0, 0).toISOString());
    expect(new Date(params.get('to')!).getTime()).toBe(new Date(2026, 10, 23, 0, 0, 0, 0).getTime() - 1);
  });

  it('an empty list speaks of the account, and a chosen campaign is a filter like any other', () => {
    const today = { from: '2026-11-22T00:00:00.000Z', to: '2026-11-22T23:59:59.999Z' };
    const view = { type: 'all' as const, status: null };
    expect(callLogEmptyState(today, view, { where: 'account', campaignChosen: false }))
      .toMatchObject({ kind: 'dates', title: 'No calls in this account for these dates.' });
    expect(callLogEmptyState(today, view, { where: 'account', campaignChosen: true }).kind).toBe('filtered');
    expect(callLogEmptyState({}, { type: 'to_follow_up', status: null }, { where: 'account', campaignChosen: false }).title)
      .toBe('Nobody is waiting for a call back in this account.');
    // The campaign's own words are unchanged.
    expect(callLogEmptyState(today, view).title).toBe('No calls on this campaign for these dates.');
  });
});

describe('the soft-phone status filter', () => {
  it('offers the Soft-phone calls list’s three statuses, in its words', () => {
    expect(CALL_LOG_STATUS_OPTIONS).toEqual([
      { value: 'live', label: 'On a call now' },
      { value: 'awaiting_outcome', label: 'Waiting for an outcome' },
      { value: 'settled', label: 'Done' },
    ]);
    expect(callLogStatusLabel('awaiting_outcome')).toBe('Waiting for an outcome');
  });

  it('counts as a filter', () => {
    expect(isCallLogFiltered({}, { status: 'live' })).toBe(true);
    expect(isCallLogFiltered({}, { status: null })).toBe(false);
    expect(isCallLogFiltered({ phone: '9' }, { status: null })).toBe(true);
  });
});

describe('the dates the list opens on', () => {
  it('a live campaign opens on today; a finished or archived one on every date', () => {
    for (const status of ['draft', 'running', 'paused', 'stopping']) expect(callLogOpening({ status }), status).toBe('today');
    for (const status of ['stopped', 'completed']) expect(callLogOpening({ status }), status).toBe('all');
    expect(callLogOpening({ status: 'draft', archived_at: '2026-11-20T10:00:00.000Z' })).toBe('all');
    expect(callLogOpening({ status: 'running', archived_at: null })).toBe('today');
  });

  it('the opening view is a URL with no filter, whatever chip is on', () => {
    expect(onOpeningView({}, V())).toBe(true);
    expect(onOpeningView({}, V({ type: 'soft_phone' }))).toBe(true);
    expect(onOpeningView({}, V({ allDates: true }))).toBe(false);
    expect(onOpeningView({}, V({ status: 'live' }))).toBe(false);
    expect(onOpeningView({ contact_id: 'c-1' }, V())).toBe(false);
  });

  it('reads today on a live campaign’s opening view, and every date on a finished one’s', () => {
    expect(localDay(NOW)).toBe(TODAY);
    expect(effectiveCallLogFilters({}, V(), 'today', TODAY)).toEqual({
      from: '2026-11-22T00:00:00.000Z', to: '2026-11-22T23:59:59.999Z',
    });
    expect(effectiveCallLogFilters({}, V({ type: 'soft_phone' }), 'today', TODAY)).toEqual({
      from: '2026-11-22T00:00:00.000Z', to: '2026-11-22T23:59:59.999Z',
    });
    expect(effectiveCallLogFilters({}, V(), 'all', TODAY)).toEqual({});
    // The day is the caller's to hold: the next one gives the next day's range.
    expect(effectiveCallLogFilters({}, V(), 'today', '2026-11-23').from).toBe('2026-11-23T00:00:00.000Z');
  });

  it('is never forced on a link that carries a filter, or one that asked for every date', () => {
    for (const filters of [{ contact_id: 'c-1' }, { outcome: ['abandoned'] }, { dialed_from: '2026-08-17T00:00:00.000Z' }, { placed: '1' as const }]) {
      expect(effectiveCallLogFilters(filters, V(), 'today', TODAY)).toBe(filters);
    }
    expect(effectiveCallLogFilters({}, V({ allDates: true }), 'today', TODAY)).toEqual({});
    expect(effectiveCallLogFilters({}, V({ status: 'awaiting_outcome' }), 'today', TODAY)).toEqual({});
  });

  it('the last seven days end today and start six days back, across a month', () => {
    expect(lastSevenDays(NOW)).toEqual({ from: '2026-11-16T00:00:00.000Z', to: '2026-11-22T23:59:59.999Z' });
    expect(lastSevenDays(new Date(2026, 11, 3, 9))).toEqual({ from: '2026-11-27T00:00:00.000Z', to: '2026-12-03T23:59:59.999Z' });
  });

  it('knows when only the dates narrow the list', () => {
    const none = { status: null };
    expect(onlyDatesNarrow({ from: 'a', to: 'b' }, none)).toBe(true);
    expect(onlyDatesNarrow({ to: 'b' }, none)).toBe(true);
    expect(onlyDatesNarrow({}, none)).toBe(false);
    expect(onlyDatesNarrow({ from: 'a', outcome: ['busy'] }, none)).toBe(false);
    expect(onlyDatesNarrow({ dialed_from: 'a' }, none)).toBe(false);
    expect(onlyDatesNarrow({ from: 'a' }, { status: 'live' })).toBe(false);
  });
});

describe('the chips', () => {
  const counts = { all: 1326, dialler: 1240, soft_phone: 86, inbound: 0, to_follow_up: 0 };

  it('are All · Dialler · Soft phone with their counts, in that order', () => {
    expect(visibleCallLogChips(counts, 'all', { softphoneEnabled: true, inboundEnabled: false })).toEqual([
      { id: 'all', label: 'All', count: 1326 },
      { id: 'dialler', label: 'Dialler', count: 1240 },
      { id: 'soft_phone', label: 'Soft phone', count: 86 },
    ]);
  });

  it('carry no number before the server has counted', () => {
    expect(visibleCallLogChips(null, 'all', { softphoneEnabled: true, inboundEnabled: false }).map((c) => c.count)).toEqual([null, null, null]);
  });

  it('drop a type that is switched off and has no call, and with one type left show nothing', () => {
    const none = { all: 4, dialler: 4, soft_phone: 0, inbound: 0, to_follow_up: 0 };
    expect(visibleCallLogChips(none, 'all', { softphoneEnabled: false, inboundEnabled: false })).toEqual([]);
    expect(visibleCallLogChips(null, 'dialler', { softphoneEnabled: false, inboundEnabled: false })).toEqual([]);
    // Switched off, calls in the range: shown (SR5). Switched on, none: shown.
    expect(visibleCallLogChips({ all: 5, dialler: 4, soft_phone: 1, inbound: 0, to_follow_up: 0 }, 'all', { softphoneEnabled: false, inboundEnabled: false })).toHaveLength(3);
    expect(visibleCallLogChips(none, 'all', { softphoneEnabled: true, inboundEnabled: false })).toHaveLength(3);
  });

  it('always show the chip that is on, so a link to it can be left', () => {
    expect(visibleCallLogChips({ all: 4, dialler: 4, soft_phone: 0, inbound: 0, to_follow_up: 0 }, 'soft_phone', { softphoneEnabled: false, inboundEnabled: false }).map((c) => c.id))
      .toEqual(['all', 'dialler', 'soft_phone']);
  });

  it('word the count line with a count, and without one never as "N of M"', () => {
    expect(callLogCountCopy(50, 1234, true)).toBe('1,234 calls — showing 50');
    expect(callLogCountCopy(1, 1, false)).toBe('1 call');
    expect(callLogCountCopy(3, 3, false)).toBe('3 calls');
    expect(callLogCountCopy(50, null, true)).toBe('Showing 50 calls — there are more');
    expect(callLogCountCopy(1, null, false)).toBe('Showing 1 call');
    // A row that never dialled is listed and not counted: never "2 calls — showing 3".
    expect(callLogCountCopy(3, 2, false)).toBe('2 calls');
  });
});

describe('the empty list', () => {
  const view = (type: CallLogView['type'], status: CallLogView['status'] = null) => ({ type, status });

  it('is about the dates when only the dates narrow it, naming the chip’s type', () => {
    const dates = { from: 'a', to: 'b' };
    expect(callLogEmptyState(dates, view('all'))).toMatchObject({ kind: 'dates', title: 'No calls on this campaign for these dates.' });
    expect(callLogEmptyState(dates, view('dialler')).title).toBe('No dialler calls on this campaign for these dates.');
    expect(callLogEmptyState(dates, view('soft_phone')).title).toBe('No soft-phone calls on this campaign for these dates.');
  });

  it('is about the filters when anything else narrows it, the status included', () => {
    expect(callLogEmptyState({ from: 'a', outcome: ['busy'] }, view('all'))).toMatchObject({ kind: 'filtered', title: 'Nothing matches those filters' });
    expect(callLogEmptyState({ contact_id: 'c-1' }, view('soft_phone')).kind).toBe('filtered');
    expect(callLogEmptyState({ from: 'a', to: 'b' }, view('all', 'awaiting_outcome')).kind).toBe('filtered');
    expect(callLogEmptyState({}, view('dialler', 'live')).kind).toBe('filtered');
  });

  it('is about the campaign only with every date and no filter', () => {
    expect(callLogEmptyState({}, view('all'))).toMatchObject({ kind: 'none', title: 'No calls were placed' });
    expect(callLogEmptyState({}, view('soft_phone'))).toMatchObject({ kind: 'none', title: 'No soft-phone calls on this campaign' });
  });
});

describe('how a row reads', () => {
  it('a dialler row’s own facts are its try and whether it was a redial', () => {
    expect(callLogTypeFacts(DIALLER)).toEqual(['Try 2']);
    expect(callLogTypeFacts({ ...DIALLER, attempt_number: 1, redial_number: 2 })).toEqual(['Try 1', 'redial']);
    // A server that predates wrap-up redials sends no `redial_number`.
    expect(callLogTypeFacts({ ...DIALLER, redial_number: undefined })).toEqual(['Try 2']);
    expect(callLogTypeFacts(SOFT)).toEqual([]);
  });

  it('a soft-phone row’s overrides are badges, in the Soft-phone calls list’s words', () => {
    expect(callLogBadges(SOFT)).toEqual([]);
    expect(callLogBadges({ ...SOFT, dnc_overridden: true, hours_overridden: true }).map((b) => b.label)).toEqual(['DNC override', 'Hours override']);
    expect(callLogBadges(DIALLER)).toEqual([]);
  });

  it('only a soft-phone call that ended without dialling is Not dialled', () => {
    expect(isNotDialled({ ...SOFT, dialed_at: null })).toBe(true);
    expect(isNotDialled(SOFT)).toBe(false);
    // Still queued: about to dial, not a failure to.
    expect(isNotDialled({ ...SOFT, dialed_at: null, state: 'queued' })).toBe(false);
    // A dialler attempt that never dialled says why in its own outcome.
    expect(isNotDialled({ ...DIALLER, dialed_at: null })).toBe(false);
  });

  it('What happened is what the line did, Not dialled, or a call still on', () => {
    expect(callLogWhatHappened(DIALLER)).toEqual({ text: 'No answer', key: 'no_answer' });
    expect(callLogWhatHappened({ ...DIALLER, outcome: null })).toEqual({ text: 'Not classified', key: 'unknown' });
    expect(callLogWhatHappened({ ...SOFT, dialed_at: null, outcome: 'failed' })).toEqual({ text: 'Not dialled', key: 'not_dialled' });
    expect(callLogWhatHappened({ ...SOFT, state: 'bridged', outcome: null })).toEqual({ text: 'On a call now', key: 'live' });
    expect(callLogWhatHappened(SOFT)).toEqual({ text: 'Connected', key: 'connected' });
  });

  it('a soft-phone call that owes its outcome says so where the outcome would be', () => {
    expect(callLogOutcomePlaceholder({ ...SOFT, requires_disposition: true })).toBe('No outcome yet');
    expect(callLogOutcomePlaceholder(SOFT)).toBe('—');
    expect(callLogOutcomePlaceholder(DIALLER)).toBe('—');
  });

  it('opens the detail page of its own type; a soft-phone call’s only with the soft phone on', () => {
    expect(callLogRowPath(DIALLER, 'c-1', { softphoneEnabled: false })).toBe('/agency/campaigns/c-1/attempts/a-1');
    expect(callLogRowPath(SOFT, 'c-1', { softphoneEnabled: true })).toBe('/agency/softphone/calls/m-1');
    expect(callLogRowPath(SOFT, 'c-1', { softphoneEnabled: false })).toBeNull();
  });
});

/**
 * Inbound calls in the log (docs/call-log.md §4, P2): the Inbound and To follow up chips, how an
 * inbound row reads, and a missed call and its call back pointing at each other.
 */
const ANSWERED = {
  type: 'inbound', id: 'i-1', campaign_id: 'c-1', campaign_source: 'contact', contact_id: 'ct-1', phone_e164: '+919876504821',
  caller_id: '+919000000001', route_name: 'Sales line', agent_user_id: 'u-priya', agent_name: 'Priya Nair', state: 'ended',
  outcome: 'answered', disposition_code: 'will_pay', talk_seconds: 252, wait_seconds: 18, queued: true, via_sticky_agent: true,
  requires_disposition: false, voicemail_seconds: null, follow_up: null, called_back: null,
  created_at: '2026-11-22T15:42:01.000Z', bridged_at: '2026-11-22T15:42:19.000Z', ended_at: '2026-11-22T15:46:31.000Z',
} as AgencyCallLogInboundRow;
const MISSED = {
  ...ANSWERED, id: 'i-2', contact_id: null, phone_e164: '+919812307730', agent_user_id: null, agent_name: null, outcome: 'overflow',
  disposition_code: null, talk_seconds: null, wait_seconds: 100, via_sticky_agent: false, bridged_at: null,
  follow_up: { status: 'open', reason: 'overflow', closed_cause: null, assignee_user_id: 'u-arjun', assignee_name: 'Arjun Mehta', handled_reason: null, handled_at: null },
  created_at: '2026-11-22T15:12:00.000Z',
} as AgencyCallLogInboundRow;
const SOFT_ROW = { type: 'soft_phone', id: 'm-9', state: 'ended', outcome: 'connected', dialed_at: '2026-11-22T15:31:01.000Z', created_at: '2026-11-22T15:31:00.000Z', callback_of: null } as AgencyCallLogSoftphoneRow;
const DIAL = { type: 'dialler', id: 'a-9', attempt_number: 1, redial_number: 0, outcome: 'canceled', state: 'ended', disposition_code: null } as AgencyCallLogDiallerRow;

describe('the Inbound and To follow up chips', () => {
  const counts = { all: 1383, dialler: 1240, soft_phone: 86, inbound: 57, to_follow_up: 6 };
  const on = { softphoneEnabled: true, inboundEnabled: true };
  const off = { softphoneEnabled: false, inboundEnabled: false };

  it('are All · Dialler · Soft phone · Inbound · To follow up, the last one marked as owed work', () => {
    expect(visibleCallLogChips(counts, 'all', on)).toEqual([
      { id: 'all', label: 'All', count: 1383 },
      { id: 'dialler', label: 'Dialler', count: 1240 },
      { id: 'soft_phone', label: 'Soft phone', count: 86 },
      { id: 'inbound', label: 'Inbound', count: 57 },
      { id: 'to_follow_up', label: 'To follow up', count: 6, warning: true },
    ]);
  });

  it('hide To follow up at 0, unless it is the chip that is on', () => {
    const none = { ...counts, to_follow_up: 0 };
    expect(visibleCallLogChips(none, 'all', on).map((c) => c.id)).toEqual(['all', 'dialler', 'soft_phone', 'inbound']);
    expect(visibleCallLogChips(none, 'to_follow_up', on).map((c) => c.id)).toContain('to_follow_up');
    expect(visibleCallLogChips(null, 'all', on).map((c) => c.id)).not.toContain('to_follow_up');
  });

  it('hide Inbound with inbound switched off and no inbound call; keep it while the range holds one', () => {
    expect(visibleCallLogChips({ ...counts, inbound: 0, to_follow_up: 0 }, 'all', { softphoneEnabled: true, inboundEnabled: false }).map((c) => c.id))
      .toEqual(['all', 'dialler', 'soft_phone']);
    expect(visibleCallLogChips({ all: 5, dialler: 4, soft_phone: 0, inbound: 1, to_follow_up: 0 }, 'all', off).map((c) => c.id))
      .toEqual(['all', 'dialler', 'inbound']);
    expect(visibleCallLogChips({ all: 4, dialler: 4, soft_phone: 0, inbound: 0, to_follow_up: 0 }, 'inbound', off).map((c) => c.id))
      .toEqual(['all', 'dialler', 'inbound']);
  });

  it('show To follow up beside All even when Dialler is the only type: an old missed call is still owed', () => {
    // Today holds no inbound call, inbound is off, and two missed calls from earlier are still open.
    expect(visibleCallLogChips({ all: 4, dialler: 4, soft_phone: 0, inbound: 0, to_follow_up: 2 }, 'all', off).map((c) => c.id))
      .toEqual(['all', 'to_follow_up']);
  });

  it('read the type from the URL, and put it back', () => {
    const view = callLogViewFromParams(new URLSearchParams('type=to_follow_up'));
    expect(view.type).toBe('to_follow_up');
    expect(callLogParams({}, view).get('type')).toBe('to_follow_up');
    expect(campaignCallLogPath('c-1', 'inbound')).toBe('/agency/campaigns/c-1/attempts?type=inbound');
  });

  it('an empty To follow up is never about the dates', () => {
    expect(callLogEmptyState({ from: 'a', to: 'b' }, { type: 'to_follow_up', status: null })).toMatchObject({
      kind: 'none', title: 'Nobody is waiting for a call back on this campaign.',
    });
    expect(callLogEmptyState({ from: 'a', phone: '7730' }, { type: 'to_follow_up', status: null }).kind).toBe('filtered');
    expect(callLogEmptyState({ from: 'a', to: 'b' }, { type: 'inbound', status: null }).title).toBe('No inbound calls on this campaign for these dates.');
  });

  it('What happened gains Missed, Voicemail and Abandoned, worded apart from the dialler’s Abandoned', () => {
    expect(CALL_LOG_INBOUND_OUTCOME_OPTIONS.map((o) => o.value)).toEqual(['missed', 'voicemail', 'abandoned_in_queue']);
    expect(callLogOutcomeFilterLabel('missed')).toBe('Missed');
    expect(callLogOutcomeFilterLabel('abandoned_in_queue')).toBe('Abandoned (hung up while waiting)');
    expect(callLogOutcomeFilterLabel('abandoned')).toBe('Abandoned (no agent free)');
    expect(callLogOutcomeFilterLabel('connected')).toBe('Connected');
  });
});

describe('how an inbound row reads', () => {
  it('its own fact is that the customer rang us', () => {
    expect(callLogTypeFacts(ANSWERED)).toEqual(['rang us']);
    expect(callLogBadges(ANSWERED)).toEqual([]);
    expect(isNotDialled(ANSWERED)).toBe(false);
  });

  it('answered: Answered, with the wait and whether they came through their own agent', () => {
    expect(isMissedInbound(ANSWERED)).toBe(false);
    expect(callLogWhatHappened(ANSWERED)).toEqual({ text: 'Answered', key: 'connected', detail: 'waited 0:18 · came through their agent' });
    expect(callLogWhatHappened({ ...ANSWERED, via_sticky_agent: false }).detail).toBe('waited 0:18');
    expect(inboundAgentCopy(ANSWERED)).toEqual({ text: 'Priya Nair', muted: false });
    expect(inboundAgentCopy({ ...ANSWERED, agent_name: null })).toEqual({ text: 'Former member', muted: true });
    expect(callLogOutcomePlaceholder({ ...ANSWERED, requires_disposition: true })).toBe('No outcome yet');
  });

  it('missed: Missed, with why in the Missed list’s words and the wait when the caller queued', () => {
    expect(isMissedInbound(MISSED)).toBe(true);
    expect(callLogWhatHappened(MISSED)).toEqual({ text: 'Missed', key: 'missed', detail: 'nobody free to answer · waited 1:40' });
    const abandoned = { ...MISSED, wait_seconds: 52, follow_up: { ...MISSED.follow_up!, reason: 'abandoned_in_queue' as const } };
    expect(callLogWhatHappened(abandoned).detail).toBe('hung up while waiting · 0:52');
    // Out of hours: answered with a message, never queued, so no wait is claimed.
    const closed = { ...MISSED, queued: false, follow_up: { ...MISSED.follow_up!, reason: 'closed' as const, closed_cause: 'hours' as const } };
    expect(callLogWhatHappened(closed).detail).toBe('out of hours');
    expect(callLogWhatHappened({ ...closed, follow_up: { ...closed.follow_up, closed_cause: 'switched_off' as const } }).detail).toBe('inbound switched off');
  });

  it('a missed call’s Agent cell is a dash, with who it is assigned to under it', () => {
    expect(inboundAgentCopy(MISSED)).toEqual({ text: '—', muted: true, detail: 'assigned to Arjun Mehta' });
    expect(inboundAgentCopy({ ...MISSED, follow_up: { ...MISSED.follow_up!, assignee_name: null } }).detail).toBe('assigned to a former member');
    expect(inboundAgentCopy({ ...MISSED, follow_up: { ...MISSED.follow_up!, assignee_user_id: null, assignee_name: null } })).toEqual({ text: '—', muted: true });
  });

  it('a missed call’s Outcome cell says where its follow-up stands', () => {
    expect(followUpCopy(MISSED)).toEqual({ calledBack: null, status: 'To follow up', open: true });
    const calledBack = { ...MISSED, called_back: { call_id: 'm-9', at: '2026-11-22T15:31:00.000Z' } };
    // Rung back and still open: both are said, and the row keeps its actions.
    expect(followUpCopy(calledBack)).toEqual({ calledBack: 'Called back 3:31 PM', status: 'To follow up', open: true });
    const handled = { ...MISSED.follow_up!, status: 'handled' as const, handled_reason: 'marked' as const, handled_at: '2026-11-22T16:00:00.000Z' };
    expect(followUpCopy({ ...MISSED, follow_up: handled })).toEqual({ calledBack: null, status: 'Handled', open: false });
    expect(followUpCopy({ ...MISSED, follow_up: { ...handled, handled_reason: 'reached' } }).status).toBe('Customer reached');
    // Closed and rung back: the call back says it.
    expect(followUpCopy({ ...calledBack, follow_up: { ...handled, handled_reason: 'reached' } })).toEqual({ calledBack: 'Called back 3:31 PM', status: null, open: false });
    // A call back on a later day says the day too.
    expect(followUpCopy({ ...MISSED, called_back: { call_id: 'm-9', at: '2026-11-23T09:05:00.000Z' } }).calledBack).toMatch(/^Called back 23 Nov 2026/);
  });

  it('opens the inbound Call page of its campaign, whatever the soft phone’s flag', () => {
    expect(callLogRowPath(ANSWERED, 'c-1', { softphoneEnabled: false })).toBe('/agency/campaigns/c-1/calls/inbound/i-1');
  });
});

describe('a missed call and its call back', () => {
  const callBack = { ...SOFT_ROW, callback_of: { inbound_call_id: 'i-2', arrived_at: '2026-11-22T15:12:00.000Z' } };
  const missed = { ...MISSED, called_back: { call_id: 'm-9', at: '2026-11-22T15:31:00.000Z' } };

  it('the soft-phone call stays a soft-phone call, marked as the call back to the missed call (CL1)', () => {
    expect(callBack.type).toBe('soft_phone');
    expect(callBackFact(callBack)).toBe('Call back · to the 3:12 PM missed call');
    expect(callLogTypeFacts(callBack)).toEqual(['Call back · to the 3:12 PM missed call']);
    // The missed call's row has gone (retention): still a call back, to a call we can no longer time.
    expect(callBackFact({ ...callBack, callback_of: { inbound_call_id: 'i-2', arrived_at: null } })).toBe('Call back · to a missed call');
    expect(callBackFact(SOFT_ROW)).toBeNull();
    expect(callLogTypeFacts(SOFT_ROW)).toEqual([]);
  });

  it('each names the other row, so hovering one lights the other', () => {
    expect(pairedRowKey(callBack)).toBe(callLogRowKey(missed));
    expect(pairedRowKey(missed)).toBe(callLogRowKey(callBack));
    expect(pairedRowKey(SOFT_ROW)).toBeNull();
    expect(pairedRowKey(MISSED)).toBeNull();
    expect(pairedRowKey(DIAL)).toBeNull();
  });

  it('a dial stopped because the customer rang us says so', () => {
    const stopped = { ...DIAL, disposition_code: 'inbound_call' };
    expect(stoppedByInbound(stopped)).toBe(true);
    expect(callLogWhatHappened(stopped)).toEqual({ text: 'Stopped: customer rang us', key: 'canceled' });
    expect(stoppedByInbound(DIAL)).toBe(false);
    expect(callLogWhatHappened(DIAL).text).toBe('Stopped by us before answer');
  });
});

describe('pairedTime', () => {
  it('says the clock time on the same day, the day too on another', () => {
    expect(pairedTime('2026-11-21T15:12:00.000Z', '2026-11-21T18:00:00.000Z')).toBe('3:12 PM');
    expect(pairedTime('2026-11-20T15:12:00.000Z', new Date('2026-11-21T18:00:00.000Z'))).toContain('20 Nov');
  });

  it('never says "NaN" when a time cannot be read', () => {
    expect(pairedTime('not a time', 'not a time')).not.toContain('NaN');
    expect(pairedTime('2026-11-21T15:12:00.000Z', new Date(Number.NaN))).not.toContain('NaN');
  });
});
