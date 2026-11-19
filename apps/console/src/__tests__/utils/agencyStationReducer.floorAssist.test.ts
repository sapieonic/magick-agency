import { describe, it, expect } from 'vitest';
import {
  INITIAL_STATION_STATE,
  SUPERVISOR_MESSAGES_HELD,
  stationReducer,
  type StationState,
} from '../../utils/agencyStationReducer';
import type { AgencyStationSupervisorMessageFrame } from '@magick-agency/contracts/agency';

/**
 * Floor assist on the station (LF4, LF5, LF15, LF24): the open Need help request, moved by the
 * raise's and cancel's answers, `ready.help`, `help_answered` and `help_cleared`, and only ever by
 * a frame that names the request on screen; and the supervisors' messages, each id once.
 */

const R1 = '2026-11-19T10:00:00.000Z';
const R2 = '2026-11-19T10:20:00.000Z';

const raised = (raisedAt = R1, callId: string | null = 'call-1'): StationState =>
  stationReducer(INITIAL_STATION_STATE, { type: 'help_set', help: { raised_at: raisedAt, call_id: callId } });

const answered = (state: StationState, raisedAt = R1, byName: string | null = 'Priya N', how: 'listen' | 'message' = 'listen') =>
  stationReducer(state, { type: 'help_answered', frame: { event: 'help_answered', raised_at: raisedAt, by_name: byName, how } });

const cleared = (state: StationState, raisedAt: string, reason: 'cancelled' | 'expired' | 'answered' | 'session_ended') =>
  stationReducer(state, { type: 'help_cleared', frame: { event: 'help_cleared', raised_at: raisedAt, reason } });

const message = (id: string, text = 'Offer the 3-month plan'): AgencyStationSupervisorMessageFrame => ({
  event: 'supervisor_message',
  id,
  text,
  from_name: 'Priya N',
  sent_at: '2026-11-19T10:01:00.000Z',
});

