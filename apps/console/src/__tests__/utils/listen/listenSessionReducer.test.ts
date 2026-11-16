import { describe, it, expect } from 'vitest';
import {
  INITIAL_LISTEN_STATE,
  LISTEN_MAX_INTERNAL_ERRORS,
  listenBarVisible,
  listenSessionReducer as reduce,
  listenSocketWanted,
  regrantOutcome,
  type ListenSessionEvent,
  type ListenSessionState,
  type ListenTarget,
} from '../../../utils/listen/listenSessionReducer';
import { AGENCY_LISTEN_CLOSE, AGENCY_LISTEN_RECONNECT_WINDOW_MS } from '../../../types/live-calls';

/**
 * Every transition of a supervisor's listen (`docs/listening.md` §3, §4, §9): start, grant,
 * socket, ready, the ways it ends, the reconnect window, stale events, and the bar's own flags.
 */

const TARGET: ListenTarget = {
  callId: 'call-1',
  origin: 'campaign',
  campaignId: 'camp-1',
  campaignLabel: 'Renewals',
  agentName: 'Priya Sharma',
  customerMasked: '****4321',
  connectedAt: '2026-11-16T10:00:00Z',
  clockOffsetMs: 0,
};

function run(events: ListenSessionEvent[], from: ListenSessionState = INITIAL_LISTEN_STATE): ListenSessionState {
  return events.reduce(reduce, from);
}

/** A listen that is live: start (attempt 1), granted, ready at t=1000. */
function live(): ListenSessionState {
  return run([
    { type: 'start', target: TARGET, now: 0 },
    { type: 'granted', attempt: 1, listenId: 'l-1' },
    { type: 'ready', attempt: 1, listenId: 'l-1', now: 1_000 },
  ]);
}

/** A live listen whose socket dropped at t=5000: reconnecting, waiting. */
function dropped(): ListenSessionState {
  return reduce(live(), { type: 'closed', attempt: 1, code: 1006, reason: '', now: 5_000 });
}

describe('starting', () => {
  it('start: connecting, minting a grant, with the target and a new attempt', () => {
    const s = reduce(INITIAL_LISTEN_STATE, { type: 'start', target: TARGET, now: 0 });
    expect(s).toMatchObject({ phase: 'connecting', step: 'grant', target: TARGET, attempt: 1, startedAt: null, retry: null });
    expect(listenBarVisible(s)).toBe(true);
    expect(listenSocketWanted(s)).toBe(false);
  });

  it('granted: opens the socket', () => {
    const s = run([{ type: 'start', target: TARGET, now: 0 }, { type: 'granted', attempt: 1, listenId: 'l-1' }]);
    expect(s).toMatchObject({ phase: 'connecting', step: 'socket', listenId: 'l-1' });
    expect(listenSocketWanted(s)).toBe(true);
  });

  it('ready: live, the start time kept for "you listened for"', () => {
    const s = live();
    expect(s).toMatchObject({ phase: 'live', step: null, listenId: 'l-1', startedAt: 1_000, retry: null });
    expect(listenSocketWanted(s)).toBe(true);
  });

  it('a refused first grant: no bar, and a refusal for the toast', () => {
    const s = run([
      { type: 'start', target: TARGET, now: 0 },
      { type: 'grant_refused', attempt: 1, refusal: { status: 409, code: 'listen_limit_call' }, now: 10 },
    ]);
    expect(s.phase).toBe('idle');
    expect(s.target).toBeNull();
    expect(s.refusal).toEqual({ status: 409, code: 'listen_limit_call' });
    expect(s.refusalSeq).toBe(1);
    expect(listenBarVisible(s)).toBe(false);
  });

  it('a second refusal moves the toast sequence again', () => {
    const once = run([
      { type: 'start', target: TARGET, now: 0 },
      { type: 'grant_refused', attempt: 1, refusal: { status: 503, code: 'listen_unavailable' }, now: 10 },
    ]);
    const twice = run([
      { type: 'start', target: TARGET, now: 20 },
      { type: 'grant_refused', attempt: 2, refusal: { status: 503, code: 'listen_unavailable' }, now: 30 },
    ], once);
    expect(twice.refusalSeq).toBe(2);
  });

  it('a new start clears the last refusal and anything left of the last listen', () => {
    const s = run([{ type: 'sound', blocked: true }, { type: 'start', target: TARGET, now: 0 }], { ...live(), refusal: { status: 409, code: null } });
    expect(s).toMatchObject({ phase: 'connecting', refusal: null, soundBlocked: false, startedAt: null, attempt: 2 });
  });

  it('a socket that fails before ready waits and tries again, still "connecting"', () => {
    const s = run([
      { type: 'start', target: TARGET, now: 0 },
      { type: 'granted', attempt: 1, listenId: 'l-1' },
      { type: 'closed', attempt: 1, code: 1006, reason: '', now: 100 },
    ]);
    expect(s).toMatchObject({ phase: 'connecting', step: 'wait', retry: { deadline: 100 + AGENCY_LISTEN_RECONNECT_WINDOW_MS, internalErrors: 0 } });
  });
});

