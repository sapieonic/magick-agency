import { describe, expect, it } from 'vitest';
import {
  compareTimeline,
  decodeTimelineCursor,
  encodeTimelineCursor,
  toWireInstant,
} from '../../../../src/agency/customer-history/cursor.js';
import {
  customerSearchRequestSchema,
  customerTimelineRequestSchema,
  pageLimit,
  toTimelineFilter,
} from '../../../../src/agency/customer-history/requests.js';
import { memorySearchStore, SEARCH_ID_RE } from '../../../../src/agency/customer-history/search-store.js';

/**
 * The customer-history timeline's cursor and request bodies (`docs/customer-history.md` §2, §4):
 * the cursor round-trips at microsecond precision and refuses anything this server did not mint;
 * the bodies refuse what the contract does not allow; the search store binds an id to its tenant
 * and user and forgets it after its TTL.
 */

const ID = '0a1b2c3d-4e5f-4061-8293-a4b5c6d7e8f9';
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');

describe('the timeline cursor', () => {
  it('round-trips at microsecond precision', () => {
    const pos = { at: '2026-11-04T07:56:00.123456Z', key: `campaign_call:${ID}` };
    expect(decodeTimelineCursor(encodeTimelineCursor(pos))).toEqual(pos);
  });

  it('refuses what this server did not mint', () => {
    for (const raw of [
      undefined, 42, '', 'not base64 !', b64('x'), b64([]), b64({}),
      b64({ at: '2026-11-04T07:56:00.123Z', key: `campaign_call:${ID}` }), // millisecond, not micro
      b64({ at: '2026-02-30T07:56:00.000000Z', key: `campaign_call:${ID}` }), // not a real day
      b64({ at: '0000-01-01T00:00:00.000000Z', key: `campaign_call:${ID}` }),
      b64({ at: '2026-11-04T07:56:00.000000Z', key: `call:${ID}` }), // unknown kind
      b64({ at: '2026-11-04T07:56:00.000000Z', key: 'campaign_call:nope' }),
      b64({ at: '2026-11-04T07:56:00.000000Z', key: `campaign_call:${ID.toUpperCase()}` }),
      'A'.repeat(600),
    ]) {
      expect(decodeTimelineCursor(raw), String(raw)).toBeNull();
    }
  });

  it('orders at DESC then key DESC', () => {
    const a = { at: '2026-11-04T07:56:00.000002Z', key: `roster_entry:${ID}` };
    const b = { at: '2026-11-04T07:56:00.000001Z', key: `softphone_call:${ID}` };
    const c = { at: '2026-11-04T07:56:00.000001Z', key: `campaign_call:${ID}` };
    expect([c, a, b].sort(compareTimeline)).toEqual([a, b, c]);
    expect(compareTimeline(b, b)).toBe(0);
  });

  it('the wire instant is the microsecond form cut to milliseconds', () => {
    expect(toWireInstant('2026-11-04T07:56:00.123456Z')).toBe('2026-11-04T07:56:00.123Z');
  });
});

describe('the request bodies', () => {
  it('a search: by phone, the raw text, an optional two-letter country', () => {
    expect(customerSearchRequestSchema.safeParse({ by: 'phone', value: '098765-43210', country: 'IN' }).success).toBe(true);
    expect(customerSearchRequestSchema.safeParse({ by: 'phone', value: '98765' }).success).toBe(true);
    for (const bad of [
      {}, { by: 'column', value: 'x' }, { by: 'phone' }, { by: 'phone', value: 42 },
      { by: 'phone', value: '9'.repeat(65) }, { by: 'phone', value: '1', country: 'IND' },
    ]) {
      expect(customerSearchRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a timeline page: filters, limit 1–100, ids validated', () => {
    expect(customerTimelineRequestSchema.safeParse({
      search_id: 'chs_x', limit: 100,
      filters: { campaign_ids: [ID], from: '2026-10-01T00:00:00.000Z', to: '2026-11-07T00:00:00Z', outcomes: ['connected', 'canceled'],
        connected_only: true, channel: 'campaign', disposition_codes: ['ptp'], agent_user_ids: [ID] },
    }).success).toBe(true);
    for (const bad of [
      {}, { search_id: 1 }, { search_id: 's', limit: 0 }, { search_id: 's', limit: 101 }, { search_id: 's', limit: 1.5 },
      { search_id: 's', filters: { campaign_ids: ['nope'] } },
      { search_id: 's', filters: { outcomes: ['cancelled'] } }, // the wire code is `canceled`, never respelled
      { search_id: 's', filters: { channel: 'sms' } },
      { search_id: 's', filters: { from: 'yesterday' } },
      { search_id: 's', filters: { from: '2026-11-07T00:00:00Z', to: '2026-11-01T00:00:00Z' } },
      { search_id: 's', filters: { agent_user_ids: Array.from({ length: 101 }, () => ID) } },
      { search_id: 's', filters: { disposition_codes: ['x'.repeat(51)] } },
      { search_id: 's', filters: { disposition_codes: [''] } },
    ]) {
      expect(customerTimelineRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(pageLimit(undefined)).toBe(50);
  });

  it('the filters: any call-only filter keeps only calls; from/to as sent; lists de-duplicated, empty = none', () => {
    expect(toTimelineFilter(undefined).callsOnly).toBe(false);
    expect(toTimelineFilter({ campaign_ids: [ID, ID], from: '2026-10-01T00:00:00Z' })).toMatchObject({
      callsOnly: false, campaignRoots: [ID], from: '2026-10-01T00:00:00Z', to: null, outcomes: null,
    });
    for (const f of [{ outcomes: ['connected' as const] }, { disposition_codes: ['x'] }, { agent_user_ids: [ID] }, { connected_only: true }, { channel: 'softphone' as const }]) {
      expect(toTimelineFilter(f).callsOnly, JSON.stringify(f)).toBe(true);
    }
    expect(toTimelineFilter({ connected_only: false, outcomes: [] }).callsOnly).toBe(false);
  });
});

describe('the search store (in process)', () => {
  it('binds an id to its tenant and user, and forgets it after the TTL', async () => {
    let now = Date.parse('2026-11-06T10:00:00Z');
    const store = memorySearchStore(30, () => now);
    const { id, record } = await store.save({ tenant_id: 't1', user_id: 'u1', by: 'phone', value: '+919876543210', display: '+91 98765 43210' });
    expect(id).toMatch(SEARCH_ID_RE);
    expect(record.expires_at).toBe('2026-11-06T10:30:00.000Z');
    expect(await store.find(id, 't1', 'u1')).toEqual(record);
    expect(await store.find(id, 't1', 'u2')).toBeNull();
    expect(await store.find(id, 't2', 'u1')).toBeNull();
    expect(await store.find('chs_00112233445566778899aabbccddeeff', 't1', 'u1')).toBeNull();
    expect(await store.find('../etc', 't1', 'u1')).toBeNull();
    now += 30 * 60_000;
    expect(await store.find(id, 't1', 'u1')).toBeNull();
  });
});
