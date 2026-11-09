import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getInboundCall: vi.fn(),
  updateInboundCallNotes: vi.fn(),
  hangupInboundCall: vi.fn(),
  dispositionInboundCall: vi.fn(),
  markInboundCallDnc: vi.fn(),
}));
vi.mock('../../api/inbound', () => api);

import {
  INBOUND_HUNG_UP_EARLY_COPY,
  INBOUND_MUTED_AT_CONNECT_COPY,
  INBOUND_REQUEUED_COPY,
  NOTES_DEBOUNCE_MS,
  useInboundCall,
  type UseInboundCallOptions,
} from '../../hooks/useInboundCall';
import { serverClock } from '../../hooks/useServerClock';
import type { InboundRefusal } from '../../api/inbound';
import { connected, inboundCall, owing } from '../helpers/inbound';

/**
 * The inbound panel's state (P2): the call held is the newest copy from the frame and the
 * routes' answers; a reconnect asks the server about it and retires a copy the server no longer
 * holds for this session; the notes autosave; the outcome, hang-up and DNC routes and their
 * refusals.
 */

const clock = serverClock(0);
const audio = { muted: false, sending: true, toggleMute: vi.fn() };

function refusal(over: Partial<InboundRefusal>): InboundRefusal {
  return {
    code: 'unknown',
    status: 409,
    message: 'Refused.',
    details: [],
    phoneNumberId: null,
    routeId: null,
    inboundCallId: null,
    allowedCodes: null,
    reason: null,
    ...over,
  };
}

function render(initial: Partial<UseInboundCallOptions> = {}) {
  const props: UseInboundCallOptions = {
    tenantId: 't-1',
    accountId: 'a-1',
    sessionId: 'sess-1',
    connection: 'open',
    frameCall: inboundCall(),
    clock,
    audio,
    mayMarkDnc: true,
    ...initial,
  };
  const view = renderHook((p: UseInboundCallOptions) => useInboundCall(p), { initialProps: props });
  return {
    ...view,
    set: (over: Partial<UseInboundCallOptions>) => {
      Object.assign(props, over);
      view.rerender({ ...props });
    },
  };
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  audio.toggleMute.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the call held', () => {
  it('follows the frames, and lets go once it settles', () => {
    const h = render();
    expect(h.result.current.phase).toBe('offered');
    h.set({ frameCall: connected() });
    expect(h.result.current.phase).toBe('connected');
    h.set({ frameCall: owing() });
    expect(h.result.current.phase).toBe('outcome');
    h.set({ frameCall: owing({ settled_at: '2026-11-09T10:05:00Z', disposition_code: 'resolved' }) });
    expect(h.result.current.call).toBeNull();
    expect(h.result.current.notice).toBeNull();
  });

  it('says why a call left without the agent: the caller hung up first, or it went back to the queue', () => {
    const h = render();
    h.set({ frameCall: inboundCall({ state: 'ended', outcome: 'abandoned_in_queue', settled_at: '2026-11-09T10:00:01Z' }) });
    expect(h.result.current.call).toBeNull();
    expect(h.result.current.notice).toBe(INBOUND_HUNG_UP_EARLY_COPY);
    const g = render();
    g.set({ frameCall: inboundCall({ state: 'queued' }) });
    expect(g.result.current.notice).toBe(INBOUND_REQUEUED_COPY);
  });

  it('tells a muted agent so the moment the caller is connected', () => {
    const h = render({ audio: { ...audio, muted: true } });
    h.set({ frameCall: connected() });
    expect(h.result.current.announcement).toBe(INBOUND_MUTED_AT_CONNECT_COPY);
  });
});

