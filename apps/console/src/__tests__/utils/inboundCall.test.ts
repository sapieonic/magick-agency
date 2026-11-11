import { describe, it, expect } from 'vitest';
import {
  INBOUND_DNC_ENQUIRY_COPY,
  NUMBER_WITHHELD,
  catalogHint,
  customerWaitingLine,
  describeInboundRail,
  inboundCallerLabel,
  inboundCallerNumber,
  inboundMatchName,
  inboundPhase,
  isInboundCallLive,
  isInboundCallOnStation,
  matchLine,
  newerInboundCall,
  stickyLine,
  waitedLine,
} from '../../utils/inbound/inboundCall';
import { connected, inboundCall, owing } from '../helpers/inbound';

/**
 * The inbound call as the station reads it (P2): which phase it puts the panel in, which of two
 * copies is newer (the row has no `updated_at`), and the rail's and the panel's words.
 */

describe('inboundPhase', () => {
  it('offered, connected, and an answered call owing its outcome are on the station', () => {
    expect(inboundPhase(inboundCall())).toBe('offered');
    expect(inboundPhase(connected())).toBe('connected');
    expect(inboundPhase(owing())).toBe('outcome');
    expect(isInboundCallLive(inboundCall())).toBe(true);
    expect(isInboundCallLive(connected())).toBe(true);
    expect(isInboundCallLive(owing())).toBe(false);
  });

  it('a settled call, an unanswered end and a requeued call are not', () => {
    expect(inboundPhase(owing({ settled_at: '2026-11-09T10:05:00Z', disposition_code: 'resolved' }))).toBeNull();
    // The caller hung up before audio bound: nobody spoke to them, nothing is owed.
    expect(inboundPhase(inboundCall({ state: 'ended', outcome: 'abandoned_in_queue' }))).toBeNull();
    expect(inboundPhase(inboundCall({ state: 'queued' }))).toBeNull();
    expect(isInboundCallOnStation(null)).toBe(false);
  });
});

describe('newerInboundCall', () => {
  it('within one offer, progress wins and the first copy wins a tie', () => {
    const offered = inboundCall();
    const live = connected();
    expect(newerInboundCall(offered, live)).toBe(live);
    expect(newerInboundCall(live, offered)).toBe(live);
    const ended = owing();
    expect(newerInboundCall(live, ended)).toBe(ended);
    const sameAgain = connected();
    expect(newerInboundCall(live, sameAgain)).toBe(live);
  });

  it('a settled copy beats an unsettled one, whatever came first', () => {
    const owed = owing({ notes: 'typed later' });
    const settled = owing({ settled_at: '2026-11-09T10:05:00Z', disposition_code: 'resolved' });
    expect(newerInboundCall(owed, settled)).toBe(settled);
    expect(newerInboundCall(settled, owed)).toBe(settled);
  });

  it('a requeue beats the offer it ended; a later re-offer beats the requeue', () => {
    const offered = inboundCall();
    const requeued = inboundCall({ state: 'queued' });
    expect(newerInboundCall(offered, requeued)).toBe(requeued);
    const reoffered = inboundCall({ offered_at: '2026-11-09T10:01:00.000Z' });
    expect(newerInboundCall(requeued, reoffered)).toBe(reoffered);
  });

  it('a different call: the later offer wins', () => {
    const first = owing();
    const second = inboundCall({ id: 'ib-2', offered_at: '2026-11-09T10:40:00.000Z' });
    expect(newerInboundCall(first, second)).toBe(second);
    expect(newerInboundCall(second, first)).toBe(second);
    expect(newerInboundCall(null, first)).toBe(first);
    expect(newerInboundCall(first, undefined)).toBe(first);
  });
});

