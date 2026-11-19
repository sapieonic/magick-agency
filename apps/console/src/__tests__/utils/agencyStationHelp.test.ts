import { describe, it, expect } from 'vitest';
import { ApiError } from '../../api/client';
import {
  STATION_HELP_COPY,
  helpNoticeText,
  helpRaisable,
  helpRefusalText,
  messageSender,
} from '../../utils/agency/stationHelp';

/** The agent's floor assist words (LF24–LF26): who answered, what a refusal means, who wrote. */

const refused = (status: number, code?: string) =>
  new ApiError(status, code ? { error: 'x', code, message: 'server words' } : { error: 'x' });

describe('helpRaisable', () => {
  it('is on a call or in wrap-up only (the server’s help_not_on_call rule)', () => {
    expect(helpRaisable('on_call')).toBe(true);
    expect(helpRaisable('wrapup')).toBe(true);
    for (const state of ['available', 'reserved', 'break', 'offline'] as const) expect(helpRaisable(state), state).toBe(false);
  });
});

describe('helpNoticeText', () => {
  it('names who answered and how', () => {
    expect(helpNoticeText({ kind: 'answered', raised_at: 'r', by_name: 'Priya', how: 'listen' })).toBe('Priya is listening in.');
    expect(helpNoticeText({ kind: 'answered', raised_at: 'r', by_name: 'Priya', how: 'message' })).toBe('Priya sent you a message.');
  });

  it('says “A supervisor” when the name could not be read', () => {
    expect(helpNoticeText({ kind: 'answered', raised_at: 'r', by_name: null, how: 'listen' })).toBe('A supervisor is listening in.');
    expect(helpNoticeText({ kind: 'answered', raised_at: 'r', by_name: '  ', how: 'message' })).toBe('A supervisor sent you a message.');
    expect(helpNoticeText({ kind: 'answered', raised_at: 'r', by_name: null, how: null })).toBe('A supervisor responded to your request.');
  });

  it('says a lapsed request may be raised again', () => {
    const text = helpNoticeText({ kind: 'expired', raised_at: 'r' });
    expect(text).toBe(STATION_HELP_COPY.expired);
    expect(text).toMatch(/15 minutes/);
    expect(text).toMatch(/ask again/);
  });
});

describe('helpRefusalText', () => {
  it('words every refusal the routes answer', () => {
    expect(helpRefusalText(refused(403, 'floor_assist_disabled'), 'raise')).toMatch(/not turned on/);
    expect(helpRefusalText(refused(409, 'help_not_on_call'), 'raise')).toBe(STATION_HELP_COPY.notOnCall);
    expect(helpRefusalText(refused(409, 'session_ended'), 'raise')).toMatch(/session has ended/);
    expect(helpRefusalText(refused(400, 'account_scope_required'), 'raise')).toMatch(/your account/);
    expect(helpRefusalText(refused(404), 'cancel')).toMatch(/not found/);
    expect(helpRefusalText(refused(403), 'raise')).toMatch(/permission/);
    expect(helpRefusalText(new Error('network'), 'raise')).toBe('Your request for help did not go through. Try again.');
    expect(helpRefusalText(refused(500), 'cancel')).toBe('Your request could not be cancelled. Try again.');
  });

  it('never shows the server’s raw words or a wire code', () => {
    for (const code of ['floor_assist_disabled', 'help_not_on_call', 'session_ended', 'account_scope_required']) {
      const text = helpRefusalText(refused(409, code), 'raise');
      expect(text).not.toContain('server words');
      expect(text).not.toContain(code);
    }
  });
});

describe('messageSender', () => {
  it('is the sender’s name, or “Your supervisor” when the server could not read it', () => {
    expect(messageSender('Priya N')).toBe('Priya N');
    expect(messageSender(null)).toBe('Your supervisor');
    expect(messageSender(' ')).toBe('Your supervisor');
  });
});
