import { describe, expect, it } from 'vitest';
import {
  offeredUnconnectedActions,
  UNCONNECTED_ACTION_LABELS,
  configFromDraft,
  createRequestFromDraft,
  draftChanged,
  draftFromRoute,
  hoursRowLabel,
  isOvernight,
  newRouteDraft,
  numberAvailability,
  patchFromDraft,
  routeErrorsFromDetails,
  validateRouteDraft,
  weekdayHours,
  weeklyHoursSummary,
} from '../../utils/inbound/routeForm';
import { AGENCY_INBOUND_AVAILABLE_ACTIONS, AGENCY_INBOUND_ROUTE_DEFAULTS, type AgencyInboundRoute } from '../../types/inbound';

/**
 * The inbound route editor's rules (`utils/inbound/routeForm.ts`): IB2 / §5.1 defaults for a new
 * route, the midnight mapping (a form `00:00` end is the wire's `24:00`), overnight stretches,
 * the console's own checks keyed by body path, a PATCH that carries only what changed, and why a
 * number cannot be chosen.
 */

const ROUTE: AgencyInboundRoute = {
  id: 'r-1',
  account_id: 'a-1',
  name: 'Main line',
  timezone: 'Europe/London',
  weekly_hours: [{ day: 1, start: '09:00', end: '24:00' }, { day: 5, start: '22:00', end: '02:00' }],
  holidays: [{ from: '2026-12-25', to: '2026-12-26', label: null }],
  clips: { ...AGENCY_INBOUND_ROUTE_DEFAULTS.clips, greeting: 'clip-1' },
  sticky_mode: 'loose',
  sticky_wait_seconds: 30,
  sticky_lookback_days: 30,
  pool_campaign_ids: [],
  queue_max_wait_seconds: 120,
  max_waiting: 10,
  max_concurrent: 20,
  wrapup_seconds: 45,
  after_hours_action: 'callback',
  overflow_action: 'callback',
  record_calls: false,
  recording_notice: true,
  analysis_profile_id: null,
  disposition_catalog: [],
  numbers: [{ phone_number_id: 'n-1', phone_number: '+441632960001', attached_at: '2026-11-01T00:00:00Z' }],
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
};

