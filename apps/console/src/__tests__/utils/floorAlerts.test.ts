import { describe, it, expect } from 'vitest';
import type { AgencyFloorAlert } from '@magick-agency/contracts/api/agency/floor';
import { floorAlertItems, floorAlertText, quietAlertIds } from '../../utils/agency/floorAlerts';

/** Supervisor alerts in plain words (AS16, AS15), counted on the server's clock. */

const AS_OF = '2026-11-20T10:30:00.000Z';
const base = {
  session_id: 's-1', agent_user_id: 'a1b2c3d4e5f6', agent_name: 'Ravi', campaign_id: 'c-1', campaign_name: 'Collections',
};

const helpAlert = (over: Partial<AgencyFloorAlert> = {}): AgencyFloorAlert => ({
  ...base, id: 'help:s-1:t', kind: 'help', since: '2026-11-20T10:29:00.000Z',
  help: { raised_at: '2026-11-20T10:29:00.000Z', call_id: null, state_at_raise: 'available' },
  ...over,
} as AgencyFloorAlert);

const breakAlert = (since: string): AgencyFloorAlert => ({
  ...base, id: `break_over:s-1:${since}`, kind: 'break_over', since,
  break_reason: 'tea', break_label: 'Tea', limit_minutes: 15, break_started_at: '2026-11-20T10:00:00.000Z',
});

const dropAlert: AgencyFloorAlert = {
  ...base, id: 'disconnected:s-1:t', kind: 'disconnected', since: '2026-11-20T10:29:30.000Z',
  state: 'available', client_kind: 'web', call_id: null,
};

describe('floorAlertText', () => {
  it('says each kind in plain words', () => {
    expect(floorAlertText(helpAlert(), AS_OF)).toBe('Ravi needs help');
    expect(floorAlertText(dropAlert, AS_OF)).toBe('Ravi is disconnected');
  });

  it('counts a break’s minutes over from when it passed its limit to the read’s as_of', () => {
    expect(floorAlertText(breakAlert('2026-11-20T10:24:00.000Z'), AS_OF)).toBe('Ravi’s break is over by 6 min');
    expect(floorAlertText(breakAlert('2026-11-20T10:29:30.000Z'), AS_OF)).toBe('Ravi’s break is over time');
    // A viewer's clock is never read: an as_of earlier than since is not a negative count.
    expect(floorAlertText(breakAlert('2026-11-20T10:40:00.000Z'), AS_OF)).toBe('Ravi’s break is over time');
    expect(floorAlertText(breakAlert('not a time'), AS_OF)).toBe('Ravi’s break is over time');
  });

  it('names an agent the server could not name by the floor’s fallback', () => {
    expect(floorAlertText(helpAlert({ agent_name: null }), AS_OF)).toBe('Agent a1b2c3d4 needs help');
  });
});

describe('floorAlertItems', () => {
  it('keeps the server’s order and leaves out a kind it does not know', () => {
    const odd = { ...helpAlert(), id: 'odd:1', kind: 'something_new' } as unknown as AgencyFloorAlert;
    expect(floorAlertItems([dropAlert, odd, helpAlert()], AS_OF)).toEqual([
      { id: 'disconnected:s-1:t', kind: 'disconnected', text: 'Ravi is disconnected' },
      { id: 'help:s-1:t', kind: 'help', text: 'Ravi needs help' },
    ]);
  });
});

describe('quietAlertIds', () => {
  it('quiets Need help on Live floor only, where its own chime plays for it', () => {
    const items = floorAlertItems([helpAlert(), dropAlert], AS_OF);
    expect(quietAlertIds(items, true)).toEqual(['help:s-1:t']);
    expect(quietAlertIds(items, false)).toEqual([]);
  });
});
