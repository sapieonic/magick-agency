import { describe, expect, it } from 'vitest';
import {
  hasAdvancedFinding,
  isAdvancedField,
  pickedLine,
  readyLine,
  staffingHint,
  wrapupLabel,
  wrapupOptions,
} from '../../../utils/campaignSetup/agentsTiming';
import { DEFAULT_ASSIGNMENT_CONFIG } from '../../../utils/agencyCampaignConfigForm';

/** Step 4's rules in words: the staffing line (CA1, CA4, CA5), the Ready line (CS15), wrap-up, Advanced. */

const WEEKDAYS = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] };

describe('readyLine', () => {
  it('reads as the footer does', () => {
    expect(readyLine({ customers: 1240, agents: 6, window: WEEKDAYS })).toBe(
      'Ready: 1,240 customers · 6 agents · 9 AM – 6 PM · 6 days a week',
    );
  });

  it('says one, none and every day', () => {
    expect(readyLine({ customers: 1, agents: 1, window: { ...WEEKDAYS, days: [1, 2, 3, 4, 5, 6, 7] } })).toBe(
      'Ready: 1 customer · 1 agent · 9 AM – 6 PM · every day',
    );
    expect(readyLine({ customers: 0, agents: 0, window: { start: '09:00', end: '20:30', days: [3] } })).toBe(
      'Ready: no customers · no agents · 9 AM – 8:30 PM · 1 day a week',
    );
  });

  it('groups a large count the Indian way, and leaves an unknown count out', () => {
    expect(readyLine({ customers: 125000, agents: 2, window: WEEKDAYS })).toBe(
      'Ready: 1,25,000 customers · 2 agents · 9 AM – 6 PM · 6 days a week',
    );
    expect(readyLine({ customers: null, agents: 2, window: WEEKDAYS })).toBe('Ready: 2 agents · 9 AM – 6 PM · 6 days a week');
  });
});

describe('pickedLine', () => {
  it('counts the ticks', () => {
    expect(pickedLine(6)).toBe('6 agents picked.');
    expect(pickedLine(1)).toBe('1 agent picked.');
    expect(pickedLine(0)).toBe('No agents picked yet.');
  });
});

describe('staffingHint', () => {
  it('on the shared pool (the default), does not promise a call-back to the same agent (CA4 is owner modes only)', () => {
    const hint = staffingHint(DEFAULT_ASSIGNMENT_CONFIG);
    expect(DEFAULT_ASSIGNMENT_CONFIG.mode).toBe('pool');
    expect(hint).toBe('Any free agent takes the next customer. Call-backs go to whichever agent is free when they are due.');
    expect(hint).not.toMatch(/same agent/);
  });

  it('on preferred, gives a call-back to its booker, then to any free agent after the grace (CA5)', () => {
    expect(staffingHint({ mode: 'preferred', callbackGraceMinutes: 30, callbackFallback: 'pool' })).toBe(
      'Each agent calls the customers assigned to them first, then customers nobody is assigned. '
        + 'A call-back goes to the agent who booked it. If that agent is not working 30 minutes after it is due, any free agent takes it.',
    );
  });

  it('on strict, says unassigned customers are not called and a freed call-back waits for a supervisor', () => {
    const hint = staffingHint({ mode: 'strict', callbackGraceMinutes: 1, callbackFallback: 'pool' });
    expect(hint).toContain('Customers nobody is assigned are not called.');
    expect(hint).toContain('If that agent is not working 1 minute after it is due, it waits for a supervisor to assign it.');
  });

  it('with the fallback set to wait, keeps the call-back with its booker', () => {
    expect(staffingHint({ mode: 'preferred', callbackGraceMinutes: 30, callbackFallback: 'wait' })).toMatch(
      /A call-back goes to the agent who booked it, and waits for them\.$/,
    );
  });
});

describe('wrap-up choices', () => {
  it('say the time as seconds and minutes, with none first', () => {
    expect(wrapupOptions(30).map((o) => o.label)).toEqual([
      'No time', '10 sec', '15 sec', '20 sec', '30 sec', '45 sec', '1 min', '1 min 30 sec', '2 min', '3 min', '5 min', '10 min',
    ]);
    expect(wrapupLabel(75)).toBe('1 min 15 sec');
  });

  it('keep a loaded value that is not a choice', () => {
    expect(wrapupOptions(75).map((o) => o.value)).toContain('75');
    expect(wrapupOptions(75).map((o) => Number(o.value))).toEqual([...wrapupOptions(75).map((o) => Number(o.value))].sort((a, b) => a - b));
  });
});

describe('the Advanced fold’s fields', () => {
  it('are the retry table, the abandonment limit, wrap-up extras, assignment, inbound, unanswered outcomes and breaks', () => {
    for (const field of [
      'retry_policy.busy.max_attempts',
      'abandonment_ceiling_pct',
      'allow_wrapup_redial',
      'callback_owner_grace_minutes',
      'inbound_sticky_enabled',
      'outcome_dispositions.no_answer',
      'break_reasons',
      'break_reasons[2].icon',
    ]) {
      expect(isAdvancedField(field), field).toBe(true);
    }
  });

  it('are not the settings the step shows open', () => {
    for (const field of ['wrapup_seconds', 'calling_window_start', 'calling_days', 'record_calls', 'daily_target_calls', 'disposition_catalog[0].code']) {
      expect(isAdvancedField(field), field).toBe(false);
    }
    expect(hasAdvancedFinding({ wrapup_seconds: 'x' })).toBe(false);
    expect(hasAdvancedFinding({ wrapup_seconds: 'x', 'retry_policy.no_answer.max_attempts': 'y' })).toBe(true);
  });
});
