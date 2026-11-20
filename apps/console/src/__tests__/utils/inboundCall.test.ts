import { describe, it, expect } from 'vitest';
import {
  NUMBER_WITHHELD,
  customerWaitingLine,
  inboundCallerLabel,
  inboundCallerNumber,
  inboundMatchName,
  inboundPhase,
  isInboundCallLive,
  isInboundCallOnStation,
  newerInboundCall,
} from '../../utils/inbound/inboundCall';
import { connected, inboundCall, owing } from '../helpers/inbound';

/**
 * The inbound call as the station reads it (P2): which phase it puts the panel in, which of two
 * copies is newer (the row has no `updated_at`), and the caller in words.
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

  it('the waiting pill names the contact, else the number', () => {
    const frame = { event: 'customer_waiting' as const, inbound_call_id: 'ib-9', from_e164: '+919820461733', waiting_since: 'x' };
    expect(customerWaitingLine({ ...frame, match_name: 'Asha Rao' })).toBe('Your customer is waiting: Asha Rao');
    expect(customerWaitingLine(frame)).toBe(`Your customer is waiting: ${inboundCallerNumber('+919820461733')}`);
    expect(customerWaitingLine({ ...frame, from_e164: null })).toBe('Your customer is waiting');
  });
});
