import { describe, expect, it } from 'vitest';
import {
  agentPhone,
  unfiledInboundIds,
  callListLabelIds,
  contactNameMap,
  mergeCallbacksDue,
  parseCallLogQuery,
  toMyCallRow,
  MY_CALLBACKS_DUE_MAX,
  type CallListCampaignLabel,
} from '../../../src/agency/call-lists.js';
import type { CampaignCallLogRow, CampaignInboundLogRow, CampaignSoftphoneLogRow } from '../../../src/agency/campaign-call-log.js';

/**
 * The account's All calls and the agent's My calls (docs/call-log.md §7): what the routes do to
 * the read's rows. The rule held hardest here: an agent's row never carries a number its
 * campaign hides, nor anything of the call's media.
 */

const MASKED: CallListCampaignLabel = { name: 'Diwali EMI Collections', phone_display: 'masked', disposition_catalog: [{ code: 'will_pay', label: 'Will pay' }] };
const FULL: CallListCampaignLabel = { name: 'Gold Loan Renewals', phone_display: 'full', disposition_catalog: [] };
const labels = (campaigns: Record<string, CallListCampaignLabel>, names: Record<string, string> = {}) =>
  ({ campaigns: new Map(Object.entries(campaigns)), contactNames: new Map(Object.entries(names)) });

const DIALLER = {
  source: 'dialler', id: 'a-1', campaign_id: 'c-1', contact_id: 'k-1', attempt_number: 2, phone_e164: '+919876543210',
  caller_id: '+912200000000', agent_user_id: 'u-1', reserved_agent_id: 's-1', state: 'ended', outcome: 'connected',
  disposition_code: 'will_pay', auto_disposition_code: null, notes: 'will pay on Friday', callback_at: null, promise_date: '2026-11-25',
  promise_amount: '1500.00', dispositioned_by_user_id: 'u-1', dispositioned_at: '2026-11-22T10:00:00.000Z', dispositioned_on_behalf: false,
  webrtc_call_id: 'leg-1', dialed_at: '2026-11-22T09:59:00.000Z', answered_at: null, bridged_at: '2026-11-22T09:59:10.000Z',
  ended_at: '2026-11-22T10:00:00.000Z', talk_seconds: 50, wrapup_seconds: 20, redial_of_attempt_id: null, redial_number: 0,
  created_at: '2026-11-22T09:58:00.000Z',
} as unknown as CampaignCallLogRow;

const SOFT = {
  source: 'soft_phone', id: 'm-1', campaign_id: null, contact_id: null, attempt_number: null, phone_e164: '+919811000040',
  caller_id: '+912200000000', agent_user_id: 'u-1', reserved_agent_id: null, state: 'ended', outcome: 'connected', disposition_code: 'resolved',
  auto_disposition_code: null, notes: null, callback_at: null, promise_date: null, promise_amount: null, dispositioned_by_user_id: 'u-1',
  dispositioned_at: null, dispositioned_on_behalf: false, webrtc_call_id: 'leg-2', dialed_at: '2026-11-22T11:00:01.000Z', answered_at: null,
  bridged_at: null, ended_at: '2026-11-22T11:01:00.000Z', talk_seconds: 40, wrapup_seconds: null, redial_of_attempt_id: null,
  redial_number: null, dnc_overridden: true, hours_overridden: false, requires_disposition: false, settled_at: '2026-11-22T11:02:00.000Z',
  callback_of: { inbound_call_id: 'i-9', arrived_at: '2026-11-22T10:30:00.000Z' }, created_at: '2026-11-22T11:00:00.000Z',
} satisfies CampaignSoftphoneLogRow;

const MISSED = {
  source: 'inbound', id: 'i-1', campaign_id: 'c-1', contact_id: 'k-2', attempt_number: null, phone_e164: '+919812307730',
  caller_id: '+912200000001', agent_user_id: null, reserved_agent_id: null, state: 'ended', outcome: 'overflow', disposition_code: null,
  auto_disposition_code: null, notes: null, callback_at: null, promise_date: null, promise_amount: null, dispositioned_by_user_id: null,
  dispositioned_at: null, dispositioned_on_behalf: false, webrtc_call_id: 'leg-3', dialed_at: null, answered_at: '2026-11-22T12:00:02.000Z',
  bridged_at: null, ended_at: '2026-11-22T12:01:40.000Z', talk_seconds: null, wrapup_seconds: null, redial_of_attempt_id: null,
  redial_number: null, dnc_overridden: false, hours_overridden: false, requires_disposition: false, settled_at: '2026-11-22T12:01:40.000Z',
  inbound: {
    campaign_source: 'route', route_name: 'Sales line', wait_seconds: 100, queued: true, via_sticky_agent: false, voicemail_seconds: 22,
    follow_up: {
      status: 'open', reason: 'overflow', closed_cause: null, assignee_user_id: 'u-1', assignee_name: 'Priya Nair',
      handled_reason: null, handled_at: null,
    },
    called_back: { call_id: 'm-1', at: '2026-11-22T12:31:00.000Z' },
  },
  created_at: '2026-11-22T12:00:00.000Z',
} satisfies CampaignInboundLogRow;

