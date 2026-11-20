import { describe, it, expect } from 'vitest';
import {
  DOING_WORDS,
  INBOUND_NOTICE_COPY,
  LAST_OUTCOME_LOST,
  dncDoneLine,
  dncFailedLine,
  hangupFailedLine,
  micProblemLine,
  presenceRefusedLine,
  redialRefusedLine,
  saveRefusedLine,
  breakRefusedLine,
  savedLine,
  STATION_BLOCK_COPY,
  STATION_COPY,
  SOFTPHONE_CLOSE_COPY,
  helpAnsweredLine,
  joinRefusedLine,
  switchFailedLine,
  helpRefusedLine,
  backToCallsRefusedLine,
  softphoneSwitchRefusedLine,
  missedReleaseLine,
  noCallsSubtitle,
  NO_CALLS_STOPPED_WORDS,
  releaseBanner,
} from '../../utils/agency/stationCopy';
import { STATION_HELP_COPY } from '../../utils/agency/stationHelp';
import { AGENCY_SOFTPHONE_ERROR_CODES } from '../../types/softphone';

/**
 * AS15 and spec §6.6: the station's own words never use the jargon on the spec's list. Every
 * string the station's copy can produce is collected here (functions are called with sample
 * arguments) and checked, so a new line that says "disposition" or "campaign" goes red.
 */
const BANNED = [
  /disposition/i,
  /wrap-?up/i,
  /pacing/i,
  /session/i,
  /station/i,
  /\bSIP\b/,
  /webrtc/i,
  /\bDNC\b/,
  /call-?back/i,
  /campaign/i,
  /reserved/i,
  /\bavailable\b/i,
  /\boffline\b/i,
  /reconnecting/i,
];

function everyString(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => everyString(v, out));
  else if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => unknown;
    for (const args of [[3], ['Sunita'], [null], ['3:00 PM', '₹12,500'], ['Tea'], [15, 15]]) {
      try {
        everyString(fn(...args), out);
      } catch {
        /* a sample that does not fit this function */
      }
    }
  } else if (value && typeof value === 'object') Object.values(value).forEach((v) => everyString(v, out));
  return out;
}

/** Every code the server's agency routes can refuse with (contracts `errors.ts`), and none. */
const SERVER_CODES: (string | null)[] = [
  'missing_actor', 'not_your_attempt', 'unknown_disposition_code', 'invalid_dnc_scope', 'note_required', 'datetime_required',
  'invalid_callback_at', 'attempt_not_dispositionable', 'already_dispositioned', 'unknown_break_reason', 'break_already_applied',
  'session_ended', 'session_on_other_campaign', 'agent_on_live_call', 'no_station', 'attempt_not_live', 'campaign_not_running',
  'feature_disabled', 'not_staffed', 'state_changing', 'redial_not_allowed', 'redial_limit_reached', 'disposition_already_submitted',
  'redial_blocked_dnc', 'redial_blocked_calling_hours', 'redial_blocked', 'inbound_call_live', 'manual_call_live', 'dial_failed',
  'unknown_attempt', null,
];

/** What `POST /sessions` can refuse with, and the client's own `no_campaign`. */
const JOIN_CODES: (string | null)[] = [
  ...SERVER_CODES, 'no_campaign', 'session_in_other_tenant', 'station_on_other_device', 'session_on_softphone',
  'station_token_unavailable', 'account_scope_required', 'not_a_code_we_know',
];