describe('restore after a reconnect', () => {
  it('asks the server about the call held, and retires it when the server no longer has it for us', async () => {
    api.getInboundCall.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 404, details: { code: 'inbound_call_not_found' } }));
    const h = render({ frameCall: connected() });
    h.set({ connection: 'reconnecting' });
    expect(api.getInboundCall).not.toHaveBeenCalled();
    await act(async () => h.set({ connection: 'open' }));
    expect(api.getInboundCall).toHaveBeenCalledWith('ib-1', 't-1', 'a-1');
    expect(h.result.current.call).toBeNull();
  });

  it('adopts the server’s copy: a call that ended while the socket was away owes its outcome', async () => {
    api.getInboundCall.mockResolvedValue(owing());
    const h = render({ frameCall: connected() });
    h.set({ connection: 'reconnecting' });
    await act(async () => h.set({ connection: 'open' }));
    expect(h.result.current.phase).toBe('outcome');
  });

  it('retires a call answered for another session', async () => {
    api.getInboundCall.mockResolvedValue(connected({ session_id: 'sess-other' }));
    const h = render({ frameCall: connected() });
    h.set({ connection: 'reconnecting' });
    await act(async () => h.set({ connection: 'open' }));
    expect(h.result.current.call).toBeNull();
  });

  it('keeps the call on any other failure: it is not evidence either way', async () => {
    api.getInboundCall.mockRejectedValue(new Error('network'));
    const h = render({ frameCall: connected() });
    h.set({ connection: 'reconnecting' });
    await act(async () => h.set({ connection: 'open' }));
    expect(h.result.current.phase).toBe('connected');
  });

  it('a frame restated after ready is the same call, and needs nothing', async () => {
    api.getInboundCall.mockResolvedValue(connected());
    const h = render({ frameCall: connected() });
    h.set({ connection: 'reconnecting' });
    await act(async () => h.set({ connection: 'open', frameCall: connected() }));
    expect(h.result.current.phase).toBe('connected');
  });

  it('does not ask on the first open', () => {
    render({ connection: 'connecting' }).set({ connection: 'open' });
    expect(api.getInboundCall).not.toHaveBeenCalled();
  });
});

describe('notes autosave', () => {
  it('saves the notes once typing pauses, and takes the server’s notes for a call arriving', async () => {
    vi.useFakeTimers();
    api.updateInboundCallNotes.mockResolvedValue({ ok: true, value: connected({ notes: 'Wants a statement' }) });
    const h = render({ frameCall: connected({ notes: 'From before the reload' }) });
    expect(h.result.current.notes).toBe('From before the reload');
    act(() => h.result.current.setNotes('Wants a'));
    act(() => h.result.current.setNotes('Wants a statement'));
    expect(api.updateInboundCallNotes).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTES_DEBOUNCE_MS);
    });
    expect(api.updateInboundCallNotes).toHaveBeenCalledTimes(1);
    expect(api.updateInboundCallNotes).toHaveBeenCalledWith('ib-1', 'Wants a statement', 't-1', 'a-1');
    expect(h.result.current.notesStatus.copy).toMatch(/^Saved /);
  });
});

describe('the outcome', () => {
  function picked(h: ReturnType<typeof render>, code: string, extra: Partial<{ callbackAt: string }> = {}) {
    act(() => h.result.current.setForm({ ...h.result.current.form, selectedCode: code, callbackAt: extra.callbackAt ?? null }));
  }

  it('is refused until the call ends, then saved with the code and the notes', async () => {
    const settled = owing({ settled_at: '2026-11-09T10:05:00Z', disposition_code: 'resolved' });
    api.dispositionInboundCall.mockResolvedValue({
      ok: true,
      value: { call: settled, contact_state: 'completed', next_attempt_at: null, callback_requested_at: null },
    });
    const h = render({ frameCall: connected() });
    picked(h, 'resolved');
    expect(h.result.current.saveBlockAt(Date.now())).toBe('call_live');
    h.set({ frameCall: owing() });
    act(() => h.result.current.setNotes('Sorted the address'));
    expect(h.result.current.saveBlockAt(Date.now())).toBeNull();
    await act(async () => h.result.current.saveOutcome());
    expect(api.dispositionInboundCall).toHaveBeenCalledWith('ib-1', { code: 'resolved', notes: 'Sorted the address' }, 't-1', 'a-1');
    expect(h.result.current.call).toBeNull();
    expect(h.result.current.announcement).toBe('Outcome saved.');
  });

  it('sends a callback time for a callback outcome', async () => {
    api.dispositionInboundCall.mockResolvedValue({ ok: false, refusal: refusal({ code: 'inbound_call_not_dispositionable' }) });
    const h = render({ frameCall: owing() });
    picked(h, 'callback', { callbackAt: '2099-01-02T10:00' });
    await act(async () => h.result.current.saveOutcome());
    const body = api.dispositionInboundCall.mock.calls[0]![1] as { code: string; callback_at?: string };
    expect(body.code).toBe('callback');
    expect(body.callback_at).toBe(new Date('2099-01-02T10:00').toISOString());
    expect(h.result.current.padRejection).toMatch(/can’t take an outcome/);
  });

  it('a changed outcome list rebuilds the pad from allowed_codes', async () => {
    api.dispositionInboundCall.mockResolvedValue({
      ok: false,
      refusal: refusal({ code: 'inbound_disposition_invalid', reason: 'unknown_code', allowedCodes: ['resolved', 'escalated'] }),
    });
    const h = render({ frameCall: owing() });
    picked(h, 'complaint');
    act(() => h.result.current.setNotes('note'));
    await act(async () => h.result.current.saveOutcome());
    expect(h.result.current.catalog.map((d) => d.code)).toEqual(['resolved', 'escalated']);
    expect(h.result.current.padRejection).toMatch(/outcome list for this call changed/);
  });

  it('an outcome already saved elsewhere asks the server for the call', async () => {
    api.dispositionInboundCall.mockResolvedValue({ ok: false, refusal: refusal({ code: 'inbound_outcome_already_saved' }) });
    api.getInboundCall.mockResolvedValue(owing({ settled_at: '2026-11-09T10:05:00Z', disposition_code: 'resolved' }));
    const h = render({ frameCall: owing() });
    picked(h, 'resolved');
    await act(async () => h.result.current.saveOutcome());
    expect(api.getInboundCall).toHaveBeenCalledWith('ib-1', 't-1', 'a-1');
    expect(h.result.current.call).toBeNull();
  });
});

