import { describe, expect, it } from 'vitest';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import { attemptCallbackOf, callbackBookerOf, type CallLaterContact } from '../../../src/agency/call-later.js';
import { buildPanel } from '../../../src/agency/dialer/live-attempt.js';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

/**
 * Who booked a call-later, and the panel's call-later tag (agent station BE-3, BE-4; AS8;
 * `src/agency/call-later.ts`). The write is pinned on Postgres in
 * `test/integration/agency/callback-booker.test.ts`.
 */

const AGENT = 'agent-1';
const CATALOG: AgencyDisposition[] = [
  { code: 'sale', label: 'Sale', is_success: true },
  { code: 'call_later', label: 'Call later', requires_datetime: true },
  { code: 'ptp', label: 'Will pay', requires_promise: true, promise_follow_up_days: 1 },
  { code: 'ptp_no_follow', label: 'Will pay (no follow-up)', requires_promise: true },
];

describe('callbackBookerOf (BE-3)', () => {
  const base = { decisionReason: 'callback_scheduled', entry: { requires_datetime: true }, followUpBooked: false, onBehalf: false, reservedUserId: AGENT };

  it('the agent\'s own call-later stamps them', () => {
    expect(callbackBookerOf(base)).toEqual({ kind: 'mine', userId: AGENT });
  });

  it('a promise follow-up stamps them too (PT2)', () => {
    expect(callbackBookerOf({ ...base, entry: {}, followUpBooked: true })).toEqual({ kind: 'mine', userId: AGENT });
  });

  it('never on a supervisor\'s on-behalf save', () => {
    expect(callbackBookerOf({ ...base, onBehalf: true })).toEqual({ kind: 'on_behalf' });
  });

  it('nothing booked clears it', () => {
    expect(callbackBookerOf({ ...base, decisionReason: 'terminal' })).toBeNull();
    expect(callbackBookerOf({ ...base, entry: {}, followUpBooked: false })).toBeNull();
    expect(callbackBookerOf({ ...base, reservedUserId: null })).toBeNull();
  });
});

describe('attemptCallbackOf (BE-4)', () => {
  const due = new Date('2026-11-20T09:30:00Z');
  const contact = (over: Partial<CallLaterContact> = {}): CallLaterContact => ({
    last_outcome: 'connected', last_disposition: 'call_later', next_attempt_at: due,
    callback_source: null, callback_booked_by_user_id: AGENT, ...over,
  });

  it('the agent\'s own call-later coming due', () => {
    expect(attemptCallbackOf({ contact: contact(), catalog: CATALOG, agentUserId: AGENT, redial: false }))
      .toEqual({ due_at: '2026-11-20T09:30:00.000Z', booked_by_me: true, source: 'outcome' });
  });

  it('booked by another agent, or before the booker was recorded: not mine', () => {
    expect(attemptCallbackOf({ contact: contact({ callback_booked_by_user_id: 'agent-2' }), catalog: CATALOG, agentUserId: AGENT, redial: false })?.booked_by_me).toBe(false);
    expect(attemptCallbackOf({ contact: contact({ callback_booked_by_user_id: null }), catalog: CATALOG, agentUserId: AGENT, redial: false })?.booked_by_me).toBe(false);
    expect(attemptCallbackOf({ contact: contact(), catalog: CATALOG, agentUserId: undefined, redial: false })?.booked_by_me).toBe(false);
  });

  it('a promise follow-up is `promise`', () => {
    expect(attemptCallbackOf({ contact: contact({ last_disposition: 'ptp' }), catalog: CATALOG, agentUserId: AGENT, redial: false })?.source).toBe('promise');
  });

  it('an inbound callback is `inbound`, never mine', () => {
    expect(attemptCallbackOf({ contact: contact({ callback_source: 'inbound', last_disposition: null, last_outcome: null }), catalog: CATALOG, agentUserId: AGENT, redial: false }))
      .toEqual({ due_at: '2026-11-20T09:30:00.000Z', booked_by_me: false, source: 'inbound' });
  });

  it('absent on every other dial', () => {
    const none = (c: CallLaterContact) => attemptCallbackOf({ contact: c, catalog: CATALOG, agentUserId: AGENT, redial: false });
    expect(none(contact({ last_disposition: 'sale' }))).toBeUndefined();
    expect(none(contact({ last_disposition: 'ptp_no_follow' }))).toBeUndefined();
    // A call-later dialled and not answered is not one any more (`isCallbackSql`).
    expect(none(contact({ last_outcome: 'no_answer' }))).toBeUndefined();
    expect(none(contact({ last_disposition: null, last_outcome: null }))).toBeUndefined();
    expect(attemptCallbackOf({ contact: contact(), catalog: null, agentUserId: AGENT, redial: false })).toBeUndefined();
  });

  it('a wrap-up redial carries none', () => {
    expect(attemptCallbackOf({ contact: contact(), catalog: CATALOG, agentUserId: AGENT, redial: true })).toBeUndefined();
  });
});

describe('buildPanel: the reserved attempt carries the call-later tag (BE-4)', () => {
  const cmd = (over: Partial<DialCommand> = {}, contactOver: Record<string, unknown> = {}) => ({
    attemptId: 'a1', campaignId: 'c1', contactId: 'k1', callerId: '+919000000001', attemptNumber: 2, bridgeGraceMs: 3000,
    campaign: { name: 'Collections', context_display: {}, disposition_catalog: CATALOG },
    contact: {
      phone_e164: '+919811100001', context: {}, promise_date: null,
      last_outcome: 'connected', last_disposition: 'call_later', next_attempt_at: new Date('2026-11-20T09:30:00Z'),
      callback_source: null, callback_booked_by_user_id: AGENT, ...contactOver,
    },
    agentUserId: AGENT,
    ...over,
  }) as unknown as DialCommand;

  it('the agent\'s own call-later coming due', () => {
    expect(buildPanel(cmd(), []).callback).toEqual({ due_at: '2026-11-20T09:30:00.000Z', booked_by_me: true, source: 'outcome' });
  });

  it('for an agent the dial does not name, not mine', () => {
    expect(buildPanel(cmd({ agentUserId: undefined }), []).callback?.booked_by_me).toBe(false);
  });

  it('absent on an ordinary dial and on a wrap-up redial (the key is not sent at all)', () => {
    expect('callback' in buildPanel(cmd({}, { last_disposition: 'sale' }), [])).toBe(false);
    expect('callback' in buildPanel(cmd({ redial: { ofAttemptId: 'a0', number: 1 } }), [])).toBe(false);
  });
});
