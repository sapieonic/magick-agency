import { describe, expect, it } from 'vitest';
import { AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS } from '@magick-agency/contracts/api/agency/floor';
import {
  buildFloorAlerts,
  goneLongEnough,
  isDisconnectedAlert,
  stateWhenStationWent,
  workingState,
} from '../../../src/agency/floor-alerts.js';
import { StationDetachTimes } from '../../../src/agency/station-detach-times.js';
import type { FloorAlertHelpRow, FloorAlertSessionRow } from '../../../src/db/repositories/agency.repository.js';

/**
 * The supervisors' alerts (agent station AS16; `agency/floor-alerts.ts`), pure: which conditions
 * alert (Need help, a break past its reason's limit, a working agent's station gone 20 s or more),
 * which never do (at the limit, a break with no limit of its own, a reserved break, a drop on a
 * break, a drop under the threshold, liveness unknown), the ids (stable from poll to poll, new for a
 * new break or drop), the order; and the in-memory detach times the disconnect rule reads.
 */

const NOW = new Date('2026-11-20T10:00:00.000Z');
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

const ago = (ms: number) => new Date(NOW.getTime() - ms);

function helpRow(over: Partial<FloorAlertHelpRow> = {}): FloorAlertHelpRow {
  return {
    session_id: S1, agent_user_id: 'agent-1', campaign_id: 'c-1', campaign_name: 'Renewals',
    raised_at: ago(90_000), call_id: null, state: 'available', ...over,
  };
}

function sessionRow(over: Partial<FloorAlertSessionRow> = {}): FloorAlertSessionRow {
  return {
    session_id: S2, agent_user_id: 'agent-2', campaign_id: 'c-1', campaign_name: 'Renewals', break_reasons: [],
    state: 'break', state_since: ago(16 * 60_000), break_reason: 'tea', client_kind: 'web', left_state: null,
    soft_phone_call_live: false, ...over,
  };
}

const build = (input: Partial<Parameters<typeof buildFloorAlerts>[0]>) => buildFloorAlerts({
  help: [], sessions: [], disconnectedSince: new Map(), connected: new Map(), now: NOW, ...input,
});

describe('help', () => {
  it('every open request the read found, with its state at the raise; id help:<session>:<raised_at>, since the raise', () => {
    const raised = ago(90_000);
    expect(build({ help: [helpRow({ raised_at: raised })] })).toEqual([{
      id: `help:${S1}:${raised.toISOString()}`, kind: 'help', session_id: S1, agent_user_id: 'agent-1',
      campaign_id: 'c-1', campaign_name: 'Renewals', since: raised.toISOString(),
      help: { raised_at: raised.toISOString(), call_id: null, state_at_raise: 'available' },
    }]);
  });
});

describe('break_over (AS12)', () => {
  it('past its reason\'s limit: since the limit passed, id break_over:<session>:<break start>', () => {
    const started = ago(16 * 60_000);
    expect(build({ sessions: [sessionRow({ state_since: started })] })).toEqual([{
      id: `break_over:${S2}:${started.toISOString()}`, kind: 'break_over', session_id: S2, agent_user_id: 'agent-2',
      campaign_id: 'c-1', campaign_name: 'Renewals', since: new Date(started.getTime() + 15 * 60_000).toISOString(),
      break_reason: 'tea', break_label: 'Tea', limit_minutes: 15, break_started_at: started.toISOString(),
    }]);
  });

  it('only PAST the limit: at it exactly, or a second short, no alert; a millisecond past it, one', () => {
    // FALSIFIED: with `>` turned into `>=` the at-the-limit case alerts; with the limit dropped
    // from the comparison every break alerts. Both red.
    expect(build({ sessions: [sessionRow({ state_since: ago(15 * 60_000) })] })).toEqual([]);
    expect(build({ sessions: [sessionRow({ state_since: ago(15 * 60_000 - 1_000) })] })).toEqual([]);
    expect(build({ sessions: [sessionRow({ state_since: ago(15 * 60_000 + 1) })] })).toHaveLength(1);
  });

  it('never for a reason with no limit of its own, a code the catalog does not know, a reserved break, or the soft phone', () => {
    const long = ago(5 * 60 * 60_000);
    for (const row of [
      sessionRow({ break_reason: 'break', state_since: long }),
      sessionRow({ break_reason: 'nap', state_since: long }),
      sessionRow({ break_reason: 'device_away', state_since: long }),
      sessionRow({ break_reason: 'soft_phone', state_since: long, campaign_id: null, campaign_name: null, break_reasons: null }),
    ]) expect(build({ sessions: [row] }), String(row.break_reason)).toEqual([]);
  });

  it('the campaign\'s own catalog decides the limit (its limit, its label)', () => {
    const row = sessionRow({ break_reason: 'prayer', break_reasons: [{ code: 'prayer', label: 'Prayer', limit_minutes: 10 }], state_since: ago(11 * 60_000) });
    expect(build({ sessions: [row] })).toMatchObject([{ kind: 'break_over', break_label: 'Prayer', limit_minutes: 10 }]);
  });
});