describe('the caller, in words', () => {
  it('names a matched contact, else the number, else "Number withheld"', () => {
    expect(inboundMatchName(inboundCall())).toBe('Asha Rao');
    expect(inboundCallerLabel(inboundCall())).toBe('Asha Rao');
    expect(inboundCallerLabel(inboundCall({ match: null }))).toBe(inboundCallerNumber('+919820461733'));
    expect(inboundCallerLabel(inboundCall({ match: null, from_e164: null }))).toBe(NUMBER_WITHHELD);
    expect(NUMBER_WITHHELD).toBe('Number withheld');
  });

  it('says why the caller is "your customer", and when they usually speak to someone else', () => {
    expect(stickyLine(inboundCall())).toBe('Your customer: you last spoke to them');
    expect(stickyLine(inboundCall({ sticky: { reason: 'owner', is_you: true } }))).toMatch(/assigned to you/);
    expect(stickyLine(inboundCall({ sticky: { reason: 'owner', is_you: false } }))).toMatch(/another agent/);
    expect(stickyLine(inboundCall({ sticky: null }))).toBeNull();
  });

  it('names the outcome list the pad offers', () => {
    expect(catalogHint(inboundCall())).toBe('From Card Renewals’s outcome list');
    expect(catalogHint(inboundCall({ catalog_source: 'route', match: null }))).toBe('From the Customer care route’s outcome list');
    expect(catalogHint(inboundCall({ catalog_source: 'builtin', match: null }))).toBe('From the standard outcome list');
  });

  it('the matched campaign, the wait, and the DNC sentence', () => {
    expect(matchLine(inboundCall())).toBe('Card Renewals · Waiting');
    expect(matchLine(inboundCall({ match: null }))).toBeNull();
    expect(waitedLine(42)).toBe('Waited 42 s');
    expect(waitedLine(120)).toBe('Waited 2 min');
    expect(waitedLine(65)).toBe('Waited 1 min 5 s');
    expect(INBOUND_DNC_ENQUIRY_COPY).toMatch(/customer’s own call is an enquiry/);
  });

  it('the waiting pill names the contact, else the number', () => {
    const frame = { event: 'customer_waiting' as const, inbound_call_id: 'ib-9', from_e164: '+919820461733', waiting_since: 'x' };
    expect(customerWaitingLine({ ...frame, match_name: 'Asha Rao' })).toBe('Your customer is waiting: Asha Rao');
    expect(customerWaitingLine(frame)).toBe(`Your customer is waiting: ${inboundCallerNumber('+919820461733')}`);
    expect(customerWaitingLine({ ...frame, from_e164: null })).toBe('Your customer is waiting');
  });
});

describe('describeInboundRail', () => {
  it('offered: who is calling and that they are being put through', () => {
    const rail = describeInboundRail({ connection: 'open', call: inboundCall() });
    expect(rail.tone).toBe('info');
    expect(rail.label).toBe('Incoming call from Asha Rao');
    expect(rail.detail).toMatch(/^Rang .* · Customer care · connecting you now$/);
    expect(rail.timerFrom).toBeNull();
  });

  it('a withheld caller is said so', () => {
    const rail = describeInboundRail({ connection: 'open', call: inboundCall({ from_e164: null, match: null }) });
    expect(rail.label).toBe('Incoming call from Number withheld');
    expect(rail.detail).toMatch(/^The caller withheld their number/);
  });

  it('connected: the talk timer from bridged_at', () => {
    const rail = describeInboundRail({ connection: 'open', call: connected() });
    expect(rail.tone).toBe('success');
    expect(rail.label).toBe('On a call with Asha Rao');
    expect(rail.timerFrom).toBe('2026-11-09T10:00:01.500Z');
  });

  it('outcome needed: the lapse instant for the countdown', () => {
    const rail = describeInboundRail({ connection: 'open', call: owing() });
    expect(rail.label).toBe('Outcome needed');
    expect(rail.lapseAt).toBe('2026-11-09T10:33:00.000Z');
  });

  it('a lost connection outranks the call', () => {
    expect(describeInboundRail({ connection: 'disconnected', call: connected() }).detail).toMatch(/can’t hear you/);
    expect(describeInboundRail({ connection: 'reconnecting', call: owing() }).detail).toMatch(/outcome is kept/);
    expect(describeInboundRail({ connection: 'superseded', call: connected() }).label).toMatch(/another device/);
  });
});