describe('the number an agent may see', () => {
  it('is masked where the campaign hides numbers, in full where it shows them', () => {
    expect(agentPhone('+919876543210', [MASKED])).toEqual({ phone: '98••• ••210', phone_masked: true });
    expect(agentPhone('+919876543210', [FULL])).toEqual({ phone: '+919876543210', phone_masked: false });
  });

  it('is masked when the row names a campaign the read did not return (fail closed)', () => {
    expect(agentPhone('+919876543210', [undefined])).toEqual({ phone: '98••• ••210', phone_masked: true });
  });

  it('is in full for a call that names no campaign, and absent for a withheld caller', () => {
    expect(agentPhone('+919876543210', [])).toEqual({ phone: '+919876543210', phone_masked: false });
    expect(agentPhone(null, [MASKED])).toEqual({ phone: null, phone_masked: false });
  });

  it('is masked on a stored setting it does not know: only exactly "full" shows the number', () => {
    for (const phone_display of ['whatever', 'FULL', '', null]) {
      expect(agentPhone('+919876543210', [{ ...FULL, phone_display }]).phone_masked, String(phone_display)).toBe(true);
    }
  });

  it('is masked when any campaign the row names hides numbers', () => {
    expect(agentPhone('+919876543210', [FULL, MASKED]).phone_masked).toBe(true);
    expect(agentPhone('+919876543210', [FULL, undefined]).phone_masked).toBe(true);
    expect(agentPhone('+919876543210', [FULL, FULL]).phone_masked).toBe(false);
  });

  it('masks an inbound row filed under no campaign by the campaign of the contact it matched', () => {
    const unfiled = { ...MISSED, id: 'i-unfiled', campaign_id: null } as unknown as CampaignCallLogRow;
    const campaigns = new Map([['c-1', MASKED], ['c-2', FULL]]);
    const row = (matched?: string) => toMyCallRow(unfiled, {
      campaigns, contactNames: new Map(), ...(matched ? { matchedCampaignIds: new Map([['i-unfiled', matched]]) } : {}),
    });
    expect(row('c-1')).toMatchObject({ campaign_id: null, campaign_name: null, phone_masked: true });
    expect(row('c-1').phone).not.toBe(unfiled.phone_e164);
    expect(row('c-2')).toMatchObject({ phone: unfiled.phone_e164, phone_masked: false });
    // Matched to a campaign the label read did not return: masked.
    expect(row('c-gone').phone_masked).toBe(true);
    // Matched to nothing: no setting hides it.
    expect(row()).toMatchObject({ phone: unfiled.phone_e164, phone_masked: false });
    expect(unfiledInboundIds([unfiled, MISSED as unknown as CampaignCallLogRow])).toEqual(['i-unfiled']);
  });
});