describe('stale events are dropped', () => {
  it('a grant, a ready or a close from an older attempt changes nothing', () => {
    const s = live();
    expect(reduce(s, { type: 'granted', attempt: 0, listenId: 'x' })).toBe(s);
    expect(reduce(s, { type: 'ready', attempt: 0, listenId: 'x', now: 2 })).toBe(s);
    expect(reduce(s, { type: 'closed', attempt: 0, code: 1006, reason: '', now: 2 })).toBe(s);
    expect(reduce(s, { type: 'server_ended', attempt: 0, reason: 'call_ended', now: 2 })).toBe(s);
    expect(reduce(s, { type: 'pong', attempt: 0, sample: { ts: 1, server_ts: 2, receivedAt: 3 } })).toBe(s);
  });

  it('a grant answer out of step changes nothing', () => {
    const s = live();
    expect(reduce(s, { type: 'granted', attempt: 1, listenId: 'x' })).toBe(s);
    expect(reduce(s, { type: 'grant_refused', attempt: 1, refusal: { status: 404, code: null }, now: 2 })).toBe(s);
  });

  it('ready before the grant answered changes nothing', () => {
    const s = reduce(INITIAL_LISTEN_STATE, { type: 'start', target: TARGET, now: 0 });
    expect(reduce(s, { type: 'ready', attempt: 1, listenId: 'l', now: 1 })).toBe(s);
  });

  it('a close while minting a grant (no socket yet) changes nothing', () => {
    const s = reduce(INITIAL_LISTEN_STATE, { type: 'start', target: TARGET, now: 0 });
    expect(reduce(s, { type: 'closed', attempt: 1, code: 1006, reason: '', now: 1 })).toBe(s);
  });

  it('nothing reaches idle', () => {
    for (const event of [
      { type: 'granted', attempt: 0, listenId: 'l' },
      { type: 'ready', attempt: 0, listenId: 'l', now: 0 },
      { type: 'closed', attempt: 0, code: 1000, reason: '', now: 0 },
      { type: 'reattach', now: 0 },
      { type: 'tick', now: 0 },
      { type: 'stop' },
      { type: 'retry', now: 0 },
      { type: 'dismiss' },
      { type: 'agent_silent', silent: true },
    ] as ListenSessionEvent[]) {
      expect(reduce(INITIAL_LISTEN_STATE, event), event.type).toBe(INITIAL_LISTEN_STATE);
    }
  });
});

