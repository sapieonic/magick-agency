import { describe, it, expect } from 'vitest';
import { parseDialActivity, stationAgentLabel } from '../../utils/agencyStationIdle';

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
