import { describe, it, expect } from 'vitest';
import {
  DIAL_BLOCK_WORDS,
  SIDE_COPY,
  STICKY_WORDS,
  sideSaveBlockLine,
  waitedFor,
  type SideSaveBlock,
} from '../../utils/agency/sideViewCopy';
import { inboundCustomerCard, inboundLastCalls, softphoneCustomerCard, softphoneLastCalls } from '../../utils/agency/sideViewCustomer';
import { connected, inboundCall } from '../helpers/inbound';
import { CAMPAIGN, manualCall } from '../helpers/softphone';

/**
 * The station's side views (an inbound call, the soft phone) in their own words (AS15, spec
 * §6.6), and the customer card they build by the outbound card's rules.
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
  /\broute\b/i,
  /soft ?phone/i,
  /\binbound\b/i,
  /\boutcome\b/i,
];

function everyString(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'function') everyString((value as (arg: string) => unknown)('today at 3:00 PM'), out);
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => everyString(v, out));
  return out;
}

const BLOCKS: SideSaveBlock[] = [
  'no_selection', 'note_required', 'datetime_required', 'callback_in_past', 'promise_required', 'promise_date_invalid',
  'promise_amount_invalid', 'call_live', 'fields_required',
];

const ALL = [
  ...everyString(SIDE_COPY),
  ...everyString(STICKY_WORDS),
  ...everyString(DIAL_BLOCK_WORDS),
  ...BLOCKS.map(sideSaveBlockLine),
];

describe('the side views’ own words (AS15, spec §6.6)', () => {
  it('collects a real body of copy, so the checks below cannot pass on nothing', () => {
    expect(ALL.length).toBeGreaterThan(60);
  });

  it.each(BANNED.map((re) => [re.source, re] as const))('never says %s', (_name, re) => {
    expect(ALL.filter((line) => re.test(line))).toEqual([]);
  });

  it('spells the British way', () => {
    expect(ALL.filter((line) => /\b(canceled|color|dialed|redialed|organization|center)\b/i.test(line))).toEqual([]);
  });

  it('says every Save block in the station’s words, the side views’ two included', () => {
    expect(sideSaveBlockLine('no_selection')).toBe('Choose one first.');
    expect(sideSaveBlockLine('call_live')).toBe('Save opens when the call ends.');
    expect(sideSaveBlockLine('fields_required')).toBe('Fill in the call details first.');
  });

  it('says a wait as a clock', () => {
    expect(waitedFor(42)).toBe('0:42');
    expect(waitedFor(65)).toBe('1:05');
    expect(waitedFor(-3)).toBe('0:00');
  });
});

describe('the customer card on a side view', () => {
  it('an inbound caller: the matched contact by the outbound card’s rules, the number as phone_display says', () => {
    const card = inboundCustomerCard(inboundCall());
    expect(card.name).toBe('Asha Rao');
    expect(card.place).toBe('Pune');
    expect(card.phone).toBe('+919820461733');
    expect(card.facts.map((f) => f.value)).toEqual(['P-778', '8 Nov']);
    expect(card.lastSaid).toBe('Asked to ring after six');
    expect(inboundCustomerCard(inboundCall(), 'masked').phone).toBe('98••• ••733');
  });

  it('an unmatched caller is their number; a withheld one is "Number hidden", never an empty title', () => {
    expect(inboundCustomerCard(inboundCall({ match: null })).name).toBeNull();
    expect(inboundCustomerCard(inboundCall({ match: null })).phone).toBe('+919820461733');
    const hidden = inboundCustomerCard(connected({ match: null, from_e164: null }), 'masked');
    expect(hidden.phone).toBe('Number hidden');
    expect(hidden.facts).toEqual([]);
    expect(inboundLastCalls(inboundCall({ match: null }))).toEqual([]);
  });

  it('Last calls name an outcome from the matched work’s own list, and only then', () => {
    const prior = { ...inboundCall().match!.prior_attempts[0]!, disposition_code: 'resolved', outcome: 'connected' as const };
    const call = inboundCall({ match: { ...inboundCall().match!, prior_attempts: [prior] } });
    expect(inboundLastCalls(call)[0]!.outcome).toBe('Resolved');
    expect(inboundLastCalls({ ...call, catalog_source: 'route' })[0]!.outcome).not.toBe('Resolved');
  });

  it('a soft-phone call: the number dialled, whole, and the roster contact when the number is on the list', () => {
    const bare = softphoneCustomerCard(manualCall(), undefined);
    expect(bare.name).toBeNull();
    expect(bare.phone).toBe('+919820461733');
    const contact = {
      contact_id: 'ct-1',
      state: 'in_flight' as const,
      claimed: true,
      context: { Name: 'Asha Rao', 'Loan account': 'HL-4471' },
      prior_attempts: [],
    };
    const call = manualCall({ tag: { campaign_id: 'camp-1', campaign_name: 'Home Loan Renewals' }, contact });
    const card = softphoneCustomerCard(call, CAMPAIGN.context_display);
    expect(card.name).toBe('Asha Rao');
    expect(card.facts.map((f) => f.value)).toEqual(['HL-4471']);
    expect(softphoneLastCalls(call, CAMPAIGN)).toEqual([]);
    expect(softphoneLastCalls(manualCall(), null)).toEqual([]);
  });
});
