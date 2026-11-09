import { describe, expect, it } from 'vitest';
import {
  EMPTY_MISSED_FILTERS,
  INBOUND_REFUSAL_COPY,
  assigneeLabel,
  inboundRefusalCopy,
  missedQueryFromDraft,
} from '../../utils/inbound/inboundCopy';
import { missedQueryString, parseInboundRefusal } from '../../api/inbound';
import { readSoftphonePrefill, softphonePrefillState } from '../../utils/softphone/prefill';
import { AGENCY_INBOUND_ERROR_CODES } from '../../types/inbound';

/**
 * Inbound calls' words and plumbing: every refusal code has British-English copy, a refusal is
 * read off an `ApiError`, the Missed filters become the list query (local dates to instants,
 * `to` exclusive), and the soft phone's prefill travels in history state, never malformed.
 */

describe('refusals', () => {
  it('has words for every code', () => {
    for (const code of AGENCY_INBOUND_ERROR_CODES) expect(INBOUND_REFUSAL_COPY[code]).toMatch(/\S/);
  });

  it('reads the envelope off an ApiError and names the number', () => {
    const err = Object.assign(new Error('Conflict'), {
      statusCode: 409,
      details: { code: 'inbound_number_not_linked', message: 'not linked', phone_number_id: 'n-1' },
    });
    const refusal = parseInboundRefusal(err);
    expect(refusal).toMatchObject({ code: 'inbound_number_not_linked', status: 409, phoneNumberId: 'n-1', routeId: null, details: [] });
    expect(inboundRefusalCopy(refusal, () => '+44 1632 960001')).toMatch(/Contact support .*\(\+44 1632 960001\)$/);
  });

  it('keeps the details of an invalid route and falls back to the server’s words for an unknown code', () => {
    const invalid = parseInboundRefusal(Object.assign(new Error('x'), {
      statusCode: 400, details: { code: 'inbound_route_invalid', details: [{ path: 'name', message: 'n' }, { bogus: true }] },
    }));
    expect(invalid.details).toEqual([{ path: 'name', message: 'n' }]);
    const unknown = parseInboundRefusal(Object.assign(new Error('Forbidden'), { statusCode: 403, details: { message: 'Insufficient permissions' } }));
    expect(unknown.code).toBe('unknown');
    expect(inboundRefusalCopy(unknown)).toBe('Insufficient permissions');
    expect(parseInboundRefusal(new TypeError('Failed to fetch'))).toMatchObject({ code: 'unknown', status: null, message: 'Failed to fetch' });
  });
});

describe('the Missed list query', () => {
  it('turns local dates into an inclusive start and an exclusive end, and leaves out what is unset', () => {
    expect(missedQueryFromDraft(EMPTY_MISSED_FILTERS)).toEqual({ status: 'open' });
    const query = missedQueryFromDraft({ status: 'handled', assignee: 'unassigned', reason: 'closed', from: '2026-11-01', to: '2026-11-03' });
    expect(query).toEqual({
      status: 'handled', assignee: 'unassigned', reason: 'closed',
      from: '2026-11-01T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z',
    });
    expect(missedQueryString({ ...query, cursor: 'c 1', limit: 50 }))
      .toBe('?status=handled&assignee=unassigned&reason=closed&from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-04T00%3A00%3A00.000Z&cursor=c+1&limit=50');
  });

  it('names the assignee: the caller, the account, someone, or a former member', () => {
    expect(assigneeLabel({ assignee_user_id: null, assignee_name: null }, 'u-1')).toBe('The account');
    expect(assigneeLabel({ assignee_user_id: 'u-1', assignee_name: 'Asha' }, 'u-1')).toBe('You');
    expect(assigneeLabel({ assignee_user_id: 'u-2', assignee_name: 'Ravi' }, 'u-1')).toBe('Ravi');
    expect(assigneeLabel({ assignee_user_id: 'u-3', assignee_name: null }, 'u-1')).toBe('Former member');
  });
});

describe('the soft phone prefill', () => {
  it('round-trips through history state, and anything malformed reads as none', () => {
    const state = softphonePrefillState({ number: '+447700900123', campaignId: 'c-1' });
    expect(readSoftphonePrefill(state)).toEqual({ number: '+447700900123', campaignId: 'c-1' });
    expect(readSoftphonePrefill(softphonePrefillState({ number: '+447700900123', campaignId: null }))).toEqual({ number: '+447700900123', campaignId: null });
    for (const bad of [null, 'x', {}, { softphonePrefill: null }, { softphonePrefill: { number: '07700 900123' } }, { softphonePrefill: { number: 447700900123 } }]) {
      expect(readSoftphonePrefill(bad)).toBeNull();
    }
  });
});
