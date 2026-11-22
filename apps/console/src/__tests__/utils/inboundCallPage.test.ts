import { describe, expect, it } from 'vitest';
import {
  inboundCallCards,
  inboundCallHeadline,
  inboundCallerTitle,
  inboundFollowUpCard,
  inboundIdentityFacts,
  inboundJourneyLines,
  inboundOutcomeCard,
  inboundRecordCard,
} from '../../utils/agency/inboundCallPage';
import type { AgencyCallLogInboundRow, AgencyInboundJourneyStep } from '../../types/agency-call-log';

/** The inbound Call page's words (docs/call-log.md §4, P2). TZ is UTC and the locale en-IN in tests. */

const ANSWERED = {
  type: 'inbound', id: 'i-1', campaign_id: 'c-1', campaign_source: 'contact', contact_id: 'ct-1', phone_e164: '+919876504821',
  caller_id: '+919000000001', route_name: 'Sales line', agent_user_id: 'u-priya', agent_name: 'Priya Nair', state: 'ended',
  outcome: 'answered', disposition_code: 'will_pay', notes: 'Salary on 24th, will pay full EMI', callback_at: null,
  promise_date: '2026-11-25', promise_amount: '4850.00', dispositioned_by_user_id: 'u-priya', dispositioned_at: '2026-11-22T15:47:00.000Z',
  dispositioned_on_behalf: false, talk_seconds: 252, wait_seconds: 18, queued: true, via_sticky_agent: true,
  requires_disposition: false, voicemail_seconds: null, follow_up: null, called_back: null,
  created_at: '2026-11-22T15:42:01.000Z', answered_at: '2026-11-22T15:42:01.000Z', bridged_at: '2026-11-22T15:42:19.000Z',
  ended_at: '2026-11-22T15:46:31.000Z',
} as AgencyCallLogInboundRow;
const ANSWERED_PATH: AgencyInboundJourneyStep[] = [
  { kind: 'rang', at: '2026-11-22T15:42:01.000Z', seconds: null },
  { kind: 'greeting', at: '2026-11-22T15:42:01.000Z', seconds: null },
  { kind: 'waited', at: null, seconds: 18 },
  { kind: 'answered', at: '2026-11-22T15:42:19.000Z', seconds: null },
  { kind: 'ended', at: '2026-11-22T15:46:31.000Z', seconds: 252 },
];
const MISSED = {
  ...ANSWERED, id: 'i-2', campaign_source: 'route', contact_id: null, phone_e164: null, agent_user_id: null, agent_name: null,
  outcome: 'voicemail', disposition_code: null, notes: null, promise_date: null, promise_amount: null, dispositioned_at: null,
  talk_seconds: null, wait_seconds: 100, via_sticky_agent: false, bridged_at: null, voicemail_seconds: 22,
  follow_up: { status: 'open', reason: 'overflow', closed_cause: null, assignee_user_id: 'u-arjun', assignee_name: 'Arjun Mehta', handled_reason: null, handled_at: null },
} as AgencyCallLogInboundRow;
const CATALOG = [{ code: 'will_pay', label: 'Will pay' }] as never;

describe('the page’s title and headline', () => {
  it('names the caller by number, or says it was withheld', () => {
    expect(inboundCallerTitle(ANSWERED)).toContain('98765 04821');
    expect(inboundCallerTitle(MISSED)).toBe('Number withheld');
  });

  it('says it was an inbound call, when, and why it is in this campaign’s log', () => {
    expect(inboundCallHeadline(ANSWERED)).toMatch(/^Inbound · 22 Nov 2026, 03:42 pm · filed under this campaign because the number is on its list$/);
    expect(inboundCallHeadline(MISSED)).toContain('because the number they rang sends unknown callers here');
    expect(inboundCallHeadline({ ...ANSWERED, campaign_source: 'agent' })).toContain('by the agent who took the call');
    expect(inboundCallHeadline({ ...ANSWERED, campaign_source: 'supervisor' })).toContain('by a supervisor');
  });
});