describe('Need help on the station', () => {
  it('opens on the raise’s answer, and a re-raise answering the same request changes nothing', () => {
    const open = raised();
    expect(open.help).toEqual({ raised_at: R1, call_id: 'call-1' });
    // Idempotent on the server (LF13): the same request comes back, and no render follows.
    expect(stationReducer(open, { type: 'help_set', help: { raised_at: R1, call_id: 'call-1' } })).toBe(open);
  });

  it('closes on the agent’s cancel without a notice, and remembers it ended', () => {
    const open = raised();
    const gone = stationReducer(open, { type: 'help_set', help: null });
    expect(gone.help).toBeNull();
    expect(gone.helpNotice).toBeNull();
    expect(gone.helpEndedAt).toBe(R1);
    // A cancel with nothing open is nothing.
    expect(stationReducer(INITIAL_STATION_STATE, { type: 'help_set', help: null })).toBe(INITIAL_STATION_STATE);
  });

  it('says who answered and how, keeps it through the clear, and closes the request', () => {
    const heard = answered(raised(), R1, 'Priya N', 'listen');
    expect(heard.help).not.toBeNull();
    expect(heard.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: 'Priya N', how: 'listen' });
    const done = cleared(heard, R1, 'answered');
    expect(done.help).toBeNull();
    expect(done.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: 'Priya N', how: 'listen' });
  });

  it('says a supervisor answered when only the clear arrived', () => {
    const done = cleared(raised(), R1, 'answered');
    expect(done.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: null, how: null });
  });

  it('says the request lapsed on expired, and clears silently on cancelled and session_ended', () => {
    expect(cleared(raised(), R1, 'expired').helpNotice).toEqual({ kind: 'expired', raised_at: R1 });
    for (const reason of ['cancelled', 'session_ended'] as const) {
      const done = cleared(raised(), R1, reason);
      expect(done.help, reason).toBeNull();
      expect(done.helpNotice, reason).toBeNull();
    }
  });

  it('ignores an answer or a clear about any other request than the one on screen', () => {
    const open = raised(R2);
    // A late frame about the earlier request R1 must not touch R2.
    expect(answered(open, R1)).toBe(open);
    expect(cleared(open, R1, 'expired')).toBe(open);
    expect(cleared(open, R1, 'answered')).toBe(open);
    // With nothing open there is nothing to close, and nothing to say about a lapse.
    const lapsed = cleared(INITIAL_STATION_STATE, R1, 'expired');
    expect(lapsed.help).toBeNull();
    expect(lapsed.helpNotice).toBeNull();
  });

  it('remembers a request cleared while nothing is on screen: the raise’s answer landing after its own frames opens nothing', () => {
    // The raise is in flight; the server took it, a supervisor answered and it closed, all
    // before the HTTP answer came back.
    let state = answered(INITIAL_STATION_STATE, R1, 'Priya N', 'listen');
    state = cleared(state, R1, 'answered');
    expect(state.helpEndedAt).toBe(R1);
    state = stationReducer(state, { type: 'help_set', help: { raised_at: R1, call_id: 'call-1' } });
    // Not open (no frame about it is coming, so it would never close), and the answer is said.
    expect(state.help).toBeNull();
    expect(state.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: 'Priya N', how: 'listen' });
  });

  it('keeps an answer that arrived before the raise’s own answer, and closes on its clear', () => {
    let state = answered(INITIAL_STATION_STATE, R1, 'Priya N', 'message');
    state = stationReducer(state, { type: 'help_set', help: { raised_at: R1, call_id: 'call-1' } });
    expect(state.help).toEqual({ raised_at: R1, call_id: 'call-1' });
    expect(state.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: 'Priya N', how: 'message' });
    state = cleared(state, R1, 'answered');
    expect(state.help).toBeNull();
    expect(state.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: 'Priya N', how: 'message' });
  });

  it('shows the answer to a raise whose HTTP call failed after the server took it, and a retry opens nothing ended', () => {
    // The raise failed on the agent's side (the page set nothing), but the server holds R1.
    let state = answered(INITIAL_STATION_STATE, R1, 'Priya N', 'listen');
    expect(state.help).toBeNull();
    expect(state.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: 'Priya N', how: 'listen' });
    state = cleared(state, R1, 'answered');
    expect(state.helpNotice?.kind).toBe('answered');
    // Pressed again, the server (idempotent, LF13) names R1 if it were still open; it is not.
    expect(stationReducer(state, { type: 'help_set', help: { raised_at: R1, call_id: 'call-1' } })).toBe(state);
    // With only the clear (no answer frame), it is still an answer, said without a name.
    const onlyClear = cleared(INITIAL_STATION_STATE, R1, 'answered');
    expect(onlyClear.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: null, how: null });
    // A retry before any frame opens it, and its frames end it as usual.
    const retried = stationReducer(INITIAL_STATION_STATE, { type: 'help_set', help: { raised_at: R1, call_id: 'call-1' } });
    expect(cleared(retried, R1, 'expired').helpNotice).toEqual({ kind: 'expired', raised_at: R1 });
  });

  it('keeps the answer when the agent’s cancel lands between help_answered and help_cleared', () => {
    let state = answered(raised(), R1, 'Priya N', 'listen');
    state = stationReducer(state, { type: 'help_set', help: null });
    expect(state.help).toBeNull();
    expect(state.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: 'Priya N', how: 'listen' });
    state = cleared(state, R1, 'answered');
    expect(state.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: 'Priya N', how: 'listen' });
    expect(state.helpEndedAt).toBe(R1);
  });

  it('never re-opens a request a frame already ended (the raise’s answer landing late)', () => {
    // Raised, answered and cleared before the HTTP answer of a duplicate raise arrived.
    const done = cleared(answered(raised()), R1, 'answered');
    const late = stationReducer(done, { type: 'help_set', help: { raised_at: R1, call_id: 'call-1' } });
    expect(late).toBe(done);
    // A NEW request raised after it opens, and retires the old notice.
    const next = stationReducer(done, { type: 'help_set', help: { raised_at: R2, call_id: null } });
    expect(next.help).toEqual({ raised_at: R2, call_id: null });
    expect(next.helpNotice).toBeNull();
  });

  it('restores the open request from ready.help, and a ready without one closes it (a snapshot)', () => {
    const restored = stationReducer(INITIAL_STATION_STATE, {
      type: 'ready',
      frame: { event: 'ready', session_id: 'sess-1', state: 'on_call', help: { raised_at: R1, call_id: 'call-1' } },
      wrapup: null,
    });
    expect(restored.help).toEqual({ raised_at: R1, call_id: 'call-1' });
    // Frames about it work as on the first socket.
    expect(cleared(restored, R1, 'expired').helpNotice).toEqual({ kind: 'expired', raised_at: R1 });
    const ended = stationReducer(restored, {
      type: 'ready',
      frame: { event: 'ready', session_id: 'sess-1', state: 'available' },
      wrapup: null,
    });
    expect(ended.help).toBeNull();
    expect(ended.helpEndedAt).toBe(R1);
  });

  it('ignores a ready.help naming the request this station already saw cleared', () => {
    const done = cleared(answered(raised()), R1, 'answered');
    const stale = stationReducer(done, {
      type: 'ready',
      frame: { event: 'ready', session_id: 'sess-1', state: 'on_call', help: { raised_at: R1, call_id: 'call-1' } },
      wrapup: null,
    });
    expect(stale.help).toBeNull();
    expect(stale.helpNotice).toEqual({ kind: 'answered', raised_at: R1, by_name: 'Priya N', how: 'listen' });
    expect(stale.helpEndedAt).toBe(R1);
  });

  it('drops a notice about an older request when ready states a newer open one', () => {
    const lapsed = cleared(raised(R1), R1, 'expired');
    const other = stationReducer(lapsed, {
      type: 'ready',
      frame: { event: 'ready', session_id: 'sess-1', state: 'on_call', help: { raised_at: R2, call_id: null } },
      wrapup: null,
    });
    expect(other.help?.raised_at).toBe(R2);
    expect(other.helpNotice).toBeNull();
  });

  it('dismisses the notice', () => {
    const lapsed = cleared(raised(), R1, 'expired');
    expect(stationReducer(lapsed, { type: 'help_notice_dismissed' }).helpNotice).toBeNull();
  });
});