const ALL = [
  ...everyString(STATION_COPY),
  ...everyString(STATION_BLOCK_COPY),
  ...everyString(DOING_WORDS),
  ...everyString(INBOUND_NOTICE_COPY),
  LAST_OUTCOME_LOST,
  dncDoneLine(true),
  dncDoneLine(false),
  ...SERVER_CODES.flatMap((code) => [
    presenceRefusedLine(code),
    hangupFailedLine(code),
    dncFailedLine(code),
    redialRefusedLine(code, 409),
    redialRefusedLine(code, null),
    saveRefusedLine(code),
    breakRefusedLine(code),
  ]),
  ...JOIN_CODES.flatMap((code) => [403, 404, 409, 500, 503, null].flatMap((status) => [
    joinRefusedLine({ code, status }),
    joinRefusedLine({ code, status, placeName: 'Acme Collections' }),
  ])),
  ...(['resume', 'leave', 'rejoin'] as const).flatMap((stage) =>
    ['station_on_other_device', 'session_ended', null].map((code) => switchFailedLine(stage, 'Renewals', code))),
  ...everyString(SOFTPHONE_CLOSE_COPY),
  ...everyString(STATION_HELP_COPY),
  ...[...AGENCY_SOFTPHONE_ERROR_CODES, 'unknown', null].flatMap((code) => [softphoneSwitchRefusedLine(code), backToCallsRefusedLine(code)]),
  ...['permission_denied', 'no_device', 'device_busy', 'device_lost', 'audio_blocked', 'unsupported', 'x'].flatMap((k) => Object.values(micProblemLine(k)).filter((v): v is string => typeof v === 'string')),
  savedLine({ label: 'Call later', nextAttemptAt: '2026-11-20T09:30:00.000Z', callbackRequestedAt: '2026-11-20T03:30:00.000Z', dncRecorded: false }),
  ...['completed', 'no_answer', 'busy', 'agent_disconnected', 'remote_hangup', 'x'].map((r) => releaseBanner(r) ?? ''),
  ...['remote_hangup', 'agent_disconnected', 'no_answer', 'x'].map(missedReleaseLine),
  helpAnsweredLine('Priya', 'listen'),
  helpAnsweredLine(null, 'message'),
  helpAnsweredLine(null, null),
  ...['floor_assist_disabled', 'help_not_on_call', 'session_ended', 'account_scope_required', null].flatMap((code) => [
    helpRefusedLine({ action: 'raise', code, status: 409 }),
    helpRefusedLine({ action: 'cancel', code, status: 404 }),
    helpRefusedLine({ action: 'raise', code, status: 403 }),
    helpRefusedLine({ action: 'raise', code, status: 500 }),
  ]),
  ...everyString(NO_CALLS_STOPPED_WORDS),
  ...(['list_exhausted', 'paused_by_supervisor', 'stopped_by_supervisor', 'auto_paused', 'started', 'resumed', null] as const).flatMap((campaignReason) =>
    (['queue_empty', 'waiting_for_retry', 'callbacks_later', 'outside_calling_hours', null] as const).flatMap((queueReason) => [
      noCallsSubtitle({ campaignReason, dialing: false, queueReason, nextDueAt: null }),
      noCallsSubtitle({ campaignReason, dialing: true, queueReason, nextDueAt: '2026-11-20T09:30:00Z' }),
    ]),
  ),
].filter(Boolean);

describe('02c: why calls stopped, one table (spec §3 02c)', () => {
  it('blames the supervisor only for a supervisor’s pause or stop', () => {
    const blaming = Object.entries(NO_CALLS_STOPPED_WORDS).filter(([, line]) => /supervisor/i.test(line)).map(([reason]) => reason);
    expect(blaming.sort()).toEqual(['paused_by_supervisor', 'stopped_by_supervisor']);
  });
});

describe('the station’s own words (AS15, spec §6.6)', () => {
  it('collects a real body of copy, so the checks below cannot pass on nothing', () => {
    expect(ALL.length).toBeGreaterThan(150);
  });

  it.each(BANNED.map((re) => [re.source, re] as const))('never says %s', (_name, re) => {
    expect(ALL.filter((line) => re.test(line))).toEqual([]);
  });

  it('spells the British way', () => {
    expect(ALL.filter((line) => /\b(canceled|color|dialed|redialed|organization|center)\b/i.test(line))).toEqual([]);
  });
});

describe('why work did not open (AS15: keyed on the code, never the server’s sentence)', () => {
  it('says who to ask when the agent is not on the work', () => {
    expect(joinRefusedLine({ code: 'not_staffed', status: 403 })).toBe('You are not on this work. Ask your supervisor to add you.');
  });

  it('names the other account from its name, not from a sentence', () => {
    expect(joinRefusedLine({ code: 'session_in_other_tenant', status: 409, placeName: 'Acme Collections' }))
      .toBe('You are working in Acme Collections. Finish work there first, then come back here.');
    expect(joinRefusedLine({ code: 'session_in_other_tenant', status: 409, placeName: '  ' }))
      .toBe('You are working in another account. Finish work there first, then come back here.');
  });

  it('reads an unreadable other-list conflict as working on another list', () => {
    expect(joinRefusedLine({ code: 'session_on_other_campaign', status: 409 }))
      .toBe('You are working on another list. Finish work there first, then come back here.');
  });

  it('falls back by status, then to a safe line, for a code it does not know', () => {
    expect(joinRefusedLine({ code: 'something_new', status: 404 })).toBe('This work was not found. Ask your supervisor.');
    expect(joinRefusedLine({ code: 'something_new', status: 403 })).toBe('You cannot open this work. Ask your supervisor.');
    expect(joinRefusedLine({ code: null, status: null })).toBe('Check your internet. Then go back and try again.');
    expect(joinRefusedLine({ code: 'something_new', status: 500 })).toBe('We could not open your work just now. Go back and try again.');
  });

  it('says what is true after each step of the switch from another list', () => {
    expect(switchFailedLine('resume', 'Renewals', null)).toBe('We could not reach Renewals. Nothing changed. Try again.');
    expect(switchFailedLine('resume', 'Renewals', 'station_on_other_device'))
      .toBe('Renewals is open on another device. Finish work there, then come back here.');
    expect(switchFailedLine('leave', 'Renewals', 'state_changing')).toBe('Renewals is still open. Nothing changed. Try again.');
    // The one an agent must not be left to guess at: the other list is already closed.
    expect(switchFailedLine('rejoin', 'Renewals', null)).toBe('You left Renewals, but this work did not open. Go back and open it again.');
  });
});
