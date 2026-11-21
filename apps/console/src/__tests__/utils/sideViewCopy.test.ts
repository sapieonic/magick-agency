import { describe, it, expect } from 'vitest';
import {
  DIAL_BLOCK_WORDS,
  SIDE_COPY,
  SOFTPHONE_PAGE_COPY,
  STICKY_WORDS,
  sideSaveBlockLine,
  waitedFor,
  type SideSaveBlock,
} from '../../utils/agency/sideViewCopy';
import { inboundCustomerCard, inboundLastCalls, softphoneCustomerCard, softphoneLastCalls } from '../../utils/agency/sideViewCustomer';
import { connected, inboundCall } from '../helpers/inbound';
import { refusalCopy, PROMISE_REFUSAL_COPY } from '../../utils/softphone/refusalCopy';
import {
  SAVE_BLOCK_COPY,
  SOFTPHONE_FINISH_CALL_COPY,
  SOFTPHONE_FINISH_IDLE_COPY,
  SOFTPHONE_MUTED_AT_ANSWER_COPY,
  SOFTPHONE_NOTES_DISABLED_COPY,
  SOFTPHONE_PAD_DISABLED_COPY,
} from '../../hooks/useSoftphone';
import {
  INBOUND_DISPOSITION_RULE_COPY,
  INBOUND_MUTED_AT_CONNECT_COPY,
  INBOUND_SAVE_BLOCK_COPY,
  dispositionRefusalCopy,
} from '../../hooks/useInboundCall';
import { INBOUND_PAD_DISABLED_COPY } from '../../utils/inbound/inboundCall';
import { MANUAL_END_REASON_COPY } from '../../utils/softphone/callState';
import { OVERRIDE_NOTE_BLOCK_COPY, describeDncRefusal, describeHoursRefusal } from '../../utils/softphone/overrides';
import { SOFTPHONE_LEAVE_BLOCKED_COPY, SOFTPHONE_STAYS_OPEN_COPY } from '../../components/softphone/SoftphoneHeader';
import { SOFTPHONE_CLOSE_CONFIRM_MESSAGE } from '../../pages/agency/SoftphonePage';
import { AGENCY_SOFTPHONE_ERROR_CODES } from '../../types/softphone';
import { AGENCY_INBOUND_ERROR_CODES } from '../../types/inbound';
import type { SoftphoneRefusal } from '../../api/softphone';
import type { InboundRefusal } from '../../api/inbound';
import { CAMPAIGN, manualCall } from '../helpers/softphone';

/**
 * The station's side views (an inbound call, the soft phone, `/dialer/phone`) in their own words
 * (AS15, spec §6.6), the lines their hooks say included, and the customer card they build by the
 * outbound card's rules.
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
  /\binbound\b/i,
  /\boutcome\b/i,
  /\broster\b/i,
  /caller ID/i,
  /\bdialer\b/i,
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

const DNC_REFUSAL = {
  code: 'dnc_listed' as const,
  status: 409,
  message: 'The server’s campaign words',
  entry: { id: 'd', scope: 'campaign' as const, reason: null, created_at: '2026-10-12T09:00:00Z' },
};
const HOURS_REFUSAL = {
  code: 'outside_calling_hours' as const,
  status: 409,
  message: 'The server’s campaign words',
  window: { start: '09:00', end: '20:00', days: [1, 2, 3], timezone: 'Asia/Kolkata' },
  timezone_source: 'campaign_default' as const,
  next_open_at: null,
};
const describedOverride = (d: { title: string; facts: Array<{ label: string; value: string }>; consequence: string; noteLabel: string; confirmLabel: string }) =>
  [d.title, d.consequence, d.noteLabel, d.confirmLabel, ...d.facts.flatMap((f) => [f.label, f.value])];

/**
 * The lines the side views' hooks and helpers say (AS15): the soft phone's and an inbound call's
 * refusals by every code, in both contexts, their pad and Save words, their announcements, the
 * override dialog, how a call ended and the way out. Collected here so a new one that says
 * "campaign" or "outcome", or passes on the server's sentence, goes red.
 */
