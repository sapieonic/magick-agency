import { describe, it, expect } from 'vitest';
import { isoMs, mergeListenVisits, type ListenSessionSpan } from '../../../utils/listen/listenVisits';
import { AGENCY_LISTEN_HISTORY_MERGE_GAP_MS } from '../../../types/listen-history';

/**
 * Merging a supervisor's sessions on one call into visits for display (`docs/listening.md` §9,
 * LS19 b): the server history's rule, so "Listened to by" and a campaign History's listen rows
 * say what the Listening history page says.
 */

const S = 1_000;
const GAP = AGENCY_LISTEN_HISTORY_MERGE_GAP_MS;

function session(over: Partial<ListenSessionSpan> & { id: string; startedMs: number }): ListenSessionSpan {
  return { listenerId: 'sup-1', callId: 'call-1', endedMs: over.startedMs + 10 * S, endReason: 'listener_stopped', ...over };
}

const merge = (sessions: ListenSessionSpan[], gap?: number) => mergeListenVisits(sessions, (s) => s, gap);

describe('mergeListenVisits', () => {
  it('is the server’s 30 s', () => {
    expect(GAP).toBe(30_000);
  });

  it('one session is one visit, its time and reason its own', () => {
    const [v] = merge([session({ id: 'a', startedMs: 0, endedMs: 130 * S, endReason: 'call_ended' })]);
    expect(v).toMatchObject({ startedMs: 0, endedMs: 130 * S, listenedMs: 130 * S, endReason: 'call_ended' });
    expect(v!.sessions.map((s) => s.id)).toEqual(['a']);
  });

  it('a reconnect within the gap joins the visit; the time counts the sessions, not the gap', () => {
    const visits = merge([
      session({ id: 'b', startedMs: 70 * S, endedMs: 100 * S, endReason: 'listener_stopped' }),
      session({ id: 'a', startedMs: 0, endedMs: 60 * S, endReason: 'listener_disconnected' }),
    ]);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ startedMs: 0, endedMs: 100 * S, listenedMs: 90 * S, endReason: 'listener_stopped' });
    expect(visits[0]!.sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('exactly the gap still joins; a millisecond past it is a new visit', () => {
    expect(merge([session({ id: 'a', startedMs: 0, endedMs: 10 * S }), session({ id: 'b', startedMs: 10 * S + GAP })])).toHaveLength(1);
    expect(merge([session({ id: 'a', startedMs: 0, endedMs: 10 * S }), session({ id: 'b', startedMs: 10 * S + GAP + 1 })])).toHaveLength(2);
  });

  it('overlapping sessions count the overlap once, and the reason is the last to end', () => {
    const [v] = merge([
      session({ id: 'a', startedMs: 0, endedMs: 60 * S, endReason: 'listener_disconnected' }),
      session({ id: 'b', startedMs: 50 * S, endedMs: 80 * S, endReason: 'call_ended' }),
    ]);
    expect(v).toMatchObject({ listenedMs: 80 * S, endedMs: 80 * S, endReason: 'call_ended' });
  });

  it('a session inside an earlier one adds nothing and does not take the reason', () => {
    const [v] = merge([
      session({ id: 'a', startedMs: 0, endedMs: 100 * S, endReason: 'call_ended' }),
      session({ id: 'b', startedMs: 20 * S, endedMs: 40 * S, endReason: 'listener_disconnected' }),
    ]);
    expect(v).toMatchObject({ listenedMs: 100 * S, endedMs: 100 * S, endReason: 'call_ended' });
  });

  it('a session joining an open one, however late, is the same visit; the visit is open', () => {
    const [v, ...rest] = merge([
      session({ id: 'a', startedMs: 0, endedMs: null, endReason: null }),
      session({ id: 'b', startedMs: 5 * 60 * S, endedMs: 6 * 60 * S }),
    ]);
    expect(rest).toEqual([]);
    expect(v).toMatchObject({ endedMs: null, listenedMs: null, endReason: null });
    expect(v!.sessions).toHaveLength(2);
  });

  it('another listener or another call is another visit, however close', () => {
    const visits = merge([
      session({ id: 'a', startedMs: 0 }),
      session({ id: 'b', startedMs: 1 * S, listenerId: 'sup-2' }),
      session({ id: 'c', startedMs: 2 * S, callId: 'call-2' }),
    ]);
    expect(visits.map((v) => [v.listenerId, v.callId])).toEqual([['sup-1', 'call-1'], ['sup-2', 'call-1'], ['sup-1', 'call-2']]);
  });

  it('a supervisor who comes back minutes later is a new visit, earliest first', () => {
    const visits = merge([
      session({ id: 'b', startedMs: 10 * 60 * S, endReason: 'call_ended' }),
      session({ id: 'a', startedMs: 0, endReason: 'listener_stopped' }),
    ]);
    expect(visits.map((v) => [v.sessions.map((s) => s.id), v.endReason])).toEqual([[['a'], 'listener_stopped'], [['b'], 'call_ended']]);
  });

  it('leaves out what it cannot read', () => {
    expect(mergeListenVisits([1, 2], (n) => (n === 1 ? null : session({ id: 'x', startedMs: 0 })))).toHaveLength(1);
    expect(merge([session({ id: 'x', startedMs: Number.NaN })])).toEqual([]);
  });

  it('takes the gap it is given', () => {
    expect(merge([session({ id: 'a', startedMs: 0, endedMs: 10 * S }), session({ id: 'b', startedMs: 15 * S })], 1 * S)).toHaveLength(2);
  });
});

describe('isoMs', () => {
  it('reads an instant, and nothing else', () => {
    expect(isoMs('2026-11-16T10:00:00Z')).toBe(Date.UTC(2026, 10, 16, 10));
    expect(isoMs(null)).toBeNull();
    expect(isoMs('soon')).toBeNull();
  });
});
