import { describe, it, expect } from 'vitest';
import { breakIsOver, stationScreen, stationView, type StationViewInput } from '../../utils/agency/stationView';

/**
 * The station's view model (AS1, spec §2): one agent state in, one screen out. Every input maps to
 * exactly one screen, with one main action; controls that do not belong are not offered.
 */

const BASE: StationViewInput = {
  firstName: 'Sunita',
  connection: 'open',
  agentState: 'offline',
  call: 'none',
  outcomeOwed: false,
  dialing: true,
  campaignReason: null,
  queue: null,
  diallingCustomer: false,
  breakReasonLabel: null,
  breakLimitMinutes: null,
  breakElapsedMs: null,
  checks: { microphone: 'ok', headset: 'ok' },
  finishOpen: false,
  helpOffered: true,
  helpOpen: false,
  softphoneAvailable: true,
  myContactsOffered: true,
};
const v = (patch: Partial<StationViewInput>) => stationView({ ...BASE, ...patch });

describe('which screen is on (spec §2)', () => {
  it.each<[string, Partial<StationViewInput>, string]>([
    ['01 start of day', {}, 'start'],
    ['01b a blocked microphone', { checks: { microphone: 'blocked', headset: 'ok' } }, 'check_failed'],
    ['01b no internet before work', { connection: 'reconnecting' }, 'check_failed'],
    ['02 ready', { agentState: 'available' }, 'ready'],
    ['02c calls stopped', { agentState: 'available', dialing: false }, 'no_calls'],
    ['02c nothing due', { agentState: 'available', queue: { due: false, reason: 'queue_empty', next_due_at: null } }, 'no_calls'],
    ['02 a hidden dial ringing outranks nothing due', { agentState: 'available', diallingCustomer: true, queue: { due: false, reason: 'queue_empty', next_due_at: null } }, 'ready'],
    ['03 call coming', { agentState: 'reserved', call: 'ringing' }, 'coming'],
    ['03 reserved with no attempt yet', { agentState: 'reserved' }, 'coming'],
    ['04 on call', { agentState: 'on_call', call: 'connected' }, 'on_call'],
    ['05 what happened', { agentState: 'wrapup', outcomeOwed: true }, 'happened'],
    ['05 between released and agent_state', { agentState: 'on_call', outcomeOwed: true }, 'happened'],
    ['07 on break', { agentState: 'break', breakLimitMinutes: 15, breakElapsedMs: 60_000 }, 'on_break'],
    ['08 break over', { agentState: 'break', breakLimitMinutes: 15, breakElapsedMs: 16 * 60_000 }, 'break_over'],
    ['09 internet problem', { agentState: 'available', connection: 'reconnecting' }, 'internet'],
    ['09 gave up', { agentState: 'available', connection: 'disconnected' }, 'internet'],
    ['10 call problem', { agentState: 'on_call', call: 'connected', connection: 'reconnecting' }, 'call_problem'],
    ['05 stays through a drop: its answer is kept', { agentState: 'wrapup', outcomeOwed: true, connection: 'reconnecting' }, 'happened'],
    ['11 finish work', { agentState: 'available', finishOpen: true }, 'finish'],
    ['12 open on another device', { agentState: 'available', connection: 'superseded' }, 'other_device'],
    ['12 outranks a call too', { agentState: 'on_call', call: 'connected', connection: 'superseded' }, 'other_device'],
    ['the session ended', { connection: 'session_gone' }, 'work_ended'],
  ])('%s', (_name, patch, screen) => {
    expect(stationScreen({ ...BASE, ...patch })).toBe(screen);
  });

  it('never asks Finish work over a call or an outcome owed', () => {
    expect(stationScreen({ ...BASE, finishOpen: true, agentState: 'on_call', call: 'connected' })).toBe('on_call');
    expect(stationScreen({ ...BASE, finishOpen: true, agentState: 'wrapup', outcomeOwed: true })).toBe('happened');
  });

  it('a break with no limit never runs over', () => {
    expect(breakIsOver(3 * 60 * 60_000, null)).toBe(false);
    expect(breakIsOver(15 * 60_000, 15)).toBe(false);
    expect(breakIsOver(15 * 60_000 + 1, 15)).toBe(true);
  });
});