const HOOK_LINES = [
  ...AGENCY_SOFTPHONE_ERROR_CODES.flatMap((code) => [
    refusalCopy({ code, status: 409, message: 'The server’s campaign words' } as SoftphoneRefusal),
    refusalCopy({ code, status: 409, message: 'The server’s campaign words' } as SoftphoneRefusal, 'status'),
  ]),
  refusalCopy({ code: 'unknown', raw_code: 'boom', status: 500, message: 'The server’s campaign words' }),
  ...Object.values(PROMISE_REFUSAL_COPY),
  ...Object.values(SAVE_BLOCK_COPY),
  SOFTPHONE_MUTED_AT_ANSWER_COPY,
  SOFTPHONE_NOTES_DISABLED_COPY,
  SOFTPHONE_FINISH_CALL_COPY,
  ...Object.values(SOFTPHONE_FINISH_IDLE_COPY),
  SOFTPHONE_PAD_DISABLED_COPY,
  ...Object.values(INBOUND_SAVE_BLOCK_COPY),
  ...Object.values(INBOUND_DISPOSITION_RULE_COPY),
  INBOUND_MUTED_AT_CONNECT_COPY,
  INBOUND_PAD_DISABLED_COPY,
  ...AGENCY_INBOUND_ERROR_CODES.map((code) => dispositionRefusalCopy({ code, status: 409, message: 'The server’s campaign words', reason: null } as InboundRefusal)),
  dispositionRefusalCopy({ code: 'unknown', status: 500, message: 'The server’s campaign words', reason: null } as InboundRefusal),
  ...Object.values(MANUAL_END_REASON_COPY),
  ...Object.values(OVERRIDE_NOTE_BLOCK_COPY),
  ...describedOverride(describeDncRefusal(DNC_REFUSAL, { number: '+919820461733', campaignName: null })),
  ...(['tenant', 'account'] as const).flatMap((scope) =>
    describedOverride(describeDncRefusal({ ...DNC_REFUSAL, entry: { ...DNC_REFUSAL.entry, scope } }, { number: '+919820461733', campaignName: null }))),
  ...describedOverride(describeHoursRefusal(HOURS_REFUSAL, { campaignName: null })),
  ...describedOverride(describeHoursRefusal({ ...HOURS_REFUSAL, timezone_source: 'contact' }, { campaignName: null })),
  SOFTPHONE_LEAVE_BLOCKED_COPY,
  SOFTPHONE_STAYS_OPEN_COPY,
  SOFTPHONE_CLOSE_CONFIRM_MESSAGE,
];

const ALL = [
  ...everyString(SIDE_COPY),
  // `/dialer/phone`'s screens before the soft phone opens.
  ...everyString(SOFTPHONE_PAGE_COPY),
  ...everyString(STICKY_WORDS),
  ...everyString(DIAL_BLOCK_WORDS),
  ...BLOCKS.map(sideSaveBlockLine),
  ...HOOK_LINES,
];

describe('the side views’ own words (AS15, spec §6.6)', () => {
  it('collects a real body of copy, so the checks below cannot pass on nothing', () => {
    expect(ALL.length).toBeGreaterThan(200);
  });

  it('never passes on the server’s sentence: a code without words gets a safe line of ours', () => {
    expect(ALL.filter((line) => line.includes('The server’s'))).toEqual([]);
    expect(refusalCopy({ code: 'unknown', raw_code: 'boom', status: 500, message: 'The server’s campaign words' })).toBe(
      'That did not go through. Try again in a moment.',
    );
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
    expect(card.phone).toBe('+91 98204 61733');
    expect(card.facts.map((f) => f.value)).toEqual(['P-778', '8 Nov']);
    expect(card.lastSaid).toBe('Asked to ring after six');
    expect(inboundCustomerCard(inboundCall(), 'masked').phone).toBe('98••• ••733');
  });

  it('an unmatched caller is their number; a withheld one is "Number hidden", never an empty title', () => {
    expect(inboundCustomerCard(inboundCall({ match: null })).name).toBeNull();
    expect(inboundCustomerCard(inboundCall({ match: null })).phone).toBe('+91 98204 61733');
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
    expect(bare.phone).toBe('+91 98204 61733');
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

  it('a legacy campaign’s caller is named by the card’s guess from before AS19 when the rule finds none; a chosen one is not', () => {
    const context = { 'Loan account': 'HL-4471', 'Borrower Name': 'Sunita Patil' };
    const match = { ...inboundCall().match!, context, context_display: { hero: ['Loan account', 'Borrower Name'] } };
    const inbound = inboundCustomerCard(inboundCall({ match }));
    expect(inbound.name).toBe('Sunita Patil');
    // The name is not a tile as well.
    expect(inbound.facts.map((f) => f.value)).not.toContain('Sunita Patil');
    const chosen = inboundCustomerCard(inboundCall({ match: { ...match, context_display: { facts: [] } } }));
    expect(chosen.name).toBeNull();

    const contact = { contact_id: 'ct-1', state: 'in_flight' as const, claimed: true, context, prior_attempts: [] };
    const call = manualCall({ tag: { campaign_id: 'camp-1', campaign_name: 'Home Loan Renewals' }, contact });
    expect(softphoneCustomerCard(call, {}).name).toBe('Sunita Patil');
    expect(softphoneCustomerCard(call, { facts: [] }).name).toBeNull();
  });
});
