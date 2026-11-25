import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useCallback, useReducer } from 'react';

const mocks = vi.hoisted(() => ({ raiseHelp: vi.fn(), cancelHelp: vi.fn() }));
vi.mock('../../api/agency', () => ({ raiseHelp: mocks.raiseHelp, cancelHelp: mocks.cancelHelp }));

import * as posthog from '../../analytics/posthog';
import { ApiError } from '../../api/client';
import { useStationHelp } from '../../pages/agency/station/useStationHelp';
import { INITIAL_STATION_STATE, stationReducer, type StationAction } from '../../utils/agencyStationReducer';
import { helpRefusedCode, helpWaitBucket, type HelpWhere } from '../../utils/agency/helpTelemetry';
import type { AgencyStationReadyFrame } from '../../types/agency';

/**
 * Need help's telemetry (LF39) through the station's real reducer: each event at most once per
 * request (`raised_at`), through reconnects, duplicate frames, a raise's answer landing after the
 * frames that ended it, and a cancel that lost the race to an answer or a lapse (LF24's races).
 * Raised is the first raise answer naming a request (never a `ready.help`); cancelled is only the
 * server's `help_cleared { cancelled }` on either side of the cancel's reply, never the reply;
 * nothing for a `session_ended` clear or a frame about an earlier request; and nothing in any
 * property that names a person, a session, a call or a request.
 */

const R1 = '2026-11-19T10:00:00.000Z';
const R0 = '2026-11-19T09:30:00.000Z';
const R2 = '2026-11-19T10:30:00.000Z';
/**
 * The server-aligned clock the hook is handed (offset 0). Two instants, so a test can say both: when
 * Need help is pressed (`pressNow`, 5 s after R1, as a raise's own request is raised as it is
 * pressed: read at the press for the 60 s rule) and when the frames land (`now`, two minutes after
 * R1 unless a test moves it: read for how long a request was open).
 */
let now = Date.parse(R1) + 2 * 60_000;
let pressNow = Date.parse(R1) + 5_000;
const clock = {
  offsetMs: 0,
  now: () => pressNow,
  since: (anchor: string | number | null | undefined) => (typeof anchor === 'string' ? Math.max(0, now - Date.parse(anchor)) : null),
};

const ON_CALL: HelpWhere = { surface: 'softphone', onCall: true };

let capture: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  now = Date.parse(R1) + 2 * 60_000;
  pressNow = Date.parse(R1) + 5_000;
  mocks.raiseHelp.mockReset().mockResolvedValue({ session_id: 'sess-1', help: { raised_at: R1, call_id: 'call-1' } });
  mocks.cancelHelp.mockReset().mockResolvedValue({ session_id: 'sess-1', help: null });
  capture = vi.spyOn(posthog, 'captureEvent').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  capture.mockRestore();
});

function useHarness() {
  const [state, dispatch] = useReducer(stationReducer, INITIAL_STATION_STATE);
  const setHelp = useCallback((help: typeof state.help) => dispatch({ type: 'help_set', help }), []);
  const dismissHelpNotice = useCallback(() => dispatch({ type: 'help_notice_dismissed' }), []);
  const noteHelpRaise = useCallback(
    (raise: { phase: 'started'; at: number } | { phase: 'failed' }) =>
      dispatch(raise.phase === 'started' ? { type: 'help_raise_started', at: raise.at } : { type: 'help_raise_failed' }),
    [],
  );
  const help = useStationHelp({
    offered: true,
    everywhere: true,
    sessionId: 'sess-1',
    tenantId: 't-1',
    accountId: 'a-1',
    station: { agentState: state.agentState, help: state.help, helpNotice: state.helpNotice, helpFrames: state.helpFrames, setHelp, noteHelpRaise, dismissHelpNotice },
    clock,
  });
  return { help, state, dispatch };
}