describe('how a listen ends', () => {
  it('stop: idle', () => {
    expect(reduce(live(), { type: 'stop' }).phase).toBe('idle');
    expect(reduce(dropped(), { type: 'stop' }).phase).toBe('idle');
  });

  it('the call ends (frame or close 1000): "Call ended", with how long they listened', () => {
    const byFrame = reduce(live(), { type: 'server_ended', attempt: 1, reason: 'call_ended', now: 131_000 });
    expect(byFrame).toMatchObject({ phase: 'ended', end: { kind: 'call_ended', listenedMs: 130_000, code: null } });
    const byClose = reduce(live(), { type: 'closed', attempt: 1, code: AGENCY_LISTEN_CLOSE.NORMAL, reason: 'call_ended', now: 61_000 });
    expect(byClose).toMatchObject({ phase: 'ended', end: { kind: 'call_ended', listenedMs: 60_000 } });
    expect(listenSocketWanted(byClose)).toBe(false);
    expect(listenBarVisible(byClose)).toBe(true);
  });

  it('the call is gone at the upgrade (4404): "Call ended", having listened for nothing', () => {
    const s = run([
      { type: 'start', target: TARGET, now: 0 },
      { type: 'granted', attempt: 1, listenId: 'l-1' },
      { type: 'closed', attempt: 1, code: AGENCY_LISTEN_CLOSE.CALL_GONE, reason: 'listen_call_not_live', now: 50 },
    ]);
    expect(s).toMatchObject({ phase: 'ended', end: { kind: 'call_ended', listenedMs: 0 } });
  });

  it('our own stop echoed by the server (1000 listener_stopped): idle', () => {
    expect(reduce(live(), { type: 'closed', attempt: 1, code: 1000, reason: 'listener_stopped', now: 2 }).phase).toBe('idle');
    expect(reduce(live(), { type: 'server_ended', attempt: 1, reason: 'listener_stopped', now: 2 }).phase).toBe('idle');
  });

  it('revoked (frame or 4403): "You no longer have access"', () => {
    expect(reduce(live(), { type: 'server_ended', attempt: 1, reason: 'permission_revoked', now: 2 }).end?.kind).toBe('revoked');
    expect(reduce(live(), { type: 'closed', attempt: 1, code: 4403, reason: 'permission_revoked', now: 2 }).end?.kind).toBe('revoked');
  });

  it('superseded (frame or 4409): "Listening moved to another call."', () => {
    expect(reduce(live(), { type: 'server_ended', attempt: 1, reason: 'superseded', now: 2 }).end?.kind).toBe('superseded');
    expect(reduce(live(), { type: 'closed', attempt: 1, code: 4409, reason: 'superseded', now: 2 }).end?.kind).toBe('superseded');
  });

  it('a cap at the upgrade (4429): stopped, with its code', () => {
    const s = run([
      { type: 'start', target: TARGET, now: 0 },
      { type: 'granted', attempt: 1, listenId: 'l-1' },
      { type: 'closed', attempt: 1, code: 4429, reason: 'listen_limit_server', now: 5 },
    ]);
    expect(s).toMatchObject({ phase: 'ended', end: { kind: 'refused', code: 'listen_limit_server' } });
  });

  it('an `ended` frame for a drop it can recover from waits for the close', () => {
    for (const reason of ['send_backlog', 'tap_error', 'server_shutdown', 'listener_disconnected'] as const) {
      const s = live();
      expect(reduce(s, { type: 'server_ended', attempt: 1, reason, now: 2 }), reason).toBe(s);
    }
  });

  it('a close after the session ended changes nothing', () => {
    const ended = reduce(live(), { type: 'server_ended', attempt: 1, reason: 'call_ended', now: 2 });
    expect(reduce(ended, { type: 'closed', attempt: 1, code: 1000, reason: 'call_ended', now: 3 })).toBe(ended);
  });

  it('dismiss: from ended or lost to idle, from nothing else', () => {
    const ended = reduce(live(), { type: 'server_ended', attempt: 1, reason: 'call_ended', now: 2 });
    expect(reduce(ended, { type: 'dismiss' }).phase).toBe('idle');
    const s = live();
    expect(reduce(s, { type: 'dismiss' })).toBe(s);
  });
});

