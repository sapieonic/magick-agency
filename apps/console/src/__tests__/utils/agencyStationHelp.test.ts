import { describe, it, expect } from 'vitest';
import { helpRaisable, messageSender } from '../../utils/agency/stationHelp';

/**
 * The agent's floor assist rules (LF24–LF26): where raising is offered, who wrote. Who answered and
 * what a refusal means are the station's words (`helpAnsweredLine`, `helpRefusedLine`, pinned in
 * `stationCopy.test.ts` and at the page).
 */

describe('helpRaisable', () => {
  it('is on a call or in wrap-up only (the server’s help_not_on_call rule)', () => {
    expect(helpRaisable('on_call')).toBe(true);
    expect(helpRaisable('wrapup')).toBe(true);
    for (const state of ['available', 'reserved', 'break', 'offline'] as const) expect(helpRaisable(state), state).toBe(false);
  });
});

describe('messageSender', () => {
  it('is the sender’s name, or “Your supervisor” when the server could not read it', () => {
    expect(messageSender('Priya N')).toBe('Priya N');
    expect(messageSender(null)).toBe('Your supervisor');
    expect(messageSender(' ')).toBe('Your supervisor');
  });
});
