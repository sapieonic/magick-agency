import { describe, it, expect } from 'vitest';
import {
  CALL_LOG_STATUS_OPTIONS,
  callLogBadges,
  callLogCountCopy,
  callLogEmptyState,
  callLogOpening,
  callLogOutcomePlaceholder,
  callLogParams,
  callLogRowPath,
  callLogStatusLabel,
  callLogTypeFacts,
  callLogViewFromParams,
  callLogWhatHappened,
  campaignCallLogPath,
  effectiveCallLogFilters,
  isCallLogFiltered,
  isNotDialled,
  lastSevenDays,
  localDay,
  manualCallsRedirectPath,
  onOpeningView,
  onlyDatesNarrow,
  selectedCallLogCount,
  visibleCallLogChips,
  type CallLogView,
} from '../../utils/agency/callLog';
import { SOFTPHONE_CALL_STATUS_OPTIONS } from '../../utils/softphone/callStats';
import { campaignAttemptFiltersFromParams } from '../../utils/agencyCampaignAttemptParams';
import type { AgencyCallLogDiallerRow, AgencyCallLogSoftphoneRow } from '../../types/agency-call-log';

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
    expect(callLogViewFromParams(new URLSearchParams('type=inbound&dates=some&status=done'))).toEqual(V());
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

describe('the soft-phone status filter', () => {
  it('offers the Soft-phone calls list’s three statuses, in its words', () => {
    expect(CALL_LOG_STATUS_OPTIONS).toEqual([
      { value: 'live', label: 'On a call now' },
      { value: 'awaiting_outcome', label: 'Waiting for an outcome' },
      { value: 'settled', label: 'Done' },
    ]);
    // The same words as the account's Soft-phone calls list, which still has the filter.
    expect(CALL_LOG_STATUS_OPTIONS).toEqual(SOFTPHONE_CALL_STATUS_OPTIONS);
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
  const counts = { all: 1326, dialler: 1240, soft_phone: 86 };

  it('are All · Dialler · Soft phone with their counts, in that order', () => {
    expect(visibleCallLogChips(counts, 'all', { softphoneEnabled: true })).toEqual([
      { id: 'all', label: 'All', count: 1326 },
      { id: 'dialler', label: 'Dialler', count: 1240 },
      { id: 'soft_phone', label: 'Soft phone', count: 86 },
    ]);
  });

  it('carry no number before the server has counted', () => {
    expect(visibleCallLogChips(null, 'all', { softphoneEnabled: true }).map((c) => c.count)).toEqual([null, null, null]);
  });

  it('drop a type that is switched off and has no call, and with one type left show nothing', () => {
    const none = { all: 4, dialler: 4, soft_phone: 0 };
    expect(visibleCallLogChips(none, 'all', { softphoneEnabled: false })).toEqual([]);
    expect(visibleCallLogChips(null, 'dialler', { softphoneEnabled: false })).toEqual([]);
    // Switched off, calls in the range: shown (SR5). Switched on, none: shown.
    expect(visibleCallLogChips({ all: 5, dialler: 4, soft_phone: 1 }, 'all', { softphoneEnabled: false })).toHaveLength(3);
    expect(visibleCallLogChips(none, 'all', { softphoneEnabled: true })).toHaveLength(3);
  });

  it('always show the chip that is on, so a link to it can be left', () => {
    expect(visibleCallLogChips({ all: 4, dialler: 4, soft_phone: 0 }, 'soft_phone', { softphoneEnabled: false }).map((c) => c.id))
      .toEqual(['all', 'dialler', 'soft_phone']);
  });

  it('give the count of the chip that is on', () => {
    expect(selectedCallLogCount(counts, 'all')).toBe(1326);
    expect(selectedCallLogCount(counts, 'soft_phone')).toBe(86);
    expect(selectedCallLogCount(null, 'all')).toBeNull();
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