describe('the caller’s path', () => {
  it('an answered call: rang, greeting, the wait through their own agent, who answered, the end and the talk time', () => {
    expect(inboundJourneyLines({ inbound: ANSWERED, journey: ANSWERED_PATH })).toEqual([
      { kind: 'rang', title: 'Rang', detail: '3:42:01 pm · Sales line' },
      { kind: 'greeting', title: 'Greeting', detail: 'we answered and played our message' },
      { kind: 'waited', title: 'Waited 0:18', detail: 'came through their agent' },
      { kind: 'answered', title: 'Priya Nair answered', detail: '3:42:19 pm' },
      { kind: 'ended', title: 'Ended', detail: '3:46:31 pm · talk 4:12' },
    ]);
  });

  it('a missed call: nobody answered, why in the Missed list’s words, and the voicemail', () => {
    const journey: AgencyInboundJourneyStep[] = [
      { kind: 'rang', at: MISSED.created_at, seconds: null },
      { kind: 'waited', at: null, seconds: 100 },
      { kind: 'missed', at: null, seconds: null },
      { kind: 'voicemail', at: null, seconds: 22 },
      { kind: 'ended', at: '2026-11-22T15:43:41.000Z', seconds: null },
    ];
    const lines = inboundJourneyLines({ inbound: { ...MISSED, route_name: null }, journey });
    expect(lines.map((line) => line.title)).toEqual(['Rang', 'Waited 1:40', 'Nobody answered', 'Left a voicemail', 'Ended']);
    expect(lines[0]!.detail).toBe('3:42:01 pm');
    expect(lines[1]!.detail).toBeNull();
    expect(lines[2]!.detail).toBe('Nobody free to answer');
    expect(lines[3]!.detail).toBe('0:22');
    // No talk time on a call nobody answered.
    expect(lines[4]!.detail).toBe('3:43:41 pm');
  });

  it('an agent whose name is gone still answered', () => {
    const lines = inboundJourneyLines({ inbound: { ...ANSWERED, agent_name: null }, journey: ANSWERED_PATH });
    expect(lines[3]!.title).toBe('An agent answered');
  });
});

describe('the cards', () => {
  it('an answered call shows the outcome the agent saved, by the campaign’s label, with the promise and the notes', () => {
    const card = inboundOutcomeCard({ inbound: ANSWERED, dispositioned_by_name: 'Priya Nair' }, CATALOG);
    expect(card).toMatchObject({ title: 'Outcome', source: 'Agent' });
    const by = Object.fromEntries(card.facts.map((fact) => [fact.label, fact.value]));
    expect(by['Outcome']).toBe('Will pay');
    expect(by['Saved']).toMatch(/· by Priya Nair$/);
    expect(by['Promise to pay']).toContain('25 Nov');
    expect(by['Notes']).toBe('Salary on 24th, will pay full EMI');
    expect(inboundCallCards({ inbound: ANSWERED, dispositioned_by_name: null }, CATALOG).map((c) => c.title)).toEqual(['Outcome']);
  });

  it('says an outcome is still owed, and who saved one on the agent’s behalf', () => {
    const owed = inboundOutcomeCard({ inbound: { ...ANSWERED, disposition_code: null, dispositioned_at: null, requires_disposition: true }, dispositioned_by_name: null }, CATALOG);
    expect(owed.facts[0]).toMatchObject({ value: 'No outcome yet', muted: true });
    const onBehalf = inboundOutcomeCard({ inbound: { ...ANSWERED, dispositioned_on_behalf: true }, dispositioned_by_name: 'Anil Kapoor' }, CATALOG);
    expect(onBehalf.facts[1]!.value).toMatch(/by Anil Kapoor, on the agent’s behalf$/);
  });

  it('a missed call shows its follow-up instead: where it stands, why, who has it, and whether it was rung back', () => {
    expect(inboundCallCards({ inbound: MISSED, dispositioned_by_name: null }, CATALOG).map((c) => c.title)).toEqual(['Follow-up']);
    const open = Object.fromEntries(inboundFollowUpCard(MISSED)!.facts.map((fact) => [fact.label, fact.value]));
    expect(open).toEqual({ 'Follow-up': 'To follow up', 'Why it was missed': 'Nobody free to answer', 'Assigned to': 'Arjun Mehta', 'Called back': 'Not yet' });
    const rungBack = { ...MISSED, called_back: { call_id: 'm-1', at: '2026-11-22T16:31:00.000Z' },
      follow_up: { ...MISSED.follow_up!, status: 'handled' as const, handled_reason: 'reached' as const, handled_at: '2026-11-22T16:32:00.000Z', assignee_user_id: null, assignee_name: null } };
    const closed = Object.fromEntries(inboundFollowUpCard(rungBack)!.facts.map((fact) => [fact.label, fact.value]));
    expect(closed).toMatchObject({ 'Follow-up': 'Customer reached', 'Assigned to': 'The account', 'Called back': '4:31 pm' });
    expect(closed['Closed']).toContain('22 Nov 2026');
    expect(inboundFollowUpCard(ANSWERED)).toBeNull();
  });

  it('the header facts and the record say who answered, what happened and the number rung', () => {
    const facts = Object.fromEntries(inboundIdentityFacts(ANSWERED).map((fact) => [fact.label, fact.value]));
    expect(facts['Agent']).toBe('Priya Nair');
    expect(facts['What happened']).toBe('Answered · waited 0:18 · came through their agent');
    expect(facts['Number they rang']).toMatch(/· Sales line$/);
    expect(facts['Talk time']).toBe('4:12');
    expect(inboundIdentityFacts(MISSED)[0]).toMatchObject({ value: 'Nobody answered', muted: true });
    expect(inboundRecordCard(MISSED).facts[0]).toMatchObject({ label: 'Caller', value: 'Number withheld', muted: true });
  });
});