describe('reconnecting (up to 15 s, a fresh grant each time)', () => {
  it('a drop after ready: reconnecting, waiting, the window from the drop', () => {
    const s = dropped();
    expect(s).toMatchObject({ phase: 'reconnecting', step: 'wait', retry: { deadline: 5_000 + AGENCY_LISTEN_RECONNECT_WINDOW_MS, internalErrors: 0 } });
    expect(listenSocketWanted(s)).toBe(false);
  });

  it.each([
    ['going away (1001)', 1001, 'server_shutdown'],
    ['a refused token (4401)', 4401, ''],
    ['the socket stopped reading (4408)', 4408, 'send_backlog'],
    ['silence (4408)', 4408, 'listener_disconnected'],
  ])('%s reconnects', (_name, code, reason) => {
    expect(reduce(live(), { type: 'closed', attempt: 1, code, reason, now: 5_000 }).phase).toBe('reconnecting');
  });

  it('reattach: a new attempt minting a new grant', () => {
    const s = reduce(dropped(), { type: 'reattach', now: 5_250 });
    expect(s).toMatchObject({ phase: 'reconnecting', step: 'grant', attempt: 2, listenId: null });
  });

  it('a reattach is only taken while waiting', () => {
    const s = live();
    expect(reduce(s, { type: 'reattach', now: 2 })).toBe(s);
  });

  it('back to live on the new attach’s ready, the window closed and the start time kept', () => {
    const s = run([
      { type: 'reattach', now: 5_250 },
      { type: 'granted', attempt: 2, listenId: 'l-2' },
      { type: 'ready', attempt: 2, listenId: 'l-2', now: 6_000 },
    ], dropped());
    expect(s).toMatchObject({ phase: 'live', listenId: 'l-2', startedAt: 1_000, retry: null });
  });

  it('later drops do not renew the window', () => {
    const s = run([
      { type: 'reattach', now: 5_250 },
      { type: 'granted', attempt: 2, listenId: 'l-2' },
      { type: 'closed', attempt: 2, code: 1006, reason: '', now: 9_000 },
    ], dropped());
    expect(s.retry?.deadline).toBe(5_000 + AGENCY_LISTEN_RECONNECT_WINDOW_MS);
  });

  it('the window passes: "Connection lost"', () => {
    const deadline = 5_000 + AGENCY_LISTEN_RECONNECT_WINDOW_MS;
    expect(reduce(dropped(), { type: 'tick', now: deadline - 1 }).phase).toBe('reconnecting');
    expect(reduce(dropped(), { type: 'tick', now: deadline })).toMatchObject({ phase: 'lost', step: null, retry: null });
    expect(reduce(dropped(), { type: 'reattach', now: deadline }).phase).toBe('lost');
    const late = run([
      { type: 'reattach', now: 5_250 },
      { type: 'granted', attempt: 2, listenId: 'l-2' },
      { type: 'closed', attempt: 2, code: 1006, reason: '', now: deadline + 1 },
    ], dropped());
    expect(late.phase).toBe('lost');
  });

  it('server failures (1011) are retried a bounded number of times', () => {
    let s = live();
    let attempt = 1;
    for (let i = 1; i < LISTEN_MAX_INTERNAL_ERRORS; i++) {
      s = reduce(s, { type: 'closed', attempt, code: 1011, reason: 'tap_error', now: 2_000 + i });
      expect(s.phase, `failure ${i}`).toBe('reconnecting');
      expect(s.retry?.internalErrors).toBe(i);
      s = run([{ type: 'reattach', now: 2_100 + i }, { type: 'granted', attempt: attempt + 1, listenId: 'l' }], s);
      attempt += 1;
    }
    s = reduce(s, { type: 'closed', attempt, code: 1011, reason: 'listen_unavailable', now: 3_000 });
    expect(s.phase).toBe('lost');
  });

  it.each([
    ['the call ended (404 listen_call_not_live)', { status: 404, code: 'listen_call_not_live' }, 'ended', 'call_ended'],
    ['the permission went (403)', { status: 403, code: null }, 'ended', 'revoked'],
    ['the flag went off (403 feature_disabled)', { status: 403, code: 'feature_disabled' }, 'ended', 'revoked'],
    ['the call filled up (409 listen_limit_call)', { status: 409, code: 'listen_limit_call' }, 'ended', 'refused'],
    ['the process is full (503 listen_limit_server)', { status: 503, code: 'listen_limit_server' }, 'reconnecting', null],
    ['no answer at all', { status: null, code: null }, 'reconnecting', null],
  ] as const)('a refused re-grant when %s', (_name, refusal, phase, kind) => {
    const s = run([
      { type: 'reattach', now: 5_250 },
      { type: 'grant_refused', attempt: 2, refusal, now: 5_300 },
    ], dropped());
    expect(s.phase).toBe(phase);
    if (kind) expect(s.end?.kind).toBe(kind);
    else expect(s.step).toBe('wait');
  });

  it('a refused grant after a failed first socket is a re-grant, not a toast', () => {
    const s = run([
      { type: 'start', target: TARGET, now: 0 },
      { type: 'granted', attempt: 1, listenId: 'l-1' },
      { type: 'closed', attempt: 1, code: 1006, reason: '', now: 100 },
      { type: 'reattach', now: 400 },
      { type: 'grant_refused', attempt: 2, refusal: { status: 404, code: 'listen_call_not_live' }, now: 450 },
    ]);
    expect(s).toMatchObject({ phase: 'ended', end: { kind: 'call_ended' }, refusalSeq: 0 });
  });
});