describe('the band says where the agent is (spec §3)', () => {
  it('greets the agent by name and counts the checks the browser can do', () => {
    expect(v({}).title).toBe('Namaste, Sunita');
    expect(v({}).subtitle).toBe('Check these 3 things. Then start work.');
    expect(v({ checks: { microphone: 'ok', headset: 'unknown' } }).subtitle).toBe('Check these 2 things. Then start work.');
  });

  it.each<[Partial<StationViewInput>, string]>([
    [{ agentState: 'available', dialing: false, campaignReason: 'paused_by_supervisor' }, 'Your supervisor has stopped calls. Stay on this screen.'],
    [{ agentState: 'available', dialing: false, campaignReason: 'list_exhausted' }, 'No customers are waiting. Stay on this screen.'],
    [{ agentState: 'available', queue: { due: false, reason: 'queue_empty', next_due_at: null } }, 'No customers are waiting. Stay on this screen.'],
  ])('02c says why calls stopped, in its own words', (patch, subtitle) => {
    expect(v(patch).subtitle).toBe(subtitle);
  });

  it('02c names the next time when there is one', () => {
    const at = new Date();
    at.setHours(15, 0, 0, 0);
    expect(v({ agentState: 'available', queue: { due: false, reason: 'callbacks_later', next_due_at: at.toISOString() } }).subtitle).toBe('Your next call is at 3:00 PM.');
    at.setHours(9, 0, 0, 0);
    expect(v({ agentState: 'available', queue: { due: false, reason: 'outside_calling_hours', next_due_at: at.toISOString() } }).subtitle).toBe('Calls start at 9:00 AM.');
  });

  it('08 says how late, and turns red-orange with its own icon (never colour alone)', () => {
    const over = v({ agentState: 'break', breakLimitMinutes: 15, breakElapsedMs: (17 * 60 + 5) * 1000 });
    expect(over.title).toBe('Break time is over');
    expect(over.subtitle).toBe('You are 2:05 late. Start calls now.');
    expect(over.tone).toBe('over');
    expect(over.icon).toBe('warning');
  });

  it('a break the app took by itself reads Paused', () => {
    expect(v({ agentState: 'break', reservedBreak: true }).title).toBe('Paused');
  });

  it('every screen has its own icon and tone pair, so no two states share a look', () => {
    const looks = new Map<string, string>();
    const inputs: Partial<StationViewInput>[] = [
      {}, { checks: { microphone: 'blocked', headset: 'ok' } }, { agentState: 'available' }, { agentState: 'available', dialing: false },
      { agentState: 'reserved', call: 'ringing' }, { agentState: 'on_call', call: 'connected' }, { agentState: 'wrapup', outcomeOwed: true },
      { agentState: 'break' }, { agentState: 'break', breakLimitMinutes: 1, breakElapsedMs: 120_000 },
      { agentState: 'available', connection: 'reconnecting' }, { agentState: 'available', finishOpen: true }, { connection: 'superseded' },
    ];
    for (const input of inputs) {
      const view = v(input);
      const look = `${view.tone}/${view.icon}/${view.title}`;
      expect(looks.has(look), `${view.screen} looks like ${looks.get(look)}`).toBe(false);
      looks.set(look, view.screen);
    }
  });
});

