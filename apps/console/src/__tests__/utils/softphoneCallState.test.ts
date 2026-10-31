import { describe, it, expect } from 'vitest';
import {
  contactName,
  describeSoftphoneRail,
  isCallLive,
  isCallUnsettled,
  newerCall,
  softphonePhase,
} from '../../utils/softphone/callState';
import { audioTarget } from '../../utils/softphone/audioTarget';
import { stationReducer, INITIAL_STATION_STATE } from '../../utils/agencyStationReducer';
import { manualCall, step } from '../helpers/softphone';

describe('softphonePhase — the rail’s five states from one row', () => {
  it('reads every state', () => {
    const call = manualCall();
    expect(softphonePhase(null)).toBe('ready');
    expect(softphonePhase(call)).toBe('dialing');
    expect(softphonePhase({ ...call, state: 'dialing' })).toBe('dialing');
    expect(softphonePhase({ ...call, state: 'ringing' })).toBe('ringing');
    expect(softphonePhase({ ...call, state: 'answered' })).toBe('on_call');
    expect(softphonePhase({ ...call, state: 'bridged' })).toBe('on_call');
    expect(softphonePhase({ ...call, state: 'ended', requires_disposition: true })).toBe('outcome');
    expect(softphonePhase({ ...call, state: 'ended', requires_disposition: false })).toBe('ready');
    expect(softphonePhase({ ...call, state: 'ended', settled_at: '2026-10-30T10:05:00Z' })).toBe('ready');
  });

  it('holds the session for a live call and for one that owes its outcome, and for nothing else', () => {
    const call = manualCall();
    expect(isCallUnsettled({ ...call, state: 'ringing' })).toBe(true);
    expect(isCallUnsettled({ ...call, state: 'ended', requires_disposition: true })).toBe(true);
    expect(isCallUnsettled({ ...call, state: 'ended', requires_disposition: false })).toBe(false);
    expect(isCallLive({ ...call, state: 'ended', requires_disposition: true })).toBe(false);
  });
});

describe('newerCall — frames are the authority, HTTP answers fill the gap', () => {
  const base = manualCall();
  it('takes the later updated_at for the same call', () => {
    const ringing = step(base, 3, { state: 'ringing' });
    expect(newerCall(base, ringing)).toBe(ringing);
    expect(newerCall(ringing, base)).toBe(ringing);
  });

  it('lets the first argument (the frame) win a tie', () => {
    const frame = step(base, 3, { state: 'ended' });
    const http = step(base, 3, { state: 'ringing' });
    expect(newerCall(frame, http)).toBe(frame);
  });

  it('takes a settled copy over an unsettled one with the same stamp', () => {
    const unsettled = step(base, 9, { state: 'ended', requires_disposition: true });
    const settled = step(base, 9, { state: 'ended', settled_at: '2026-10-30T10:00:09.000Z' });
    expect(newerCall(unsettled, settled)).toBe(settled);
  });

  it('lets a new dial win over the one before it', () => {
    const next = manualCall({ id: 'mc-2', created_at: '2026-10-30T10:10:00.000Z', updated_at: '2026-10-30T10:10:00.000Z' });
    expect(newerCall(base, next)).toBe(next);
    expect(newerCall(next, base)).toBe(next);
  });
});

describe('the station reducer keeps the newest manual_call', () => {
  it('replaces on a newer frame and ignores an older one', () => {
    const queued = manualCall();
    const ringing = step(queued, 2, { state: 'ringing' });
    let state = stationReducer(INITIAL_STATION_STATE, { type: 'manual_call', call: queued });
    state = stationReducer(state, { type: 'manual_call', call: ringing });
    expect(state.manualCall?.state).toBe('ringing');
    const stale = stationReducer(state, { type: 'manual_call', call: queued });
    expect(stale).toBe(state);
  });

  it('is not cleared by a ready snapshot: the server re-sends manual_call after a reconnect', () => {
    const ringing = step(manualCall(), 2, { state: 'ringing' });
    let state = stationReducer(INITIAL_STATION_STATE, { type: 'manual_call', call: ringing });
    state = stationReducer(state, {
      type: 'ready',
      frame: { event: 'ready', session_id: 'sess-sp', state: 'break' },
      wrapup: null,
    });
    expect(state.manualCall?.id).toBe('mc-1');
  });
});