describe('supervisor messages on the station', () => {
  it('holds each message once, oldest first, until dismissed', () => {
    let state = stationReducer(INITIAL_STATION_STATE, { type: 'supervisor_message', frame: message('m-1') });
    state = stationReducer(state, { type: 'supervisor_message', frame: message('m-2', 'Wrap up this call') });
    // The same id again is the same message.
    expect(stationReducer(state, { type: 'supervisor_message', frame: message('m-1') })).toBe(state);
    expect(state.supervisorMessages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    state = stationReducer(state, { type: 'supervisor_message_dismissed', id: 'm-1' });
    expect(state.supervisorMessages.map((m) => m.id)).toEqual(['m-2']);
    expect(stationReducer(state, { type: 'supervisor_message_dismissed', id: 'nope' })).toBe(state);
  });

  it('keeps messages through a reconnect’s ready: they are not state the server restates', () => {
    const held = stationReducer(INITIAL_STATION_STATE, { type: 'supervisor_message', frame: message('m-1') });
    const ready = stationReducer(held, {
      type: 'ready',
      frame: { event: 'ready', session_id: 'sess-1', state: 'available' },
      wrapup: null,
    });
    expect(ready.supervisorMessages.map((m) => m.id)).toEqual(['m-1']);
  });

  it(`holds at most ${SUPERVISOR_MESSAGES_HELD}, dropping the oldest`, () => {
    let state = INITIAL_STATION_STATE;
    for (let i = 0; i < SUPERVISOR_MESSAGES_HELD + 3; i++) {
      state = stationReducer(state, { type: 'supervisor_message', frame: message(`m-${i}`) });
    }
    expect(state.supervisorMessages).toHaveLength(SUPERVISOR_MESSAGES_HELD);
    expect(state.supervisorMessages[0]!.id).toBe('m-3');
  });
});