describe('disconnected (BE-11)', () => {
  const working = sessionRow({ session_id: S3, state: 'available', break_reason: null, state_since: ago(3_600_000) });

  it('a working agent\'s station gone 20 s or more and still gone: since the detach, id disconnected:<session>:<detach>', () => {
    const went = ago(AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS);
    expect(build({
      sessions: [working], disconnectedSince: new Map([[S3, went]]), connected: new Map([[S3, false]]),
      callIds: new Map([[S3, null]]),
    })).toEqual([{
      id: `disconnected:${S3}:${went.toISOString()}`, kind: 'disconnected', session_id: S3, agent_user_id: 'agent-2',
      campaign_id: 'c-1', campaign_name: 'Renewals', since: went.toISOString(), state: 'available', client_kind: 'web', call_id: null,
    }]);
  });

  it('the threshold: a millisecond short of 20 s, no alert (a wifi blip the reconnect ladder wins)', () => {
    // FALSIFIED: with the threshold check removed, this reds.
    const input = { sessions: [working], connected: new Map([[S3, false]]) };
    expect(build({ ...input, disconnectedSince: new Map([[S3, ago(AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS - 1)]]) })).toEqual([]);
    expect(build({ ...input, disconnectedSince: new Map([[S3, ago(AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS)]]) })).toHaveLength(1);
    expect(goneLongEnough(new Map([[S1, ago(AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS - 1)], [S3, ago(AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS)]]), NOW))
      .toEqual([S3]);
  });

  it('liveness must say gone: held again, unknown (Redis could not answer) or no detach time, no alert', () => {
    const since = new Map([[S3, ago(60_000)]]);
    expect(build({ sessions: [working], disconnectedSince: since, connected: new Map([[S3, true]]) })).toEqual([]);
    expect(build({ sessions: [working], disconnectedSince: since, connected: new Map() })).toEqual([]);
    expect(build({ sessions: [working], disconnectedSince: since, connected: null })).toEqual([]);
    expect(build({ sessions: [working], disconnectedSince: new Map(), connected: new Map([[S3, false]]) })).toEqual([]);
  });

  it('only a WORKING agent: a row the close wrote offline counts by the state it left; a drop on a break (an app in the background) never', () => {
    expect(stateWhenStationWent({ state: 'on_call', left_state: null })).toBe('on_call');
    expect(stateWhenStationWent({ state: 'offline', left_state: 'available' })).toBe('available');
    expect(stateWhenStationWent({ state: 'offline', left_state: 'wrapup' })).toBe('wrapup');
    expect(stateWhenStationWent({ state: 'offline', left_state: 'break' })).toBeNull();
    expect(stateWhenStationWent({ state: 'offline', left_state: null })).toBeNull();
    expect(stateWhenStationWent({ state: 'break', left_state: null })).toBeNull();
    const since = ago(60_000);
    const gone = (row: FloorAlertSessionRow) => isDisconnectedAlert(row, since, new Map([[row.session_id, false]]), NOW);
    expect(gone(sessionRow({ session_id: S3, state: 'offline', left_state: 'reserved', break_reason: null }))).toBe(true);
    expect(gone(sessionRow({ session_id: S3, state: 'break', break_reason: 'device_away' }))).toBe(false);
    expect(gone(sessionRow({ session_id: S3, state: 'offline', left_state: 'break', break_reason: null }))).toBe(false);
  });

  it('a soft-phone agent (on `break`/`soft_phone`) is working while a soft-phone call is live: a drop then alerts; idle on the soft phone it does not', () => {
    // FALSIFIED: with `break` never working, the live-call case reds; with every soft-phone break
    // working, the idle case reds.
    expect(workingState('break', true)).toBe('break');
    expect(workingState('break', false)).toBeNull();
    expect(workingState('offline', true)).toBeNull();
    expect(workingState('on_call', false)).toBe('on_call');
    const phone = sessionRow({
      session_id: S3, state: 'break', break_reason: 'soft_phone', campaign_id: null, campaign_name: null, break_reasons: null,
    });
    const input = { disconnectedSince: new Map([[S3, ago(30_000)]]), connected: new Map([[S3, false]]), callIds: new Map([[S3, 'call-7']]) };
    expect(build({ ...input, sessions: [{ ...phone, soft_phone_call_live: true }] }))
      .toMatchObject([{ kind: 'disconnected', session_id: S3, state: 'break', call_id: 'call-7' }]);
    expect(build({ ...input, sessions: [{ ...phone, soft_phone_call_live: false }] })).toEqual([]);
    // Only the soft phone's own break: another break with a live flag set never counts as a call.
    expect(stateWhenStationWent({ state: 'offline', left_state: 'break', soft_phone_call_live: true })).toBeNull();
  });

  it('served with the state it went in and the call it is on', () => {
    const row = sessionRow({ session_id: S3, state: 'offline', left_state: 'on_call', break_reason: null, client_kind: 'mobile' });
    expect(build({
      sessions: [row], disconnectedSince: new Map([[S3, ago(30_000)]]), connected: new Map([[S3, false]]), callIds: new Map([[S3, 'call-9']]),
    })).toMatchObject([{ kind: 'disconnected', state: 'on_call', client_kind: 'mobile', call_id: 'call-9' }]);
  });
});

