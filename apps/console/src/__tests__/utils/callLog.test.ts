import { describe, it, expect } from 'vitest';
import {
  callLogBadges,
  callLogCountCopy,
  callLogEmptyState,
  callLogOutcomePlaceholder,
  callLogParams,
  callLogRowPath,
  callLogTypeFacts,
  callLogViewFromParams,
  callLogWhatHappened,
  campaignCallLogPath,
  effectiveCallLogFilters,
  isNotDialled,
  lastSevenDays,
  localDay,
  onlyDatesNarrow,
  opensOnToday,
  selectedCallLogCount,
  visibleCallLogChips,
} from '../../utils/agency/callLog';
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

describe('the view in the URL', () => {
  it('reads the chip and the every-date marker, and treats anything else as All and today', () => {
    expect(callLogViewFromParams(new URLSearchParams(''))).toEqual({ type: 'all', allDates: false });
    expect(callLogViewFromParams(new URLSearchParams('type=soft_phone&dates=all'))).toEqual({ type: 'soft_phone', allDates: true });
    expect(callLogViewFromParams(new URLSearchParams('type=dialler'))).toEqual({ type: 'dialler', allDates: false });
    // A type this build does not know (a link from a newer one) and a mangled marker.
    expect(callLogViewFromParams(new URLSearchParams('type=inbound&dates=some'))).toEqual({ type: 'all', allDates: false });
  });

  it('writes the chip only when it is not All, and every-date only when no filter says more', () => {
    expect(callLogParams({}, { type: 'all', allDates: false }).toString()).toBe('');
    expect(callLogParams({}, { type: 'soft_phone', allDates: false }).toString()).toBe('type=soft_phone');
    expect(callLogParams({}, { type: 'all', allDates: true }).toString()).toBe('dates=all');
    expect(callLogParams({ outcome: ['busy'] }, { type: 'dialler', allDates: true }).toString()).toBe('outcome=busy&type=dialler');
  });

  it('round-trips, and the view’s keys are not filters', () => {
    const params = callLogParams({ phone: '98765', placed: '1' }, { type: 'soft_phone', allDates: false });
    expect(campaignAttemptFiltersFromParams(params)).toEqual({ phone: '98765', placed: '1' });
    expect(callLogViewFromParams(params)).toEqual({ type: 'soft_phone', allDates: false });
    expect(campaignAttemptFiltersFromParams(new URLSearchParams('type=soft_phone&dates=all'))).toEqual({});
  });

  it('builds the Call log’s path for a chip: where a campaign’s Soft-phone calls now live', () => {
    expect(campaignCallLogPath('c-1')).toBe('/agency/campaigns/c-1/attempts');
    expect(campaignCallLogPath('c-1', 'all')).toBe('/agency/campaigns/c-1/attempts');
    expect(campaignCallLogPath('c-1', 'soft_phone')).toBe('/agency/campaigns/c-1/attempts?type=soft_phone');
  });
});

describe('the day the list opens on', () => {
  it('is today when the URL carries no filter, whatever chip is on', () => {
    expect(opensOnToday({}, { type: 'all', allDates: false })).toBe(true);
    expect(opensOnToday({}, { type: 'soft_phone', allDates: false })).toBe(true);
    expect(localDay(NOW)).toBe('2026-11-22');
    expect(effectiveCallLogFilters({}, { type: 'all', allDates: false }, NOW)).toEqual({
      from: '2026-11-22T00:00:00.000Z', to: '2026-11-22T23:59:59.999Z',
    });
  });

  it('is never forced on a link that carries a filter, or one that asked for every date', () => {
    const view = { type: 'all', allDates: false } as const;
    for (const filters of [{ contact_id: 'c-1' }, { outcome: ['abandoned'] }, { dialed_from: '2026-08-17T00:00:00.000Z' }, { placed: '1' as const }]) {
      expect(opensOnToday(filters, view)).toBe(false);
      expect(effectiveCallLogFilters(filters, view, NOW)).toBe(filters);
    }
    expect(effectiveCallLogFilters({}, { type: 'all', allDates: true }, NOW)).toEqual({});
  });

  it('the last seven days end today and start six days back, across a month', () => {
    expect(lastSevenDays(NOW)).toEqual({ from: '2026-11-16T00:00:00.000Z', to: '2026-11-22T23:59:59.999Z' });
    expect(lastSevenDays(new Date(2026, 11, 3, 9))).toEqual({ from: '2026-11-27T00:00:00.000Z', to: '2026-12-03T23:59:59.999Z' });
  });

  it('knows when only the dates narrow the list', () => {
    expect(onlyDatesNarrow({ from: 'a', to: 'b' })).toBe(true);
    expect(onlyDatesNarrow({ to: 'b' })).toBe(true);
    expect(onlyDatesNarrow({})).toBe(false);
    expect(onlyDatesNarrow({ from: 'a', outcome: ['busy'] })).toBe(false);
    expect(onlyDatesNarrow({ dialed_from: 'a' })).toBe(false);
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
  it('is about the dates when only the dates narrow it, naming the chip’s type', () => {
    const dates = { from: 'a', to: 'b' };
    expect(callLogEmptyState(dates, 'all')).toMatchObject({ kind: 'dates', title: 'No calls on this campaign for these dates.' });
    expect(callLogEmptyState(dates, 'dialler').title).toBe('No dialler calls on this campaign for these dates.');
    expect(callLogEmptyState(dates, 'soft_phone').title).toBe('No soft-phone calls on this campaign for these dates.');
  });

  it('is about the filters when anything else narrows it', () => {
    expect(callLogEmptyState({ from: 'a', outcome: ['busy'] }, 'all')).toMatchObject({ kind: 'filtered', title: 'Nothing matches those filters' });
    expect(callLogEmptyState({ contact_id: 'c-1' }, 'soft_phone').kind).toBe('filtered');
  });

  it('is about the campaign only with every date and no filter', () => {
    expect(callLogEmptyState({}, 'all')).toMatchObject({ kind: 'none', title: 'No calls were placed' });
    expect(callLogEmptyState({}, 'soft_phone')).toMatchObject({ kind: 'none', title: 'No soft-phone calls on this campaign' });
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