function mount() {
  const hook = renderHook(() => useHarness());
  const send = async (action: StationAction) => {
    await act(async () => {
      hook.result.current.dispatch(action);
    });
  };
  const press = async (where?: HelpWhere) => {
    await act(async () => {
      hook.result.current.help.press(where);
    });
  };
  const answered = (raisedAt: string, how: 'listen' | 'message', byName: string | null = 'Priya N') =>
    send({ type: 'help_answered', frame: { event: 'help_answered', raised_at: raisedAt, by_name: byName, how } });
  const cleared = (raisedAt: string, reason: 'answered' | 'cancelled' | 'expired' | 'session_ended') =>
    send({ type: 'help_cleared', frame: { event: 'help_cleared', raised_at: raisedAt, reason } });
  const ready = (help?: { raised_at: string; call_id: string | null }) =>
    send({
      type: 'ready',
      frame: { event: 'ready', session_id: 'sess-1', state: 'on_call', ...(help ? { help } : {}) } as unknown as AgencyStationReadyFrame,
      wrapup: null,
    });
  return { hook, send, press, answered, cleared, ready };
}

/** The Need help events captured, in order, name and properties. */
const helpEvents = (): [string, Record<string, unknown>][] =>
  capture.mock.calls
    .filter((call: unknown[]) => String(call[0]).startsWith('agency_help_'))
    .map((call: unknown[]) => [String(call[0]), call[1] as Record<string, unknown>]);
const names = () => helpEvents().map(([name]) => name);

/** No property of any captured event says who, which session or call, or which request. */
function expectNothingPersonal() {
  for (const [, props] of helpEvents()) {
    const text = JSON.stringify(props);
    for (const needle of ['Priya', 'sess-1', 'call-1', 't-1', 'a-1', '2026-11-19']) expect(text).not.toContain(needle);
    for (const value of Object.values(props)) expect(['string', 'boolean']).toContain(typeof value);
  }
}

describe('agency_help_raised', () => {
  it('fires once when the raise’s answer opens the request, with where and whether on a call', async () => {
    const t = mount();
    await t.press(ON_CALL);
    expect(helpEvents()).toEqual([['agency_help_raised', { surface: 'softphone', on_call: true }]]);
    expectNothingPersonal();
  });

  it('defaults to the campaign’s screen, on a call by the agent state', async () => {
    const t = mount();
    await t.send({ type: 'agent_state', frame: { event: 'agent_state', state: 'on_call', since: R0 } });
    await t.press();
    expect(helpEvents()).toEqual([['agency_help_raised', { surface: 'station', on_call: true }]]);
  });

  it('is not sent again for a reconnect’s ready.help, a duplicate answer, or a repeated raise answered with the same request', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await t.ready({ raised_at: R1, call_id: 'call-1' });
    await t.ready({ raised_at: R1, call_id: 'call-1' });
    await t.send({ type: 'help_set', help: { raised_at: R1, call_id: 'call-1' } });
    // The socket dropped and came back without it, then with it again (a stale restatement is ignored).
    await t.ready();
    await t.ready({ raised_at: R1, call_id: 'call-1' });
    expect(names()).toEqual(['agency_help_raised']);
  });

  it('a second raise answer naming the same request is not a second raise', async () => {
    const t = mount();
    await t.press(ON_CALL);
    // A reconnect's ready left it out (racing its clear), so the agent asks again; the server answers
    // the request still open, the same `raised_at`.
    await t.ready();
    expect(t.hook.result.current.help.open).toBe(false);
    await t.press({ surface: 'softphone', onCall: false });
    expect(mocks.raiseHelp).toHaveBeenCalledTimes(2);
    expect(helpEvents()).toEqual([['agency_help_raised', { surface: 'softphone', on_call: true }]]);
  });

  it('is never sent for a request only a ready.help stated (raised before a reload)', async () => {
    const t = mount();
    await t.ready({ raised_at: R0, call_id: null });
    expect(t.hook.result.current.help.open).toBe(true);
    expect(names()).toEqual([]);
  });

  it('a raise answer naming the request a ready.help already put on screen is still the raise', async () => {
    const t = mount();
    let resolve!: (v: unknown) => void;
    mocks.raiseHelp.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    await t.press(ON_CALL);
    // Stated without its call (the ready's read of it failed); the answer then names it.
    await t.ready({ raised_at: R1, call_id: null });
    await act(async () => {
      resolve({ session_id: 'sess-1', help: { raised_at: R1, call_id: 'call-1' } });
    });
    expect(t.hook.result.current.state.help).toEqual({ raised_at: R1, call_id: 'call-1' });
    expect(helpEvents()).toEqual([['agency_help_raised', { surface: 'softphone', on_call: true }]]);
  });

  it('a raise answer that lands after the frames that ended its request opens nothing on screen, and is still the raise', async () => {
    const t = mount();
    let resolve!: (v: unknown) => void;
    mocks.raiseHelp.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    await t.press(ON_CALL);
    await t.answered(R1, 'message');
    await t.cleared(R1, 'answered');
    await act(async () => {
      resolve({ session_id: 'sess-1', help: { raised_at: R1, call_id: 'call-1' } });
    });
    expect(t.hook.result.current.help.open).toBe(false);
    expect(helpEvents()).toEqual([
      ['agency_help_answered', { how: 'message', wait_bucket: '1_5m' }],
      ['agency_help_raised', { surface: 'softphone', on_call: true }],
    ]);
  });

  it('a second request after the first ended is its own raise', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await t.cleared(R1, 'expired');
    mocks.raiseHelp.mockResolvedValueOnce({ session_id: 'sess-1', help: { raised_at: R2, call_id: null } });
    await t.press({ surface: 'inbound', onCall: false });
    expect(helpEvents()).toEqual([
      ['agency_help_raised', { surface: 'softphone', on_call: true }],
      ['agency_help_expired', {}],
      ['agency_help_raised', { surface: 'inbound', on_call: false }],
    ]);
  });
});