describe('call controls', () => {
  it('hang up only once connected; the answer is adopted', async () => {
    api.hangupInboundCall.mockResolvedValue({ ok: true, value: owing() });
    const h = render();
    expect(h.result.current.hangupEnabled).toBe(false);
    await act(async () => h.result.current.hangup());
    expect(api.hangupInboundCall).not.toHaveBeenCalled();
    h.set({ frameCall: connected() });
    expect(h.result.current.hangupEnabled).toBe(true);
    await act(async () => h.result.current.hangup());
    expect(api.hangupInboundCall).toHaveBeenCalledWith('ib-1', 't-1', 'a-1');
    expect(h.result.current.phase).toBe('outcome');
  });

  it('a hang-up that fails says the caller may still be on the line', async () => {
    api.hangupInboundCall.mockResolvedValue({ ok: false, refusal: refusal({ code: 'unknown', message: 'Network' }) });
    const h = render({ frameCall: connected() });
    await act(async () => h.result.current.hangup());
    expect(h.result.current.hangupFailure).toMatch(/you may still be connected/);
  });

  it('mute is the microphone, and only with the caller connected and the uplink open', () => {
    const h = render();
    expect(h.result.current.muteEnabled).toBe(false);
    h.set({ frameCall: connected() });
    expect(h.result.current.muteEnabled).toBe(true);
    h.result.current.toggleMute();
    expect(audio.toggleMute).toHaveBeenCalled();
    h.set({ audio: { ...audio, sending: false } });
    expect(h.result.current.muteEnabled).toBe(false);
  });

  it('marks DNC with the campaign’s scope when the call matched one', async () => {
    api.markInboundCallDnc.mockResolvedValue({
      ok: true,
      value: { call_id: 'ib-1', phone_e164: '+919820461733', scope: 'campaign', dnc_recorded: true, contact_state: 'suppressed' },
    });
    const h = render({ frameCall: connected() });
    act(() => h.result.current.openDnc());
    expect(h.result.current.dncConfirmOpen).toBe(true);
    await act(async () => h.result.current.confirmDnc());
    expect(api.markInboundCallDnc).toHaveBeenCalledWith('ib-1', undefined, 't-1', 'a-1');
    expect(h.result.current.dncOutcome).toMatch(/on the Do Not Call list for Card Renewals\.$/);
  });

  it('offers no DNC for a withheld number, before the caller is connected, or without the permission', () => {
    expect(render({ frameCall: connected({ from_e164: null }) }).result.current.dncEnabled).toBe(false);
    expect(render({ frameCall: inboundCall() }).result.current.dncEnabled).toBe(false);
    expect(render({ frameCall: connected(), mayMarkDnc: false }).result.current.dncEnabled).toBe(false);
    expect(render({ frameCall: owing() }).result.current.dncEnabled).toBe(true);
  });
});