describe('one main action per screen, in the same corner (AS1)', () => {
  it.each<[Partial<StationViewInput>, string | null]>([
    [{}, 'start_work'],
    [{ checks: { microphone: 'blocked', headset: 'ok' } }, 'check_again'],
    [{ agentState: 'available' }, 'take_break'],
    [{ agentState: 'available', dialing: false }, 'take_break'],
    // AS11: no stop button on Call coming.
    [{ agentState: 'reserved', call: 'ringing' }, null],
    [{ agentState: 'on_call', call: 'connected' }, 'end_call'],
    [{ agentState: 'wrapup', outcomeOwed: true }, 'save_next'],
    [{ agentState: 'break' }, 'start_calls'],
    [{ agentState: 'available', connection: 'reconnecting' }, 'try_again'],
    [{ agentState: 'available', finishOpen: true }, 'keep_working'],
    [{ connection: 'superseded' }, 'use_this_computer'],
  ])('%o', (patch, main) => {
    expect(v(patch).main).toBe(main);
  });

  it('Call coming says the call connects by itself instead', () => {
    expect(v({ agentState: 'reserved', call: 'ringing' }).footHint).toBe('The call connects by itself.');
  });
});

describe('Need help (AS5, phase 0)', () => {
  it('is offered on On call and What happened? only, where the server accepts it today', () => {
    expect(v({ agentState: 'on_call', call: 'connected' }).needHelp).toBe(true);
    expect(v({ agentState: 'wrapup', outcomeOwed: true }).needHelp).toBe(true);
    for (const patch of [{}, { agentState: 'available' as const }, { agentState: 'break' as const }, { agentState: 'reserved' as const, call: 'ringing' as const }]) {
      expect(v(patch).needHelp).toBe(false);
    }
  });

  it('stays reachable while a request is open, so the agent can cancel it', () => {
    expect(v({ agentState: 'available', helpOpen: true }).needHelp).toBe(true);
  });

  it('is never on 11 or 12, nor with the internet down, nor with the flag off', () => {
    expect(v({ agentState: 'available', finishOpen: true, helpOpen: true }).needHelp).toBe(false);
    expect(v({ connection: 'superseded', helpOpen: true }).needHelp).toBe(false);
    expect(v({ agentState: 'on_call', call: 'connected', connection: 'reconnecting' }).needHelp).toBe(false);
    // What happened? stays on screen through a drop; Need help does not (the press cannot reach anyone).
    expect(v({ agentState: 'wrapup', outcomeOwed: true, connection: 'reconnecting' }).needHelp).toBe(false);
    expect(v({ agentState: 'wrapup', outcomeOwed: true, connection: 'reconnecting', helpOpen: true }).needHelp).toBe(false);
    expect(v({ agentState: 'on_call', call: 'connected', helpOffered: false }).needHelp).toBe(false);
  });

  it('BE-9 slot: shown on every working screen once the server accepts it everywhere', () => {
    expect(v({ agentState: 'available', helpEverywhere: true }).needHelp).toBe(true);
    expect(v({ agentState: 'break', helpEverywhere: true }).needHelp).toBe(true);
    expect(v({ helpEverywhere: true }).needHelp).toBe(false);
  });
});

describe('⋮ More hides what cannot be used now (spec §3)', () => {
  it('holds everything on Ready, Finish work last', () => {
    expect(v({ agentState: 'available' }).menu).toEqual(['my_customers', 'dial_myself', 'my_calls', 'sound', 'theme', 'finish']);
  });

  it('holds only Sound (and the screen colour) during a call and on What happened?', () => {
    for (const patch of [
      { agentState: 'reserved' as const, call: 'ringing' as const },
      { agentState: 'on_call' as const, call: 'connected' as const },
      { agentState: 'wrapup' as const, outcomeOwed: true },
    ]) {
      expect(v(patch).menu).toEqual(['sound', 'theme']);
    }
  });

  it('is gone on 11 and 12', () => {
    expect(v({ agentState: 'available', finishOpen: true }).menu).toEqual([]);
    expect(v({ connection: 'superseded' }).menu).toEqual([]);
  });

  it('leaves out My customers and Dial a number myself where they are not on, and the dial tile is on Start of day itself', () => {
    expect(v({ agentState: 'available', myContactsOffered: false, softphoneAvailable: false }).menu).toEqual(['my_calls', 'sound', 'theme', 'finish']);
    expect(v({}).menu).not.toContain('dial_myself');
  });
});