describe('audioTarget — the mic gates for a soft-phone call', () => {
  it('arms on the dial and opens the uplink only on bridged_at', () => {
    const queued = manualCall();
    expect(audioTarget({ stationIsGone: false, live: null, manualCall: queued })).toEqual({ id: 'mc-1', bridged: false });
    const answered = { ...queued, state: 'answered' as const };
    expect(audioTarget({ stationIsGone: false, live: null, manualCall: answered })).toEqual({ id: 'mc-1', bridged: false });
    const bridged = { ...queued, state: 'bridged' as const, bridged_at: '2026-10-30T10:00:05Z' };
    expect(audioTarget({ stationIsGone: false, live: null, manualCall: bridged })).toEqual({ id: 'mc-1', bridged: true });
  });

  it('releases the mic when the call ends, even while it owes an outcome, and when the station is gone', () => {
    const ended = manualCall({ state: 'ended', requires_disposition: true, bridged_at: '2026-10-30T10:00:05Z' });
    expect(audioTarget({ stationIsGone: false, live: null, manualCall: ended })).toEqual({ id: null, bridged: false });
    const live = manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' });
    expect(audioTarget({ stationIsGone: true, live: null, manualCall: live })).toEqual({ id: null, bridged: false });
  });
});

describe('describeSoftphoneRail', () => {
  const rail = (over: Partial<Parameters<typeof describeSoftphoneRail>[0]>) =>
    describeSoftphoneRail({ connection: 'open', call: null, lastCall: null, fromCampaign: false, contactName: null, ...over });

  it('Ready, with the campaign sentence only when switched from one', () => {
    expect(rail({}).label).toBe('Ready to dial');
    expect(rail({}).detail).not.toMatch(/paced/);
    expect(rail({ fromCampaign: true }).detail).toMatch(/not paced, and the campaign's dialer does not reserve you/);
  });

  it('Dialing and Ringing name the number and time from dialed_at', () => {
    const ringing = manualCall({ state: 'ringing' });
    const r = rail({ call: ringing });
    expect(r.label).toBe('Ringing +91 98204 61733');
    expect(r.detail).toMatch(/ringback tone plays in your browser/);
    expect(r.timerFrom).toBe(ringing.dialed_at);
    expect(rail({ call: manualCall() }).label).toBe('Dialing +91 98204 61733');
  });

  it('On call names the contact and times from bridged_at alone', () => {
    const answered = manualCall({ state: 'answered' });
    expect(rail({ call: answered }).timerFrom).toBeNull();
    const bridged = manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' });
    const r = rail({ call: bridged, contactName: 'Rahul Verma' });
    expect(r.tone).toBe('success');
    expect(r.label).toBe('On call with Rahul Verma');
    expect(r.timerFrom).toBe('2026-10-30T10:00:05Z');
  });

  it('Outcome needed after an answered call ends', () => {
    const ended = manualCall({ state: 'ended', requires_disposition: true, end_reason: 'remote_hangup', ended_at: '2026-10-30T10:04:00Z' });
    const r = rail({ call: ended });
    expect(r.label).toBe('Outcome needed');
    expect(r.detail).toMatch(/The customer hung up\./);
  });

  it('says how the last unanswered call ended on the Ready rail', () => {
    const last = manualCall({ state: 'ended', end_reason: 'no_answer', settled_at: '2026-10-30T10:01:00Z' });
    expect(rail({ lastCall: last }).detail).toMatch(/^Last call to \+91 98204 61733: No answer\./);
  });

  it('lets connection failures outrank the call', () => {
    const live = manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' });
    expect(rail({ connection: 'disconnected', call: live }).detail).toMatch(/customer can’t hear you/);
    expect(rail({ connection: 'reconnecting', call: live }).label).toBe('Reconnecting');
    expect(rail({ connection: 'superseded' }).tone).toBe('danger');
    expect(rail({ connection: 'connecting' }).label).toBe('Connecting your phone…');
  });
});

describe('contactName', () => {
  it('reads a name-like field through the tag’s display, never the first column', () => {
    const call = manualCall({
      contact: {
        contact_id: 'c-1',
        state: 'in_flight',
        claimed: true,
        context: { 'Loan account': 'HL-20931', Name: 'Rahul Verma' },
      },
    });
    expect(contactName(call, { hero: ['Loan account', 'Name'] })).toBe('Rahul Verma');
    expect(contactName(manualCall(), undefined)).toBeNull();
  });
});
