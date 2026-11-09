import { describe, expect, it } from 'vitest';
import {
  AGENCY_INBOUND_AVAILABLE_ACTIONS,
  AGENCY_INBOUND_ROUTE_DEFAULTS,
  inboundRouteWarnings,
  type AgencyInboundRouteConfig,
} from '../src/api/agency/inbound';

/*
 * A route's advisory warnings (docs/inbound.md §6, §7): which missing recording leaves which
 * caller in silence, or makes a voicemail impossible. Served on the routes API and computed live
 * in the console's editor from this one function.
 */
type Shape = Pick<AgencyInboundRouteConfig, 'clips' | 'overflow_action' | 'after_hours_action'>;
const route = (over: Partial<Omit<Shape, 'clips'>> & { clips?: Partial<Shape['clips']> } = {}): Shape => ({
  overflow_action: over.overflow_action ?? 'callback',
  after_hours_action: over.after_hours_action ?? 'callback',
  clips: { ...AGENCY_INBOUND_ROUTE_DEFAULTS.clips, ...over.clips },
});
const codes = (r: Shape, connectsAgents = true) => inboundRouteWarnings(r, { connectsAgents }).map((w) => `${w.code}@${w.path}`);

describe('inboundRouteWarnings', () => {
  it('this build offers both actions', () => {
    expect([...AGENCY_INBOUND_AVAILABLE_ACTIONS]).toEqual(['callback', 'voicemail']);
  });

  it('agents connected, callback: a missing call-back or closed recording leaves a waiting caller in silence', () => {
    expect(codes(route())).toEqual(['overflow_message_silent@clips.callback', 'overflow_message_silent@clips.closed']);
    expect(codes(route({ clips: { callback: 'c' } }))).toEqual(['overflow_message_silent@clips.closed']);
    expect(codes(route({ clips: { callback: 'c', closed: 'x' } }))).toEqual([]);
  });

  it('nobody connected: the carrier speaks a missing message, so a callback route warns of nothing', () => {
    expect(codes(route(), false)).toEqual([]);
  });

  it('voicemail from the queue: only the beep without its prompt; with nobody connected no voicemail at all', () => {
    expect(codes(route({ overflow_action: 'voicemail', clips: { closed: 'x' } }))).toEqual(['voicemail_beep_only@clips.callback']);
    expect(codes(route({ overflow_action: 'voicemail', clips: { callback: 'c' } }))).toEqual(['voicemail_beep_only@clips.closed']);
    expect(codes(route({ overflow_action: 'voicemail', clips: { closed: 'x' } }), false)).toEqual(['voicemail_needs_prompt@clips.callback']);
  });

  it('voicemail out of hours needs the closed recording, connected or not', () => {
    const r = route({ after_hours_action: 'voicemail', clips: { callback: 'c' } });
    expect(codes(r)).toEqual(['overflow_message_silent@clips.closed', 'voicemail_needs_prompt@clips.closed']);
    expect(codes(r, false)).toEqual(['voicemail_needs_prompt@clips.closed']);
    expect(codes(route({ after_hours_action: 'voicemail', clips: { callback: 'c', closed: 'x' } }))).toEqual([]);
  });

  it('says it in British English, naming the recording to choose', () => {
    for (const w of inboundRouteWarnings(route({ after_hours_action: 'voicemail', overflow_action: 'voicemail' }), { connectsAgents: true })) {
      expect(w.message).toMatch(/Choose a recording for “(We’ll call you back|Closed)”/);
      expect(w.message).not.toMatch(/\b(color|canceled|dialed)\b/);
    }
  });
});