describe('a new route', () => {
  it('starts on the design’s defaults, open Monday to Friday 09:00–17:30 in the browser’s zone when usable', () => {
    const draft = newRouteDraft('Europe/Paris');
    expect(draft.hours).toEqual([1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:30' })));
    expect(validateRouteDraft({ ...draft, name: 'Main line' })).toEqual({});
    expect(draft).toMatchObject({
      timezone: 'Europe/Paris', stickyMode: 'loose', stickyWait: '30', stickyLookback: '30',
      queueMaxWait: '120', maxWaiting: '10', maxConcurrent: '20', wrapupSeconds: '30', afterHoursAction: 'callback', overflowAction: 'callback',
      recordCalls: false, recordingNotice: true, catalog: [], numberIds: [],
    });
    expect(newRouteDraft('Not/AZone').timezone).toBe('UTC');
    expect(newRouteDraft(undefined).timezone).toBe('UTC');
  });

  it('creates with the whole configuration and its numbers', () => {
    const draft = { ...newRouteDraft('UTC'), name: '  Sales  ', hours: weekdayHours(), numberIds: ['n-2'] };
    const body = createRequestFromDraft(draft);
    expect(body).toMatchObject({ name: 'Sales', timezone: 'UTC', phone_number_ids: ['n-2'], sticky_wait_seconds: 30, wrapup_seconds: 30 });
    expect(body.weekly_hours).toEqual([1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:30' })));
  });
});

describe('midnight and overnight', () => {
  it('shows a stored 24:00 as 00:00 and sends it back as 24:00', () => {
    const draft = draftFromRoute(ROUTE);
    expect(draft.hours[0]).toEqual({ day: 1, start: '09:00', end: '00:00' });
    expect(configFromDraft(draft).weekly_hours).toEqual(ROUTE.weekly_hours);
    // 00:00–00:00 is the whole day, not an empty stretch.
    const allDay = { ...draft, hours: [{ day: 6, start: '00:00', end: '00:00' }] };
    expect(configFromDraft(allDay).weekly_hours).toEqual([{ day: 6, start: '00:00', end: '24:00' }]);
    expect(validateRouteDraft(allDay)['weekly_hours[0].end']).toBeUndefined();
  });

  it('a closing time before the opening runs overnight; one at midnight does not', () => {
    expect(isOvernight({ day: 5, start: '22:00', end: '02:00' })).toBe(true);
    expect(isOvernight({ day: 1, start: '09:00', end: '00:00' })).toBe(false);
    expect(hoursRowLabel({ day: 5, start: '22:00', end: '02:00' })).toBe('Fri 22:00–02:00 (next day)');
    expect(hoursRowLabel({ day: 1, start: '09:00', end: '24:00' })).toBe('Mon 09:00–midnight');
    expect(weeklyHoursSummary({ weekly_hours: [] })).toMatch(/No opening hours/);
    expect(weeklyHoursSummary(ROUTE)).toBe('Mon 09:00–midnight, Fri 22:00–02:00 (next day)');
  });
});

describe('the console’s checks', () => {
  it('finds each problem at the body path the server uses', () => {
    const draft = {
      ...newRouteDraft('UTC'),
      name: ' ',
      timezone: 'EST',
      hours: [{ day: 1, start: '09:00', end: '09:00' }, { day: 2, start: '', end: '10:00' }],
      holidays: [{ from: '2026-12-26', to: '2026-12-25', label: '' }, { from: '2026-01-01', to: '2026-03-01', label: '' }],
      stickyWait: '200',
      queueMaxWait: '100',
      maxWaiting: '30',
      maxConcurrent: '20',
      stickyLookback: '1.5',
    };
    const errors = validateRouteDraft(draft);
    expect(Object.keys(errors).sort()).toEqual([
      'holidays[0].to', 'holidays[1].to', 'max_waiting', 'name', 'sticky_lookback_days', 'sticky_wait_seconds',
      'timezone', 'weekly_hours[0].end', 'weekly_hours[1].start',
    ]);
    expect(errors['holidays[1].to']).toMatch(/at most 31 days/);
    expect(errors['max_waiting']).toMatch(/count towards calls at once/);
  });

  it('holds the wrap-up time to 10–600 whole seconds (IQ52), at the server’s path', () => {
    const named = { ...newRouteDraft('UTC'), name: 'X' };
    for (const ok of ['10', '30', '600']) expect(validateRouteDraft({ ...named, wrapupSeconds: ok }), ok).toEqual({});
    for (const bad of ['9', '601', '0']) {
      expect(validateRouteDraft({ ...named, wrapupSeconds: bad })['wrapup_seconds'], bad).toBe('Wrap-up time must be between 10 and 600.');
    }
    for (const bad of ['', '12.5', 'abc']) {
      expect(validateRouteDraft({ ...named, wrapupSeconds: bad })['wrapup_seconds'], bad).toBe('Wrap-up time must be a whole number.');
    }
  });

  it('holds a customised outcome list to the campaign rules', () => {
    const draft = { ...newRouteDraft('UTC'), name: 'X', catalog: [{ code: '', label: '' }] };
    expect(Object.keys(validateRouteDraft(draft)).some((k) => k.startsWith('disposition_catalog'))).toBe(true);
  });

  it('maps the server’s details onto the same fields', () => {
    expect(routeErrorsFromDetails([{ path: 'clips.greeting', message: 'm1' }, { path: '', message: 'm2' }]))
      .toEqual({ 'clips.greeting': 'm1', form: 'm2' });
  });
});

describe('a PATCH', () => {
  it('carries only what changed, clips per slot, and the number set only when it changed', () => {
    const draft = draftFromRoute(ROUTE);
    expect(patchFromDraft(ROUTE, draft)).toEqual({});
    expect(draftChanged(ROUTE, draft)).toBe(false);
    const edited = { ...draft, name: 'Main', clips: { ...draft.clips, closed: 'clip-2' }, maxConcurrent: '25' };
    expect(patchFromDraft(ROUTE, edited)).toEqual({ name: 'Main', clips: { closed: 'clip-2' }, max_concurrent: 25 });
    expect(patchFromDraft(ROUTE, { ...draft, numberIds: ['n-1', 'n-2'] })).toEqual({ phone_number_ids: ['n-1', 'n-2'] });
    expect(patchFromDraft(ROUTE, { ...draft, numberIds: [] })).toEqual({ phone_number_ids: [] });
  });

  it('round-trips the route’s wrap-up time and sends it only when it changed (IQ52)', () => {
    const draft = draftFromRoute(ROUTE);
    expect(draft.wrapupSeconds).toBe('45');
    expect(configFromDraft(draft).wrapup_seconds).toBe(45);
    expect(patchFromDraft(ROUTE, { ...draft, wrapupSeconds: '90' })).toEqual({ wrapup_seconds: 90 });
  });
});

describe('number choices', () => {
  const option = { phone_number_id: 'n-9', phone_number: '+441632960009', linked: true, route_id: null, route_name: null, held_elsewhere: false };

  it('says why a number cannot be put on this route', () => {
    expect(numberAvailability(option, 'r-1')).toEqual({ available: true });
    expect(numberAvailability({ ...option, linked: false }, 'r-1')).toEqual({ available: false, reason: expect.stringMatching(/Contact support/) });
    expect(numberAvailability({ ...option, held_elsewhere: true }, 'r-1')).toEqual({ available: false, reason: expect.stringMatching(/another account/) });
    expect(numberAvailability({ ...option, route_id: 'r-2', route_name: 'Sales' }, 'r-1')).toEqual({ available: false, reason: 'Already answers “Sales”.' });
    expect(numberAvailability({ ...option, route_id: 'r-1', route_name: 'Main' }, 'r-1')).toEqual({ available: true });
    expect(numberAvailability({ ...option, route_id: 'r-2', route_name: 'Sales' }, null).available).toBe(false);
  });
});

describe('offeredUnconnectedActions (P2): what the editor offers for a call nobody answers', () => {
  it('is the server’s list, in the contract’s order', () => {
    expect(offeredUnconnectedActions(['callback'])).toEqual(['callback']);
    expect(offeredUnconnectedActions(['voicemail', 'callback'])).toEqual(['callback', 'voicemail']);
  });

  it('keeps a stored action the server no longer offers, so it is shown rather than replaced', () => {
    expect(offeredUnconnectedActions(['callback'], ['voicemail', 'callback'])).toEqual(['callback', 'voicemail']);
  });

  it('this build offers callback and voicemail (P2 records one), so the editor offers the choice', () => {
    expect(offeredUnconnectedActions(AGENCY_INBOUND_AVAILABLE_ACTIONS)).toEqual(['callback', 'voicemail']);
    expect(UNCONNECTED_ACTION_LABELS.voicemail.hint).toMatch(/up to 2 minutes/);
  });
});