describe('agency_help_answered and agency_help_expired', () => {
  it('answered by a listen: once, with how and how long, through duplicate frames and a reconnect', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await t.answered(R1, 'listen');
    await t.answered(R1, 'listen');
    await t.cleared(R1, 'answered');
    await t.cleared(R1, 'answered');
    await t.ready();
    expect(helpEvents()).toEqual([
      ['agency_help_raised', { surface: 'softphone', on_call: true }],
      ['agency_help_answered', { how: 'listen', wait_bucket: '1_5m' }],
    ]);
    expectNothingPersonal();
  });

  it('a clear `answered` with no help_answered seen is `unknown`', async () => {
    const t = mount();
    await t.press(ON_CALL);
    now = Date.parse(R1) + 20 * 1000;
    await t.cleared(R1, 'answered');
    expect(helpEvents().at(-1)).toEqual(['agency_help_answered', { how: 'unknown', wait_bucket: 'under_60' }]);
  });

  it('a dismissed answer is not sent again', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await t.answered(R1, 'message');
    await t.cleared(R1, 'answered');
    await act(async () => t.hook.result.current.help.dismiss());
    await t.answered(R1, 'message');
    expect(names()).toEqual(['agency_help_raised', 'agency_help_answered']);
  });

  it('expired: once, with no properties', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await t.cleared(R1, 'expired');
    await t.cleared(R1, 'expired');
    expect(helpEvents()).toEqual([
      ['agency_help_raised', { surface: 'softphone', on_call: true }],
      ['agency_help_expired', {}],
    ]);
  });

  it('a session_ended clear sends nothing', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await t.cleared(R1, 'session_ended');
    await t.cleared(R1, 'cancelled');
    expect(names()).toEqual(['agency_help_raised']);
  });

  it('frames about an earlier request than the one on screen send nothing', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await t.answered(R0, 'listen');
    await t.cleared(R0, 'answered');
    await t.cleared(R0, 'expired');
    expect(names()).toEqual(['agency_help_raised']);
  });
});