describe('an agent\'s row', () => {
  it('a dialler row: the campaign, the customer, the outcome in the campaign\'s words, the number masked', () => {
    const row = toMyCallRow(DIALLER, labels({ 'c-1': MASKED }, { 'k-1': 'Anjali Verma' }));
    expect(row).toMatchObject({
      type: 'dialler', id: 'a-1', campaign_id: 'c-1', campaign_name: 'Diwali EMI Collections', customer_name: 'Anjali Verma',
      phone: '98••• ••210', phone_masked: true, outcome: 'connected', disposition_code: 'will_pay', disposition_label: 'Will pay',
      promise_date: '2026-11-25', talk_seconds: 50, attempt_number: 2, redial: false, notes: 'will pay on Friday',
      follow_up: null, wait_seconds: null, callback_of: null,
    });
  });

  it('carries no media, no agent and no number but the one it may show, on any type', () => {
    for (const source of [DIALLER, SOFT, MISSED]) {
      const row = toMyCallRow(source, labels({ 'c-1': MASKED }));
      const text = JSON.stringify(row);
      for (const key of ['webrtc_call_id', 'caller_id', 'phone_e164', 'agent_user_id', 'dispositioned_by_user_id', 'assignee_user_id', 'assignee_name', 'route_name']) {
        expect(row, `${source.source} row carries ${key}`).not.toHaveProperty(key);
        expect(text).not.toContain(`"${key}"`);
      }
      expect(text).not.toContain('leg-');
      if (source.campaign_id === 'c-1') expect(text).not.toContain(source.phone_e164!.slice(3));
    }
  });

  it('a soft-phone call with no campaign: in full, no campaign words, its call back kept', () => {
    expect(toMyCallRow(SOFT, labels({}))).toMatchObject({
      type: 'soft_phone', campaign_id: null, campaign_name: null, phone: '+919811000040', phone_masked: false,
      disposition_code: 'resolved', disposition_label: null, callback_of: SOFT.callback_of, attempt_number: null,
    });
  });

  it('a missed call: its Missed row without who it is assigned to, the wait, the voicemail, its call back', () => {
    const row = toMyCallRow(MISSED, labels({ 'c-1': FULL }));
    expect(row).toMatchObject({
      type: 'inbound', phone: '+919812307730', phone_masked: false, wait_seconds: 100, queued: true, voicemail_seconds: 22,
      follow_up: { status: 'open', reason: 'overflow', closed_cause: null, handled_reason: null },
      called_back: { call_id: 'm-1', at: '2026-11-22T12:31:00.000Z' },
    });
    expect(Object.keys(row.follow_up!).sort()).toEqual(['closed_cause', 'handled_reason', 'reason', 'status']);
  });
});

describe('the labels a page needs', () => {
  it('asks for each campaign and contact once', () => {
    expect(callListLabelIds([DIALLER, SOFT, MISSED, DIALLER])).toEqual({ campaignIds: ['c-1'], contactIds: ['k-1', 'k-2'] });
  });

  it('names a contact by the station card\'s rule, and leaves one with no name out', () => {
    const names = contactNameMap([
      { id: 'k-1', context: { name: 'Anjali Verma' }, display: null },
      { id: 'k-2', context: { city: 'Pune' }, display: null },
      { id: 'k-3', context: { 'Customer Name': 'Vikram Patil' }, display: { roles: { name: 'Customer Name' } } },
    ]);
    expect([...names]).toEqual([['k-1', 'Anjali Verma'], ['k-3', 'Vikram Patil']]);
  });
});

describe('the callbacks due', () => {
  it('are one list across campaigns, soonest due first, capped', () => {
    const due = (contact: string, at: string) => ({ contact_id: contact, campaign_id: 'c', campaign_name: null, customer_name: null, due_at: at, overdue: false });
    expect(mergeCallbacksDue([
      [due('b', '2026-11-22T12:00:00.000Z'), due('d', '2026-11-22T16:00:00.000Z')],
      [due('a', '2026-11-22T12:00:00.000Z'), due('c', '2026-11-22T09:00:00.000Z')],
    ]).map((c) => c.contact_id)).toEqual(['c', 'a', 'b', 'd']);
    const many = Array.from({ length: MY_CALLBACKS_DUE_MAX + 5 }, (_, i) => due(`k-${i}`, new Date(1_700_000_000_000 + i * 60_000).toISOString()));
    expect(mergeCallbacksDue([many])).toHaveLength(MY_CALLBACKS_DUE_MAX);
  });
});

describe('the Call log\'s query, parsed once for every scope', () => {
  it('splits the two outcome vocabularies and reads the source, the status and the counts flag', () => {
    const parsed = parseCallLogQuery({ outcome: 'connected,missed', source: 'inbound', status: 'live', include_counts: '1' });
    expect(parsed).toMatchObject({
      ok: true,
      value: { source: 'inbound', softphoneStatus: 'live', inboundOutcomes: ['missed'], includeCounts: true, filters: { outcomes: ['connected'] } },
    });
    expect(parseCallLogQuery({})).toMatchObject({ ok: true, value: { source: null, includeCounts: false } });
  });

  it('refuses a source, a status or an agent it does not know', () => {
    for (const query of [{ source: 'nope' }, { status: 'nope' }, { agent_user_id: 'not-an-id' }, { include_counts: 'maybe' }, { outcome: 'nope' }]) {
      expect(parseCallLogQuery(query).ok, JSON.stringify(query)).toBe(false);
    }
  });
});