describe('Try again', () => {
  const lost = () => reduce(dropped(), { type: 'tick', now: 5_000 + AGENCY_LISTEN_RECONNECT_WINDOW_MS });

  it('from lost: a fresh window and a new grant, the target kept', () => {
    const s = reduce(lost(), { type: 'retry', now: 30_000 });
    expect(s).toMatchObject({
      phase: 'reconnecting',
      step: 'grant',
      attempt: 2,
      target: TARGET,
      retry: { deadline: 30_000 + AGENCY_LISTEN_RECONNECT_WINDOW_MS, internalErrors: 0 },
    });
  });

  it('from lost before any audio: connecting again', () => {
    const s = run([
      { type: 'start', target: TARGET, now: 0 },
      { type: 'granted', attempt: 1, listenId: 'l-1' },
      { type: 'closed', attempt: 1, code: 1006, reason: '', now: 100 },
      { type: 'tick', now: 100 + AGENCY_LISTEN_RECONNECT_WINDOW_MS },
      { type: 'retry', now: 20_000 },
    ]);
    expect(s).toMatchObject({ phase: 'connecting', step: 'grant' });
  });

  it('only from lost', () => {
    const s = live();
    expect(reduce(s, { type: 'retry', now: 2 })).toBe(s);
  });
});

describe('the bar’s flags', () => {
  it('sound blocked: set and cleared, the same state when unchanged', () => {
    const blocked = reduce(live(), { type: 'sound', blocked: true });
    expect(blocked.soundBlocked).toBe(true);
    expect(reduce(blocked, { type: 'sound', blocked: true })).toBe(blocked);
    expect(reduce(blocked, { type: 'sound', blocked: false }).soundBlocked).toBe(false);
  });

  it('agent silent: only while live, and cleared by a drop', () => {
    const silent = reduce(live(), { type: 'agent_silent', silent: true });
    expect(silent.agentSilent).toBe(true);
    expect(reduce(silent, { type: 'closed', attempt: 1, code: 1006, reason: '', now: 3 }).agentSilent).toBe(false);
    const connecting = reduce(INITIAL_LISTEN_STATE, { type: 'start', target: TARGET, now: 0 });
    expect(reduce(connecting, { type: 'agent_silent', silent: true })).toBe(connecting);
  });

  it('pong: a clock sample, live only', () => {
    const s = reduce(live(), { type: 'pong', attempt: 1, sample: { ts: 1_000, server_ts: 3_050, receivedAt: 1_100 } });
    expect(s.clock.sampleCount).toBe(1);
    expect(s.clock.offsetMs).toBe(2_000);
  });
});

describe('regrantOutcome', () => {
  it('treats a 401 as revoked and other 4xx as a refusal that will not change', () => {
    expect(regrantOutcome({ status: 401, code: null })).toEqual({ kind: 'revoked' });
    expect(regrantOutcome({ status: 400, code: 'bad' })).toEqual({ kind: 'refused', code: null });
    expect(regrantOutcome({ status: 429, code: null })).toEqual({ kind: 'reconnect' });
    expect(regrantOutcome({ status: 500, code: null })).toEqual({ kind: 'reconnect' });
    expect(regrantOutcome({ status: 409, code: 'listen_own_call' })).toEqual({ kind: 'refused', code: 'listen_own_call' });
    expect(regrantOutcome({ status: 409, code: 'listen_recording_off' })).toEqual({ kind: 'refused', code: 'listen_recording_off' });
  });
});