describe('agency_help_cancelled', () => {
  /** Press cancel with its reply held, so a test puts the frames on either side of it. */
  async function cancelHeld(t: ReturnType<typeof mount>) {
    let resolve!: (v: unknown) => void;
    mocks.cancelHelp.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    await t.press(ON_CALL);
    return async () => {
      await act(async () => {
        resolve({ session_id: 'sess-1', help: null });
      });
    };
  }

  it('cancel won, its help_cleared before the reply: cancelled once, with how long it was open', async () => {
    const t = mount();
    await t.press(ON_CALL);
    const reply = await cancelHeld(t);
    now = Date.parse(R1) + 6 * 60_000;
    await t.cleared(R1, 'cancelled');
    await reply();
    await t.cleared(R1, 'cancelled');
    await t.ready();
    expect(helpEvents()).toEqual([
      ['agency_help_raised', { surface: 'softphone', on_call: true }],
      ['agency_help_cancelled', { wait_bucket: '5_15m' }],
    ]);
  });

  it('cancel won, its help_cleared after the reply: cancelled once, sent on the frame', async () => {
    const t = mount();
    await t.press(ON_CALL);
    const reply = await cancelHeld(t);
    await reply();
    expect(t.hook.result.current.help.open).toBe(false);
    // The reply alone says nothing: it reads the same when the cancel lost.
    expect(names()).toEqual(['agency_help_raised']);
    await t.cleared(R1, 'cancelled');
    await t.cleared(R1, 'cancelled');
    expect(helpEvents()).toEqual([
      ['agency_help_raised', { surface: 'softphone', on_call: true }],
      ['agency_help_cancelled', { wait_bucket: '1_5m' }],
    ]);
  });

  it('cancel lost, both answer frames after the reply: answered, never cancelled', async () => {
    const t = mount();
    await t.press(ON_CALL);
    const reply = await cancelHeld(t);
    await reply();
    await t.answered(R1, 'listen');
    await t.cleared(R1, 'answered');
    expect(helpEvents()).toEqual([
      ['agency_help_raised', { surface: 'softphone', on_call: true }],
      ['agency_help_answered', { how: 'listen', wait_bucket: '1_5m' }],
    ]);
  });

  it('cancel lost, only the clear `answered` after the reply: answered `unknown`, once', async () => {
    const t = mount();
    await t.press(ON_CALL);
    const reply = await cancelHeld(t);
    await reply();
    await t.cleared(R1, 'answered');
    await t.cleared(R1, 'answered');
    expect(names()).toEqual(['agency_help_raised', 'agency_help_answered']);
    expect(helpEvents()[1]![1]).toEqual({ how: 'unknown', wait_bucket: '1_5m' });
  });

  it('cancel lost, the answer before the reply: answered, never cancelled', async () => {
    const t = mount();
    await t.press(ON_CALL);
    const reply = await cancelHeld(t);
    await t.answered(R1, 'listen');
    await reply();
    await t.cleared(R1, 'answered');
    expect(names()).toEqual(['agency_help_raised', 'agency_help_answered']);
  });

  it('cancel lost to the lapse, on either side of the reply: expired', async () => {
    const t = mount();
    await t.press(ON_CALL);
    let reply = await cancelHeld(t);
    await t.cleared(R1, 'expired');
    await reply();
    mocks.raiseHelp.mockResolvedValueOnce({ session_id: 'sess-1', help: { raised_at: R2, call_id: null } });
    await t.press(ON_CALL);
    reply = await cancelHeld(t);
    await reply();
    await t.cleared(R2, 'expired');
    expect(names()).toEqual(['agency_help_raised', 'agency_help_expired', 'agency_help_raised', 'agency_help_expired']);
  });

  it('a cancelled clear about an earlier request than the one on screen sends nothing', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await t.cleared(R0, 'cancelled');
    expect(names()).toEqual(['agency_help_raised']);
    expect(t.hook.result.current.help.open).toBe(true);
  });
});

describe('frames that land in one render', () => {
  const both = (t: ReturnType<typeof mount>, first: StationAction, second: StationAction) =>
    act(async () => {
      t.hook.result.current.dispatch(first);
      t.hook.result.current.dispatch(second);
    });
  const answeredFrame = (raisedAt: string, how: 'listen' | 'message'): StationAction =>
    ({ type: 'help_answered', frame: { event: 'help_answered', raised_at: raisedAt, by_name: 'Priya N', how } });
  const clearedFrame = (raisedAt: string, reason: 'answered' | 'expired' | 'cancelled'): StationAction =>
    ({ type: 'help_cleared', frame: { event: 'help_cleared', raised_at: raisedAt, reason } });

  it.each(['listen', 'message'] as const)('help_answered (%s) then its clear, back to back: answered with that how', async (how) => {
    const t = mount();
    await t.press(ON_CALL);
    await both(t, answeredFrame(R1, how), clearedFrame(R1, 'answered'));
    expect(helpEvents()).toEqual([
      ['agency_help_raised', { surface: 'softphone', on_call: true }],
      ['agency_help_answered', { how, wait_bucket: '1_5m' }],
    ]);
  });

  it('an in-scope frame followed by a frame about another request: the first still counts, the second does not', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await both(t, clearedFrame(R1, 'expired'), answeredFrame(R0, 'listen'));
    expect(names()).toEqual(['agency_help_raised', 'agency_help_expired']);
  });
});

