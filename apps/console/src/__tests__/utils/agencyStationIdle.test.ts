import { describe, it, expect } from 'vitest';
import { DIAL_GAP_HOLD_MS } from '../../hooks/useDialActivityDisplay';
import { AGENCY_DIAL_ACTIVITY_COPY, AGENCY_DIAL_ACTIVITY_TIMING } from '../../types/agency';
import {
  DIALLING_HEADLINE,
  DIALLING_HINT,
  IDLE_GUIDE_HEADING,
  IDLE_GUIDE_INTRO,
  IDLE_KEYS_NOW,
  IDLE_KEYS_ON_CALL,
  IDLE_PAUSED_HINT,
  IDLE_WAITING_HINT,
  parseDialActivity,
  stationAgentLabel,
  unansweredLine,
} from '../../utils/agencyStationIdle';

const IMPLEMENTATION_WORDS = /websocket|session_id|core|bootstrap|payload|enum|uuid/i;

describe('stationAgentLabel', () => {
  it('prefers the display name', () => {
    expect(stationAgentLabel({ display_name: 'Asha Kumar', email: 'asha@example.com' })).toBe(
      'Asha Kumar',
    );
  });

  it('falls back to email when the name is blank', () => {
    expect(stationAgentLabel({ display_name: '  ', email: 'asha@example.com' })).toBe(
      'asha@example.com',
    );
    expect(stationAgentLabel({ display_name: null, email: 'asha@example.com' })).toBe(
      'asha@example.com',
    );
  });

  it('never returns a blank chip', () => {
    expect(stationAgentLabel(null)).toBe('Signed in');
    expect(stationAgentLabel({ display_name: null, email: '' })).toBe('Signed in');
  });
});

describe('idle copy', () => {
  it('names what to do, not how the station is wired', () => {
    const blobs = [
      IDLE_WAITING_HINT,
      IDLE_PAUSED_HINT,
      IDLE_GUIDE_HEADING,
      IDLE_GUIDE_INTRO,
      ...IDLE_KEYS_NOW.map((row) => `${row.key} ${row.does}`),
      ...IDLE_KEYS_ON_CALL.map((row) => `${row.key} ${row.does}`),
    ];
    for (const blob of blobs) expect(blob).not.toMatch(IMPLEMENTATION_WORDS);
  });

  it('lists a break key for the idle wait, and the live-call keys the page actually binds', () => {
    expect(IDLE_KEYS_NOW.map((row) => row.key)).toEqual(['B']);
    expect(IDLE_KEYS_ON_CALL.map((row) => row.key)).toEqual([
      '1–9',
      'N',
      'D',
      'Ctrl + Enter',
      'E then E',
    ]);
  });
});

describe('unansweredLine', () => {
  it('says nothing for none, or for a count that is not a count', () => {
    expect(unansweredLine(0)).toBeNull();
    expect(unansweredLine(-1)).toBeNull();
    expect(unansweredLine(Number.NaN)).toBeNull();
  });

  it('singular for one, the number for more', () => {
    expect(unansweredLine(1)).toBe('No answer from the last number');
    expect(unansweredLine(2)).toBe('No answer from the last 2 numbers');
    expect(unansweredLine(10)).toBe('No answer from the last 10 numbers');
  });
});

describe('the hidden dials\' words are the contract\'s (the agent app is held to the same)', () => {
  it('headline, hint and count lines come from AGENCY_DIAL_ACTIVITY_COPY, byte for byte', () => {
    expect(DIALLING_HEADLINE).toBe(AGENCY_DIAL_ACTIVITY_COPY.headline);
    expect(DIALLING_HINT).toBe(AGENCY_DIAL_ACTIVITY_COPY.hint);
    expect(unansweredLine(1)).toBe(AGENCY_DIAL_ACTIVITY_COPY.unanswered_one);
    expect(unansweredLine(7)).toBe(AGENCY_DIAL_ACTIVITY_COPY.unanswered_many.replace('{count}', '7'));
    expect(DIALLING_HEADLINE).toBe('Dialling a customer…');
    expect(DIALLING_HINT).toBe('You’ll be connected as soon as they answer.');
  });

  it('the gap hold is the contract\'s', () => {
    expect(DIAL_GAP_HOLD_MS).toBe(AGENCY_DIAL_ACTIVITY_TIMING.GAP_HOLD_MS);
  });
});

describe('parseDialActivity — the one check for both the frame and ready.dial_activity', () => {
  it('takes a well-formed activity, and only its two fields', () => {
    expect(parseDialActivity({ ringing: true, unanswered_in_a_row: 0 })).toEqual({ ringing: true, unanswered_in_a_row: 0 });
    expect(parseDialActivity({ event: 'dial_activity', campaign_id: 'camp-1', ringing: false, unanswered_in_a_row: 3 }))
      .toEqual({ ringing: false, unanswered_in_a_row: 3 });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['not an object', 'ringing'],
    ['ringing a string', { ringing: 'yes', unanswered_in_a_row: 1 }],
    ['ringing a number', { ringing: 1, unanswered_in_a_row: 1 }],
    ['ringing missing', { unanswered_in_a_row: 1 }],
    ['count missing', { ringing: true }],
    ['count a string', { ringing: true, unanswered_in_a_row: '2' }],
    ['count negative', { ringing: true, unanswered_in_a_row: -1 }],
    ['count fractional', { ringing: true, unanswered_in_a_row: 1.5 }],
    ['count NaN', { ringing: true, unanswered_in_a_row: Number.NaN }],
    ['count infinite', { ringing: true, unanswered_in_a_row: Number.POSITIVE_INFINITY }],
  ])('refuses %s', (_name, value) => {
    expect(parseDialActivity(value)).toBeNull();
  });
});
