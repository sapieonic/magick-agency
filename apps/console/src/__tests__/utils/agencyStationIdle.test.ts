import { describe, it, expect } from 'vitest';
import {
  IDLE_GUIDE_HEADING,
  IDLE_GUIDE_INTRO,
  IDLE_KEYS_NOW,
  IDLE_KEYS_ON_CALL,
  IDLE_PAUSED_HINT,
  IDLE_WAITING_HINT,
  stationAgentLabel,
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
