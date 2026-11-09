import { describe, expect, it } from 'vitest';
import {
  AGENCY_INBOUND_AVAILABLE_ACTIONS,
  AGENCY_INBOUND_CLIP_SLOTS,
  AGENCY_INBOUND_SLOT_STANDARD,
  AGENCY_INBOUND_STANDARD_RECORDINGS,
  AGENCY_INBOUND_STANDARD_WORDS,
  inboundRouteWarnings,
  type AgencyInboundRouteConfig,
  type AgencyInboundStandardRecording,
} from '../src/api/agency/inbound';

/*
 * A route's advisory warnings (docs/inbound.md §8.4): a route that never opens, a deployment that
 * cannot put callers through, a call recorded with no notice. Served on the routes API and
 * computed live in the console's editor from this one function. A message with no recording is
 * never a warning: our standard recording plays.
 */
type Shape = Pick<AgencyInboundRouteConfig, 'weekly_hours' | 'record_calls' | 'recording_notice'>;
const OPEN: Shape['weekly_hours'] = [{ day: 1, start: '09:00', end: '17:30' }];
const route = (over: Partial<Shape> = {}): Shape => ({
  weekly_hours: over.weekly_hours ?? OPEN,
  record_calls: over.record_calls ?? false,
  recording_notice: over.recording_notice ?? true,
});
const codes = (r: Shape, connectsAgents = true) => inboundRouteWarnings(r, { connectsAgents }).map((w) => `${w.code}@${w.path ?? '-'}`);

describe('inboundRouteWarnings', () => {
  it('this build offers both actions', () => {
    expect([...AGENCY_INBOUND_AVAILABLE_ACTIONS]).toEqual(['callback', 'voicemail']);
  });

  it('a route with hours, connecting, not recorded: nothing to say', () => {
    expect(codes(route())).toEqual([]);
  });

  it('no opening hours: closed at all times', () => {
    expect(codes(route({ weekly_hours: [] }))).toEqual(['no_opening_hours@weekly_hours']);
    expect(inboundRouteWarnings(route({ weekly_hours: [] }), { connectsAgents: true })[0]!.message)
      .toBe('Closed at all times: callers always hear the closed message. Add opening hours to take calls.');
  });

  it('a deployment that cannot put callers through says so, whatever the route', () => {
    expect(codes(route(), false)).toEqual(['connect_unavailable@-']);
    expect(codes(route({ weekly_hours: [] }), false)).toEqual(['no_opening_hours@weekly_hours', 'connect_unavailable@-']);
  });

  it('names the message callers actually hear: the call-back message, nobody put through (busy only for those never promised one)', () => {
    const [w] = inboundRouteWarnings(route(), { connectsAgents: false });
    expect(w!.message).toBe(
      'Calls can’t be put through to agents on this deployment, so nobody is put through: in opening hours, callers hear '
      + 'our “we’ll call you back” message (or, if they withheld their number or are on your do-not-call list, our “all lines busy” message).',
    );
  });

  it('recorded with the notice off warns; recorded with it on (the standard notice plays) does not', () => {
    expect(codes(route({ record_calls: true, recording_notice: false }))).toEqual(['recording_without_notice@recording_notice']);
    expect(codes(route({ record_calls: true, recording_notice: true }))).toEqual([]);
    expect(codes(route({ record_calls: false, recording_notice: false }))).toEqual([]);
  });

  it('says it in British English', () => {
    for (const w of inboundRouteWarnings(route({ weekly_hours: [], record_calls: true, recording_notice: false }), { connectsAgents: false })) {
      expect(w.message).not.toMatch(/\b(color|canceled|dialed|center)\b/);
    }
  });
});

describe('the standard recordings', () => {
  it('every one has its words, and nothing else has words', () => {
    expect(Object.keys(AGENCY_INBOUND_STANDARD_WORDS).sort()).toEqual([...AGENCY_INBOUND_STANDARD_RECORDINGS].sort());
    for (const words of Object.values(AGENCY_INBOUND_STANDARD_WORDS)) expect(words.trim().length).toBeGreaterThan(10);
  });

  it('a slot stands in with its own recording; hold has none (the built-in tone)', () => {
    expect(Object.keys(AGENCY_INBOUND_SLOT_STANDARD).sort()).toEqual([...AGENCY_INBOUND_CLIP_SLOTS].sort());
    expect(AGENCY_INBOUND_SLOT_STANDARD.hold).toBeNull();
    expect(AGENCY_INBOUND_SLOT_STANDARD.greeting).toBe<AgencyInboundStandardRecording>('please_hold');
  });

  it('only the call-back and voicemail words promise a callback', () => {
    const promising = AGENCY_INBOUND_STANDARD_RECORDINGS.filter((r) => /call you back/i.test(AGENCY_INBOUND_STANDARD_WORDS[r]));
    expect(promising).toEqual(['callback', 'voicemail_prompt']);
  });
});