describe('which request a frame counts for (amendment 2)', () => {
  /** Press Need help with its reply held; the returned function lands the reply. */
  async function raiseHeld(t: ReturnType<typeof mount>, raisedAt: string) {
    let resolve!: (v: unknown) => void;
    mocks.raiseHelp.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    await t.press(ON_CALL);
    return async () => {
      await act(async () => {
        resolve({ session_id: 'sess-1', help: { raised_at: raisedAt, call_id: null } });
      });
    };
  }

  it('the 60 s rule: a lapse of a request raised long before the press, landing before a slow raise’s reply, sends nothing', async () => {
    const t = mount();
    // Request A was never shown in this page load; a ready says none is open.
    await t.ready();
    const A = new Date(pressNow - 14 * 60_000).toISOString();
    const reply = await raiseHeld(t, R1);
    // The server expires A (past its 15 minutes) before it answers the new raise.
    await t.cleared(A, 'expired');
    await reply();
    expect(names()).toEqual(['agency_help_raised']);
  });

  it('the 60 s rule’s edge: a request raised 60 s before the press counts, 61 s does not', async () => {
    const t = mount();
    const atEdge = new Date(pressNow - 60_000).toISOString();
    const past = new Date(pressNow - 61_000).toISOString();
    const reply = await raiseHeld(t, R1);
    await t.cleared(past, 'expired');
    await t.cleared(atEdge, 'expired');
    await reply();
    expect(names()).toEqual(['agency_help_expired', 'agency_help_raised']);
  });

  it('a raise’s answer ends the raise in flight: a late frame about an older request then sends nothing', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await t.cleared(R1, 'expired');
    // Raised 10 s before R1: within 60 s of the press, so only the ended raise keeps it out.
    const older = new Date(Date.parse(R1) - 10_000).toISOString();
    await t.answered(older, 'listen');
    await t.cleared(older, 'expired');
    expect(names()).toEqual(['agency_help_raised', 'agency_help_expired']);
  });

  it('a cancelled request still ends after the cancel’s reply and a new raise put another on screen', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await t.press(ON_CALL);
    expect(mocks.cancelHelp).toHaveBeenCalledTimes(1);
    mocks.raiseHelp.mockResolvedValueOnce({ session_id: 'sess-1', help: { raised_at: R2, call_id: null } });
    await t.press({ surface: 'station', onCall: false });
    expect(t.hook.result.current.state.help?.raised_at).toBe(R2);
    await t.cleared(R1, 'cancelled');
    expect(t.hook.result.current.state.help?.raised_at).toBe(R2);
    expect(t.hook.result.current.help.open).toBe(true);
    expect(helpEvents()).toEqual([
      ['agency_help_raised', { surface: 'softphone', on_call: true }],
      ['agency_help_raised', { surface: 'station', on_call: false }],
      ['agency_help_cancelled', { wait_bucket: '1_5m' }],
    ]);
  });

  it('a lapse landing before a slow raise’s reply counts for the request it names: expired, then raised', async () => {
    const t = mount();
    const reply = await raiseHeld(t, R1);
    await t.cleared(R1, 'expired');
    await reply();
    expect(t.hook.result.current.help.open).toBe(false);
    expect(names()).toEqual(['agency_help_expired', 'agency_help_raised']);
  });

  it('a cancel (from another window) landing before a slow raise’s reply: cancelled, then raised', async () => {
    const t = mount();
    const reply = await raiseHeld(t, R1);
    await t.cleared(R1, 'cancelled');
    await reply();
    expect(names()).toEqual(['agency_help_cancelled', 'agency_help_raised']);
  });

  it.each([
    ['no answer at all', new TypeError('Failed to fetch'), 'network'],
    ['a 5xx', new ApiError(503, { message: 'down' }), 'other'],
  ] as const)('a raise whose reply failed (%s) is out of scope: a later answer sends nothing, and still shows', async (_what, error, code) => {
    const t = mount();
    mocks.raiseHelp.mockRejectedValueOnce(error);
    await t.press(ON_CALL);
    await t.answered(R1, 'listen');
    await t.cleared(R1, 'answered');
    await t.cleared(R1, 'expired');
    await t.cleared(R1, 'cancelled');
    expect(helpEvents()).toEqual([['agency_help_refused', { action: 'raise', code }]]);
    // The screen is LF24's, unchanged: the answer is shown.
    expect(t.hook.result.current.state.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: 'Priya N', how: 'listen' });
  });

  it('nothing on screen and no raise in flight: frames send nothing', async () => {
    const t = mount();
    await t.answered(R1, 'message');
    await t.cleared(R1, 'answered');
    await t.cleared(R2, 'expired');
    expect(names()).toEqual([]);
  });

  it('a ready that left out request A, a new raise B, then A’s late lapse before B’s reply: raised(B) only', async () => {
    const t = mount();
    await t.press(ON_CALL);
    await t.ready();
    expect(t.hook.result.current.help.open).toBe(false);
    const reply = await raiseHeld(t, R2);
    await t.cleared(R1, 'expired');
    await reply();
    expect(t.hook.result.current.state.help?.raised_at).toBe(R2);
    expect(names()).toEqual(['agency_help_raised', 'agency_help_raised']);
  });
});