describe('ids and order', () => {
  it('the same conditions read twice give the same ids (the console chimes once); a new break or drop of the same agent is a new id', () => {
    // FALSIFIED: with `now` (or a counter) in an id, the second read's ids differ and this reds.
    const went = ago(45_000);
    const input = {
      help: [helpRow()],
      sessions: [sessionRow(), sessionRow({ session_id: S3, state: 'on_call', break_reason: null })],
      disconnectedSince: new Map([[S3, went]]),
      connected: new Map([[S3, false]]),
    };
    const first = build(input).map((a) => a.id);
    const later = buildFloorAlerts({ ...input, now: new Date(NOW.getTime() + 5_000) }).map((a) => a.id);
    expect(first).toHaveLength(3);
    expect(later).toEqual(first);
    const nextBreak = build({ sessions: [sessionRow({ state_since: ago(20 * 60_000) })] })[0]!.id;
    expect(first).not.toContain(nextBreak);
    const nextDrop = build({ ...input, help: [], disconnectedSince: new Map([[S3, ago(25_000)]]) }).find((a) => a.kind === 'disconnected')!.id;
    expect(first).not.toContain(nextDrop);
  });

  it('oldest `since` first, then by id', () => {
    const alerts = build({
      help: [helpRow({ raised_at: ago(10_000) }), helpRow({ session_id: S3, raised_at: ago(10_000) })],
      sessions: [sessionRow({ state_since: ago(40 * 60_000) })],
    });
    expect(alerts.map((a) => a.kind)).toEqual(['break_over', 'help', 'help']);
    expect(alerts[1]!.id < alerts[2]!.id).toBe(true);
  });
});

describe('the detach times (memory)', () => {
  const A = { tenantId: 't-1', accountId: 'a-1' };
  const B = { tenantId: 't-1', accountId: 'a-2' };

  it('a detach records when; an attach forgets it and says when it went; a second detach is the new time; the oldest goes first past the cap', () => {
    const times = new StationDetachTimes(2);
    times.detached(S1, A, 1_000);
    times.detached(S2, A, 2_000);
    expect(times.disconnectedSince([S1, S2, S3])).toEqual(new Map([[S1, new Date(1_000)], [S2, new Date(2_000)]]));
    expect(times.attached(S1)).toBe(1_000);
    expect(times.attached(S1)).toBeUndefined();
    expect(times.disconnectedSince([S1])).toEqual(new Map());
    times.detached(S1, A, 3_000);
    times.detached(S3, A, 4_000);
    expect(times.goneSessionIds()).toEqual([S1, S3]);
    expect(times.size()).toBe(2);
  });

  it('the alerts read asks for its own account only (filtered in memory, before any SQL); a detach with no scope is nobody\'s', () => {
    // FALSIFIED: with the scope ignored, every account's gone sessions are listed and this reds.
    const times = new StationDetachTimes();
    times.detached(S1, A, 1_000);
    times.detached(S2, B, 2_000);
    times.detached(S3, null, 3_000);
    expect(times.goneSessionIds(A)).toEqual([S1]);
    expect(times.goneSessionIds(B)).toEqual([S2]);
    expect(times.goneSessionIds({ tenantId: 't-2', accountId: 'a-1' })).toEqual([]);
    expect(times.goneSessionIds()).toEqual([S1, S2, S3]);
  });

  it('a session that ended is forgotten, one at a time or by the list the alerts read found ended', () => {
    const times = new StationDetachTimes();
    times.detached(S1, A, 1_000);
    times.detached(S2, A, 2_000);
    times.detached(S3, A, 3_000);
    times.ended(S1);
    times.forgetEnded([S2, 'not-there']);
    expect(times.goneSessionIds(A)).toEqual([S3]);
    expect(times.size()).toBe(1);
  });
});