describe('agency_help_refused', () => {
  it.each([
    ['raise', new ApiError(403, { code: 'floor_assist_disabled', message: 'raw' }), 'floor_assist_disabled'],
    ['raise', new ApiError(409, { code: 'help_not_on_call', message: 'raw' }), 'help_not_on_call'],
    ['raise', new ApiError(409, { code: 'session_ended', message: 'raw' }), 'session_ended'],
    ['raise', new ApiError(404, { error: 'Not Found', message: 'Session not found' }), 'not_found'],
    ['raise', new TypeError('Failed to fetch'), 'network'],
    // A 2xx whose body was not JSON: an answer came back.
    ['raise', new SyntaxError('Unexpected token < in JSON'), 'other'],
    ['raise', new ApiError(500, { message: 'boom' }), 'other'],
    ['raise', new ApiError(400, { code: 'account_scope_required', message: 'raw' }), 'other'],
  ] as const)('%s refused: %s → %s', async (action, error, code) => {
    const t = mount();
    mocks.raiseHelp.mockRejectedValueOnce(error);
    await t.press(ON_CALL);
    expect(helpEvents()).toEqual([['agency_help_refused', { action, code }]]);
    expectNothingPersonal();
  });

  it('a refused cancel says so, keeps the request, and the later answer is still sent', async () => {
    const t = mount();
    await t.press(ON_CALL);
    mocks.cancelHelp.mockRejectedValueOnce(new ApiError(409, { code: 'session_ended', message: 'raw' }));
    await t.press(ON_CALL);
    await t.answered(R1, 'message');
    await t.cleared(R1, 'answered');
    expect(helpEvents()).toEqual([
      ['agency_help_raised', { surface: 'softphone', on_call: true }],
      ['agency_help_refused', { action: 'cancel', code: 'session_ended' }],
      ['agency_help_answered', { how: 'message', wait_bucket: '1_5m' }],
    ]);
  });
});

describe('the rules the events are cut by', () => {
  it('helpRefusedCode: the named codes, then a 404, then no answer, then other', () => {
    expect(helpRefusedCode('floor_assist_disabled', 403, false)).toBe('floor_assist_disabled');
    expect(helpRefusedCode('help_not_on_call', 409, false)).toBe('help_not_on_call');
    expect(helpRefusedCode('session_ended', 409, false)).toBe('session_ended');
    expect(helpRefusedCode(null, 404, false)).toBe('not_found');
    expect(helpRefusedCode(null, null, true)).toBe('network');
    // An answer came back but could not be read: not the network.
    expect(helpRefusedCode(null, null, false)).toBe('other');
    expect(helpRefusedCode('account_scope_required', 400, false)).toBe('other');
    expect(helpRefusedCode(null, 500, false)).toBe('other');
  });

  it('helpWaitBucket: agency_floor_intervention’s thresholds', () => {
    expect(helpWaitBucket(59_999)).toBe('under_60');
    expect(helpWaitBucket(60_000)).toBe('1_5m');
    expect(helpWaitBucket(5 * 60_000)).toBe('5_15m');
    expect(helpWaitBucket(15 * 60_000)).toBe('over_15m');
    expect(helpWaitBucket(null)).toBe('under_60');
  });
});
